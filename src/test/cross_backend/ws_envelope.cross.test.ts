/**
 * Cross-process **WebSocket JSON-RPC envelope** suite — run against BOTH
 * fuz_forge backends (Deno/Hono + Rust `fuz_forge_server`) via the
 * `cross_backend_*` mechanism.
 *
 * The socket's read loop classifies every inbound frame before anything
 * dispatches: version, then id, then method, then params. Three outcomes are
 * possible and each is pinned here — an `invalid_request` envelope carrying the
 * id the frame yields, silence (the frame demuxes as a peer response, or is a
 * notification), or a real dispatch. The two implementations reach that from
 * opposite directions: TS runs the `JsonrpcRequest` schema inside
 * `register_action_ws`, Rust runs `fuz_http::classify` ahead of
 * `fuz_realtime`'s `ws_endpoint` dispatch. Nothing compared them frame for
 * frame on the forge's own socket, and the envelope is exactly where two
 * hand-written stacks drift: the happy path agrees, the malformed shapes are
 * each a separate decision.
 *
 * **The id is half the contract.** A refusal that echoes the wrong id (or
 * `null` where the frame carried a usable id) leaves a client unable to settle
 * the request it sent, so every row states the id it expects alongside the
 * code. `null` is the answer whenever the frame yields no usable id — a scalar
 * frame, a boolean or null id, a frame that is not an object at all.
 *
 * **Silence is asserted positively**, the same way `ws_cancel.cross.test.ts`
 * does it: each case marks the client's received-message count, sends its
 * frames, then round-trips a `heartbeat` and reads back everything that
 * arrived. A frame that should produce nothing leaves exactly the probe
 * response behind, and the probe doubles as proof the socket survived the
 * malformed frame rather than being torn down by it.
 *
 * Gated on `capabilities.ws`.
 *
 * @module
 */

