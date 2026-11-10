/**
 * Tests for `repo/storage.ts`.
 *
 * Pure path computation runs in-memory; init/clone/install_hooks
 * exercise a real Node runtime against a per-suite tmp dir. Tests
 * shell out to `git` for init/clone — these are skipped via
 * `assert.fail` if `git` is missing, but in practice `gro check`
 * environments always have it.
 *
 * @module
 */

import { mkdir, readFile, readdir, rm, stat as fs_stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, test, describe, beforeAll, afterAll, beforeEach } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { create_node_runtime } from '@fuzdev/fuz_app/runtime/node.ts';

import { spawn_collect } from '#lib/server/subprocess.ts';
import {
	create_redirect_server,
	create_upstream_git_server,
	type UpstreamGitServer
} from '../../git_upstream_server.ts';
import { git } from '../../cross_backend/git_helpers.ts';
import { load_parity_fixture, parity_rows, parity_string } from '../../fixtures/parity/load.ts';

import {
	HOOK_NAMES,
	clone_bare_repo,
	init_bare_repo,
	install_hooks,
	render_post_receive_hook,
	render_pre_receive_hook,
	SEED_CLONE_GIT_CONFIG,
	seed_clone_args,
	repo_path,
	repo_store_root
} from '#lib/fuz_forge/repo/storage.ts';

const file_exists = async (path: string): Promise<boolean> => {
	try {
		await fs_stat(path);
		return true;
	} catch {
		return false;
	}
};

describe('repo_store_root', () => {
	test('returns the env value verbatim when no tilde present', () => {
		const path = repo_store_root({
			env_get: (name) => (name === 'FUZ_FORGE_REPO_STORE_PATH' ? '/srv/fuz_forge/repos' : undefined)
		});
		assert.strictEqual(path, '/srv/fuz_forge/repos');
	});

	test('expands a leading tilde against $HOME', () => {
		const path = repo_store_root({
			env_get: (name) => {
				if (name === 'FUZ_FORGE_REPO_STORE_PATH') return '~/.fuz_forge/repos';
				if (name === 'HOME') return '/home/fuz_forge';
				return undefined;
			}
		});
		assert.strictEqual(path, '/home/fuz_forge/.fuz_forge/repos');
	});

	test('falls back to <fuz_forge_home>/repos when env unset', () => {
		const path = repo_store_root({
			env_get: (name) => (name === 'HOME' ? '/home/fuz_forge' : undefined)
		});
		assert.strictEqual(path, '/home/fuz_forge/.fuz_forge/repos');
	});

	test('follows FUZ_FORGE_HOME when set and the store path is unset', () => {
		const path = repo_store_root({
			env_get: (name) => {
				if (name === 'FUZ_FORGE_HOME') return '/srv/forge-dev';
				if (name === 'HOME') return '/home/fuz_forge';
				return undefined;
			}
		});
		assert.strictEqual(path, '/srv/forge-dev/repos');
	});

	test('FUZ_FORGE_REPO_STORE_PATH overrides FUZ_FORGE_HOME', () => {
		const path = repo_store_root({
			env_get: (name) => {
				if (name === 'FUZ_FORGE_REPO_STORE_PATH') return '/explicit/repos';
				if (name === 'FUZ_FORGE_HOME') return '/srv/forge-dev';
				return undefined;
			}
		});
		assert.strictEqual(path, '/explicit/repos');
	});
});

describe('repo_path', () => {
	test('joins resolved store path with <id>.git suffix', () => {
		const path = repo_path(
			{
				env_get: (name) => {
					if (name === 'FUZ_FORGE_REPO_STORE_PATH') return '/var/fuz_forge/repos';
					return undefined;
				}
			},
			'fuz_app'
		);
		assert.strictEqual(path, '/var/fuz_forge/repos/fuz_app.git');
	});
});

