/**
 * Locked-down auth chain for the forge git smart-HTTP routes.
 *
 * Twin of `crates/fuz_forge_server/src/forge_git/auth.rs`.
 * `authenticate_git_request` is the full gate: `RepoSlug` grammar →
 * Origin/Referer rejection → HTTP Basic (the password is treated as an API
 * token) → the token-shape precheck → `query_validate_api_token` → global
 * `admin` role-grant → `repos/<slug>` cell lookup. `check_repo_capability`
 * then gates the operation against the token's authority over that repo. On
 * any failure the caller returns the
 * generic 401 (`git_unauthorized`) — no enumeration via distinct error
 * shapes.
 *
 * Git smart-HTTP is one of the forge's own non-RPC surfaces
 * (`surface:git_http`), so `check_repo_capability` resolves both per-token
 * authority axes: the resource-bound `fuz_forge_api_token_policy` row when the
 * token has one, and the spine's `api_token.scope` when it does not. The second
 * half is what refuses a token minted through the spine's own
 * `account_token_create` — narrowed scope, no policy row, and
 * `policy_check(null, …)` alone would have admitted it. See
 * `fuz_forge_token_surfaces.ts`.
 *
 * The routing layer (`routes/repo_git.ts`) parses the bare `slug` from the URL
 * and passes it in, matching the Rust `serve_*` → `authenticate_git_request`
 * seam. It has already validated the slug against the `RepoSlug` grammar, so
 * an off-grammar spelling arrives here as `''` and is refused on the first
 * line — before any credential work, and long before the lookup's lowercase
 * fold, which is what keeps a non-ASCII homoglyph from folding onto a real
 * slug. Rust gates the same grammar in `bare_slug_from_segments`, pre-auth; on
 * both backends an off-grammar URL therefore does zero database work (no
 * `api_token.last_used_at`/`_ip` touch, no cell read).
 *
 * @module
 */

import type { Context } from 'hono';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { get_client_ip } from '@fuzdev/fuz_app/http/client_ip.ts';
import { query_validate_api_token } from '@fuzdev/fuz_app/auth/api_token_queries.ts';
import { is_api_token_shaped } from '@fuzdev/fuz_app/auth/api_token.ts';
import { query_account_has_active_global_role } from '@fuzdev/fuz_app/auth/role_grant_queries.ts';
import { query_account_by_id } from '@fuzdev/fuz_app/auth/account_queries.ts';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { query_cell_get_by_path, type CellRow } from '@fuzdev/fuz_app/db/cell_queries.ts';
import type { TokenScope } from '@fuzdev/fuz_app/auth/token_scope.ts';

import { repo_cell_path } from '../../fuz_forge/repo/plan_repo.ts';
import { SURFACE_GIT_HTTP, token_scope_admits_forge_surface } from '../fuz_forge_token_surfaces.ts';
import { query_token_policy_by_id } from '../db/fuz_forge_api_token_policy_queries.ts';
import {
	capability_string,
	policy_check,
	type FuzForgeCapability
} from '../fuz_forge_token_policy.ts';
import { unauthorized as base_unauthorized } from './inhandler_auth.ts';

/** Dependencies for the git smart-HTTP auth chain. */
export interface RepoGitAuthDeps {
	query_deps: QueryDeps;
	log: Logger;
}

/** Git operation a request is performing — drives the capability check. */
export type GitOp = 'push' | 'pull';

/**
 * Result of `authenticate_git_request`. `null` indicates the caller
 * should return the prebuilt 401 response — auth failure has been
 * logged and the response is uniform regardless of cause.
 */
export interface GitAuthOk {
	account_id: string;
	username: string;
	cell: CellRow;
	repo_id: string;
	/**
	 * The validated `api_token.id`. Used by `check_repo_capability`
	 * to look up the scoped-token policy — forge routes mount outside
	 * `/api/*` so the policy hydration middleware doesn't fire here.
	 */
	api_token_id: string;
	/**
	 * The credential's `api_token.scope`, carried from the validated row for the
	 * same reason as `api_token_id`: the policy middleware doesn't fire on these
	 * routes, so nothing else on the request holds it. Read by
	 * `check_repo_capability` when the token has no policy row.
	 */
	scope: TokenScope;
}

