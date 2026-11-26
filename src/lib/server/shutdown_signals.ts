/**
 * Graceful shutdown on SIGINT / SIGTERM for the TS server.
 *
 * The server entry, `server/server_main.ts`, binds the handler to the
 * process's signals and exit. The order mirrors fuz_app's cross-process test
 * binary: stop accepting connections, close the app (`ServerApp.close`, which
 * closes every live WebSocket and audit stream — they would otherwise hold
 * the listener's drain open — then the database), and wait for the close,
 * then, on a clean close, the listener's drain, before exiting, up to
 * `SHUTDOWN_TIMEOUT_MS`.
 *
 * @module
 */

import {
	DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
	shutdown_gave_up,
	type ShutdownDrainGivenUp
} from '@fuzdev/fuz_app/server/shutdown_drain.ts';

/**
 * How long a shutdown may run before the process exits `1` anyway — a
 * backstop past the app server's drain bound
 * (`DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS`, which the forge leaves at its
 * default), not a bound of its own. The drain bound starts only once the
 * orphan-temp sweep has stopped and the daemon-token file is removed, so a backstop
 * equal to it would fire first, cutting off the drain's give-up log and the
 * exit it decides. Within the bound the app server reports what it gave up on
 * and the handler exits `1`, as the Rust server's one drain bound covers its
 * connections, upkeep and audit writes, and a give-up there exits `1`
 * (`StartupError::ShutdownGivenUp`). Past this backstop is what no bound
 * covers: a sweep pass that never ends, a pool close waiting on a checked-out
 * client.
 */
export const SHUTDOWN_TIMEOUT_MS = 2 * DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;

/** Options for `create_shutdown_handler`. */
export interface ShutdownHandlerOptions {
	/**
	 * Stop accepting new connections; resolves once the listener has drained.
	 * Called before `close` and not awaited first: live WebSockets hold the
	 * drain open until `close` ends them.
	 */
	stop_listening: () => Promise<void>;
	/** Close the app — `ServerApp.close`, resolving what its drain gave up on. */
	close: () => Promise<ShutdownDrainGivenUp>;
	/** Exit the process with `code`. */
	exit: (code: number) => void;
	/**
	 * Bound on the whole shutdown, in milliseconds — a stuck sweep pass, or a
	 * pool close waiting on a checked-out client, would otherwise hold it open
	 * until a second signal.
	 * @default SHUTDOWN_TIMEOUT_MS
	 */
	timeout_ms?: number;
}

/**
 * Run `step` to its settled result, a synchronous throw included; never
 * rejects.
 */
const settle = async <T>(step: () => Promise<T>): Promise<PromiseSettledResult<T>> => {
	try {
		return { status: 'fulfilled', value: await step() };
	} catch (reason) {
		return { status: 'rejected', reason };
	}
};

/**
 * Create the handler a server entry binds to SIGINT and SIGTERM.
 *
 * The first signal stops the listener and closes the app — both started
 * before either is awaited, a synchronous throw from one never keeping the
 * other from running. A close that failed, or whose drain gave up on anything
 * (`shutdown_gave_up`, logged by the app server), exits `1` at once without
 * waiting for the listener's drain, which a given-up request's connection
 * would hold open — as the Rust server's main and fuz_app's test binary do.
 * Otherwise the handler waits for the listener, then exits `0`, or `1` after
 * logging when its stop failed. A shutdown still running after `timeout_ms`
 * logs and exits `1`; a signal that arrives while the shutdown is still
 * running exits `1` at once.
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
		// both started before either is awaited; `settle` turns a synchronous
		// throw into a rejection of that step alone
		const listening = settle(stop_listening);
		const closed = await Promise.race([settle(close), timed_out]);
		if (closed === 'timed_out') {
			console.error(`[server] shutdown timed out after ${timeout_ms} ms`);
			exit(1);
			return;
		}
		// a failed close or a give-up exits without the listener's drain, which a
		// request the drain gave up on still holds open
		if (closed.status === 'rejected' || shutdown_gave_up(closed.value)) {
			clearTimeout(timer);
			if (closed.status === 'rejected') {
				console.error('[server] shutdown failed:', closed.reason);
			}
			// otherwise `AppServer.close` has logged what it gave up on
			exit(1);
			return;
		}
		const listened = await Promise.race([listening, timed_out]);
		clearTimeout(timer);
		if (listened === 'timed_out') {
			console.error(`[server] shutdown timed out after ${timeout_ms} ms`);
			exit(1);
			return;
		}
		const failed = listened.status === 'rejected';
		if (failed) {
			console.error('[server] shutdown failed:', listened.reason);
		}
		exit(failed ? 1 : 0);
	};
};
