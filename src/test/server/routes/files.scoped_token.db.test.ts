/**
 * Scoped-token capability tests for the `/api/fuz_forge/files/*` routes.
 *
 * Adds the policy layer on top of the existing admin-role / authenticated
 * gates: scoped tokens authenticate as their issuing account but their
 * file store actions are narrowed to what the `fuz_forge_api_token_policy`
 * row allows.
 *
 * This file requires `transform_middleware: extend_middleware_for_fuz_forge`
 * to be wired into the test app — without it, the policy hydration
 * middleware doesn't fire and `c.var.fuz_forge_token_policy` is always
 * undefined (which the gates treat as unscoped). The existing
 * `files.db.test.ts` deliberately does NOT wire this in to verify that
 * unscoped behavior is unaffected; this file's setup is symmetric — it
 * wires the middleware in to test the scoped path.
 *
 * @module
 */

import { mkdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, test, describe, beforeAll, afterAll } from 'vitest';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { create_test_app, type TestApp } from '@fuzdev/fuz_app/testing/app_server.ts';
import { create_node_runtime } from '@fuzdev/fuz_app/runtime/node.ts';
import type { AppServerContext } from '@fuzdev/fuz_app/server/app_server_context.ts';
import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import { DbCheckoutError } from '@fuzdev/fuz_app/db/db_checkout_error.ts';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { token_scope_full } from '@fuzdev/fuz_app/auth/token_scope.ts';

import { fuz_forge_session_config } from '#lib/server/routes/account.ts';
import { create_fuz_forge_app_route_specs } from '#lib/server/routes/fuz_forge_route_specs.ts';
import { PgFactStore } from '@fuzdev/fuz_app/db/fact_store.ts';
import {
	create_fuz_forge_token_policy_middleware,
	extend_middleware_for_fuz_forge
} from '#lib/server/fuz_forge_token_policy_middleware.ts';
import { policy_from_template } from '#lib/server/fuz_forge_token_policy.ts';

import { describe_db } from '../../db_fixture.ts';
import {
	test_file_route_deps,
	test_audit_sse_deps,
	test_facts_dir
} from './fuz_forge_test_helpers.ts';
import {
	attach_policy,
	attach_raw_policy,
	get_api_token_id_for_account,
	narrow_token_scope,
	set_token_scope
} from './scoped_token_helpers.ts';

let disk_root: string;

beforeAll(async () => {
	const tag = randomBytes(16).toString('hex');
	disk_root = join(tmpdir(), `fuz_forge-files-scoped-facts-${tag}`);
	await mkdir(disk_root, { recursive: true });
});

afterAll(async () => {
	if (disk_root) await rm(disk_root, { recursive: true, force: true });
});

const runtime = create_node_runtime([]);

/**
 * @param get_db - the test database
 * @param get_policy_db - the database the policy middleware reads; a stub here
 *   injects a lookup failure without touching the rest of the stack
 */
