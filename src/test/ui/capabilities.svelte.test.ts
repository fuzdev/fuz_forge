/**
 * `Capabilities` probe independence — the three dashboard checks each own an
 * `AsyncSlot`, so a failure in one neither hides its own error nor pins the
 * others' retry.
 *
 * The regression this pins: the probes used to share one status field, so a
 * `check_server` that failed while `check_database` succeeded was never
 * retried (and swallowed its error outright), leaving `/admin/capabilities`
 * with a blank version and no way to tell "old server" from "call failed".
 *
 * `capabilities.svelte.ts` is a rune module with no DOM dependency, so it
 * runs here directly — no component harness.
 *
 * @module
 */

import { afterEach, assert, beforeEach, describe, test } from 'vitest';

import { BACKEND_PROBE_NOT_HEALTH } from '@fuzdev/fuz_app/ui/backend_probe.svelte.ts';

import { Capabilities } from '#lib/ui/capabilities.svelte.ts';

const HEALTH = '/health';
const SERVER_STATUS = '/api/server/status';
const DB_HEALTH = '/api/db/health';

const json_response = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});

const original_fetch = globalThis.fetch;

/** Every URL the stub was asked for, in call order. */
let calls: Array<string>;
/** Canned response per URL — an unrouted URL is a test bug, not a 404. */
let routes: Map<string, () => Response>;

const count_calls = (url: string): number => calls.filter((c) => c === url).length;

const url_of = (input: RequestInfo | URL): string =>
	typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

beforeEach(() => {
	calls = [];
	routes = new Map();
	globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
		const url = url_of(input);
		calls.push(url);
		const route = routes.get(url);
		if (!route) return Promise.reject(new Error(`unrouted fetch: ${url}`));
		return Promise.resolve(route());
	};
});

afterEach(() => {
	globalThis.fetch = original_fetch;
});

const route_all_ok = (): void => {
	routes.set(HEALTH, () => json_response({ status: 'ok' }));
	routes.set(SERVER_STATUS, () => json_response({ version: '0.1.0', uptime_ms: 1234 }));
	routes.set(DB_HEALTH, () =>
		json_response({ connected: true, type: 'postgres', name: 'fuz_forge', table_count: 12 })
	);
};

