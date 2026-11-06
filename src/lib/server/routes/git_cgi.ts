/**
 * `git http-backend` CGI streaming proxy for the forge smart-HTTP routes.
 *
 * Twin of `crates/fuz_forge_server/src/forge_git/cgi.rs`.
 * `proxy_to_git_http_backend` is a thin orchestrator over named streaming
 * stages, in this fixed order (the ordering is load-bearing — guarded by
 * `repo_push.cross.test.ts` + `repo_git.cgi_head.db.test.ts`):
 *
 * 1. `build_cgi_env` — pure CGI env map.
 * 2. `spawn_http_backend` — spawn `git http-backend` (503 if the
 *    primitive isn't wired).
 * 3. `drain_stderr` — background stderr drain; returns an accessor so the
 *    error paths can surface it (the Rust twin fire-and-forget logs — the only
 *    stage that diverges in shape).
 * 4. `pipe_request_body` — stream the request body into stdin (background).
 * 5. `read_cgi_head` — drain stdout until the CGI separator (502 on EOF /
 *    cap overflow).
 * 6. `parse_cgi_head` — CGI head parse (takes `deps` only to log a
 *    dropped header).
 *
 * The response is then `new Response(body_stream, {status, headers})` — the TS
 * runtime reaps the child and the `Headers` object has no default-header
 * collision, so the Rust `reap_child` / `build_proxy_response` /
 * `apply_cgi_headers` stages have no TS analog. The one behavior
 * `apply_cgi_headers` does carry — dropping a header the HTTP layer refuses —
 * lives inside `parse_cgi_head` here.
 *
 * @module
 */

import type { Context } from 'hono';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import type { RuntimeDeps } from '@fuzdev/fuz_app/runtime/deps.ts';
import { get_client_ip } from '@fuzdev/fuz_app/http/client_ip.ts';

import { repo_path } from '../../fuz_forge/repo/storage.ts';
import { concat_uint8 } from '../../runtime/bytes.ts';
import type { SpawnStreaming, SpawnStreamingHandle } from '../subprocess.ts';
import type { GitAuthOk } from './repo_git_auth.ts';

/** Dependencies for the CGI streaming proxy. */
export interface GitCgiDeps {
	runtime: RuntimeDeps;
	spawn_streaming: SpawnStreaming | undefined;
	log: Logger;
}

/** The CGI request shape passed to `proxy_to_git_http_backend`. */
interface ProxyOptions {
	request_method: 'GET' | 'POST';
	path_info: string;
	query_string: string;
}

/**
 * Build the CGI-shaped env passed to `git http-backend`. The env is the
 * minimal set the binary needs plus `PATH` (so it can locate its
 * helper subcommands) and the two push-attribution vars consumed by
 * the post-receive hook script.
 *
 * `GIT_HTTP_EXPORT_ALL` is intentionally NOT set — per-repo
 * `http.receivepack=true` / `http.uploadpack=true` is the single source
 * of truth for "this repo is exportable over HTTP" (see
 * `repo/storage.ts`).
 */
