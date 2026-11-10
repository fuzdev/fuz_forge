/**
 * Handler-level tests for `fuz_forge_repo_create`.
 *
 * Uses a real Node runtime + a per-suite tmp store so the handler's disk
 * work runs for real: `git init --bare` (or `clone --bare` for the seed
 * path), HEAD symbolic-ref, hook install, and the cell insert. Asserts:
 *
 *   - create (no seed) → cell at `repos/<slug>`, bare repo at
 *     `<store>/<cell.id>.git`, HEAD on the default branch, hooks present,
 *     and the wire id is the cell-id UUID
 *   - duplicate slug → conflict
 *   - invalid slug shape → validation error
 *   - `default_branch` override is honored
 *   - `seed_from` clones an upstream and stamps `seed_completed_at`
 *   - an off-grammar `seed_from` is refused at dispatch, before any disk work
 *   - a grammar-valid but unreachable `seed_from` fails the clone, answers the
 *     fixed `-32603` message, and leaves neither a cell nor a store entry
 *   - with the operator override **off** (a second app), a private-host
 *     `seed_from` is refused with the full `-32602` envelope before any work
 *
 * The seed upstream is served over **dumb HTTP** from a loopback
 * `node:http` static server rather than handed to git as a local path: the
 * `seed_from` grammar (`seed_from_url_canonical`) admits only absolute
 * http(s) URLs, so a `file://` or bare-path seed no longer reaches the
 * handler. That fixture is `git_upstream_server.ts`, shared with
 * the cross-backend suite that drives the same clone over real wires — it owns
 * its own scratch directory, so this suite's store root holds nothing but the
 * repos the handler creates.
 *
 * The failed-clone case is the only place either backend's **on-disk** unwind
 * is observable: the bare repo is keyed by a freshly minted cell UUID, so no
 * black-box caller can name the path it would leak. This suite owns the
 * store root, so it can `readdir` it before and after — which is why the
 * cross-backend twin claims the cell rollback only.
 *
 * The generated RPC round-trip suite skips this method (side-effecting +
 * a two-segment slug the body generator can't synthesize), so this file
 * is its primary coverage.
 *
 * @module
 */

import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, test, beforeAll, afterAll, beforeEach } from 'vitest';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import type { TestApp, TestAccount } from '@fuzdev/fuz_app/testing/app_server.ts';
import { create_node_runtime } from '@fuzdev/fuz_app/runtime/node.ts';
import { query_cell_get_by_path } from '@fuzdev/fuz_app/db/cell_queries.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { repo_cell_path, type RepoCellData } from '#lib/fuz_forge/repo/plan_repo.ts';
import { build_rpc_endpoint_specs } from '#lib/server/routes/fuz_forge_route_specs.ts';
import { hash_hook_secret } from '#lib/server/routes/fuz_forge_repo_cell.ts';
import { REPO_CREATE_SEED_FAILED_MESSAGE } from '#lib/server/routes/fuz_forge_repo_write.ts';
import { SEED_FROM_HOST_MESSAGE } from '#lib/fuz_forge/repo/seed_from.ts';
import { spawn_collect } from '#lib/server/subprocess.ts';
import { ISO8601_SECONDS } from '#lib/server/timestamp.ts';

import { git } from '../../cross_backend/git_helpers.ts';
import { describe_db } from '../../db_fixture.ts';
import { create_upstream_git_server, type UpstreamGitServer } from '../../git_upstream_server.ts';
import { create_fuz_forge_test_app } from './fuz_forge_test_helpers.ts';

const path_exists = async (p: string): Promise<boolean> => {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
};

