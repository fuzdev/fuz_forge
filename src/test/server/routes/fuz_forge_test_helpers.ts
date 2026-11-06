/**
 * Shared test app factories for fuz_forge server tests.
 *
 * Wraps `create_test_app` from `@fuzdev/fuz_app/testing/app_server` with
 * `fuz_forge_session_config` + fuz_forge route/RPC factories already wired. Pinned route
 * factory uses real DB query deps so handlers can hit the test Postgres DB.
 *
 * @module
 */

import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import {
	create_test_app,
	type CreateTestAppOptions,
	type TestApp
} from '@fuzdev/fuz_app/testing/app_server.ts';
import type { AppServerContext } from '@fuzdev/fuz_app/server/app_server_context.ts';
import type { RouteSpec } from '@fuzdev/fuz_app/http/route_spec.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AuditLogRouteOptions } from '@fuzdev/fuz_app/auth/audit_log_routes.ts';
import { create_stub_audit_sse, stub } from '@fuzdev/fuz_app/testing/stubs.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { AsyncSemaphore } from '@fuzdev/fuz_util/async.ts';

import { fuz_forge_session_config } from '#lib/server/routes/account.ts';
import { FUZ_FORGE_ORIGIN_CARVE_OUTS } from '#lib/server/app_assembly.ts';
import type { FileRoutesDeps } from '#lib/server/routes/files.ts';
import {
	build_rpc_endpoint_specs,
	create_fuz_forge_app_route_specs
} from '#lib/server/routes/fuz_forge_route_specs.ts';

/**
 * Build `FileRoutesDeps` for tests, filling the disk-budget / concurrency
 * fields with test-safe defaults so callers only set what they exercise. No
 * `disk_root` (the free-space preflight no-ops without one), a wide-open
 * semaphore (`Infinity` permits — no contention), and a silent log. Pass
 * `disk_root` / `free_space_margin_bytes` to drive the `507 storage_full`
 * preflight, or a tighter semaphore to drive concurrency.
 */
export const test_file_route_deps = (
	overrides: Pick<FileRoutesDeps, 'query_deps' | 'max_upload_bytes' | 'fact_store'> &
		Partial<FileRoutesDeps>
): FileRoutesDeps => ({
	disk_root: undefined,
	free_space_margin_bytes: 0,
	upload_semaphore: new AsyncSemaphore(Infinity),
	log: new Logger('test'),
	...overrides
});

/**
 * Inert audit-SSE wiring: mounts `GET /api/admin/audit/stream` over a fresh
 * registry nothing broadcasts to, so a stream opened on it receives no audit
 * row.
 *
 * `create_fuz_forge_app_route_specs` requires `audit_sse` so a caller cannot
 * drop the route by omission — which is what happened to the attack-surface
 * snapshot, hiding the one admin route whose gate is a declared
 * `required_scope`. Tests that don't exercise the stream mount it anyway, so
 * every generated surface is the production surface.
 */
export const test_audit_sse_deps = (): NonNullable<AuditLogRouteOptions['stream']> => {
	const { registry, log } = create_stub_audit_sse();
	return { registry, log };
};

/**
 * Stand-in fact-store disk root for suites that mount the two fact-serving
 * routes without reading an external fact through them.
 *
 * `create_fuz_forge_app_route_specs` requires `facts_dir` so a caller cannot
 * drop the routes by omission (the same reason `audit_sse` is required). Only an
 * external (`file:<shard>/<rest>`) fact streams from this directory, and these
 * suites seed none — an embedded fact comes off the `fact.bytes` column.
 */
export const test_facts_dir = (): string => join(tmpdir(), 'fuz_forge-test-facts');

/** Fields callers may override on the fuz_forge test app. */
export type FuzForgeTestAppOverrides = Partial<
	Omit<CreateTestAppOptions, 'session_options' | 'create_route_specs' | 'db'>
>;

/**
 * Route factory for fuz_forge-specific tests (real DB queries).
 *
 * Passes `query_deps` from the app server's DB so route handlers can
 * execute real SQL against the test Postgres DB.
 */
const create_fuz_forge_db_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_fuz_forge_app_route_specs(ctx, {
		audit_sse: test_audit_sse_deps(),
		fuz_forge: {
			runtime: stub,
			query_deps: { db: ctx.deps.db },
			// Loopback seeds: the in-process suites that drive `seed_from` point
			// at a local upstream server, which the default host policy refuses.
			seed_from_allow_private_hosts: true,
			log: new Logger('test')
		},
		files: test_file_route_deps({
			query_deps: { db: ctx.deps.db },
			max_upload_bytes: 800 * 1024 * 1024,
			fact_store: stub
		}),
		repo_git: {
			runtime: stub,
			query_deps: { db: ctx.deps.db },
			spawn_streaming: undefined,
			log: new Logger('test')
		},
		repo_internal: {
			query_deps: { db: ctx.deps.db },
			broadcast: stub,
			log: new Logger('test'),
			get_connection_ip: () => '127.0.0.1'
		},
		version: '0.0.0-test',
		get_uptime_ms: () => 42,
		facts_dir: test_facts_dir()
	});

/**
 * Create a fuz_forge test app bound to the given database.
 *
 * `session_options` and `create_route_specs` are pinned to the canonical
 * fuz_forge wiring with real DB query deps — overrides cover roles, password
 * deps, app_options, etc.
 */
export const create_fuz_forge_test_app = (
	get_db: () => Db,
	overrides?: FuzForgeTestAppOverrides
): Promise<TestApp> =>
	create_test_app({
		session_options: fuz_forge_session_config,
		create_route_specs: create_fuz_forge_db_route_specs,
		db: get_db(),
		...overrides,
		// production's carve-outs, under whatever else a suite overrides
		app_options: { origin_carve_outs: [...FUZ_FORGE_ORIGIN_CARVE_OUTS], ...overrides?.app_options }
	});

/**
 * Create a fuz_forge test app with the RPC surface mounted and the bootstrapped
 * account holding `keeper` + `admin` roles.
 *
 * Use for tests that exercise admin-only RPC methods (audit log reads,
 * role grant create/revoke, account listing). Additional accounts created via
 * `test_app.create_account()` default to no roles.
 */
export const create_fuz_forge_admin_test_app = (
	get_db: () => Db,
	overrides?: FuzForgeTestAppOverrides
): Promise<TestApp> =>
	create_fuz_forge_test_app(get_db, {
		roles: [ROLE_KEEPER, ROLE_ADMIN],
		rpc_endpoints: (ctx) =>
			build_rpc_endpoint_specs(ctx, {
				fuz_forge_deps: {
					runtime: stub,
					query_deps: { db: ctx.deps.db },
					seed_from_allow_private_hosts: true,
					log: new Logger('test')
				},
				extra_actions: [],
				notification_sender: null,
				final_actions_factory: null
			}),
		...overrides
	});
