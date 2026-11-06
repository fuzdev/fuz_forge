/**
 * Cross-process **CORS simple-request refusal** for fuz_forge, run against BOTH
 * forge backends (Deno/Hono + Rust `fuz_forge_server`).
 *
 * A `POST` with no `Content-Type`, or a `text/plain` / form / multipart one, is
 * what a browser sends cross-origin without a preflight. The shared
 * `@fuzdev/fuz_app` suite, run in the one call (`spine_suites.cross.test.ts`),
 * pins the spine's JSON routes (RPC, login, logout) refusing it with the flat
 * `415 {error: 'unsupported_content_type'}`.
 *
 * The forge-local cases pin the forge's own `POST` routes, which the spine
 * doesn't own. Each refusal carries no credential and is paired with a typed
 * control that reaches the route's own auth gate, so the 415 can only be the
 * content type:
 *
 * - the raw-byte routes — the file-store upload and the two git smart-HTTP
 *   `POST`s — take any type but none or a safelisted one (TS `raw_body: true`;
 *   Rust checks `fuz_http::is_cors_simple_content_type` first in each handler)
 * - the post-receive callback is a JSON route, so it takes only
 *   `application/json` (TS route pipeline; Rust `is_json_content_type` ahead
 *   of the loopback gate)
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url } = handle.config;

/** The canonical content-type refusal body both backends emit. */
const UNSUPPORTED_CONTENT_TYPE_BODY = { error: 'unsupported_content_type' };

/** POST `path` anonymously, with `content_type` when given. */
const post = (path: string, content_type: string | null): Promise<Response> =>
	fetch(`${base_url}${path}`, {
		method: 'POST',
		headers: content_type === null ? {} : { 'Content-Type': content_type },
		body: content_type === null ? undefined : 'x'
	});

const assert_refused = async (res: Response, label: string): Promise<void> => {
	assert.strictEqual(res.status, 415, `${label} must be refused with 415`);
	assert.deepStrictEqual(await res.json(), UNSUPPORTED_CONTENT_TYPE_BODY, label);
};

/** A grammar-valid repo path; no repo needs to exist, since auth answers first. */
const GIT_REPO_PATH = '/probe/repo.git';

const RAW_ROUTES = [
	{ path: '/api/fuz_forge/files/tools/probe.txt', typed: 'application/octet-stream' },
	{ path: `${GIT_REPO_PATH}/git-upload-pack`, typed: 'application/x-git-upload-pack-request' },
	{ path: `${GIT_REPO_PATH}/git-receive-pack`, typed: 'application/x-git-receive-pack-request' }
] as const;

describe('forge POST routes refuse CORS simple requests (cross-process, both backends)', () => {
	for (const route of RAW_ROUTES) {
		test(`raw-byte POST ${route.path}: untyped, text/plain, and form → 415; typed → 401`, async () => {
			await setup_test();
			await assert_refused(await post(route.path, null), `untyped POST ${route.path}`);
			await assert_refused(await post(route.path, 'text/plain'), `text/plain POST ${route.path}`);
			await assert_refused(
				await post(route.path, 'application/x-www-form-urlencoded'),
				`form POST ${route.path}`
			);
			const typed = await post(route.path, route.typed);
			assert.strictEqual(typed.status, 401, `typed POST ${route.path} reaches the auth gate`);
		});
	}

	test('the post-receive callback takes only application/json', async () => {
		await setup_test();
		const path = '/internal/repo-receive-callback';
		await assert_refused(await post(path, null), 'untyped callback');
		await assert_refused(await post(path, 'text/plain'), 'text/plain callback');
		await assert_refused(await post(path, 'application/octet-stream'), 'octet-stream callback');
		// no secret header, so the loopback gate's bare 401 answers
		const typed = await post(path, 'application/json');
		assert.strictEqual(typed.status, 401, 'a JSON callback reaches the loopback gate');
	});
});
