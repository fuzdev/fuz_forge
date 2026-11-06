/**
 * Cross-process **origin-check scope** suite — run against BOTH fuz_forge
 * backends (Deno/Hono + Rust `fuz_forge_server`) via the
 * `cross_backend_*` mechanism.
 *
 * The shared upstream `origin` suite (run in `spine_suites.cross.test.ts`) pins
 * what the origin check *does* on the RPC path. It says nothing about **where
 * the check is mounted**, which is exactly where the two backends can drift, so
 * this suite drives the paths outside `/api`.
 *
 * **The scope.** Every path is checked by default, with named carve-outs
 * only — the probes (`/health`, `/ready`), git smart-HTTP and the unrouted
 * fallback included. A request with no `Origin` passes the check, so a probe,
 * `git`, and the `fuzf` CLI are unaffected; what is refused is a page from a
 * foreign origin, on any path. The Rust router composes through
 * `fuz_http::compose_stack` (`router/compose.rs`), which checks every route
 * group and its fallback unless a group is carved out by name; the TS server
 * runs fuz_app's every-path check with the same carve-out passed as
 * `origin_carve_outs` (`FUZ_FORGE_ORIGIN_CARVE_OUTS`, `server/app_assembly.ts`):
 *
 * - **`/internal/*`** is the one carve-out — the loopback-gated hook callbacks.
 *   The in-handler gate already refuses any request carrying an `Origin` or
 *   `Referer` (`internal_callback.cross`), on top of a loopback peer check and
 *   a per-repo secret, and answers every refusal with one bare `401`, so a
 *   browser replay learns nothing about which fence it hit.
 * - **Git smart-HTTP stays checked** although its handlers refuse *any*
 *   `Origin` or `Referer` themselves (`repo_git_auth.cross`): `git` sends none,
 *   so the check only decides which refusal a browser replay sees — `403
 *   forbidden_origin` for a foreign page, the handler's generic `401` for an
 *   allowed one.
 *
 * **The file store and git own their body caps**, the one exception to
 * cap-before-origin: there an over-cap request with a foreign `Origin` is the
 * origin refusal, where every other group answers `413` first
 * (`body_limit.cross`).
 *
 * **Controls.** Every negative below is paired with a positive control on the
 * `/api` surface — RPC, the file store, and `/api/server/status` — so this
 * suite cannot pass on a backend that simply stopped checking `Origin`.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { raw_http_send_head } from '@fuzdev/fuz_app/testing/transports/raw_http.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url } = handle.config;

/** An origin no backend's `FUZ_ALLOWED_ORIGINS` admits (`http://localhost:*`). */
const DISALLOWED_ORIGIN = 'http://evil.invalid';

/** The canonical origin refusal body both backends emit (`fuz_http::rest_error`). */
const FORBIDDEN_ORIGIN_BODY = { error: 'forbidden_origin' };

/** One byte over the 1 MiB generic cap — and over nothing the handler-owned groups enforce. */
const OVER_GENERIC_CAP = 1024 * 1024 + 1;

/** GET `path` with the disallowed `Origin` attached, outside any cookie jar. */
const get_with_bad_origin = (path: string): Promise<Response> =>
	fetch(`${base_url}${path}`, { headers: { Origin: DISALLOWED_ORIGIN } });

/**
 * Assert a response is the canonical 403 origin refusal — status, JSON
 * content-type, and body. Repeating it per route group is what proves the check
 * is mounted on each of them and not just on one.
 */
const assert_forbidden_origin = async (res: Response, label: string): Promise<void> => {
	assert.strictEqual(res.status, 403, `${label}: expected the origin refusal`);
	assert.strictEqual(
		res.headers.get('content-type')?.split(';')[0]?.trim(),
		'application/json',
		`${label}: 403 body must be JSON`
	);
	assert.deepStrictEqual(await res.json(), FORBIDDEN_ORIGIN_BODY, `${label}: 403 body`);
};

