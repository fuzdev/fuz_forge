/**
 * Git smart-HTTP routes for forge-hosted repos.
 *
 * Exposes the four endpoints `git` clients need over HTTPS:
 *
 *   GET  /:slug.git/info/refs?service=git-upload-pack    -- clone/fetch advertise
 *   POST /:slug.git/git-upload-pack                       -- clone/fetch body
 *   GET  /:slug.git/info/refs?service=git-receive-pack   -- push advertise
 *   POST /:slug.git/git-receive-pack                      -- push body
 *
 * The four logical endpoints collapse to **three routes** because both
 * `info/refs` variants share a single GET handler keyed on
 * `?service=<…>`. The receive-pack route is mutating (admin push); the
 * upload-pack route is read-only (clone/fetch) but still admin-gated in
 * v1: pull needs the same admin grant as push.
 *
 * The concern is split into three structurally-parallel modules, mirroring the
 * Rust twin (`forge_git/mod.rs` + `forge_git/auth.rs` + `forge_git/cgi.rs`):
 *
 * - **this module** — routing: the route specs, the handlers, and the slug
 *   parsing that gates on `authenticate_git_request` then proxies through
 *   `proxy_to_git_http_backend`.
 * - `routes/repo_git_auth.ts` — the locked-down auth chain.
 * - `routes/git_cgi.ts` — the `git http-backend` streaming proxy.
 *
 * Each request streams through `git http-backend` via the runtime's
 * `SpawnStreaming` primitive — the binary itself handles the smart
 * HTTP protocol details (advertisement, pack reception, ref validation,
 * atomic ref updates). Hooks installed by `repo/storage.ts` enforce
 * default-branch force-push protection (pre-receive) and update the
 * `repos/<slug>` cell via the internal callback (post-receive).
 *
 * **Auth (locked-down posture):**
 *
 * - Authorization MUST be HTTP Basic. Cookies, bearer tokens, and
 *   anonymous access are rejected.
 * - The Basic password is treated as an API token and validated via
 *   `query_validate_api_token`.
 * - The token's account must hold a global `admin` role_grant on a live
 *   actor — checked via `query_account_has_active_global_role` for every
 *   request, even reads.
 * - The Basic username is ignored — any username works with a valid token
 *   (GitHub/GitLab PAT semantics); the token already identifies the account.
 * - Requests carrying `Origin` or `Referer` are rejected outright.
 *   Browsers add these automatically; `git` never does. Closes the
 *   CSRF window where a malicious page could replay credentials.
 * - All refusals are the generic 401 — no enumeration ("no such repo" vs
 *   "wrong password" both look identical). A password without an API token's
 *   shape is refused before any database work. A database read that fails is
 *   no refusal: it throws to the route pipeline's error mapper, which answers
 *   `500 {error: 'internal_error'}` — the Rust twin's `refusal_response`.
 *
 * Subprocess env is constructed explicitly from the request — server
 * env is NOT inherited. Push-attribution fields
 * (`FUZ_FORGE_PUSH_ACCOUNT_ID`, `FUZ_FORGE_PUSH_USERNAME`) are threaded into the
 * subprocess so the `post-receive` hook can forward them to the
 * internal callback.
 *
 * Routes register at app root (`/<slug>.git/...`), not under `/api/*`,
 * so the standard cookie/bearer auth middleware does not fire on
 * these paths — auth is exclusively in-handler.
 *
 * **Clone-URL grammar.** The only URL either backend serves is
 * `<base>/<org>/<repo>.git/<endpoint>` — exactly two `RepoSlug` segments,
 * `.git` required (`docs/forge.md` § Clone-URL grammar). Anything else is
 * refused without reaching `git http-backend`. The *shape* of that refusal is
 * not a cross-backend contract: this server also mounts the SPA static
 * fallback (which production delegates to nginx), so an unrouted path here is
 * the SPA, while the Rust `fuzfd` — which serves no static — answers its
 * router 404. Off-grammar URLs that this server's wider route regex still
 * matches get the same generic 401 as every other refusal. What both backends
 * pin is the behavior that matters: an off-grammar URL never reaches the git
 * backend.
 *
 * @module
 */

import { literal, unknown } from '@fuzdev/fuz_schema/schema.ts';
import type { Context } from 'hono';
import { define_route, type RouteSpec } from '@fuzdev/fuz_app/http/route_spec.ts';
import { route_raw, type RouteRaw } from '@fuzdev/fuz_app/http/route_result.ts';

