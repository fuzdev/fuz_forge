/**
 * Cross-process **`cancel` protocol-method** suite — run against BOTH
 * fuz_forge backends (Deno/Hono + Rust `fuz_forge_server`) via the
 * `cross_backend_*` mechanism. It pins what a `cancel` does, what it
 * answers, and what a `cancel`-shaped request that is not a cancel
 * answers instead.
 *
 * **The effect.** `fuz_app`'s `FrontendWebsocketClient` sends `cancel` as a
 * JSON-RPC **notification** (`{method: 'cancel', params: {request_id}}`, no
 * `id`), and the server aborts that request's `ctx.signal` without
 * answering a frame of its own. Silence is the contract, which makes the
 * effect invisible at frame level: a backend that drops the notification
 * looks identical on the wire to one that honors it. The
 * `_testing_await_signal` seam is what closes that — a handler that parks
 * on `ctx.signal` against a timeout and reports which won — so the
 * cancelled request's own response carries the evidence. Both testing
 * binaries mount it (`src/lib/server/testing_server_build.ts`,
 * `crates/testing_fuz_forge_server/src/main.rs`), and the effect case
 * asserts one expectation across both backends.
 *
 * **The silence.** Asserted positively rather than by a timeout: each case
 * marks the client's received-message count, sends the notification(s),
 * then issues a `heartbeat` request and waits for its response. The frames
 * that arrived after the mark must be exactly that one response — so a
 * stray envelope for a notification fails, and a slow one cannot pass by
 * racing the assertion (the socket is ordered).
 *
 * **`cancel` with an `id` is not a cancel.** It is a notification-kind
 * method, so neither backend mounts it on the dispatch map — TS because
 * `compile_action_registry` admits only `request_response` specs, Rust
 * because `PROTOCOL_ACTION_SPECS` omits it. Both answer `-32601 method not
 * found: cancel`, over the socket and over HTTP POST alike, and the HTTP
 * case is included because a re-mount would be invisible on the socket
 * (the read loop would go on intercepting the notification form).
 *
 * **The other two protocol actions are pinned elsewhere** —
 * `protocol_actions_http.cross.test.ts` owns both HTTP answers, which differ
 * by design: `heartbeat` is WS-only on both backends and answers `-32601`,
 * while `peer/ping` is mounted on both transports on both backends and answers
 * `-32600` with `data: {reason: 'peer_no_transport'}`, so a caller asking for
 * a server-initiated round-trip over a socketless transport learns why. The
 * `peer/ping` socket half is the shared `peer_ping_ws` suite
 * (`spine_suites.cross.test.ts`).
 *
 * Gated on `capabilities.ws` for the socket cases.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { test_if } from '@fuzdev/fuz_app/testing/cross_backend/capabilities.ts';
import { create_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';
import { is_response_for, type WsClient } from '@fuzdev/fuz_app/testing/transports/ws_client.ts';
import { JSONRPC_VERSION } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import { cancel_action_spec } from '@fuzdev/fuz_app/actions/cancel.ts';
import { heartbeat_action_spec } from '@fuzdev/fuz_app/actions/heartbeat.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { post_rpc_session } from './rpc_helpers.ts';

const handle = inject_backend_handle();
// The WS upgrade is gated by `require_role(ROLE_ADMIN)`, which the fresh
// keeper holds: `_testing_reset` seeds it `[ROLE_KEEPER, ROLE_ADMIN]`.
// `extra_keeper_roles` is for roles *beyond* that default, so nothing is wired.
const setup_test = default_cross_process_setup(handle);
const { base_url, ws_path, capabilities } = handle.config;

const CANCEL = cancel_action_spec.method;
const HEARTBEAT = heartbeat_action_spec.method;

/**
 * The signal-observing test seam both testing binaries mount. Named here
 * rather than imported: it is a test-binary action with no shared spec
 * module, so the string is the contract the two mounts agree on.
 */
const AWAIT_SIGNAL = '_testing_await_signal';

/** The envelope both backends answer for a `cancel` that carries an `id`. */
const CANCEL_METHOD_NOT_FOUND = {
	code: JSONRPC_ERROR_CODES.method_not_found,
	message: `method not found: ${CANCEL}`
};

