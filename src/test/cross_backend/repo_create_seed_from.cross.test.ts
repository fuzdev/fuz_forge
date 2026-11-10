/**
 * Cross-process **`seed_from` grammar parity** — run against BOTH fuz_forge
 * backends (TS/Hono + Rust `fuz_forge_server`).
 *
 * `fuz_forge_repo_create`'s `seed_from` becomes the remote of a
 * `git clone --bare`, and git's transport set is far wider than "an upstream
 * on the web": a `file://` seed imports any bare repo on the host's disk into
 * a served repo, and `ext::` / `ssh://` / `git://` hand git a remote helper or
 * an unvetted protocol from the daemon's network position. Both backends hold
 * the value to one grammar — an absolute `http`/`https` URL with a host and no
 * embedded credentials — at **input validation**, before any disk or DB work:
 * a `check` on `FuzForgeRepoCreateInput` on TS, `require_seed_from_url`
 * in `handlers::seed_from` on Rust. The shared accept/reject/canonicalized
 * case tables are unit-pinned literally on both sides
 * (`src/test/fuz_forge/repo/seed_from.test.ts` and the `seed_from` test
 * module); this suite proves the refusal reaches the wire as the same code on
 * both, and that a refused create leaves no repo behind.
 *
 * Only `error.code` is asserted on the refusals, never the text. The Rust
 * backend puts `SEED_FROM_URL_MESSAGE` on the wire, but the TS dispatcher
 * flattens every input-schema failure to a bare `invalid params` (the
 * per-issue detail is DEV-only, under `data.issues`). `-32602` is the shared
 * contract; the wording is not.
 *
 * The second half is the positive control the negatives need: a
 * *grammar-valid* seed whose remote cannot be reached. Without it the
 * negatives would still pass on a backend that refused every `seed_from`.
 * It also pins the clone-failure envelope — `-32603` with the fixed
 * `repo create failed: seed clone failed` message on both, git's stderr
 * having been demoted to the server log because it names the store root, the
 * `.tmp` assembly scheme and the rolled-back cell UUID — and proves the cell
 * unwinds, by re-creating the same slug unseeded afterwards: a leaked cell
 * would answer `-32004` (slug conflict). The **on-disk** unwind is not
 * observable from here (the bare repo is keyed by a fresh cell UUID no client
 * ever learns); it is pinned in-process by the `readdir` before/after in
 * `src/test/server/routes/fuz_forge_repo_create_rpc.db.test.ts`.
 *
 * Host-range policy (loopback, link-local, unspecified, RFC 1918 / CGNAT /
 * ULA, and the `localhost` names) is a **third gate** past the grammar and the
 * canonicalization — `seed_from_host_is_private`, on by default. Both spawns
 * in this suite set `FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS=true`
 * (`fuz_forge_backend_config.ts`), which is what lets the unreachable-remote
 * control and the real upstream below be loopback URLs — the only spelling that
 * fails fast and identically on both backends without a DNS round-trip. The
 * default-on behavior of that gate is therefore *not* exercised here; it is
 * pinned in-process per backend (`fuz_forge_repo_create_rpc.db.test.ts` on TS,
 * the `seed_from` test module on Rust).
 *
 * Its third part is the **successful** clone, over a real loopback upstream
 * (`git_upstream_server.ts`), which is where canonicalization becomes
 * observable: the create is driven with a non-canonical spelling of the seed
 * and both backends must store, and hand back, the WHATWG serialization. The
 * negatives above prove a bad URL never reaches git; this proves the value git
 * *did* receive is the parser's, not the client's. Beside it, a seed whose
 * origin `302`s to that same upstream must fail without the upstream ever
 * being dialed: the clone refuses redirects, so the host the policy judged is
 * the only host git contacts.
 *
 * @module
 */

import { assert, test, describe, beforeAll, afterAll } from 'vitest';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';
import { assert_iso8601_seconds } from '@fuzdev/fuz_app/testing/cross_backend/wire_shapes.ts';

