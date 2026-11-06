/**
 * Setup helpers for the fuz_forge `create_app` factory.
 *
 * `create_app` (`server/server.ts`) is the orchestrator; the cohesive setup
 * stages it sequences live here so each is independently readable and the
 * factory body stays a thin call-list. The split mirrors the Rust backend,
 * which already layers the same concerns across modules:
 *
 * - `resolve_server_config` — env load + validate + keyring/origins +
 *   bootstrap options (Rust: `env.rs` `FuzForgeEnv` over the spine's
 *   `BaseServerEnv`; the spine's `create_app_backend` builds the keyring).
 * - `create_ws_messaging` — WS connection registry + broadcast API
 *   (Rust: `broadcasts.rs` over the `ConnectionRegistry`).
 * - `create_fact_store` — fact-store disk root + `PgFactStore` + upload
 *   semaphore + orphan-temp sweeper (Rust: `fact_store.rs` `FactStoreHandle` +
 *   `fuz_fact::spawn_orphan_temp_sweeper`, run from `runtime.rs`
 *   `upkeep_options`).
 * - `create_testing_wiring` — the test-only daemon-token rotation +
 *   injected actions + rate-limiter gates (Rust: the
 *   `testing_fuz_forge_server` crate boundary).
 *
 * @module
 */

import { dirname } from 'node:path';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { AsyncSemaphore } from '@fuzdev/fuz_util/async.ts';
import { parse } from '@fuzdev/fuz_schema/schema.ts';
import { validate_server_env } from '@fuzdev/fuz_app/server/env.ts';
import { EnvStringbool } from '@fuzdev/fuz_app/env/env_schemas.ts';
import type { BootstrapServerOptions } from '@fuzdev/fuz_app/server/app_server.ts';
import {
	default_action_account_rate_limit,
	default_action_ip_rate_limit,
	RateLimiter,
	type RateLimiterMode,
	type RateLimiterOptions
} from '@fuzdev/fuz_app/rate_limiter.ts';
import type { DaemonTokenState } from '@fuzdev/fuz_app/auth/daemon_token.ts';
import type { DaemonTokenRotation } from '@fuzdev/fuz_app/testing/daemon_token_rotation.ts';
import type { AppDeps } from '@fuzdev/fuz_app/auth/deps.ts';
import type { RpcAction } from '@fuzdev/fuz_app/actions/action_types.ts';
import { ConnectionRegistry } from '@fuzdev/fuz_app/actions/connection_registry.ts';
import type { EnvDeps, RuntimeDeps } from '@fuzdev/fuz_app/runtime/deps.ts';
import { PgFactStore } from '@fuzdev/fuz_app/db/fact_store.ts';
import { sweep_orphan_temps } from '@fuzdev/fuz_app/db/fact_disk_storage.ts';
import { start_periodic } from '@fuzdev/fuz_app/periodic.ts';
import { create_body_limit_middleware } from '@fuzdev/fuz_app/http/body_limit.ts';
import type { MiddlewareCarveOut, MiddlewareSpec } from '@fuzdev/fuz_app/http/middleware_spec.ts';

import { fuz_forge_home, resolve_tilde } from '../runtime/path.ts';
import type { ServerEnv } from './env/schema.ts';
import { load_env } from './env/load.ts';
import { fuz_forge_session_config } from './routes/account.ts';
import { create_backend_actions_api } from './backend_actions_api.ts';
// Type-only — `server.ts` imports the values back, so this edge is erased at
// runtime (no module cycle).
import type { ServerTestingOptions } from './server.ts';

/**
 * Interval (1 hour) between orphan-temp sweeps of the fact-store `.tmp/`
 * dir, start to start. The startup pass + this interval reap `.tmp/*` files
 * left by a hard crash mid-stream; the per-file age threshold
 * (`FACT_TMP_ORPHAN_MAX_AGE_MS`) spares in-flight uploads. Mirrors the Rust
 * `fuz_fact::ORPHAN_TEMP_SWEEP_INTERVAL`.
 */
const FACT_TMP_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Generic 1 MiB body cap for every capped route group, matching the spine's
 * `DEFAULT_BODY_LIMIT_BYTES`. Matches the Rust forge, whose `api`, `internal` and
 * `probes` groups and its fallback carry the 1 MiB `DEFAULT_BODY_LIMIT_BYTES`;
 * the file-store + git groups own their caps on either backend.
 */
