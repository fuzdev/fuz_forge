/**
 * Unit tests for the TS server entries' signal-driven shutdown.
 *
 * @module
 */

import { assert, describe, test, vi } from 'vitest';

import { create_shutdown_handler } from '#lib/server/shutdown_signals.ts';

/** A step the test settles by hand, recording that it started. */
const create_step = () => {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	const step = vi.fn(() => promise);
	return { step, resolve, reject };
};

describe('create_shutdown_handler', () => {
	test('stops the listener and closes the app together, then exits 0', async () => {
		const listener = create_step();
		const app = create_step();
		const exits: Array<number> = [];
		const shutdown = create_shutdown_handler({
			stop_listening: listener.step,
			close: app.step,
			exit: (code) => exits.push(code)
		});

		const done = shutdown();
		// the drain is not awaited before the close: live sockets hold it open
		assert.strictEqual(listener.step.mock.calls.length, 1);
		assert.strictEqual(app.step.mock.calls.length, 1);
		app.resolve();
		// a macrotask flushes every microtask the settled close queued
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepStrictEqual(exits, [], 'waits for the drain too');
		listener.resolve();
		await done;
		assert.deepStrictEqual(exits, [0]);
	});

	test('a failed close exits 1 after the drain settles, and is logged', async () => {
		const error_log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const exits: Array<number> = [];
			const boom = new Error('close failed');
			const shutdown = create_shutdown_handler({
				stop_listening: () => Promise.resolve(),
				close: () => Promise.reject(boom),
				exit: (code) => exits.push(code)
			});
			await shutdown();
			assert.deepStrictEqual(exits, [1]);
			assert.ok(error_log.mock.calls.some((args) => args.includes(boom)));
		} finally {
			error_log.mockRestore();
			log.mockRestore();
		}
	});

	test('a failed listener stop exits 1 after the close settles, and is logged', async () => {
		const error_log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const exits: Array<number> = [];
			const boom = new Error('listener stop failed');
			const close = vi.fn(() => Promise.resolve());
			const shutdown = create_shutdown_handler({
				stop_listening: () => Promise.reject(boom),
				close,
				exit: (code) => exits.push(code)
			});
			await shutdown();
			assert.strictEqual(close.mock.calls.length, 1, 'the app still closed');
			assert.deepStrictEqual(exits, [1]);
			assert.ok(error_log.mock.calls.some((args) => args.includes(boom)));
		} finally {
			error_log.mockRestore();
			log.mockRestore();
		}
	});

	test('a second signal during shutdown exits 1 at once', async () => {
		const error_log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const listener = create_step();
			const app = create_step();
			const exits: Array<number> = [];
			const shutdown = create_shutdown_handler({
				stop_listening: listener.step,
				close: app.step,
				exit: (code) => exits.push(code)
			});

			const first = shutdown();
			await shutdown();
			assert.deepStrictEqual(exits, [1], 'the second signal did not wait for the first');
			assert.strictEqual(app.step.mock.calls.length, 1, 'and closed nothing twice');
			listener.resolve();
			app.resolve();
			await first;
		} finally {
			error_log.mockRestore();
			log.mockRestore();
		}
	});

	test('a stop_listening that throws synchronously still closes the app and exits 1', async () => {
		const error_log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const exits: Array<number> = [];
			const boom = new Error('listener stop threw');
			const close = vi.fn(() => Promise.resolve());
			const shutdown = create_shutdown_handler({
				stop_listening: () => {
					throw boom;
				},
				close,
				exit: (code) => exits.push(code)
			});
			await shutdown();
			assert.strictEqual(close.mock.calls.length, 1, 'the app still closed');
			assert.deepStrictEqual(exits, [1]);
			assert.ok(error_log.mock.calls.some((args) => args.includes(boom)));
		} finally {
			error_log.mockRestore();
			log.mockRestore();
		}
	});

	test('a step that never settles exits 1 after the timeout', async () => {
		vi.useFakeTimers();
		const error_log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const listener = create_step();
			const exits: Array<number> = [];
			const shutdown = create_shutdown_handler({
				stop_listening: listener.step,
				close: () => Promise.resolve(),
				exit: (code) => exits.push(code),
				timeout_ms: 500
			});
			const done = shutdown();
			await vi.advanceTimersByTimeAsync(499);
			assert.deepStrictEqual(exits, [], 'not before the timeout');
			await vi.advanceTimersByTimeAsync(1);
			await done;
			assert.deepStrictEqual(exits, [1]);
			assert.ok(
				error_log.mock.calls.some((args) =>
					args.includes('[server] shutdown timed out after 500 ms')
				)
			);
			// a step that settles after the timeout never exits again
			listener.resolve();
			await vi.advanceTimersByTimeAsync(0);
			assert.deepStrictEqual(exits, [1], 'no late exit');
		} finally {
			error_log.mockRestore();
			log.mockRestore();
			vi.useRealTimers();
		}
	});

	test('the timeout is cleared when the steps settle first', async () => {
		vi.useFakeTimers();
		try {
			const exits: Array<number> = [];
			const shutdown = create_shutdown_handler({
				stop_listening: () => Promise.resolve(),
				close: () => Promise.resolve(),
				exit: (code) => exits.push(code),
				timeout_ms: 500
			});
			await shutdown();
			assert.deepStrictEqual(exits, [0]);
			assert.strictEqual(vi.getTimerCount(), 0, 'no timer left pending');
			await vi.advanceTimersByTimeAsync(1000);
			assert.deepStrictEqual(exits, [0], 'no late exit');
		} finally {
			vi.useRealTimers();
		}
	});
});
