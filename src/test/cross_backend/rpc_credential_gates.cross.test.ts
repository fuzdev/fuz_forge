/**
 * Cross-process integration suite for the forge's **session-only credential
 * gates** on the JSON-RPC surface — run against BOTH fuz_forge backends
 * (TS/Hono + Rust `fuz_forge_server`) via the `cross_backend_*` mechanism.
 *
 * Three forge methods mount `credential_types: ['session']` /
 * `CredentialGate::SESSION_ONLY` on both backends:
 *
 *   - `fuz_forge_repo_rotate_secret` — a leaked api_token must not rotate the
 *     hook-callback credential and lock the daemon out
 *   - `fuz_forge_token_create_scoped` — a leaked token must not mint another
 *   - `fuz_forge_token_policy_list` — nor enumerate the account's policies
 *
 * The happy paths already run over the keeper SESSION elsewhere
 * (`repo_push.cross.test.ts` § rotate_secret, `rpc_scoped_token.cross.test.ts`
 * § mint + policy_list). What no suite fired was the *negative*: a perfectly
 * valid, full-scope, admin-held **bearer** against each of them. Without it the
 * gate is asserted only in each backend's own unit table, never on the wire —
 * and a backend that dropped the gate would still pass every existing cross
 * suite, because every existing caller happens to hold a session.
 *
 * Four cases, one bearer shape: one per gated method, plus a positive control.
 * The control dispatches `fuz_forge_repo_list` (`CredentialGate::Any`, same
 * admin role) over the same kind of token and expects 200, proving the bearer
 * is valid, unexpired, admin-roled and unscoped — without it a denial could
 * pass vacuously on a backend that refused every bearer, or every bearer
 * without a policy row.
 *
 * The refusal is the spine's, identically on both sides — the credential gate
 * is the FIRST of the three post-authorization gates (credential → scope →
 * role) and runs **before** params are validated, so the probe's params never
 * reach a schema and a missing gate would surface as a different code
 * (`-32003` not-found for `rotate_secret`, `200` for the other two) rather than
 * a passing test. TS: `check_action_auth_post_authorization` in
 * `@fuzdev/fuz_app/actions/perform_action.ts` →
 * `jsonrpc_error_messages.forbidden('forbidden', {reason:
 * ERROR_CREDENTIAL_TYPE_REQUIRED, required_credential_types: auth.credential_types})`.
 * Rust: the `fuz_auth::action_auth` twin of the same name →
 * `JsonrpcErrorCode::Forbidden` + `{reason: "credential_type_required",
 * required_credential_types: <spec.credentials.allowed() names>}`.
 *
 * Bearer probes are raw `fetch` with NO Origin and NO cookie jar, for two
 * reasons: the auth middleware discards bearer credentials when an
 * Origin/Referer is present, and the fixture transport's cookie jar would
 * smuggle the keeper's session in — which would make every case pass
 * vacuously through the very gate under test.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';

import { post_rpc_bearer, FORBIDDEN, type JsonrpcEnvelopeBody } from './rpc_helpers.ts';
import { keeper_token } from './git_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url } = handle.config;

/**
 * The exact `error.data` a session-only spec emits for a wrong credential
 * channel — one shape on both backends. `required_credential_types` echoes the
 * spec's allowlist, which for every forge session-only method is `['session']`.
 */
const CREDENTIAL_DENIAL_DATA = {
	reason: 'credential_type_required',
	required_credential_types: ['session']
};

/** A well-formed but absent repo id, so `rotate_secret`'s params are realistic. */
const ABSENT_REPO_ID = '00000000-0000-4000-8000-000000000000';

/**
 * Assert that one session-only method refuses a full-admin bearer with the
 * spine's `credential_type_required` denial.
 *
 * The params are realistic rather than empty so a *missing* gate is loud: with
 * the gate removed, `rotate_secret` on an absent id answers `-32003` and the
 * two token methods answer `200` — none of them the `-32002` asserted here.
 */
const assert_credential_gate_refuses = async (
	bearer: string,
	method: string,
	params: unknown
): Promise<void> => {
	const denied = await post_rpc_bearer(base_url, bearer, method, params);
	assert.strictEqual(
		denied.status,
		403,
		`${method}: expected HTTP 403, got ${denied.status}: ${JSON.stringify(denied.body)}`
	);
	const body: JsonrpcEnvelopeBody = denied.body;
	assert.ok(body.error, `${method}: expected a JSON-RPC error, got ${JSON.stringify(denied.body)}`);
	assert.strictEqual(body.error.code, FORBIDDEN, `${method}: forbidden -32002`);
	assert.strictEqual(body.error.message, 'forbidden', `${method}: message`);
	assert.deepStrictEqual(
		body.error.data,
		CREDENTIAL_DENIAL_DATA,
		`${method}: expected the spine's credential_type_required body, got ${JSON.stringify(
			body.error.data
		)}`
	);
	assert.strictEqual(body.result, undefined, `${method}: a refused call must carry no result`);
};

describe('session-only RPC credential gates (cross-process, both backends)', () => {
	test('fuz_forge_repo_rotate_secret refuses a full-admin bearer', async () => {
		const fixture = await setup_test();
		await assert_credential_gate_refuses(
			keeper_token(fixture.create_bearer_headers()),
			'fuz_forge_repo_rotate_secret',
			{ id: ABSENT_REPO_ID }
		);
	});

	test('fuz_forge_token_create_scoped refuses a full-admin bearer', async () => {
		const fixture = await setup_test();
		await assert_credential_gate_refuses(
			keeper_token(fixture.create_bearer_headers()),
			'fuz_forge_token_create_scoped',
			{
				name: 'credential gate probe (must never be minted)',
				template: { kind: 'rpc_subset', methods: ['fuz_forge_repo_list'] },
				lifetime: { kind: 'eternal' }
			}
		);
	});

	test('fuz_forge_token_policy_list refuses a full-admin bearer', async () => {
		const fixture = await setup_test();
		await assert_credential_gate_refuses(
			keeper_token(fixture.create_bearer_headers()),
			'fuz_forge_token_policy_list',
			{}
		);
	});

	test('the same bearer reaches an any-credential admin method — the denials are not vacuous', async () => {
		const fixture = await setup_test();
		const bearer = keeper_token(fixture.create_bearer_headers());
		const control = await post_rpc_bearer(base_url, bearer, 'fuz_forge_repo_list', {});
		assert.strictEqual(
			control.status,
			200,
			`the control bearer must dispatch an any-credential admin method: ${JSON.stringify(
				control.body
			)}`
		);
		const body: JsonrpcEnvelopeBody = control.body;
		assert.ok(
			body.result && Array.isArray((body.result as { repos?: unknown }).repos),
			`expected a repos array, got ${JSON.stringify(control.body)}`
		);
	});
});
