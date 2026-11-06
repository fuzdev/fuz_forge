/**
 * Shared stubs and builders for auth attack surface tests and gen file.
 *
 * Used by both `auth_attack_surface.gen.json.ts` (snapshot generation)
 * and `auth_attack_surface.test.ts` (adversarial HTTP tests).
 *
 * @module
 */

import type { EventSpec } from '@fuzdev/fuz_app/realtime/sse.ts';
import { create_test_app_surface_spec, stub } from '@fuzdev/fuz_app/testing/stubs.ts';
import type { AppSurfaceSpec } from '@fuzdev/fuz_app/http/surface.ts';
import { resolve_fixture_path } from '@fuzdev/fuz_app/testing/assertions.ts';
import { parse_allowed_origins } from '@fuzdev/fuz_app/http/origin.ts';
import { ConnectionRegistry } from '@fuzdev/fuz_app/actions/connection_registry.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { AsyncSemaphore } from '@fuzdev/fuz_util/async.ts';

import { fuz_forge_session_config } from '#lib/server/routes/account.ts';
import {
	FUZ_FORGE_ORIGIN_CARVE_OUTS,
	generic_body_cap_middleware
} from '#lib/server/app_assembly.ts';
import { extend_middleware_for_fuz_forge } from '#lib/server/fuz_forge_token_policy_middleware.ts';
import {
	build_rpc_endpoint_specs,
	build_ws_endpoint_specs,
	create_fuz_forge_app_route_specs
} from '#lib/server/routes/fuz_forge_route_specs.ts';

import { test_audit_sse_deps, test_facts_dir } from './fuz_forge_test_helpers.ts';

/**
 * No-op stand-in for the scoped-token middleware on the snapshot path.
 * The attack-surface snapshot test exercises route SHAPE (paths,
 * methods, declared auth), not middleware behavior — wiring the real
 * policy middleware would require a live DB, which the snapshot
 * doesn't have.
 */
const passthrough_middleware = async (_c: unknown, next: () => Promise<void>): Promise<void> => {
	await next();
};

/** Stub fuz_forge route deps shared by route and surface generation. */
const fuz_forge_stub_deps = {
	runtime: stub,
	query_deps: stub,
	// The snapshot inspects route shape, not handler behavior; the seed host
	// policy never runs here.
	seed_from_allow_private_hosts: false,
	log: new Logger('test')
};

/**
 * fuz_forge SSE event specs.
 *
 * Kept empty during the WebSocket migration — `/api/fuz_forge/subscribe` and
 * `/api/fuz_forge/apply` SSE routes were removed; the remaining notification
 * schemas (`fuz_forge_run_created`, `fuz_forge_run_updated`, `fuz_forge_apply_progress`) travel
 * over WS via the broadcast API / `ctx.notify`, so they no longer feed the
 * SSE event registry. The `audit_log_sse: true` path retains its own
 * internally-wired event specs from fuz_app.
 */
export const fuz_forge_event_specs: Array<EventSpec> = [];

/**
 * Bootstrap config for surface generation — production wires bootstrap (live
 * when `BOOTSTRAP_TOKEN_PATH` is set), so the snapshot must include
 * `/api/account/bootstrap`. `surface_only` mounts the route shape without
 * the live-execution `token_path` — the snapshot inspects route shape, not
 * handler behavior.
 */
const fuz_forge_bootstrap_config = { mode: 'surface_only' } as const;

/**
 * Origin allowlist for surface generation — the `FUZ_ALLOWED_ORIGINS` example
 * the env loader prints. Production reads the operator's value; the
 * `/api/ws` entry records whatever list the server was given, so the snapshot
 * pins the shape (the endpoint inherits the server's list), not a deployment.
 */
const parsed_surface_allowed_origins = parse_allowed_origins('http://localhost:*');
if (!parsed_surface_allowed_origins.ok) throw new Error('surface origin allowlist must parse');
const fuz_forge_surface_allowed_origins = parsed_surface_allowed_origins.origins;

/** Build the full app surface bundle from route and middleware specs. */
export const create_fuz_forge_app_surface_spec = (): AppSurfaceSpec =>
	create_test_app_surface_spec({
		session_options: fuz_forge_session_config,
		bootstrap: fuz_forge_bootstrap_config,
		create_route_specs: (ctx) =>
			create_fuz_forge_app_route_specs(ctx, {
				fuz_forge: fuz_forge_stub_deps,
				files: {
					query_deps: stub,
					max_upload_bytes: 800 * 1024 * 1024,
					fact_store: stub,
					disk_root: undefined,
					free_space_margin_bytes: 0,
					upload_semaphore: new AsyncSemaphore(Infinity),
					log: new Logger('test')
				},
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
				facts_dir: test_facts_dir(),
				// Production threads `require_audit_sse(ctx)` here, mounting
				// `GET /api/admin/audit/stream`. The field is required so this
				// surface can never silently lose a route by omission — which it
				// did, hiding the one admin route gated by a declared
				// `required_scope` from both this snapshot and the token census.
				audit_sse: test_audit_sse_deps()
			}),
		rpc_endpoints: (ctx) =>
			build_rpc_endpoint_specs(ctx, {
				fuz_forge_deps: fuz_forge_stub_deps,
				extra_actions: [],
				notification_sender: null,
				final_actions_factory: null
			}),
		ws_endpoints: build_ws_endpoint_specs(new ConnectionRegistry()),
		allowed_origins: fuz_forge_surface_allowed_origins,
		origin_carve_outs: [...FUZ_FORGE_ORIGIN_CARVE_OUTS],
		event_specs: fuz_forge_event_specs,
		// Both test binaries this spec is probed against mount the daemon-token
		// layer — the TS server through `create_testing_wiring`'s
		// `daemon_token_state`, `testing_fuzfd` through
		// `RunAppOptions::daemon_token_state` — so the surface lists it.
		// Production mounts none on either backend.
		// `GET /api/surface` stays at its default, off: neither backend serves it.
		daemon_token: true,
		// the forge mounts no global body limit, as `create_app` passes
		// `max_body_size: null`: its generic cap is a middleware of its own,
		// first in the chain, carved out of the file store and git smart-HTTP
		max_body_size: null,
		transform_middleware: (api_middleware) => [
			generic_body_cap_middleware(),
			...extend_middleware_for_fuz_forge(api_middleware, {
				fuz_forge_token_policy_middleware: passthrough_middleware as never
			})
		]
	});

/** Resolve an absolute path relative to this file's directory. */
export const resolve_fuz_forge_fixture_path = (filename: string): string =>
	resolve_fixture_path(filename, import.meta.url);
