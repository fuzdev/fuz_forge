/**
 * Shared JSON-RPC POST helpers for the cross-backend suites.
 *
 * Every suite that hand-builds an envelope (rather than going through
 * `rpc_call`) used to carry its own copy of these; one module keeps the
 * three spellings of "POST an envelope to `/api/rpc`" from drifting.
 * Error codes come from `JSONRPC_ERROR_CODES` — a suite references the enum,
 * never a magic number. The aliases here are the shorthand for the codes this
 * directory asserts most, exported beside the two probe ids they pair with so
 * a suite needs neither a literal nor a local const of its own; reading
 * `JSONRPC_ERROR_CODES.<name>` directly is equally fine, and several suites
 * do.
 *
 * @module
 */

import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import type { SetupTest } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';
import { create_test_request_headers, TEST_ORIGIN } from '@fuzdev/fuz_app/testing/test_origin.ts';

/** Grammar-valid id that names no repo — isolates input validation from lookup. */
export const ABSENT_ID = '3f8a1c2e-1234-4abc-9def-0123456789ab';

/**
 * `ABSENT_ID` without its hyphens — a spelling Rust's `Uuid::parse_str` and
 * Postgres both accept and the UUID grammar refuses, so it is the discriminating
 * input for every UUID grammar gate.
 */
export const HYPHENLESS_UUID = '3f8a1c2e12344abc9def0123456789ab';

/** Error code a schema/bound failure produces on both backends. */
export const INVALID_PARAMS = JSONRPC_ERROR_CODES.invalid_params;

/** Error code an envelope-level rejection produces. */
export const INVALID_REQUEST = JSONRPC_ERROR_CODES.invalid_request;

/** HTTP status both backends map `-32600` (and `-32602`) onto. */
export const BAD_REQUEST = 400;

/** Error code a well-formed request for a record that is not there produces. */
export const NOT_FOUND = JSONRPC_ERROR_CODES.not_found;

/** Error code the authority gates (credential / scope / role) produce. */
export const FORBIDDEN = JSONRPC_ERROR_CODES.forbidden;

/** Error code a handler failure past input validation produces. */
export const INTERNAL_ERROR = JSONRPC_ERROR_CODES.internal_error;

/** Error code a request for a method neither backend mounts produces. */
export const METHOD_NOT_FOUND = JSONRPC_ERROR_CODES.method_not_found;

/** A cross-process fixture, as `default_cross_process_setup` yields it. */
export type CrossFixture = Awaited<ReturnType<SetupTest>>;

/** The JSON-RPC envelope read back off an `unknown` body. */
export interface JsonrpcEnvelopeBody {
	jsonrpc?: unknown;
	id?: unknown;
	result?: unknown;
	error?: { code?: unknown; message?: unknown; data?: unknown };
}

/** Status + parsed body of a hand-built envelope POST. */
export interface RpcPostResult {
	status: number;
	body: JsonrpcEnvelopeBody;
}

/**
 * POST a hand-built JSON-RPC envelope to `/api/rpc` through the fixture's
 * transport with explicit headers, returning the HTTP status alongside the
 * envelope — the status is half the contract, since both backends map
 * `-32600` / `-32602` onto `400` (`error_code_to_http_status` in `fuz_http`,
 * the `JsonrpcRequest` check of `classify_jsonrpc_message`).
 *
 * Hand-built rather than `rpc_call` because an explicit-`null` `params` needs
 * the key spelled literally, which `create_rpc_post_init` strips to the absent
 * form.
 */
export const post_envelope = async (
	fixture: CrossFixture,
	envelope: Record<string, unknown>,
	headers: Record<string, string>
): Promise<RpcPostResult> => {
	const response = await fixture.transport(SPINE_RPC_PATH, {
		method: 'POST',
		headers,
		body: JSON.stringify(envelope)
	});
	return { status: response.status, body: (await response.json()) as JsonrpcEnvelopeBody };
};

/**
 * POST a hand-built envelope as the fixture's admin session, with the same
 * `host` / `origin` / `Content-Type` defaults every other POST in this
 * directory sends, so an origin-check rejection can never be mistaken for the
 * answer a case is about.
 */
export const post_rpc_session = async (
	fixture: CrossFixture,
	envelope: Record<string, unknown>
): Promise<RpcPostResult> =>
	post_envelope(
		fixture,
		envelope,
		create_test_request_headers({
			'Content-Type': 'application/json',
			...fixture.create_session_headers()
		})
	);

/**
 * `GET /api/rpc` with the method / id / params spelled into the query string —
 * the endpoint's side-effect-free-reads half, which reads its request off the
 * query rather than a JSON-RPC envelope.
 *
 * `params` is the raw query value, not a JS value, so a case can send the
 * literal `null` an envelope POST cannot carry past the classifier. Omit it
 * for the absent form.
 */
export const get_rpc = async (
	fixture: CrossFixture,
	query: { method: string; id?: string; params?: string }
): Promise<RpcPostResult> => {
	const response = await fixture.transport(`${SPINE_RPC_PATH}?${rpc_query(query)}`, {
		method: 'GET',
		headers: create_test_request_headers(fixture.create_session_headers())
	});
	return { status: response.status, body: (await response.json()) as JsonrpcEnvelopeBody };
};

/**
 * `GET /api/rpc` with no credentials at all — a raw `fetch`, because the
 * fixture transport threads a cookie jar and would re-send the keeper session.
 * For the cases that assert where a refusal sits relative to auth.
 */
export const get_rpc_anonymous = async (
	base_url: string,
	query: { method: string; id?: string; params?: string }
): Promise<RpcPostResult> => {
	const response = await fetch(`${base_url}${SPINE_RPC_PATH}?${rpc_query(query)}`, {
		method: 'GET',
		headers: { origin: TEST_ORIGIN }
	});
	return { status: response.status, body: (await response.json()) as JsonrpcEnvelopeBody };
};

/** Render the `method` / `id` / `params` query the GET endpoint reads. */
const rpc_query = (query: { method: string; id?: string; params?: string }): string => {
	const search = new URLSearchParams({ method: query.method, id: query.id ?? '1' });
	if (query.params !== undefined) search.set('params', query.params);
	return search.toString();
};

/**
 * POST a JSON-RPC request over a Bearer with NO Origin header and no cookie
 * jar. Bearer credentials are silently discarded by the auth middleware when
 * an Origin/Referer is present, so bearer probes must look like non-browser
 * callers — a raw `fetch` rather than the cookie-jar transport.
 */
export const post_rpc_bearer = async (
	base_url: string,
	bearer: string,
	method: string,
	params: unknown
): Promise<RpcPostResult> => {
	const res = await fetch(`${base_url}${SPINE_RPC_PATH}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${bearer}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
	});
	return { status: res.status, body: (await res.json()) as JsonrpcEnvelopeBody };
};
