/**
 * Deno subprocess primitives for the fuz_forge cross-process test binary,
 * `server/testing_server_deno.ts`.
 *
 * @module
 */

import { concat_uint8 } from '../runtime/bytes.ts';
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
