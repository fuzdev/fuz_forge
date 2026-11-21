/**
 * Reading a request's scoped-token policy, and the gates that resolve a
 * credential's authority over a forge surface from it.
 *
 * Twin of `crates/fuz_forge_server/src/token_policy/hydrate.rs`: a route that
 * gates on the policy reads it in-handler (`load_request_authority`), at the
 * point the Rust `request_policy` runs, after the route's own gates — so a
 * route that never reads it costs no lookup.
 *
 * The policy governs forge's **resource-bound** surfaces only —
 * `files.read:<filename>`, `forge.push:<repo_id>` — which the spine has
 * no vocabulary for. The RPC method surface and the non-RPC spine
 * surfaces (WS upgrade among them) are the spine's, gated by
 * `api_token.scope`; `fuz_forge_token_create_scoped` derives that scope
 * from the same template it builds the policy from, so the two layers
 * always agree about a given token. The git smart-HTTP routes read the policy
 * row themselves (`check_repo_capability`), answering a failed read with
 * their generic refusal's 500.
 *
 * Session and daemon-token callers never resolve to an API token, so their
 * policy is `null` (unscoped) without touching the database.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import {
	resolved_auth_api_token_id,
	resolved_auth_scope,
	type ResolvedAuth
} from '@fuzdev/fuz_app/auth/resolved_auth.ts';
import type { TokenScope } from '@fuzdev/fuz_app/auth/token_scope.ts';
import { is_db_checkout_error } from '@fuzdev/fuz_app/db/db_checkout_error.ts';
import { REST_TOKEN_SCOPE_REQUIRED, rest_error } from '@fuzdev/fuz_app/http/error_schemas.ts';
import { route_fail, type RouteFailOf } from '@fuzdev/fuz_app/http/route_result.ts';
import { string } from '@fuzdev/fuz_schema/schema.ts';

import { query_token_policy_by_id } from './db/fuz_forge_api_token_policy_queries.ts';
import {
	capability_string,
	policy_check,
	type FuzForgeCapability
} from './fuz_forge_token_policy.ts';
import type { FuzForgeTokenPolicy } from './fuz_forge_token_policy_schema.ts';
import {
	token_scope_admits_forge_surface,
	type FuzForgeTokenSurface
} from './fuz_forge_token_surfaces.ts';

/** Dependencies for reading a request's policy. */
export interface HydratePolicyDeps {
	query_deps: QueryDeps;
	log: Pick<Logger, 'error'>;
}

/**
 * Read the scoped-token policy of a request's credential, `null` (unscoped)
 * when the credential is no API token or the token has no policy row; a row
 * that exists but doesn't parse is `DENY_ALL_POLICY`, never `null`
 * (`query_token_policy_by_id`).
 *
 * A failed pool **checkout** (`DbCheckoutError`) is rethrown: the database is
 * unavailable, and the route pipeline answers the flat 503
 * `{error: 'service_unavailable'}` every other checkout site gives. Any other
 * read failure is logged and falls through unscoped; underlying role checks
 * still apply, so a transient blip never widens access.
 *
 * What makes that soft-fail safe on the resource-bound surfaces is the other
 * axis: with the policy absent, `token_scope_admits_forge_surface` falls to
 * `api_token.scope`, and every token `fuz_forge_token_create_scoped` writes a
 * policy row for carries a `methods` scope by construction, which admits no
 * non-RPC surface — so a blip refuses those tokens rather than widening them.
 * Only a policy-row token whose scope were `full` would widen, and the mint
 * never writes that pair (the `admin` template takes the `full` scope and
 * writes no row).
 *
 * Twin of the Rust `hydrate_policy`.
 *
 * @param deps - query deps (pool-level db) and the logger for a failed read
 * @param credential - the credential the auth middleware resolved
 * @returns the policy, or `null` when unscoped
 * @throws DbCheckoutError when the lookup's pool checkout fails
 */
export const hydrate_policy = async (
	deps: HydratePolicyDeps,
	credential: ResolvedAuth | null
): Promise<FuzForgeTokenPolicy | null> => {
	const api_token_id = resolved_auth_api_token_id(credential);
	if (api_token_id === null) return null;
	try {
		const row = await query_token_policy_by_id({ ...deps.query_deps, log: deps.log }, api_token_id);
		return row?.policy ?? null;
	} catch (err) {
		if (is_db_checkout_error(err)) throw err;
		deps.log.error('hydrate_policy: policy lookup failed', err);
		return null;
	}
};

