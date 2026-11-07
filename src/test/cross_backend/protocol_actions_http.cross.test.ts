/**
 * Cross-process **protocol actions over HTTP** suite — run against BOTH
 * fuz_forge backends (Deno/Hono + Rust `fuz_forge_server`) via the
 * `cross_backend_*` mechanism. The two dispatchable protocol actions answer a
 * `POST /api/rpc` differently on purpose, and each is pinned here.
 *
 * `heartbeat` is WS-only by contract: it is the socket's liveness probe, and
 * the JSON-RPC HTTP mount does not serve it. The two spines reach that
 * contract from opposite directions — the TS spine keeps per-transport
 * registries and spreads `protocol_actions` into the WS endpoint only, while
 * the Rust spine compiles one registry serving both transports and marks the
 * spec `ws_only`, which `rpc_dispatch` refuses. Either way an HTTP POST must
 * answer exactly what an unregistered method answers: `404` + `-32601 method
 * not found: heartbeat`.
 *
 * The refusal runs **before** auth, so the anonymous and admin cases assert
 * the same envelope: a WS-only method must not be distinguishable from an
 * absent one by anyone, and in particular must not leak the `200 {}` the Rust
 * backend answered even unauthenticated (its spec was `public_readonly_spec`
 * where the TS spec declares `{account: 'required', actor: 'none'}`).
 *
 * Two controls keep the 404s from passing vacuously: an admin POST of a real
 * mounted method on the same channel, and — gated on `capabilities.ws` — a
 * `heartbeat` over the socket, where it is mounted and answers `{}`.
 *
 * **`peer/ping` goes the other way**, and the second describe pins that. It is
 * a protocol action too, but it is mounted on the HTTP RPC endpoint as well as
 * the socket on both backends — fuz_app's `full_spine_mount` does it upstream
 * and the forge's `build_rpc_endpoint_specs` does it here — so an HTTP call
 * must reach the handler and refuse `peer_no_transport` rather than
 * `method_not_found`. A caller asking for a server-initiated round-trip on a
 * transport with no return socket deserves the reason, not a lie about the
 * method existing. Its spec is `auth: public` on both sides (`{account:
 * 'none', actor: 'none'}` ≡ `AuthSpec::public()`), so the anonymous and admin
 * answers are the same envelope here too, and it is pinned whole: code,
 * `message`, and `data.reason`. The socket half is the shared
 * `describe_peer_ping_ws_tests` suite, run in `spine_suites.cross.test.ts`.
 *
 * **The file's second half is the endpoint's own two contracts**, which sit
 * one layer above every action's input schema and so belong to neither
 * backend's domain code — the input schemas themselves are
 * `rpc_input_strictness.shape.cross.test.ts` and its bounds sibling.
 *
 * On the POST path, `JsonrpcRequest.params` is a an optional loose object:
 * a **present** non-object — array, scalar, or explicit `null` — is `-32600`
 * with HTTP 400 before dispatch on both backends, while an **absent** `params`
 * is the no-arg call and answers 200. Both shapes go over a hand-built
 * envelope (`post_rpc_session`) rather than `rpc_call`, whose
 * `create_rpc_post_init` strips a `null` params to the absent form and so
 * cannot express the two separately. The array arm is the load-bearing one:
 * serde fills a derived struct's named fields *positionally* from a sequence,
 * a path `#[serde(deny_unknown_fields)]` does not guard.
 * `ws_envelope.cross.test.ts` carries the same two shapes over the socket.
 *
 * The GET half reads its request off the query string, so no envelope is
 * parsed and none of those rules apply there. Four stand in their place: an
 * explicit `?params=null` reads as absent — a `void` input takes it as the
 * no-arg call and every non-void input as `{}` — a non-object
 * `?params=` reaches the input decode as `-32602` rather than the envelope's
 * `-32600`, a `side_effects: true` method is `-32600 has side effects and must
 * use POST` — after the method lookup, before the credential resolution — and
 * a missing (or empty) `?method=` / `?id=` names which half is missing in
 * `data.reason` rather than answering one bare `invalid request` for both.
 * Like the protocol actions above, these are the spine's rules mounted here
 * because fuz_forge is the ecosystem's cross-backend consumer.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { test_if } from '@fuzdev/fuz_app/testing/cross_backend/capabilities.ts';
import { create_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';
import { is_response_for } from '@fuzdev/fuz_app/testing/transports/ws_client.ts';
import { JSONRPC_VERSION } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import { heartbeat_action_spec } from '@fuzdev/fuz_app/actions/heartbeat.ts';
import { PEER_PING_METHOD, REASON_PEER_NO_TRANSPORT } from '@fuzdev/fuz_app/actions/peer_ping.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';
import { create_test_request_headers } from '@fuzdev/fuz_app/testing/test_origin.ts';

import {
	ABSENT_ID,
	INVALID_PARAMS,
	INVALID_REQUEST,
	BAD_REQUEST,
	get_rpc,
	get_rpc_anonymous,
	post_envelope,
	post_rpc_session,
	type JsonrpcEnvelopeBody
} from './rpc_helpers.ts';

const handle = inject_backend_handle();
// The WS upgrade is gated by `require_role(ROLE_ADMIN)`, which the fresh
// keeper holds: `_testing_reset` seeds it `[ROLE_KEEPER, ROLE_ADMIN]`.
// `extra_keeper_roles` is for roles *beyond* that default, so nothing is wired.
const setup_test = default_cross_process_setup(handle);

const { base_url, ws_path, capabilities } = handle.config;

const HEARTBEAT = heartbeat_action_spec.method;

/** The one envelope both backends answer for `heartbeat` over HTTP. */
const HEARTBEAT_METHOD_NOT_FOUND = {
	jsonrpc: JSONRPC_VERSION,
	id: 1,
	error: {
		code: JSONRPC_ERROR_CODES.method_not_found,
		message: `method not found: ${HEARTBEAT}`
	}
};

