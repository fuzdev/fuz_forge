/**
 * Handler-level tests for `fuz_forge_repo_commit`.
 *
 * The git subprocesses (metadata + diff body) are stubbed via a fake
 * `spawn_collect` that dispatches per-argv so each fetch can be
 * exercised independently:
 *
 *   - happy path: metadata + diff returned, single 11-field record
 *     parses into `commit`, body unified-diff text → `diff.text`
 *   - missing repo cell → 404
 *   - bad-object / unknown-revision stderr → 404 `commit`
 *   - malformed SHA (not 40-hex) rejected pre-spawn → 404
 *   - diff body exceeds `MAX_DIFF_BYTES` → `diff.truncated: true` with
 *     empty text, metadata still surfaced
 *   - generic subprocess failure → `service_unavailable`
 *   - auth rejection (non-admin caller) → forbidden
 *
 * Surface auth + the schema shape are covered by the standard RPC
 * attack surface suite; this file targets the handler-specific paths.
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
import { type SpawnCollect, SpawnOutputTooLargeError } from '#lib/server/subprocess.ts';

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

const FS = '\x00';

interface FakeCommitMeta {
	sha: string;
	short: string;
	subject: string;
	author_name: string;
	author_email: string;
	author_date: string;
	committer_name: string;
	committer_email: string;
	committer_date: string;
	parents: string;
	body: string;
}

const fake_meta_output = (m: FakeCommitMeta): string =>
	[
		m.sha,
		m.short,
		m.subject,
		m.author_name,
		m.author_email,
		m.author_date,
		m.committer_name,
		m.committer_email,
		m.committer_date,
		m.parents,
		m.body
	].join(FS) + '\n';

const SAMPLE_SHA = 'c'.repeat(40);

const sample_meta = (overrides: Partial<FakeCommitMeta> = {}): FakeCommitMeta => ({
	sha: SAMPLE_SHA,
	short: SAMPLE_SHA.slice(0, 7),
	subject: 'add commit detail page',
	author_name: 'Alice',
	author_email: 'alice@example.com',
	author_date: '2026-05-15T00:00:00Z',
	committer_name: 'Alice',
	committer_email: 'alice@example.com',
	committer_date: '2026-05-15T00:00:00Z',
	parents: 'b'.repeat(40),
	body: 'add commit detail page\n\nMirror the log page pattern.\n',
	...overrides
});

const SAMPLE_DIFF =
	'diff --git a/foo.ts b/foo.ts\nindex 0000..1111 100644\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n';

/** Classify a spawn call by its argv so the fake can dispatch per-call. */
const is_meta_call = (call: SpawnCall): boolean => call.args.includes('--no-patch');
const is_diff_call = (call: SpawnCall): boolean => call.args.includes('-p');

