/**
 * Coverage assertion: a deny-all scoped-token policy MUST refuse every
 * protected fuz_forge REST surface it governs.
 *
 * Discipline guard for forge's resource-bound half of the scoped-token
 * feature. Each per-file gate site (`server/routes/files.ts`) reads
 * `FUZ_FORGE_TOKEN_POLICY_KEY` via `enforce_capability`. A future surface that
 * forgets to consult the policy would silently widen access — this test
 * iterates over every file-store route and demands a 403/forbidden response
 * from each, except the list, which filters to the empty readable set and so
 * answers 200 with no entries.
 *
 * The RPC method surface is the spine's, gated by `api_token.scope`
 * inside `perform_action` rather than by a forge policy row, and covered
 * cross-process by `cross_backend/rpc_scoped_token.cross.test.ts`.
 *
 * Forge smart-HTTP routes have their own deny-all coverage in
 * `repo_git.scoped_token.db.test.ts` (HTTP Basic auth shape, not Bearer).
 *
 * @module
 */

import { test, assert, beforeAll, beforeEach } from 'vitest';
import { ROLE_ADMIN, ROLE_KEEPER } from '@fuzdev/fuz_app/auth/role_schema.ts';
import type { TestApp, TestAccount } from '@fuzdev/fuz_app/testing/app_server.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	create_fuz_forge_token_policy_middleware,
	extend_middleware_for_fuz_forge
} from '#lib/server/fuz_forge_token_policy_middleware.ts';

import { describe_db } from '../../db_fixture.ts';
import { create_fuz_forge_admin_test_app } from './fuz_forge_test_helpers.ts';
import { attach_deny_all_policy, get_api_token_id_for_account } from './scoped_token_helpers.ts';

describe_db('scoped-token deny-all coverage', (get_db) => {
	let test_app: TestApp;
	let admin: TestAccount;

	beforeAll(async () => {
		test_app = await create_fuz_forge_admin_test_app(get_db, {
			roles: [ROLE_KEEPER, ROLE_ADMIN],
			app_options: {
				transform_middleware: (api_middleware) =>
					extend_middleware_for_fuz_forge(api_middleware, {
						fuz_forge_token_policy_middleware: create_fuz_forge_token_policy_middleware(
							{ db: get_db() },
							new Logger('test-deny-all', { level: 'off' })
						)
					})
			}
		});
	});

	beforeEach(async () => {
		admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
	});

	const bearer = (account: TestAccount): Record<string, string> => ({
		authorization: `Bearer ${account.api_token}`
	});

	test('file store routes denied under deny-all policy', async () => {
		const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
		await attach_deny_all_policy(get_db(), token_id);

		const filename = 'probe.bin';

		// GET /api/fuz_forge/files (list)
		const list_res = await test_app.app.request('/api/fuz_forge/files', {
			headers: bearer(admin)
		});
		assert.strictEqual(list_res.status, 200, 'list endpoint filters, not 403');
		const list_body = (await list_res.json()) as { files: Array<unknown> };
		// List is filtered to readable files — under deny-all, the readable
		// set is empty regardless of what's stored on disk
		assert.deepStrictEqual(list_body.files, []);

		// GET /api/fuz_forge/files/:filename?meta
		const meta_res = await test_app.app.request(`/api/fuz_forge/files/${filename}?meta`, {
			headers: bearer(admin)
		});
		assert.strictEqual(meta_res.status, 403, 'meta should be 403 under deny-all');
		const meta_body = (await meta_res.json()) as { required: string };
		assert.strictEqual(meta_body.required, `files.read:${filename}`);

		// GET /api/fuz_forge/files/:filename (download)
		const get_res = await test_app.app.request(`/api/fuz_forge/files/${filename}`, {
			headers: bearer(admin)
		});
		assert.strictEqual(get_res.status, 403, 'download should be 403 under deny-all');
		const get_body = (await get_res.json()) as { required: string };
		assert.strictEqual(get_body.required, `files.read:${filename}`);

		// POST /api/fuz_forge/files/:filename (upload)
		const upload_res = await test_app.app.request(`/api/fuz_forge/files/${filename}`, {
			method: 'POST',
			headers: { ...bearer(admin), 'Content-Type': 'application/octet-stream' },
			body: new Uint8Array([1, 2, 3])
		});
		assert.strictEqual(upload_res.status, 403, 'upload should be 403 under deny-all');
		const upload_body = (await upload_res.json()) as { required: string };
		assert.strictEqual(upload_body.required, `files.write:${filename}`);

		// DELETE /api/fuz_forge/files/:filename
		const del_res = await test_app.app.request(`/api/fuz_forge/files/${filename}`, {
			method: 'DELETE',
			headers: bearer(admin)
		});
		assert.strictEqual(del_res.status, 403, 'delete should be 403 under deny-all');
		const del_body = (await del_res.json()) as { required: string };
		assert.strictEqual(del_body.required, `files.delete:${filename}`);
	});
});
