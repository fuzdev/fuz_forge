/**
 * Cross-process integration suite for the **`rpc_subset` scoped-token RPC
 * method gate** and **`fuz_forge_token_policy_list`** — run against BOTH
 * fuz_forge backends (Deno/Hono + Rust `fuz_forge_server`) via the
 * `cross_backend_*` mechanism. Companion to `files_scoped_token.cross.test.ts`
 * (which probes the file-route capability gate); this one probes the JSON-RPC
 * method gate `files_scoped_token.cross.test.ts` never fires an RPC against.
 *
 * Flow: mint a scoped token via `fuz_forge_token_create_scoped({template:
 * {kind: 'rpc_subset', methods: ['fuz_forge_repo_list']}})` over the keeper
 * SESSION; then over the scoped Bearer (Authorization header, NO Origin — the
 * auth middleware discards bearer credentials when an Origin/Referer is
 * present):
 *
 *   - the granted method (`fuz_forge_repo_list`) dispatches (ok / repos array)
 *   - a denied method (`fuz_forge_repo_refs`) → JSON-RPC error `-32002` naming
 *     the missing capability `'rpc:fuz_forge_repo_refs'`
 *
 * The denied-method assertion runs on **both backends**, which enforce it in
 * the same place: the spine's `api_token.scope`, checked inside
 * `perform_action` between the credential gate and the role gate. The envelope
 * is the spine's machine-dispatchable `{reason, required_scope}`, and the
 * capability string is forge's `rpc:<method>` vocabulary, which the spine
 * adopted when it took the gate over.
 *
 * Then `fuz_forge_token_policy_list` over the keeper SESSION lists the minted
 * token with template `'rpc_subset'`, and a freshly-minted secondary account's
 * policy list is empty (per-account isolation) — both green on both backends.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';

import { post_rpc_bearer, type RpcPostResult } from './rpc_helpers.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';
import { FuzForgeTokenPolicyListOutput } from '#lib/action_specs.ts';

import { mint_scoped_token, scoped_token_rpc_denial_data } from './scoped_token_mint.ts';

const handle = inject_backend_handle();
// The secondary account in the isolation case is granted ROLE_ADMIN so it can
// call `fuz_forge_token_policy_list` (admin-gated) — that grant is made per
// case below, through the production offer/accept flow. The keeper holds admin
// already: `_testing_reset` seeds it `[ROLE_KEEPER, ROLE_ADMIN]`, and
// `extra_keeper_roles` is for roles beyond that default.
const setup_test = default_cross_process_setup(handle);
const { base_url } = handle.config;

/** The method the scoped token does not grant, and the capability it names. */
const DENIED_METHOD = 'fuz_forge_repo_refs';
const DENIED_CAPABILITY = `rpc:${DENIED_METHOD}`;

/** The `error.data` a denied method produces. */
const EXPECTED_DENIAL_DATA = scoped_token_rpc_denial_data(DENIED_METHOD);

/**
 * Mint an `rpc_subset` token granting only `fuz_forge_repo_list` and fire the
 * denied `fuz_forge_repo_refs` over the scoped bearer.
 */
const probe_denied_rpc_over_scoped_bearer = async (): Promise<RpcPostResult> => {
	const fixture = await setup_test();
	const { token } = await mint_scoped_token(
		fixture,
		{ kind: 'rpc_subset', methods: ['fuz_forge_repo_list'] },
		'rpc subset: repo_list only (denial probe)'
	);
	return post_rpc_bearer(base_url, token, DENIED_METHOD, {
		id: '00000000-0000-4000-8000-000000000000'
	});
};

