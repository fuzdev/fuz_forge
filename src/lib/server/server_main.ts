/**
 * Entry point for the fuz_forge TS server.
 *
 * The TS server is the reference twin, run directly rather than compiled:
 * `gro dev` runs this module beside Vite (`gro_plugin_server` in
 * `gro.config.ts`), and `npm run dev:server` runs it alone. Production serves
 * the Rust `fuzfd` binary instead, which reads its env from the process
 * environment and takes no `--env_file`.
 *
 * Serves the app with `@hono/node-server` and `/api/ws` with `@hono/node-ws`.
 * Reads its env from the process environment; `--env_file <path>` loads a file
 * beneath it first, never overriding a variable already set.
 *
 * Run with:
 *   gro run src/lib/server/server_main.ts --env_file .env.development
 *
 * @module
 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createNodeWebSocket, type NodeWebSocket } from '@hono/node-ws';
import { argv_parse } from '@fuzdev/fuz_util/args.ts';
import { load_env_file } from '@fuzdev/fuz_app/env/dotenv.ts';
import { create_node_runtime } from '@fuzdev/fuz_app/runtime/node.ts';
import { DEFAULT_WS_MAX_MESSAGE_BYTES } from '@fuzdev/fuz_app/actions/transports.ts';

import { create_app } from './server.ts';
import { create_shutdown_handler } from './shutdown_signals.ts';
import { spawn_collect, spawn_streaming } from './subprocess.ts';

/**
 * Load the env file, if one is named, start the server, and bind SIGINT and
 * SIGTERM to a graceful shutdown — the listener stops, the app closes, and the
 * process exits (`create_shutdown_handler`).
 */
const main = async (): Promise<void> => {
	const runtime = create_node_runtime();

	const raw = argv_parse(process.argv.slice(2));
	const env_file = typeof raw.env_file === 'string' ? raw.env_file : undefined;
	if (env_file) {
		const env_vars = await load_env_file(runtime, env_file);
		if (env_vars === null) {
			console.error(`[server] Cannot read env file: ${env_file}`);
			runtime.exit(1);
			return;
		}
		// the process env wins, as a dotenv loader leaves set vars alone
		for (const [key, value] of Object.entries(env_vars)) {
			if (runtime.env_get(key) === undefined) {
				runtime.env_set(key, value);
			}
		}
	}

	// `@hono/node-ws` builds its upgrade helper from the assembled app, so
	// `create_app_server` calls this factory with the app it creates; the
	// helper's other half, `injectWebSocket`, attaches to the server below.
	// Unset when no WS endpoint mounted (the factory is never called).
	let node_ws: NodeWebSocket | undefined;
	const { app, env, close } = await create_app({
		runtime,
		serve_static: serveStatic,
		get_connection_ip: (c) => getConnInfo(c).remote.address,
		create_upgrade_websocket: (assembled_app) => {
			node_ws = createNodeWebSocket({ app: assembled_app });
			// `@hono/node-ws` builds its `ws` server with no options and takes
			// none, so its frame cap would stay `ws`'s 100 MiB default. `ws` reads
			// `options.maxPayload` per upgrade, so setting it before any
			// connection caps every socket at twice the endpoint's message limit
			// (`/api/ws` keeps fuz_app's default). Past its cap `ws` closes with
			// 1009 and no reason, so the headroom leaves a message just over the
			// limit to `register_action_ws`'s own check, which sends the
			// `message too big` reason as the Rust spine does, while a grossly
			// oversized one is still refused at the frame layer.
			node_ws.wss.options.maxPayload = 2 * DEFAULT_WS_MAX_MESSAGE_BYTES;
			return node_ws.upgradeWebSocket;
		},
		spawn_streaming,
		spawn_collect
	});

	console.log(`[server] Listening on http://${env.HOST}:${env.PORT}`);

	const server = serve({
		fetch: app.fetch,
		port: env.PORT,
		hostname: env.HOST
	});
	node_ws?.injectWebSocket(server);

	const shutdown = create_shutdown_handler({
		stop_listening: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
		close,
		exit: (code) => process.exit(code)
	});
	process.on('SIGINT', () => void shutdown());
	process.on('SIGTERM', () => void shutdown());
};

main().catch((error: unknown) => {
	console.error('[server] Failed to start:', error);
	process.exit(1);
});