describe_db('fuz_forge_repo_create', (get_db) => {
	let test_app: TestApp;
	let admin: TestAccount;
	let store_root: string;
	let upstream: UpstreamGitServer;
	const runtime = create_node_runtime([]);

	beforeAll(async () => {
		store_root = join(tmpdir(), `fuz_forge-create-${randomBytes(16).toString('hex')}`);
		await mkdir(store_root, { recursive: true });

		upstream = await create_upstream_git_server('create_rpc');

		// Runtime that resolves the repo store under the per-suite tmp dir.
		const scoped_runtime = {
			...runtime,
			env_get: (name: string) =>
				name === 'FUZ_FORGE_REPO_STORE_PATH' ? store_root : runtime.env_get(name)
		};

		test_app = await create_fuz_forge_test_app(get_db, {
			roles: [ROLE_ADMIN],
			rpc_endpoints: (ctx) =>
				build_rpc_endpoint_specs(ctx, {
					fuz_forge_deps: {
						runtime: scoped_runtime,
						query_deps: { db: ctx.deps.db },
						spawn_collect,
						seed_from_allow_private_hosts: true,
						log: new Logger('test', { level: 'off' })
					},
					extra_actions: [],
					notification_sender: null,
					final_actions_factory: null
				})
		});
	});

	afterAll(async () => {
		if (upstream) await upstream.close();
		if (store_root) await rm(store_root, { recursive: true, force: true });
	});

	beforeEach(async () => {
		admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
	});

	test('creates the bare repo, hooks, and cell (no seed)', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_create',
			params: { slug: 'fuzdev/new_repo' },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok, JSON.stringify(res));
		const { repo } = res.result as { repo: Record<string, unknown> };
		assert.strictEqual(repo.slug, 'fuzdev/new_repo');
		assert.strictEqual(repo.name, 'new_repo');
		assert.strictEqual(repo.default_branch, 'main');
		assert.strictEqual(repo.seed_from, null);
		// Only a *seeded* create resolves a tip, because only a seeded repo has
		// one: an empty repo has no default-branch tip until the first push.
		assert.strictEqual(repo.head_sha, null);
		assert.strictEqual(typeof repo.id, 'string');
		const id = repo.id as string;

		// Cell at `repos/<slug>` mirrors the output.
		const cell = await query_cell_get_by_path({ db: get_db() }, repo_cell_path('fuzdev/new_repo'));
		assert.ok(cell);
		assert.strictEqual(cell.id, id);
		assert.strictEqual(cell.created_by, admin.actor.id);
		// `kind` is the top-level `cell.kind` column, no longer inside `data`.
		assert.strictEqual(cell.kind, 'repo');
		const data = cell.data as RepoCellData;
		assert.strictEqual(data.name, 'new_repo');
		// The cell holds the 64-hex digest; the plaintext is only in the hooks.
		assert.match(data.hook_secret_hash, /^[0-9a-f]{64}$/);
		assert.isFalse('hook_secret' in data, 'no plaintext secret in the cell');

		// Bare repo + hooks on disk, keyed on the cell-id UUID.
		const bare = join(store_root, `${id}.git`);
		assert.isTrue(await path_exists(join(bare, 'HEAD')));
		assert.isTrue(await path_exists(join(bare, 'hooks', 'pre-receive')));
		assert.isTrue(await path_exists(join(bare, 'hooks', 'post-receive')));
		// The plaintext the hooks embed is what the cell's digest is of.
		for (const name of ['pre-receive', 'post-receive']) {
			const script = await readFile(join(bare, 'hooks', name), 'utf8');
			const embedded = /^FUZ_FORGE_HOOK_SECRET = '([^'\\]*)'$/m.exec(script);
			assert.ok(embedded, `${name} embeds the secret`);
			assert.strictEqual(hash_hook_secret(embedded[1]!), data.hook_secret_hash, name);
		}
		// HEAD points at the requested default branch.
		const head = await git(bare, ['symbolic-ref', 'HEAD']);
		assert.strictEqual(head.stdout.trim(), 'refs/heads/main');
		// The digest never appears in the wire payload.
		assert.notInclude(JSON.stringify(res.result), data.hook_secret_hash);
	});

	test('rejects a duplicate slug with a conflict', async () => {
		const params = { slug: 'fuzdev/dup_repo' };
		const first = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_create',
			params,
			headers: admin.create_session_headers()
		});
		assert.isTrue(first.ok);

		const second = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_create',
			params,
			headers: admin.create_session_headers()
		});
		assert.isFalse(second.ok);
		assert.include(second.error.message.toLowerCase(), 'already exists');
	});

	test('rejects an invalid slug shape with a validation error', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_create',
			// Passes the spec's bounded-string check but fails the strict
			// `RepoSlug` parse in the handler (no `/`).
			params: { slug: 'no_slash_here' },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'slug');
	});

	test('honors a default_branch override', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_create',
			params: { slug: 'fuzdev/trunk_repo', default_branch: 'trunk' },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok, JSON.stringify(res));
		const { repo } = res.result as { repo: { id: string; default_branch: string } };
		assert.strictEqual(repo.default_branch, 'trunk');
		const head = await git(join(store_root, `${repo.id}.git`), ['symbolic-ref', 'HEAD']);
		assert.strictEqual(head.stdout.trim(), 'refs/heads/trunk');
	});

	test('seeds from an upstream and stamps the canonical seed_from', async () => {
		// A non-canonical spelling of the same origin — uppercase scheme, no
		// path — so the stored value can only match by going through the WHATWG
		// parser. Passing an already-canonical URL here would leave
		// canonicalization unpinned on the success path (the reject table
		// covers only what the grammar refuses).
		const noncanonical = `HTTP://127.0.0.1:${upstream.port}`;
		assert.notStrictEqual(noncanonical, upstream.url);
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_create',
			params: { slug: 'fuzdev/seeded_repo', seed_from: noncanonical },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok, JSON.stringify(res));
		const { repo } = res.result as {
			repo: {
				id: string;
				seed_from: string;
				seed_completed_at: string;
				head_sha: string | null;
				updated_at: string;
			};
		};
		assert.strictEqual(repo.seed_from, upstream.url, 'the stored seed_from is the serialization');
		// The canonical second-precision UTC wire shape, not merely a string —
		// the Rust twin stamps this from `fuz_sys::rfc3339_now`.
		assert.match(repo.seed_completed_at, ISO8601_SECONDS);
		// The clone carried the upstream's commit.
		const rev = await git(join(store_root, `${repo.id}.git`), ['rev-parse', 'main']);
		assert.strictEqual(rev.stdout.trim(), upstream.head_sha);
		// A seeded create resolves that tip into the cell before it answers, so
		// the mirrored repo is browsable without a resync.
		assert.strictEqual(repo.head_sha, upstream.head_sha, 'the response carries the tip');
		const cell = await query_cell_get_by_path(
			{ db: get_db() },
			repo_cell_path('fuzdev/seeded_repo')
		);
		assert.ok(cell);
		assert.strictEqual(
			(cell.data as RepoCellData).head_sha,
			upstream.head_sha,
			'the tip is on the cell, not just the response'
		);

		// The create builds its response in memory, and the seeded tip is a
		// SECOND write on the row the insert just made — so the stamp it reports
		// has to be the one a read returns. (The two are equal today: the writes
		// share one transaction and Postgres `NOW()` is transaction-scoped. This
		// pins the wire contract, not the mechanism.)
		const got = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_get',
			params: { id: repo.id },
			headers: admin.create_session_headers()
		});
		assert.isTrue(got.ok, JSON.stringify(got));
		const stored = (got.result as { repo: { updated_at: string } }).repo;
		assert.strictEqual(
			stored.updated_at,
			repo.updated_at,
			"the create response's updated_at is what a read returns"
		);

		// The whole point of the create-time read: `fuz_forge_repo_log` takes a
		// never-pushed shortcut on a null `head_sha`, so without it a freshly
		// mirrored repo answers an EMPTY commit log.
		const log = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_log',
			params: { id: repo.id },
			headers: admin.create_session_headers()
		});
		assert.isTrue(log.ok, JSON.stringify(log));
		const { commits } = log.result as { commits: Array<{ sha: string }> };
		assert.deepStrictEqual(
			commits.map((c) => c.sha),
			[upstream.head_sha],
			'a seeded repo browses its history without a resync'
		);
	});

	test('an off-grammar seed_from is refused before any disk or DB work', async () => {
		// The grammar is a `check` on the input schema, so the dispatcher
		// rejects it — nothing reaches `clone_bare_repo`, and no cell is
		// written. A `file://` seed is the load-bearing case: without the
		// check it would import `__upstream.git` (any bare repo on the host's
		// disk) into a served repo.
		for (const seed_from of [
			`file://${upstream.path}`,
			upstream.path,
			'ext::sh -c id',
			'git@example.com:x.git',
			'https://user:pw@example.com/x.git'
		]) {
			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_create',
				params: { slug: 'fuzdev/rejected_seed', seed_from },
				headers: admin.create_session_headers()
			});
			assert.isFalse(res.ok, `${seed_from} must be refused: ${JSON.stringify(res)}`);
			assert.strictEqual(res.error.code, -32602, `${seed_from}: ${res.error.message}`);
			const cell = await query_cell_get_by_path(
				{ db: get_db() },
				repo_cell_path('fuzdev/rejected_seed')
			);
			assert.isNull(cell, `${seed_from} must not create a cell`);
		}
	});

	test('a failed clone unwinds the cell and the store directory', async () => {
		// Loopback port 1 is never listening, so `git clone` fails on
		// ECONNREFUSED with no DNS lookup and no timeout wait. The host policy
		// would normally refuse a loopback seed, but this app is built with
		// `seed_from_allow_private_hosts: true`, so the value passes all three
		// gates and the failure can only come from `clone_bare_repo`. The
		// default-off refusal is the separate describe below.
		const slug = 'fuzdev/unreachable_seed';
		const before = (await readdir(store_root)).sort();
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_create',
			params: { slug, seed_from: 'http://127.0.0.1:1/x.git' },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok, JSON.stringify(res));
		assert.strictEqual(res.error.code, -32603, res.error.message);
		// Fixed message — git's stderr names the store root, the `.tmp`
		// assembly path and the cell UUID that just rolled back.
		assert.strictEqual(res.error.message, REPO_CREATE_SEED_FAILED_MESSAGE);
		assert.notInclude(res.error.message, store_root);

		const cell = await query_cell_get_by_path({ db: get_db() }, repo_cell_path(slug));
		assert.isNull(cell, 'a failed clone must roll the cell back');
		// The on-disk unwind, which the cross-backend twin can't see: the bare
		// repo is keyed by a fresh cell UUID, so only a caller that owns the
		// store root can prove neither `<uuid>.git` nor its `.tmp` sibling
		// survived.
		assert.deepStrictEqual(
			(await readdir(store_root)).sort(),
			before,
			'a failed clone must leave no directory in the store'
		);
	});
});

