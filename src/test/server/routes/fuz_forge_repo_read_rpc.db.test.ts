/**
 * Tests for the read-side repo RPC handlers `fuz_forge_repo_list` and
 * `fuz_forge_repo_get` (`src/lib/server/routes/fuz_forge_repo_read.ts`).
 *
 * The standard RPC round-trip + auth attack surface suites already
 * cover authz and output-schema validity for every spec; this file
 * targets the handler-specific paths those suites can't reach:
 *
 *   - empty list / 404 when no repo cells exist
 *   - malformed cell data → skip-and-warn on list / 404 on get
 *   - hook_secret_hash never appears in any response payload
 *   - id lookup (cell-id UUID) and slug lookup (`repos/<slug>` path)
 *
 * @module
 */

import { assert, describe, test, beforeAll, beforeEach } from 'vitest';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import type { TestApp, TestAccount } from '@fuzdev/fuz_app/testing/app_server.ts';

import { repo_cell_path, type RepoCellData } from '#lib/fuz_forge/repo/plan_repo.ts';
import { query_cell_create } from '@fuzdev/fuz_app/db/cell_queries.ts';

import { describe_db } from '../../db_fixture.ts';
import { create_fuz_forge_admin_test_app } from './fuz_forge_test_helpers.ts';

/** A well-formed UUID that no seeded cell uses. */
const ABSENT_UUID = '99999999-9999-4999-8999-999999999999';

const SAMPLE_DATA = (overrides: Partial<RepoCellData> = {}): RepoCellData => ({
	slug: 'fuzdev/fuz_app',
	name: 'fuz_app',
	default_branch: 'main',
	seed_from: null,
	seed_completed_at: null,
	hook_secret_hash: 'secret-must-not-leak',
	head_sha: null,
	last_pushed_at: null,
	last_pushed_by: null,
	last_push_username: null,
	...overrides
});

/**
 * Seed a repo cell at `repos/<slug>` and return its cell-id UUID (the
 * wire `id`). The slug is the canonical handle, so the cell path derives
 * from `data.slug` directly.
 */
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

/**
 * Seed a cell with deliberately wrong-shape `data` so we can exercise
 * the narrow-failure branch. `query_cell_create` only types `data` as
 * `Json`, so casting through `unknown` is the cleanest way to plant a
 * cell that `narrow_repo_cell_data` will reject. `slug` is the
 * `repos/<slug>` path component (the bad data has no usable slug).
 */
const seed_malformed_repo_cell = async (
	get_db: () => import('@fuzdev/fuz_app/db/db.ts').Db,
	slug: string
): Promise<string> => {
	const deps = { db: get_db() };
	const cell = await query_cell_create(deps, {
		path: repo_cell_path(slug),
		data: { not: 'a valid RepoCellData shape' }
	});
	return cell.id;
};