import { assert, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { test_if } from '@fuzdev/fuz_app/testing/cross_backend/capabilities.ts';
import { create_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';
import { is_response_for, type WsClient } from '@fuzdev/fuz_app/testing/transports/ws_client.ts';
import { JSONRPC_VERSION } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import { heartbeat_action_spec } from '@fuzdev/fuz_app/actions/heartbeat.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url, ws_path, capabilities } = handle.config;

/** The mounted WS method every probe and every well-formed frame here uses. */
const HEARTBEAT = heartbeat_action_spec.method;

/** Open an admin socket for one case. */
const open_socket = async (cookies: ReadonlyArray<string>): Promise<WsClient> =>
	create_ws_transport({ base_url, ws_path, cookies, origin: base_url });

/** A response frame's id, or `undefined` when the frame is not a response. */
const frame_id = (frame: unknown): unknown => (frame as { id?: unknown }).id;

/**
 * Send `frames`, round-trip a `heartbeat` probe, and return every frame that
 * arrived after the mark except the probe's own response.
 *
 * The probe is what makes silence assertable: the socket is ordered, so a
 * classifier that answered a frame it should have dropped has already put that
 * envelope on the wire by the time the probe response lands. It also proves the
 * connection survived — a backend that closed the socket on a malformed frame
 * fails the probe's own `wait_for` rather than passing as "silent".
 *
 * `awaited_ids` names responses the caller's frames are expected to produce;
 * each is awaited before the slice is read, so a case never races a dispatch
 * whose answer the Rust loop produces concurrently.
 */
const frames_after = async (
	client: WsClient,
	frames: ReadonlyArray<unknown>,
	awaited_ids: ReadonlyArray<string | number> = []
): Promise<ReadonlyArray<unknown>> => {
	const mark = client.messages.length;
	const probe_id = `probe-${mark}`;
	for (const frame of frames) await client.send(frame);
	await client.send({ jsonrpc: JSONRPC_VERSION, id: probe_id, method: HEARTBEAT, params: {} });
	for (const id of [...awaited_ids, probe_id]) await client.wait_for(is_response_for(id), 3000);
	return client.messages.slice(mark).filter((frame) => frame_id(frame) !== probe_id);
};

/** A frame the classifier must refuse, and the id its refusal must carry. */
interface InvalidRequestCase {
	name: string;
	frame: unknown;
	/** The id the `invalid_request` envelope echoes — `null` when the frame yields none. */
	id: string | number | null;
}

/**
 * Every frame shape that answers one `invalid_request`, with the id it echoes.
 *
 * The rows walk the classifier in order: the envelope version, then the frames
 * that are not objects at all, then the response-shaped hybrids, then the
 * request fields (`method`, `params`, `id`).
 */
const INVALID_REQUEST_CASES: ReadonlyArray<InvalidRequestCase> = [
	{
		name: 'a batch array',
		frame: [{ jsonrpc: JSONRPC_VERSION, id: 1, method: HEARTBEAT, params: {} }],
		id: null
	},
	{ name: 'a versionless frame', frame: { method: HEARTBEAT, params: {} }, id: null },
	{
		name: 'a jsonrpc 1.0 frame with no id',
		frame: { jsonrpc: '1.0', method: HEARTBEAT, params: {} },
		id: null
	},
	{
		name: 'a jsonrpc 1.0 frame with a usable id',
		frame: { jsonrpc: '1.0', id: 4, method: HEARTBEAT, params: {} },
		id: 4
	},
	// A scalar frame carries no id to echo — reading the frame `5` as its own
	// id would answer `id: 5`. The bare string is the JSON document `"heartbeat"`,
	// a string body rather than a frame.
	{ name: 'a scalar frame', frame: 5, id: null },
	{ name: 'a bare string frame', frame: HEARTBEAT, id: null },
	{ name: 'a frame with no method', frame: { jsonrpc: JSONRPC_VERSION, id: 1 }, id: 1 },
	{
		name: 'a frame carrying both result and error',
		frame: { jsonrpc: JSONRPC_VERSION, id: 1, result: 1, error: { code: -1, message: 'x' } },
		id: 1
	},
	{
		name: 'a response-shaped frame with a boolean id',
		frame: { jsonrpc: JSONRPC_VERSION, id: true, result: 1 },
		id: null
	},
	// `method` is read as a string, so a non-string one counts as absent and the
	// frame takes the no-method branch — with neither an id nor a response shape
	// it lands on `invalid_request` rather than being dropped as a notification.
	{
		name: 'a non-string method with no id',
		frame: { jsonrpc: JSONRPC_VERSION, method: 123 },
		id: null
	},
	// The envelope's `params` contract, over the socket: a present non-object is
	// refused before dispatch, so it is `invalid_request` and not `invalid_params`.
	{
		name: 'an explicit null params',
		frame: { jsonrpc: JSONRPC_VERSION, id: 7, method: HEARTBEAT, params: null },
		id: 7
	},
	{
		name: 'an array params',
		frame: { jsonrpc: JSONRPC_VERSION, id: 8, method: HEARTBEAT, params: [1, 2] },
		id: 8
	},
	{
		name: 'a null id',
		frame: { jsonrpc: JSONRPC_VERSION, id: null, method: HEARTBEAT, params: {} },
		id: null
	},
	{
		name: 'a boolean id',
		frame: { jsonrpc: JSONRPC_VERSION, id: true, method: HEARTBEAT, params: {} },
		id: null
	},
	// The two **falsy but valid** ids. `0` and `''` are ordinary JSON-RPC ids a
	// client is free to send, and both fail a bare truthiness test — the one a
	// classifier reaches for when it means "no usable id". Answering `null` here
	// leaves the client unable to settle the request it sent, and the two rows
	// above (`null` / boolean ids) are exactly what makes that mistake look
	// right. `params: null` is the refusal's cause, so the row is about the id.
	{
		name: 'a zero id',
		frame: { jsonrpc: JSONRPC_VERSION, id: 0, method: HEARTBEAT, params: null },
		id: 0
	},
	{
		name: 'an empty-string id',
		frame: { jsonrpc: JSONRPC_VERSION, id: '', method: HEARTBEAT, params: null },
		id: ''
	}
];

/**
 * Frame shapes that answer nothing at all.
 *
 * Both demux as **peer responses**: `method` is not a string, so the frame
 * takes the no-method branch, and a usable id plus exactly one of
 * `result` / `error` routes it to the response arm. No pending server-initiated
 * request matches the id, so it is dropped. Answering `invalid_request` here
 * would put an envelope on the wire the peer protocol never asked for.
 */
const SILENT_CASES: ReadonlyArray<{ name: string; frame: unknown }> = [
	{
		name: 'a non-string method with a result',
		frame: { jsonrpc: JSONRPC_VERSION, id: 1, method: 123, result: {} }
	},
	{
		name: 'a null method with an error',
		frame: { jsonrpc: JSONRPC_VERSION, id: 1, method: null, error: { code: -1, message: 'x' } }
	}
];

describe('WS JSON-RPC envelope (cross-process, both backends)', () => {
	for (const { name, frame, id } of INVALID_REQUEST_CASES) {
		test_if(
			capabilities.ws,
			`${name} answers invalid_request with id ${JSON.stringify(id)}`,
			async () => {
				const fixture = await setup_test();
				const client = await open_socket(fixture.transport.cookies());
				try {
					const frames = await frames_after(client, [frame]);
					assert.lengthOf(frames, 1, `expected one refusal, got ${JSON.stringify(frames)}`);
					const answer = frames[0] as { jsonrpc: string; id: unknown; error: { code: number } };
					assert.deepStrictEqual(
						{ jsonrpc: answer.jsonrpc, id: answer.id, code: answer.error?.code },
						{ jsonrpc: JSONRPC_VERSION, id, code: JSONRPC_ERROR_CODES.invalid_request },
						`refusal envelope drifted: ${JSON.stringify(answer)}`
					);
				} finally {
					await client.close();
				}
			}
		);
	}

	for (const { name, frame } of SILENT_CASES) {
		test_if(
			capabilities.ws,
			`${name} demuxes as a peer response and answers no frame`,
			async () => {
				const fixture = await setup_test();
				const client = await open_socket(fixture.transport.cookies());
				try {
					const frames = await frames_after(client, [frame]);
					assert.lengthOf(frames, 0, `expected no frame, got ${JSON.stringify(frames)}`);
				} finally {
					await client.close();
				}
			}
		);
	}

	test_if(
		capabilities.ws,
		'a frame carrying method and result dispatches as a request',
		async () => {
			// The other side of the demux: `method` IS a string here, so the frame
			// is a request and the stray `result` key is ignored rather than
			// routing it to the peer-response arm. A looser demux swallows it.
			const fixture = await setup_test();
			const client = await open_socket(fixture.transport.cookies());
			try {
				const id = 'method-and-result';
				const frames = await frames_after(
					client,
					[{ jsonrpc: JSONRPC_VERSION, id, method: HEARTBEAT, params: {}, result: {} }],
					[id]
				);
				assert.deepStrictEqual(frames, [{ jsonrpc: JSONRPC_VERSION, id, result: {} }]);
			} finally {
				await client.close();
			}
		}
	);

	test_if(capabilities.ws, 'a well-formed notification answers no frame', async () => {
		// The control for every silent row above: a frame that IS a valid
		// notification (version, string method, no id) is dropped too — so the
		// silence in the peer-response cases is the classifier's decision, not a
		// backend that answers nothing for anything id-less.
		const fixture = await setup_test();
		const client = await open_socket(fixture.transport.cookies());
		try {
			const frames = await frames_after(client, [
				{ jsonrpc: JSONRPC_VERSION, method: HEARTBEAT, params: {} }
			]);
			assert.lengthOf(frames, 0, `expected no frame, got ${JSON.stringify(frames)}`);
		} finally {
			await client.close();
		}
	});
});