/** Open an admin socket for one case. */
const open_socket = async (cookies: ReadonlyArray<string>): Promise<WsClient> =>
	create_ws_transport({ base_url, ws_path, cookies, origin: base_url });

/**
 * Send `frames`, then round-trip a `heartbeat` and return every frame that
 * arrived after the mark. A silent server yields exactly the heartbeat
 * response.
 *
 * `awaited_ids` names the responses the caller's own `frames` are expected
 * to produce — every one is awaited before the slice is taken, so the
 * assertion never races a pending answer. Ordering is deliberately not
 * assumed: the Rust loop dispatches concurrently, so a later request's
 * response can land first.
 */
const frames_after = async (
	client: WsClient,
	frames: ReadonlyArray<unknown>,
	awaited_ids: ReadonlyArray<string> = []
): Promise<ReadonlyArray<unknown>> => {
	const mark = client.messages.length;
	const probe_id = `probe-${mark}`;
	for (const frame of frames) await client.send(frame);
	await client.send({ jsonrpc: JSONRPC_VERSION, id: probe_id, method: HEARTBEAT, params: {} });
	for (const id of [...awaited_ids, probe_id]) await client.wait_for(is_response_for(id), 3000);
	return client.messages.slice(mark);
};

describe('cancel protocol method (cross-process, both backends)', () => {
	test_if(capabilities.ws, 'a cancel notification aborts the named request signal', async () => {
		const fixture = await setup_test();
		const client = await open_socket(fixture.transport.cookies());
		try {
			// The effect, end to end: a handler parked on `ctx.signal`
			// against a 3s timeout, cancelled by id immediately after. The
			// signal must win, so the handler's own response reports
			// `cancelled: true` — the one wire-visible difference between a
			// backend that honors the notification and one that drops it.
			const id = 'awaiting-signal';
			await client.send({
				jsonrpc: JSONRPC_VERSION,
				id,
				method: AWAIT_SIGNAL,
				params: { timeout_ms: 3000 }
			});
			await client.send({
				jsonrpc: JSONRPC_VERSION,
				method: CANCEL,
				params: { request_id: id }
			});
			const frame = await client.wait_for(is_response_for(id), 5000);
			assert.deepStrictEqual(frame, {
				jsonrpc: JSONRPC_VERSION,
				id,
				result: { cancelled: true }
			});
		} finally {
			await client.close();
		}
	});

	test_if(capabilities.ws, 'without a cancel the signal never fires', async () => {
		const fixture = await setup_test();
		const client = await open_socket(fixture.transport.cookies());
		try {
			// The control for the case above. Same action, short timeout, no
			// cancel — the timeout wins and the handler reports `false`, so a
			// backend that reported `cancelled: true` unconditionally (or
			// aborted every signal on some other trigger) fails here.
			const id = 'no-cancel';
			await client.send({
				jsonrpc: JSONRPC_VERSION,
				id,
				method: AWAIT_SIGNAL,
				params: { timeout_ms: 300 }
			});
			const frame = await client.wait_for(is_response_for(id), 5000);
			assert.deepStrictEqual(frame, {
				jsonrpc: JSONRPC_VERSION,
				id,
				result: { cancelled: false }
			});
		} finally {
			await client.close();
		}
	});

	test_if(
		capabilities.ws,
		'a cancel notification for an unknown request_id answers no frame',
		async () => {
			const fixture = await setup_test();
			const client = await open_socket(fixture.transport.cookies());
			try {
				const frames = await frames_after(client, [
					{ jsonrpc: JSONRPC_VERSION, method: CANCEL, params: { request_id: 'never-existed' } }
				]);
				assert.lengthOf(
					frames,
					1,
					`expected only the heartbeat response, got ${JSON.stringify(frames)}`
				);
			} finally {
				await client.close();
			}
		}
	);

	test_if(
		capabilities.ws,
		'a cancel notification with malformed params answers no frame',
		async () => {
			const fixture = await setup_test();
			const client = await open_socket(fixture.transport.cookies());
			try {
				// No `request_id`; an extra key beside a valid one (the params
				// schema is a strict `object`, so this names nothing); a
				// non-object `params`; `params` omitted entirely. Each fails the
				// twin's `CancelNotificationParams` parse, and none may become an
				// error envelope — a notification carries no id to answer on.
				const frames = await frames_after(client, [
					{ jsonrpc: JSONRPC_VERSION, method: CANCEL, params: { bogus: 1 } },
					{
						jsonrpc: JSONRPC_VERSION,
						method: CANCEL,
						params: { request_id: 'never-existed', bogus: 1 }
					},
					{ jsonrpc: JSONRPC_VERSION, method: CANCEL, params: [] },
					{ jsonrpc: JSONRPC_VERSION, method: CANCEL }
				]);
				assert.lengthOf(
					frames,
					1,
					`expected only the heartbeat response, got ${JSON.stringify(frames)}`
				);
			} finally {
				await client.close();
			}
		}
	);

	test_if(
		capabilities.ws,
		'a cancel notification for an in-flight request answers no frame of its own',
		async () => {
			const fixture = await setup_test();
			const client = await open_socket(fixture.transport.cookies());
			try {
				// The canonical shape: a real in-flight request, cancelled by id.
				// `fuz_forge_repo_list` doesn't observe `ctx.signal`, so it still
				// completes on both backends — what is pinned here is that the
				// cancel itself adds nothing to the wire. (The abort actually
				// reaching a handler is the `_testing_await_signal` case above.)
				const target_id = 'inflight-1';
				const frames = await frames_after(
					client,
					[
						{ jsonrpc: JSONRPC_VERSION, id: target_id, method: 'fuz_forge_repo_list', params: {} },
						{ jsonrpc: JSONRPC_VERSION, method: CANCEL, params: { request_id: target_id } }
					],
					[target_id]
				);
				assert.lengthOf(
					frames,
					2,
					`expected the request's response plus the heartbeat response, got ${JSON.stringify(frames)}`
				);
			} finally {
				await client.close();
			}
		}
	);

	test_if(capabilities.ws, 'an unrecognized notification answers no frame', async () => {
		const fixture = await setup_test();
		const client = await open_socket(fixture.transport.cookies());
		try {
			const frames = await frames_after(client, [
				{ jsonrpc: JSONRPC_VERSION, method: 'no_such_method_at_all', params: {} }
			]);
			assert.lengthOf(
				frames,
				1,
				`expected only the heartbeat response, got ${JSON.stringify(frames)}`
			);
		} finally {
			await client.close();
		}
	});

	test_if(capabilities.ws, 'cancel sent as a request answers method_not_found', async () => {
		const fixture = await setup_test();
		const client = await open_socket(fixture.transport.cookies());
		try {
			const id = 'cancel-as-request';
			await client.send({
				jsonrpc: JSONRPC_VERSION,
				id,
				method: CANCEL,
				params: { request_id: 'whatever' }
			});
			const frame = await client.wait_for(is_response_for(id), 3000);
			assert.deepStrictEqual(frame, {
				jsonrpc: JSONRPC_VERSION,
				id,
				error: CANCEL_METHOD_NOT_FOUND
			});
		} finally {
			await client.close();
		}
	});

	test_if(capabilities.ws, 'heartbeat sent as a request answers the empty result', async () => {
		const fixture = await setup_test();
		const client = await open_socket(fixture.transport.cookies());
		try {
			const id = 'heartbeat-as-request';
			await client.send({ jsonrpc: JSONRPC_VERSION, id, method: HEARTBEAT, params: {} });
			const frame = await client.wait_for(is_response_for(id), 3000);
			assert.deepStrictEqual(frame, { jsonrpc: JSONRPC_VERSION, id, result: {} });
		} finally {
			await client.close();
		}
	});

	test('cancel over HTTP POST answers method_not_found with a 404', async () => {
		const fixture = await setup_test();
		const { status, body } = await post_rpc_session(fixture, {
			jsonrpc: JSONRPC_VERSION,
			id: 1,
			method: CANCEL,
			params: { request_id: 'whatever' }
		});
		assert.strictEqual(status, 404);
		assert.deepStrictEqual(body, {
			jsonrpc: JSONRPC_VERSION,
			id: 1,
			error: CANCEL_METHOD_NOT_FOUND
		});
	});
});
