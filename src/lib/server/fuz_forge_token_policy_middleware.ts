/**
 * Middleware that hydrates the scoped-token policy onto the Hono
 * context after the bearer auth middleware has resolved an API token
 * (`get_resolved_auth`).
 *
 * Runs on every authenticated request whose middleware chain
 * includes bearer auth (i.e., `/api/*` — the forge smart-HTTP
 * routes mount outside `/api/*` and load the policy in-handler
 * instead).
 *
 * The policy governs forge's **resource-bound** surfaces only —
 * `files.read:<filename>`, `forge.push:<repo_id>` — which the spine has
 * no vocabulary for. The RPC method surface and the non-RPC spine
 * surfaces (WS upgrade among them) are the spine's, gated by
 * `api_token.scope`; `fuz_forge_token_create_scoped` derives that scope
 * from the same template it builds the policy from, so the two layers
 * always agree about a given token.
 *
 * For tokens with **no** policy row: leaves `FUZ_FORGE_TOKEN_POLICY_KEY`
 * unset (semantically `undefined`); gates that consult the key
 * treat undefined as `null` (unscoped — today's max-admin behavior).
 *
 * For tokens with a policy row: sets `FUZ_FORGE_TOKEN_POLICY_KEY` to the
 * parsed policy document. Downstream gates pass this to
 * `policy_check`.
 *
 * Session-authenticated requests (cookie callers — i.e., the
 * dashboard UI) never resolve to an API token; the middleware
 * short-circuits without touching the DB.
 *
 * @module
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import type { MiddlewareSpec } from '@fuzdev/fuz_app/http/middleware_spec.ts';
import {
	get_resolved_auth,
	resolved_auth_api_token_id,
	resolved_auth_scope
} from '@fuzdev/fuz_app/auth/resolved_auth.ts';
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

/**
 * Hono context variable name for the scoped-token policy.
 *
 * Set by `create_fuz_forge_token_policy_middleware` for bearer-
 * authenticated requests whose token has a `fuz_forge_api_token_policy`
 * row. `undefined` (or absent) means unscoped; gates treat
 * absent/`undefined` as today's max-admin behavior.
 */
export const FUZ_FORGE_TOKEN_POLICY_KEY = 'fuz_forge_token_policy';

/**
 * Hono context key for a policy lookup whose pool checkout failed.
 *
 * Set by `create_fuz_forge_token_policy_middleware` instead of throwing, so
 * only a route that reads the policy (`get_request_policy`) answers the 503 —
 * at the point the Rust twin's `request_policy` runs, after the route's own
 * gates — and routes that never read it are unaffected.
 */
export const FUZ_FORGE_TOKEN_POLICY_ERROR_KEY = 'fuz_forge_token_policy_error';

declare module 'hono' {
	interface ContextVariableMap {
		/**
		 * Scoped-token policy for the current request, or `undefined` when
		 * the request is unscoped (session auth, bearer auth with no
		 * policy row, or daemon-token auth). Hydrated by
		 * `create_fuz_forge_token_policy_middleware` on `/api/*`;
		 * loaded in-handler for the forge smart-HTTP routes (which
		 * mount outside `/api/*`).
		 */
		fuz_forge_token_policy: FuzForgeTokenPolicy | undefined;
		/**
		 * The `DbCheckoutError` from a policy lookup whose pool checkout
		 * failed; `get_request_policy` rethrows it.
		 */
		fuz_forge_token_policy_error: Error | undefined;
	}
}

/**
 * Create the scoped-token policy hydration middleware.
 *
 * Runs on the `/api/*` path (mounted by `extend_middleware_for_fuz_forge`):
 * when bearer auth resolved an API token, look up the token's
 * policy row and set `FUZ_FORGE_TOKEN_POLICY_KEY` on the context for
 * downstream gates. Session and daemon-token requests skip the lookup;
 * api_token requests with no policy row remain unscoped.
 *
 * Hydration only — the RPC method gate and the WS upgrade gate belong to
 * the spine's `api_token.scope`, which refuses a narrowed token per-method
 * inside `perform_action` and refuses every non-RPC spine surface (the
 * socket among them) outright. What remains forge-side is the
 * resource-bound half the spine has no vocabulary for: `files.*` and
 * `forge.*`, enforced through `enforce_capability`.
 *
 * A failed pool checkout (`DbCheckoutError`) is stored on the context
 * (`FUZ_FORGE_TOKEN_POLICY_ERROR_KEY`), and `get_request_policy` rethrows it,
 * so a route that reads the policy answers the flat 503
 * `{error: 'service_unavailable'}` every other checkout site gives (the Rust
 * twin's `db_unavailable_response`). Any other DB error soft-fails — logs and
 * falls through unscoped. Underlying role checks still apply, so a transient
 * blip never widens access. A row that exists but fails the schema is the
 * other case and does **not** fall through: `query_token_policy_by_id` hands
 * back `DENY_ALL_POLICY` so an unreadable policy denies everything.
 *
 * What makes the soft-fail safe on the resource-bound surfaces is the other
 * axis: with the policy absent, `token_scope_admits_forge_surface` falls to
 * `api_token.scope`, and every token `fuz_forge_token_create_scoped` writes a
 * policy row for carries a `methods` scope by construction, which admits no
 * non-RPC surface — so a blip refuses those tokens rather than widening them.
 * Only a policy-row token whose scope were `full` would widen, and the mint
 * never writes that pair (the `admin` template takes the `full` scope and
 * writes no row).
 *
 * @param deps - query deps (pool-level db)
 * @param log - logger (DB failures recorded here)
 * @mutates Hono context — sets `FUZ_FORGE_TOKEN_POLICY_KEY` on hit, or
 *   `FUZ_FORGE_TOKEN_POLICY_ERROR_KEY` when the lookup's pool checkout fails
 */
