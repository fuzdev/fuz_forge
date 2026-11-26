/**
 * Integration tests of the in-process app.
 *
 * Mounts the fuz_app cross-backend suites (standard integration and its
 * middleware-gate probes, admin integration, rate limiting, route + RPC
 * round-trip, data exposure) plus fuz_forge-specific smoke tests in separate
 * describe blocks. Suite options use the
 * `default_in_process_suite_options(...)` consolidation helper for the shared
 * `{setup_test, surface_source, capabilities}` triple, whose bootstrapped
 * keeper holds admin as a production bootstrap grants, so it can hit
 * admin-gated RPC methods. The two suites that drive the whole route set
 * (round-trip, data exposure) pass the helper the whole forge schema's
 * database and build the file-store routes on real deps, so every route
 * reaches its handler's queries. The RPC round-trip runs on the same schema
 * with real query deps, so every method it drives reaches its handler. The
 * attack-surface suites live in sibling files; SSE and WS are covered
 * cross-process, in `cross_backend/`.
 *
 * @module
 */

import { test, assert, describe, beforeEach } from 'vitest';
import { describe_standard_integration_tests } from '@fuzdev/fuz_app/testing/integration.ts';
import { describe_middleware_gate_tests } from '@fuzdev/fuz_app/testing/middleware_gate_probes.ts';
import { describe_standard_admin_integration_tests } from '@fuzdev/fuz_app/testing/admin_integration.ts';
import { describe_rate_limiting_tests } from '@fuzdev/fuz_app/testing/rate_limiting.ts';
import { describe_round_trip_validation } from '@fuzdev/fuz_app/testing/round_trip.ts';
import { describe_rpc_round_trip_tests } from '@fuzdev/fuz_app/testing/rpc_round_trip.ts';
import { describe_data_exposure_tests } from '@fuzdev/fuz_app/testing/data_exposure.ts';
import { default_in_process_suite_options } from '@fuzdev/fuz_app/testing/cross_backend/in_process_setup.ts';
import { ROLE_ADMIN, create_role_registry } from '@fuzdev/fuz_app/auth/role_schema.ts';
import type { TestApp, TestAccount } from '@fuzdev/fuz_app/testing/test_app.ts';
import type { RouteSpec } from '@fuzdev/fuz_app/http/route_spec.ts';
import type { AppServerContext } from '@fuzdev/fuz_app/server/app_server_context.ts';
import { stub } from '@fuzdev/fuz_app/testing/stubs.ts';
import { create_describe_db } from '@fuzdev/fuz_app/testing/describe_db.ts';
import { create_node_runtime } from '@fuzdev/fuz_app/runtime/node.ts';
import { PgFactStore } from '@fuzdev/fuz_app/db/fact_store.ts';
import { create_audit_emitter } from '@fuzdev/fuz_app/auth/audit_emitter.ts';
import { create_audit_log_config } from '@fuzdev/fuz_app/auth/audit_log_schema.ts';
import { cell_audit_events } from '@fuzdev/fuz_app/auth/cell_audit_events.ts';
import type { AuditFactory } from '@fuzdev/fuz_app/server/app_backend.ts';
import { assert_response_matches_spec } from '@fuzdev/fuz_app/testing/integration_helpers.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { FUZ_FORGE_SESSION_COOKIE_NAME } from '#lib/server/routes/account.ts';
import {
	build_rpc_endpoint_specs,
	create_fuz_forge_app_route_specs
} from '#lib/server/routes/fuz_forge_route_specs.ts';

import type { SpawnCollect } from '#lib/server/subprocess.ts';

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
			log: new Logger('test')
		},
		version: '',
		get_uptime_ms: () => 0,
		facts_dir: test_facts_dir()
	});

/**
 * Route factory for the suites that drive the whole route set to its handlers
 * (round-trip, data exposure): the stub factory's wiring, but the file-store
 * routes read the test database and a `PgFactStore` over it, so their handlers
 * answer from real queries instead of crashing on the stub.
 */
