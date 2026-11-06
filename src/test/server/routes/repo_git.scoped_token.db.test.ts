/**
 * Scoped-token capability tests for the forge smart-HTTP
 * routes.
 *
 * The companion `repo_git.auth.db.test.ts` locks the unscoped auth
 * gates (HTTP Basic, admin role, Origin/Referer rejection). This file
 * adds the scoped-token policy layer: an authenticated admin token can
 * be **narrowed** so it only push/pulls specific repos.
 *
 * Capabilities key on the repo's cell-id UUID (the wire id), so the
 * policies built here reference the id returned by `seed_repo_cell`, not
 * the slug.
 *
 * Same fixture shape as `repo_git.auth.db.test.ts` — `spawn_streaming`
 * is `undefined` so handlers that pass all gates land on the
 * "subprocess unavailable" 503. A 503 = "auth + policy + service all
 * passed"; 401 = "any gate failed."
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { create_test_app, type TestApp } from '@fuzdev/fuz_app/testing/app_server.ts';
import type { AppServerContext } from '@fuzdev/fuz_app/server/app_server_context.ts';
import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { fuz_forge_session_config } from '#lib/server/routes/account.ts';
import { create_fuz_forge_app_route_specs } from '#lib/server/routes/fuz_forge_route_specs.ts';
import { repo_cell_path, type RepoCellData } from '#lib/fuz_forge/repo/plan_repo.ts';
import { repo_name_from_slug } from '#lib/fuz_forge/repo/repo_id.ts';
import { query_cell_create } from '@fuzdev/fuz_app/db/cell_queries.ts';
import { policy_from_template } from '#lib/server/fuz_forge_token_policy.ts';

import { describe_db } from '../../db_fixture.ts';
import {
	test_file_route_deps,
	test_audit_sse_deps,
	test_facts_dir
} from './fuz_forge_test_helpers.ts';
import { attach_policy, get_api_token_id_for_account } from './scoped_token_helpers.ts';

const SLUG = 'fuzdev/fuz_app';

const build_test_app = async (get_db: () => Db): Promise<TestApp> => {
	const log = new Logger('test-repo-git-scoped', { level: 'off' });
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

/** Seed a repo cell at `repos/<slug>` and return its cell-id UUID (the wire id). */
const seed_repo_cell = async (db: Db, slug: string): Promise<string> => {
	const deps: QueryDeps = { db };
	const data: RepoCellData = {
		slug,
		name: repo_name_from_slug(slug),
		default_branch: 'main',
		seed_from: null,
		seed_completed_at: null,
		hook_secret_hash: 'secret',
		head_sha: null,
		last_pushed_at: null,
		last_pushed_by: null,
		last_push_username: null
	};
	const cell = await query_cell_create(deps, { path: repo_cell_path(slug), data, kind: 'repo' });
	return cell.id;
};

