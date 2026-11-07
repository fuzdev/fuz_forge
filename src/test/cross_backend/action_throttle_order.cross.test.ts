/**
 * Cross-process **throttle-before-validate** pin — run against BOTH forge
 * backends via the limiter-enabled `cross_backend_login_security_*` spawn pair.
 *
 * The action dispatcher runs its phases in one order — authenticate (401),
 * authorize, role gate (403), **rate limit (429)**, then input validation
 * (400) — and the 429/400 adjacency is the one a hand-written twin gets wrong
 * cheaply. Validating first looks harmless and is not: it hands a throttled
 * caller a free schema oracle, letting them probe an action's input shape
 * indefinitely at zero budget cost, and it makes the refusal a client reads
 * depend on the shape of the request rather than on the state of its bucket.
 *
 * This runs here rather than in the standard projects because it needs the
 * limiters **live**, which those disable by design (their suites fire hundreds
 * of round trips from one host). Those spawns cap both action limiters at
 * `LOGIN_SECURITY_ACTION_RATE_LIMIT_MAX_ATTEMPTS`, so a case spends a full
 * per-account budget in a few calls; the production bounds the cap replaces
 * (`fixtures/parity/rate_limits.json`) are pinned in-process on both
 * backends (`server/action_rate_limit_bounds.test.ts`,
 * `router::compose::tests`). It uses its own **dedicated admin account**, so
 * exhausting a per-account budget can't reach the other cases sharing the
 * spawn.
 *
 * `fuz_forge_token_policy_list` is the cheapest `rate_limit: 'account'` action
 * the forge mounts — read-only, session-only, admin-gated, no-arg — so the
 * budget can be spent without writing anything. The malformed probe reuses the
 * same method with an undeclared key: its input is a strict `object`, so a
 * dispatcher that validated first would answer `invalid_params`.
 *
 * **Both transports, one bucket.** The method is mounted on HTTP RPC and on
 * the `/api/ws` socket, and a server holds one account limiter, so the budget
 * is per account, not per transport. The second case spends it across both and
 * probes on each: a WS mount holding its own limiter, or none, would still have
 * budget left after the HTTP spend and answer the socket probe
 * `invalid_params`, failing there.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { JSONRPC_VERSION } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import { test_if } from '@fuzdev/fuz_app/testing/cross_backend/capabilities.ts';
import { create_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';
import {
	is_response_for,
	type JsonrpcErrorResponseFrame,
	type WsClient
} from '@fuzdev/fuz_app/testing/transports/ws_client.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { TEST_ORIGIN } from '@fuzdev/fuz_app/testing/test_origin.ts';
import { fuz_forge_token_policy_list_action_spec } from '#lib/action_specs.ts';

import { LOGIN_SECURITY_ACTION_RATE_LIMIT_MAX_ATTEMPTS } from './fuz_forge_backend_config.ts';
import { post_envelope, type CrossFixture, type RpcPostResult } from './rpc_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url, ws_path, capabilities } = handle.config;

const METHOD = fuz_forge_token_policy_list_action_spec.method;

/**
 * The per-account action budget the spawn was started with — the test cap,
 * which replaces both action limiters' `max_attempts` on both backends.
 * Spending exactly the budget leaves the bucket full; the probe that follows
 * is the refusal.
 */
const ACCOUNT_BUDGET = LOGIN_SECURITY_ACTION_RATE_LIMIT_MAX_ATTEMPTS;

/**
 * Action-classed calls the fixture's own `create_account({roles: [ROLE_ADMIN]})`
 * already charged to this account before the test body runs, each driven as
 * the new account and declared `rate_limit: 'account'` on both spines:
 * `account_token_create` (from `mint_account`) and the admin role's
 * `role_grant_offer_accept`.
 *
 * Load-bearing, not bookkeeping. It is what lets the loop below spend the
 * budget *exactly*, and it only holds because both backends put the spine's
 * auth surface and the forge's own dispatcher surface on **one** account
 * bucket. A backend giving them separate limiters admits one extra call here
 * and fails.
 */
const SETUP_ACCOUNT_CHARGES = 2;

/** How many calls ride in one `Promise.all` wave while spending the budget. */
const WAVE = 25;

/** Generous per-response wait on the socket — the cases assert the answer, not a timeout. */
const WS_RESPONSE_TIMEOUT_MS = 5000;