/**
 * Cell lookup keyed on the slug carried in the clone URL. The slug is
 * mirrored into `cell.path` as `repos/<slug>`, so this is a single
 * indexed path lookup (the path-unique index also guarantees at most one
 * match).
 *
 * Repo slugs are case-insensitive (canonical lowercase): cells are stored at
 * the lowercase slug (creation folds via the `RepoSlug` schema), so a raw
 * clone-URL slug is lowercased here before the lookup — `MyOrg/MyRepo`
 * resolves the same cell as `myorg/myrepo`.
 */
const query_repo_cell_by_slug = (deps: QueryDeps, slug: string): Promise<CellRow | null> =>
	query_cell_get_by_path(deps, repo_cell_path(slug.toLowerCase()));

/**
 * Build the generic 401 response. Adds the `WWW-Authenticate: Basic`
 * header so a git client knows to prompt for credentials. The shared
 * helper supplies the locked-down body shape and content type.
 */
export const git_unauthorized = (c: Context): Response =>
	base_unauthorized(c, {
		headers: { 'WWW-Authenticate': 'Basic realm="fuz_forge forge", charset="UTF-8"' }
	});

/**
 * Parse a `Basic <base64>` Authorization header into `{username, password}`.
 *
 * Returns `null` for any shape violation. The colon-split is bounded to
 * the first occurrence so passwords may legally contain `:`.
 */
const parse_basic_auth = (
	header: string | undefined
): { username: string; password: string } | null => {
	if (!header) return null;
	if (header.slice(0, 6).toLowerCase() !== 'basic ') return null;
	const encoded = header.slice(6).trim();
	if (!encoded) return null;
	let decoded: string;
	try {
		decoded = atob(encoded);
	} catch {
		return null;
	}
	const colon = decoded.indexOf(':');
	if (colon < 0) return null;
	const username = decoded.slice(0, colon);
	const password = decoded.slice(colon + 1);
	if (!username || !password) return null;
	return { username, password };
};

/**
 * Validate the request against the locked-down auth contract.
 *
 * `slug` is the bare `org/repo` parsed by the routing layer. On success
 * returns the resolved actor identity + cell row; on any failure (off-grammar
 * slug, missing header, browser context, bad token, unknown slug, non-admin
 * account) the caller MUST return `unauthorized(c)` — no diagnostic
 * distinction between cases.
 *
 * The grammar gate comes FIRST, before any credential work: `resolve_slug`
 * hands an off-grammar URL over as `''`, and refusing it here — rather than
 * after the token validation that touches `api_token.last_used_at`/`_ip` —
 * keeps an off-grammar URL doing zero database work, matching the Rust twin's
 * pre-auth `bare_slug_from_segments`.
 */
