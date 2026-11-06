/**
 * Integration tests using a real Postgres auth database.
 *
 * Mounts the fuz_app cross-backend suites (standard integration, admin
 * integration, rate limiting, route + RPC round-trip, data exposure) plus
 * fuz_forge-specific smoke tests in separate describe blocks. Suite options use
 * the `default_in_process_suite_options(...)` consolidation helper for the
 * shared `{setup_test, surface_source, capabilities}` triple; admin passes
 * `extra_keeper_roles: [ROLE_ADMIN]` so the bootstrapped keeper can
 * hit admin-gated RPC methods. The two suites that drive the whole route set
 * (round-trip, data exposure) override `setup_test` with
 * `fuz_forge_in_process_setup`, which migrates the forge's own namespaces so
 * the fact-serving routes reach their handlers. The RPC round-trip runs on the
 * whole forge schema in real Postgres with real query deps, so every method it
 * drives reaches its handler. The attack-surface suites live
 * in sibling files; SSE and WS are covered cross-process, in `cross_backend/`.
 *
 * @module
 */

import { test, assert, describe, beforeAll, beforeEach } from 'vitest';
import { describe_standard_integration_tests } from '@fuzdev/fuz_app/testing/integration.ts';
import { describe_standard_admin_integration_tests } from '@fuzdev/fuz_app/testing/admin_integration.ts';
import { describe_rate_limiting_tests } from '@fuzdev/fuz_app/testing/rate_limiting.ts';
import { describe_round_trip_validation } from '@fuzdev/fuz_app/testing/round_trip.ts';
import { describe_rpc_round_trip_tests } from '@fuzdev/fuz_app/testing/rpc_round_trip.ts';
import { describe_data_exposure_tests } from '@fuzdev/fuz_app/testing/data_exposure.ts';
import {
	default_in_process_setup,
	default_in_process_suite_options
} from '@fuzdev/fuz_app/testing/cross_backend/in_process_setup.ts';
import { ROLE_ADMIN, ROLE_KEEPER, create_role_registry } from '@fuzdev/fuz_app/auth/role_schema.ts';
import type { TestApp, TestAccount } from '@fuzdev/fuz_app/testing/app_server.ts';
import type { RouteSpec } from '@fuzdev/fuz_app/http/route_spec.ts';
import type { AppServerContext } from '@fuzdev/fuz_app/server/app_server_context.ts';
import { stub } from '@fuzdev/fuz_app/testing/stubs.ts';
import { create_describe_db } from '@fuzdev/fuz_app/testing/db.ts';
import { assert_response_matches_spec } from '@fuzdev/fuz_app/testing/integration_helpers.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { fuz_forge_session_config } from '#lib/server/routes/account.ts';
import { fuz_forge_own_migration_namespaces } from '#lib/server/db/fuz_forge_schema.ts';
import {
	build_rpc_endpoint_specs,
	create_fuz_forge_app_route_specs
} from '#lib/server/routes/fuz_forge_route_specs.ts';

import { db_factories, describe_db } from '../../db_fixture.ts';
import {
	create_fuz_forge_test_app,
	test_file_route_deps,
	test_audit_sse_deps,
	test_facts_dir,
	fuz_forge_param_values
} from './fuz_forge_test_helpers.ts';

/**
 * Route factory for standard integration tests (stub deps).
 *
 * Uses the shared factory with stub fuz_forge deps — provides the full route set
 * so integration tests cover the complete surface.
 */
const create_fuz_forge_test_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_fuz_forge_app_route_specs(ctx, {
		audit_sse: test_audit_sse_deps(),
		fuz_forge: {
			runtime: stub,
			query_deps: stub,
			seed_from_allow_private_hosts: false,
			log: new Logger('test')
		},
		files: test_file_route_deps({
			query_deps: stub,
			max_upload_bytes: 800 * 1024 * 1024,
			fact_store: stub
		}),
		repo_git: {
			runtime: stub,
			query_deps: stub,
			spawn_streaming: undefined,
			log: new Logger('test')
		},
		repo_internal: {
			query_deps: stub,
			broadcast: stub,
			log: new Logger('test'),
			get_connection_ip: () => '127.0.0.1'
		},
		version: '',
		get_uptime_ms: () => 0,
		facts_dir: test_facts_dir()
	});

/** Builtin roles only — fuz_forge has no app-defined roles. */
const fuz_forge_roles = create_role_registry([]);

/** Stub deps used to build RPC endpoint specs in the suite helpers. */
const fuz_forge_rpc_stub_deps = {
	runtime: stub,
	query_deps: stub,
	seed_from_allow_private_hosts: false,
	log: new Logger('test')
};

/** Factory passed to every suite — one canonical RPC endpoint assembly. */
const fuz_forge_rpc_endpoints = (ctx: AppServerContext) =>
	build_rpc_endpoint_specs(ctx, {
		fuz_forge_deps: fuz_forge_rpc_stub_deps,
		extra_actions: [],
		notification_sender: null,
		final_actions_factory: null
	});