export const create_fuz_forge_token_policy_middleware = (
	deps: QueryDeps,
	log: Logger
): MiddlewareHandler => {
	return async (c, next): Promise<void> => {
		const api_token_id = resolved_auth_api_token_id(get_resolved_auth(c));
		if (api_token_id !== null) {
			try {
				const row = await query_token_policy_by_id({ ...deps, log }, api_token_id);
				if (row !== null) {
					c.set(FUZ_FORGE_TOKEN_POLICY_KEY, row.policy);
				}
			} catch (err) {
				if (is_db_checkout_error(err)) {
					// the database is unavailable: a route that reads the policy answers the 503
					c.set(FUZ_FORGE_TOKEN_POLICY_ERROR_KEY, err as Error);
				} else {
					log.error('fuz_forge_token_policy_middleware: policy lookup failed', err);
					// Fall through unscoped — downstream role checks still apply.
				}
			}
		}

		await next();
	};
};

/**
 * Read the request's scoped-token policy (or `null` if unscoped).
 *
 * Rethrows a policy lookup's failed pool checkout (stored by the middleware),
 * which the route wrapper answers with the flat 503.
 *
 * Centralizes the `c.var.fuz_forge_token_policy ?? null` coercion — the
 * context var is `FuzForgeTokenPolicy | undefined` (Hono's
 * `ContextVariableMap` shape), but the `policy_check` helper takes
 * `FuzForgeTokenPolicy | null`. One coercion site means callers don't
 * need to remember the distinction.
 */
export const get_request_policy = (c: Context): FuzForgeTokenPolicy | null => {
	const error = c.get(FUZ_FORGE_TOKEN_POLICY_ERROR_KEY);
	if (error !== undefined) throw error;
	return c.get(FUZ_FORGE_TOKEN_POLICY_KEY) ?? null;
};

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
 * @param c - the request context
 * @param surface - the forge surface being reached, reported in the denial
 * @returns `null` to proceed, or the 403 denial
 */
export const enforce_surface = (
	c: Context,
	surface: FuzForgeTokenSurface
): RouteFailOf<typeof REST_TOKEN_SCOPE_REQUIRED> | null => {
	const scope = resolved_auth_scope(get_resolved_auth(c));
	if (token_scope_admits_forge_surface(get_request_policy(c), scope)) return null;
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
 * @param c - the request context
 * @param capability - the resource-bound capability the route requires
 * @param surface - the forge surface the capability belongs to
 * @returns `null` to proceed, or the 403 denial
 */
export const enforce_capability = (
	c: Context,
	capability: FuzForgeCapability,
	surface: FuzForgeTokenSurface
): RouteFailOf<typeof REST_TOKEN_SCOPE_REQUIRED | typeof REST_FORBIDDEN> | null => {
	const denied = enforce_surface(c, surface);
	if (denied) return denied;
	if (policy_check(get_request_policy(c), capability)) return null;
	return route_fail(REST_FORBIDDEN, { required: capability_string(capability) });
};

/**
 * The resource-bound capability denial, at 403: a scoped token's policy does
 * not grant the capability, named in `required` (`files.read:<filename>`).
 */
export const REST_FORBIDDEN = rest_error(403, ERROR_FORBIDDEN, { required: string });

/** Options for the fuz_forge middleware extension. */
export interface ExtendMiddlewareOptions {
	/**
	 * Scoped-token policy hydration middleware. Runs on `/api/*` after
	 * `bearer_auth` and hydrates `FUZ_FORGE_TOKEN_POLICY_KEY` from the
	 * authenticated api_token so the file-store gates can consult it.
	 */
	fuz_forge_token_policy_middleware: MiddlewareHandler;
}

/**
 * Extend the API middleware chain with the scoped-token policy
 * hydration step.
 *
 * Appends a `fuz_forge_token_policy` layer that runs after `bearer_auth`
 * on `/api/*` — reads the token id set by `bearer_auth`, looks up the
 * policy row, and hydrates the context so downstream gates can check.
 *
 * Order is load-bearing: `fuz_forge_token_policy` MUST come after
 * `bearer_auth` on the same path so the API token is resolved by the
 * time the policy middleware runs.
 *
 * @param api_middleware - the proxy spec then the auth stack, as `transform_middleware` gets them
 * @param options - the fuz_forge-side middleware to weave in.
 * @returns the extended array with the policy hydration layer.
 */
export const extend_middleware_for_fuz_forge = (
	api_middleware: Array<MiddlewareSpec>,
	options: ExtendMiddlewareOptions
): Array<MiddlewareSpec> => [
	...api_middleware,
	// Policy hydration on /api/* — runs after bearer_auth has resolved the
	// API token.
	{
		name: 'fuz_forge_token_policy',
		path: '/api/*',
		handler: options.fuz_forge_token_policy_middleware
	}
];