const GENERIC_BODY_CAP_BYTES = 1024 * 1024;

/**
 * Mount prefix of the file-store routes — exempt from the generic body cap (they
 * stream + enforce `FUZ_FORGE_FILE_STORE_MAX_BYTES` in-handler). Must match the
 * mount prefix in `routes/fuz_forge_route_specs.ts`; matched as the prefix
 * itself or a non-empty path under it, as the Rust `nest` routes them (`/` and
 * the `/{*filename}` catch-all, which matches no empty tail — so the prefix
 * with a bare trailing slash reaches the capped fallback there, and is capped
 * here too).
 */
const FILE_STORE_PATH_PREFIX = '/api/fuz_forge/files';

/**
 * The git smart-HTTP route shapes — exempt from the generic body cap (`git
 * http-backend` owns pack limits, and a pack routinely exceeds 1 MiB). The
 * twin of the Rust `git` group's three routes (`/{org}/{repo}/info/refs`,
 * `/{org}/{repo}/git-upload-pack`, `/{org}/{repo}/git-receive-pack`): exactly
 * two segments ahead of the git suffix, so a path the Rust router sends to
 * the capped fallback is capped here too.
 */
const GIT_SMART_HTTP_PATH = /^\/[^/]+\/[^/]+\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;

/**
 * Whether a request path falls in a capped route group: every path but the
 * file store and git smart-HTTP — the `/api` and `/internal` surfaces, the
 * probes (`/health`, `/`, `/ready`), the static SPA and every unrouted path,
 * exactly as the Rust stack caps all of its groups but `files` and `git`.
 */
const is_generic_body_cap_path = (path: string): boolean =>
	!(
		path === FILE_STORE_PATH_PREFIX ||
		(path.startsWith(`${FILE_STORE_PATH_PREFIX}/`) &&
			path.length > FILE_STORE_PATH_PREFIX.length + 1)
	) && !GIT_SMART_HTTP_PATH.test(path);

/**
 * Build the generic body-cap middleware spec. Mounted at `*` and gated
 * in-handler on `is_generic_body_cap_path`: a `MiddlewareSpec` carries a
 * single path, so one middleware covers every capped group and passes the two
 * handler-owned ones through. Inside a capped group it is fuz_app's
 * `create_body_limit_middleware` at 1 MiB — the cap `create_app_server` would
 * mount globally, which the forge disables (`max_body_size: null`) so the
 * file store can stream:
 *
 * - a `Content-Length` over the cap answers the canonical
 *   `{error: payload_too_large}` 413 on the header alone, with
 *   `Connection: close`;
 * - a `Content-Length` that is not a plain run of ASCII digits answers 400
 *   `{error: invalid_content_length}` — a length that does not parse cannot
 *   be capped, so it is refused rather than passed on uncounted;
 * - a body with no `Content-Length`, or one beside `Transfer-Encoding`, is
 *   buffered and counted, up to the cap, before any handler runs, and refused
 *   past it.
 *
 * First in the chain, so the cap fires ahead of the origin check and the auth
 * middleware — an over-cap request carrying a disallowed `Origin` answers 413,
 * not 403. The Rust twin reaches the same order through `fuz_http::compose_stack`,
 * which mounts each group's cap outside its origin check (`router/compose.rs`). The Rust server's HTTP
 * parser (hyper) refuses a malformed `Content-Length` before the router sees
 * the request, so the 400 here covers what a JS runtime's parser lets through.
 * One case differs across the twins: a repeated `Content-Length` with equal
 * values answers 400 here (Deno hands it over as `5, 5`) and is accepted as the
 * one value by hyper.
 */
export const generic_body_cap_middleware = (): MiddlewareSpec => {
	const body_limit = create_body_limit_middleware(GENERIC_BODY_CAP_BYTES);
	return {
		name: 'generic_body_cap',
		path: '*',
		// the handler-owned groups (file store, git smart-HTTP) pass straight
		// through — they stream + cap in-handler
		handler: (c, next) => (is_generic_body_cap_path(c.req.path) ? body_limit(c, next) : next())
	};
};