/**
 * Bootstrap config — production wires bootstrap (live when
 * `BOOTSTRAP_TOKEN_PATH` is set), so suite options must too, keeping the
 * surface spec and live app in sync. `surface_only` mounts the route shape
 * with permanent-403 semantics: this suite doesn't drive the success path,
 * and bootstrap audit-completeness coverage lives in
 * `bootstrap_account.db.test.ts` (see fuz_app's testing CLAUDE.md).
 */
const fuz_forge_bootstrap_config = { mode: 'surface_only' } as const;

/**
 * The setup every suite that drives the **whole route set** needs: the fuz_app
 * default plus the forge's own migration namespaces.
 *
 * The two fact-serving routes read the `fact` / `cell` tables, so against the
 * auth-only default fixture `GET /api/facts/:hash` and
 * `GET /api/cells/:cell_id/facts/:hash` answer a missing-relation 500 instead
 * of the route's own 404 — visible as a failure in the round-trip validator,
 * silently swallowed by the data-exposure suite's `if (!res.ok) continue`.
 * `default_in_process_suite_options` builds its `setup_test` from a fixed field
 * list with no slot for the namespaces, so the setup is rebuilt here rather
 * than configured, and the suites that need it override the helper's
 * `setup_test` with this one.
 *
 * The fields match what the helper would have produced for these two call
 * sites: `roles: [ROLE_KEEPER]` (neither passes `extra_keeper_roles`), no
 * `rpc_endpoints` (neither passes one — RPC methods are covered by
 * `describe_rpc_round_trip_tests`), and no `app_options` / `extra_accounts` /
 * `extra_actors`.
 */
const fuz_forge_in_process_setup = default_in_process_setup({
	session_options: fuz_forge_session_config,
	create_route_specs: create_fuz_forge_test_route_specs,
	bootstrap: fuz_forge_bootstrap_config,
	roles: [ROLE_KEEPER],
	migration_namespaces: fuz_forge_own_migration_namespaces
});

// --- Standard auth integration suite (9 test groups) ---

describe_standard_integration_tests(
	default_in_process_suite_options({
		session_options: fuz_forge_session_config,
		create_route_specs: create_fuz_forge_test_route_specs,
		rpc_endpoints: fuz_forge_rpc_endpoints,
		// The signup-invite-edge-case groups drive keeper-side `invite_create`
		// (admin-gated) now that `/signup` is mounted, so the bootstrapped
		// keeper needs ROLE_ADMIN.
		//
		// Load-bearing here, and NOT redundant the way it was in the cross
		// files: the in-process seed is `roles: [ROLE_KEEPER,
		// ...extra_keeper_roles]` (fuz_app's `default_in_process_suite_options`),
		// so admin arrives only if it is named — where `_testing_reset` on the
		// cross-process side seeds `[ROLE_KEEPER, ROLE_ADMIN]` unconditionally.
		// The two defaults differ; don't "clean this up" by analogy.
		extra_keeper_roles: [ROLE_ADMIN],
		bootstrap: fuz_forge_bootstrap_config
	})
);

// --- Standard admin integration tests (7 groups) ---

describe_standard_admin_integration_tests({
	...default_in_process_suite_options({
		session_options: fuz_forge_session_config,
		create_route_specs: create_fuz_forge_test_route_specs,
		rpc_endpoints: fuz_forge_rpc_endpoints,
		extra_keeper_roles: [ROLE_ADMIN],
		bootstrap: fuz_forge_bootstrap_config
	}),
	roles: fuz_forge_roles
});

// --- Rate limiting tests ---

describe_rate_limiting_tests({
	...default_in_process_suite_options({
		session_options: fuz_forge_session_config,
		create_route_specs: create_fuz_forge_test_route_specs,
		rpc_endpoints: fuz_forge_rpc_endpoints,
		bootstrap: fuz_forge_bootstrap_config
	}),
	db_factories
});

// --- Round-trip validation ---

describe_round_trip_validation({
	...default_in_process_suite_options({
		session_options: fuz_forge_session_config,
		create_route_specs: create_fuz_forge_test_route_specs,
		bootstrap: fuz_forge_bootstrap_config
	}),
	// Drives every route to its handler, so it needs the forge's own namespaces
	// migrated — see `fuz_forge_in_process_setup`.
	setup_test: fuz_forge_in_process_setup,
	skip_routes: [
		// RPC routes handled by describe_rpc_round_trip_tests below
		'GET /api/rpc',
		'POST /api/rpc',
		// File store routes take raw bytes, not JSON — round-trip can't generate a body
		'POST /api/fuz_forge/files/:filename{.+}',
		'DELETE /api/fuz_forge/files/:filename{.+}'
	],
	param_values: fuz_forge_param_values
});

// --- RPC round-trip validation ---

