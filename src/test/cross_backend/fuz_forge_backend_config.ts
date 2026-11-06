/**
 * Cross-process `BackendConfig` factories for fuz_forge's cross-backend
 * integration suites.
 *
 * fuz_forge is the ecosystem's canonical dual-impl cross-backend consumer —
 * its TS (Hono/Deno) and Rust (`fuz_forge_server`, Axum) backends are
 * measured against each other with full parity as the standing goal. This
 * file declares the per-backend spawn config; the shared shape (`/api/*`
 * paths, cookie name, bootstrap block) comes from the lifted upstream
 * builders in `@fuzdev/fuz_app/testing/cross_backend/default_backend_configs.ts`.
 *
 * Both pipes carry the same suites and both are green. Parity here is
 * symmetric — a divergence fails on whichever side is wrong, and the fix goes
 * there. A suite that has to branch on the backend is a gap in the contract,
 * not a configuration detail — express the difference as a declared
 * `capabilities` flag or close it.
 *
 * **Port assignments** — fixed-but-distinct, no collision with the dev
 * daemon (`4041`):
 *
 * - Deno test binary → `14041`
 * - Node test binary → `14042`
 * - Bun test binary → `14043`
 * - Rust test binary → `14141`
 *
 * The Node + Bun configs exist for the cross-impl bench
 * (`src/benchmarks/cross_impl.bench.ts`), which times the TS reference backend
 * under all three JS runtimes (Node V8 / Deno V8 / Bun JSC). The cross-backend
 * *correctness* suites still spawn only the Deno + Rust binaries.
 *
 * **Cookie name** — both backends emit `fuz_forge_session`. The Rust spine
 * takes a per-app cookie-name override
 * (`fuz_forge_server::router::FUZ_FORGE_SESSION_COOKIE_NAME` threaded into the
 * route states); without it the Rust spine would emit its default
 * `fuz_session` and diverge from the TS forge.
 *
 * **Rust Postgres** — the Rust binary needs real Postgres (`tokio-postgres`
 * can't reach an in-process database). The `cross_backend_rust` project points at
 * `fuz_forge_test_rust`, which the global setups create when it's missing
 * (`ensure_databases`, `ensure_database_for_url`). The test binary self-wipes
 * the schema on every boot (`FUZ_TESTING_RESET_DB_ON_STARTUP=true`), so no
 * manual `DROP TABLE` between sessions.
 *
 * **Loopback `HOST`** — both backends bind the builders' default
 * `127.0.0.1`, which the git `post-receive` / `pre-receive` hooks' callback
 * (`build_callback_url_base`, `http://127.0.0.1:<port>`) depends on.
 *
 * @module
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackendConfig } from '@fuzdev/fuz_app/testing/cross_backend/backend_config.ts';
import {
	resolve_cargo_binary_path,
	type CargoBinaryOptions
} from '@fuzdev/fuz_app/testing/cross_backend/cargo_binary.ts';
import { build_test_backend_paths } from '@fuzdev/fuz_app/testing/cross_backend/build_test_backend_paths.ts';
import {
	action_rate_limit_env,
	make_default_rust_backend_config,
	make_default_ts_backend_config,
	rust_default_capabilities,
	ts_default_capabilities
} from '@fuzdev/fuz_app/testing/cross_backend/default_backend_configs.ts';
import {
	LOGIN_RATE_LIMIT_ENABLED_ENV,
	TESTING_BACKDOOR_METHODS
} from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';

/**
 * Per-project Rust backend database URL prefix — real Postgres (an
 * in-process database isn't reachable from `tokio-postgres`). The full URL appends the backend
 * `name` (`fuz_forge_test_rust`). See the module doc for operator setup.
 */
const RUST_DATABASE_URL_PREFIX = 'postgres://localhost/fuz_forge_test_';

/**
 * The database every Rust spawn uses. Exported so the parity gates' setup can
 * put the TS leg's own database on the same server.
 */
export const RUST_DATABASE_URL = `${RUST_DATABASE_URL_PREFIX}rust`;

/**
 * Optional overrides accepted by the TS-backend factories. `database_url`
 * lets the cross-impl bench's fair-DB option point a TS backend at real
 * Postgres (apples-to-apples vs the Rust backend's Postgres) instead of the
 * default in-memory `'memory://'`. The single-backend correctness suites never pass it
 * (the in-memory database is the zero-infra default); the parity gates do,
 * from `dual_spawn_global_setup.ts`.
 */
export interface TsBackendConfigOptions {
	database_url?: string;
}