/** The same headers every other POST in this directory sends, minus credentials. */
const post_headers = create_test_request_headers({ 'Content-Type': 'application/json' });

/**
 * POST a JSON-RPC request to `/api/rpc`. Anonymous is the default — the
 * anonymous and authenticated answers are the same envelope, which is the
 * point of the pre-auth refusal.
 */
const post_rpc = async (
	fixture: Awaited<ReturnType<typeof setup_test>>,
	method: string,
	headers: Record<string, string> = post_headers,
	params: unknown = {}
): Promise<{ status: number; body: unknown }> =>
	post_envelope(fixture, { jsonrpc: JSONRPC_VERSION, id: 1, method, params }, headers);

/**
 * The `message` both backends put on the no-transport refusal. The three
 * fields of the envelope carry different information — the code says "bad
 * request", `data.reason` is the machine discriminator the shared upstream
 * suite reads, and this is the sentence a developer sees — so all three are
 * pinned here. A backend that paraphrases the sentence passes the other two
 * assertions and still diverges on the wire.
 */
const PEER_NO_TRANSPORT_MESSAGE = 'peer/ping has no return transport';

/**
 * Assert one `peer/ping` HTTP answer: the transport refusal, whole — code,
 * `message`, and `data.reason`.
 */
const assert_peer_no_transport = (
	label: string,
	response: { status: number; body: unknown }
): void => {
	assert.strictEqual(
		response.status,
		400,
		`${label}: expected 400, got ${response.status}: ${JSON.stringify(response.body)}`
	);
	const body = response.body as JsonrpcEnvelopeBody;
	assert.strictEqual(body.jsonrpc, JSONRPC_VERSION, `${label}: jsonrpc`);
	// The id echo, like every other envelope assertion in this directory — a
	// refusal that answered on the wrong id would still carry the right code.
	assert.strictEqual(body.id, 1, `${label}: id echo`);
	const { error } = body;
	assert.ok(error, `${label}: expected an error envelope, got ${JSON.stringify(response.body)}`);
	assert.strictEqual(error.code, JSONRPC_ERROR_CODES.invalid_request, `${label}: code`);
	assert.strictEqual(error.message, PEER_NO_TRANSPORT_MESSAGE, `${label}: message`);
	assert.deepStrictEqual(error.data, { reason: REASON_PEER_NO_TRANSPORT }, `${label}: data`);
	assert.strictEqual(body.result, undefined, `${label}: a refusal carries no result`);
};

/**
 * The non-vacuity control the `heartbeat` and `peer/ping` describes need: a
 * real mounted method over the same channel and headers must still answer 200,
 * so a refusal can only be the transport rule under test.
 */