/**
 * The forge's origin carve-outs — the paths fuz_app's every-path origin check
 * skips. The twin of the Rust stack's one carved-out group, `internal`
 * (`router/compose.rs`): the loopback-only hook callbacks refuse any `Origin`
 * or `Referer` in-handler, on top of a loopback peer check and a per-repo
 * secret, and answer every refusal with one bare `401`, so a browser replay
 * learns nothing about which fence it hit. Shared by `create_app`, the
 * in-process test app, and the attack-surface spec, so the three cannot drift.
 */
export const FUZ_FORGE_ORIGIN_CARVE_OUTS: ReadonlyArray<MiddlewareCarveOut> = [
	{
		path: '/internal/*',
		reason: 'loopback-only hook callbacks; refuse any Origin/Referer in-handler'
	}
];

/** The validated (`ok: true`) branch of `validate_server_env`. */
type ValidatedServerEnv = Extract<ReturnType<typeof validate_server_env>, { ok: true }>;

/** Resolved, validated configuration the app factory needs before assembly. */
export interface ServerConfig {
	env: ServerEnv;
	keyring: ValidatedServerEnv['keyring'];
	allowed_origins: ValidatedServerEnv['allowed_origins'];
	/** `FUZ_ALLOW_ORIGIN_WILDCARDS=true` — admits a wildcard `allowed_origins` entry. */
	allow_origin_wildcards: ValidatedServerEnv['allow_origin_wildcards'];
	bootstrap_options: BootstrapServerOptions;
}

/**
 * Load + validate the server env, then derive the keyring, allowed origins, the
 * origin-wildcard opt-in, and bootstrap options. Exits the process (via
 * `runtime.exit`) on an invalid env — a misconfigured deploy must fail loud,
 * never boot with a degraded keyring.
 *
 * Twin of the Rust `FuzForgeEnv::from_process` plus the keyring the spine's
 * `create_app_backend` builds.
 */
export const resolve_server_config = (runtime: RuntimeDeps): ServerConfig => {
	const env = load_env(runtime);

	// Validate keyring, parse origins, resolve bootstrap path.
	const env_config = validate_server_env(env);
	if (!env_config.ok) {
		console.error(`[server] ERROR: Invalid ${env_config.field}:`);
		for (const err of env_config.errors) console.error(`[server]   ${err}`);
		if (env_config.field === 'SECRET_FUZ_COOKIE_KEYS') {
			console.error('[server] Generate with: openssl rand -hex 32');
		}
		runtime.exit(1);
		throw new Error('unreachable'); // satisfy type checker after exit
	}
	const { keyring, allowed_origins, allow_origin_wildcards } = env_config;
	console.log('[server] Cookie signing keyring initialized');
	console.log(`[server] Origin verification enabled: ${allowed_origins.length} pattern(s)`);

	// Bootstrap token path (tilde expansion is fuz_forge-specific). Conditionally
	// construct `bootstrap` so an unset env var lands on `{mode: 'disabled'}`
	// — a conscious deployment decision rather than a permanently-403 route
	// in the surface.
	const bootstrap_token_path = env_config.bootstrap_token_path
		? resolve_tilde(env_config.bootstrap_token_path, runtime.env_get('HOME'))
		: null;
	const bootstrap_options: BootstrapServerOptions = bootstrap_token_path
		? { mode: 'live', token_path: bootstrap_token_path }
		: { mode: 'disabled' };

	return { env, keyring, allowed_origins, allow_origin_wildcards, bootstrap_options };
};

/** The WebSocket connection registry and broadcast API. */
export interface WsMessaging {
	connection_registry: ConnectionRegistry;
	broadcast_api: ReturnType<typeof create_backend_actions_api>;
}

/**
 * Compose the WebSocket messaging stack: the connection registry and the
 * broadcast API over it. The registry is created ahead of assembly because
 * three holders need the one instance — the broadcast API, the role-grant-offer
 * `notification_sender` of the RPC action set (which `/api/ws` serves too), and
 * the `/api/ws` endpoint itself (`build_ws_endpoint_specs` passes it as
 * `WsEndpointSpec.registry`).
 *
 * Socket revocation is not wired here: `create_app_server` adds the mounted
 * registry to `AppDeps.connection_closer`, and registers its one revocation
 * guard (`create_revocation_guard`) on that closer.
 */
