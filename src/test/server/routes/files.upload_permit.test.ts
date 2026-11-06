/**
 * Unit tests for the upload route's concurrency permit — no DB. The handler
 * runs on a bare Hono app with no dispatcher, so the request context can carry
 * no acting actor, the state the dispatcher's authorization phase rules out.
 *
 * @module
 */

import { Hono } from 'hono';
import { assert, describe, test } from 'vitest';
import type { Account } from '@fuzdev/fuz_app/auth/account_schema.ts';
import { REQUEST_CONTEXT_KEY, type RequestContext } from '@fuzdev/fuz_app/auth/request_context.ts';
import { to_route_response, type RouteContext } from '@fuzdev/fuz_app/http/route_spec.ts';
import { create_throwing_stub } from '@fuzdev/fuz_app/testing/stubs.ts';
import { AsyncSemaphore } from '@fuzdev/fuz_util/async.ts';

import { create_file_route_specs } from '#lib/server/routes/files.ts';
import { test_file_route_deps } from './fuz_forge_test_helpers.ts';

/** Counts `acquire` calls, so a test can tell whether a request took a permit. */
class CountingSemaphore extends AsyncSemaphore {
	acquired = 0;

	override acquire(): Promise<void> {
		this.acquired++;
		return super.acquire();
	}
}

describe('POST /:filename upload permit', () => {
	test('a request with no acting actor fails without taking a permit', async () => {
		const upload_semaphore = new CountingSemaphore(1);
		const specs = create_file_route_specs(
			test_file_route_deps({
				query_deps: create_throwing_stub('query_deps'),
				max_upload_bytes: 1024,
				fact_store: create_throwing_stub('fact_store'),
				upload_semaphore
			})
		);
		const upload = specs.find((spec) => spec.method === 'POST' && spec.path === '/:filename{.+}');
		assert.ok(upload, 'the upload route spec exists');

		const request_context: RequestContext = {
			account: create_throwing_stub<Account>('account'),
			actor: null,
			role_grants: []
		};
		const errors: Array<unknown> = [];
		const app = new Hono();
		app.onError((err, c) => {
			errors.push(err);
			return c.text('error', 500);
		});
		app.use(async (c, next) => {
			c.set(REQUEST_CONTEXT_KEY, request_context);
			await next();
		});
		app.post(upload.path, async (c) =>
			to_route_response(c, await upload.handler(c, create_throwing_stub<RouteContext>('route')))
		);

		const res = await app.request('/a.txt', {
			method: 'POST',
			body: 'bytes',
			headers: { 'Content-Length': '5' }
		});

		assert.strictEqual(res.status, 500);
		assert.strictEqual(errors.length, 1);
		const [error] = errors;
		assert(error instanceof Error);
		assert.match(error.message, /no acting actor/);
		assert.strictEqual(upload_semaphore.acquired, 0);
	});
});