const build_test_app = async (
	get_db: () => Db,
	get_policy_db: () => Db = get_db
): Promise<TestApp> => {
	const log = new Logger('test-files-scoped', { level: 'off' });
	const create_route_specs = (ctx: AppServerContext) => {
		const query_deps: QueryDeps = { db: ctx.deps.db };
		const fact_store = new PgFactStore({ deps: query_deps, disk_root, fs: runtime, log });
		return create_fuz_forge_app_route_specs(ctx, {
			audit_sse: test_audit_sse_deps(),
			fuz_forge: {
				runtime,
				query_deps,
				seed_from_allow_private_hosts: false,
				log
			},
			files: test_file_route_deps({
				query_deps,
				max_upload_bytes: 1024 * 1024,
				fact_store
			}),
			repo_git: { runtime, query_deps, spawn_streaming: undefined, log },
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
		roles: [ROLE_ADMIN],
		app_options: {
			// Wire the fuz_forge policy hydration middleware into the test stack.
			// Production uses the same shape via server.ts; this mirrors it.
			transform_middleware: (api_middleware) =>
				extend_middleware_for_fuz_forge(api_middleware, {
					fuz_forge_token_policy_middleware: create_fuz_forge_token_policy_middleware(
						{ db: get_policy_db() },
						new Logger('test-files-scoped-mw', { level: 'off' })
					)
				})
		}
	});
};

const upload = async (
	test_app: TestApp,
	headers: Record<string, string>,
	filename: string,
	bytes: Uint8Array
): Promise<Response> =>
	test_app.app.request(`/api/fuz_forge/files/${filename}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(bytes.length),
			...headers
		},
		body: bytes as unknown as BodyInit
	});

const download = async (
	test_app: TestApp,
	headers: Record<string, string>,
	filename: string
): Promise<Response> =>
	test_app.app.request(`/api/fuz_forge/files/${filename}`, {
		method: 'GET',
		headers
	});

const list = async (test_app: TestApp, headers: Record<string, string>): Promise<Response> =>
	test_app.app.request('/api/fuz_forge/files', {
		method: 'GET',
		headers
	});

const delete_file = async (
	test_app: TestApp,
	headers: Record<string, string>,
	filename: string
): Promise<Response> =>
	test_app.app.request(`/api/fuz_forge/files/${filename}`, {
		method: 'DELETE',
		headers
	});

describe_db('files.ts scoped-token gating', (get_db) => {
	describe('files_read scoped token', () => {
		test('read allowed for permitted filename, denied for others', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			// Seed: upload two files with an unscoped admin (the bootstrapped account).
			const r_up_a = await upload(
				test_app,
				test_app.create_bearer_headers(),
				'allowed.bin',
				new Uint8Array([1, 2, 3])
			);
			assert.strictEqual(r_up_a.status, 200);
			const r_up_b = await upload(
				test_app,
				test_app.create_bearer_headers(),
				'denied.bin',
				new Uint8Array([4, 5, 6])
			);
			assert.strictEqual(r_up_b.status, 200);

			// Scope `admin` to read 'allowed.bin' only.
			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			const policy = policy_from_template({ kind: 'files_read', filenames: ['allowed.bin'] });
			assert.ok(policy);
			await attach_policy(get_db(), token_id, policy, 'files_read');

			const allowed = await download(test_app, admin.create_bearer_headers(), 'allowed.bin');
			assert.strictEqual(allowed.status, 200);

			const denied = await download(test_app, admin.create_bearer_headers(), 'denied.bin');
			assert.strictEqual(denied.status, 403);
			const body = (await denied.json()) as { error: string; required: string };
			assert.strictEqual(body.error, 'forbidden');
			assert.strictEqual(body.required, 'files.read:denied.bin');
		});

		test('write denied for files_read token', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			const policy = policy_from_template({ kind: 'files_read', filenames: '*' });
			assert.ok(policy);
			await attach_policy(get_db(), token_id, policy, 'files_read');

			const res = await upload(
				test_app,
				admin.create_bearer_headers(),
				'attempt.bin',
				new Uint8Array([1, 2, 3])
			);
			assert.strictEqual(res.status, 403);
			const body = (await res.json()) as { error: string; required: string };
			assert.strictEqual(body.required, 'files.write:attempt.bin');
		});

		test('delete denied for files_read token', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			// Seed a file first.
			await upload(
				test_app,
				test_app.create_bearer_headers(),
				'target.bin',
				new Uint8Array([1, 2, 3])
			);

			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			const policy = policy_from_template({ kind: 'files_read', filenames: '*' });
			assert.ok(policy);
			await attach_policy(get_db(), token_id, policy, 'files_read');

			const res = await delete_file(test_app, admin.create_bearer_headers(), 'target.bin');
			assert.strictEqual(res.status, 403);
			const body = (await res.json()) as { error: string; required: string };
			assert.strictEqual(body.required, 'files.delete:target.bin');
		});

		test('list filters to readable entries only', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			await upload(test_app, test_app.create_bearer_headers(), 'visible.bin', new Uint8Array([1]));
			await upload(test_app, test_app.create_bearer_headers(), 'hidden_a.bin', new Uint8Array([2]));
			await upload(test_app, test_app.create_bearer_headers(), 'hidden_b.bin', new Uint8Array([3]));

			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			const policy = policy_from_template({ kind: 'files_read', filenames: ['visible.bin'] });
			assert.ok(policy);
			await attach_policy(get_db(), token_id, policy, 'files_read');

			const res = await list(test_app, admin.create_bearer_headers());
			assert.strictEqual(res.status, 200);
			const body = (await res.json()) as { files: Array<{ filename: string }> };
			assert.deepStrictEqual(
				body.files.map((f) => f.filename),
				['visible.bin']
			);
		});

		test('list with wildcard read sees everything', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			await upload(test_app, test_app.create_bearer_headers(), 'a.bin', new Uint8Array([1]));
			await upload(test_app, test_app.create_bearer_headers(), 'b.bin', new Uint8Array([2]));

			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			const policy = policy_from_template({ kind: 'files_read', filenames: '*' });
			assert.ok(policy);
			await attach_policy(get_db(), token_id, policy, 'files_read');

			const res = await list(test_app, admin.create_bearer_headers());
			assert.strictEqual(res.status, 200);
			const body = (await res.json()) as { files: Array<{ filename: string }> };
			assert.deepStrictEqual(body.files.map((f) => f.filename).sort(), ['a.bin', 'b.bin']);
		});
	});

	describe('files_write scoped token', () => {
		test('upload allowed for permitted filename, denied for others', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			const policy = policy_from_template({
				kind: 'files_write',
				filenames: ['can-write.bin']
			});
			assert.ok(policy);
			await attach_policy(get_db(), token_id, policy, 'files_write');

			const ok = await upload(
				test_app,
				admin.create_bearer_headers(),
				'can-write.bin',
				new Uint8Array([1, 2, 3])
			);
			assert.strictEqual(ok.status, 200);

			const bad = await upload(
				test_app,
				admin.create_bearer_headers(),
				'other.bin',
				new Uint8Array([1, 2, 3])
			);
			assert.strictEqual(bad.status, 403);
		});

		test("write doesn't grant read", async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			// Upload via the unscoped bootstrap account so the file exists.
			await upload(
				test_app,
				test_app.create_bearer_headers(),
				'thing.bin',
				new Uint8Array([1, 2, 3])
			);

			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			const policy = policy_from_template({ kind: 'files_write', filenames: '*' });
			assert.ok(policy);
			await attach_policy(get_db(), token_id, policy, 'files_write');

			const res = await download(test_app, admin.create_bearer_headers(), 'thing.bin');
			assert.strictEqual(res.status, 403);
		});
	});

	describe('deny-all policy', () => {
		test('every files op denied', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			await upload(test_app, test_app.create_bearer_headers(), 'x.bin', new Uint8Array([1]));

			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			await attach_policy(get_db(), token_id, { version: 1 }, 'deny_all');

			const up = await upload(
				test_app,
				admin.create_bearer_headers(),
				'y.bin',
				new Uint8Array([1])
			);
			const dl = await download(test_app, admin.create_bearer_headers(), 'x.bin');
			const ls = await list(test_app, admin.create_bearer_headers());
			const del = await delete_file(test_app, admin.create_bearer_headers(), 'x.bin');

			assert.strictEqual(up.status, 403);
			assert.strictEqual(dl.status, 403);
			assert.strictEqual(ls.status, 200); // list is filter-not-403
			const ls_body = (await ls.json()) as { files: Array<unknown> };
			assert.strictEqual(ls_body.files.length, 0);
			assert.strictEqual(del.status, 403);
		});
	});

	describe('unreadable policy row', () => {
		/**
		 * The wiring behind `policy_from_stored`: a row the schema can't read
		 * must reach the gates as the deny-all document, not as an absent row.
		 * `policy_from_stored` is unit-pinned in
		 * `server/fuz_forge_token_policy.test.ts`; this asserts the read path
		 * actually goes through it, since returning the raw jsonb here would
		 * have handed the gates a `{version: 2}` object that `policy_check`
		 * reads as "no grants declared" on some shapes and — for the
		 * `null`-returning spelling — as unscoped, which allows everything.
		 */
		test('a future grammar version denies every files op', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			await upload(test_app, test_app.create_bearer_headers(), 'x.bin', new Uint8Array([1]));

			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			// A v2 document granting everything — refused wholesale, not read.
			await attach_raw_policy(
				get_db(),
				token_id,
				{ version: 2, files: { read: '*', write: '*', delete: '*' } },
				2,
				'future_grammar'
			);

			const headers = admin.create_bearer_headers();
			const dl = await download(test_app, headers, 'x.bin');
			assert.strictEqual(dl.status, 403, 'read must be refused, not granted by the v2 doc');
			assert.deepStrictEqual(await dl.json(), {
				error: 'forbidden',
				required: 'files.read:x.bin'
			});

			const ls = await list(test_app, headers);
			assert.strictEqual(ls.status, 200); // list is filter-not-403
			assert.deepStrictEqual(await ls.json(), { files: [] });

			const up = await upload(test_app, headers, 'y.bin', new Uint8Array([1]));
			assert.strictEqual(up.status, 403);
			const del = await delete_file(test_app, headers, 'x.bin');
			assert.strictEqual(del.status, 403);
		});

		test('the same token with a readable v1 grant reaches the file', async () => {
			// The control: the row, the column, and the write path are identical
			// — only the document's grammar differs — so the denials above can't
			// pass on a build that refuses every policy row.
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			await upload(test_app, test_app.create_bearer_headers(), 'x.bin', new Uint8Array([1]));

			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			await attach_raw_policy(
				get_db(),
				token_id,
				{ version: 1, files: { read: '*' } },
				1,
				'readable'
			);

			const headers = admin.create_bearer_headers();
			assert.strictEqual((await download(test_app, headers, 'x.bin')).status, 200);
			const ls_body = (await (await list(test_app, headers)).json()) as {
				files: Array<unknown>;
			};
			assert.strictEqual(ls_body.files.length, 1);
		});
	});

	/**
	 * The **other** axis: a token narrowed on `api_token.scope` with no policy
	 * row, which is what the spine's `account_token_create` mints.
	 *
	 * Every case above narrows the forge policy, so every denial above comes
	 * from `policy_check`. This block is the complement, and it is the shape
	 * that was reaching the file store unrefused: `policy_check(null, …)`
	 * returns `true`, so the resource axis abstains and only
	 * `token_scope_admits_forge_surface` is left to answer.
	 *
	 * The cross-backend `consumer_surface_scoped_token.cross.test.ts` proves the
	 * same thing on both backends over real HTTP; these run in the default
	 * `gro test` gate, which that suite does not.
	 */
	describe('narrowed spine scope, no policy row', () => {
		test('every files route refuses with the flat surface denial', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			// Seed with the bootstrapped admin so the target exists — a 403 on a
			// missing file would pass whether or not the gate ran.
			const seeded = await upload(
				test_app,
				test_app.create_bearer_headers(),
				'seeded.bin',
				new Uint8Array([1, 2, 3])
			);
			assert.strictEqual(seeded.status, 200);

			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			await narrow_token_scope(get_db(), token_id, ['fuz_forge_repo_list']);

			const headers = admin.create_bearer_headers();
			const responses = {
				upload: await upload(test_app, headers, 'attempt.bin', new Uint8Array([1])),
				list: await list(test_app, headers),
				download: await download(test_app, headers, 'seeded.bin'),
				delete: await delete_file(test_app, headers, 'seeded.bin')
			};

			for (const [name, res] of Object.entries(responses)) {
				assert.strictEqual(res.status, 403, `${name} must refuse a narrowed token`);
				assert.deepStrictEqual(
					await res.json(),
					{ error: 'token_scope_required', required_scope: 'surface:file_store' },
					`${name} denial body`
				);
			}
		});

		test('list refuses rather than returning an empty set', async () => {
			// The failure mode the shared `enforce_surface` call is placed to
			// prevent: list filters by policy, and a token with no policy row has
			// nothing to filter *by*. Falling through would have shown it every
			// entry; filtering to nothing would have looked like a refusal while
			// leaving the other three routes open.
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await upload(test_app, test_app.create_bearer_headers(), 'listed.bin', new Uint8Array([1]));

			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			await narrow_token_scope(get_db(), token_id, []);

			const res = await list(test_app, admin.create_bearer_headers());
			assert.strictEqual(res.status, 403);
			assert.notProperty(await res.json(), 'files');
		});

		test('a full scope written the same way still reaches every route', async () => {
			// The positive control. Same rewrite path, same absent policy row —
			// only the scope's content differs, so the denials above cannot pass
			// vacuously on a build that refused every rewritten token.
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			await set_token_scope(get_db(), token_id, token_scope_full());

			const headers = admin.create_bearer_headers();
			const up = await upload(test_app, headers, 'full.bin', new Uint8Array([1, 2, 3]));
			assert.strictEqual(up.status, 200);
			assert.strictEqual((await list(test_app, headers)).status, 200);
			assert.strictEqual((await download(test_app, headers, 'full.bin')).status, 200);
			assert.strictEqual((await delete_file(test_app, headers, 'full.bin')).status, 200);
		});
	});

	describe('failed policy lookup', () => {
		/** A policy database whose every method rejects with `error`. */
		const throwing_db = (error: Error): Db =>
			new Proxy({}, { get: () => () => Promise.reject(error) }) as unknown as Db;

		test('a failed checkout answers the flat 503 on every files route', async () => {
			// A narrowed token, so the old fall-through would have answered the
			// 403 surface denial — the 503 is the checkout, not the scope.
			const checkout_failure = new DbCheckoutError({
				cause: new Error('timeout exceeded when trying to connect')
			});
			const test_app = await build_test_app(get_db, () => throwing_db(checkout_failure));
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			await narrow_token_scope(get_db(), token_id, ['fuz_forge_repo_list']);

			const headers = admin.create_bearer_headers();
			const responses = {
				upload: await upload(test_app, headers, 'attempt.bin', new Uint8Array([1])),
				list: await list(test_app, headers),
				download: await download(test_app, headers, 'attempt.bin'),
				delete: await delete_file(test_app, headers, 'attempt.bin')
			};

			for (const [name, res] of Object.entries(responses)) {
				assert.strictEqual(res.status, 503, `${name} must answer the checkout failure`);
				assert.deepStrictEqual(
					await res.json(),
					{ error: 'service_unavailable' },
					`${name} 503 body`
				);
			}
		});

		test('any other lookup error falls through unscoped', async () => {
			// Unscoped means the spine scope decides: the narrowed token is
			// refused, never widened.
			const test_app = await build_test_app(get_db, () =>
				throwing_db(new Error('relation does not exist'))
			);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
			await narrow_token_scope(get_db(), token_id, ['fuz_forge_repo_list']);

			const res = await download(test_app, admin.create_bearer_headers(), 'attempt.bin');
			assert.strictEqual(res.status, 403);
			assert.deepStrictEqual(await res.json(), {
				error: 'token_scope_required',
				required_scope: 'surface:file_store'
			});
		});
	});

	describe('unscoped token regression', () => {
		test('admin bearer with no policy row sees full surface', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			const up = await upload(
				test_app,
				admin.create_bearer_headers(),
				'free.bin',
				new Uint8Array([1, 2, 3])
			);
			assert.strictEqual(up.status, 200);

			const dl = await download(test_app, admin.create_bearer_headers(), 'free.bin');
			assert.strictEqual(dl.status, 200);

			const del = await delete_file(test_app, admin.create_bearer_headers(), 'free.bin');
			assert.strictEqual(del.status, 200);
		});
	});
});
