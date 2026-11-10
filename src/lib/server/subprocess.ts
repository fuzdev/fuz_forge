/**
 * Subprocess streaming + buffered primitives for the forge server.
 *
 * Two capabilities the forge routes depend on:
 * - `SpawnStreaming` bridges the git smart-HTTP body into
 *   `git http-backend` (used by `routes/git_cgi.ts`).
 * - `SpawnCollect` runs bounded `git` and `chmod` commands and buffers
 *   their output (used by `server/git/read.ts`'s read-only queries and by
 *   `fuz_forge/repo/storage.ts`, which runs the `git init --bare` /
 *   `git clone --bare` / `git config` / `git symbolic-ref` / `chmod`
 *   storage commands through it).
 *
 * Both share an env-isolation contract: the subprocess sees only
 * `options.env`, never the parent env. `spawn_streaming` and `spawn_collect`
 * implement them over `node:child_process`, which Bun implements too; the
 * routes take them injected, so tests substitute their own.
 *
 * Structural twin of the Rust backend's `crates/fuz_forge_server/src/subprocess.rs`,
 * kept in its own module on both backends. The data shapes and the two
 * functions carry the same names there — `SpawnStreamingHandle`,
 * `SpawnStreamingOptions`, `SpawnCollectResult`, `SpawnCollectOptions`,
 * `spawn_streaming`, `spawn_collect`. The capability types `SpawnStreaming` and
 * `SpawnCollect` are TS-only by design: the Rust side calls its free functions
 * directly instead of injecting them, so there is nothing on that side for the
 * two to name.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import { concat_uint8 } from '../runtime/bytes.ts';

/**
 * Streaming subprocess handle used by the forge routes to bridge the
 * git smart-HTTP protocol into `git http-backend`.
 *
 * Web-stream-shaped: `spawn_streaming` adapts the child's Node streams via
 * `Readable.toWeb` / `Writable.toWeb`.
 *
 * The handle is intentionally narrow — `git http-backend` only needs
 * stdin/stdout/stderr streams, an exit status, and a kill switch.
 */
export interface SpawnStreamingHandle {
	stdin: WritableStream<Uint8Array>;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	status: Promise<{ code: number; success: boolean }>;
	kill: (signal?: string) => void;
}

export interface SpawnStreamingOptions {
	/**
	 * Explicit environment passed to the subprocess. Callers MUST supply
	 * exactly the variables the binary needs — server env is intentionally
	 * NOT inherited. For `git http-backend` this is the CGI-shaped set
	 * (`GIT_PROJECT_ROOT`, `PATH_INFO`, `REQUEST_METHOD`, …) plus `PATH`.
	 */
	env: Record<string, string>;
	cwd?: string;
}

/**
 * Streaming-subprocess capability. Spawns `cmd` with the given `args` and
 * returns a `SpawnStreamingHandle`; `spawn_streaming` implements it.
 */
export type SpawnStreaming = (
	cmd: string,
	args: ReadonlyArray<string>,
	options: SpawnStreamingOptions
) => SpawnStreamingHandle;

/**
 * Result of a buffered subprocess run — stdout/stderr collected to memory,
 * exit code surfaced as a number.
 *
 * Same env-isolation contract as `SpawnStreaming` — the subprocess only sees
 * `options.env`, never the parent env. Every caller runs a command whose
 * output is bounded and wants it as a single value rather than a stream;
 * `FuzForgeRoutesDeps.spawn_collect` in
 * `server/routes/fuz_forge_repo_cell.ts` names the set.
 */
export interface SpawnCollectResult {
	stdout: Uint8Array;
	stderr: Uint8Array;
	code: number;
	success: boolean;
}

export interface SpawnCollectOptions {
	/** Explicit subprocess env. Same posture as `SpawnStreamingOptions`. */
	env: Record<string, string>;
	cwd?: string;
	/** Optional cap on stdout/stderr bytes. Excess output kills the subprocess and rejects. */
	max_output_bytes?: number;
}

/**
 * Buffered-subprocess capability. Spawns `cmd`, drains
 * stdout + stderr to memory, and resolves with the captured bytes and
 * exit code. No stdin — callers that need to pipe input use
 * `SpawnStreaming` instead.
 *
 * TODO: no **wall-clock** timeout. `max_output_bytes` bounds how much a child
 * can produce, and nothing bounds how long it may take to produce it — a
 * `git clone --bare` against a hostile or hanging upstream, or a `git log` on
 * a pathological repo, stalls its request until the client gives up while
 * holding a subprocess slot. Both backends have the same hole (Rust
 * `subprocess.rs`'s `spawn_collect`), so closing it is a paired change: a
 * deadline option on the primitive, an `AbortSignal` / `tokio::time::timeout`
 * around the drain, SIGKILL on expiry, and a typed timeout outcome the
 * classifiers can map — the shape `SpawnOutputTooLargeError` /
 * `PayloadTooLarge` already set for the byte cap.
 *
 * `spawn_collect` implements it.
 */
export type SpawnCollect = (
	cmd: string,
	args: ReadonlyArray<string>,
	options: SpawnCollectOptions
) => Promise<SpawnCollectResult>;

/**
 * Thrown by a `SpawnCollect` implementation when a subprocess exceeds its
 * `max_output_bytes` cap (the process is SIGKILL'd). A discriminant type — not
 * a message substring — so callers classify the cap-overflow outcome reliably;
 * the Rust backend models the same case as a typed `PayloadTooLarge`.
 */
export class SpawnOutputTooLargeError extends Error {
	constructor(label: string, cap: number) {
		super(`subprocess ${label} exceeded ${cap} bytes`);
		this.name = 'SpawnOutputTooLargeError';
	}
}

/** True when `err` is a `SpawnOutputTooLargeError` (a subprocess output-cap hit). */
export const is_output_too_large = (err: unknown): boolean =>
	err instanceof SpawnOutputTooLargeError;

/**
 * `SpawnCollect` over `node:child_process`. Buffers stdout/stderr to memory
 * until exit. No stdin — closed immediately so the subprocess doesn't block
 * waiting for input.
 *
 * `max_output_bytes` is enforced across each of stdout / stderr
 * independently — exceeding either kills the subprocess and rejects.
 * The cap is the only resource bound on this primitive, so callers
 * with adversarial-or-buggy subprocesses MUST set one.
 *
 * `env` is passed explicitly — `spawn` would otherwise inherit `process.env`,
 * which leaks server secrets.
 */
export const spawn_collect: SpawnCollect = (cmd, args, options) =>
	new Promise((resolve, reject) => {
		const proc = spawn(cmd, [...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		const cap = options.max_output_bytes;
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
 * `SpawnStreaming` over `node:child_process`. `spawn` returns Node-shaped
 * streams; `Readable.toWeb` / `Writable.toWeb` adapt them to the handle's web
 * streams.
 *
 * `env` is passed explicitly, as in `spawn_collect`.
 */
export const spawn_streaming: SpawnStreaming = (cmd, args, options) => {
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
