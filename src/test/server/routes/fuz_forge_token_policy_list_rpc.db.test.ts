/**
 * Handler tests for `fuz_forge_token_policy_list`.
 *
 * The list endpoint joins fuz_app's `api_token` rows with fuz_forge's
 * `fuz_forge_api_token_policy` rows to surface the template name per
 * scoped token. Unscoped tokens (no policy row) MUST be absent
 * from the result — the UI treats absence as "admin (unscoped)".
 *
 * Authz invariants (admin-only, session-only) are covered by the
 * standard auth attack surface snapshot.
 *
 * @module
 */

import { assert, test, beforeAll, beforeEach } from 'vitest';
import { ROLE_ADMIN, ROLE_KEEPER } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import type { TestApp, TestAccount } from '@fuzdev/fuz_app/testing/app_server.ts';

import type { FuzForgeTokenPolicyListOutput } from '#lib/action_specs.ts';

import { describe_db } from '../../db_fixture.ts';
import { create_fuz_forge_admin_test_app } from './fuz_forge_test_helpers.ts';
import { attach_policy, get_api_token_id_for_account } from './scoped_token_helpers.ts';

describe_db('fuz_forge_token_policy_list handler', (get_db) => {
	let test_app: TestApp;
	let admin: TestAccount;

	beforeAll(async () => {
		test_app = await create_fuz_forge_admin_test_app(get_db, {
			roles: [ROLE_KEEPER, ROLE_ADMIN]
		});
	});

	beforeEach(async () => {
		admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
	});

	test('returns empty list when no tokens have policies', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_token_policy_list',
			params: {},
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		const out = res.result as FuzForgeTokenPolicyListOutput;
		assert.deepStrictEqual(out.policies, []);
	});

	test('returns one row per scoped token belonging to the caller', async () => {
		const token_id = await get_api_token_id_for_account(get_db(), admin.account.id);
		await attach_policy(
			get_db(),
			token_id,
			{ version: 1, forge: { push: { alpha: true } } },
			'forge_push'
		);

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_token_policy_list',
			params: {},
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		const out = res.result as FuzForgeTokenPolicyListOutput;
		assert.deepStrictEqual(out.policies, [{ api_token_id: token_id, template: 'forge_push' }]);
	});

	test("does not surface another account's tokens", async () => {
		const other = await test_app.create_account({ roles: [ROLE_ADMIN] });
		const other_token_id = await get_api_token_id_for_account(get_db(), other.account.id);
		await attach_policy(
			get_db(),
			other_token_id,
			{ version: 1, rpc: { fuz_forge_repo_list: true } },
			'rpc_subset'
		);

		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_token_policy_list',
			params: {},
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		const out = res.result as FuzForgeTokenPolicyListOutput;
		assert.deepStrictEqual(out.policies, []);
	});
});