export const authenticate_git_request = async (
	deps: RepoGitAuthDeps,
	c: Context,
	slug: string
): Promise<GitAuthOk | null> => {
	// Grammar gate — `''` is the routing layer's off-grammar signal.
	if (!slug) return null;

	// Browser-context replay defense — git never sends Origin or Referer.
	if (c.req.header('Origin') !== undefined || c.req.header('Referer') !== undefined) {
		deps.log.warn('repo_git: rejecting request with Origin/Referer header');
		return null;
	}

	const basic = parse_basic_auth(c.req.header('Authorization'));
	if (!basic) return null;
	// A password that cannot be an API token is refused before any database
	// work — the spine bearer leg's precheck. Git smart-HTTP is pre-auth with no
	// rate limiter in front of it, so junk must cost nothing. Twin:
	// `basic_api_token` in `forge_git/auth.rs`.
	if (!is_api_token_shaped(basic.password)) return null;

	const ip = get_client_ip(c);
	const api_token = await query_validate_api_token(
		{ ...deps.query_deps, log: deps.log },
		basic.password,
		ip,
		undefined
	);
	if (!api_token) return null;

	// The Basic-auth username is NOT validated against the account: the token
	// already identifies the account, so requiring a matching username adds
	// friction (and a footgun) without security — usernames aren't secret.
	// Matches GitHub/GitLab PAT semantics: any username + a valid token.
	const account = await query_account_by_id(deps.query_deps, api_token.account_id);
	if (!account) return null;

	// Tombstone-aware: the grant counts only while the account **and** the
	// granting actor are both live. This path reads the grant straight off
	// `api_token.account_id` with no acting-actor resolution in front of it, so
	// the tombstone-blind sibling `query_account_has_global_role` would keep
	// admitting a push on a grant held by a soft-deleted actor — fail-open on
	// an admission gate.
	// Twin: `forge_git/auth.rs`, which reads the spine's
	// `query_account_has_active_global_role`. Tighten together, never one.
	const has_admin = await query_account_has_active_global_role(
		deps.query_deps,
		api_token.account_id,
		ROLE_ADMIN
	);
	if (!has_admin) return null;

	const cell = await query_repo_cell_by_slug(deps.query_deps, slug);
	// `kind = 'repo'`, as the Rust twin's lookup requires: a path is admin-only,
	// but an admin `cell_create` can still put another kind at `repos/<slug>`,
	// and that is no hosted repo.
	if (cell?.kind !== 'repo' || cell.path === null) return null;

	return {
		account_id: api_token.account_id,
		username: account.username,
		cell,
		// On-disk repo dir + CGI PATH_INFO are keyed on the cell-id UUID,
		// not the `repos/<slug>` cell path or the clone-URL slug.
		repo_id: cell.id,
		api_token_id: api_token.id,
		// parsed by `query_validate_api_token`, which refuses a row whose stored
		// scope is unreadable
		scope: api_token.scope
	};
};

/**
 * After token validation + admin role check + service validation, gate the
 * operation against the token's authority over this repo.
 *
 * Resolves both per-token axes, the same rule the file store applies through
 * `enforce_capability`: a token **with** a `fuz_forge_api_token_policy` row is
 * governed by it (`forge.push:<repo_id>` / `forge.pull:<repo_id>`), and a token
 * **without** one falls through to its spine scope, where a narrowed token is
 * refused. See `fuz_forge_token_surfaces.ts` for why it splits that way rather
 * than stacking.
 *
 * Loads the policy row directly from the DB — forge routes mount outside
 * `/api/*` so the policy hydration middleware doesn't fire here, which is also
 * why the scope rides on `GitAuthOk` rather than the request context.
 *
 * On deny, the handler returns the same generic 401 as every other auth failure
 * — the locked-down posture forbids enumeration via distinct error shapes (git
 * clients can't render structured 403 bodies anyway), so the two axes are
 * distinguished only in the log.
 */
export const check_repo_capability = async (
	deps: RepoGitAuthDeps,
	auth: GitAuthOk,
	operation: GitOp
): Promise<boolean> => {
	const row = await query_token_policy_by_id(
		{ ...deps.query_deps, log: deps.log },
		auth.api_token_id
	);
	const policy = row?.policy ?? null;
	if (!token_scope_admits_forge_surface(policy, auth.scope)) {
		deps.log.warn(
			`repo_git: token scope denied ${SURFACE_GIT_HTTP} for account ${auth.account_id}`
		);
		return false;
	}
	const capability: FuzForgeCapability = {
		kind: operation === 'push' ? 'forge.push' : 'forge.pull',
		repo_id: auth.repo_id
	};
	if (!policy_check(policy, capability)) {
		deps.log.warn(
			`repo_git: policy denied ${capability_string(capability)} for account ${auth.account_id}`
		);
		return false;
	}
	return true;
};
