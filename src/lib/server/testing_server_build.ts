/**
 * fuz_forge domain seam for the cross-process test binary.
 *
 * The runtime-neutral orchestration (serve, daemon-info, WS attach, drain)
 * + the Node/Deno/Bun adapters live in fuz_app
 * (`@fuzdev/fuz_app/testing/cross_backend/testing_server_{core,node,deno,bun}.ts`).
 * This module keeps only what's fuz_forge-specific: building the production
 * `create_app` with the test seams wired — `stub_password_deps`, daemon-token
 * rotation, the test rate-limiter gates, and the `_testing_*` seams from
 * `testing_rpc_actions.ts` — the bundle on both mounts, and through the
 * last-position `final_rpc_actions_factory` `_testing_action_manifest`, which
 * has to enumerate the mount it lives on.
 *
 * Reusing the production `create_app` (rather than a parallel test assembly)
 * is deliberate: the cross-backend harness exists to catch wire-shape drift,
 * so the spawned backend must be the real app, not a divergent stand-in.
 *
 * **NEVER ships in a release.** Reaches into fuz_app's `testing/cross_backend/`
 * modules which throw on production-bundle load.
 *
 * @module
 */

import { dirname, join } from 'node:path';
import type { Context, Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { ServeStaticFactory } from '@fuzdev/fuz_app/server/static.ts';
import type { RuntimeDeps } from '@fuzdev/fuz_app/runtime/deps.ts';
import { stub_password_deps } from '@fuzdev/fuz_app/testing/app_server.ts';
import type { BuiltTestingApp } from '@fuzdev/fuz_app/testing/cross_backend/testing_server_core.ts';

import { load_env } from './env/load.ts';
import { create_app } from './server.ts';
import type { SpawnCollect, SpawnStreaming } from './subprocess.ts';
import {
	create_fuz_forge_testing_final_rpc_actions,
	create_fuz_forge_testing_rpc_actions
} from './testing_rpc_actions.ts';

export interface ResolvedFuzForgeTestingConfig {
	host: string;
	port: number;
	/**
	 * Where daemon-token rotation writes the deterministic token. Derived
	 * from `FUZ_BOOTSTRAP_TOKEN_PATH`'s parent (the harness's per-backend
	 * root), so it lands at `{root}/run/daemon_token` — exactly where
	 * `build_test_backend_paths` tells the harness to read it.
	 */
	daemon_token_path: string;
}

/**
 * Resolve `{host, port, daemon_token_path}` from the spawned process env.
 * The `BackendConfig.env` (built by `make_default_ts_backend_config`)
 * supplies `HOST` / `PORT` / `FUZ_BOOTSTRAP_TOKEN_PATH`.
 */
export const resolve_fuz_forge_testing_config = (
	runtime: RuntimeDeps
): ResolvedFuzForgeTestingConfig => {
	const env = load_env(runtime);
	if (!env.FUZ_BOOTSTRAP_TOKEN_PATH) {
		throw new Error(
			'testing server requires FUZ_BOOTSTRAP_TOKEN_PATH (its parent is the harness backend root; ' +
				'`{root}/run/daemon_token` is where the cross-process harness reads the keeper token)'
		);
	}
	return {
		host: env.HOST,
		port: env.PORT,
		daemon_token_path: join(dirname(env.FUZ_BOOTSTRAP_TOKEN_PATH), 'run', 'daemon_token')
	};
};

export interface BuildFuzForgeTestingAppOptions {
	runtime: RuntimeDeps;
	/** Runtime-specific static middleware factory (e.g. `serveStatic` from `@hono/deno`). */
	serve_static: ServeStaticFactory;
	/** Extract the raw TCP connection IP from a Hono context (adapter-specific). */
	get_connection_ip: (c: Context) => string | undefined;
	daemon_token_path: string;
	/**
	 * Runtime-specific subprocess primitives for the forge git routes. Wired
	 * so the cross-process `repo_push` suite can drive smart-HTTP push (which
	 * spawns `git http-backend`) and the repo read RPCs (`git log`/`show`)
	 * against the spawned binary. The standard suite never exercises these.
	 */
	spawn_streaming: SpawnStreaming;
	spawn_collect: SpawnCollect;
	/**
	 * The runtime's WS upgrade factory, passed through to `create_app` — each
	 * entry passes `BuildTestingAppContext.prepare_websocket()`, whose attach
	 * step (Node's `injectWebSocket`) the test-server core runs after `serve`.
	 * Mounts `/api/ws` so the cross-process WS suites can drive the socket.
	 */
	create_upgrade_websocket: (app: Hono) => UpgradeWebSocket;
}

/**
 * Build the fuz_forge test app over the production `create_app` with the
 * test seams wired.
 */
export const build_fuz_forge_testing_app = async (
	options: BuildFuzForgeTestingAppOptions
): Promise<BuiltTestingApp> => {
	const {
		runtime,
		serve_static,
		get_connection_ip,
		daemon_token_path,
		spawn_streaming,
		spawn_collect,
		create_upgrade_websocket
	} = options;

	// serve no static files — `create_app` serves the cwd's SvelteKit `build/`
	// with a `200.html` fallback, so a stale gitignored build would turn unrouted
	// paths into 200s; rooted at a dir nothing creates (`{root}/static`, beside
	// `{root}/run/daemon_token`), both lookups miss and every unrouted path falls
	// through to Hono's default 404, as on the Rust backend (no static serving)
	const static_root = join(dirname(dirname(daemon_token_path)), 'static');
	const serve_no_static: ServeStaticFactory = (static_options) =>
		serve_static({ ...static_options, root: static_root });

	const server_app = await create_app({
		runtime,
		serve_static: serve_no_static,
		get_connection_ip,
		spawn_streaming,
		spawn_collect,
		create_upgrade_websocket,
		testing: {
			password: stub_password_deps,
			daemon_token_path,
			extra_rpc_actions_factory: (deps, { daemon_token_state, session_options }) => {
				if (!daemon_token_state) {
					throw new Error(
						'testing server requires daemon-token rotation (it provides keeper credentials for _testing_reset)'
					);
				}
				// one list for both mounts (HTTP RPC + WS), and the one the cross
				// suites resolve off-surface methods from (`testing_rpc_actions.ts`)
				return create_fuz_forge_testing_rpc_actions(deps, { daemon_token_state, session_options });
			},
			// last-position: `_testing_action_manifest` dumps the live method set,
			// so each mount builds it over its own assembled list
			final_rpc_actions_factory: create_fuz_forge_testing_final_rpc_actions
		}
	});

	return { app: server_app.app, close: server_app.close };
};