export const create_ws_messaging = (log: Logger): WsMessaging => {
	const connection_registry = new ConnectionRegistry();
	const broadcast_api = create_backend_actions_api({ registry: connection_registry, log });
	return { connection_registry, broadcast_api };
};

/** The fact store, its disk root, the upload semaphore, and the sweep stopper. */
export interface FactStoreBundle {
	fact_store: PgFactStore;
	fact_store_path: string;
	upload_semaphore: AsyncSemaphore;
	/**
	 * Ends the orphan-temp sweep schedule and resolves once a pass in progress
	 * has finished; never rejects. Composed into the app's `close()`.
	 */
	stop_sweep: () => Promise<void>;
}

/**
 * Resolve + prepare the fact-store disk root, construct the `PgFactStore`, the
 * upload-concurrency semaphore, and start the orphan-temp sweeper (a pass at
 * boot, then one per interval, on fuz_app's `start_periodic` loop). The eager
 * `mkdir` surfaces permission / mount issues at boot rather than on first
 * oversize upload.
 *
 * Twin of the Rust `fact_store.rs` `FactStoreHandle::new` +
 * `fuz_fact::spawn_orphan_temp_sweeper` (run from `runtime.rs` `upkeep_options`).
 */
export const create_fact_store = async (
	runtime: RuntimeDeps,
	env: ServerEnv,
	deps: AppDeps,
	log: Logger
): Promise<FactStoreBundle> => {
	const fact_store_path = env.FUZ_FORGE_FACT_STORE_PATH
		? resolve_tilde(env.FUZ_FORGE_FACT_STORE_PATH, runtime.env_get('HOME'))
		: `${fuz_forge_home(runtime)}/facts`;
	await runtime.mkdir(fact_store_path, { recursive: true });
	const fact_store = new PgFactStore({ deps, disk_root: fact_store_path, fs: runtime, log });
	console.log(`[server] Fact store disk root: ${fact_store_path}`);

	// Bound concurrent streaming uploads (a permit held across `put_stream`) so
	// excess uploads wait rather than racing to fill the disk — caps aggregate
	// in-flight temp churn on top of the per-request free-space preflight.
	const upload_semaphore = new AsyncSemaphore(env.FUZ_FORGE_FILE_STORE_MAX_CONCURRENT_UPLOADS);

	// Reap stale `.tmp/*` orphans left by a hard crash mid-stream — a pass at
	// boot, then one per interval. Mirrors the Rust `sweep_orphan_temps`.
	// Best-effort: the loop logs a failed pass at `warn` and retries on the next
	// interval, so a sweep failure never crashes the server, and its timer is
	// unref'd, so it never holds the process open.
	const orphan_sweep = start_periodic(
		'orphan-temp sweep',
		FACT_TMP_SWEEP_INTERVAL_MS,
		async () => {
			const removed = await sweep_orphan_temps(runtime, fact_store_path, { log });
			if (removed > 0) console.log(`[server] Swept ${removed} orphan fact temp file(s)`);
		},
		log
	);

	return {
		fact_store,
		fact_store_path,
		upload_semaphore,
		stop_sweep: orphan_sweep.stop
	};
};

/**
 * Env var gating the login rate limiters in test mode, shared with the Rust
 * `testing_fuz_forge_server` binary and `testing_spine_stub`. fuz_app owns the
 * name (`LOGIN_RATE_LIMIT_ENABLED_ENV`) in its `testing/` cross-backend
 * modules; library code keeps its own copy rather than importing from
 * fuz_app's `testing/` tree, whose modules assert a dev environment on import
 * and are test harness, not server code. The same holds for the two action
 * names below.
 */
const LOGIN_RATE_LIMIT_ENABLED_ENV = 'FUZ_LOGIN_RATE_LIMIT_ENABLED';

/**
 * Env var gating the action rate limiters in test mode — fuz_app's
 * `ACTION_RATE_LIMIT_ENABLED_ENV`, read by the Rust test binary too.
 */
const ACTION_RATE_LIMIT_ENABLED_ENV = 'FUZ_ACTION_RATE_LIMIT_ENABLED';

/**
 * Env var replacing both action limiters' `max_attempts` in test mode —
 * fuz_app's `ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV`, read by the Rust test binary
 * too.
 */
const ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV = 'FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS';

/** `u32::MAX` — the largest cap the Rust test binary's `u32` parse accepts. */
const U32_MAX = 0xffff_ffff;