describe_db('fuz_forge_repo_list / fuz_forge_repo_get', (get_db) => {
	let test_app: TestApp;
	let admin: TestAccount;

	beforeAll(async () => {
		test_app = await create_fuz_forge_admin_test_app(get_db);
	});

	beforeEach(async () => {
		admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
	});

	describe('fuz_forge_repo_list', () => {
		test('returns empty list when no repos exist', async () => {
			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_list',
				params: {},
				headers: admin.create_session_headers()
			});
			assert.isTrue(res.ok);
			assert.deepStrictEqual(res.result, { repos: [] });
		});

		test('returns one entry per cell, omitting hook_secret_hash', async () => {
			await seed_repo_cell(get_db, SAMPLE_DATA({ head_sha: 'abc123' }));
			await seed_repo_cell(get_db, SAMPLE_DATA({ slug: 'fuzdev/fuz_css', name: 'fuz_css' }));

			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_list',
				params: {},
				headers: admin.create_session_headers()
			});
			assert.isTrue(res.ok);
			const { repos } = res.result as { repos: Array<Record<string, unknown>> };
			assert.strictEqual(repos.length, 2);
			const slugs = repos.map((r) => r.slug as string).sort((a, b) => a.localeCompare(b));
			assert.deepStrictEqual(slugs, ['fuzdev/fuz_app', 'fuzdev/fuz_css']);

			// hook_secret_hash must never appear in the wire payload — Object.values
			// catches it even if a field rename slipped past the schema.
			const serialized = JSON.stringify(res.result);
			assert.notInclude(serialized, 'secret-must-not-leak');
			assert.notInclude(serialized, 'hook_secret');

			const fuz_app_row = repos.find((r) => r.slug === 'fuzdev/fuz_app')!;
			assert.strictEqual(fuz_app_row.name, 'fuz_app');
			assert.strictEqual(fuz_app_row.default_branch, 'main');
			assert.strictEqual(fuz_app_row.head_sha, 'abc123');
			assert.strictEqual(typeof fuz_app_row.id, 'string');
			assert.strictEqual(typeof fuz_app_row.created_at, 'string');
			assert.strictEqual(typeof fuz_app_row.updated_at, 'string');
		});

		test('skips malformed cells and still returns valid ones', async () => {
			await seed_repo_cell(get_db, SAMPLE_DATA());
			await seed_malformed_repo_cell(get_db, 'bad/repo');

			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_list',
				params: {},
				headers: admin.create_session_headers()
			});
			assert.isTrue(res.ok);
			const { repos } = res.result as { repos: Array<{ slug: string }> };
			assert.strictEqual(repos.length, 1);
			assert.strictEqual(repos[0]!.slug, 'fuzdev/fuz_app');
		});
	});

	describe('fuz_forge_repo_get', () => {
		test('returns 404 when the repo does not exist', async () => {
			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_get',
				params: { id: ABSENT_UUID },
				headers: admin.create_session_headers()
			});
			assert.isFalse(res.ok);
			// jsonrpc_errors.not_found maps to JSON-RPC error code -32004 (resource_not_found).
			// We only assert the message carries the reason — the numeric code is
			// covered by the standard surface suite.
			assert.include(res.error.message.toLowerCase(), 'repo');
		});

		test('returns the repo when the cell exists', async () => {
			const cell_id = await seed_repo_cell(get_db, SAMPLE_DATA({ head_sha: 'abc123' }));

			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_get',
				params: { id: cell_id },
				headers: admin.create_session_headers()
			});
			assert.isTrue(res.ok);
			const { repo } = res.result as { repo: Record<string, unknown> };
			assert.strictEqual(repo.id, cell_id);
			assert.strictEqual(repo.slug, 'fuzdev/fuz_app');
			assert.strictEqual(repo.head_sha, 'abc123');
			// hook_secret_hash stays server-side.
			const serialized = JSON.stringify(res.result);
			assert.notInclude(serialized, 'secret-must-not-leak');
			assert.notInclude(serialized, 'hook_secret');
		});

		test('returns 404 when the cell is missing', async () => {
			// Seed a different cell so one exists, but the requested id doesn't.
			await seed_repo_cell(get_db, SAMPLE_DATA({ slug: 'other/repo', name: 'repo' }));

			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_get',
				params: { id: ABSENT_UUID },
				headers: admin.create_session_headers()
			});
			assert.isFalse(res.ok);
			assert.include(res.error.message.toLowerCase(), 'repo');
		});

		test('returns 404 when the cell exists but is malformed', async () => {
			const cell_id = await seed_malformed_repo_cell(get_db, 'fuzdev/fuz_app');

			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_get',
				params: { id: cell_id },
				headers: admin.create_session_headers()
			});
			assert.isFalse(res.ok);
			assert.include(res.error.message.toLowerCase(), 'repo');
		});

		test('looks up by slug when slug is provided', async () => {
			const cell_id = await seed_repo_cell(get_db, SAMPLE_DATA({ head_sha: 'abc123' }));

			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_get',
				params: { slug: 'fuzdev/fuz_app' },
				headers: admin.create_session_headers()
			});
			assert.isTrue(res.ok);
			const { repo } = res.result as { repo: Record<string, unknown> };
			assert.strictEqual(repo.id, cell_id);
			assert.strictEqual(repo.slug, 'fuzdev/fuz_app');
			assert.strictEqual(repo.head_sha, 'abc123');
		});

		test('mixed-case slug resolves the lowercase-stored cell (case-insensitive)', async () => {
			// Cell is stored at the lowercase slug; request it with a mixed-case
			// slug. The `RepoSlug` schema folds the input to lowercase, so the
			// `repos/<slug>` cell-path lookup matches the lowercase-stored cell.
			const cell_id = await seed_repo_cell(get_db, SAMPLE_DATA({ head_sha: 'abc123' }));

			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_get',
				params: { slug: 'FuzDev/Fuz_App' },
				headers: admin.create_session_headers()
			});
			assert.isTrue(res.ok);
			const { repo } = res.result as { repo: Record<string, unknown> };
			assert.strictEqual(repo.id, cell_id);
			assert.strictEqual(repo.slug, 'fuzdev/fuz_app');
			assert.strictEqual(repo.head_sha, 'abc123');
		});

		test('returns 404 when slug does not match any cell', async () => {
			await seed_repo_cell(get_db, SAMPLE_DATA());

			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_get',
				params: { slug: 'fuzdev/missing' },
				headers: admin.create_session_headers()
			});
			assert.isFalse(res.ok);
			assert.include(res.error.message.toLowerCase(), 'repo');
		});

		test('rejects providing both id and slug', async () => {
			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_get',
				params: { id: ABSENT_UUID, slug: 'fuzdev/fuz_app' },
				headers: admin.create_session_headers()
			});
			assert.isFalse(res.ok);
		});

		test('rejects providing neither id nor slug', async () => {
			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_get',
				params: {},
				headers: admin.create_session_headers()
			});
			assert.isFalse(res.ok);
		});
	});

	describe('fuz_forge_repo_list filters', () => {
		test('slug_prefix filters to slugs starting with the prefix', async () => {
			await seed_repo_cell(get_db, SAMPLE_DATA({ slug: 'fuzdev/fuz_app', name: 'fuz_app' }));
			await seed_repo_cell(get_db, SAMPLE_DATA({ slug: 'fuzdev/fuz_css', name: 'fuz_css' }));
			await seed_repo_cell(get_db, SAMPLE_DATA({ slug: 'other/repo', name: 'repo' }));

			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_list',
				params: { slug_prefix: 'fuzdev/' },
				headers: admin.create_session_headers()
			});
			assert.isTrue(res.ok);
			const { repos } = res.result as { repos: Array<{ slug: string }> };
			assert.strictEqual(repos.length, 2);
			const slugs = repos.map((r) => r.slug).sort((a, b) => a.localeCompare(b));
			assert.deepStrictEqual(slugs, ['fuzdev/fuz_app', 'fuzdev/fuz_css']);
		});

		test('slug_prefix is case-sensitive (mixed-case prefix matches nothing)', async () => {
			await seed_repo_cell(get_db, SAMPLE_DATA({ slug: 'fuzdev/fuz_app', name: 'fuz_app' }));
			await seed_repo_cell(get_db, SAMPLE_DATA({ slug: 'fuzdev/fuz_css', name: 'fuz_css' }));
			await seed_repo_cell(get_db, SAMPLE_DATA({ slug: 'other/repo', name: 'repo' }));

			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_list',
				// Slugs are lowercase-canonical and the prefix match is exact +
				// case-sensitive (the documented contract, held to cross-backend
				// parity), so an uppercase prefix matches nothing.
				params: { slug_prefix: 'FuzDev/' },
				headers: admin.create_session_headers()
			});
			assert.isTrue(res.ok);
			const { repos } = res.result as { repos: Array<{ slug: string }> };
			assert.strictEqual(repos.length, 0);
		});

		test('since filters to repos pushed at or after the timestamp', async () => {
			const old_push = '2026-01-01T00:00:00Z';
			const recent_push = '2026-05-01T00:00:00Z';
			await seed_repo_cell(
				get_db,
				SAMPLE_DATA({ slug: 'org/old', name: 'old', last_pushed_at: old_push })
			);
			await seed_repo_cell(
				get_db,
				SAMPLE_DATA({ slug: 'org/recent', name: 'recent', last_pushed_at: recent_push })
			);
			// A repo that's never been pushed — should be excluded when `since` is set.
			await seed_repo_cell(
				get_db,
				SAMPLE_DATA({ slug: 'org/never', name: 'never', last_pushed_at: null })
			);

			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_list',
				params: { since: '2026-04-01T00:00:00.000Z' },
				headers: admin.create_session_headers()
			});
			assert.isTrue(res.ok);
			const { repos } = res.result as { repos: Array<{ slug: string }> };
			assert.strictEqual(repos.length, 1);
			assert.strictEqual(repos[0]!.slug, 'org/recent');
		});

		test('slug_prefix and since combine', async () => {
			await seed_repo_cell(
				get_db,
				SAMPLE_DATA({ slug: 'fuzdev/a', name: 'a', last_pushed_at: '2026-05-01T00:00:00Z' })
			);
			await seed_repo_cell(
				get_db,
				SAMPLE_DATA({ slug: 'fuzdev/b', name: 'b', last_pushed_at: '2026-01-01T00:00:00Z' })
			);
			await seed_repo_cell(
				get_db,
				SAMPLE_DATA({ slug: 'other/c', name: 'c', last_pushed_at: '2026-05-01T00:00:00Z' })
			);

			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_list',
				params: { slug_prefix: 'fuzdev/', since: '2026-04-01T00:00:00.000Z' },
				headers: admin.create_session_headers()
			});
			assert.isTrue(res.ok);
			const { repos } = res.result as { repos: Array<{ slug: string }> };
			assert.strictEqual(repos.length, 1);
			assert.strictEqual(repos[0]!.slug, 'fuzdev/a');
		});
	});
});
