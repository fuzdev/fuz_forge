/**
 * Tests for `generic_body_cap_middleware` (`server/app_assembly.ts`) — the
 * forge's body cap over its capped route groups, on a bare Hono app.
 *
 * The cap itself is fuz_app's `create_body_limit_middleware`, tested there;
 * what the forge owns is the scoping (every path but the file store and git),
 * and that inside a capped group a `Content-Length` the cap
 * cannot read is refused rather than passed on uncounted.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Hono } from 'hono';
import {
	ERROR_INVALID_CONTENT_LENGTH,
	ERROR_PAYLOAD_TOO_LARGE
} from '@fuzdev/fuz_app/http/error_schemas.ts';

import { generic_body_cap_middleware } from '#lib/server/app_assembly.ts';

/** The cap the capped groups carry (`GENERIC_BODY_CAP_BYTES`). */
const CAP_BYTES = 1024 * 1024;

interface TestApp {
	app: Hono;
	/** How many requests reached a handler. */
	handled: () => number;
}

/** A bare app behind the cap whose every route answers 200. */
const create_test_app = (): TestApp => {
	let handled = 0;
	const app = new Hono();
	const spec = generic_body_cap_middleware();
	app.use(spec.path, spec.handler);
	app.all('*', (c) => {
		handled++;
		return c.json({ ok: true });
	});
	return { app, handled: () => handled };
};

const post = (app: Hono, path: string, content_length: string): Response | Promise<Response> =>
	app.request(path, { method: 'POST', headers: { 'content-length': content_length }, body: 'x' });

/** `Content-Length` values that are not a plain run of ASCII digits. */
const UNREADABLE_CONTENT_LENGTHS = ['abc', '-1', '+5', '1e9', '0x1F4', '5, 500', '50, 50'];

/**
 * Every path but the file store and git smart-HTTP — the `/api` and
 * `/internal` surfaces, the probes, the SPA, unrouted paths, and the near
 * misses of the two exempt shapes, which the Rust stack's fallback caps.
 */
const CAPPED_PATHS = [
	'/api/rpc',
	'/internal/repo-receive-callback',
	'/health',
	'/ready',
	'/',
	'/nonexistent',
	'/api/nonexistent',
	'/api/fuz_forge/filesystem',
	'/api/fuz_forge/files/',
	'/org/repo.git/info/refs/extra',
	'/org/team/repo.git/git-receive-pack',
	'/repo.git/git-upload-pack'
];

/** The file store and git smart-HTTP — the two groups that own their caps. */
const UNCAPPED_PATHS = [
	'/api/fuz_forge/files',
	'/api/fuz_forge/files/abc',
	'/org/repo.git/info/refs',
	'/org/repo.git/git-upload-pack',
	'/org/repo.git/git-receive-pack'
];

/** A body of `size` bytes with no `Content-Length`, as a chunked upload arrives. */
const streamed_body = (size: number): ReadableStream<Uint8Array> => {
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= size) {
				controller.close();
				return;
			}
			const chunk = new Uint8Array(Math.min(64 * 1024, size - sent));
			sent += chunk.length;
			controller.enqueue(chunk);
		}
	});
};

const post_streamed = (app: Hono, path: string, size: number): Response | Promise<Response> =>
	app.request(
		new Request(`http://localhost${path}`, {
			method: 'POST',
			body: streamed_body(size),
			// `duplex: 'half'` is required when a Request carries a stream body
			duplex: 'half'
		} as RequestInit)
	);

describe('generic_body_cap_middleware', () => {
	describe('capped groups', () => {
		for (const path of CAPPED_PATHS) {
			for (const content_length of UNREADABLE_CONTENT_LENGTHS) {
				test(`${path} refuses Content-Length ${JSON.stringify(content_length)} with 400`, async () => {
					const { app, handled } = create_test_app();
					const res = await post(app, path, content_length);
					assert.strictEqual(res.status, 400);
					assert.deepEqual(await res.json(), { error: ERROR_INVALID_CONTENT_LENGTH });
					assert.strictEqual(res.headers.get('connection'), 'close');
					assert.strictEqual(handled(), 0, 'the request must not reach a handler');
				});
			}

			test(`${path} refuses a Content-Length over the cap with 413`, async () => {
				const { app, handled } = create_test_app();
				const res = await post(app, path, String(CAP_BYTES + 1));
				assert.strictEqual(res.status, 413);
				assert.deepEqual(await res.json(), { error: ERROR_PAYLOAD_TOO_LARGE });
				assert.strictEqual(res.headers.get('connection'), 'close');
				assert.strictEqual(handled(), 0);
			});

			test(`${path} passes a Content-Length at the cap`, async () => {
				const { app, handled } = create_test_app();
				const res = await post(app, path, String(CAP_BYTES));
				assert.strictEqual(res.status, 200);
				assert.strictEqual(handled(), 1);
			});
		}
	});

	describe('uncapped groups', () => {
		for (const path of UNCAPPED_PATHS) {
			test(`${path} is not read by the cap`, async () => {
				const { app, handled } = create_test_app();
				// over the cap, and unreadable: neither is this middleware's to judge
				// on a route that enforces its own limit
				assert.strictEqual((await post(app, path, String(CAP_BYTES + 1))).status, 200);
				assert.strictEqual((await post(app, path, 'abc')).status, 200);
				assert.strictEqual(handled(), 2);
			});
		}
	});

	describe('streamed and bodiless requests', () => {
		for (const path of CAPPED_PATHS) {
			test(`${path} refuses a streamed body over the cap before any handler runs`, async () => {
				const { app, handled } = create_test_app();
				const res = await post_streamed(app, path, CAP_BYTES + 1);
				assert.strictEqual(res.status, 413);
				assert.deepEqual(await res.json(), { error: ERROR_PAYLOAD_TOO_LARGE });
				// rests on the body limit buffering up to the cap before the next handler runs
				assert.strictEqual(handled(), 0, 'the request must not reach a handler');
			});

			test(`${path} passes a streamed body at the cap`, async () => {
				const { app, handled } = create_test_app();
				const res = await post_streamed(app, path, CAP_BYTES);
				assert.strictEqual(res.status, 200);
				assert.strictEqual(handled(), 1);
			});

			test(`${path} refuses a bodiless request declaring a Content-Length over the cap`, async () => {
				const { app, handled } = create_test_app();
				const res = await app.request(path, {
					method: 'GET',
					headers: { 'content-length': String(CAP_BYTES + 1) }
				});
				assert.strictEqual(res.status, 413);
				assert.strictEqual(handled(), 0);
			});
		}

		for (const path of UNCAPPED_PATHS) {
			test(`${path} does not count a streamed body`, async () => {
				const { app, handled } = create_test_app();
				const res = await post_streamed(app, path, CAP_BYTES + 1);
				assert.strictEqual(res.status, 200);
				assert.strictEqual(handled(), 1);
			});
		}
	});
});