const build_cgi_env = (
	deps: GitCgiDeps,
	auth: GitAuthOk,
	c: Context,
	options: ProxyOptions
): Record<string, string> => {
	const project_root = repo_path(deps.runtime, auth.repo_id).replace(/\/[^/]+\.git$/, '');
	const content_type = c.req.header('Content-Type');
	const content_encoding = c.req.header('Content-Encoding') ?? '';
	const env: Record<string, string> = {
		GIT_PROJECT_ROOT: project_root,
		PATH_INFO: options.path_info,
		REQUEST_METHOD: options.request_method,
		QUERY_STRING: options.query_string,
		REMOTE_USER: auth.username,
		REMOTE_ADDR: get_client_ip(c),
		FUZ_FORGE_PUSH_ACCOUNT_ID: auth.account_id,
		FUZ_FORGE_PUSH_USERNAME: auth.username,
		// `git http-backend` execs git-upload-pack / git-receive-pack — both
		// need to find each other on PATH. A fixed, minimal PATH (NOT the
		// daemon's inherited PATH) keeps the subprocess env controlled — the
		// env-isolation posture, matching the Rust twin's `cgi.rs` hardcode.
		// The deploy host's git binaries must resolve within these dirs.
		PATH: '/usr/local/bin:/usr/bin:/bin',
		// Hint git's interactive prompts off — should never trigger over
		// the HTTP backend but cheap defense.
		GIT_TERMINAL_PROMPT: '0',
		// `/etc/gitconfig` is outside the forge's control, and `git http-backend`
		// execs `git-receive-pack` under it: a system-wide `core.hooksPath` would
		// point the push path at hooks the forge never installed, bypassing the
		// per-repo `pre-receive` force-push guard and the `post-receive` callback.
		// `HOME` is already absent (so `~/.gitconfig` is out of reach); this closes
		// the remaining tier, matching `git/read.ts`'s `git_env`.
		GIT_CONFIG_NOSYSTEM: '1'
	};
	// Set `CONTENT_TYPE` only when the request carries the header (matching the
	// Rust twin, which omits it when absent) — not an empty-string default.
	if (content_type !== undefined) env.CONTENT_TYPE = content_type;
	if (content_encoding) env.HTTP_CONTENT_ENCODING = content_encoding;
	return env;
};

/**
 * Spawn `git http-backend` with the CGI `env`. Returns the streaming handle, or
 * a 503 `Response` when the streaming subprocess primitive isn't wired (e.g. a
 * Node test run without `spawn_streaming`).
 */
const spawn_http_backend = (
	deps: GitCgiDeps,
	c: Context,
	env: Record<string, string>
): SpawnStreamingHandle | Response => {
	const spawn = deps.spawn_streaming;
	if (!spawn) {
		deps.log.error('repo_git: spawn_streaming not configured');
		return c.text('Forge subprocess unavailable\n', 503);
	}
	return spawn('git', ['http-backend'], { env });
};

/**
 * Drain the subprocess stderr to a chunk buffer in the background, returning an
 * accessor that decodes whatever has accumulated so far. The error paths fold
 * the result into the server log (CGI-head parse failure → 502 message; a
 * non-2xx CGI status → warn). The Rust twin fire-and-forget logs instead — this
 * accessor shape is the deliberate idiom divergence.
 */
const drain_stderr = (handle: SpawnStreamingHandle): (() => string) => {
	const stderr_chunks: Array<Uint8Array> = [];
	const stderr_reader = handle.stderr.getReader();
	void (async () => {
		try {
			for (;;) {
				const { done, value } = await stderr_reader.read();
				if (done) break;
				stderr_chunks.push(value);
			}
		} catch {
			// reader cancelled — nothing to do
		}
	})();
	return () => new TextDecoder().decode(concat_uint8(stderr_chunks));
};

/**
 * Pipe the request body (if any) into the subprocess stdin in the background;
 * a pipe failure aborts the subprocess. POST always carries a body
 * (advertisement is a GET); a GET closes stdin promptly so the subprocess
 * doesn't wait for input. Mirrors the Rust `pipe_request_body`.
 */
const pipe_request_body = (
	handle: SpawnStreamingHandle,
	c: Context,
	deps: GitCgiDeps,
	path_info: string
): void => {
	const body = c.req.raw.body;
	if (body) {
		void body.pipeTo(handle.stdin).catch((err: unknown) => {
			deps.log.warn(`repo_git: stdin pipe failed for ${path_info}: ${String(err)}`);
			handle.kill('SIGTERM');
		});
	} else {
		void handle.stdin.close().catch(() => {
			/* ignore: subprocess may have already exited */
		});
	}
};

/**
 * Spawn `git http-backend`, pipe the request body in, and stream the
 * subprocess stdout back as the HTTP response. Headers emitted by the
 * subprocess (the CGI `Status:` line + arbitrary `Header: value` lines
 * before the blank line) are parsed and reflected onto the response.
 */
