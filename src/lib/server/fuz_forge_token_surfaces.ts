/**
 * fuz_forge's non-RPC surface names, and the rule that decides which of the
 * forge's two per-token authority axes governs a request.
 *
 * A narrowed api token (`{kind: 'methods', methods: [...]}`) may call the RPC
 * methods it names and — by token scoping's RPC-only rule — reach no non-RPC
 * surface. The spine enforces that over the surfaces the spine mounts; it
 * cannot see a consumer's. So every bearer-reachable surface fuz_forge authors,
 * or re-auths into bearer reach, names itself here, and
 * `fuz_forge_token_surfaces.census.test.ts` asserts the set is exactly these.
 *
 * **The name decides nothing.** The rule is all-or-nothing, so a capability
 * string only labels *which* surface refused, in the `required_scope` a denial
 * reports back. That is why fuz_app leaves the identifier half of
 * `RouteAuth.required_scope` open: no registration, no upstream release. These
 * constants exist so a typo is a compile error rather than a silently
 * mis-labelled denial, not because the spine needs to recognize them.
 *
 * `surface:db_admin` deliberately **reuses the spine's own name** for the same
 * table browser fuz_app ships and fuz_forge re-auths. Matching is the desirable
 * case — one surface, one label, whichever backend refused.
 *
 * ## Which axis governs, and why it depends on the token
 *
 * Two per-token controls sit on the same requests:
 *
 * - **The forge policy** (`fuz_forge_api_token_policy` / `policy_check`) —
 *   *which repos, which filenames?* Resource-bound, the vocabulary the spine
 *   deliberately has none for, written by `fuz_forge_token_create_scoped`.
 * - **Token scope** (spine, `api_token.scope`) — all-or-nothing over non-RPC
 *   surfaces, `NOT NULL`, so a bearer credential always has an answer.
 *
 * They are not layers to stack. **A token has exactly one of them as its
 * authority over a forge surface**, and which one depends on how it was minted:
 *
 * - Minted by `fuz_forge_token_create_scoped` → it has a policy row, and the
 *   policy governs. Its spine scope is `Methods` by construction (the file /
 *   forge templates derive `Methods(∅)`, since they grant no RPC), so consulting
 *   the scope here would refuse every token the forge's own scoped-mint
 *   feature exists to issue.
 * - Minted by the spine's `account_token_create` → **no policy row**, and the
 *   scope governs. `policy_check(null, …)` returns `true`, which is this axis
 *   abstaining rather than granting; without the scope consulted, a token
 *   narrowed to a couple of RPC methods reached the file store and git with
 *   full resource authority.
 *
 * `token_scope_admits_forge_surface` is that rule, and every forge surface
 * gate goes through it.
 *
 * ## Why these surfaces are not `auth.required_scope` route declarations
 *
 * Because the decision is conditional on a DB row, a declarative whole-surface
 * refusal cannot express it — and would be the wrong gate anyway. Rule 3 is
 * blunt precisely because its surfaces have **no identity a token can name**:
 * nothing mints a token *for* the db-admin browser, which is why
 * `server/routes/db.ts` does declare `surface:db_admin` and is right to. The
 * file store and git smart-HTTP are the opposite shape — the forge's policy
 * vocabulary names them (`files.read:<filename>`, `forge.push:<repo_id>`) and
 * its templates mint tokens for them — so a blanket refusal would refuse what
 * the minter deliberately allowed.
 *
 * @module
 */

import { token_scope_admits_non_rpc, type TokenScope } from '@fuzdev/fuz_app/auth/token_scope.ts';

import type { FuzForgeTokenPolicy } from './fuz_forge_token_policy_schema.ts';

/**
 * The db-admin table browser (`/api/db/*`) — fuz_app's `create_db_route_specs`,
 * re-authed to admin + session-only for the dashboard. Paginated rows of every
 * browsable table, plus row `DELETE`. The channel gate now refuses every
 * bearer before this scope is consulted; the declaration stays as the dormant
 * second fence should the channel gate ever re-widen.
 *
 * The one forge surface gated declaratively, because it is the one no token is
 * ever minted *for*.
 */
export const SURFACE_DB_ADMIN = 'surface:db_admin';

/**
 * The file store (`/api/fuz_forge/files/*`) — upload, list, download, delete
 * over the cell + fact substrate.
 */
export const SURFACE_FILE_STORE = 'surface:file_store';

/**
 * Git smart-HTTP (`/<slug>.git/*`) — mounted at app root, outside the `/api/*`
 * middleware chain, authenticating an api token as the HTTP Basic password.
 *
 * Unlike the two above this name never reaches the wire: the locked-down git
 * posture answers every failure with one generic 401, so nothing enumerates via
 * a distinct denial shape. It labels the refusal in the server log.
 */
export const SURFACE_GIT_HTTP = 'surface:git_http';

/**
 * Every non-RPC surface fuz_forge exposes to a bearer credential.
 *
 * The census reconciles this against the live route mount and the live gate
 * sites, so adding a surface without a decision fails the suite rather than
 * shipping ungated.
 */
export const FUZ_FORGE_TOKEN_SURFACES = [
	SURFACE_DB_ADMIN,
	SURFACE_FILE_STORE,
	SURFACE_GIT_HTTP
] as const;

export type FuzForgeTokenSurface = (typeof FUZ_FORGE_TOKEN_SURFACES)[number];

/**
 * May this credential reach a forge surface the resource policy says nothing
 * about?
 *
 * The default-deny half of the rule in this module's docs. Returns `true` when
 * a policy row exists — the policy is that token's authority and
 * `policy_check` has already answered — and otherwise falls through to the
 * spine scope, where a narrowed token is refused.
 *
 * Session and daemon-token credentials resolve to a `full` scope by
 * construction, so they pass unchanged; so does a grandfathered bearer token,
 * whose backfilled scope is `full`. What newly fails is the case that had no
 * gate at all: a bearer token minted through the spine's `account_token_create`
 * with a narrowed scope and no policy row.
 *
 * `scope` is `null` for an anonymous caller, who holds no credential to
 * narrow — the surrounding role gate is what refuses them.
 *
 * @param policy - the request's forge policy, or `null` when the token has no row
 * @param scope - the credential's scope (`resolved_auth_scope`), or `null` when anonymous
 * @returns `true` to let the capability check stand, `false` to refuse the surface
 */
export const token_scope_admits_forge_surface = (
	policy: FuzForgeTokenPolicy | null,
	scope: TokenScope | null
): boolean => {
	if (policy !== null) return true;
	if (scope === null) return true;
	return token_scope_admits_non_rpc(scope);
};
