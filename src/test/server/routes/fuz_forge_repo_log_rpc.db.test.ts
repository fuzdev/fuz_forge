/**
 * Handler-level tests for `fuz_forge_repo_log`.
 *
 * The git subprocess is stubbed via a fake `spawn_collect` so the
 * handler's branches all exercise:
 *
 *   - first page (no cursor): defaults ref to the cell's
 *     `default_branch`, returns `next_cursor: null` when fewer than
 *     `limit + 1` records come back, returns the last record's SHA
 *     when more do
 *   - cursor pagination: passes `<cursor>^` as the rev so the next
 *     page starts past the previous one; rejects malformed cursors
 *   - filter passthrough: `--author=`, `--since=`, and a path
 *     argument after `--`
 *   - empty repo (no head_sha) skips the subprocess on the no-cursor
 *     case and returns the configured ref alongside an empty page
 *   - subprocess failure → `service_unavailable`
 *
 * Surface auth + the schema shape are covered by the standard RPC
 * attack surface suite; this file targets the handler-specific paths
 * only.
 *
 * @module
 */

import { assert, test, beforeAll, beforeEach } from 'vitest';
import { ROLE_ADMIN, ROLE_KEEPER } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import type { TestApp, TestAccount } from '@fuzdev/fuz_app/testing/app_server.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { repo_cell_path, type RepoCellData } from '#lib/fuz_forge/repo/plan_repo.ts';
import { query_cell_create } from '@fuzdev/fuz_app/db/cell_queries.ts';
import { build_rpc_endpoint_specs } from '#lib/server/routes/fuz_forge_route_specs.ts';
import type { SpawnCollect } from '#lib/server/subprocess.ts';

import { create_mock_runtime } from '../../runtime_mock.ts';
import { describe_db } from '../../db_fixture.ts';
import { create_fuz_forge_test_app } from './fuz_forge_test_helpers.ts';

/** A well-formed UUID that no seeded cell uses. */
const ABSENT_UUID = '99999999-9999-4999-8999-999999999999';

