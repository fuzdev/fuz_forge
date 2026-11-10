/**
 * Cross-process **body-size-limit 413 wire-shape** suite — run against BOTH
 * fuz_forge backends (TS/Hono + Rust `fuz_forge_server`) via the
 * `cross_backend_*` mechanism.
 *
 * The contract under test is the *shape* of the over-cap rejection: when a
 * request body exceeds the configured body-size cap, the backend must
 * short-circuit — before auth or validation — with the canonical flat REST
 * shape:
 *
 *   status 413, `Content-Type: application/json`, body `{error: "payload_too_large"}`
 *
 * TS owns the shape (fuz_app's `create_body_limit_middleware`, which the
 * forge's `generic_body_cap_middleware` applies to its capped groups). The Rust spine converged to it:
 * `fuz_http::body_limit_layer` wraps tower-http's `RequestBodyLimitLayer`
 * (which would otherwise reject with a plain-text `length limit exceeded`
 * body) in a response map that rewrites the 413 to
 * `fuz_http::rest_error::payload_too_large_response()`.
 *
 * **Cap-scoping parity.** Both backends cap every path at the generic 1 MiB
 * but the file store and git smart-HTTP, which own their caps (handler-enforced
 * + streamed):
 *
 *   - The **Rust** forge applies the 1 MiB `DEFAULT_BODY_LIMIT_BYTES` to every
 *     route group of its stack but `files` and `git` — `api`, `internal`,
 *     `probes`, and the fallback that answers every unrouted path.
 *   - The **TS** forge disables the spine's global `bodyLimit` (it would clip
 *     the streaming file route) and mounts `generic_body_cap_middleware`
 *     (`server/app_assembly.ts`) at every path, passing the file store and git
 *     smart-HTTP through.
 *
 * Cap-scoping parity is what the suite pins: an over-cap POST rejects with the
 * canonical JSON `{error: "payload_too_large"}` 413 on BOTH backends — at
 * `/api/rpc`, at a probe, and at an unrouted path.
 *
 * **Cap-before-origin.** The cap also has to fire *ahead of* the origin check,
 * so an over-cap POST carrying a disallowed `Origin` is a 413 rather than a
 * 403 — the request is refused on size, before anything reads a header. TS has
 * always answered that way (`generic_body_cap_middleware` is first in the
 * `transform_middleware` chain); Rust answered 403, because `origin_layer` was
 * a single global layer wrapping the whole router while `body_limit_layer` sat
 * on each nested group, and tower runs the outermost layer first. The Rust
 * router now composes through `fuz_http::compose_stack`, which mounts each
 * group's cap outside its origin check. The normal-size + bad-`Origin` control below is what keeps
 * this from passing on a backend that stopped checking `Origin` at all.
 *
 * The over-cap cases send the request head alone over a raw socket
 * (`raw_http_send_head`) — the over-cap `Content-Length` and no body — so the
 * 413 is read without an upload racing the close that follows it, and a
 * backend that read the body before refusing would fail them. The under-cap
 * cases post raw bytes straight through `fixture.transport` (not `rpc_call`,
 * which expects a JSON-RPC envelope back — the refusals are flat REST bodies).
 * No auth header is needed: the limit fires ahead of the auth middleware.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { ERROR_PAYLOAD_TOO_LARGE } from '@fuzdev/fuz_app/http/error_schemas.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';
import { raw_http_send_head } from '@fuzdev/fuz_app/testing/transports/raw_http.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url } = handle.config;

/** An origin no backend's `FUZ_ALLOWED_ORIGINS` admits (`http://localhost:*`). */
const DISALLOWED_ORIGIN = 'http://evil.invalid';

/** The shared 1 MiB cap both backends apply to `/api/*` (`DEFAULT_BODY_LIMIT_BYTES`). */
const BODY_LIMIT_DEFAULT_BYTES = 1024 * 1024;

/**
 * One byte over the cap — the smallest declared length that trips it. This
 * file holds the cap from above only; the at-cap body that must pass, and so
 * the boundary itself, is pinned by the shared `body_size` suite
 * (`spine_suites.cross.test.ts`).
 */
const OVERSIZED_CONTENT_LENGTH = BODY_LIMIT_DEFAULT_BYTES + 1;

/**
 * POST a request head to `path` (`/api/rpc` by default) declaring a body one
 * byte over the cap, and send none of it. Both backends answer the 413 on the
 * declared length, and the helper reads one whole response and stops rather
 * than wait on what the connection does next.
 */
