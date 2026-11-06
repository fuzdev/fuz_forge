/**
 * Node.js entry point for fuz_forge server.
 *
 * This entry point allows running the server in Node.js for:
 * - Testing (vitest runs in Node)
 * - Runtime comparison benchmarks (Deno vs Node vs Bun)
 * - Environments where Deno isn't available
 *
 * Uses @hono/node-server for the HTTP server and @hono/node-ws for `/api/ws`.
 *
 * Run with:
 *   gro run src/lib/server/server_node.ts
 *
 * Or with env file:
 *   gro run src/lib/server/server_node.ts --env_file .env.development
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createNodeWebSocket, type NodeWebSocket } from '@hono/node-ws';
import { argv_parse } from '@fuzdev/fuz_util/args.ts';
import { load_env_file } from '@fuzdev/fuz_app/env/dotenv.ts';
import { create_node_runtime } from '@fuzdev/fuz_app/runtime/node.ts';
import { DEFAULT_WS_MAX_MESSAGE_BYTES } from '@fuzdev/fuz_app/actions/transports.ts';

import { concat_uint8 } from '../runtime/bytes.ts';
import { create_app } from './server.ts';
import { create_shutdown_handler } from './shutdown_signals.ts';
import { SpawnOutputTooLargeError, type SpawnStreaming, type SpawnCollect } from './subprocess.ts';

/**
 * Node implementation of `SpawnCollect`. Buffers stdout/stderr to
 * memory until exit. No stdin — closed immediately so the subprocess
 * doesn't block waiting for input.
 *
 * `max_output_bytes` is enforced across each of stdout / stderr
 * independently — exceeding either kills the subprocess and rejects.
 * The cap is the only resource bound on this primitive, so callers
 * with adversarial-or-buggy subprocesses MUST set one.
 */
export const spawn_collect_node: SpawnCollect = (cmd, args, options) =>
	new Promise((resolve, reject) => {
		const proc = spawn(cmd, [...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		const cap = options.max_output_bytes;
		// `chunk` arrives as a Node `Buffer` but is structurally a
		// `Uint8Array`; typing it as the latter avoids depending on the
		// `Buffer` global, which Deno's typechecker doesn't expose to
		// this module.
		const stdout_chunks: Array<Uint8Array> = [];
		const stderr_chunks: Array<Uint8Array> = [];
		let stdout_bytes = 0;
		let stderr_bytes = 0;
		let killed = false;

		const collect =
			(
				chunks: Array<Uint8Array>,
				get_bytes: () => number,
				add_bytes: (n: number) => void,
				label: string
			) =>
			(chunk: Uint8Array) => {
				if (killed) return;
				add_bytes(chunk.length);
				chunks.push(chunk);
				if (cap !== undefined && get_bytes() > cap) {
					killed = true;
					proc.kill('SIGKILL');
					reject(new SpawnOutputTooLargeError(label, cap));
				}
			};

		proc.stdout.on(
			'data',
			collect(
				stdout_chunks,
				() => stdout_bytes,
				(n) => {
					stdout_bytes += n;
				},
				'stdout'
			)
		);
		proc.stderr.on(
			'data',
			collect(
				stderr_chunks,
				() => stderr_bytes,
				(n) => {
					stderr_bytes += n;
				},
				'stderr'
			)
		);

		proc.on('error', (err) => {
			if (killed) return;
			killed = true;
			reject(err);
		});

		proc.on('close', (code, signal) => {
			if (killed) return;
			const resolved_code = code ?? (signal ? 128 : 1);
			resolve({
				stdout: concat_uint8(stdout_chunks),
				stderr: concat_uint8(stderr_chunks),
				code: resolved_code,
				success: resolved_code === 0
			});
		});
	});

/**
 * Node implementation of `SpawnStreaming`. `node:child_process.spawn`
 * returns Node-shaped streams; `Readable.toWeb` / `Writable.toWeb` adapt
 * them to the web-stream contract Deno already produces.
 *
 * Env is passed explicitly via `options.env` — `spawn` would otherwise
 * inherit `process.env`, which leaks server secrets. Mirrors Deno's
 * `clearEnv: true` defense.
 *
 * Exported for use in route integration tests that run on Node — the
 * production wiring closes over this same factory in `start_server_node`.
 */
export const spawn_streaming_node: SpawnStreaming = (cmd, args, options) => {
	const proc = spawn(cmd, [...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ['pipe', 'pipe', 'pipe']
	});

	const status: Promise<{ code: number; success: boolean }> = new Promise((resolve) => {
		proc.on('exit', (code, signal) => {
			// `code` is null when the process was killed by a signal; map to
			// a non-zero sentinel so callers see `success: false` in either
			// failure mode.
			const resolved_code = code ?? (signal ? 128 : 1);
			resolve({ code: resolved_code, success: resolved_code === 0 });
		});
	});

	return {
		stdin: Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
		stdout: Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
		stderr: Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array>,
		status,
		kill: (signal?: string) => {
			proc.kill((signal as NodeJS.Signals | undefined) ?? 'SIGTERM');
		}
	};
};

/**
 * Start the server using Node.js runtime.
 *
 * Creates the Hono app with Node-specific dependencies and starts the server.
 * SIGINT and SIGTERM shut it down gracefully — the listener stops, the app
 * closes, and the process exits (`create_shutdown_handler`).
 *
 * @returns Promise that resolves when server is listening
 */
export const start_server_node = async (): Promise<void> => {
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
		// Don't override existing process env.
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
		spawn_streaming: spawn_streaming_node,
		spawn_collect: spawn_collect_node
	});

	console.log(`[server] Listening on http://${env.HOST}:${env.PORT} (Node)`);

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

// Auto-start when run directly
// In Node, we check if this module is the entry point
const is_main_module = import.meta.url === `file://${process.argv[1]}`;

if (is_main_module) {
	start_server_node().catch((error) => {
		console.error('[server] Failed to start:', error);
		process.exit(1);
	});
}
