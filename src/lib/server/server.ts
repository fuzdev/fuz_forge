/**
 * Runtime-agnostic Hono app factory for fuz_forge.
 *
 * This module creates the core Hono application without any runtime-specific code.
 * The entry (`server/server_main.ts`) and the cross-process test binaries
 * (over `server/testing_server_build.ts`) import this and provide:
 * - the `RuntimeDeps` implementation
 * - serve_static middleware (from @hono/node-server, or @hono/bun)
 * - the WebSocket upgrade factory (`createNodeWebSocket` from @hono/node-ws
 *   over the assembled app)
 * - the HTTP server (@hono/node-server, or `Bun.serve`)
 *
 * Architecture:
 * - Frontend: SvelteKit build output (prerendered HTML/CSS/JS in `./build/`)
 * - Backend: This Hono app (routes, middleware, database)
 * - Static: Served by runtime-specific serve_static middleware
 *
 * `create_app` is a thin orchestrator; the cohesive setup stages it sequences
 * live in `server/app_assembly.ts`, and the subprocess primitives in
 * `server/subprocess.ts`.
 *
 * Routes are defined as data via the route spec system (fuz_app/routes/route_spec).
 * The attack surface is generated from the specs — always accurate, always complete.
 *
 * @module
 */

import { type Context, type Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { Db } from '@fuzdev/fuz_app/db/db.ts';
import { type ServeStaticFactory } from '@fuzdev/fuz_app/server/static.ts';
import type { AppSurface } from '@fuzdev/fuz_app/http/surface.ts';
import { argon2_password_deps } from '@fuzdev/fuz_app/auth/password_argon2.ts';
import type { PasswordHashDeps } from '@fuzdev/fuz_app/auth/password.ts';
import { create_app_server, require_audit_sse } from '@fuzdev/fuz_app/server/app_server.ts';
import { create_app_backend } from '@fuzdev/fuz_app/server/app_backend.ts';
import type { DaemonTokenState } from '@fuzdev/fuz_app/auth/daemon_token.ts';
import type { SessionOptions } from '@fuzdev/fuz_app/auth/session_cookie.ts';
import type { AppDeps } from '@fuzdev/fuz_app/auth/deps.ts';
import type { RpcAction } from '@fuzdev/fuz_app/actions/action_types.ts';
import { create_audit_emitter } from '@fuzdev/fuz_app/auth/audit_emitter.ts';
import { create_audit_log_config } from '@fuzdev/fuz_app/auth/audit_log_schema.ts';
import { cell_audit_events } from '@fuzdev/fuz_app/auth/cell_audit_events.ts';
import type { RuntimeDeps } from '@fuzdev/fuz_app/runtime/deps.ts';

import { ServerEnv } from './env/schema.ts';
import { fuz_forge_session_config } from './routes/account.ts';
import { init_fuz_forge_schema } from './db/fuz_forge_schema.ts';
import {
	create_fuz_forge_app_route_specs,
	build_rpc_endpoint_specs,
	build_ws_endpoint_specs
} from './routes/fuz_forge_route_specs.ts';
import { VERSION } from '../fuz_forge/build_info.ts';
import {
	create_fuz_forge_token_policy_middleware,
	extend_middleware_for_fuz_forge
} from './fuz_forge_token_policy_middleware.ts';
import type { SpawnStreaming, SpawnCollect } from './subprocess.ts';
import {
	resolve_server_config,
	create_ws_messaging,
	create_fact_store,
	create_testing_wiring,
	generic_body_cap_middleware,
	FUZ_FORGE_ORIGIN_CARVE_OUTS,
	type FinalRpcActionsFactory
} from './app_assembly.ts';

/**
 * Dependencies for creating the Hono app.
 *
 * Runtime adapters provide these based on the target runtime.
 */
export interface ServerDeps {
	/** RuntimeDeps for runtime operations (env, fs, etc). */
	runtime: RuntimeDeps;
	/** Runtime-specific static file middleware factory. */
	serve_static: ServeStaticFactory;
	/** Extract the raw TCP connection IP from the Hono context. Adapter-specific. */
	get_connection_ip: (c: Context) => string | undefined;
	/**
	 * Builds the runtime's Hono WebSocket upgrade helper from the assembled
	 * app — passed through to `create_app_server`, which mounts `/api/ws`
	 * (`build_ws_endpoint_specs`) with it. On Node the entry creates
	 * `@hono/node-ws`'s helper from the app and injects it into the server
	 * after `serve()`. Required: every
	 * entry serves realtime, as the Rust twin always mounts its WS route.
	 */
	create_upgrade_websocket: (app: Hono) => UpgradeWebSocket;
	/**
	 * Streaming subprocess primitive. Required for the forge smart-HTTP
	 * routes; omit to run without forge push/fetch support (the routes
	 * 503 if the primitive isn't wired).
	 */
	spawn_streaming?: SpawnStreaming;
	/**
	 * Buffered subprocess primitive. Required by every forge repo action
	 * that shells out to git — the five subprocess reads and all three
	 * mutations. Omit to run without them; those handlers 503 and every
	 * create fails before touching disk. `FuzForgeRoutesDeps.spawn_collect`
	 * enumerates the actions and the two 503 wordings.
	 */
	spawn_collect?: SpawnCollect;
	/**
	 * Test-only assembly seams. **Production never sets this** — its presence
	 * switches `create_app` into the cross-process test posture: a fast stub
	 * password hasher, daemon-token rotation (so `_testing_reset` has a keeper
	 * credential channel), every rate limiter disabled unless a gate turns it
	 * on — `FUZ_LOGIN_RATE_LIMIT_ENABLED` the auth limiters,
	 * `FUZ_ACTION_RATE_LIMIT_ENABLED` (with an optional
	 * `FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS` cap) the action limiters, both set
	 * by the login-security cross projects — `await_pending_effects` on, a tracking
	 * audit emitter (`track_inflight`, so `_testing_drain_effects` awaits
	 * in-flight writes), and the injected `_testing_*` actions.
	 *
	 * Grouped into one labeled field (rather than flat optionals on `ServerDeps`)
	 * so the test boundary is unmistakable and the production deps above stay
	 * clean. The Rust backend segregates the same concerns at the crate
	 * boundary instead (`testing_fuz_forge_server` + `fuz_testing`), which is
	 * that language's idiom — these shapes deliberately do not mirror.
	 */
	testing?: ServerTestingOptions;
}

/**
 * Test-only knobs for `ServerDeps.testing`. `build_fuz_forge_testing_app`
 * (`server/testing_server_build.ts`) is the only caller — the shared core of
 * the Node and Bun cross-process test binaries.
 */
export interface ServerTestingOptions {
	/**
	 * Fast deterministic password hasher (e.g. `stub_password_deps`) so
	 * per-test bootstrap/login round-trips don't pay the Argon2 cost.
	 * Production uses `argon2_password_deps`.
	 */
	password: PasswordHashDeps;
	/**
	 * Where daemon-token rotation writes the rotated keeper token — the
	 * `_testing_reset` action gates on the daemon-token credential and the
	 * harness reads this file to authenticate the keeper channel. The test
	 * binary points it at `{backend_root}/run/daemon_token`.
	 */
	daemon_token_path: string;
	/**
	 * Factory for the `_testing_*` RPC actions, invoked after the backend is
	 * constructed so it can close over `deps`. The test binary returns
	 * fuz_app's `create_testing_actions` bundle with a `reset_state` callback
	 * truncating fuz_forge domain state.
	 */
	extra_rpc_actions_factory: (
		deps: AppDeps,
		options: {
			daemon_token_state: DaemonTokenState | null;
			session_options: SessionOptions<string>;
		}
	) => ReadonlyArray<RpcAction>;
	/**
	 * Factory for the `_testing_*` actions that must be built **from** the
	 * assembled mount rather than alongside it — `_testing_action_manifest`,
	 * which dumps the live method set and so has to see every action mounted
	 * above it. Both mounts (HTTP RPC + WS) call it with their own list, so
	 * each serves a manifest of itself. Twin of the Rust
	 * `RunAppOptions.final_action_specs_factory`.
	 */
	final_rpc_actions_factory: FinalRpcActionsFactory;
}

/**
 * Result of creating the app.
 */
export interface ServerApp {
	/** The configured Hono app. */
	app: Hono;
	/** Validated environment configuration. */
	env: ServerEnv;
	/** Database instance (for cleanup). */
	db: Db;
	/** Generated attack surface for testing and auditing. */
	surface: AppSurface;
	/**
	 * Graceful shutdown — ends the orphan-temp sweep and (when wired)
	 * daemon-token rotation, then closes the app server: it stops the auth
	 * cleanup schedule, closes every live WebSocket and audit stream, releases
	 * what assembly acquired (the rate limiters it built, the listeners it
	 * registered on the audit emitter, the members it added to the connection
	 * closer), and closes the DB pool; a sweep or cleanup
	 * pass in progress finishes first. Safe to call more than once: the sweep
	 * and rotation stops tolerate a repeat, and the app server's close is
	 * idempotent. The server entry (`server/server_main.ts`) calls it on
	 * SIGINT / SIGTERM, as the cross-process test binary does on shutdown —
	 * after the listener stops accepting connections and before awaiting its
	 * drain.
	 */
	close: () => Promise<void>;
}

/**
 * Create the Hono application.
 *
 * This is the main entry point for creating a runtime-agnostic server.
 * Called by the server entry (`server/server_main.ts`) and, through
 * `server/testing_server_build.ts`, the cross-process test binaries.
 *
 * The body is a thin call-list over the setup stages in
 * `server/app_assembly.ts`; the call order (config → messaging → backend →
 * schema → fact store → testing → assemble) is load-bearing.
 */
export const create_app = async (deps: ServerDeps): Promise<ServerApp> => {
	const {
		runtime,
		serve_static,
		get_connection_ip,
		create_upgrade_websocket,
		spawn_streaming,
		spawn_collect,
		testing
	} = deps;
	const password = testing?.password ?? argon2_password_deps;

	const { env, keyring, allowed_origins, allow_origin_wildcards, bootstrap_options } =
		resolve_server_config(runtime);

	const server_log = new Logger('server');
	const started_at = Date.now();

	const { connection_registry, broadcast_api } = create_ws_messaging(server_log);

	// Pre-init backend: runs auth migrations, returns deps with db.
	const backend = await create_app_backend({
		database_url: env.DATABASE_URL,
		keyring,
		password,
		read_secure_file: runtime.read_secure_file,
		delete_file: (p) => runtime.remove(p),
		log: server_log,
		// the pool checkout bounds — a failed checkout answers 503, audit pool
		// writes wait longer (inert on a `memory://` / `file://` database)
		db_checkout_timeout_ms: env.FUZ_DB_CHECKOUT_TIMEOUT_MS,
		db_audit_checkout_timeout_ms: env.FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS,
		// Register the cell-domain audit events so the mounted cell handlers'
		// `deps.audit.emit(...)` calls validate against a known event type.
		// Test mode tracks in-flight audit writes so `_testing_drain_effects`
		// awaits them, a real barrier for WS mutations, whose effects flush
		// after the reply. Production never tracks. Twin of the Rust test
		// binary's `audit_inflight_tracking: true` (`testing_fuz_forge_server`).
		audit_factory: ({ db, log }) =>
			create_audit_emitter({
				db,
				log,
				audit_log_config: create_audit_log_config({ extra_events: cell_audit_events }),
				track_inflight: testing !== undefined
			})
	});

	// Run fuz_forge-specific schema (file store, scoped-token policies, facts, cells).
	await init_fuz_forge_schema(backend.deps.db);

	const { fact_store, fact_store_path, upload_semaphore, stop_sweep } = await create_fact_store(
		runtime,
		env,
		backend.deps,
		server_log
	);

	const fuz_forge_route_deps = {
		runtime,
		query_deps: backend.deps,
		spawn_collect,
		seed_from_allow_private_hosts: env.FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS,
		log: backend.deps.log
	};

	const {
		rate_limiters,
		daemon_token_state,
		extra_rpc_actions,
		final_rpc_actions_factory,
		action_ip_rate_limiter,
		action_account_rate_limiter,
		await_pending_effects,
		stop: stop_testing
	} = await create_testing_wiring(testing, runtime, backend.deps, server_log);

	const {
		app,
		surface_spec,
		close: close_app_server
	} = await create_app_server({
		backend,
		audit_log_sse: true,
		// Schedule the spine's auth cleanup beside the server — a pass at
		// assembly, then one per interval: expired sessions deleted and the
		// sockets and audit streams they opened closed through
		// `backend.deps.connection_closer`, expired role-grant offers audited
		// once. `close_app_server` stops the schedule, waiting for a pass in
		// progress, before it closes the pool. On in every posture, the test
		// binary included, as the Rust twin's `run_app` schedules
		// `fuz_auth::spawn_auth_cleanup` (`runtime.rs` `upkeep_options`) for
		// `fuzfd` and `testing_fuzfd` alike.
		auth_cleanup: true,
		session_options: fuz_forge_session_config,
		allowed_origins,
		// the operator's `FUZ_ALLOW_ORIGIN_WILDCARDS` — without it a wildcard entry refuses to boot
		allow_origin_wildcards,
		// every path is origin-checked but `/internal/*`, as on the Rust stack
		origin_carve_outs: [...FUZ_FORGE_ORIGIN_CARVE_OUTS],
		// Disable the spine's *global* `bodyLimit` — it sits at `app.use('*')` and
		// would clip the streaming file route (and, for a chunked upload, buffer
		// the whole body into RAM to count it). The generic 1 MiB cap instead
		// covers every path but the file store and git smart-HTTP, through the
		// body-cap middleware in `transform_middleware` below, and those two
		// enforce their own caps in-handler. Mirrors the Rust forge: the
		// file-store + git groups own their caps; every other group and the
		// fallback keep the 1 MiB `DEFAULT_BODY_LIMIT_BYTES`.
		max_body_size: null,
		proxy: {
			trusted_proxies: ['127.0.0.1', '::1'],
			get_connection_ip
		},
		rate_limiters,
		// `undefined` in production — the spine defaults under `'enforced'`
		action_ip_rate_limiter,
		action_account_rate_limiter,
		daemon_token_state,
		// Await fire-and-forget effects before each HTTP response returns so a
		// mutation's audit emits are durable by response time. Test mode only.
		// WS replies don't wait on it — a socket message's effects flush after
		// its reply — so the barrier for those is `_testing_drain_effects`
		// awaiting the tracking emitter's in-flight writes (`audit_factory`
		// above).
		await_pending_effects,
		bootstrap: bootstrap_options,
		transform_middleware: (api_middleware) => [
			// Generic 1 MiB body cap over every path but the file store and git
			// smart-HTTP (they stream + enforce their own caps). Replaces the
			// disabled global `bodyLimit` so a >1 MiB POST to `/api/rpc`, a probe,
			// or an unrouted path still rejects with the canonical
			// `{error: payload_too_large}` 413. First in the chain so it fires
			// ahead of the origin check and auth, matching the spine's bodyLimit
			// order — and the Rust twin's cap-outside-origin layering, whose
			// stack fallback is capped and checked like any group, so an unrouted
			// path answers the same 413 / 403 on both backends
			// (`body_limit.cross.test.ts`, `origin_scope.cross.test.ts`).
			generic_body_cap_middleware(),
			...extend_middleware_for_fuz_forge(api_middleware, {
				fuz_forge_token_policy_middleware: create_fuz_forge_token_policy_middleware(
					backend.deps,
					server_log
				)
			})
		],
		create_route_specs: (ctx) =>
			create_fuz_forge_app_route_specs(ctx, {
				audit_sse: require_audit_sse(ctx),
				fuz_forge: fuz_forge_route_deps,
				files: {
					query_deps: backend.deps,
					max_upload_bytes: env.FUZ_FORGE_FILE_STORE_MAX_BYTES,
					fact_store,
					disk_root: fact_store_path,
					free_space_margin_bytes: env.FUZ_FORGE_FILE_STORE_FREE_SPACE_MARGIN_BYTES,
					upload_semaphore,
					log: server_log
				},
				repo_git: {
					runtime,
					query_deps: backend.deps,
					spawn_streaming,
					log: server_log
				},
				repo_internal: {
					query_deps: backend.deps,
					broadcast: broadcast_api,
					log: server_log,
					get_connection_ip
				},
				version: VERSION,
				get_uptime_ms: () => Date.now() - started_at,
				// The fact-serving routes stream external facts from the same disk
				// root the file store's `PgFactStore` writes into.
				facts_dir: fact_store_path
			}),
		rpc_endpoints: (ctx) =>
			build_rpc_endpoint_specs(ctx, {
				fuz_forge_deps: fuz_forge_route_deps,
				extra_actions: extra_rpc_actions,
				notification_sender: connection_registry,
				final_actions_factory: final_rpc_actions_factory
			}),
		// Mounted ahead of `post_route_middleware` and static serving, with the
		// server's action rate limiters (one budget per caller across both
		// transports) and `allowed_origins`, serving the `/api/rpc` action set
		// above — the testing server's extras included, matching the Rust
		// backend's single registry. `create_app_server` adds `connection_registry` to
		// `backend.deps.connection_closer` — so a revocation over HTTP RPC, REST,
		// or the socket itself closes the sockets opened here once its
		// transaction commits — and registers its revocation guard on that
		// closer, which repeats that close when the audit row is announced
		// (covering a revocation emitted by code holding no closer). Twin of the
		// Rust `router.rs` `register_revocation_guard`.
		ws_endpoints: build_ws_endpoint_specs(connection_registry),
		create_upgrade_websocket,
		env_schema: ServerEnv,
		env_values: env,
		static_serving: { serve_static, spa_fallback: '/200.html' },
		on_effect_error: (error, ctx) => {
			console.error(`[server] Pending effect failed (${ctx.method} ${ctx.path}):`, error);
		}
	});

	console.log(`[server] Database initialized (${backend.db_type}: ${backend.db_name})`);

	const close = async (): Promise<void> => {
		// ends the sweep schedule and waits for a pass in progress
		await stop_sweep();
		await stop_testing();
		await close_app_server();
	};

	return { app, env, db: backend.deps.db, surface: surface_spec.surface, close };
};
