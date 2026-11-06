/**
 * Subprocess streaming + buffered primitives for the forge server.
 *
 * Two runtime-provided capabilities the forge routes depend on:
 * - `SpawnStreaming` bridges the git smart-HTTP body into
 *   `git http-backend` (used by `routes/git_cgi.ts`).
 * - `SpawnCollect` runs bounded `git` and `chmod` commands and buffers
 *   their output (used by `server/git/read.ts`'s read-only queries and by
 *   `fuz_forge/repo/storage.ts`, which runs the `git init --bare` /
 *   `git clone --bare` / `git config` / `git symbolic-ref` / `chmod`
 *   storage commands through it).
 *
 * Both share an env-isolation contract: the subprocess sees only
 * `options.env`, never the parent env. The Deno + Node implementations live
 * in `server/server_deno.ts` / `server/server_node.ts`.
 *
 * Structural twin of the Rust backend's `crates/fuz_forge_server/src/subprocess.rs`,
 * kept in its own module on both backends. The data shapes carry the same names
 * there — `SpawnStreamingHandle`, `SpawnStreamingOptions`, `SpawnCollectResult`,
 * `SpawnCollectOptions`. The capability types `SpawnStreaming` and
 * `SpawnCollect` are TS-only by design: the Rust side calls its free
 * `spawn_streaming` / `spawn_collect` functions directly instead of injecting
 * them, so there is nothing on that side for the two to name.
 *
 * @module
 */

/**
 * Streaming subprocess handle used by the forge routes to bridge the
 * git smart-HTTP protocol into `git http-backend`.
 *
 * Web-stream-shaped on both runtimes:
 * - Deno: returned directly by `Deno.Command(...).spawn()`.
 * - Node: adapted via `Readable.toWeb` / `Writable.toWeb` (Node ≥ 18).
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
 * Runtime-provided streaming-subprocess primitive. Spawns `cmd` with the
 * given `args` and returns a `SpawnStreamingHandle`. Implementations
 * live in `server/server_deno.ts` (via `Deno.Command`) and `server/server_node.ts`
 * (via `node:child_process.spawn`).
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
 * Runtime-provided buffered-subprocess primitive. Spawns `cmd`, drains
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
 * Implementations live in `server/server_deno.ts` (via `Deno.Command(...).output()`)
 * and `server/server_node.ts` (via `node:child_process.spawn` + chunk accumulation).
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