/**
 * The `seed_from` **host policy** with the operator override off — the shape
 * the forge actually ships.
 *
 * Its own `describe_db`, and its own app, because the suite above deliberately
 * runs with `seed_from_allow_private_hosts: true` (every seed it drives is a
 * loopback upstream). So does every cross-backend spawn, which is why this
 * refusal has no wire pin anywhere else: the two backend configs set
 * `FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS=true` so the cross suite's positive
 * control can be a loopback URL. Without this file the gate that ships is
 * asserted only against the predicate, never through a dispatcher.
 *
 * The assertion is the **whole** error object rather than the code, because
 * every other seed refusal in this file is also a `-32602`: only the message
 * distinguishes the host gate from the grammar gate, and only the absent `data`
 * proves the refusal is the handler's `invalid_params` rather than a schema
 * failure carrying DEV-mode issues.
 *
 * The Rust twin is the `seed_from` unit table
 * (`require_seed_from_url_applies_the_host_policy_unless_overridden`), which
 * drives the same URLs through the same call the handler makes. A route-level
 * Rust twin would have to boot `build_router` over a real Postgres and would
 * land `#[ignore]`d — outside `cargo test --workspace` — so it would add a
 * second copy of this assertion without adding a gate.
 */
describe_db('fuz_forge_repo_create seed_from host policy', (get_db) => {
	let test_app: TestApp;
	let admin: TestAccount;
	let store_root: string;
	const runtime = create_node_runtime([]);

	beforeAll(async () => {
		store_root = join(tmpdir(), `fuz_forge-create-hostpolicy-${randomBytes(16).toString('hex')}`);
		await mkdir(store_root, { recursive: true });
		const scoped_runtime = {
			...runtime,
			env_get: (name: string) =>
				name === 'FUZ_FORGE_REPO_STORE_PATH' ? store_root : runtime.env_get(name)
		};
		test_app = await create_fuz_forge_test_app(get_db, {
			roles: [ROLE_ADMIN],
			rpc_endpoints: (ctx) =>
				build_rpc_endpoint_specs(ctx, {
					fuz_forge_deps: {
						runtime: scoped_runtime,
						query_deps: { db: ctx.deps.db },
						spawn_collect,
						// The shipped default — this is the whole point of the app.
						seed_from_allow_private_hosts: false,
						log: new Logger('test', { level: 'off' })
					},
					extra_actions: [],
					notification_sender: null,
					final_actions_factory: null
				})
		});
	});

	afterAll(async () => {
		if (store_root) await rm(store_root, { recursive: true, force: true });
	});

	beforeEach(async () => {
		admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
	});

	/**
	 * One spelling per refusal shape the wire can distinguish — the full
	 * literal / name / range tables are the shared unit ones in
	 * `fuz_forge/repo/seed_from.test.ts` and the `seed_from` test module,
	 * which is where breadth belongs. What this list adds is that each shape
	 * survives the round trip through the dispatcher.
	 */
	const NON_PUBLIC_HOST_SEEDS = [
		// loopback literal
		'http://127.0.0.1:1/x.git',
		// RFC 1918
		'https://10.1.2.3/x.git',
		// CGNAT
		'https://100.64.0.1/x.git',
		// the cloud metadata endpoint — the reason the gate exists
		'http://169.254.169.254/latest/meta-data/',
		// IPv6 loopback, and the v4-mapped spelling the parser rewrites
		'https://[::1]/x.git',
		'https://[::ffff:127.0.0.1]/x.git',
		// the two RFC 6761 loopback names
		'http://localhost/x.git',
		'http://evil.localhost/x.git',
		// an alternate IPv4 spelling the parser folds before the policy runs
		'https://2130706433/x.git'
	];

	test('a private-host seed is refused with the full envelope, before any disk or DB work', async () => {
		for (const seed_from of NON_PUBLIC_HOST_SEEDS) {
			const slug = 'fuzdev/non_public_host_seed';
			const before = (await readdir(store_root)).sort();
			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_create',
				params: { slug, seed_from },
				headers: admin.create_session_headers()
			});
			assert.isFalse(res.ok, `${seed_from} must be refused: ${JSON.stringify(res)}`);
			// The full object as it crosses the wire: code, the host message
			// (not the grammar one), and no `data` — a schema failure would
			// carry DEV-mode issues there, which is what tells the handler's
			// `invalid_params` apart from a `check` on the input schema. Compared
			// through a JSON round-trip because the in-process envelope carries
			// an own `data: undefined` key that never reaches a client.
			assert.deepStrictEqual(
				JSON.parse(JSON.stringify(res.error)),
				{ code: -32602, message: `invalid params: ${SEED_FROM_HOST_MESSAGE}` },
				`${seed_from} must answer the host-policy envelope`
			);
			const cell = await query_cell_get_by_path({ db: get_db() }, repo_cell_path(slug));
			assert.isNull(cell, `${seed_from} must not create a cell`);
			assert.deepStrictEqual(
				(await readdir(store_root)).sort(),
				before,
				`${seed_from} must not touch the store`
			);
		}
	});

	/**
	 * The non-vacuity control: the same app, the same slug, a public host. It
	 * gets past the host gate and fails at the clone instead — so the refusals
	 * above are the policy, not the app refusing every seed.
	 */
	test('a public host still reaches the clone on the same app', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_create',
			// An RFC 2606 `.invalid` name: the host policy admits it (a name,
			// not a literal, and not under `.localhost`) and DNS refuses it
			// immediately, so the clone fails fast without a connect timeout.
			// A TEST-NET literal would be admitted too but blocks for seconds.
			params: {
				slug: 'fuzdev/public_host_seed',
				seed_from: 'http://seed-control.invalid/x.git'
			},
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok, JSON.stringify(res));
		assert.strictEqual(
			res.error.code,
			-32603,
			`a public host must reach the clone, got ${res.error.message}`
		);
		assert.strictEqual(res.error.message, REPO_CREATE_SEED_FAILED_MESSAGE);
	});
});