export const proxy_to_git_http_backend = async (
	deps: GitCgiDeps,
	c: Context,
	auth: GitAuthOk,
	options: ProxyOptions
): Promise<Response> => {
	const env = build_cgi_env(deps, auth, c, options);
	const handle = spawn_http_backend(deps, c, env);
	if (handle instanceof Response) return handle;

	const read_stderr = drain_stderr(handle);
	pipe_request_body(handle, c, deps, options.path_info);

	// Parse CGI headers from the subprocess stdout, then forward the
	// remaining bytes as the response body.
	let head_buffer: Uint8Array;
	let body_stream: ReadableStream<Uint8Array>;
	try {
		const parsed = await read_cgi_head(handle.stdout);
		head_buffer = parsed.head_buffer;
		body_stream = parsed.body_stream;
	} catch (err) {
		// Subprocess closed stdout without writing the CGI header separator
		// (or blew past the header size cap). Don't emit a default 200 with
		// truncated bytes — surface as 502 and log the stderr drained so far.
		await handle.status.catch(() => undefined);
		const reason = to_error_message(err);
		deps.log.error(
			`repo_git: git http-backend CGI head parse failed (${reason}); stderr: ${read_stderr().trim()}`
		);
		return c.text('Forge subprocess error\n', 502);
	}
	const { status, headers } = parse_cgi_head(deps, head_buffer);

	// On non-200 from a CGI subprocess, surface stderr to the log too —
	// useful when the binary refuses a request.
	if (status >= 400) {
		void handle.status.then(() => {
			const stderr_text = read_stderr();
			if (stderr_text.trim()) {
				deps.log.warn(`repo_git: git http-backend stderr: ${stderr_text.trim()}`);
			}
		});
	}

	return new Response(body_stream, { status, headers });
};

/**
 * Maximum bytes we'll accumulate looking for the CGI header / body
 * separator. `git http-backend` only emits a handful of headers
 * (`Status`, `Content-Type`, occasional `Cache-Control` /
 * `Content-Length`), so anything past 64 KiB without a blank line is
 * either a runaway subprocess or a malformed response — fail loud
 * rather than buffer indefinitely.
 */
const CGI_HEAD_MAX_BYTES = 64 * 1024;

/**
 * Read CGI headers from the subprocess stdout. Returns the captured
 * head bytes and a follow-up stream that yields the remaining body
 * bytes. The first `\r\n\r\n` or `\n\n` separator is consumed.
 *
 * Throws if stdout closes before the separator appears, or if the
 * unfinished head crosses `CGI_HEAD_MAX_BYTES`. The caller
 * (`proxy_to_git_http_backend`) maps both to HTTP 502 instead of
 * defaulting to a 200 with truncated bytes.
 */
const read_cgi_head = async (
	stdout: ReadableStream<Uint8Array>
): Promise<{ head_buffer: Uint8Array; body_stream: ReadableStream<Uint8Array> }> => {
	const reader = stdout.getReader();
	const head_chunks: Array<Uint8Array> = [];
	let accumulated = 0;
	let leftover: Uint8Array | null = null;
	let head_buffer: Uint8Array | null = null;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		head_chunks.push(value);
		accumulated += value.length;
		const joined = concat_uint8(head_chunks);
		const idx = find_double_newline(joined);
		if (idx >= 0) {
			head_buffer = joined.slice(0, idx);
			leftover = joined.slice(idx);
			break;
		}
		if (accumulated > CGI_HEAD_MAX_BYTES) {
			// Release the reader so the subprocess sees a closed stdout and
			// exits; caller drains stderr + returns 502.
			reader.cancel().catch(() => undefined);
			throw new Error(`CGI head exceeded ${CGI_HEAD_MAX_BYTES} bytes without a separator`);
		}
	}

	if (head_buffer === null) {
		throw new Error('CGI head missing separator before stdout EOF');
	}

	const body_stream = new ReadableStream<Uint8Array>({
		start(controller) {
			if (leftover && leftover.length > 0) controller.enqueue(leftover);
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (err) {
				controller.error(err);
			}
		},
		cancel() {
			void reader.cancel();
		}
	});

	return { head_buffer, body_stream };
};