const assert_dispatches = async (
	fixture: Awaited<ReturnType<typeof setup_test>>
): Promise<void> => {
	const { status, body } = await post_rpc(
		fixture,
		'fuz_forge_repo_list',
		fixture.create_session_headers(post_headers)
	);
	assert.strictEqual(status, 200, `expected a dispatched method, got ${JSON.stringify(body)}`);
	const result = (body as { result?: { repos?: unknown } }).result;
	assert.ok(
		result && Array.isArray(result.repos),
		`expected a repos array, got ${JSON.stringify(body)}`
	);
};

describe('heartbeat over HTTP (cross-process, both backends)', () => {
	test('an anonymous POST answers method_not_found', async () => {
		const fixture = await setup_test();
		const { status, body } = await post_rpc(fixture, HEARTBEAT);
		assert.strictEqual(status, 404);
		assert.deepStrictEqual(body, HEARTBEAT_METHOD_NOT_FOUND);
	});

	test('an admin POST answers the same method_not_found', async () => {
		const fixture = await setup_test();
		const { status, body } = await post_rpc(
			fixture,
			HEARTBEAT,
			fixture.create_session_headers(post_headers)
		);
		assert.strictEqual(status, 404);
		assert.deepStrictEqual(body, HEARTBEAT_METHOD_NOT_FOUND);
	});

	test('a mounted method over the same channel still dispatches — the 404s are not vacuous', async () => {
		const fixture = await setup_test();
		await assert_dispatches(fixture);
	});

	test_if(capabilities.ws, 'heartbeat over the socket answers the empty result', async () => {
		const fixture = await setup_test();
		const client = await create_ws_transport({
			base_url,
			ws_path,
			cookies: fixture.transport.cookies(),
			origin: base_url
		});
		try {
			const id = 'heartbeat-over-ws';
			await client.send({ jsonrpc: JSONRPC_VERSION, id, method: HEARTBEAT, params: {} });
			const frame = await client.wait_for(is_response_for(id), 3000);
			assert.deepStrictEqual(frame, { jsonrpc: JSONRPC_VERSION, id, result: {} });
		} finally {
			await client.close();
		}
	});
});

describe('peer/ping over HTTP (cross-process, both backends)', () => {
	// The mirror image of the heartbeat cases: mounted on HTTP as well as WS on
	// both backends, so the call reaches the handler and is refused for the
	// reason it actually failed. A `-32601` here would mean a backend dropped
	// the HTTP mount; a `200` would mean it invented a return socket.

	test('an anonymous POST is refused as no-transport', async () => {
		const fixture = await setup_test();
		assert_peer_no_transport(
			'anon',
			await post_rpc(fixture, PEER_PING_METHOD, post_headers, { nonce: 1 })
		);
	});

	test('an admin POST is refused the same way', async () => {
		const fixture = await setup_test();
		assert_peer_no_transport(
			'admin',
			await post_rpc(fixture, PEER_PING_METHOD, fixture.create_session_headers(post_headers), {
				nonce: 1
			})
		);
	});

	test('a mounted method over the same channel still dispatches', async () => {
		// This describe's own non-vacuity control, so it does not lean on the
		// heartbeat describe's: a backend refusing every POST would otherwise
		// pass both cases above.
		const fixture = await setup_test();
		await assert_dispatches(fixture);
	});
});

