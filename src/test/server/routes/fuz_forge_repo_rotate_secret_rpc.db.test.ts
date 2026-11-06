/**
 * Handler-level tests for `fuz_forge_repo_rotate_secret`.
 *
 * Exercises the cell-first / disk-second flow and its recovery
 * branches:
 *
 *   - Happy path → both hook scripts on disk carry the new secret and the
 *     cell its digest. Neither appears in any output payload — the
 *     secret and `hook_secret_hash` are server-side state, not part of
 *     the wire contract.
 *   - The installed scripts can't be read → nothing is written and the
 *     RPC surfaces a `hook scripts unreadable` error.
 *   - Forward disk write fails, recovery succeeds → cell rolls back
 *     via the dispatcher's wrapping transaction; both hook files are
 *     restored to the bytes read before the rewrite (the cell keeps only
 *     a digest, so there is no old plaintext to re-render from). The RPC
 *     surfaces a `reverted to old secret` error.
 *   - Forward AND recovery disk writes fail → cell still rolls back,
 *     but disk is potentially inconsistent. The RPC surfaces a
 *     `manual reconciliation required` error so the operator knows to
 *     fix the hook scripts by hand or via `fuz_forge apply`.
 *
 * Disk writes go through the mock runtime's `write_text_file`; failure
 * injection swaps a wrapping function in for the path containing
 * `post-receive` so the forward call fails on the second hook write
 * after `pre-receive` already landed — the realistic failure mode for
 * a partial install.
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
import { hash_hook_secret } from '#lib/server/routes/fuz_forge_repo_cell.ts';

import { create_mock_runtime, type MockFuzForgeRuntime } from '../../runtime_mock.ts';
import { describe_db } from '../../db_fixture.ts';
import { create_fuz_forge_test_app } from './fuz_forge_test_helpers.ts';

const OLD_SECRET = 'old-secret-must-not-leak';
/** A well-formed UUID that no seeded cell uses. */
const ABSENT_UUID = '99999999-9999-4999-8999-999999999999';

const SAMPLE_DATA = (overrides: Partial<RepoCellData> = {}): RepoCellData => ({
	slug: 'fuzdev/fuz_app',
	name: 'fuz_app',
	default_branch: 'main',
	seed_from: null,
	seed_completed_at: null,
	hook_secret_hash: hash_hook_secret(OLD_SECRET),
	head_sha: null,
	last_pushed_at: null,
	last_pushed_by: null,
	last_push_username: null,
	...overrides
});

/** Seed a repo cell at `repos/<slug>`; returns the cell-id UUID (the wire id + dir name). */
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

const REPO_STORE = '/test/repos';

const hook_path = (id: string, name: 'pre-receive' | 'post-receive'): string =>
	`${REPO_STORE}/${id}.git/hooks/${name}`;

/** The secret a rendered hook script embeds, read back off its config block. */
const embedded_secret = (script: string): string => {
	const m = /^FUZ_FORGE_HOOK_SECRET = '([^'\\]*)'$/m.exec(script);
	assert.ok(m, 'script embeds a secret');
	return m[1]!;
};