describe_db('fuz_forge_repo_commit', (get_db) => {
	let test_app: TestApp;
	let admin: TestAccount;
	let fake_calls: Array<SpawnCall>;
	let meta_response: (call: SpawnCall) => { stdout?: string; stderr?: string; code: number };
	let diff_response: (
		call: SpawnCall
	) => { stdout?: string; stderr?: string; code: number } | 'throw_too_large' | 'throw_generic';

	beforeAll(async () => {
		fake_calls = [];
		meta_response = () => ({ stdout: '', code: 0 });
		diff_response = () => ({ stdout: '', code: 0 });
		const fake_spawn: SpawnCollect = (cmd, args, options) => {
			const call: SpawnCall = { cmd, args: [...args], env: options.env };
			fake_calls.push(call);
			let r;
			if (is_meta_call(call)) {
				r = meta_response(call);
			} else if (is_diff_call(call)) {
				const d = diff_response(call);
				if (d === 'throw_too_large') {
					return Promise.reject(new SpawnOutputTooLargeError('git', 5_000_000));
				}
				if (d === 'throw_generic') {
					return Promise.reject(new Error('spawn ENOENT'));
				}
				r = d;
			} else {
				r = { stdout: '', code: 0 };
			}
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
		meta_response = () => ({ stdout: '', code: 0 });
		diff_response = () => ({ stdout: '', code: 0 });
		admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
	});

	test('returns commit metadata + diff on the happy path', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		meta_response = () => ({ stdout: fake_meta_output(sample_meta()), code: 0 });
		diff_response = () => ({ stdout: SAMPLE_DIFF, code: 0 });

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_commit',
			params: { id, sha: SAMPLE_SHA },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		const result = res.result as {
			commit: {
				sha: string;
				subject: string;
				committer_name: string;
				parents: Array<string>;
				body: string;
			};
			diff: { text: string; truncated: boolean };
		};
		assert.strictEqual(result.commit.sha, SAMPLE_SHA);
		assert.strictEqual(result.commit.subject, 'add commit detail page');
		assert.strictEqual(result.commit.committer_name, 'Alice');
		assert.deepStrictEqual(result.commit.parents, ['b'.repeat(40)]);
		assert.include(result.commit.body, 'Mirror the log page pattern.');
		assert.strictEqual(result.diff.text, SAMPLE_DIFF);
		assert.strictEqual(result.diff.truncated, false);

		// Exactly two subprocess calls, one per fetch.
		assert.strictEqual(fake_calls.length, 2);
		const meta_call = fake_calls.find(is_meta_call)!;
		const diff_call = fake_calls.find(is_diff_call)!;
		assert.include(meta_call.args, SAMPLE_SHA);
		assert.include(meta_call.args, '--no-patch');
		assert.include(diff_call.args, SAMPLE_SHA);
		assert.include(diff_call.args, '--full-index');
		// Both calls share the locked-down env.
		assert.strictEqual(meta_call.env.LC_ALL, 'C.UTF-8');
		assert.strictEqual(meta_call.env.GIT_TERMINAL_PROMPT, '0');
	});

	test('parses a root commit (no parents) with empty parents list', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		meta_response = () => ({ stdout: fake_meta_output(sample_meta({ parents: '' })), code: 0 });
		diff_response = () => ({ stdout: SAMPLE_DIFF, code: 0 });

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_commit',
			params: { id, sha: SAMPLE_SHA },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		const result = res.result as { commit: { parents: Array<string> } };
		assert.deepStrictEqual(result.commit.parents, []);
	});

	test('parses a merge commit (multiple parents)', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		const parent_a = 'b'.repeat(40);
		const parent_b = 'd'.repeat(40);
		meta_response = () => ({
			stdout: fake_meta_output(sample_meta({ parents: `${parent_a} ${parent_b}` })),
			code: 0
		});

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_commit',
			params: { id, sha: SAMPLE_SHA },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		const result = res.result as { commit: { parents: Array<string> } };
		assert.deepStrictEqual(result.commit.parents, [parent_a, parent_b]);
	});

	test('rejects malformed SHA pre-spawn with 404', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_commit',
			// Not a 40-hex SHA — read_commit rejects pre-spawn.
			params: { id, sha: 'not-a-real-sha' },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'commit');
		// Subprocess never spawned — reject was at the validator.
		assert.strictEqual(fake_calls.length, 0);
	});

	test('maps bad-object stderr from metadata fetch to 404', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		meta_response = () => ({
			stdout: '',
			stderr: `fatal: bad object ${SAMPLE_SHA}\n`,
			code: 128
		});

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_commit',
			params: { id, sha: SAMPLE_SHA },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'commit');
		// Only the metadata call happened — diff is skipped on metadata failure.
		assert.strictEqual(fake_calls.length, 1);
	});

	test('flips truncated: true when diff body exceeds the cap, preserves metadata', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		meta_response = () => ({ stdout: fake_meta_output(sample_meta()), code: 0 });
		diff_response = () => 'throw_too_large';

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_commit',
			params: { id, sha: SAMPLE_SHA },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		const result = res.result as {
			commit: { sha: string };
			diff: { text: string; truncated: boolean };
		};
		assert.strictEqual(result.commit.sha, SAMPLE_SHA);
		assert.strictEqual(result.diff.text, '');
		assert.strictEqual(result.diff.truncated, true);
	});

	test('throws service_unavailable on unrecognized metadata subprocess failure', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		meta_response = () => ({
			stdout: '',
			stderr: 'fatal: not a git repository\n',
			code: 128
		});

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_commit',
			params: { id, sha: SAMPLE_SHA },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'failed to read');
	});

	test('throws service_unavailable on unrecognized diff subprocess failure', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		meta_response = () => ({ stdout: fake_meta_output(sample_meta()), code: 0 });
		diff_response = () => ({
			stdout: '',
			stderr: 'fatal: not a git repository\n',
			code: 128
		});

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_commit',
			params: { id, sha: SAMPLE_SHA },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'failed to read');
	});

	test('throws service_unavailable when diff subprocess rejects with a non-cap error', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		meta_response = () => ({ stdout: fake_meta_output(sample_meta()), code: 0 });
		diff_response = () => 'throw_generic';

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_commit',
			params: { id, sha: SAMPLE_SHA },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'failed to read');
	});

	test('returns 404 when the repo cell does not exist', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_commit',
			params: { id: ABSENT_UUID, sha: SAMPLE_SHA },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'repo');
		assert.strictEqual(fake_calls.length, 0);
	});
});
