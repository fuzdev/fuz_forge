/**
 * Deno entry point for the fuz_forge TS server.
 *
 * The TS server is the reference twin, run directly rather than compiled: this
 * module is the entry `gro.config.ts` wires as the dev Deno server, and the one
 * `server/server_main.ts` hands off to. Production serves the Rust `fuzfd`
 * binary instead. Uses `Deno.serve` for the HTTP server and `@hono/deno` for
 * static files.
 *
 * Run with:
 *   deno run --allow-net --allow-read --allow-env server_deno.ts
 *
 * Or through `server/server_main.ts`, which loads an env file first
 * (`deno task dev:start`).
 *
 * @module
 */

import { serveStatic, upgradeWebSocket, getConnInfo } from '@hono/deno';
import { create_deno_runtime } from '@fuzdev/fuz_app/runtime/deno.ts';

import { concat_uint8 } from '../runtime/bytes.ts';
import { create_app } from './server.ts';
import { create_shutdown_handler } from './shutdown_signals.ts';
import { SpawnOutputTooLargeError, type SpawnStreaming, type SpawnCollect } from './subprocess.ts';

/**
 * Deno implementation of `SpawnStreaming`. `Deno.Command(...).spawn()`
 * already returns web-shaped streams; we just wrap the exit-status shape
 * to match the cross-runtime contract (no `success` field on the raw
 * promise).
 */
export const spawn_streaming_deno: SpawnStreaming = (cmd, args, options) => {
	const proc = new Deno.Command(cmd, {
		args: [...args],
		env: options.env,
		cwd: options.cwd,
		stdin: 'piped',
		stdout: 'piped',
		stderr: 'piped',
		// Deno inherits parent env by default; clear it so only `options.env`
		// is visible to the subprocess (locked-down posture).
		clearEnv: true
	}).spawn();

	return {
		stdin: proc.stdin,
		stdout: proc.stdout,
		stderr: proc.stderr,
		status: proc.status.then((s: { code: number; success: boolean }) => ({
			code: s.code,
			success: s.success
		})),
		kill: (signal?: string) => proc.kill(signal as never)
	};
};

/**
 * Deno implementation of `SpawnCollect`. `Deno.Command(...).output()`
 * already buffers stdout/stderr to memory — we just enforce the optional
 * `max_output_bytes` cap by draining the streams manually and checking
 * each chunk.
 *
 * Deno's `output()` has no built-in cap; without manual draining a
 * runaway subprocess could exhaust memory. Locked-down posture matches
 * the Node side: callers MUST set a cap for adversarial-or-buggy inputs.
 */
export const spawn_collect_deno: SpawnCollect = async (cmd, args, options) => {
	const proc = new Deno.Command(cmd, {
		args: [...args],
		env: options.env,
		cwd: options.cwd,
		stdin: 'null',
		stdout: 'piped',
		stderr: 'piped',
		clearEnv: true
	}).spawn();

	const cap = options.max_output_bytes;

	const drain = async (stream: ReadableStream<Uint8Array>, label: string): Promise<Uint8Array> => {
		const reader = stream.getReader();
		const chunks: Array<Uint8Array> = [];
		let total = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.length;
				chunks.push(value);
				if (cap !== undefined && total > cap) {
					proc.kill('SIGKILL');
					throw new SpawnOutputTooLargeError(label, cap);
				}
			}
		} finally {
			reader.releaseLock();
		}
		return concat_uint8(chunks);
	};

	const [stdout, stderr] = await Promise.all([
		drain(proc.stdout, 'stdout'),
		drain(proc.stderr, 'stderr')
	]);
	const status = await proc.status;
	return { stdout, stderr, code: status.code, success: status.success };
};

/**
 * Start the server using Deno runtime.
 *
 * Creates the Hono app with Deno-specific dependencies and starts Deno.serve.
 * SIGINT and SIGTERM shut it down gracefully — the listener stops, the app
 * closes, and the process exits (`create_shutdown_handler`).
 */
export const start_server_deno = async (): Promise<void> => {
	const runtime = create_deno_runtime([]);
	const { app, env, close } = await create_app({
		runtime,
		serve_static: serveStatic,
		create_upgrade_websocket: () => upgradeWebSocket,
		get_connection_ip: (c) => getConnInfo(c).remote.address,
		spawn_streaming: spawn_streaming_deno,
		spawn_collect: spawn_collect_deno
	});

	console.log(`[server] Listening on http://${env.HOST}:${env.PORT} (Deno)`);
	const server = Deno.serve({ port: env.PORT, hostname: env.HOST }, app.fetch);

	const shutdown = create_shutdown_handler({
		stop_listening: () => server.shutdown(),
		close,
		exit: (code) => Deno.exit(code)
	});
	Deno.addSignalListener('SIGINT', () => void shutdown());
	Deno.addSignalListener('SIGTERM', () => void shutdown());
};

// Auto-start when run directly (Deno entry point detection)
if (import.meta.url === Deno.mainModule) {
	start_server_deno().catch((error) => {
		console.error('[server] Failed to start:', error);
		Deno.exit(1);
	});
}