/**
 * RPC endpoints over the real database, for the round-trip — it drives every
 * method to its handler, where the stub `query_deps` the other suites use would
 * throw (a 500, which the round-trip reads as a crash).
 */
const fuz_forge_db_rpc_endpoints = (ctx: AppServerContext) =>
	build_rpc_endpoint_specs(ctx, {
		fuz_forge_deps: { ...fuz_forge_rpc_stub_deps, query_deps: { db: ctx.deps.db } },
		extra_actions: [],
		notification_sender: null,
		final_actions_factory: null
	});

/**
 * One fresh forge schema per describe, with no per-test truncate: the round-trip
 * seeds its accounts once, in `beforeAll`, and `describe_db`'s truncate would
 * wipe them before each case.
 */
const describe_forge_schema_db = create_describe_db(db_factories, []);

describe_forge_schema_db('RPC round-trip on the forge schema', (get_db) => {
	describe_rpc_round_trip_tests({
		...default_in_process_suite_options({
			session_options: fuz_forge_session_config,
			create_route_specs: create_fuz_forge_test_route_specs,
			rpc_endpoints: fuz_forge_rpc_endpoints,
			bootstrap: fuz_forge_bootstrap_config
		}),
		// The whole forge schema (`init_fuz_forge_schema`: the cell and fact
		// namespaces plus the direct-DDL token-policy table) and real query deps,
		// so the repo, cell and token-policy reads reach their handlers.
		setup_test: () =>
			default_in_process_setup({
				session_options: fuz_forge_session_config,
				create_route_specs: create_fuz_forge_test_route_specs,
				rpc_endpoints: fuz_forge_db_rpc_endpoints,
				bootstrap: fuz_forge_bootstrap_config,
				roles: [ROLE_KEEPER],
				db: get_db()
			})(),
		// `fuz_forge_repo_create` is side-effecting (real `git init` + disk +
		// hook install) and its `slug` needs a two-segment `org/repo` shape the
		// generator can't synthesize. Covered by `fuz_forge_repo_create_rpc.db.test.ts`.
		skip_methods: ['fuz_forge_repo_create']
	});
});

// --- Data exposure tests ---

describe_data_exposure_tests({
	...default_in_process_suite_options({
		session_options: fuz_forge_session_config,
		create_route_specs: create_fuz_forge_test_route_specs,
		bootstrap: fuz_forge_bootstrap_config
	}),
	// Also drives every route, and its response-shape scan reads only responses
	// that succeeded (`if (!res.ok) continue`) — so on the auth-only default
	// fixture the two fact routes contribute nothing at all rather than failing
	// loudly. See `fuz_forge_in_process_setup`.
	setup_test: fuz_forge_in_process_setup,
	param_values: fuz_forge_param_values
});

// No SSE or WS suites here. Realtime rides the WebSocket endpoint, and both it
// and the one remaining SSE surface (the audit-log stream) are driven
// cross-process: the shared SSE and WS suites in
// `cross_backend/spine_suites.cross.test.ts`, and the forge's own
// `cross_backend/{ws_envelope,ws_cancel,ws_role_gate,ws_scoped_token,repo_updated_ws}.cross.test.ts`
// for the socket.

// --- fuz_forge-specific smoke tests ---
//
// Each describe block creates one TestApp in beforeAll (shares the Hono app +
// deps across tests) and re-bootstraps the account(s) it needs in beforeEach,
// because describe_db truncates the auth tables before every test.

describe_db('fuz_forge-specific routes', (get_db) => {
	describe('server status', () => {
		let test_app: TestApp;
		let authed: TestAccount;

		beforeAll(async () => {
			test_app = await create_fuz_forge_test_app(get_db);
		});

		beforeEach(async () => {
			authed = await test_app.create_account({});
		});

		test('GET /api/server/status returns server info', async () => {
			const res = await test_app.app.request('/api/server/status', {
				headers: authed.create_session_headers()
			});
			assert.strictEqual(res.status, 200);
			await assert_response_matches_spec(test_app.route_specs, 'GET', '/api/server/status', res);
			const body = await res.json();
			assert.strictEqual(body.version, '0.0.0-test');
			assert.strictEqual(body.uptime_ms, 42);
		});
	});

	describe('fuz_forge files', () => {
		let test_app: TestApp;
		let admin: TestAccount;

		beforeAll(async () => {
			test_app = await create_fuz_forge_test_app(get_db);
		});

		beforeEach(async () => {
			admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
		});

		test('GET /api/fuz_forge/files returns empty list on fresh DB (not SPA fallback)', async () => {
			const res = await test_app.app.request('/api/fuz_forge/files', {
				headers: admin.create_session_headers()
			});
			assert.strictEqual(res.status, 200);
			await assert_response_matches_spec(test_app.route_specs, 'GET', '/api/fuz_forge/files', res);
			const body = await res.json();
			assert.deepStrictEqual(body.files, []);
		});
	});
});