describe_db('fuz_forge_repo_rotate_secret', (get_db) => {
	let test_app: TestApp;
	let admin: TestAccount;
	let runtime: MockFuzForgeRuntime;
	/**
	 * When set, the wrapping `write_text_file` consults this against
	 * the incoming `(path, content, call_count)` tuple. Return a non-
	 * empty string to throw with that message; return `null` to let
	 * the underlying mock store the write.
	 */
	let inject_write_fault: ((path: string, content: string, n: number) => string | null) | null;
	/** Subprocess calls the storage layer makes (`chmod 0700` per hook script). */
	const spawn_calls: Array<{ cmd: string; args: Array<string> }> = [];

	beforeAll(async () => {
		runtime = create_mock_runtime();
		runtime.mock_env.set('FUZ_FORGE_REPO_STORE_PATH', REPO_STORE);

		// Wrap `write_text_file` to support per-test failure injection.
		// Closes over the `inject_write_fault` slot so each test sets
		// its own policy without rebuilding the app.
		const original_write = runtime.write_text_file;
		let n = 0;
		runtime.write_text_file = async (path: string, content: string) => {
			n++;
			const fault = inject_write_fault?.(path, content, n);
			if (fault) throw new Error(fault);
			await original_write(path, content);
		};
		inject_write_fault = null;

		test_app = await create_fuz_forge_test_app(get_db, {
			roles: [ROLE_KEEPER, ROLE_ADMIN],
			rpc_endpoints: (ctx) =>
				build_rpc_endpoint_specs(ctx, {
					fuz_forge_deps: {
						runtime,
						query_deps: { db: ctx.deps.db },
						// `install_hooks`' `chmod 0700` goes through the forge's own
						// `SpawnCollect` (explicit env, no stdin), not the mock
						// runtime's `run_command` — so the mock records the calls here.
						spawn_collect: async (cmd, args) => {
							spawn_calls.push({ cmd, args: [...args] });
							return {
								success: true,
								code: 0,
								stdout: new Uint8Array(),
								stderr: new Uint8Array()
							};
						},
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
		runtime.mock_fs.clear();
		runtime.mock_dirs.clear();
		runtime.command_calls.length = 0;
		spawn_calls.length = 0;
		inject_write_fault = null;
		admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
	});

	test('mints a new secret, writes both hook files, and updates the cell', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_rotate_secret',
			params: { id },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		assert.deepStrictEqual(res.result, { ok: true });

		// Wire payload must not surface the old or new secret.
		const serialized = JSON.stringify(res.result);
		assert.notInclude(serialized, OLD_SECRET);
		assert.notInclude(serialized, 'hook_secret');

		// Both hook scripts on disk carry one new secret, and the cell holds
		// its digest — a *different* digest than the seeded one.
		const pre = runtime.mock_fs.get(hook_path(id, 'pre-receive'));
		const post = runtime.mock_fs.get(hook_path(id, 'post-receive'));
		assert.isDefined(pre);
		assert.isDefined(post);
		const new_secret = embedded_secret(pre);
		assert.strictEqual(embedded_secret(post), new_secret);
		assert.notStrictEqual(new_secret, OLD_SECRET);
		const after = await read_cell_data(get_db, id);
		assert.isNotNull(after);
		assert.strictEqual(after.hook_secret_hash, hash_hook_secret(new_secret));
		assert.notInclude(JSON.stringify(after), new_secret, 'no plaintext in the cell');
		assert.notInclude(serialized, after.hook_secret_hash);
		// And neither retains the old secret string.
		assert.notInclude(pre, OLD_SECRET);
		assert.notInclude(post, OLD_SECRET);

		// chmod 0700 ran for both hook files (install_hooks tightens perms
		// after each write).
		const chmod_calls = spawn_calls.filter((c) => c.cmd === 'chmod');
		assert.strictEqual(chmod_calls.length, 2);
	});

	test('drops a legacy plaintext hook_secret while writing the new digest', async () => {
		// a cell that held the plaintext and was given a digest by hand: it
		// narrows, so rotate reaches it, and the plaintext must not survive
		const legacy_data = { ...SAMPLE_DATA(), hook_secret: OLD_SECRET };
		const id = await seed_repo_cell(get_db, legacy_data);

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_rotate_secret',
			params: { id },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);

		const after = await read_cell_data(get_db, id);
		assert.isNotNull(after);
		assert.notProperty(after, 'hook_secret');
		assert.notInclude(JSON.stringify(after), OLD_SECRET);
		const pre = runtime.mock_fs.get(hook_path(id, 'pre-receive'));
		assert.isDefined(pre);
		assert.strictEqual(after.hook_secret_hash, hash_hook_secret(embedded_secret(pre)));
		// keys outside the legacy one survive the write-back
		assert.strictEqual(after.slug, SAMPLE_DATA().slug);
		assert.strictEqual(after.default_branch, SAMPLE_DATA().default_branch);
	});

	test('refuses before any write when the installed hooks cannot be read', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		await runtime.write_text_file(hook_path(id, 'pre-receive'), `old pre ${OLD_SECRET}`);
		const original_read = runtime.read_text_file;
		runtime.read_text_file = async () => {
			throw new Error('simulated read failure');
		};
		let writes = 0;
		inject_write_fault = () => {
			writes++;
			return null;
		};
		try {
			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_rotate_secret',
				params: { id },
				headers: admin.create_session_headers()
			});
			assert.isFalse(res.ok);
			assert.include(res.error.message.toLowerCase(), 'hook scripts unreadable');
		} finally {
			runtime.read_text_file = original_read;
		}
		assert.strictEqual(writes, 0, 'nothing is written');
		const after = await read_cell_data(get_db, id);
		assert.strictEqual(after?.hook_secret_hash, hash_hook_secret(OLD_SECRET));
	});

	test('a permission error on a hook stat cannot see is unreadable, not absent', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		// `stat` answers null for every failure, so only the read can tell a
		// missing hook from one the server may not read.
		const original_read = runtime.read_text_file;
		runtime.read_text_file = async () => {
			throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
		};
		let writes = 0;
		inject_write_fault = () => {
			writes++;
			return null;
		};
		try {
			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_repo_rotate_secret',
				params: { id },
				headers: admin.create_session_headers()
			});
			assert.isFalse(res.ok);
			assert.include(res.error.message.toLowerCase(), 'hook scripts unreadable');
		} finally {
			runtime.read_text_file = original_read;
		}
		assert.strictEqual(writes, 0, 'nothing is written');
		const after = await read_cell_data(get_db, id);
		assert.strictEqual(after?.hook_secret_hash, hash_hook_secret(OLD_SECRET));
	});

	test('rolls back cell + disk when a hook write fails and recovery succeeds', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		// The hooks as installed before the rotation — what recovery restores.
		const old_pre = `old pre ${OLD_SECRET}`;
		const old_post = `old post ${OLD_SECRET}`;
		await runtime.write_text_file(hook_path(id, 'pre-receive'), old_pre);
		await runtime.write_text_file(hook_path(id, 'post-receive'), old_post);

		// Throw only on the *first* post-receive write — the second
		// call to that path (the recovery install) will succeed.
		let post_receive_seen = 0;
		inject_write_fault = (path) => {
			if (!path.includes('post-receive')) return null;
			post_receive_seen++;
			return post_receive_seen === 1 ? 'simulated disk failure' : null;
		};

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_rotate_secret',
			params: { id },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'reverted to old secret');

		// Cell rolls back via the wrapping transaction — original digest intact.
		const after = await read_cell_data(get_db, id);
		assert.strictEqual(after?.hook_secret_hash, hash_hook_secret(OLD_SECRET));

		// Disk lands consistent: both hooks restored byte for byte.
		assert.strictEqual(runtime.mock_fs.get(hook_path(id, 'pre-receive')), old_pre);
		assert.strictEqual(runtime.mock_fs.get(hook_path(id, 'post-receive')), old_post);
	});

	test('recovery removes a hook that was absent before the rotation', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		// No hooks installed: the forward write lands `pre-receive`, then fails
		// on `post-receive`; recovery must not leave the new `pre-receive`.
		let post_receive_seen = 0;
		inject_write_fault = (path) => {
			if (!path.includes('post-receive')) return null;
			post_receive_seen++;
			return post_receive_seen === 1 ? 'simulated disk failure' : null;
		};

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_rotate_secret',
			params: { id },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'reverted to old secret');
		assert.isUndefined(runtime.mock_fs.get(hook_path(id, 'pre-receive')));
		assert.isUndefined(runtime.mock_fs.get(hook_path(id, 'post-receive')));
	});

	test('surfaces manual-reconciliation error when recovery also fails', async () => {
		const id = await seed_repo_cell(get_db, SAMPLE_DATA());
		// Installed hooks, so recovery has a `post-receive` to write back.
		await runtime.write_text_file(hook_path(id, 'pre-receive'), `old pre ${OLD_SECRET}`);
		await runtime.write_text_file(hook_path(id, 'post-receive'), `old post ${OLD_SECRET}`);

		// Every post-receive write throws — forward and recovery both
		// fail to lay down a consistent on-disk script.
		inject_write_fault = (path) =>
			path.includes('post-receive') ? 'persistent disk failure' : null;

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_rotate_secret',
			params: { id },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'manual reconciliation');

		// Cell still rolls back — the transactional invariant survives
		// even when the disk-side recovery is unable to.
		const after = await read_cell_data(get_db, id);
		assert.strictEqual(after?.hook_secret_hash, hash_hook_secret(OLD_SECRET));
	});

	test('resolves by slug', async () => {
		const id = await seed_repo_cell(
			get_db,
			SAMPLE_DATA({ slug: 'fuzdev/by_slug', name: 'by_slug' })
		);

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_rotate_secret',
			params: { slug: 'fuzdev/by_slug' },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);

		const after = await read_cell_data(get_db, id);
		assert.isNotNull(after);
		assert.notStrictEqual(after.hook_secret_hash, hash_hook_secret(OLD_SECRET));
	});

	test('returns 404 when the repo cell does not exist', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_rotate_secret',
			params: { id: ABSENT_UUID },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.include(res.error.message.toLowerCase(), 'repo');
	});

	test('rejects providing both id and slug', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_repo_rotate_secret',
			params: { id: ABSENT_UUID, slug: 'fuzdev/fuz_app' },
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
	});
});