/**
 * Locate the first CGI header-body separator (`\n\n` after `\r` normalization).
 * Returns the offset of the byte AFTER the blank-line terminator, or -1.
 */
const find_double_newline = (buf: Uint8Array): number => {
	for (let i = 0; i < buf.length - 1; i++) {
		// \n\n
		if (buf[i] === 0x0a && buf[i + 1] === 0x0a) return i + 2;
		// \r\n\r\n
		if (
			i + 3 < buf.length &&
			buf[i] === 0x0d &&
			buf[i + 1] === 0x0a &&
			buf[i + 2] === 0x0d &&
			buf[i + 3] === 0x0a
		) {
			return i + 4;
		}
	}
	return -1;
};

/**
 * Exactly three ASCII digits — the shape the leading `Status:` token must have
 * before `parse_cgi_status` range-checks it.
 */
const CGI_STATUS_CODE_PATTERN = /^\d{3}$/;

/**
 * Parse a CGI `Status:` value's code: the leading space/tab-delimited token of
 * `"<code> <reason>"`. Returns `null` — leaving the CGI default 200 — unless
 * the token is three ASCII digits in 200-599 excluding the null-body statuses
 * (204/205/304) — the set both runtimes can emit: `new Response` throws
 * outside 200-599 and on a null-body status with a stream body (a 500, plus
 * an unreaped `git http-backend` child) where the Rust twin would answer the
 * code verbatim. Splitting on `[ \t]` rather than `\s` is the same parity concern —
 * JS `\s` matches U+FEFF and Rust whitespace does not. Twin of the Rust
 * `parse_cgi_status` (`forge_git/cgi.rs`); `git http-backend` only ever emits
 * 2xx-5xx, so the shared rule refuses nothing real.
 */
const parse_cgi_status = (value: string): number | null => {
	const code = value.split(/[ \t]/)[0] ?? '';
	if (!CGI_STATUS_CODE_PATTERN.test(code)) return null;
	const status = Number(code);
	if (status < 200 || status > 599) return null;
	if (status === 204 || status === 205 || status === 304) return null;
	return status;
};

/**
 * Parse a CGI header block into `{status, headers}`. Lines look like:
 *
 *   Status: 200 OK
 *   Content-Type: application/x-git-upload-pack-advertisement
 *   Cache-Control: no-cache
 *
 * If `Status:` is absent the response defaults to 200 (CGI convention).
 *
 * A header the `Headers` API refuses — an invalid name, or a value carrying a
 * byte like a lone `\r` (not a line break on either side, so it folds into the
 * preceding value) — is **skipped**, not fatal, matching the Rust twin's
 * `apply_cgi_headers`, which drops it. The head comes from `git
 * http-backend`'s stdout, so a malformed header is a subprocess anomaly worth
 * a debug breadcrumb, not a failed request.
 */
const parse_cgi_head = (
	deps: GitCgiDeps,
	head_buffer: Uint8Array
): { status: number; headers: Headers } => {
	const text = new TextDecoder().decode(head_buffer);
	const headers = new Headers();
	let status = 200;
	for (const raw_line of text.split(/\r?\n/)) {
		if (!raw_line) continue;
		const colon = raw_line.indexOf(':');
		if (colon < 0) continue;
		const name = raw_line.slice(0, colon).trim();
		const value = raw_line.slice(colon + 1).trim();
		if (name.toLowerCase() === 'status') {
			const parsed = parse_cgi_status(value);
			if (parsed !== null) status = parsed;
			continue;
		}
		try {
			headers.append(name, value);
		} catch {
			deps.log.debug(`repo_git: dropping unrepresentable CGI header ${JSON.stringify(name)}`);
		}
	}
	return { status, headers };
};