/** A JSON-RPC error code read off a socket response frame, `null` on success. */
const ws_error_code = (frame: unknown): number | null =>
	(frame as Partial<JsonrpcErrorResponseFrame>).error?.code ?? null;

/**
 * Send `count` well-formed calls over `ws` in waves, asserting each succeeds.
 *
 * Every response is awaited before the next wave goes out, so the bucket has
 * been charged for all of them by the time this resolves.
 */
const spend_over_ws = async (ws: WsClient, first_id: number, count: number): Promise<void> => {
	for (let sent = 0; sent < count; sent += WAVE) {
		const ids = Array.from({ length: Math.min(WAVE, count - sent) }, (_, i) => first_id + sent + i);
		for (const id of ids) {
			await ws.send({ jsonrpc: JSONRPC_VERSION, id, method: METHOD, params: {} });
		}
		const frames = await Promise.all(
			ids.map((id) => ws.wait_for(is_response_for(id), WS_RESPONSE_TIMEOUT_MS))
		);
		const refusals = frames.filter((frame) => ws_error_code(frame) !== null);
		assert.deepStrictEqual(
			refusals,
			[],
			`WS calls ${ids[0]}-${ids.at(-1)} should all succeed while the budget lasts`
		);
	}
};

/** Send one call over `ws` and return its error code (`null` on success). */
const call_ws = async (ws: WsClient, id: number, params: unknown): Promise<number | null> => {
	await ws.send({ jsonrpc: JSONRPC_VERSION, id, method: METHOD, params });
	return ws_error_code(await ws.wait_for(is_response_for(id), WS_RESPONSE_TIMEOUT_MS));
};

