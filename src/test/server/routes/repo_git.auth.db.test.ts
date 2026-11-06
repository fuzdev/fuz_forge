/**
 * Auth-failure tests for the git smart-HTTP routes.
 *
 * The locked-down posture (in-handler HTTP Basic + admin role,
 * Origin/Referer rejection, generic 401 on every failure) is the
 * primary security surface of the forge. This file exhaustively
 * exercises those gates via `app.request()` — every test asserts that
 * unauthorized callers receive 401 (or 503 on the no-subprocess
 * configuration) and never reach the subprocess.
 *
 * The Basic **username** is not one of those gates and never has been: the
 * token identifies the account on its own, so any username passes with a
 * valid token (GitHub/GitLab PAT semantics — see
 * `server/routes/repo_git_auth.ts`). That acceptance is asserted directly by
 * `repo_git.cgi_head.db.test.ts`; nothing here refuses a mismatch.
 *
 * Real git protocol round-trip lives in `repo_git.integration.db.test.ts`,
 * which spins up an actual listening server.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { ROLE_ADMIN, ROLE_KEEPER } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { create_test_app, type TestApp } from '@fuzdev/fuz_app/testing/app_server.ts';
import type { AppServerContext } from '@fuzdev/fuz_app/server/app_server_context.ts';
import { TEST_ORIGIN } from '@fuzdev/fuz_app/testing/test_origin.ts';
import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { fuz_forge_session_config } from '#lib/server/routes/account.ts';
import { create_fuz_forge_app_route_specs } from '#lib/server/routes/fuz_forge_route_specs.ts';
import { repo_cell_path, type RepoCellData } from '#lib/fuz_forge/repo/plan_repo.ts';
import { query_cell_create } from '@fuzdev/fuz_app/db/cell_queries.ts';
import { query_actor_soft_delete } from '@fuzdev/fuz_app/auth/account_queries.ts';

import { describe_db } from '../../db_fixture.ts';
import {
	test_file_route_deps,
	test_audit_sse_deps,
	test_facts_dir
} from './fuz_forge_test_helpers.ts';

const SLUG = 'fuzdev/fuz_app';

/**
 * Build a test app with `spawn_streaming: undefined` so handlers that
 * reach the subprocess return 503. Auth-failure tests use this to
 * verify they 401 BEFORE the no-subprocess gate fires.
 */
const build_test_app = async (get_db: () => Db): Promise<TestApp> => {
	const log = new Logger('test-repo-git-auth', { level: 'off' });
	const create_route_specs = (ctx: AppServerContext) => {
		const query_deps: QueryDeps = { db: ctx.deps.db };
		return create_fuz_forge_app_route_specs(ctx, {
			audit_sse: test_audit_sse_deps(),
			fuz_forge: {
				runtime: undefined as never,
				query_deps,
				seed_from_allow_private_hosts: false,
				log
			},
			files: test_file_route_deps({
				query_deps,
				max_upload_bytes: 1024,
				fact_store: undefined as never
			}),
			repo_git: {
				runtime: { env_get: (name: string) => (name === 'PATH' ? '/usr/bin' : undefined) } as never,
				query_deps,
				spawn_streaming: undefined,
				log
			},
			repo_internal: {
				query_deps,
				broadcast: {
					fuz_forge_run_created: async () => undefined,
					fuz_forge_run_updated: async () => undefined,
					fuz_forge_repo_updated: async () => undefined
				} as never,
				log,
				get_connection_ip: () => '127.0.0.1'
			},
			version: '0.0.0-test',
			get_uptime_ms: () => 0,
			facts_dir: test_facts_dir()
		});
	};
	return await create_test_app({
		session_options: fuz_forge_session_config,
		create_route_specs,
		db: get_db(),
		roles: [ROLE_ADMIN]
	});
};

/**
 * An `Origin` the test app's allowlist admits (`localhost`). The git gate refuses
 * any `Origin` in-handler, so its refusal is only reachable past the origin
 * check, which answers a foreign one with `403` first.
 */
const ALLOWED_ORIGIN = TEST_ORIGIN;

