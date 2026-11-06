/**
 * Handler-level tests for `fuz_forge_repo_resync`.
 *
 * Stubs `spawn_collect` to simulate `git rev-parse --verify
 * refs/heads/<default_branch>` and asserts the resync handler's three
 * branches:
 *
 *   - `head_sha` changed → cell row updated to the on-disk value;
 *     response carries the previous and new SHAs.
 *   - `head_sha` unchanged → no cell write; response echoes the same
 *     SHA in both slots.
 *   - branch absent (empty repo / branch renamed away) → response is
 *     `{previous_head_sha: <prior>, head_sha: null}` and the cell is
 *     updated to null.
 *   - transient subprocess failure → cell is left untouched and the
 *     handler throws `service_unavailable`, so a flaky `git rev-parse`
 *     never overwrites a known-good SHA.
 *
 * Surface auth + the schema shape are covered by the standard RPC
 * attack-surface suite; this file targets the handler-specific paths.
 *
 * @module
 */

import { assert, test, beforeAll, beforeEach } from 'vitest';
import { ROLE_ADMIN, ROLE_KEEPER } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import type { TestApp, TestAccount } from '@fuzdev/fuz_app/testing/app_server.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { repo_cell_path, type RepoCellData } from '#lib/fuz_forge/repo/plan_repo.ts';
import { query_cell_create, query_cell_get } from '@fuzdev/fuz_app/db/cell_queries.ts';
import type { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { build_rpc_endpoint_specs } from '#lib/server/routes/fuz_forge_route_specs.ts';
import type { SpawnCollect } from '#lib/server/subprocess.ts';

import { create_mock_runtime } from '../../runtime_mock.ts';
import { describe_db } from '../../db_fixture.ts';
import { create_fuz_forge_test_app } from './fuz_forge_test_helpers.ts';

const SHA_OLD = 'a'.repeat(40);
const SHA_NEW = 'b'.repeat(40);
/** A well-formed UUID that no seeded cell uses. */
const ABSENT_UUID = '99999999-9999-4999-8999-999999999999';

const SAMPLE_DATA = (overrides: Partial<RepoCellData> = {}): RepoCellData => ({
	slug: 'fuzdev/fuz_app',
	name: 'fuz_app',
	default_branch: 'main',
	seed_from: null,
	seed_completed_at: null,
	hook_secret_hash: 'secret-must-not-leak',
	head_sha: SHA_OLD,
	last_pushed_at: '2026-05-13T00:00:00.000Z',
	last_pushed_by: null,
	last_push_username: null,
	...overrides
});

/** Seed a repo cell at `repos/<slug>`; returns the cell-id UUID (the wire id). */
const seed_repo_cell = async (
	get_db: () => import('@fuzdev/fuz_app/db/db.ts').Db,
	data: RepoCellData
): Promise<string> => {
	const deps = { db: get_db() };
	const cell = await query_cell_create(deps, {
		path: repo_cell_path(data.slug),
		data,
		kind: 'repo'
	});
	return cell.id;
};

const read_cell_data = async (
	get_db: () => import('@fuzdev/fuz_app/db/db.ts').Db,
	cell_id: string
): Promise<RepoCellData | null> => {
	const deps = { db: get_db() };
	const cell = await query_cell_get(deps, cell_id as Uuid);
	return (cell?.data as RepoCellData | undefined) ?? null;
};

interface SpawnCall {
	cmd: string;
	args: Array<string>;
}

describe_db('fuz_forge_repo_resync', (get_db) => {
	let test_app: TestApp;
	let admin: TestAccount;
	let fake_calls: Array<SpawnCall>;
	let fake_response: (call: SpawnCall) => { stdout?: string; stderr?: string; code: number };

	beforeAll(async () => {
		fake_calls = [];
		fake_response = () => ({ stdout: '', code: 0 });
		const fake_spawn: SpawnCollect = (cmd, args, _options) => {
			const call = { cmd, args: [...args] };
			fake_calls.push(call);
			const r = fake_response(call);
			return Promise.resolve({
				stdout: new TextEncoder().encode(r.stdout ?? ''),
				stderr: new TextEncoder().encode(r.stderr ?? ''),
				code: r.code,
				success: r.code === 0
			});
		};

		const runtime = create_mock_runtime();

		test_app = await create_fuz_forge_test_app(get_db, {
			roles: [ROLE_KEEPER, ROLE_ADMIN],
			rpc_endpoints: (ctx) =>
				build_rpc_endpoint_specs(ctx, {
					fuz_forge_deps: {
						runtime,
						query_deps: { db: ctx.deps.db },
						spawn_collect: fake_spawn,
						seed_from_allow_private_hosts: true,
						log: new Logger('test')
					},
					extra_actions: [],
					notification_sender: null,
					final_actions_factory: null
				})
		});
	});

	beforeEach(async () => {
		fake_calls.length = 0;
		fake_response = () => ({ stdout: '', code: 0 });
		admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
	});

	test('updates head_sha when on-disk tip differs from cell', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA({ head_sha: SHA_OLD }));
		fake_response = () => ({ stdout: `${SHA_NEW}\n`, code: 0 });

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_resync',
			params: { id },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		assert.deepStrictEqual(res.result, { previous_head_sha: SHA_OLD, head_sha: SHA_NEW });

		// Argv shape: `git -C <path> rev-parse --verify refs/heads/main`.
		assert.strictEqual(fake_calls.length, 1);
		const args = fake_calls[0]!.args;
		assert.include(args, 'rev-parse');
		assert.include(args, '--verify');
		assert.include(args, 'refs/heads/main');

		const after = await read_cell_data(get_db, id);
		assert.strictEqual(after?.head_sha, SHA_NEW);
		// hook_secret_hash stays put — resync only touches head_sha.
		assert.strictEqual(after?.hook_secret_hash, 'secret-must-not-leak');
	});

	test('skips the cell write when head_sha is unchanged', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA({ head_sha: SHA_OLD }));
		// Capture the updated_at before resync so we can verify it didn't move.
		const before_cell = await query_cell_get({ db: get_db() }, id as Uuid);
		const before_updated_at = before_cell?.updated_at;
		fake_response = () => ({ stdout: `${SHA_OLD}\n`, code: 0 });

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_resync',
			params: { id },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		assert.deepStrictEqual(res.result, { previous_head_sha: SHA_OLD, head_sha: SHA_OLD });

		const after_cell = await query_cell_get({ db: get_db() }, id as Uuid);
		// `updated_at` is bumped by `query_cell_update` (NULL until the first
		// edit); matching values — both `null` on this no-op path — prove the
		// write was skipped.
		assert.strictEqual(after_cell?.updated_at, before_updated_at);
	});

	test('writes head_sha=null when the default branch is absent', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA({ head_sha: SHA_OLD }));
		fake_response = () => ({
			stdout: '',
			stderr: "fatal: ambiguous argument 'refs/heads/main': unknown revision\n",
			code: 128
		});

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_resync',
			params: { id },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		assert.deepStrictEqual(res.result, { previous_head_sha: SHA_OLD, head_sha: null });

		const after = await read_cell_data(get_db, id);
		assert.strictEqual(after?.head_sha, null);
	});

	test('leaves the cell untouched on transient subprocess failure', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA({ head_sha: SHA_OLD }));
		fake_response = () => ({
			stdout: '',
			stderr: 'fatal: not a git repository\n',
			code: 128
		});

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_resync',
			params: { id },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'default-branch tip');

		// Cell must still carry the original SHA — refusing to write on
		// a flaky subprocess is the load-bearing safety property.
		const after = await read_cell_data(get_db, id);
		assert.strictEqual(after?.head_sha, SHA_OLD);
	});

	test('resolves by slug', async () => {
		const id = await seed_repo_cell(
			get_db,
			SAMPLE_DATA({ slug: 'fuzdev/special', name: 'special', head_sha: SHA_OLD })
		);
		fake_response = () => ({ stdout: `${SHA_NEW}\n`, code: 0 });

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_resync',
			params: { slug: 'fuzdev/special' },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		assert.deepStrictEqual(res.result, { previous_head_sha: SHA_OLD, head_sha: SHA_NEW });

		const after = await read_cell_data(get_db, id);
		assert.strictEqual(after?.head_sha, SHA_NEW);
	});

	test('returns 404 when the repo cell does not exist', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_resync',
			params: { id: ABSENT_UUID },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'repo');
		assert.strictEqual(fake_calls.length, 0);
	});

	test('returns 404 when the slug does not match any cell', async () => {
		await seed_repo_cell(get_db, SAMPLE_DATA({ slug: 'fuzdev/exists', name: 'exists' }));
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_resync',
			params: { slug: 'fuzdev/missing' },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'repo');
		assert.strictEqual(fake_calls.length, 0);
	});

	test('rejects providing both id and slug', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_resync',
			params: { id: ABSENT_UUID, slug: 'fuzdev/fuz_app' },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
	});

	test('rejects providing neither id nor slug', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_resync',
			params: {},
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
	});
});
