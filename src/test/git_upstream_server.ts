/**
 * A loopback **dumb-HTTP** git upstream, for the tests that drive
 * `fuz_forge_repo_create`'s `seed_from` clone.
 *
 * `seed_from` admits only an absolute `http`/`https` URL with a host, so a
 * seed can't be a local path or a `file://` URL — which means every test of
 * the seed path needs a real HTTP origin serving a real repo. `git
 * update-server-info` on the bare upstream writes the `info/refs` +
 * `objects/info/packs` indexes that are the whole of what git's **dumb**
 * transport reads, so a read-only static file server over the bare directory
 * is a clonable remote with no CGI and no smart protocol.
 *
 * `create_redirect_server` stands in for an admitted seed host that redirects
 * the clone elsewhere, for the tests that pin that the clone refuses it.
 *
 * Read by the storage suite (`fuz_forge/repo/storage.test.ts`), the
 * in-process handler test (`server/routes/fuz_forge_repo_create_rpc.db.test.ts`)
 * and the cross-backend suite (`cross_backend/repo_create_seed_from.cross.test.ts`):
 * each drives the same clone through a different front door. What puts it at
 * the test root is what it is, not who reads it — a git origin standing in for
 * the world outside the forge, owned by no single test domain, rather than a
 * helper belonging to the cross suites. It still builds its repo through
 * `cross_backend/git_helpers.ts`, so the deterministic git env and the `git`
 * runner are the ones every other git fixture uses.
 *
 * Binds `127.0.0.1` on an ephemeral port — the Rust backend runs in a separate
 * process on the same host, so loopback is reachable from either backend.
 *
 * @module
 */

import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from './cross_backend/git_helpers.ts';

/** A running upstream: where to clone it from, and what a clone should contain. */
export interface UpstreamGitServer {
	/**
	 * The WHATWG-canonical clone URL — `http://127.0.0.1:<port>/`, with the
	 * trailing slash the URL parser adds. A test that pins canonicalization
	 * builds its own non-canonical spelling from `UpstreamGitServer.port`
	 * and expects this back.
	 */
	url: string;
	/** The ephemeral port the server bound, for building alternate spellings. */
	port: number;
	/** How many requests the server has answered, for tests that assert it was never dialed. */
	request_count: () => number;
	/** The bare upstream's path on disk. */
	path: string;
	/** Tip sha of the upstream's `main`, which a successful clone reproduces. */
	head_sha: string;
	/** Stop the server and remove its scratch directory. */
	close: () => Promise<void>;
}

/**
 * Build a bare upstream with one commit on `main`, index it for the dumb
 * transport, and serve it read-only over loopback HTTP. `prefix` names the
 * owning suite so an abandoned crash dir traces back to its origin.
 */
export const create_upstream_git_server = async (prefix: string): Promise<UpstreamGitServer> => {
	const root = await mkdtemp(join(tmpdir(), `fuz_forge-${prefix}-upstream-`));
	try {
		return await start_upstream_git_server(root);
	} catch (err) {
		// The scratch dir exists from the first line, but `close()` — the only
		// thing that removes it — is never handed out on this path, so a failed
		// setup would leak it into the system temp dir on every run.
		await rm(root, { recursive: true, force: true });
		throw err;
	}
};

/** The body of `create_upstream_git_server`, minus the scratch-dir unwind. */
const start_upstream_git_server = async (root: string): Promise<UpstreamGitServer> => {
	const bare = join(root, 'upstream.git');
	const work = join(root, 'work');
	await mkdir(work, { recursive: true });

	await git(root, ['init', '--bare', '--initial-branch=main', bare]);
	await git(root, ['init', '-b', 'main', work]);
	await writeFile(join(work, 'README.md'), '# seeded upstream\n');
	await git(work, ['add', '.']);
	await git(work, ['commit', '-m', 'seed']);
	await git(work, ['remote', 'add', 'origin', bare]);
	await git(work, ['push', 'origin', 'main']);
	// Writes `info/refs` + `objects/info/packs` — the whole of what the dumb
	// HTTP transport needs to serve a clone.
	await git(bare, ['update-server-info']);
	const head_sha = (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();

	let requests = 0;
	const server: Server = createServer((req, res) => {
		requests++;
		const relative = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/').replace(/^\/+/, '');
		// Refuse traversal outright rather than resolving it — the fixture only
		// ever asks for paths inside the bare repo.
		if (relative.split('/').includes('..')) {
			res.statusCode = 400;
			res.end();
			return;
		}
		readFile(join(bare, relative)).then(
			(body) => {
				res.setHeader('content-type', 'application/octet-stream');
				res.end(body);
			},
			() => {
				res.statusCode = 404;
				res.end();
			}
		);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}/`,
		port,
		request_count: () => requests,
		path: bare,
		head_sha,
		close: async () => {
			// `close()` only stops accepting; a keep-alive socket git left open
			// would hold the callback — and the caller's hook — until it timed out.
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	};
};

/** A running redirector: the URL to seed from, and how often it was dialed. */
export interface RedirectServer {
	/** The WHATWG-canonical origin URL, `http://127.0.0.1:<port>/`. */
	url: string;
	/** How many requests the server has answered. */
	request_count: () => number;
	/** Stop the server. */
	close: () => Promise<void>;
}

/**
 * Serve a loopback origin that answers every request with a `302` to the same
 * path and query under `target_url` — the shape of an admitted seed host
 * redirecting a clone somewhere the `seed_from` host policy would refuse.
 * Pointed at a real upstream, a clone that follows the redirect succeeds, so
 * the redirect target's own request count is the observable.
 */
export const create_redirect_server = async (target_url: string): Promise<RedirectServer> => {
	let requests = 0;
	const server: Server = createServer((req, res) => {
		requests++;
		res.statusCode = 302;
		res.setHeader('location', new URL((req.url ?? '/').replace(/^\/+/, ''), target_url).href);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/`,
		request_count: () => requests,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};
};