const create_fuz_forge_db_test_route_specs = (ctx: AppServerContext): Array<RouteSpec> => {
	const query_deps = { db: ctx.deps.db };
	const log = new Logger('test');
	return create_fuz_forge_app_route_specs(ctx, {
		audit_sse: test_audit_sse_deps(),
		fuz_forge: {
			runtime: stub,
			query_deps: stub,
			seed_from_allow_private_hosts: false,
			log
		},
		files: test_file_route_deps({
			query_deps,
			max_upload_bytes: 800 * 1024 * 1024,
			fact_store: new PgFactStore({
				deps: query_deps,
				disk_root: test_facts_dir(),
				fs: create_node_runtime([]),
				log
			})
		}),
		repo_git: {
			runtime: stub,
			query_deps: stub,
			spawn_streaming: undefined,
			log
		},
		repo_internal: {
			query_deps: stub,
			broadcast: stub,
			log
		},
		version: '',
		get_uptime_ms: () => 0,
		facts_dir: test_facts_dir()
	});
};

/**
 * Production's audit config (`server.ts`): the cell-domain events registered,
 * so the mounted cell handlers' audit rows validate against a known event type.
 */
const fuz_forge_audit_factory: AuditFactory = ({ db, log }) =>
	create_audit_emitter({
		db,
		log,
		audit_log_config: create_audit_log_config({ extra_events: cell_audit_events })
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
 * One fresh forge schema per describe, with no per-test truncate: the suites
 * below seed their accounts once, in `beforeAll`, and `describe_db`'s truncate
 * would wipe them before each case. Each describe's database is built by
 * `init_fuz_forge_schema`, the schema production runs: the auth, fact and cell
 * namespaces plus the direct-DDL token-policy table.
 *
 * The suites that drive every route or method run here, passing `get_db` and
 * production's audit config to `default_in_process_suite_options`. The two
 * fact-serving routes read the `fact` / `cell` tables, so against the
 * auth-only default fixture `GET /api/facts/:hash` and
 * `GET /api/cells/:cell_id/facts/:hash` answer a missing-relation 500 instead
 * of the route's own 404 — a failure in the round-trip validator, silently
 * skipped by the data-exposure suite, which reads only successes. Each of
 * these suites calls `setup_test` once, in its `beforeAll`, so each
 * describe's fresh database takes exactly one keeper bootstrap — the per-test
 * auth truncate fuz_app's `get_db` doc asks for applies to suites that set up
 * per test.
 */
const describe_forge_schema_db = create_describe_db(db_factories, []);

// --- Standard auth integration suite and its middleware-gate probes ---

const standard_integration_options = default_in_process_suite_options({
	session_cookie_name: FUZ_FORGE_SESSION_COOKIE_NAME,
	create_route_specs: create_fuz_forge_test_route_specs,
	rpc_endpoints: fuz_forge_rpc_endpoints,
	bootstrap: fuz_forge_bootstrap_config
});

describe_standard_integration_tests(standard_integration_options);

describe_middleware_gate_tests(standard_integration_options);

// --- Standard admin integration tests ---

describe_standard_admin_integration_tests({
	...default_in_process_suite_options({
		session_cookie_name: FUZ_FORGE_SESSION_COOKIE_NAME,
		create_route_specs: create_fuz_forge_test_route_specs,
		rpc_endpoints: fuz_forge_rpc_endpoints,
		bootstrap: fuz_forge_bootstrap_config
	}),
	roles: fuz_forge_roles
});

// --- Rate limiting tests ---

describe_rate_limiting_tests({
	...default_in_process_suite_options({
		session_cookie_name: FUZ_FORGE_SESSION_COOKIE_NAME,
		create_route_specs: create_fuz_forge_test_route_specs,
		rpc_endpoints: fuz_forge_rpc_endpoints,
		bootstrap: fuz_forge_bootstrap_config
	}),
	db_factories
});

// --- Round-trip validation ---

describe_forge_schema_db('round-trip on the forge schema', (get_db) => {
	describe_round_trip_validation({
		...default_in_process_suite_options({
			session_cookie_name: FUZ_FORGE_SESSION_COOKIE_NAME,
			create_route_specs: create_fuz_forge_db_test_route_specs,
			bootstrap: fuz_forge_bootstrap_config,
			get_db,
			audit_factory: fuz_forge_audit_factory
		}),
		// the `raw_body` file upload is skipped by the validator itself; the
		// delete has no acting-actor input path for the validator to supply, so
		// it answers `actor_required` — driven by fuz_forge's own file route tests
		skip_routes: ['DELETE /api/fuz_forge/files/:filename{.+}'],
		param_values: fuz_forge_param_values
	});
});

// --- RPC round-trip validation ---

/**
 * The round-trip's `spawn_collect`: it gets the repo actions past the spawn
 * guard to their cell lookup. The round-trip seeds no repo, so each answers
 * from that lookup and no git subprocess runs — one that did would fail here,
 * and its logged error would fail the test.
 */
const round_trip_spawn_collect: SpawnCollect = () =>
	Promise.reject(new Error('the RPC round-trip seeds no repo, so no git subprocess runs'));

/**
 * RPC endpoints over the real database, for the round-trip — it drives every
 * method to its handler, where the stub `query_deps` the other suites use would
 * throw (a 500, which the round-trip reads as a crash).
 */
const fuz_forge_db_rpc_endpoints = (ctx: AppServerContext) =>
	build_rpc_endpoint_specs(ctx, {
		fuz_forge_deps: {
			...fuz_forge_rpc_stub_deps,
			query_deps: { db: ctx.deps.db },
			spawn_collect: round_trip_spawn_collect
		},
		extra_actions: [],
		final_actions_factory: null
	});

describe_forge_schema_db('RPC round-trip on the forge schema', (get_db) => {
	describe_rpc_round_trip_tests({
		// The whole forge schema (`init_fuz_forge_schema`: the cell and fact
		// namespaces plus the direct-DDL token-policy table), real query deps and
		// a `spawn_collect`, so the repo, cell and token-policy reads reach their
		// handlers' queries, and production's audit config for the cell events.
		...default_in_process_suite_options({
			session_cookie_name: FUZ_FORGE_SESSION_COOKIE_NAME,
			create_route_specs: create_fuz_forge_test_route_specs,
			rpc_endpoints: fuz_forge_db_rpc_endpoints,
			bootstrap: fuz_forge_bootstrap_config,
			get_db,
			audit_factory: fuz_forge_audit_factory
		}),
		// `fuz_forge_repo_create` is side-effecting (real `git init` + disk +
		// hook install) and its `slug` needs a two-segment `org/repo` shape the
		// generator can't synthesize. Covered by `fuz_forge_repo_create_rpc.db.test.ts`.
		skip_methods: ['fuz_forge_repo_create']
	});
});

// --- Data exposure tests ---

describe_forge_schema_db('data exposure on the forge schema', (get_db) => {
	describe_data_exposure_tests({
		...default_in_process_suite_options({
			session_cookie_name: FUZ_FORGE_SESSION_COOKIE_NAME,
			create_route_specs: create_fuz_forge_db_test_route_specs,
			bootstrap: fuz_forge_bootstrap_config,
			get_db,
			audit_factory: fuz_forge_audit_factory
		}),
		param_values: fuz_forge_param_values
	});
});

// No SSE or WS suites here. Realtime rides the WebSocket endpoint, and both it
// and the one remaining SSE surface (the audit-log stream) are driven
// cross-process: the shared SSE and WS suites in
// `cross_backend/spine_suites.cross.test.ts`, and the forge's own
// `cross_backend/{ws_envelope,ws_cancel,ws_role_gate,ws_scoped_token,repo_updated_ws}.cross.test.ts`
// for the socket.

// --- fuz_forge-specific smoke tests ---
//
// Each describe block builds its TestApp and the account(s) it needs in
// beforeEach, after describe_db's per-test truncate, so every test starts from
// a freshly bootstrapped keeper and is invariant-checked by `create_test_app`.

describe_db('fuz_forge-specific routes', (get_db) => {
	describe('server status', () => {
		let test_app: TestApp;
		let authed: TestAccount;

		beforeEach(async () => {
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

		beforeEach(async () => {
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