const basic_header = (username: string, password: string): string =>
	`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

const advertise = async (
	test_app: TestApp,
	slug: string,
	service: 'git-upload-pack' | 'git-receive-pack',
	headers: Record<string, string>
): Promise<Response> =>
	await test_app.app.request(`/${slug}.git/info/refs?service=${service}`, {
		method: 'GET',
		headers
	});

const post_pack = async (
	test_app: TestApp,
	slug: string,
	endpoint: 'git-upload-pack' | 'git-receive-pack',
	headers: Record<string, string>
): Promise<Response> =>
	await test_app.app.request(`/${slug}.git/${endpoint}`, {
		method: 'POST',
		headers: { 'Content-Type': `application/x-${endpoint}-request`, ...headers },
		body: new Uint8Array(0) as unknown as BodyInit
	});

describe_db('repo_git scoped-token capability gating', (get_db) => {
	describe("unscoped token (regression: today's behavior)", () => {
		test('admin token with no policy row reaches subprocess for push', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db(), SLUG);
			const res = await post_pack(test_app, SLUG, 'git-receive-pack', {
				Authorization: basic_header(admin.account.username, admin.api_token)
			});
			// 503 = all gates passed; subprocess unavailable.
			assert.strictEqual(res.status, 503);
		});
		test('admin token with no policy row reaches subprocess for pull', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db(), SLUG);
			const res = await post_pack(test_app, SLUG, 'git-upload-pack', {
				Authorization: basic_header(admin.account.username, admin.api_token)
			});
			assert.strictEqual(res.status, 503);
		});
	});

	describe('forge_push scoped token', () => {
		test('push to allowed repo reaches subprocess', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const repo_id = await seed_repo_cell(get_db(), SLUG);
			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			const policy = policy_from_template({ kind: 'forge_push', repo_ids: [repo_id] });
			assert.ok(policy);
			await attach_policy(get_db(), token_id, policy, 'forge_push');

			const res = await post_pack(test_app, SLUG, 'git-receive-pack', {
				Authorization: basic_header(admin.account.username, admin.api_token)
			});
			assert.strictEqual(res.status, 503);
		});
		test('push to disallowed repo denied (401)', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const fuz_app_id = await seed_repo_cell(get_db(), 'fuzdev/fuz_app');
			await seed_repo_cell(get_db(), 'fuzdev/fuz_ui');
			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			// Allow push to fuz_app only.
			const policy = policy_from_template({ kind: 'forge_push', repo_ids: [fuz_app_id] });
			assert.ok(policy);
			await attach_policy(get_db(), token_id, policy, 'forge_push');

			const res = await post_pack(test_app, 'fuzdev/fuz_ui', 'git-receive-pack', {
				Authorization: basic_header(admin.account.username, admin.api_token)
			});
			assert.strictEqual(res.status, 401);
		});
		test("pull denied even on the push-allowed repo (push doesn't grant pull)", async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const repo_id = await seed_repo_cell(get_db(), SLUG);
			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			const policy = policy_from_template({ kind: 'forge_push', repo_ids: [repo_id] });
			assert.ok(policy);
			await attach_policy(get_db(), token_id, policy, 'forge_push');

			const res = await post_pack(test_app, SLUG, 'git-upload-pack', {
				Authorization: basic_header(admin.account.username, admin.api_token)
			});
			assert.strictEqual(res.status, 401);
		});
	});

	describe('forge_pull scoped token', () => {
		test('pull to allowed repo reaches subprocess', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const repo_id = await seed_repo_cell(get_db(), SLUG);
			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			const policy = policy_from_template({ kind: 'forge_pull', repo_ids: [repo_id] });
			assert.ok(policy);
			await attach_policy(get_db(), token_id, policy, 'forge_pull');

			const res = await post_pack(test_app, SLUG, 'git-upload-pack', {
				Authorization: basic_header(admin.account.username, admin.api_token)
			});
			assert.strictEqual(res.status, 503);
		});
		test("push denied (pull doesn't grant push)", async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const repo_id = await seed_repo_cell(get_db(), SLUG);
			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			const policy = policy_from_template({ kind: 'forge_pull', repo_ids: [repo_id] });
			assert.ok(policy);
			await attach_policy(get_db(), token_id, policy, 'forge_pull');

			const res = await post_pack(test_app, SLUG, 'git-receive-pack', {
				Authorization: basic_header(admin.account.username, admin.api_token)
			});
			assert.strictEqual(res.status, 401);
		});
	});

	describe('/info/refs advertise: capability matches service= param', () => {
		test('scoped-pull token: advertise for upload-pack reaches subprocess, advertise for receive-pack denied', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const repo_id = await seed_repo_cell(get_db(), SLUG);
			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			const policy = policy_from_template({ kind: 'forge_pull', repo_ids: [repo_id] });
			assert.ok(policy);
			await attach_policy(get_db(), token_id, policy, 'forge_pull');

			const auth_header = basic_header(admin.account.username, admin.api_token);
			const pull = await advertise(test_app, SLUG, 'git-upload-pack', {
				Authorization: auth_header
			});
			assert.strictEqual(pull.status, 503);

			const push = await advertise(test_app, SLUG, 'git-receive-pack', {
				Authorization: auth_header
			});
			assert.strictEqual(push.status, 401);
		});
	});

	describe('wildcard "*" capability', () => {
		test('forge.push: "*" allows push to any repo', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db(), 'fuzdev/fuz_app');
			await seed_repo_cell(get_db(), 'fuzdev/fuz_ui');
			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			await attach_policy(
				get_db(),
				token_id,
				{ version: 1, forge: { push: '*' } },
				'wildcard_push'
			);

			const auth_header = basic_header(admin.account.username, admin.api_token);
			const r1 = await post_pack(test_app, 'fuzdev/fuz_app', 'git-receive-pack', {
				Authorization: auth_header
			});
			const r2 = await post_pack(test_app, 'fuzdev/fuz_ui', 'git-receive-pack', {
				Authorization: auth_header
			});
			assert.strictEqual(r1.status, 503);
			assert.strictEqual(r2.status, 503);
		});
	});

	describe('deny-all policy (empty document)', () => {
		test('every operation rejected with 401', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db(), SLUG);
			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			await attach_policy(get_db(), token_id, { version: 1 }, 'deny_all');

			const auth_header = basic_header(admin.account.username, admin.api_token);
			const push_post = await post_pack(test_app, SLUG, 'git-receive-pack', {
				Authorization: auth_header
			});
			const pull_post = await post_pack(test_app, SLUG, 'git-upload-pack', {
				Authorization: auth_header
			});
			const push_adv = await advertise(test_app, SLUG, 'git-receive-pack', {
				Authorization: auth_header
			});
			const pull_adv = await advertise(test_app, SLUG, 'git-upload-pack', {
				Authorization: auth_header
			});
			assert.strictEqual(push_post.status, 401);
			assert.strictEqual(pull_post.status, 401);
			assert.strictEqual(push_adv.status, 401);
			assert.strictEqual(pull_adv.status, 401);
		});
	});
});
