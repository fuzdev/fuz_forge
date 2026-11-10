/**
 * Graceful shutdown on SIGINT / SIGTERM for the TS server.
 *
 * The server entry, `server/server_main.ts`, binds the handler to the
 * process's signals and exit. The order mirrors fuz_app's cross-process test
 * binary: stop accepting connections, close the
 * app (`ServerApp.close`, which closes every live WebSocket and audit stream —
 * they would otherwise hold the listener's drain open — then the database),
 * and wait for both before exiting, up to `SHUTDOWN_TIMEOUT_MS`.
 *
 * @module
 */

/**
 * How long a shutdown may run before the process exits `1` anyway — 10 s, the
 * same value as the Rust server's drain timeout, though that bounds only the
 * connection drain and exits normally past it.
 */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Options for `create_shutdown_handler`. */
export interface ShutdownHandlerOptions {
	/**
	 * Stop accepting new connections; resolves once the listener has drained.
	 * Called before `close` and not awaited first: live WebSockets hold the
	 * drain open until `close` ends them.
	 */
	stop_listening: () => Promise<void>;
	/** Close the app — `ServerApp.close`. */
	close: () => Promise<void>;
	/** Exit the process with `code`. */
	exit: (code: number) => void;
	/**
	 * Bound on the whole shutdown, in milliseconds — a client request that
	 * never finishes, a stuck sweep pass, or a pool close waiting on a
	 * checked-out client would otherwise hold it open until a second signal.
	 * @default SHUTDOWN_TIMEOUT_MS
	 */
	timeout_ms?: number;
}

/**
 * Create the handler a server entry binds to SIGINT and SIGTERM.
 *
 * The first signal stops the listener and closes the app, then exits `0`, or
 * `1` after logging when either step failed (a synchronous throw included —
 * it never keeps the other step from running). A shutdown still running after
 * `timeout_ms` — a drain held open by a stalled client, say — logs and exits
 * `1`; a signal that arrives while the shutdown is still running exits `1` at
 * once.
 *
 * @returns the signal handler; never rejects
 */
export const create_shutdown_handler = (options: ShutdownHandlerOptions): (() => Promise<void>) => {
	const { stop_listening, close, exit, timeout_ms = SHUTDOWN_TIMEOUT_MS } = options;
	let shutting_down = false;
	return async () => {
		if (shutting_down) {
			console.error('[server] second signal during shutdown — exiting now');
			exit(1);
			return;
		}
		shutting_down = true;
		console.log('[server] shutting down...');
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timed_out = new Promise<'timed_out'>((resolve) => {
			timer = setTimeout(() => resolve('timed_out'), timeout_ms);
		});
		// both started synchronously before either is awaited, and both settled
		// before exiting; the async wrapper turns a synchronous throw into a
		// rejection of that step alone
		const settled = Promise.allSettled([stop_listening, close].map(async (step) => step()));
		const results = await Promise.race([settled, timed_out]);
		clearTimeout(timer);
		if (results === 'timed_out') {
			console.error(`[server] shutdown timed out after ${timeout_ms} ms`);
			exit(1);
			return;
		}
		let failed = false;
		for (const result of results) {
			if (result.status === 'rejected') {
				failed = true;
				console.error('[server] shutdown failed:', result.reason);
			}
		}
		exit(failed ? 1 : 0);
	};
};