describe('Capabilities', () => {
	test('init runs all three probes and stamps each checked_at', async () => {
		route_all_ok();
		const capabilities = new Capabilities();

		await capabilities.init();

		assert.isTrue(capabilities.backend.succeeded);
		assert.isTrue(capabilities.server.succeeded);
		assert.isTrue(capabilities.database.succeeded);
		assert.isTrue(capabilities.backend_available);
		assert.strictEqual(capabilities.server.data?.version, '0.1.0');
		assert.strictEqual(capabilities.server.data?.uptime_ms, 1234);
		assert.strictEqual(capabilities.database.data?.type, 'postgres');
		assert.strictEqual(capabilities.database.data?.table_count, 12);
		assert.isNumber(capabilities.backend.data?.response_time);
		assert.isNumber(capabilities.backend_checked_at);
		assert.isNumber(capabilities.server_checked_at);
		assert.isNumber(capabilities.database_checked_at);
	});

	test('a failed server probe leaves the database probe intact and retries on the next init', async () => {
		route_all_ok();
		routes.set(SERVER_STATUS, () => json_response({ error: 'server status exploded' }, 500));
		const capabilities = new Capabilities();

		await capabilities.init();

		assert.isTrue(capabilities.backend.succeeded);
		assert.isTrue(capabilities.server.failed, 'the server probe reports its own failure');
		assert.strictEqual(capabilities.server.error, 'server status exploded');
		// `strictEqual`, not `isUndefined`: the latter narrows `data` to `never`
		// for the rest of the block and the retry assertions below stop compiling.
		assert.strictEqual(capabilities.server.data, undefined);
		assert.isTrue(capabilities.database.succeeded, 'the database probe is unaffected');

		// The retry: the server probe runs again, the two settled probes do not.
		routes.set(SERVER_STATUS, () => json_response({ version: '0.2.0', uptime_ms: 7 }));
		await capabilities.init();

		assert.isTrue(capabilities.server.succeeded);
		assert.strictEqual(capabilities.server.data?.version, '0.2.0');
		assert.strictEqual(capabilities.server.error, null);
		assert.strictEqual(count_calls(SERVER_STATUS), 2);
		assert.strictEqual(count_calls(HEALTH), 1);
		assert.strictEqual(count_calls(DB_HEALTH), 1);
	});

	test('a non-ok server status without an error body reports the status code', async () => {
		route_all_ok();
		routes.set(SERVER_STATUS, () => new Response('forbidden', { status: 403 }));
		const capabilities = new Capabilities();

		await capabilities.check_server();

		assert.isTrue(capabilities.server.failed);
		assert.strictEqual(capabilities.server.error, 'HTTP 403');
		assert.isNumber(capabilities.server_checked_at, 'a failed attempt still stamps checked_at');
	});

	test('a failed database probe leaves the server probe intact and retries on the next init', async () => {
		route_all_ok();
		routes.set(DB_HEALTH, () => json_response({ error: 'database_connection_failed' }, 503));
		const capabilities = new Capabilities();

		await capabilities.init();

		assert.isTrue(capabilities.server.succeeded);
		assert.isTrue(capabilities.database.failed);
		assert.strictEqual(capabilities.database.error, 'database_connection_failed');

		routes.set(DB_HEALTH, () => json_response({ connected: true, type: 'postgres', name: 'x' }));
		await capabilities.init();

		assert.isTrue(capabilities.database.succeeded);
		assert.strictEqual(capabilities.database.data?.table_count, null);
		assert.strictEqual(count_calls(DB_HEALTH), 2);
		assert.strictEqual(count_calls(SERVER_STATUS), 1);
	});

	test('an unreachable backend skips the two protected probes', async () => {
		route_all_ok();
		routes.set(HEALTH, () => new Response(null, { status: 503 }));
		const capabilities = new Capabilities();

		await capabilities.init();

		assert.isTrue(capabilities.backend.failed);
		assert.strictEqual(capabilities.backend.error, 'HTTP 503');
		assert.isFalse(capabilities.backend_available);
		assert.isTrue(capabilities.server.initial);
		assert.isTrue(capabilities.database.initial);
		assert.deepStrictEqual(calls, [HEALTH]);
	});

	test("a static fallback's 200 HTML on /health is not a backend", async () => {
		routes.set(
			HEALTH,
			() =>
				new Response('<!doctype html><html></html>', {
					status: 200,
					headers: { 'content-type': 'text/html' }
				})
		);
		const capabilities = new Capabilities();

		await capabilities.init();

		assert.isTrue(capabilities.backend.failed);
		assert.strictEqual(capabilities.backend.error, BACKEND_PROBE_NOT_HEALTH);
		assert.isFalse(capabilities.backend_available);
		assert.deepStrictEqual(calls, [HEALTH]);
	});

	test('a network throw on /health surfaces as a backend failure', async () => {
		const capabilities = new Capabilities();

		await capabilities.check_backend();

		assert.isTrue(capabilities.backend.failed);
		assert.strictEqual(capabilities.backend.error, `unrouted fetch: ${HEALTH}`);
	});

	test('init is idempotent — settled probes are not re-run', async () => {
		route_all_ok();
		const capabilities = new Capabilities();

		await capabilities.init();
		await capabilities.init();

		assert.strictEqual(count_calls(HEALTH), 1);
		assert.strictEqual(count_calls(SERVER_STATUS), 1);
		assert.strictEqual(count_calls(DB_HEALTH), 1);
	});

	test('each probe is refreshable on its own', async () => {
		route_all_ok();
		const capabilities = new Capabilities();
		await capabilities.init();

		await capabilities.check_database();

		assert.strictEqual(count_calls(DB_HEALTH), 2);
		assert.strictEqual(count_calls(SERVER_STATUS), 1);
		assert.strictEqual(count_calls(HEALTH), 1);
	});
});