const seed_repo_cell = async (db: Db): Promise<void> => {
	const deps: QueryDeps = { db };
	const data: RepoCellData = {
		slug: SLUG,
		name: 'fuz_app',
		default_branch: 'main',
		seed_from: null,
		seed_completed_at: null,
		hook_secret_hash: 'secret',
		head_sha: null,
		last_pushed_at: null,
		last_pushed_by: null,
		last_push_username: null
	};
	await query_cell_create(deps, { path: repo_cell_path(SLUG), data, kind: 'repo' });
};

/** Build a Basic auth header from username + password. */
const basic_header = (username: string, password: string): string =>
	`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

const advertise = async (
	test_app: TestApp,
	headers: Record<string, string>,
	service = 'git-upload-pack'
): Promise<Response> =>
	await test_app.app.request(`/${SLUG}.git/info/refs?service=${service}`, {
		method: 'GET',
		headers
	});

const post_pack = async (
	test_app: TestApp,
	endpoint: 'git-upload-pack' | 'git-receive-pack',
	headers: Record<string, string>,
	body: Uint8Array = new Uint8Array(0)
): Promise<Response> =>
	await test_app.app.request(`/${SLUG}.git/${endpoint}`, {
		method: 'POST',
		headers: { 'Content-Type': `application/x-${endpoint}-request`, ...headers },
		body: body as unknown as BodyInit
	});

describe_db('repo_git auth failure paths', (get_db) => {
	describe('GET /:slug.git/info/refs', () => {
		test('rejects request with no Authorization header (generic 401)', async () => {
			const test_app = await build_test_app(get_db);
			await seed_repo_cell(get_db());
			const res = await advertise(test_app, {});
			assert.strictEqual(res.status, 401);
			assert.match(res.headers.get('WWW-Authenticate') ?? '', /^Basic realm=/);
		});

		test('rejects malformed Authorization (not "Basic ...") with 401', async () => {
			const test_app = await build_test_app(get_db);
			await seed_repo_cell(get_db());
			const res = await advertise(test_app, {
				Authorization: 'Bearer some-token'
			});
			assert.strictEqual(res.status, 401);
		});

		test('rejects request with Origin header (browser-context replay defense)', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());
			// an allowed Origin, so the origin check passes and the git gate's own
			// any-Origin refusal is what answers (a foreign one is the check's 403)
			const res = await advertise(test_app, {
				Authorization: basic_header(admin.account.username, admin.api_token),
				Origin: ALLOWED_ORIGIN
			});
			assert.strictEqual(res.status, 401);
		});

		test('rejects request with Referer header', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());
			const res = await advertise(test_app, {
				Authorization: basic_header(admin.account.username, admin.api_token),
				Referer: 'http://evil.example/page'
			});
			assert.strictEqual(res.status, 401);
		});

		test('rejects bad password (token does not match) with 401', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());
			const res = await advertise(test_app, {
				Authorization: basic_header(admin.account.username, 'wrong-token')
			});
			assert.strictEqual(res.status, 401);
		});

		test('rejects valid token without admin role (keeper-only account)', async () => {
			const test_app = await build_test_app(get_db);
			const keeper = await test_app.create_account({ roles: [ROLE_KEEPER] });
			await seed_repo_cell(get_db());
			const res = await advertise(test_app, {
				Authorization: basic_header(keeper.account.username, keeper.api_token)
			});
			assert.strictEqual(res.status, 401);
		});

		test('rejects unknown slug with 401 (no enumeration)', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			// Do NOT seed the cell — slug lookup will fail post-auth.
			const res = await advertise(test_app, {
				Authorization: basic_header(admin.account.username, admin.api_token)
			});
			assert.strictEqual(res.status, 401);
		});

		test('rejects empty Basic auth (empty username and password)', async () => {
			const test_app = await build_test_app(get_db);
			await seed_repo_cell(get_db());
			const res = await advertise(test_app, {
				Authorization: 'Basic ' + Buffer.from(':').toString('base64')
			});
			assert.strictEqual(res.status, 401);
		});

		test('valid admin token + known slug reaches subprocess (503 with no spawn)', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());
			const res = await advertise(test_app, {
				Authorization: basic_header(admin.account.username, admin.api_token)
			});
			// All auth gates pass; the route reaches `proxy_to_git_http_backend`
			// which 503s because `spawn_streaming: undefined` in this fixture.
			// This locks the "no auth surface short-circuit before reaching
			// subprocess" invariant for the auth-success path.
			assert.strictEqual(res.status, 503);
		});

		test('rejects an admin whose granting actor is soft-deleted', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());
			// Control: the same credential reaches the subprocess while the
			// actor is live, so the 401 below is the role gate and not the
			// token, the slug, or the browser-context guard.
			const live = await advertise(test_app, {
				Authorization: basic_header(admin.account.username, admin.api_token)
			});
			assert.strictEqual(live.status, 503, 'a live admin reaches the subprocess');

			// Tombstone the actor the admin grant hangs off, leaving the account
			// and the api_token untouched — the state `account_delete` can never
			// produce over the wire, since it revokes every token on the account.
			// The gate reads the grant off `api_token.account_id` with no
			// acting-actor resolution in front of it, so only the tombstone-aware
			// query excludes it.
			const soft_deleted = await query_actor_soft_delete(
				{ db: get_db() },
				admin.actor.id,
				admin.actor.id
			);
			assert.ok(soft_deleted, 'the actor should soft-delete');

			const res = await advertise(test_app, {
				Authorization: basic_header(admin.account.username, admin.api_token)
			});
			assert.strictEqual(res.status, 401, 'a grant on a tombstoned actor must not admit');
		});

		test('mixed-case URL slug resolves the lowercase-stored cell (case-insensitive)', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			// Cell is stored at the lowercase SLUG; request a mixed-case form of it.
			await seed_repo_cell(get_db());
			const res = await test_app.app.request(
				`/FuzDev/Fuz_App.git/info/refs?service=git-upload-pack`,
				{
					method: 'GET',
					headers: {
						Authorization: basic_header(admin.account.username, admin.api_token)
					}
				}
			);
			// The slug folds to lowercase at lookup, so the cell resolves and the
			// route reaches `proxy_to_git_http_backend` → 503 (spawn undefined),
			// NOT a 401-as-unknown-slug. This is the case-insensitive lookup.
			assert.strictEqual(res.status, 503);
		});

		test('rejects unknown service= query (post-auth) with 400', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());
			const res = await advertise(
				test_app,
				{
					Authorization: basic_header(admin.account.username, admin.api_token)
				},
				'totally-bogus'
			);
			assert.strictEqual(res.status, 400);
		});
	});

	describe('POST /:slug.git/git-upload-pack', () => {
		test('rejects request with no Authorization header with 401', async () => {
			const test_app = await build_test_app(get_db);
			await seed_repo_cell(get_db());
			const res = await post_pack(test_app, 'git-upload-pack', {});
			assert.strictEqual(res.status, 401);
		});

		test('rejects Origin header with 401', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());
			const res = await post_pack(test_app, 'git-upload-pack', {
				Authorization: basic_header(admin.account.username, admin.api_token),
				Origin: ALLOWED_ORIGIN
			});
			assert.strictEqual(res.status, 401);
		});
	});

	describe('POST /:slug.git/git-receive-pack', () => {
		test('rejects request with no Authorization header with 401', async () => {
			const test_app = await build_test_app(get_db);
			await seed_repo_cell(get_db());
			const res = await post_pack(test_app, 'git-receive-pack', {});
			assert.strictEqual(res.status, 401);
		});

		test('rejects keeper-only role with 401', async () => {
			const test_app = await build_test_app(get_db);
			const keeper = await test_app.create_account({ roles: [ROLE_KEEPER] });
			await seed_repo_cell(get_db());
			const res = await post_pack(test_app, 'git-receive-pack', {
				Authorization: basic_header(keeper.account.username, keeper.api_token)
			});
			assert.strictEqual(res.status, 401);
		});
	});
});