import {
	authenticate_git_request,
	check_repo_capability,
	git_unauthorized,
	type GitOp,
	type RepoGitAuthDeps
} from './repo_git_auth.ts';
import { proxy_to_git_http_backend, type GitCgiDeps } from './git_cgi.ts';
import { RepoSlug } from '../../fuz_forge/repo/repo_id.ts';
import { first_query_param, raw_query_of } from '../query_params.ts';

/**
 * Dependencies for the git smart-HTTP routes — the composite of the auth and
 * CGI module deps the route handlers thread through to each helper.
 */
export interface RepoGitRoutesDeps extends RepoGitAuthDeps, GitCgiDeps {}

/**
 * Slug-plus-`.git` capture pattern. Hono's `:name{regex}` requires the
 * `.git` suffix to live INSIDE the regex (a literal `.git` after the
 * `}` is treated as part of the param name, not a path-literal); inside
 * the regex `.+` may span path separators. The handler strips the
 * trailing `.git` to recover the slug stored in the cell.
 *
 * The regex is deliberately wider than the grammar so the grammar check can
 * happen *in-handler* and answer the generic 401 (`resolve_slug`).
 * Narrowing the pattern instead would drop an off-grammar URL through to the
 * SPA static fallback, which is a worse answer than a fail-closed 401. (In
 * practice the pattern spans one or two segments: Hono's `.+` stops spanning
 * at two once the app registers more than one route, so three-plus-segment
 * URLs already fall through.)
 */
const SLUG_WITH_GIT_PATTERN = '.+\\.git';
const GIT_SUFFIX = '.git';

/**
 * Whether the raw request target's path carries a percent-encoded `/`.
 *
 * Hono hands the handler a **decoded** route param, so `/ttt%2Frepo.git/…`
 * arrives as the slug `ttt/repo` and would serve a real repo under a URL no
 * clone ever uses; axum routes on the raw path instead, where the same request
 * is a single segment and never matches. A clone URL's `/` is always a literal
 * path separator — `git` percent-encodes nothing in the path it builds — so
 * the encoded spelling is refused on this side rather than silently accepted,
 * putting both backends on the same answer.
 *
 * Read off `c.req.raw.url` because that is the only place the pre-decode
 * spelling survives. The query string is excluded: `?service=…` is unrelated
 * to the slug and may legitimately carry encoded bytes.
 */
const path_has_encoded_slash = (url: string): boolean => {
	const query_at = url.indexOf('?');
	const path = query_at < 0 ? url : url.slice(0, query_at);
	return path.includes('%2F') || path.includes('%2f');
};

/**
 * The first `service` value in the request's raw query string, percent-decoded.
 *
 * Twin of the Rust `first_service_param` (`forge_git/mod.rs`); both delegate to
 * the shared `first_query_param`, so the advertise endpoint's `?service=` reads
 * under WHATWG `application/x-www-form-urlencoded` semantics on both backends.
 *
 * @returns `undefined` when no `service` key is present; the empty string for
 *   a bare or empty-valued key
 */
export const first_service_param = (raw_query: string | undefined): string | undefined =>
	first_query_param(raw_query, 'service');

/** Compose the route path for a smart-HTTP endpoint. */
const git_path = (suffix: string): string => `/:slug_with_git{${SLUG_WITH_GIT_PATTERN}}${suffix}`;

/** The info/refs advertisement route template. */
export const GIT_INFO_REFS_PATH = git_path('/info/refs');

/** The fetch/clone pack route template. */
export const GIT_UPLOAD_PACK_PATH = git_path('/git-upload-pack');

/** The push pack route template. */
export const GIT_RECEIVE_PACK_PATH = git_path('/git-receive-pack');

/**
 * The smart-HTTP route templates, exactly as mounted — what a middleware
 * carve-out names to leave these routes out of a layer on the surface.
 */
export const GIT_SMART_HTTP_ROUTE_PATHS: ReadonlyArray<string> = [
	GIT_INFO_REFS_PATH,
	GIT_UPLOAD_PACK_PATH,
	GIT_RECEIVE_PACK_PATH
];

/** Extract the slug from the captured `<slug>.git` param. */
const extract_slug = (slug_with_git: string): string =>
	slug_with_git.endsWith(GIT_SUFFIX) ? slug_with_git.slice(0, -GIT_SUFFIX.length) : slug_with_git;