/**
 * Shared TS-backend shape — every TS runtime (Deno / Node / Bun) serves the
 * same fuz_forge app over the same wire, so they share cookie name,
 * capabilities (bar `ws_refusal_body`), port-less env (per-backend store
 * paths, the tiny file-store cap), and the optional fair-DB
 * `database_url`. The per-runtime factories below supply only what genuinely
 * differs: `name`, `port`, `ws_refusal_body` (Node sends an empty WS refusal
 * body), and the `start_command` (which interpreter + entry).
 */
const make_ts_forge_backend_config = (opts: {
	name: string;
	port: number;
	start_command: Array<string>;
	/**
	 * Whether a refused WebSocket upgrade carries its refusal body — `true` on
	 * Deno and Bun, which send the response as built; `false` on Node, whose
	 * `@hono/node-ws` drops it (`BackendCapabilities.ws_refusal_body`).
	 */
	ws_refusal_body: boolean;
	database_url?: string;
	/** Merged over the shared baseline — the login-security variant's limiter gates. */
	extra_env?: Record<string, string>;
}): BackendConfig => {
	const { name, port, start_command, ws_refusal_body, database_url, extra_env } = opts;
	const paths = build_test_backend_paths(`fuz_forge_cross_${name}`);
	return make_default_ts_backend_config({
		name,
		port,
		// fuz_forge's session config uses a custom cookie name; the harness
		// threads the `_testing_reset` keeper cookie into its jar under this
		// name, so it must match (mismatch → 401 on the create_account path).
		cookie_name: 'fuz_forge_session',
		// The TS forge wires `audit_log_sse: true` and mounts the standard
		// `/api/admin/audit/stream`, so it advertises `sse`. The Rust forge
		// serves the same stream (see `rust_backend_config`), so both run
		// the SSE suite. Both also mount `/ready` over the committed
		// `expected_schema.json` (TS `create_ready_route_spec`, Rust
		// `fuz_http::ready_router`), so both advertise `ready` and run the
		// schema-drift readiness-probe parity suite (the shared `ready` suite).
		capabilities: {
			...ts_default_capabilities,
			sse: true,
			ready: true,
			// The TS forge mounts both fact-serving routes — the cell-scoped
			// `GET /api/cells/:id/facts/:hash` and the admin-only bare-hash
			// `GET /api/facts/:hash` — through `create_serve_cell_fact_route_spec`
			// / `create_serve_fact_route_spec` on the declared surface, twinning
			// the Rust `fuz_fact_serving::fact_routers`. The forge's own
			// `/api/fuz_forge/files/*` store is the path-keyed surface over the
			// same bytes. `fact_serving` is the cell-scoped route and
			// `fact_serving_admin_hash` the bare-hash one, which also gates the
			// fact-route cases inside `query_shape` and `token_scope_surface`.
			fact_serving: true,
			fact_serving_admin_hash: true,
			// `ts_default_capabilities` keeps `peer_request` off until a TS
			// backend mounts `peer/ping` on both a WS endpoint and the HTTP RPC
			// endpoint (the `peer_no_transport` refusal). The TS forge does both:
			// `build_rpc_endpoint_specs` adds `peer_ping_action` to `/api/rpc`,
			// and `/api/ws` serves that set through `to_ws_actions`, the protocol
			// actions first. So it runs the server-initiated `peer/ping` suite
			// like the Rust forge.
			peer_request: true,
			ws_refusal_body,
			ws: true,
			cell_crud: true,
			cell_relations: true,
			// `/api/ws` mounts the same actions as `/api/rpc`
			// (`create_fuz_forge_mount_actions`), the self-service account
			// actions among them
			ws_account_actions: true,
			// the create authorizer reserves the forge's kinds, not the suite's test
			// policy, and there is no role-gated second WS endpoint
			cell_gated_create: false,
			ws_role_gated: false,
			// `build_fuz_forge_testing_app` mounts every known backdoor
			testing_backdoors: TESTING_BACKDOOR_METHODS
		},
		start_command,
		// `make_default_ts_backend_config` defaults this to `'memory://'`
		// (in-memory); the bench's fair-DB option overrides it with a Postgres URL.
		database_url,
		paths,
		extra_env: {
			// `create_app` eager-mkdirs the fact-store disk root at boot; point
			// it under the per-backend tmp subtree for isolation + cleanup.
			FUZ_FORGE_FACT_STORE_PATH: join(paths.root, 'facts'),
			FUZ_FORGE_REPO_STORE_PATH: join(paths.root, 'repos'),
			// Tiny file-store cap so the disk-budget suite's 413 case rejects a
			// ~2 MiB upload without shipping GiB payloads (the production default is
			// 10 GiB). All other file cross-tests upload a few bytes, well under it.
			FUZ_FORGE_FILE_STORE_MAX_BYTES: String(FILE_STORE_MAX_BYTES_TEST),
			// No free-space headroom beyond the upload itself. The fact store sits
			// under the temp dir, and the default 1 GiB margin answers uploads
			// `507 storage_full` on a host whose temp volume has less than that
			// free. The 507 path is pinned in-process on both backends (see
			// `files_disk_budget.cross.test.ts`).
			FUZ_FORGE_FILE_STORE_FREE_SPACE_MARGIN_BYTES: '0',
			// Two suites seed from a loopback upstream, which the default host
			// policy refuses: `repo_create_seed_from.cross.test.ts` (its
			// connection-refused negative control and its real dumb-HTTP clone)
			// and `rpc_input_strictness.bounds.cross.test.ts` (the `seed_from`
			// length rows, whose over- and at-ceiling URLs must clear the grammar
			// and host gates so the answer is attributable to the bound). Set on
			// both backends so they exercise one contract; the *default* (off)
			// behavior is unit-pinned per backend, in
			// `fuz_forge/repo/seed_from.test.ts` and the `seed_from` test module.
			FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS: 'true',
			...extra_env
		}
	});
};