/**
 * Builds RPC actions over an already-assembled mount list.
 *
 * The shape `_testing_action_manifest` needs: it serves a dump of the live
 * method set, so it can only be built once the rest of the mount exists —
 * which `ServerTestingOptions.extra_rpc_actions_factory` (invoked before
 * assembly, seeing only its own deps) cannot provide. Each mount that takes
 * one calls it with its own assembled list, so the manifest an endpoint serves
 * describes that endpoint.
 */
export type FinalRpcActionsFactory = (
	mounted: ReadonlyArray<RpcAction>
) => ReadonlyArray<RpcAction>;

/** Test-only assembly outputs spread into `create_app_server`. */
export interface TestingWiring {
	/** Daemon-token state for `create_app_server` (`undefined` in production). */
	daemon_token_state: DaemonTokenState | undefined;
	/** Injected `_testing_*` RPC actions (empty in production). */
	extra_rpc_actions: ReadonlyArray<RpcAction>;
	/**
	 * Builds actions **from** the assembled mount, appended last. `null` in
	 * production; in test mode it returns `_testing_action_manifest`, which
	 * dumps the live method set and so must see every action mounted above it.
	 * Twin of the Rust `RunAppOptions.final_action_specs_factory`.
	 */
	final_rpc_actions_factory: FinalRpcActionsFactory | null;
	/**
	 * `AppServerOptions.rate_limiters` — `'enforced'` in production, and in
	 * test mode unless `LOGIN_RATE_LIMIT_ENABLED_ENV` asks for live limiters.
	 * In test mode it governs only the auth limiters (login, signup,
	 * bootstrap): the two action limiters are always passed explicitly there.
	 */
	rate_limiters: RateLimiterMode;
	/**
	 * `AppServerOptions.action_ip_rate_limiter` — `undefined` in production
	 * (the spine default under `'enforced'`); in test mode the limiter
	 * `resolve_testing_action_rate_limiters` built, or `null`.
	 */
	action_ip_rate_limiter: RateLimiter | null | undefined;
	/** `AppServerOptions.action_account_rate_limiter` — as `action_ip_rate_limiter`. */
	action_account_rate_limiter: RateLimiter | null | undefined;
	/** Whether `create_app_server` awaits pending effects per response (test-only). */
	await_pending_effects: boolean;
	/** Stops daemon-token rotation; no-op in production. Composed into the app's `close()`. */
	stop: () => Promise<void>;
}

/**
 * Parse a test-mode limiter gate through `EnvStringbool`, whose closed set
 * (case-insensitive `true`/`1`/`yes`/`on`/`y`/`enabled` and their falsy pairs)
 * is the twin of the Rust `fuz_sys::env::parse_stringbool`, so one
 * `BackendConfig` value means the same thing on both backends. Unset is
 * `false`; an unrecognized value throws rather than silently reading as off,
 * as the Rust binary refuses to start on one.
 */
const parse_testing_gate = (runtime: EnvDeps, name: string): boolean => {
	const raw = runtime.env_get(name);
	if (raw === undefined) return false;
	const parsed = parse(EnvStringbool, raw);
	if (!parsed.ok) {
		throw new Error(`${name}: expected a boolean, got ${JSON.stringify(raw)}`);
	}
	return parsed.value;
};

/**
 * The rate-limiter mode passed to `create_app_server` in test mode, read from
 * the `LOGIN_RATE_LIMIT_ENABLED_ENV` gate. Twin of the Rust
 * `testing_fuz_forge_server`'s `resolve_login_rate_limiter_mode`.
 *
 * In test mode the mode reaches only the auth limiters — login, signup and
 * bootstrap — because the two action limiters are passed explicitly
 * (`resolve_testing_action_rate_limiters`, their own gate). The
 * `cross_backend_login_security_*` projects spawn with the gate on because the
 * login-security suite drives the 429 wire shape and the `X-Forwarded-For`
 * bucket keying over a real socket, which needs the limiters live. Unset, it is
 * `'disabled_for_testing'`, so a standard cross suite firing hundreds of
 * logins from one host trips no budget it never meant to exercise.
 *
 * **Production passes no limiter of its own, and that is its rate-limit
 * configuration.** There `create_testing_wiring` returns `'enforced'` and no
 * action limiter, so every limiter is fuz_app's default instance — every
 * bound, including the two action budgets pinned in
 * `src/test/fixtures/parity/rate_limits.json`, accepted rather than tuned,
 * which is what keeps them equal to the Rust twin's `fuz_auth` defaults.
 * `src/test/server/action_rate_limit_bounds.test.ts` pins those defaults to
 * the fixture, not the call site: a tuned limiter passed to
 * `create_app_server` would diverge from the twin with that test still green.
 *
 * @param runtime - env access, read for `LOGIN_RATE_LIMIT_ENABLED_ENV`
 * @returns `'enforced'` when the gate is truthy, else `'disabled_for_testing'`
 * @throws Error when the gate is set to a value outside `EnvStringbool`'s set
 */