const SAMPLE_DATA = (overrides: Partial<RepoCellData> = {}): RepoCellData => ({
	slug: 'fuzdev/fuz_app',
	name: 'fuz_app',
	default_branch: 'main',
	seed_from: null,
	seed_completed_at: null,
	hook_secret_hash: 'secret-must-not-leak',
	head_sha: 'a'.repeat(40),
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

interface SpawnCall {
	cmd: string;
	args: Array<string>;
	env: Record<string, string>;
}

const RS = '\x1e';
const FS = '\x00';

interface FakeRecord {
	sha: string;
	short: string;
	subject: string;
	author: string;
	email: string;
	date: string;
	parents: string;
}

const fake_log_output = (records: Array<FakeRecord>): string =>
	records
		.map((c) => [c.sha, c.short, c.subject, c.author, c.email, c.date, c.parents].join(FS) + RS)
		.join('');

/** Build N synthetic records with predictable SHAs (`f0...0`, `f1...1`, …). */
const make_records = (n: number): Array<FakeRecord> =>
	Array.from({ length: n }, (_, i) => {
		const hex = (i + 1).toString(16);
		const sha = hex.padStart(40, '0');
		return {
			sha,
			short: sha.slice(0, 7),
			subject: `subject ${i + 1}`,
			author: 'Alice',
			email: 'alice@example.com',
			date: '2026-05-13T00:00:00Z',
			parents: i === 0 ? '' : i.toString(16).padStart(40, '0')
		};
	});

describe_db('fuz_forge_repo_log', (get_db) => {
	let test_app: TestApp;
	let admin: TestAccount;
	let fake_calls: Array<SpawnCall>;
	let fake_response: (call: SpawnCall) => { stdout?: string; stderr?: string; code: number };

	beforeAll(async () => {
		fake_calls = [];
		fake_response = () => ({ stdout: '', code: 0 });
		const fake_spawn: SpawnCollect = (cmd, args, options) => {
			const call = { cmd, args: [...args], env: options.env };
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

	test('returns first page using cell default_branch when ref is omitted', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA({ default_branch: 'trunk' }));
		fake_response = () => ({ stdout: fake_log_output(make_records(3)), code: 0 });

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_log',
			params: { id, limit: 50 },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		const result = res.result as {
			commits: Array<{ sha: string; subject: string }>;
			next_cursor: string | null;
			ref: string;
		};
		assert.strictEqual(result.commits.length, 3);
		assert.strictEqual(result.next_cursor, null);
		assert.strictEqual(result.ref, 'trunk');

		assert.strictEqual(fake_calls.length, 1);
		const args = fake_calls[0]!.args;
		// Server requests `limit + 1` so it can detect "more pages exist".
		assert.include(args, '-n');
		assert.strictEqual(args[args.indexOf('-n') + 1], '51');
		// First page rev is the configured branch verbatim — no cursor.
		assert.include(args, 'trunk');
		assert.notInclude(args.join(' '), '^');
	});

	test('sets next_cursor to last commit sha when more pages exist', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		// Limit=2, server fetches 3 → trims to 2, sets cursor to commit #2.
		fake_response = () => ({ stdout: fake_log_output(make_records(3)), code: 0 });

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_log',
			params: { id, limit: 2 },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		const result = res.result as {
			commits: Array<{ sha: string }>;
			next_cursor: string | null;
		};
		assert.strictEqual(result.commits.length, 2);
		const sha_2 = '2'.padStart(40, '0');
		assert.strictEqual(result.next_cursor, sha_2);
		assert.strictEqual(result.commits[1]!.sha, sha_2);
	});

	test('passes <cursor>^ as the rev when cursor is set', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		const cursor = 'b'.repeat(40);
		fake_response = () => ({ stdout: fake_log_output(make_records(1)), code: 0 });

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_log',
			params: { id, cursor, limit: 50 },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);

		const args = fake_calls[0]!.args;
		// The cursor's parent is the rev for the next page.
		assert.include(args, `${cursor}^`);
		assert.notInclude(args, 'main');
	});

	test('rejects malformed cursors with empty page (no_such_ref)', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_log',
			// Not a 40-hex SHA — read_log rejects pre-spawn.
			params: { id, cursor: 'not-a-real-sha', limit: 50 },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		const result = res.result as { commits: Array<unknown>; next_cursor: string | null };
		assert.strictEqual(result.commits.length, 0);
		assert.strictEqual(result.next_cursor, null);
		// Subprocess never spawned — reject was at the validator.
		assert.strictEqual(fake_calls.length, 0);
	});

	test('forwards --author, --since, and path filters into the argv', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		fake_response = () => ({ stdout: '', code: 0 });

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_log',
			params: {
				id,
				author: 'alice',
				since: '2026-01-01',
				path: 'src/lib/server/git',
				limit: 10
			},
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);

		const args = fake_calls[0]!.args;
		assert.include(args, '--author=alice');
		assert.include(args, '--since=2026-01-01');
		// path arrives after the `--` separator.
		const dash_dash_idx = args.indexOf('--');
		assert.isAbove(dash_dash_idx, -1);
		assert.strictEqual(args[dash_dash_idx + 1], 'src/lib/server/git');
	});

	test('skips the subprocess on first-page request when head_sha is null', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA({ head_sha: null, last_pushed_at: null }));
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_log',
			params: { id, limit: 50 },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		assert.deepStrictEqual(res.result, { commits: [], next_cursor: null, ref: 'main' });
		assert.strictEqual(fake_calls.length, 0);
	});

	test('maps unknown-revision stderr to an empty page', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		fake_response = () => ({
			stdout: '',
			stderr: "fatal: ambiguous argument 'main': unknown revision\n",
			code: 128
		});

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_log',
			params: { id, limit: 10 },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		assert.deepStrictEqual(res.result, { commits: [], next_cursor: null, ref: 'main' });
	});

	test('throws service_unavailable on unrecognized subprocess failure', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		fake_response = () => ({
			stdout: '',
			stderr: 'fatal: not a git repository\n',
			code: 128
		});

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_log',
			params: { id },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'failed to read');
	});

	test('returns 404 when the repo cell does not exist', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_log',
			params: { id: ABSENT_UUID },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'repo');
	});
});
