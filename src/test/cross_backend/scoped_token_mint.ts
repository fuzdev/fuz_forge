/**
 * Shared scoped-token mint helper for the cross-backend scoped-token suites
 * (`files_scoped_token.cross.test.ts`, `rpc_scoped_token.cross.test.ts`,
 * `ws_scoped_token.cross.test.ts`).
 *
 * Mints a token via the `fuz_forge_token_create_scoped` RPC over the keeper's
 * session channel (the action is `credential_types: ['session']` + `roles:
 * ['admin']`) and returns the raw token string plus its id. `acting` is omitted
 * — the keeper has a single actor, so the server resolves it implicitly. The
 * file suite reads `.token`; the rpc suite also reads `.id` (to find the token
 * in `fuz_forge_token_policy_list`), so the helper returns the superset.
 *
 * Both backends derive a spine `api_token.scope` from the same template they
 * build the forge policy row from, so a token minted here is refused
 * identically on either: the per-method check runs inside `perform_action`
 * (credential → scope → role), and a narrowed scope is RPC-only, so the WS
 * upgrade is refused along with every other non-RPC spine surface. Neither
 * backend mounts a gate of its own, which also keeps `/api/rpc` and `/api/ws`
 * to a single credential resolution. What stays forge-side is the
 * resource-bound half — `files.*` / `forge.*` — that the spine has no
 * vocabulary for.
 *
 * The `fixture` is typed structurally against exactly what the mint touches —
 * `transport` (as `rpc_call`'s `app`) and `create_session_headers()` (as its
 * `headers`) — so either suite's `Awaited<ReturnType<typeof setup_test>>`
 * fixture satisfies it without coupling to the upstream fixture type.
 *
 * @module
 */

import { assert } from 'vitest';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';

import type {
	FuzForgeTokenCreateScopedInput,
	FuzForgeTokenCreateScopedOutput
} from '#lib/action_specs.ts';

type RpcCallArgs = Parameters<typeof rpc_call>[0];

/**
 * The `error.data` a scoped token's denied RPC method produces.
 *
 * @param method - the denied JSON-RPC method
 */
export const scoped_token_rpc_denial_data = (method: string): Record<string, string> => ({
	reason: 'token_scope_required',
	required_scope: `rpc:${method}`
});

/**
 * The body a scoped token's rejected WS upgrade produces.
 *
 * One shape shared by every non-RPC surface the spine refuses
 * (`token_scope_surface_denied_response`), which is why it names the surface
 * rather than the socket.
 */
export const SCOPED_TOKEN_WS_DENIAL_BODY = {
	error: 'token_scope_required',
	required_scope: 'surface:ws_upgrade'
};

/**
 * The body every non-RPC surface emits when a narrowed token reaches a
 * capability it lacks. One shape across both backends and every surface —
 * the spine's `token_scope_denied_body` / `token_scope_surface_denied_response`.
 *
 * @param capability - the `surface:<name>` the route declared
 */
export const scoped_token_surface_denial_body = (
	capability: string
): { error: string; required_scope: string } => ({
	error: 'token_scope_required',
	required_scope: capability
});

/** Fixture shape the mints touch — see this module's docs. */
interface MintFixture {
	transport: RpcCallArgs['app'];
	create_session_headers: () => RpcCallArgs['headers'];
}

/**
 * Mint a **full** token through the spine's `account_token_create`.
 *
 * The positive control for every surface probe: the same channel and the same
 * absence of a forge policy row as fuz_app's `mint_narrowed_api_token` (the
 * spine mint of a narrowed token, which the forge's resource-bound policy
 * cannot see: `policy_check(null, …)` allows), differing only in the scope. Without it a denial could pass
 * vacuously on a backend that simply refused every policy-less bearer.
 *
 * @param fixture - the cross-process fixture
 * @param name - token label
 */
export const mint_spine_full_token = async <Fixture extends MintFixture>(
	fixture: Fixture,
	name: string
): Promise<{ token: string; id: string }> => {
	const res = await rpc_call({
		app: fixture.transport,
		path: SPINE_RPC_PATH,
		method: 'account_token_create',
		params: { name, scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
		headers: fixture.create_session_headers()
	});
	assert.isTrue(res.ok, `spine mint failed: ${JSON.stringify(res)}`);
	const out = res.result as { token: string; id: string };
	assert.ok(out.token);
	assert.ok(out.id);
	return { token: out.token, id: out.id };
};

export const mint_scoped_token = async <Fixture extends MintFixture>(
	fixture: Fixture,
	template: FuzForgeTokenCreateScopedInput['template'],
	name: string
): Promise<{ token: string; id: string }> => {
	const res = await rpc_call({
		app: fixture.transport,
		path: SPINE_RPC_PATH,
		method: 'fuz_forge_token_create_scoped',
		params: { name, template, lifetime: { kind: 'eternal' } },
		headers: fixture.create_session_headers()
	});
	assert.isTrue(res.ok, `mint failed: ${JSON.stringify(res)}`);
	const out = res.result as FuzForgeTokenCreateScopedOutput;
	assert.ok(out.token);
	assert.ok(out.id);
	return { token: out.token, id: out.id };
};