describe('action dispatcher phase order (cross-process, both backends)', () => {
	test('a throttled caller hears rate_limited, not invalid_params', async () => {
		const fixture: CrossFixture = await setup_test();
		// A dedicated admin account: the budget is per-account, so spending it
		// here leaves the keeper — and every other case on this spawn — untouched.
		const throttled = await fixture.create_account({
			username: 'throttle_order_probe',
			roles: [ROLE_ADMIN]
		});
		const transport = fixture.fresh_transport();
		const headers = {
			host: 'localhost',
			origin: TEST_ORIGIN,
			'Content-Type': 'application/json',
			...throttled.create_session_headers()
		};
		const call = async (params: unknown, id: number): Promise<RpcPostResult> =>
			post_envelope(
				{ ...fixture, transport },
				{ jsonrpc: JSONRPC_VERSION, id, method: METHOD, params },
				headers
			);

		// Spend the rest of the budget with well-formed calls. Waves rather than a strictly
		// serial loop only to keep the run bounded; the bucket is a counter, so
		// arrival order is immaterial.
		//
		// Every one of these must answer 200. Discarding them would leave the
		// assertion below satisfied by any budget at or below the cap — a
		// backend that throttled early would still hand the probe a 429 and
		// pass. Checking them pins the budget as *exactly* the cap on both
		// backends: too small and a spending call is refused here, too large
		// (a backend that ignored the cap) and the probe below reads 400
		// instead of 429.
		const spendable = ACCOUNT_BUDGET - SETUP_ACCOUNT_CHARGES;
		for (let sent = 0; sent < spendable; sent += WAVE) {
			const wave = await Promise.all(
				Array.from({ length: Math.min(WAVE, spendable - sent) }, (_, i) => call({}, sent + i))
			);
			const wave_refusals = wave.filter((res) => res.status !== 200);
			assert.deepStrictEqual(
				wave_refusals,
				[],
				`calls ${sent}-${sent + wave.length - 1} of the ${spendable} still owed on the ` +
					`${ACCOUNT_BUDGET}-call budget should all answer 200`
			);
		}

		// The probe: a well-formed envelope carrying an undeclared input key. The
		// throttle must answer first.
		const throttled_probe = await call({ bogus: 1 }, ACCOUNT_BUDGET);
		assert.deepStrictEqual(
			{ status: throttled_probe.status, code: throttled_probe.body.error?.code },
			{ status: 429, code: JSONRPC_ERROR_CODES.rate_limited },
			`expected the throttle ahead of input validation, got ${JSON.stringify(throttled_probe)}`
		);

		// The control: the same malformed params against a caller whose bucket is
		// untouched DO reach validation, so the 429 above is the throttle winning
		// a race it could lose rather than this method refusing every input.
		const keeper_refused = await post_envelope(
			fixture,
			{ jsonrpc: JSONRPC_VERSION, id: 1, method: METHOD, params: { bogus: 1 } },
			{
				host: 'localhost',
				origin: TEST_ORIGIN,
				'Content-Type': 'application/json',
				...fixture.create_session_headers()
			}
		);
		assert.deepStrictEqual(
			{ status: keeper_refused.status, code: keeper_refused.body.error?.code },
			{ status: 400, code: JSONRPC_ERROR_CODES.invalid_params },
			`unthrottled malformed params should reach validation, got ${JSON.stringify(keeper_refused)}`
		);
	});

	// The same pin over the socket, with the budget split across both
	// transports so it also pins one account bucket between them.
	test_if(
		capabilities.ws,
		'HTTP RPC and WS spend one budget, and a throttled socket hears rate_limited',
		async () => {
			const fixture: CrossFixture = await setup_test();
			const throttled = await fixture.create_account({
				username: 'throttle_order_ws_probe',
				roles: [ROLE_ADMIN]
			});
			const transport = fixture.fresh_transport();
			const session_headers = throttled.create_session_headers();
			const headers = {
				host: 'localhost',
				origin: TEST_ORIGIN,
				'Content-Type': 'application/json',
				...session_headers
			};
			const call_http = async (params: unknown, id: number): Promise<RpcPostResult> =>
				post_envelope(
					{ ...fixture, transport },
					{ jsonrpc: JSONRPC_VERSION, id, method: METHOD, params },
					headers
				);

			// Half the remaining budget over HTTP, half over the socket. Each half
			// alone is under the cap, so a backend whose transports kept
			// separate buckets admits the probes below.
			const spendable = ACCOUNT_BUDGET - SETUP_ACCOUNT_CHARGES;
			const over_http = Math.floor(spendable / 2);
			for (let sent = 0; sent < over_http; sent += WAVE) {
				const wave = await Promise.all(
					Array.from({ length: Math.min(WAVE, over_http - sent) }, (_, i) =>
						call_http({}, sent + i)
					)
				);
				assert.deepStrictEqual(
					wave.filter((res) => res.status !== 200),
					[],
					`HTTP calls ${sent}-${sent + wave.length - 1} should all answer 200`
				);
			}

			const cookie = session_headers.cookie;
			assert.ok(cookie, 'expected a session cookie for the WS upgrade');
			const ws = await create_ws_transport({
				base_url,
				ws_path,
				cookies: [cookie],
				origin: base_url
			});
			try {
				await spend_over_ws(ws, over_http, spendable - over_http);

				// The budget is spent. The malformed probe over the socket must
				// hear the throttle, not the schema.
				const ws_probe = await call_ws(ws, ACCOUNT_BUDGET, { bogus: 1 });
				assert.strictEqual(
					ws_probe,
					JSONRPC_ERROR_CODES.rate_limited,
					`expected the socket probe throttled ahead of input validation, got ${ws_probe}`
				);
			} finally {
				await ws.close();
			}

			// The same bucket refuses the account over HTTP too.
			const http_probe = await call_http({ bogus: 1 }, ACCOUNT_BUDGET + 1);
			assert.deepStrictEqual(
				{ status: http_probe.status, code: http_probe.body.error?.code },
				{ status: 429, code: JSONRPC_ERROR_CODES.rate_limited },
				`expected HTTP refused on the shared bucket, got ${JSON.stringify(http_probe)}`
			);

			// The control: the keeper's bucket is untouched, so the same malformed
			// params over a socket reach validation.
			const keeper_cookie = fixture.create_session_headers().cookie;
			assert.ok(keeper_cookie, 'expected a keeper session cookie for the WS upgrade');
			const keeper_ws = await create_ws_transport({
				base_url,
				ws_path,
				cookies: [keeper_cookie],
				origin: base_url
			});
			try {
				const keeper_probe = await call_ws(keeper_ws, 1, { bogus: 1 });
				assert.strictEqual(
					keeper_probe,
					JSONRPC_ERROR_CODES.invalid_params,
					`unthrottled malformed params over WS should reach validation, got ${keeper_probe}`
				);
			} finally {
				await keeper_ws.close();
			}
		}
	);
});