describe('RPC envelope params contract (cross-process, both backends)', () => {
	// One layer above every input schema: `JsonrpcRequest.params` admits an
	// object or nothing at all, and both halves have to agree on which is
	// which before any dispatch happens.

	test('a present non-object params is refused at the envelope — -32600', async () => {
		// `params` is an optional loose object on `JsonrpcRequest`, so
		// the envelope admits it absent or as an object and nothing else: an
		// array, a scalar, and an explicit `null` all fail request validation
		// before dispatch. The Rust twin refuses in the same layer
		// (`fuz_http::classify`), so the code is pinned exactly — no
		// either-or.
		//
		// The array arm is the load-bearing one: serde's `visit_seq` fills a
		// derived struct's named fields *by position*, a path
		// `#[serde(deny_unknown_fields)]` does not guard, so a backend that
		// deferred this to `parse_params` alone would build a valid
		// `RepoGetInput` out of `['<id>']` — a shape a strict `object` never
		// admits.
		const fixture = await setup_test();
		const cases: Array<[string, unknown]> = [
			['fuz_forge_repo_get', [ABSENT_ID]],
			['fuz_forge_repo_list', 'x'],
			['fuz_forge_repo_list', null]
		];
		for (const [method, params] of cases) {
			const { status, body } = await post_rpc_session(fixture, {
				jsonrpc: JSONRPC_VERSION,
				id: 'test',
				method,
				params
			});
			assert.isUndefined(
				body.result,
				`${method} must refuse a ${JSON.stringify(params)} params, got a result`
			);
			assert.strictEqual(
				body.error?.code,
				INVALID_REQUEST,
				`${method} ${JSON.stringify(params)} must be -32600 at the envelope, got ${body.error?.code} (${body.error?.message})`
			);
			assert.strictEqual(
				status,
				BAD_REQUEST,
				`${method} ${JSON.stringify(params)} must answer HTTP 400, got ${status}`
			);
		}
	});

	test('an absent params is the no-arg call — both backends answer the default list', async () => {
		// The other half of the envelope contract, and the reason the refusal
		// above cannot simply be "non-object → reject": `optional` admits
		// an **absent** key, which the dispatcher then reads as `{}`
		// (`raw_params ?? {}` on TS, `parse_params`'s null→`{}` on Rust).
		// `fuz_forge_repo_list` declares no required field, so a no-arg call
		// must succeed on both.
		const fixture = await setup_test();
		const { status, body } = await post_rpc_session(fixture, {
			jsonrpc: JSONRPC_VERSION,
			id: 'test',
			method: 'fuz_forge_repo_list'
		});
		assert.isUndefined(
			body.error,
			`an absent params must be accepted, got ${body.error?.code} (${body.error?.message})`
		);
		assert.strictEqual(status, 200, `an absent params must answer HTTP 200, got ${status}`);
		assert.isArray(
			(body.result as { repos?: unknown } | undefined)?.repos,
			`an absent params must answer the default list, got ${JSON.stringify(body.result)}`
		);
	});
});