/**
 * The Deno test-server spawn argv, shared by the standard and login-security
 * backends. The `--allow-*` set mirrors the production daemon's plus
 * `--allow-run` / `--allow-ffi` (the `gro` transitive `oxc-parser` forces FFI;
 * the forge smart-HTTP routes spawn `git`, though the standard suite doesn't
 * exercise them).
 */
const DENO_START_COMMAND = [
	'deno',
	'run',
	'--allow-net',
	'--allow-read',
	'--allow-env',
	'--allow-write',
	'--allow-sys',
	'--allow-ffi',
	'--allow-run',
	'--unstable-detect-cjs',
	'src/lib/server/testing_server_deno.ts'
];

/** TS canonical backend on Deno V8. Spawns `testing_server_deno.ts`. */
export const deno_backend_config = (options: TsBackendConfigOptions = {}): BackendConfig =>
	make_ts_forge_backend_config({
		name: 'deno',
		port: 14041,
		database_url: options.database_url,
		start_command: DENO_START_COMMAND,
		ws_refusal_body: true
	});

/**
 * TS backend on Node V8. Spawns `testing_server_node.ts` via `gro run` (Gro's
 * TS loader runs the `.ts` entry and its `.ts` source specifiers). Exists for
 * the cross-impl bench's runtime axis; the correctness suites don't spawn it.
 */
export const node_backend_config = (options: TsBackendConfigOptions = {}): BackendConfig =>
	make_ts_forge_backend_config({
		name: 'node',
		port: 14042,
		database_url: options.database_url,
		start_command: ['gro', 'run', 'src/lib/server/testing_server_node.ts'],
		ws_refusal_body: false
	});

/**
 * TS backend on Bun JSC. Spawns `testing_server_bun.ts` via `bun run` (Bun
 * runs `.ts` sources natively; `Bun.serve` is built in and
 * the static middleware comes from the `@hono/bun` dev dep). Exists for the
 * cross-impl bench's runtime axis; the correctness suites don't spawn it. The
 * bench only includes it when `bun` is on `PATH`.
 */
export const bun_backend_config = (options: TsBackendConfigOptions = {}): BackendConfig =>
	make_ts_forge_backend_config({
		name: 'bun',
		port: 14043,
		database_url: options.database_url,
		start_command: ['bun', 'run', 'src/lib/server/testing_server_bun.ts'],
		ws_refusal_body: true
	});

/**
 * File-store upload cap (2 MiB) injected into both backends so the disk-budget
 * suite can drive the upload `413` path with a ~3 MiB body instead of a
 * GiB payload. Small enough to test cheaply, large enough that every other file
 * cross-test (a handful of bytes each) sails under it.
 *
 * It must also stay **above** `FACT_EMBEDDED_THRESHOLD_DEFAULT` (1 MiB): the
 * file store is the only producer of external facts these spawns have, so a cap
 * at or below the threshold would make every stored fact embedded and leave the
 * disk-CAS read under `facts_dir` unreachable from any cross suite — which is
 * what `fact_serving.cross.test.ts`'s over-threshold case drives.
 */
export const FILE_STORE_MAX_BYTES_TEST = 2 * 1024 * 1024;

/**
 * The Rust test binary — `testing_fuzfd` in the `testing_fuz_forge_server`
 * crate, in this repo's Cargo workspace, `dev` profile. The global setups
 * build it before the spawn (`prepare_cargo_binary`); the configs spawn the
 * path it builds to.
 */