export const resolve_testing_login_rate_limiter_mode = (runtime: EnvDeps): RateLimiterMode =>
	parse_testing_gate(runtime, LOGIN_RATE_LIMIT_ENABLED_ENV) ? 'enforced' : 'disabled_for_testing';

/** The two action limiters `create_testing_wiring` hands `create_app_server` in test mode. */
export interface TestingActionRateLimiters {
	action_ip_rate_limiter: RateLimiter | null;
	action_account_rate_limiter: RateLimiter | null;
}

/**
 * Parse `ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV` against the enable flag — a
 * positive integer, refused when set without `ACTION_RATE_LIMIT_ENABLED_ENV`
 * (a cap that silently does nothing would leave a suite asserting a throttle
 * the binary never built). Mirrors the Rust test binary's cap parse in
 * `resolve_action_rate_limits` (`raw.trim().parse::<u32>()`, then `> 0`):
 * surrounding whitespace is trimmed, one leading `+` and leading zeros
 * are accepted, and a value above `u32::MAX` is refused.
 *
 * @param raw - the env value, `undefined` when unset
 * @param enabled - the parsed enable flag
 * @returns the cap, or `undefined` when unset
 * @throws Error on a malformed or out-of-range cap, or a cap without the flag
 */
const parse_action_rate_limit_max_attempts = (
	raw: string | undefined,
	enabled: boolean
): number | undefined => {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	const max_attempts = /^\+?[0-9]+$/.test(trimmed) ? Number(trimmed) : NaN;
	if (!(max_attempts > 0 && max_attempts <= U32_MAX)) {
		throw new Error(
			`${ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV}: expected a positive integer, got ${JSON.stringify(raw)}`
		);
	}
	if (!enabled) {
		throw new Error(
			`${ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV} is set but ${ACTION_RATE_LIMIT_ENABLED_ENV} is not`
		);
	}
	return max_attempts;
};

/**
 * The action limiters for test mode, read from `ACTION_RATE_LIMIT_ENABLED_ENV`
 * and the optional `ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV` cap. Twin of the Rust
 * `testing_fuz_forge_server`'s `resolve_action_rate_limits`, which hands
 * `RunAppOptions` the same mode and cap.
 *
 * Off (unset or falsy), both are `null`: no action class is throttled on
 * either transport, whatever the login gate says. On, one per-IP and one
 * per-account limiter over fuz_app's action defaults, with the cap replacing
 * both `max_attempts` when given — `create_app_server` threads the pair to the
 * RPC and WS endpoints alike, one budget per axis across both transports. The
 * login-security spawn pair sets both, so a case reaches the cap in a few
 * calls (`ws_action_rate_limit.cross.test.ts`,
 * `action_throttle_order.cross.test.ts`).
 *
 * @param runtime - env access, read for the action gate and cap
 * @returns the two limiters, both `null` when the gate is off
 * @throws Error on an unrecognized gate value, a malformed cap, or a cap without the gate
 */
export const resolve_testing_action_rate_limiters = (
	runtime: EnvDeps
): TestingActionRateLimiters => {
	const enabled = parse_testing_gate(runtime, ACTION_RATE_LIMIT_ENABLED_ENV);
	const max_attempts = parse_action_rate_limit_max_attempts(
		runtime.env_get(ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV),
		enabled
	);
	if (!enabled) return { action_ip_rate_limiter: null, action_account_rate_limiter: null };
	const with_cap = (defaults: RateLimiterOptions): RateLimiterOptions => ({
		...defaults,
		max_attempts: max_attempts ?? defaults.max_attempts
	});
	return {
		action_ip_rate_limiter: new RateLimiter(with_cap(default_action_ip_rate_limit)),
		action_account_rate_limiter: new RateLimiter(with_cap(default_action_account_rate_limit))
	};
};