const post_over_cap = (
	origin?: string,
	path = SPINE_RPC_PATH
): ReturnType<typeof raw_http_send_head> =>
	raw_http_send_head(base_url, {
		path,
		headers: origin
			? { 'Content-Type': 'application/json', Origin: origin }
			: { 'Content-Type': 'application/json' },
		content_length: OVERSIZED_CONTENT_LENGTH
	});

/** POST raw under-cap bytes to `/api/rpc` through the cross-process transport. */
const post_raw = (
	fixture: Awaited<ReturnType<typeof setup_test>>,
	body: string,
	origin?: string
): Promise<Response> =>
	fixture.transport(SPINE_RPC_PATH, {
		method: 'POST',
		headers: origin
			? { 'Content-Type': 'application/json', Origin: origin }
			: { 'Content-Type': 'application/json' },
		body
	});

describe('body limit 413 (cross-process, both backends)', () => {
	test('over-cap POST to /api/rpc → 413 JSON {error: "payload_too_large"}', async () => {
		await setup_test();
		const response = await post_over_cap();

		assert.strictEqual(response.status, 413, 'over-cap body must reject with 413');
		assert.strictEqual(
			response.headers['content-type']?.split(';')[0]?.trim(),
			'application/json',
			'413 body must be JSON'
		);
		assert.deepStrictEqual(
			JSON.parse(response.body),
			{ error: ERROR_PAYLOAD_TOO_LARGE },
			'413 body must be the canonical payload_too_large shape'
		);
	});

	test('over-cap POST with a disallowed Origin → 413, not 403', async () => {
		await setup_test();
		const response = await post_over_cap(DISALLOWED_ORIGIN);

		assert.strictEqual(
			response.status,
			413,
			'the body cap must run before the origin check on both backends'
		);
		assert.deepStrictEqual(JSON.parse(response.body), { error: ERROR_PAYLOAD_TOO_LARGE });
	});

	// Off the `/api` surface: a probe (GET-only, so a POST is the method refusal
	// once past the gates) and paths no route serves, one of them under `/api`.
	// The Rust stack caps its `probes` group and its fallback like any other
	// group, and the TS cap is mounted at every path, so each is the cap's 413
	// ahead of the route, the method refusal, the static fallback, and the
	// origin check. The last two are near-misses of the handler-owned file
	// store: its bare prefix with a trailing slash names no file, and a sibling
	// that shares the prefix's characters is another path, so both carry the
	// generic cap.
	for (const path of [
		'/health',
		'/nonexistent',
		'/api/nonexistent',
		'/api/fuz_forge/files/',
		'/api/fuz_forge/filesystem'
	]) {
		for (const origin of [undefined, DISALLOWED_ORIGIN]) {
			test(`over-cap POST to ${path}${origin ? ' with a disallowed Origin' : ''} → 413`, async () => {
				await setup_test();
				const response = await post_over_cap(origin, path);

				assert.strictEqual(response.status, 413, `${path} must carry the generic cap`);
				assert.deepStrictEqual(JSON.parse(response.body), { error: ERROR_PAYLOAD_TOO_LARGE });
			});
		}
	}

	test('under-cap POST with a disallowed Origin → 403 (origin still enforced)', async () => {
		// The control the case above needs: moving the cap ahead of the origin
		// check must not stop the origin check from running. Same request minus
		// the size, same disallowed `Origin`, and the answer flips to the
		// canonical origin refusal.
		const fixture = await setup_test();
		const response = await post_raw(
			fixture,
			JSON.stringify({ jsonrpc: '2.0', id: 'test', method: 'noop' }),
			DISALLOWED_ORIGIN
		);

		assert.strictEqual(response.status, 403, 'a disallowed Origin is still refused');
		assert.deepStrictEqual(await response.json(), { error: 'forbidden_origin' });
	});

	test('under-cap POST to /api/rpc passes the body limit (not 413)', async () => {
		const fixture = await setup_test();
		// A small body clears the limit on either backend; without auth it
		// resolves to some non-413 outcome (the size gate is the only thing
		// under test here).
		const response = await post_raw(
			fixture,
			JSON.stringify({ jsonrpc: '2.0', id: 'test', method: 'noop' })
		);

		assert.notStrictEqual(response.status, 413, 'an under-cap body must clear the body-size limit');
	});
});