export const FORGE_CARGO_BINARY: CargoBinaryOptions = {
	workspace_dir: fileURLToPath(new URL('../../..', import.meta.url)),
	package: 'testing_fuz_forge_server',
	bin: 'testing_fuzfd'
};

/**
 * Rust backend (`testing_fuzfd`, Axum on the spine crates) — spawns the built
 * binary (`FORGE_CARGO_BINARY`) over HTTP against `fuz_forge_test_rust`. The
 * global setups build it first (`prepare_cargo_binary`), so a stale `target/`
 * binary never serves silently.
 *
 * **Shared env contract — no per-backend remap.** The Rust spine now reads
 * the same canonical names + shapes as the TS backend: numeric `PORT` +
 * `HOST` (not a `host:port` `FUZ_FORGE_BIND_ADDR`), `FUZ_ALLOWED_ORIGINS`,
 * `FUZ_BOOTSTRAP_TOKEN_PATH`, and the forge-specific `FUZ_FORGE_REPO_STORE_PATH`
 * / `FUZ_FORGE_FACT_STORE_PATH`. So the `make_default_rust_backend_config`
 * baseline (`PORT`, `HOST`, `FUZ_ALLOWED_ORIGINS` and its
 * `FUZ_ALLOW_ORIGIN_WILDCARDS` opt-in, `FUZ_BOOTSTRAP_TOKEN_PATH`)
 * flows straight through — `extra_env` carries only the forge-specific
 * paths, mirroring the Deno config. The `fuz_forge_server::env` drift test
 * guards against the names re-splitting.
 *
 * `daemon_token_dir_env` sets `FUZ_FORGE_DAEMON_TOKEN_DIR`, so the Rust
 * `init_daemon_token` writes `{root}/run/daemon_token` — the
 * `paths.daemon_token_path` `spawn_backend` reads for the `_testing_reset`
 * keeper credential.
 */
export const rust_backend_config = (): BackendConfig => make_rust_forge_backend_config({});

/**
 * Shared Rust-backend shape. `name` / `port` / `extra_env` are the only things
 * the login-security variant changes; everything else (capabilities, the
 * built binary, the DB, the per-backend tmp roots) is identical, so the
 * two spawns can only differ where the variant says so.
 */
const make_rust_forge_backend_config = (opts: {
	name?: string;
	port?: number;
	extra_env?: Record<string, string>;
}): BackendConfig => {
	const name = opts.name ?? 'rust';
	const paths = build_test_backend_paths(`fuz_forge_cross_${name}`);
	const port = opts.port ?? 14141;
	return make_default_rust_backend_config({
		name,
		port,
		// Both backends emit `fuz_forge_session` — the Rust spine takes a per-app
		// cookie-name override (`FUZ_FORGE_SESSION_COOKIE_NAME`); its default
		// would be `fuz_session`.
		cookie_name: 'fuz_forge_session',
		// The Rust forge serves `GET /api/admin/audit/stream` (the spine
		// `fuz_realtime::SseRegistry` + audit listener wired in
		// `fuz_forge_server::router`), so it advertises `sse` like the TS
		// forge — the cross-process SSE suite runs on both. It
		// also mounts `fuz_http::ready_router` over the same committed
		// `expected_schema.json` the TS `/ready` route reads, so it advertises
		// `ready` and runs the readiness-probe parity suite.
		capabilities: {
			...rust_default_capabilities,
			sse: true,
			ready: true,
			// The Rust forge serves both fact-serving routes through
			// `fuz_fact_serving::fact_routers`, in step with the TS twin's pair of
			// route specs. See the TS config for the full note.
			fact_serving: true,
			fact_serving_admin_hash: true,
			ws: true,
			cell_crud: true,
			cell_relations: true,
			peer_request: true,
			// the one registry serves `/api/rpc` and `/api/ws`, and
			// `build_auth_spec_set` puts the self-service account actions in it
			ws_account_actions: true,
			// the create authorizer reserves the forge's kinds, not the suite's test
			// policy, and there is no role-gated second WS endpoint
			cell_gated_create: false,
			ws_role_gated: false,
			// `testing_fuz_forge_server` mounts every known backdoor
			testing_backdoors: TESTING_BACKDOOR_METHODS
		},
		start_command: [resolve_cargo_binary_path(FORGE_CARGO_BINARY)],
		// One DB for every Rust spawn — the projects are groupOrder-serialized and
		// the test binary wipes the schema at boot
		// (`FUZ_TESTING_RESET_DB_ON_STARTUP`), so a second database would be
		// operator setup with nothing to isolate.
		database_url: RUST_DATABASE_URL,
		// `RUST_LOG` targets are crate names (package name, hyphens→underscores),
		// not bin names — these track the unchanged crate names.
		rust_log: 'info,fuz_forge_server=info,testing_fuz_forge_server=info',
		paths,
		daemon_token_dir_env: 'FUZ_FORGE_DAEMON_TOKEN_DIR',
		extra_env: {
			FUZ_FORGE_FACT_STORE_PATH: join(paths.root, 'facts'),
			FUZ_FORGE_REPO_STORE_PATH: join(paths.root, 'repos'),
			// Same tiny file-store cap as the Deno backend — keeps the disk-budget
			// suite's 413 case symmetric on both backends. See the Deno config.
			FUZ_FORGE_FILE_STORE_MAX_BYTES: String(FILE_STORE_MAX_BYTES_TEST),
			// Same zero free-space margin as the Deno backend. See the Deno config.
			FUZ_FORGE_FILE_STORE_FREE_SPACE_MARGIN_BYTES: '0',
			// Same loopback-seed override as the Deno backend, for the same two
			// suites. See the Deno config.
			FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS: 'true',
			...opts.extra_env
		}
	});
};