describe('hook script rendering', () => {
	const options = {
		id: 'fuz_app',
		hook_secret: "secret-with-quotes-'-and-$$",
		callback_url_base: 'http://127.0.0.1:4041'
	};

	test('pre-receive is a python3 script that calls /internal/repo-config/', () => {
		const script = render_pre_receive_hook(options);
		assert.match(script, /^#!\/usr\/bin\/env python3/);
		assert.include(script, "FUZ_FORGE_REPO_ID = 'fuz_app'");
		// Single-quote inside the secret is escaped via Python's `\'` form.
		assert.include(script, `FUZ_FORGE_HOOK_SECRET = 'secret-with-quotes-\\'-and-$$'`);
		assert.include(script, "FUZ_FORGE_CALLBACK_BASE = 'http://127.0.0.1:4041'");
		assert.include(script, '/internal/repo-config/');
		assert.include(script, 'X-FuzForge-Repo-Secret');
		// Argv-style now (subprocess.run) rather than the bash inline form.
		assert.include(script, '"merge-base", "--is-ancestor"');
		// stdlib only — no `curl` / `sed` shellouts the way the bash version had.
		assert.include(script, 'urllib.request');
	});

	test('post-receive POSTs to /internal/repo-receive-callback with secret header', () => {
		const script = render_post_receive_hook(options);
		assert.match(script, /^#!\/usr\/bin\/env python3/);
		assert.include(script, "FUZ_FORGE_REPO_ID = 'fuz_app'");
		assert.include(script, '/internal/repo-receive-callback');
		assert.include(script, 'X-FuzForge-Repo-Secret');
		// Body is built via `json.dumps` rather than bash string concat,
		// so an exotic `account.username` can't break the payload.
		assert.include(script, 'json.dumps');
		assert.include(script, 'urllib.request');
	});

	test('python_literal handles backslash, control chars, and high codepoints', () => {
		// Render via the hook scripts (the helper isn't exported) — drive each
		// problematic character through `hook_secret` and assert the rendered
		// literal contains the expected Python escape, then `eval`-equivalent
		// by checking the literal's regex shape.
		const cases: Array<{ secret: string; needle: string }> = [
			{ secret: 'plain', needle: "'plain'" },
			{ secret: "with'apos", needle: `'with\\'apos'` },
			{ secret: 'with\\back', needle: `'with\\\\back'` },
			{ secret: 'with\nnewline', needle: `'with\\nnewline'` },
			{ secret: 'with\x00null', needle: `'with\\x00null'` },
			{ secret: 'with\x7fdel', needle: `'with\\x7fdel'` },
			{ secret: 'withéaccent', needle: `'with\\u00e9accent'` }
		];
		for (const { secret, needle } of cases) {
			const script = render_post_receive_hook({
				id: 'x',
				hook_secret: secret,
				callback_url_base: 'http://127.0.0.1:4041'
			});
			assert.include(
				script,
				`FUZ_FORGE_HOOK_SECRET = ${needle}`,
				`secret ${JSON.stringify(secret)} → ${needle}`
			);
		}
	});
});

describe('seed_clone_args', () => {
	// The seed clone's argv is a security surface written twice, so both halves
	// are asserted against `src/test/fixtures/parity/seed_clone.json`, which the
	// Rust twin's `seed_clone_args_match_the_ts_twin` reads too.
	const fixture = load_parity_fixture('seed_clone');

	test('the shared -c overrides, in order', () => {
		assert.deepEqual(
			[...SEED_CLONE_GIT_CONFIG],
			parity_rows(fixture, 'config').map((row) => parity_string(row, 'value'))
		);
	});

	test('the shared argv', () => {
		for (const row of parity_rows(fixture, 'argv')) {
			assert.deepEqual(
				seed_clone_args(parity_string(row, 'url'), parity_string(row, 'dest')),
				row.expected
			);
		}
	});
});

describe('init / clone / install_hooks (filesystem)', () => {
	let store_root: string;
	let upstream: UpstreamGitServer;
	const runtime = create_node_runtime([]);

	// Storage runs git/chmod through the forge's own `SpawnCollect` (explicit
	// env, no stdin) — see `RepoCommandDeps`. The assertions read the repos
	// back with the test `git` runner.
	const make_runtime_with_store = (store: string) => ({
		...runtime,
		spawn_collect,
		env_get: (name: string) => {
			if (name === 'FUZ_FORGE_REPO_STORE_PATH') return store;
			if (name === 'HOME') return runtime.env_get('HOME');
			return runtime.env_get(name);
		}
	});

	beforeAll(async () => {
		store_root = join(tmpdir(), `fuz_forge-repo-${randomBytes(16).toString('hex')}`);
		await mkdir(store_root, { recursive: true });

		// Seed clones go over HTTP, the only transports `SEED_CLONE_GIT_CONFIG`
		// admits — a local path would be refused by the transport pin.
		upstream = await create_upstream_git_server('storage');
	});

	afterAll(async () => {
		if (upstream) await upstream.close();
		if (store_root) await rm(store_root, { recursive: true, force: true });
	});

	let id_counter = 0;
	const fresh_id = (label: string): string => {
		id_counter++;
		return `${label}-${id_counter}-${randomBytes(4).toString('hex')}`;
	};

	let scoped_store: string;
	beforeEach(async () => {
		scoped_store = join(store_root, `case-${randomBytes(6).toString('hex')}`);
		await mkdir(scoped_store, { recursive: true });
	});

	test('init_bare_repo produces a valid bare repo at <store>/<id>.git', async () => {
		const id = fresh_id('init');
		const deps = make_runtime_with_store(scoped_store);
		const result = await init_bare_repo(deps, id);
		assert.strictEqual(result.path, `${scoped_store}/${id}.git`);

		// HEAD + refs/ + objects/ are the load-bearing pieces of bare layout.
		assert.isTrue(await file_exists(`${result.path}/HEAD`));
		assert.isTrue(await file_exists(`${result.path}/refs`));
		assert.isTrue(await file_exists(`${result.path}/objects`));

		// `core.bare` should be true for a bare repo.
		const config_check = await git(result.path, ['config', 'core.bare']);
		assert.strictEqual(config_check.stdout.trim(), 'true');

		// http.receivepack must be enabled — git http-backend uses this
		// gate to decide whether the repo accepts HTTP push. Per-repo
		// opt-in (vs blanket GIT_HTTP_EXPORT_ALL) is the locked-down
		// posture for forge repos.
		const http_receive = await git(result.path, ['config', 'http.receivepack']);
		assert.strictEqual(http_receive.stdout.trim(), 'true');

		const http_upload = await git(result.path, ['config', 'http.uploadpack']);
		assert.strictEqual(http_upload.stdout.trim(), 'true');

		// `git-daemon-export-ok` marker — the per-repo opt-in gate that
		// git http-backend enforces when `GIT_HTTP_EXPORT_ALL` is unset.
		assert.isTrue(await file_exists(`${result.path}/git-daemon-export-ok`));
	});

	test('init_bare_repo leaves the repo dir with no group/world bits', async () => {
		const id = fresh_id('init-perms');
		const deps = make_runtime_with_store(scoped_store);
		const result = await init_bare_repo(deps, id);

		// `chmod -R go-rwx` is the post-init lockdown — every entry under
		// the repo root must have group=0, world=0. Owner bits are
		// preserved as git set them. The hook script chmod (0700) runs
		// separately in install_hooks; this assertion covers the repo
		// content (HEAD, refs/, objects/, hooks dir).
		const root_stat = await fs_stat(result.path);
		assert.strictEqual(
			root_stat.mode & 0o077,
			0,
			`repo root has group/world bits set: ${(root_stat.mode & 0o777).toString(8)}`
		);
		const hooks_stat = await fs_stat(`${result.path}/hooks`);
		assert.strictEqual(
			hooks_stat.mode & 0o077,
			0,
			`hooks dir has group/world bits set: ${(hooks_stat.mode & 0o777).toString(8)}`
		);
		const head_stat = await fs_stat(`${result.path}/HEAD`);
		assert.strictEqual(
			head_stat.mode & 0o077,
			0,
			`HEAD has group/world bits set: ${(head_stat.mode & 0o777).toString(8)}`
		);
	});

	test('init_bare_repo refuses to overwrite an existing path', async () => {
		const id = fresh_id('init-existing');
		const deps = make_runtime_with_store(scoped_store);
		await init_bare_repo(deps, id);
		await assert_rejects(() => init_bare_repo(deps, id), /already exists/);
	});

	test('every storage subprocess runs under the isolated git env', async () => {
		// The security contract behind `RepoCommandDeps`: the daemon's own
		// environment never reaches `git` or `chmod`. `HOME` in particular
		// would pull in `~/.gitconfig`'s `credential.helper` and
		// `url.<base>.insteadOf` — the latter silently rewriting the remote a
		// validated, canonicalized `seed_from` names.
		const id = fresh_id('env');
		const base = make_runtime_with_store(scoped_store);
		const envs: Array<Record<string, string>> = [];
		const recording_deps = {
			...base,
			spawn_collect: (
				cmd: string,
				args: ReadonlyArray<string>,
				options: { env: Record<string, string> }
			) => {
				envs.push(options.env);
				return spawn_collect(cmd, args, options);
			}
		};
		await init_bare_repo(recording_deps, id);
		await install_hooks(recording_deps, {
			id,
			hook_secret: 'shh',
			callback_url_base: 'http://127.0.0.1:4041'
		});

		assert.isAbove(envs.length, 0, 'storage must spawn at least one subprocess');
		for (const env of envs) {
			assert.deepStrictEqual(
				Object.keys(env).sort(),
				['GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'LC_ALL', 'PATH'],
				'the subprocess env is exactly the four isolated vars'
			);
			assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');
			assert.strictEqual(env.GIT_CONFIG_NOSYSTEM, '1');
		}
	});

	test('init_bare_repo leaves no .tmp residue on git failure', async () => {
		const id = fresh_id('init-fail');
		// Force git to fail by stubbing the subprocess primitive.
		const deps = make_runtime_with_store(scoped_store);
		const failing_deps = {
			...deps,
			spawn_collect: async () => ({
				success: false,
				code: 128,
				stdout: new Uint8Array(),
				stderr: new TextEncoder().encode('fatal: synthetic failure')
			})
		};
		await assert_rejects(() => init_bare_repo(failing_deps, id), /git init --bare failed/);

		const entries = await readdir(scoped_store);
		const tmp_residue = entries.filter((e) => e.includes('.tmp'));
		assert.strictEqual(tmp_residue.length, 0, `unexpected tmp residue: ${tmp_residue.join(',')}`);
		assert.notInclude(entries, `${id}.git`);
	});

	test('clone_bare_repo from a seed yields a bare repo with the seed refs', async () => {
		const id = fresh_id('clone');
		const deps = make_runtime_with_store(scoped_store);
		const result = await clone_bare_repo(deps, id, upstream.url);
		assert.strictEqual(result.path, `${scoped_store}/${id}.git`);

		const refs_result = await git(result.path, ['for-each-ref', '--format=%(refname)']);
		assert.include(refs_result.stdout, 'refs/heads/main');

		const config_check = await git(result.path, ['config', 'core.bare']);
		assert.strictEqual(config_check.stdout.trim(), 'true');

		const http_receive = await git(result.path, ['config', 'http.receivepack']);
		assert.strictEqual(http_receive.stdout.trim(), 'true');
	});

	test('clone_bare_repo refuses a redirect without dialing its target', async () => {
		// The host policy judges the seed URL it was handed, so a redirect is a
		// way past it: an admitted public host answers `302` to a loopback or
		// link-local address. Here the target is a real clonable upstream that
		// counts its requests, so a clone that followed the redirect would
		// succeed rather than merely fail differently.
		const id = fresh_id('clone-redirect');
		const deps = make_runtime_with_store(scoped_store);
		const target_hits_before = upstream.request_count();
		const redirect = await create_redirect_server(upstream.url);
		try {
			await assert_rejects(
				() => clone_bare_repo(deps, id, redirect.url),
				/git clone --bare failed/
			);
			assert.isAbove(redirect.request_count(), 0, 'the clone dialed the seed origin');
			assert.strictEqual(
				upstream.request_count(),
				target_hits_before,
				'the clone must not dial the redirect target'
			);
		} finally {
			await redirect.close();
		}
		assert.notInclude(await readdir(scoped_store), `${id}.git`);
	});

	test('clone_bare_repo refuses a non-http transport', async () => {
		// The transport pin holds independently of the `seed_from` grammar: a
		// local path (git's `file` transport) is refused by git itself.
		const id = fresh_id('clone-file');
		const deps = make_runtime_with_store(scoped_store);
		await assert_rejects(
			() => clone_bare_repo(deps, id, upstream.path),
			/transport 'file' not allowed/
		);
	});

	test('clone_bare_repo refuses to overwrite an existing path', async () => {
		const id = fresh_id('clone-existing');
		const deps = make_runtime_with_store(scoped_store);
		await clone_bare_repo(deps, id, upstream.url);
		await assert_rejects(() => clone_bare_repo(deps, id, upstream.url), /already exists/);
	});

	test('install_hooks writes pre-receive + post-receive with 0700 mode', async () => {
		const id = fresh_id('hooks');
		const deps = make_runtime_with_store(scoped_store);
		await init_bare_repo(deps, id);
		await install_hooks(deps, {
			id,
			hook_secret: 'shh',
			callback_url_base: 'http://127.0.0.1:4041'
		});

		const hooks_dir = `${scoped_store}/${id}.git/hooks`;
		for (const name of HOOK_NAMES) {
			const path = `${hooks_dir}/${name}`;
			assert.isTrue(await file_exists(path), `expected hook ${name} to exist`);

			const stat = await fs_stat(path);
			// 0700 — owner rwx, no group / world bits. The hook script embeds
			// the per-repo callback secret in plaintext; world-readable
			// permissions would leak it to any local shell account.
			assert.strictEqual(
				stat.mode & 0o777,
				0o700,
				`hook ${name} has unexpected mode ${(stat.mode & 0o777).toString(8)}`
			);

			const contents = await readFile(path, 'utf-8');
			assert.match(contents, /^#!\/usr\/bin\/env python3/);
			assert.include(contents, 'X-FuzForge-Repo-Secret');
		}
	});
});