import { INVALID_PARAMS, INTERNAL_ERROR } from './rpc_helpers.ts';
import {
	FuzForgeRepoOutput,
	FuzForgeRepoLogOutput,
	FuzForgeRepoResyncOutput
} from '#lib/action_specs.ts';
import {
	create_redirect_server,
	create_upstream_git_server,
	type UpstreamGitServer
} from '../git_upstream_server.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);

/**
 * The fixed `-32603` message both backends answer a failed on-disk assembly
 * with. Pinnable precisely because it carries no detail — git's stderr goes
 * to the server log only. Twin constants: `REPO_CREATE_SEED_FAILED_MESSAGE` in
 * `src/lib/server/routes/fuz_forge_repo_write.ts` and in
 * `crates/fuz_forge_server/src/handlers/repo_write.rs`.
 */
const CREATE_FAILED_MESSAGE = 'repo create failed: seed clone failed';

/** Org segment owned by this suite, so the list count isolates its repos. */
const ORG = 'sfg';

/**
 * A grammar-valid seed whose remote refuses the connection immediately —
 * loopback port 1 is never listening, so `git clone` fails on ECONNREFUSED
 * with no DNS lookup and no timeout wait. Deterministic on both backends.
 */
const UNREACHABLE_SEED = 'https://127.0.0.1:1/x.git';

/** Count the repos this suite owns, so a leaked create is visible. */
const count_repos = async (fixture: Awaited<ReturnType<typeof setup_test>>): Promise<number> => {
	const listed = await rpc_call({
		app: fixture.transport,
		path: SPINE_RPC_PATH,
		method: 'fuz_forge_repo_list',
		params: { slug_prefix: `${ORG}/` },
		headers: fixture.create_session_headers()
	});
	assert.isTrue(listed.ok, `repo_list failed: ${JSON.stringify(listed)}`);
	return (listed.result as { repos: Array<unknown> }).repos.length;
};