/**
 * The action limiters' `max_attempts` on the login-security spawns, both axes,
 * both backends — small, so a case reaches the throttle in a few calls. The
 * test binaries alone read it (`FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS`);
 * production keeps the spine defaults pinned in `rate_limits.json`.
 *
 * At least 2 for `describe_ws_action_rate_limit_cross_tests`, whose
 * shared-bucket case splits the budget across both transports.
 * `action_throttle_order.cross.test.ts` needs more: its fixture's
 * `create_account` already charges its account two calls, and the WS case
 * splits what is left between HTTP and the socket, so 6 leaves two per
 * transport. Fixture setup spends the fresh keeper's account bucket too —
 * `create_account`'s `invite_create`, and a `role_grant_offer_create` per role
 * it confers, run as the keeper — so a test on these spawns that creates
 * several role-holding accounts can meet a 429 during setup.
 */
export const LOGIN_SECURITY_ACTION_RATE_LIMIT_MAX_ATTEMPTS = 6;

/**
 * The limiter env both login-security spawns carry: the login gate, and the
 * action gate with its cap (fuz_app's `action_rate_limit_env`, the same
 * option pair fuz_app's own security spawns take).
 */
const LOGIN_SECURITY_LIMITER_ENV: Record<string, string> = {
	[LOGIN_RATE_LIMIT_ENABLED_ENV]: 'true',
	...action_rate_limit_env({
		enable_action_rate_limit: true,
		action_rate_limit_max_attempts: LOGIN_SECURITY_ACTION_RATE_LIMIT_MAX_ATTEMPTS
	})
};

/**
 * The Deno backend with the login and action rate limiters **enabled** — the
 * spawn `describe_login_security_cross_tests` and
 * `describe_ws_action_rate_limit_cross_tests` need, the action pair capped at
 * `LOGIN_SECURITY_ACTION_RATE_LIMIT_MAX_ATTEMPTS`.
 *
 * A third spawn target rather than a flag on the standard one: the standard
 * cross suites fire hundreds of logins from one host, far past the
 * 5-per-15-min per-IP budget (successful logins deliberately don't refund it),
 * so the limiters have to stay off there. Its own port + tmp root keep the two
 * spawns disjoint. The proxy half needs no env: the TS forge hardcodes
 * loopback as trusted (`server.ts`'s `proxy.trusted_proxies`), so
 * `X-Forwarded-For` already keys the buckets.
 */
export const deno_login_security_backend_config = (): BackendConfig =>
	make_ts_forge_backend_config({
		name: 'login_security_deno',
		port: 14051,
		start_command: DENO_START_COMMAND,
		ws_refusal_body: true,
		extra_env: LOGIN_SECURITY_LIMITER_ENV
	});

/**
 * The Rust backend with the login and action rate limiters **enabled**. Twin of
 * `deno_login_security_backend_config`; see it for why this is a separate
 * spawn target.
 *
 * `FUZ_FORGE_TRUSTED_PROXIES` is stated explicitly even though loopback is
 * already the Rust default (`crates/fuz_forge_server/src/env.rs`), so the
 * suite's `X-Forwarded-For` cases don't silently depend on that default.
 */
export const rust_login_security_backend_config = (): BackendConfig =>
	make_rust_forge_backend_config({
		name: 'login_security_rust',
		port: 14151,
		extra_env: {
			...LOGIN_SECURITY_LIMITER_ENV,
			FUZ_FORGE_TRUSTED_PROXIES: '127.0.0.1,::1'
		}
	});