/**
 * Resolve the bare `org/repo` slug from the request param. Returns `''` when
 * the param is absent, strips to empty, carries a percent-encoded `/`, or
 * isn't a `RepoSlug` — `authenticate_git_request` maps that to the generic 401
 * (the locked-down posture). Parsing here, then passing the slug into the auth
 * chain, matches the Rust `serve_*` → `authenticate_git_request` seam.
 *
 * **The gate is the `RepoSlug` grammar, not a segment count** — and it runs
 * BEFORE the lookup's lowercase fold, because the fold is what would map a
 * non-ASCII homoglyph (U+212A KELVIN SIGN → `k`) or a percent-decoded control
 * byte onto a slug a real repo has. Rust runs the same grammar in
 * `bare_slug_from_segments`, through `fuz_forge_wire::validate_repo_slug`; the
 * per-spelling fixtures live in `repo_git_routing.cross.test.ts`.
 *
 * The parsed slug is discarded in favor of the raw one: `RepoSlug`'s
 * `.transform()` lowercases, and the case fold belongs to the cell lookup
 * (`repo_git_auth.ts`), which is where the Rust twin does it too.
 *
 * The refusal *status* is deliberately not a cross-backend contract (see the
 * module doc); what both pin is that the URL never reaches the git backend.
 */
const resolve_slug = (c: Context): string => {
	const slug_with_git = c.req.param('slug_with_git');
	if (!slug_with_git) return '';
	if (path_has_encoded_slash(c.req.raw.url)) return '';
	const slug = extract_slug(slug_with_git);
	return RepoSlug.safeParse(slug).success ? slug : '';
};

/**
 * Build the git smart-HTTP route specs.
 *
 * Three routes total — the two `info/refs` variants share a single GET
 * handler keyed on `?service=<…>`.
 */
export const create_repo_git_route_specs = (deps: RepoGitRoutesDeps): Array<RouteSpec> => {
	const handle_advertise = async (c: Context): Promise<RouteRaw> => {
		const auth = await authenticate_git_request(deps, c, resolve_slug(c));
		if (!auth) return route_raw(git_unauthorized(c));

		const service = first_service_param(raw_query_of(c.req.raw.url));
		if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
			// Dumb HTTP isn't supported; reject anything unexpected with a
			// generic 400 (no enumeration risk since this branch is post-auth).
			return route_raw(c.text('Bad Request\n', 400));
		}

		const operation: GitOp = service === 'git-receive-pack' ? 'push' : 'pull';
		if (!(await check_repo_capability(deps, auth, operation))) {
			return route_raw(git_unauthorized(c));
		}

		return route_raw(
			await proxy_to_git_http_backend(deps, c, auth, {
				request_method: 'GET',
				path_info: `/${auth.repo_id}.git/info/refs`,
				query_string: `service=${service}`
			})
		);
	};

	const handle_post =
		(path_suffix: string, operation: GitOp) =>
		async (c: Context): Promise<RouteRaw> => {
			const auth = await authenticate_git_request(deps, c, resolve_slug(c));
			if (!auth) return route_raw(git_unauthorized(c));

			if (!(await check_repo_capability(deps, auth, operation))) {
				return route_raw(git_unauthorized(c));
			}

			return route_raw(
				await proxy_to_git_http_backend(deps, c, auth, {
					request_method: 'POST',
					path_info: `/${auth.repo_id}.git${path_suffix}`,
					query_string: ''
				})
			);
		};

	return [
		define_route({
			method: 'GET',
			path: GIT_INFO_REFS_PATH,
			auth: { account: 'none', actor: 'none' },
			description:
				'Git smart-HTTP capability advertisement (in-handler HTTP Basic auth; admin role required)',
			input: literal(null),
			output: unknown,
			transaction: false,
			handler: (c) => handle_advertise(c)
		}),
		define_route({
			method: 'POST',
			path: GIT_UPLOAD_PACK_PATH,
			auth: { account: 'none', actor: 'none' },
			description: 'Git fetch/clone body (in-handler HTTP Basic auth; admin role required)',
			input: literal(null),
			raw_body: true,
			output: unknown,
			transaction: false,
			handler: handle_post('/git-upload-pack', 'pull')
		}),
		define_route({
			method: 'POST',
			path: GIT_RECEIVE_PACK_PATH,
			auth: { account: 'none', actor: 'none' },
			description:
				'Git push body (in-handler HTTP Basic auth; admin role required; default-branch force-push protected by pre-receive hook)',
			input: literal(null),
			raw_body: true,
			output: unknown,
			transaction: false,
			handler: handle_post('/git-receive-pack', 'push')
		})
	];
};