describe('repo_create seed_from grammar (cross-process, both backends)', () => {
	test('an off-grammar seed_from is -32602 on both, and creates nothing', async () => {
		const fixture = await setup_test();
		const before = await count_repos(fixture);
		// One per rejection reason: a non-http scheme that reads a local repo,
		// a remote-helper transport, a scp-style handle the URL parser refuses
		// outright, an alternate protocol, and an http(s) URL carrying
		// credentials (refused because `seed_from` is stored on the cell). The
		// last pairs an off-grammar seed with an off-grammar *slug* to pin the
		// ordering: the two backends reach the seed grammar by different
		// routes (the whole input schema at dispatch on TS, `require_*` bounds
		// before `validate_repo_slug` on Rust), and both must answer -32602
		// rather than the slug's `validation_error`.
		const seeds: Array<{ slug: string; seed_from: string }> = [
			{ slug: `${ORG}/rejected`, seed_from: 'file:///etc' },
			{ slug: `${ORG}/rejected`, seed_from: 'ext::sh -c id' },
			{ slug: `${ORG}/rejected`, seed_from: 'git@example.com:x.git' },
			{ slug: `${ORG}/rejected`, seed_from: 'ssh://example.com/x' },
			{ slug: `${ORG}/rejected`, seed_from: 'https://user:pw@example.com/x' },
			{ slug: 'AB/CD!', seed_from: 'ext::sh -c id' }
		];
		for (const { slug, seed_from } of seeds) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_create',
				params: { slug, seed_from },
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `${seed_from} must be refused: ${JSON.stringify(res)}`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`${slug} + ${seed_from} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}
		assert.strictEqual(
			await count_repos(fixture),
			before,
			'a refused seed_from must not create a repo'
		);
	});

	test('a grammar-valid but unreachable seed reaches the clone and unwinds', async () => {
		// The positive control: this seed passes input validation on both
		// backends, so the failure can only come from `git clone --bare`. That
		// is what proves the refusals above are the grammar and not a blanket
		// `seed_from` refusal.
		const fixture = await setup_test();
		const before = await count_repos(fixture);
		const slug = `${ORG}/unreachable`;
		const res = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug, seed_from: UNREACHABLE_SEED },
			headers: fixture.create_session_headers()
		});
		assert.isFalse(res.ok, `an unreachable seed must fail: ${JSON.stringify(res)}`);
		assert.strictEqual(
			res.error.code,
			INTERNAL_ERROR,
			`a failed clone must be -32603 on both, got ${res.error.code} (${res.error.message})`
		);
		// Pinnable because it carries no detail: git's stderr would leak the
		// absolute store root, the `.tmp` scheme and the rolled-back UUID.
		assert.strictEqual(
			res.error.message,
			CREATE_FAILED_MESSAGE,
			'a failed clone must answer the fixed message on both'
		);
		assert.strictEqual(
			await count_repos(fixture),
			before,
			'a failed clone must roll the cell back'
		);

		// Re-create the same slug unseeded: a leaked cell would answer a slug
		// conflict. This says nothing about the on-disk unwind — the bare repo
		// is keyed by a fresh cell UUID, so the retry can never collide with
		// the leaked path; that half is pinned in-process by the `readdir`
		// before/after in `server/routes/fuz_forge_repo_create_rpc.db.test.ts`.
		const recreated = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(
			recreated.ok,
			`the slug must be free after a failed seed: ${JSON.stringify(recreated)}`
		);
	});

	describe('a successful seeded create', () => {
		let upstream: UpstreamGitServer;

		beforeAll(async () => {
			upstream = await create_upstream_git_server('seed_from_cross');
		});

		afterAll(async () => {
			if (upstream) await upstream.close();
		});

		test('stores the WHATWG serialization of a non-canonical seed_from', async () => {
			const fixture = await setup_test();
			const slug = `${ORG}/seeded`;
			// Non-canonical in two ways the WHATWG parser normalizes: an
			// uppercase scheme, and no path at all. Both backends must store the
			// *parser's* serialization rather than the bytes the client sent —
			// the same rule that makes the validated host the host git dials in
			// the `\`-authority case the unit tables pin.
			const noncanonical = `HTTP://127.0.0.1:${upstream.port}`;
			assert.notStrictEqual(noncanonical, upstream.url, 'the spelling is non-canonical');

			const created = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_create',
				params: { slug, seed_from: noncanonical },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(created.ok, `seeded create failed: ${JSON.stringify(created)}`);
			const repo = parse_or_throw(FuzForgeRepoOutput, (created.result as { repo: unknown }).repo);
			assert.strictEqual(repo.seed_from, upstream.url, 'the create response is canonical');
			// Stamped at create time on both, in the canonical second-precision
			// UTC wire shape (fuz_app's `assert_iso8601_seconds`) rather than merely "a string".
			assert.ok(repo.seed_completed_at, 'a seeded create stamps seed_completed_at');
			assert_iso8601_seconds(repo.seed_completed_at, 'create → seed_completed_at');
			// A seeded create resolves the cloned default-branch tip into the
			// cell before it answers, so a freshly mirrored repo is browsable
			// immediately. Without it `fuz_forge_repo_log` takes its
			// never-pushed shortcut on the null `head_sha` and the commit log
			// reads EMPTY until someone resyncs, while `_refs` / `_tree` /
			// `_blob` all work — mirroring is the forge's first use case, so the
			// tip is part of the create contract on both backends.
			assert.strictEqual(
				repo.head_sha,
				upstream.head_sha,
				'a seeded create carries the upstream tip'
			);

			// The stored value, not just the response DTO.
			const got = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_get',
				params: { slug },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(got.ok, `get failed: ${JSON.stringify(got)}`);
			const stored = parse_or_throw(FuzForgeRepoOutput, (got.result as { repo: unknown }).repo);
			assert.strictEqual(stored.seed_from, upstream.url, 'the stored seed_from is canonical');
			assert.strictEqual(stored.seed_completed_at, repo.seed_completed_at);
			// The create builds its response in memory, and the seeded tip is a
			// SECOND write on the row the insert just made — so the stamp it
			// reports has to be the one a read returns. (The two are equal today
			// on both backends: the writes share one transaction and Postgres
			// `NOW()` is transaction-scoped. This pins the wire contract, not the
			// mechanism.)
			assert.strictEqual(
				stored.updated_at,
				repo.updated_at,
				"the create response's updated_at is what a read returns"
			);
			assert.strictEqual(
				stored.head_sha,
				upstream.head_sha,
				'the tip is on the cell, not just the response'
			);

			// The commit log is populated straight away — the whole point of
			// resolving the tip at create time, and the assertion that would
			// still pass on a backend that only put the sha in the response.
			const log = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_log',
				params: { id: repo.id },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(log.ok, `log failed: ${JSON.stringify(log)}`);
			const log_out = parse_or_throw(FuzForgeRepoLogOutput, log.result);
			assert.deepEqual(
				log_out.commits.map((c) => c.sha),
				[upstream.head_sha],
				'a seeded repo browses its history without a resync'
			);

			// A resync is now a NO-OP, which is the control for the create-time
			// read: it proves the sha on the cell is the one the on-disk repo
			// resolves, not a value the create invented.
			const resynced = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_resync',
				params: { id: repo.id },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(resynced.ok, `resync failed: ${JSON.stringify(resynced)}`);
			const resync_out = parse_or_throw(FuzForgeRepoResyncOutput, resynced.result);
			assert.strictEqual(
				resync_out.previous_head_sha,
				upstream.head_sha,
				'the create already wrote the tip'
			);
			assert.strictEqual(
				resync_out.head_sha,
				resync_out.previous_head_sha,
				'a resync after a seeded create is a no-op'
			);
		});

		test('a seed that redirects is refused without dialing the target', async () => {
			// The host policy judges the seed URL it was handed, so a redirect
			// would be a way past it. The target is the real upstream, so a
			// backend that followed the redirect would answer a successful
			// create; the upstream's request count proves it was never dialed.
			const fixture = await setup_test();
			const before = await count_repos(fixture);
			const target_hits_before = upstream.request_count();
			const redirect = await create_redirect_server(upstream.url);
			try {
				const res = await rpc_call({
					app: fixture.transport,
					path: SPINE_RPC_PATH,
					method: 'fuz_forge_repo_create',
					params: { slug: `${ORG}/redirected`, seed_from: redirect.url },
					headers: fixture.create_session_headers()
				});
				assert.isFalse(res.ok, `a redirecting seed must fail: ${JSON.stringify(res)}`);
				assert.strictEqual(res.error.code, INTERNAL_ERROR);
				assert.strictEqual(res.error.message, CREATE_FAILED_MESSAGE);
				assert.isAbove(redirect.request_count(), 0, 'the clone dialed the seed origin');
			} finally {
				await redirect.close();
			}
			assert.strictEqual(
				upstream.request_count(),
				target_hits_before,
				'the clone must not dial the redirect target'
			);
			assert.strictEqual(
				await count_repos(fixture),
				before,
				'a refused redirect must roll the cell back'
			);
		});

		test('an unseeded create has no tip until the first push', async () => {
			// The other half of the contract: only a *seeded* create resolves a
			// tip, because only a seeded repo has one. An empty repo stays
			// `head_sha: null` with the empty log, exactly as before.
			const fixture = await setup_test();
			const created = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_create',
				params: { slug: `${ORG}/unseeded` },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(created.ok, `create failed: ${JSON.stringify(created)}`);
			const repo = parse_or_throw(FuzForgeRepoOutput, (created.result as { repo: unknown }).repo);
			assert.strictEqual(repo.seed_from, null);
			assert.strictEqual(repo.seed_completed_at, null);
			assert.strictEqual(repo.head_sha, null, 'an unseeded create has no tip');

			const log = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_log',
				params: { id: repo.id },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(log.ok, `log failed: ${JSON.stringify(log)}`);
			assert.deepEqual(parse_or_throw(FuzForgeRepoLogOutput, log.result).commits, []);
		});
	});
});