/**
 * Wire the cross-process test seams. Production passes no `testing`, so this
 * returns the inert bundle (no daemon-token rotation, no injected actions,
 * `rate_limiters: 'enforced'` with no limiter of its own, no
 * `await_pending_effects`) and reads none of the test-mode env gates. In test
 * mode it starts daemon-token rotation (the `_testing_reset` keeper credential
 * channel), builds the injected `_testing_*` actions, and resolves the two
 * limiter gates — the auth limiters off unless `LOGIN_RATE_LIMIT_ENABLED_ENV`
 * says otherwise, the action limiters off unless
 * `ACTION_RATE_LIMIT_ENABLED_ENV` does — so a single host firing many
 * signup/login round-trips per backend lifetime doesn't trip them.
 *
 * The Rust backend segregates the same concerns at the crate boundary
 * (`testing_fuz_forge_server` + `fuz_testing`), which is that language's idiom —
 * this shape deliberately does not mirror it.
 */
export const create_testing_wiring = async (
	testing: ServerTestingOptions | undefined,
	runtime: RuntimeDeps,
	deps: AppDeps,
	log: Logger
): Promise<TestingWiring> => {
	if (!testing) {
		return {
			daemon_token_state: undefined,
			extra_rpc_actions: [],
			final_rpc_actions_factory: null,
			rate_limiters: 'enforced',
			action_ip_rate_limiter: undefined,
			action_account_rate_limiter: undefined,
			await_pending_effects: false,
			stop: async () => {}
		};
	}

	// The env gates first, so a bad value throws before anything starts.
	const rate_limiters = resolve_testing_login_rate_limiter_mode(runtime);
	const action_rate_limiters = resolve_testing_action_rate_limiters(runtime);
	// the injected limiters are this wiring's to dispose — `create_app_server`
	// disposes only the ones it builds
	const dispose_action_rate_limiters = (): void => {
		action_rate_limiters.action_ip_rate_limiter?.dispose();
		action_rate_limiters.action_account_rate_limiter?.dispose();
	};

	// Daemon-token rotation — the `_testing_reset` action gates on the
	// daemon-token credential, and the cross-process harness reads the rotated
	// token to authenticate the keeper channel. The producer moved into
	// fuz_app's `testing/` behind the dev-env guard, so import it lazily here —
	// only the `testing` branch ever reaches it, keeping the production path
	// free of test-only modules.
	let daemon_token_rotation: DaemonTokenRotation;
	try {
		const { start_daemon_token_rotation } =
			await import('@fuzdev/fuz_app/testing/daemon_token_rotation.ts');
		await runtime.mkdir(dirname(testing.daemon_token_path), { recursive: true });
		daemon_token_rotation = await start_daemon_token_rotation(
			runtime,
			{ db: deps.db },
			{
				token_path: testing.daemon_token_path,
				// Effectively never rotate during a test run. The cross-process
				// harness reads the daemon token ONCE at spawn and caches it, so a
				// rotation mid-run would invalidate that cached token (401
				// `invalid_daemon_token`); the 30s default could be crossed by a
				// slow or loaded run. Pin a long interval so the token stays static
				// for the whole run, matching the Rust testing binary's static
				// daemon token. (≤ setInterval's ~24.8-day max.)
				rotation_interval_ms: 24 * 60 * 60 * 1000
			},
			log
		);
	} catch (error) {
		dispose_action_rate_limiters();
		throw error;
	}

	// Injected `_testing_*` actions, closing over the backend deps + daemon-token
	// state.
	const extra_rpc_actions = testing.extra_rpc_actions_factory(deps, {
		daemon_token_state: daemon_token_rotation.state,
		session_options: fuz_forge_session_config
	});

	return {
		daemon_token_state: daemon_token_rotation.state,
		extra_rpc_actions,
		final_rpc_actions_factory: testing.final_rpc_actions_factory,
		rate_limiters,
		...action_rate_limiters,
		await_pending_effects: true,
		stop: async () => {
			dispose_action_rate_limiters();
			await daemon_token_rotation.stop();
		}
	};
};