/**
 * A request's authority over the forge surfaces: its credential's spine
 * scope (`null` for an anonymous caller) and its scoped-token policy.
 */
export interface RequestAuthority {
	scope: TokenScope | null;
	policy: FuzForgeTokenPolicy | null;
}

/**
 * Resolve a request's authority over the forge surfaces (`hydrate_policy`
 * with the credential's scope).
 *
 * @param deps - query deps (pool-level db) and the logger for a failed read
 * @param credential - the credential the auth middleware resolved
 * @throws DbCheckoutError when the policy lookup's pool checkout fails
 */
export const load_request_authority = async (
	deps: HydratePolicyDeps,
	credential: ResolvedAuth | null
): Promise<RequestAuthority> => ({
	scope: resolved_auth_scope(credential),
	policy: await hydrate_policy(deps, credential)
});

/** The code of a resource-bound capability denial, `enforce_capability`'s. */
export const ERROR_FORBIDDEN = 'forbidden';

/**
 * Refuse a forge surface to a credential the resource policy does not govern.
 *
 * Returns `null` to allow (caller proceeds), or the spine's flat
 * `{error: 'token_scope_required', required_scope}` at 403 to deny.
 *
 * The scope half of the two-axis rule, on its own, because one file-store route
 * needs it without the capability half: `GET /` filters rather than 403s, so it
 * cannot go through `enforce_capability`, and a token with no policy row
 * has nothing to filter *by*. Sharing the branch is what keeps the two routes
 * from drifting — and what lets the surface census pin a single source line for
 * the whole surface.
 *
 * @param authority - the request's authority (`load_request_authority`)
 * @param surface - the forge surface being reached, reported in the denial
 * @returns `null` to proceed, or the 403 denial
 */
export const enforce_surface = (
	authority: RequestAuthority,
	surface: FuzForgeTokenSurface
): RouteFailOf<typeof REST_TOKEN_SCOPE_REQUIRED> | null => {
	if (token_scope_admits_forge_surface(authority.policy, authority.scope)) return null;
	return route_fail(REST_TOKEN_SCOPE_REQUIRED, { required_scope: surface });
};

/**
 * Enforce a capability against the request's authority over this surface.
 *
 * Returns `null` to allow (caller proceeds), or a 403 to deny. The single
 * funnel for the file store's per-file routes, so both per-token axes are
 * resolved in one place and neither can be applied without the other:
 *
 * - A token **with** a policy row is governed by it — `policy_check` decides,
 *   and a denial is the resource-bound `{error: 'forbidden', required:
 *   '<capability>'}`.
 * - A token **without** one is governed by its spine scope, via
 *   `enforce_surface`. A narrowed token is refused with the spine's flat
 *   `{error: 'token_scope_required', required_scope}`, because the caller's
 *   problem is its scope and not the filename it asked for.
 *
 * See `fuz_forge_token_surfaces.ts` for why it splits that way. The git
 * smart-HTTP routes resolve the same two axes through `check_repo_capability`
 * — same rule, but their locked-down posture collapses every denial into one
 * generic 401 rather than either body above.
 *
 * @param authority - the request's authority (`load_request_authority`)
 * @param capability - the resource-bound capability the route requires
 * @param surface - the forge surface the capability belongs to
 * @returns `null` to proceed, or the 403 denial
 */
export const enforce_capability = (
	authority: RequestAuthority,
	capability: FuzForgeCapability,
	surface: FuzForgeTokenSurface
): RouteFailOf<typeof REST_TOKEN_SCOPE_REQUIRED | typeof REST_FORBIDDEN> | null => {
	const denied = enforce_surface(authority, surface);
	if (denied) return denied;
	if (policy_check(authority.policy, capability)) return null;
	return route_fail(REST_FORBIDDEN, { required: capability_string(capability) });
};

/**
 * The resource-bound capability denial, at 403: a scoped token's policy does
 * not grant the capability, named in `required` (`files.read:<filename>`).
 */
export const REST_FORBIDDEN = rest_error(403, ERROR_FORBIDDEN, { required: string });
