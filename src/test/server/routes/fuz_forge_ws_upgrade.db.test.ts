/**
 * The forge's `/api/ws` upgrade refusals, in-process: each rung's status and
 * body as the TS server builds them.
 *
 * The cross-process WS suites (`cross_backend/ws_role_gate.cross.test.ts`,
 * `cross_backend/ws_scoped_token.cross.test.ts`) pin these bodies on the Rust
 * backend only: on Node, `@hono/node-ws` answers a refused upgrade with its
 * status and an empty body. Here the forge's own WS endpoint
 * (`build_ws_endpoint_specs`) mounts over a stub upgrade, so the refusal is
 * the response the guard chain returns, before any socket.
 *
 * @module
 */

import { assert, beforeAll, test } from 'vitest';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { ConnectionRegistry } from '@fuzdev/fuz_app/actions/connection_registry.ts';
import {
	serialize_token_scope,
	token_scope_denied_body,
	token_scope_methods
} from '@fuzdev/fuz_app/auth/token_scope.ts';
import type { TestApp } from '@fuzdev/fuz_app/testing/app_server.ts';
import { create_stub_upgrade, type StubUpgrade } from '@fuzdev/fuz_app/testing/ws_round_trip.ts';

import { build_ws_endpoint_specs } from '#lib/server/routes/fuz_forge_route_specs.ts';

import { describe_db } from '../../db_fixture.ts';
import { create_fuz_forge_admin_test_app } from './fuz_forge_test_helpers.ts';

const UPGRADE_HEADERS = { Upgrade: 'websocket', Connection: 'Upgrade' };

describe_db('fuz_forge /api/ws upgrade refusals', (get_db) => {
	let test_app: TestApp;
	let stub: StubUpgrade;

	beforeAll(async () => {
		stub = create_stub_upgrade();
		test_app = await create_fuz_forge_admin_test_app(get_db, {
			app_options: {
				ws_endpoints: build_ws_endpoint_specs(new ConnectionRegistry()),
				create_upgrade_websocket: () => stub.upgradeWebSocket
			}
		});
	});

	const upgrade = (headers: Record<string, string>): Promise<Response> =>
		Promise.resolve(
			test_app.app.request('/api/ws', {
				headers: { ...UPGRADE_HEADERS, ...headers }
			})
		);

	test('a foreign origin → 403 forbidden_origin, ahead of auth', async () => {
		const res = await upgrade({ Origin: 'https://foreign.example' });
		assert.strictEqual(res.status, 403);
		assert.deepStrictEqual(await res.json(), { error: 'forbidden_origin' });
	});

	test('no credential → 401 authentication_required', async () => {
		const res = await upgrade({});
		assert.strictEqual(res.status, 401);
		assert.deepStrictEqual(await res.json(), {
			error: 'authentication_required'
		});
	});

	test('a session without admin → 403 insufficient_permissions naming admin', async () => {
		const account = await test_app.create_account();
		const res = await upgrade(account.create_session_headers());
		assert.strictEqual(res.status, 403);
		assert.deepStrictEqual(await res.json(), {
			error: 'insufficient_permissions',
			required_roles: [ROLE_ADMIN]
		});
	});

	test('a narrowed admin token → 403 token_scope_required, decided before the role', async () => {
		const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
		await get_db().query(`UPDATE api_token SET scope = $1::jsonb WHERE account_id = $2`, [
			serialize_token_scope(token_scope_methods(['heartbeat'])),
			admin.account.id
		]);
		const res = await upgrade(admin.create_bearer_headers());
		assert.strictEqual(res.status, 403);
		assert.deepStrictEqual(await res.json(), token_scope_denied_body('surface:ws_upgrade'));
	});

	test('a narrowed token without admin hears about its scope, not the role', async () => {
		const account = await test_app.create_account();
		await get_db().query(`UPDATE api_token SET scope = $1::jsonb WHERE account_id = $2`, [
			serialize_token_scope(token_scope_methods(['heartbeat'])),
			account.account.id
		]);
		const res = await upgrade(account.create_bearer_headers());
		assert.strictEqual(res.status, 403);
		assert.deepStrictEqual(await res.json(), token_scope_denied_body('surface:ws_upgrade'));
	});

	test('an admin session reaches the upgrade (the control)', async () => {
		const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
		const before = stub.upgrades.length;
		const res = await upgrade(admin.create_session_headers());
		assert.strictEqual(res.status, 200);
		assert.strictEqual(stub.upgrades.length, before + 1);
	});
});