describe('GET /api/rpc transport contract (cross-process, both backends)', () => {
	// The GET half of the endpoint reads its request off the query string, so
	// no JSON-RPC envelope is parsed and none of the envelope's own contracts
	// apply there. Four rules stand in their place, and all four are the
	// spine's rather than the forge's — mounted here for the reason the file
	// header gives.

	test('a void method reads an explicit ?params=null as the no-arg call', async () => {
		// `JSON.parse('null')` is `null`, which no envelope refuses on the GET
		// path. A `void` input reads every empty shape — absent, `null`,
		// `{}` — as the no-arg call on both spines: the TS dispatcher normalizes
		// them before `void` runs, and Rust's `InputShape::Void` check accepts
		// the `{}` its GET path maps `null` to.
		const fixture = await setup_test();
		for (const params of ['null', '{}', undefined]) {
			const res = await get_rpc(fixture, { method: 'account_session_list', params });
			assert.isUndefined(
				res.body.error,
				`?params=${params ?? '<absent>'} on a void method must be the call, got ${JSON.stringify(res.body)}`
			);
			assert.strictEqual(res.status, 200, `?params=${params ?? '<absent>'} must answer HTTP 200`);
		}
	});

	test('a non-void method reads ?params=null as the empty object', async () => {
		// The other half of the same mapping: TS's `raw_params ?? {}` makes
		// `null` and absent identical for every non-void input, so `cell_list`
		// — all-optional, `.default({})` — must answer the unfiltered page to
		// both. A mapping that refused `null` outright would close the void
		// gap by breaking this one.
		const fixture = await setup_test();
		for (const params of ['null', undefined]) {
			const res = await get_rpc(fixture, { method: 'cell_list', params });
			assert.isUndefined(
				res.body.error,
				`cell_list ?params=${params ?? '<absent>'} must reach the query, got ${JSON.stringify(res.body)}`
			);
			assert.strictEqual(res.status, 200, `?params=${params ?? '<absent>'} must answer HTTP 200`);
		}
	});

	test('a non-object ?params= reaches the input decode as -32602', async () => {
		// The GET query is not an envelope, so an array / scalar / string is
		// not the `-32600` a POST body of the same shape gets — it is forwarded
		// to the schema, which refuses it. The array arm is the load-bearing
		// one on Rust, where serde fills a derived struct's fields positionally
		// from a sequence unless something upstream refuses it.
		const fixture = await setup_test();
		for (const params of ['[1]', '1', '"x"']) {
			const res = await get_rpc(fixture, { method: 'cell_list', params });
			assert.strictEqual(
				res.body.error?.code,
				INVALID_PARAMS,
				`cell_list ?params=${params} must be -32602, got ${JSON.stringify(res.body)}`
			);
		}

		// Malformed JSON never reaches the schema at all.
		const malformed = await get_rpc(fixture, { method: 'cell_list', params: '{oops' });
		assert.strictEqual(
			malformed.body.error?.code,
			INVALID_PARAMS,
			`unparseable params must be -32602, got ${JSON.stringify(malformed.body)}`
		);
	});

	test('a side-effects method over GET is refused before it runs', async () => {
		// `GET /api/rpc` serves side-effect-free reads; `account_session_revoke_all`
		// is `side_effects: true`, so both backends answer `-32600` with a
		// reason naming the method and POST. Absent the gate the Rust
		// dispatcher runs the mutation on a GET — a revoke-all reachable from
		// a link.
		const fixture = await setup_test();
		const refused = await get_rpc(fixture, { method: 'account_session_revoke_all' });
		assert.strictEqual(
			refused.body.error?.code,
			INVALID_REQUEST,
			`a side-effects GET must be -32600, got ${JSON.stringify(refused.body)}`
		);
		assert.strictEqual(refused.status, BAD_REQUEST, 'a side-effects GET must answer HTTP 400');
		assert.include(
			JSON.stringify(refused.body.error?.data ?? ''),
			'has side effects and must use POST',
			`the refusal must name the verb, got ${JSON.stringify(refused.body.error)}`
		);

		// The mutation did not happen: the session that sent it still lists.
		const { status, body } = await post_rpc_session(fixture, {
			jsonrpc: JSONRPC_VERSION,
			id: 'test',
			method: 'account_session_list'
		});
		assert.strictEqual(status, 200, 'the caller session must survive the refused GET');
		assert.isArray(
			(body.result as { sessions?: unknown } | undefined)?.sessions,
			`the caller session must still list, got ${JSON.stringify(body)}`
		);

		// The gate sits ahead of the credential resolution, so an anonymous
		// caller gets the same `-32600` rather than a 401 — the transport
		// restriction is not an authentication oracle.
		const anonymous = await get_rpc_anonymous(base_url, {
			method: 'account_session_revoke_all'
		});
		assert.strictEqual(
			anonymous.body.error?.code,
			INVALID_REQUEST,
			`an anonymous side-effects GET must be -32600, got ${JSON.stringify(anonymous.body)}`
		);
	});

	test('a missing method or id query parameter names which half is missing', async () => {
		// The GET half's own query contract, one layer below the method
		// lookup: `?method=` and `?id=` are both required, and each refusal
		// carries a `data.reason` naming the missing half — the literals
		// `action_rpc.ts` sends. Without them a client reads one bare
		// `invalid request` for two different mistakes.
		const fixture = await setup_test();
		const cases: Array<[string, string]> = [
			['id=1', 'missing method query parameter'],
			['method=account_session_list', 'missing id query parameter'],
			// An empty value is the absent key on both backends.
			['method=&id=1', 'missing method query parameter'],
			['method=account_session_list&id=', 'missing id query parameter']
		];
		for (const [query, reason] of cases) {
			const response = await fixture.transport(`${SPINE_RPC_PATH}?${query}`, {
				method: 'GET',
				headers: create_test_request_headers(fixture.create_session_headers())
			});
			const body = (await response.json()) as {
				error?: { code?: unknown; data?: unknown };
			};
			assert.strictEqual(response.status, BAD_REQUEST, `?${query} must answer HTTP 400`);
			assert.strictEqual(
				body.error?.code,
				INVALID_REQUEST,
				`?${query} must be -32600, got ${JSON.stringify(body)}`
			);
			assert.deepStrictEqual(
				body.error?.data,
				{ reason },
				`?${query} must name the missing half, got ${JSON.stringify(body.error?.data)}`
			);
		}
	});

	test('an absent method over GET is method_not_found, ahead of the read-only gate', async () => {
		// The lookup wins: an unregistered method answers `-32601` on GET as it
		// does on POST, so the read-only gate can't turn an absent method into
		// a claim that one exists but takes POST.
		const fixture = await setup_test();
		const res = await get_rpc(fixture, { method: 'no_such_method_at_all' });
		assert.strictEqual(
			res.body.error?.code,
			JSONRPC_ERROR_CODES.method_not_found,
			`an absent method must be -32601, got ${JSON.stringify(res.body)}`
		);
	});
});