describe('origin-check scope (cross-process, both backends)', () => {
	test('GET /health — no Origin → 200, a disallowed Origin → 403', async () => {
		await setup_test();
		assert.strictEqual((await fetch(`${base_url}/health`)).status, 200, 'a probe sends no Origin');
		await assert_forbidden_origin(await get_with_bad_origin('/health'), '/health');
	});

	test('GET /ready — no Origin → 200 {ready: true}, a disallowed Origin → 403', async () => {
		await setup_test();
		const ok = await fetch(`${base_url}/ready`);
		assert.strictEqual(ok.status, 200, 'the deploy gate sends no Origin');
		assert.deepStrictEqual(await ok.json(), { ready: true });
		await assert_forbidden_origin(await get_with_bad_origin('/ready'), '/ready');
	});

	test('an unrouted path with a disallowed Origin → 403', async () => {
		await setup_test();
		// the without-Origin answer is each backend's not-a-route fallback, a
		// 404 on both test spawns; the shared `origin_scope` suite pins that
		// status, so this case asserts only that it isn't the origin refusal
		const [with_origin, without_origin] = await Promise.all([
			get_with_bad_origin('/nonexistent'),
			fetch(`${base_url}/nonexistent`)
		]);
		assert.notStrictEqual(without_origin.status, 403, 'no Origin is never the origin refusal');
		await assert_forbidden_origin(with_origin, '/nonexistent');
	});

	test('git smart-HTTP with a disallowed Origin → 403, ahead of the git gate', async () => {
		await setup_test();
		// Anonymous: without the origin check the git gate answers its generic
		// 401 (`repo_git_auth.cross` pins it, and the allowed-Origin case)
		await assert_forbidden_origin(
			await get_with_bad_origin('/ttt/origin_scope.git/info/refs'),
			'git info/refs'
		);
	});

	test('POST /internal/repo-receive-callback with a disallowed Origin → bare 401 (carved out)', async () => {
		await setup_test();
		// The loopback + per-repo-secret gate answers, and it refuses *any*
		// `Origin`, so the origin check is carved out ahead of it — otherwise
		// a browser replay would learn which fence it hit.
		const res = await fetch(`${base_url}/internal/repo-receive-callback`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: DISALLOWED_ORIGIN },
			body: '{}'
		});
		assert.strictEqual(res.status, 401, 'the loopback + secret gate answers, not the origin check');
		assert.strictEqual(await res.text(), 'Unauthorized\n');
	});

	test('the file store owns its cap: an over-cap upload with a disallowed Origin → 403, not 413', async () => {
		await setup_test();
		const res = await raw_http_send_head(base_url, {
			path: '/api/fuz_forge/files/origin_scope_over_cap.bin',
			headers: { Origin: DISALLOWED_ORIGIN, 'Content-Type': 'application/octet-stream' },
			content_length: OVER_GENERIC_CAP
		});
		assert.strictEqual(res.status, 403, 'the handler-owned cap sits behind the origin check');
		assert.deepStrictEqual(JSON.parse(res.body), FORBIDDEN_ORIGIN_BODY);
	});

	test('git owns its cap: an over-cap push with a disallowed Origin → 403, not 413', async () => {
		await setup_test();
		const res = await raw_http_send_head(base_url, {
			path: '/ttt/origin_scope.git/git-receive-pack',
			headers: {
				Origin: DISALLOWED_ORIGIN,
				'Content-Type': 'application/x-git-receive-pack-request'
			},
			content_length: OVER_GENERIC_CAP
		});
		assert.strictEqual(res.status, 403, 'the handler-owned cap sits behind the origin check');
		assert.deepStrictEqual(JSON.parse(res.body), FORBIDDEN_ORIGIN_BODY);
	});

	test('control: POST /api/rpc with a disallowed Origin → 403 forbidden_origin', async () => {
		await setup_test();
		const res = await fetch(`${base_url}/api/rpc`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: DISALLOWED_ORIGIN },
			body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method: 'noop' })
		});
		await assert_forbidden_origin(res, '/api/rpc');
	});

	test('control: GET the file store with a disallowed Origin → 403 forbidden_origin', async () => {
		await setup_test();
		// The file-store group owns its cap but keeps the origin check, so it
		// is the group most easily lost in a router restructure.
		await assert_forbidden_origin(
			await get_with_bad_origin('/api/fuz_forge/files/origin_scope_absent.txt'),
			'/api/fuz_forge/files'
		);
	});

	test('control: GET /api/server/status with a disallowed Origin → 403 forbidden_origin', async () => {
		await setup_test();
		await assert_forbidden_origin(await get_with_bad_origin('/api/server/status'), '/api/server');
	});
});