describe('rpc_subset scoped-token method gate (cross-process, both backends)', () => {
	test('granted method dispatches over the scoped bearer', async () => {
		const fixture = await setup_test();

		const { token } = await mint_scoped_token(
			fixture,
			{ kind: 'rpc_subset', methods: ['fuz_forge_repo_list'] },
			'rpc subset: repo_list only'
		);

		// Granted method dispatches — the scoped token allows `fuz_forge_repo_list`,
		// so the request reaches the handler and returns a repos array.
		const allowed = await post_rpc_bearer(base_url, token, 'fuz_forge_repo_list', {});
		assert.strictEqual(
			allowed.status,
			200,
			`allowed dispatch failed: ${JSON.stringify(allowed.body)}`
		);
		const result = allowed.body.result as { repos?: unknown } | undefined;
		assert.ok(
			result && Array.isArray(result.repos),
			`expected a repos array, got ${JSON.stringify(allowed.body)}`
		);
	});

	// A method the scoped token does not name is refused before the handler,
	// with JSON-RPC `-32002 forbidden` naming the missing capability.
	test('denied method → -32002 naming the missing capability (both backends)', async () => {
		const denied = await probe_denied_rpc_over_scoped_bearer();
		assert.ok(denied.body.error, `expected a JSON-RPC error, got ${JSON.stringify(denied.body)}`);
		assert.strictEqual(
			denied.body.error.code,
			JSONRPC_ERROR_CODES.forbidden,
			'expected forbidden -32002'
		);
		const data = denied.body.error.data as { required_scope?: unknown } | undefined;
		assert.strictEqual(
			data?.required_scope,
			DENIED_CAPABILITY,
			`expected the denial to name ${DENIED_CAPABILITY}, got ${JSON.stringify(data)}`
		);
		assert.deepStrictEqual(data, EXPECTED_DENIAL_DATA);
	});

	test('token_policy_list lists the minted token with its template; per-account isolation', async () => {
		const fixture = await setup_test();

		const { id: minted_id } = await mint_scoped_token(
			fixture,
			{ kind: 'rpc_subset', methods: ['fuz_forge_repo_list'] },
			'rpc subset for policy list'
		);

		// The keeper's policy list includes the minted token id + its template.
		const listed = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_token_policy_list',
			params: {},
			headers: fixture.create_session_headers()
		});
		assert.isTrue(listed.ok, `policy_list failed: ${JSON.stringify(listed)}`);
		const out = parse_or_throw(FuzForgeTokenPolicyListOutput, listed.result);
		const entry = out.policies.find((p) => p.api_token_id === minted_id);
		assert.ok(entry, `minted token ${minted_id} should appear in the keeper's policy list`);
		assert.strictEqual(entry.template, 'rpc_subset');

		// Per-account isolation: a fresh admin secondary minted no scoped tokens,
		// so its own policy list is empty (the keeper's minted token is invisible
		// to it — policies are account-scoped).
		const secondary = await fixture.create_account({
			username: 'policy_isolation_secondary',
			roles: [ROLE_ADMIN]
		});
		const secondary_listed = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_token_policy_list',
			params: {},
			headers: secondary.create_session_headers()
		});
		assert.isTrue(
			secondary_listed.ok,
			`secondary policy_list failed: ${JSON.stringify(secondary_listed)}`
		);
		const secondary_out = parse_or_throw(FuzForgeTokenPolicyListOutput, secondary_listed.result);
		assert.strictEqual(
			secondary_out.policies.length,
			0,
			'a fresh account that minted no scoped tokens should have an empty policy list'
		);
	});
	test('a ttl scoped mint stores a bounded expiry through the inlined INSERT (both backends)', async () => {
		// The Rust backend mints through an inlined `INSERT INTO api_token`
		// (not `fuz_auth::query_create_api_token`), so a widened query signature
		// alone can't prove it threads `expires_at`. Mint with a ttl, then read
		// the row back over the spine's `account_token_list` — a backend that
		// dropped the lifetime reports `expires_at: null` and fails here.
		const fixture = await setup_test();

		const mint_res = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'bounded scoped token',
				template: { kind: 'rpc_subset', methods: ['fuz_forge_repo_list'] },
				lifetime: { kind: 'ttl', days: 30 }
			},
			headers: fixture.create_session_headers()
		});
		assert.isTrue(mint_res.ok, `ttl mint failed: ${JSON.stringify(mint_res)}`);
		const minted = mint_res.result as { id: string };

		const list_res = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'account_token_list',
			headers: fixture.create_session_headers()
		});
		assert.isTrue(list_res.ok, `token list failed: ${JSON.stringify(list_res)}`);
		const tokens = (list_res.result as { tokens: Array<{ id: string; expires_at: string | null }> })
			.tokens;
		const row = tokens.find((t) => t.id === minted.id);
		assert.ok(row, 'the ttl-minted token must appear in account_token_list');
		assert.ok(
			row.expires_at !== null,
			'the inlined mint must store the ttl expiry — null means the lifetime was dropped'
		);
	});
});
