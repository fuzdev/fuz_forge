/**
 * Cross-process **`GET /api/server/status`** suite — run against BOTH
 * fuz_forge backends (Deno/Hono + Rust `fuz_forge_server`).
 *
 * The route is authenticated (`auth: account required, actor none`) and
 * returns the server version + uptime (`{version: string, uptime_ms: number}`,
 * a loose output schema). The frontend (`ui/capabilities.svelte.ts`) fetches
 * it after login to display server details.
 *
 * This suite exists because the route is the one client-facing endpoint no
 * other cross-test reaches: the standard round-trip bundle only generates
 * nil-id error inputs, never a populated success request here, so a backend
 * that omits the route 404s with nothing else to notice. The
 * wire CONTRACT — not the impl-specific version constant — is what parity
 * asserts: the two backends legitimately report different version strings (the
 * TS `build_info` `VERSION` vs the Rust crate version), so the success
 * assertion is on shape (a non-empty string + a non-negative number), plus the
 * `account: required` 401 on an anonymous request.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);

const STATUS_PATH = '/api/server/status';

describe('server status (cross-process, both backends)', () => {
	test('authenticated GET → 200 {version: string, uptime_ms: number}', async () => {
		const fixture = await setup_test();
		// `fixture.transport`'s jar carries the fresh keeper's session cookie, so
		// this resolves as an authenticated account (the route requires one).
		const response = await fixture.transport(STATUS_PATH, { method: 'GET' });

		assert.strictEqual(response.status, 200, 'authenticated status request must be 200');
		assert.strictEqual(
			response.headers.get('content-type')?.split(';')[0]?.trim(),
			'application/json',
			'status body must be JSON'
		);
		const body = await response.json();
		assert.strictEqual(typeof body.version, 'string', 'version must be a string');
		assert.ok(body.version.length > 0, 'version must be non-empty');
		assert.strictEqual(typeof body.uptime_ms, 'number', 'uptime_ms must be a number');
		assert.ok(body.uptime_ms >= 0, 'uptime_ms must be non-negative');
	});

	test('unauthenticated GET → 401', async () => {
		const fixture = await setup_test();
		// Cookie-jar-free probe: no credential resolves → `account: required` 401.
		const anon = fixture.fresh_transport({ origin: null });
		const response = await anon(STATUS_PATH, { method: 'GET' });

		assert.strictEqual(
			response.status,
			401,
			'server status requires authentication (account: required)'
		);
		await response.text(); // drain the body so the connection frees
	});
});
