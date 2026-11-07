/**
 * Internal callback routes for forge-hosted repo hooks.
 *
 * Two endpoints, both intended to be reached only by the `pre-receive`
 * and `post-receive` hook scripts running inside `git http-backend`:
 *
 *   GET  /internal/repo-config/:id           -- pre-receive: read default_branch
 *   POST /internal/repo-receive-callback     -- post-receive: ref updates → cell
 *
 * **Locked-down auth (defense-in-depth):**
 *
 * - Localhost source check against the **raw TCP connection IP** via
 *   `deps.get_connection_ip(c)` — NOT the proxy-resolved `client_ip`.
 *   `client_ip` can be tricked into reporting `127.0.0.1` when the
 *   connection is from a trusted proxy AND every `X-Forwarded-For`
 *   entry is itself a trusted-proxy IP. The raw connection IP can't
 *   be spoofed by app-layer headers, so it's the right signal for
 *   "is this caller on the same host as the daemon."
 * - Per-repo shared secret in `X-FuzForge-Repo-Secret`, whose BLAKE3 digest
 *   (`hash_hook_secret`) is compared in constant time against
 *   `cell.data.hook_secret_hash`. The secret is minted at repo-create time and
 *   only ever embedded in hook scripts on the same disk as the daemon; the
 *   cell keeps only the digest.
 * - Reject any request carrying `Origin` or `Referer` — hooks never
 *   send them; browsers always do. Closes the cross-context replay
 *   window if a hook secret leaks.
 * - Input validation runs **inside the handler, after the connection-IP
 *   gate** — never before. The route specs declare `input: literal(null)`
 *   so the framework's pre-handler validation middleware is skipped;
 *   a malformed body from a non-loopback caller therefore looks
 *   identical (401 generic) to a well-formed body with bad auth, with
 *   no issue enumeration leaking the schema shape.
 * - All *rejections* are the generic 401 (no enumeration). The slow
 *   path (compare secret) only runs after the cheap localhost gate
 *   passes.
 * - An unexpected internal failure — the cell lookup or the cell write
 *   below — is NOT a rejection and is deliberately left to the route-spec
 *   error mapper
 *   (`wrap_error_catch` in `@fuzdev/fuz_app/http/route_spec.ts`), which
 *   renders a thrown `Error` as `500 {error: 'internal_error'}` (plus a
 *   DEV-only `message`). The Rust twin returns the same body from the spine's
 *   `fuz_http::internal_error_response`, so a catch here would only duplicate
 *   it — and swallowing the throw would lose the logged breadcrumb.
 *
 * On successful `repo-receive-callback`:
 * 1. Update `cell.data` with `head_sha` (if the push touched
 *    `default_branch`), `last_pushed_at`, `last_pushed_by`, and
 *    `last_push_username`.
 * 2. Emit `fuz_forge_repo_updated` broadcast for connected admin clients.
 *
 * @module
 */

import {
	array,
	check,
	is,
	literal,
	min_length,
	nullable,
	object,
	parse,
	pipe,
	string
} from '@fuzdev/fuz_schema/schema.ts';
import type { Context } from 'hono';
import { define_route, type RouteSpec } from '@fuzdev/fuz_app/http/route_spec.ts';
import { route_ok, route_raw } from '@fuzdev/fuz_app/http/route_result.ts';
import { read_json_body } from '@fuzdev/fuz_app/http/json_text.ts';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import type { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import type { JsonObject } from '@fuzdev/fuz_util/json.ts';

import { query_cell_get, query_cell_update } from '@fuzdev/fuz_app/db/cell_queries.ts';
import {
	narrow_repo_cell_data,
	REPO_PATH_PREFIX,
	type RepoCellData
} from '../../fuz_forge/repo/plan_repo.ts';
import { RepoId } from '../../fuz_forge/repo/repo_id.ts';
import { is_full_sha } from '../git/parse.ts';
import { hash_hook_secret } from './fuz_forge_repo_cell.ts';
import type { BackendActionsApi } from '../backend_action_types.ts';
import { strings_equal_constant_time, unauthorized } from './inhandler_auth.ts';
import { to_iso8601_seconds } from '../timestamp.ts';

/** Dependencies for the internal callback routes. */
export interface RepoInternalRoutesDeps {
	query_deps: QueryDeps;
	broadcast: BackendActionsApi;
	log: Logger;
	/**
	 * Raw TCP connection IP extractor. Used by `internal_pre_auth_ok`
	 * to gate `/internal/*` to same-host callers. Bypasses the proxy
	 * middleware's `client_ip` resolution because app-layer headers
	 * can drive that to `127.0.0.1` in degenerate XFF configurations.
	 */
	get_connection_ip: (c: Context) => string | undefined;
}

/**
 * Body shape for `POST /internal/repo-receive-callback`.
 *
 * Exported for the in-handler `parse` (the route spec sets
 * `input: literal(null)` so no pre-handler validation middleware runs;
 * validating in-handler keeps a malformed body from leaking the
 * schema shape via a 400 + issue list before the auth gate fires).
 *
 * An update's `new` is held to `is_full_sha` (which the all-zero id of a
 * deleted ref satisfies): it becomes the cell's `head_sha`, which the read
 * RPCs hand to git. The Rust twin checks the same after its parse
 * (`updates_are_valid` in `internal_routes.rs`).
 */
export const RepoReceiveCallbackBody = object({
	repo_id: pipe(string, min_length(1)),
	updates: array(
		object({
			old: string,
			new: pipe(string, check(is_full_sha)),
			ref: string
		})
	),
	/** Account id of the operator behind the push. May be `null` if the hook ran without endpoint context (defensive). */
	pushed_by: nullable(string),
	/** HTTP Basic username supplied with the push. May be `null` (same reason). */
	push_username: nullable(string)
});

const HOOK_SECRET_HEADER = 'X-FuzForge-Repo-Secret';

const LOOPBACK_IPS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const is_loopback = (ip: string | undefined): boolean => !!ip && LOOPBACK_IPS.has(ip);

/**
 * Resolve the repo cell a hook's push is targeting, by the cell id its scripts
 * embed. Returns `null` if it's missing, not a `repo` cell at a `repos/<slug>`
 * path, or malformed — caller treats as auth failure, no separate 404 path.
 *
 * Distinct from the RPC-side `lookup_repo_cell`
 * (`server/routes/fuz_forge_repo_cell.ts`), which takes `id` xor `slug`,
 * throws `not_found('repo')` on a miss, and hands back the whole `CellRow`:
 * here a miss is one of several indistinguishable 401 paths, so it stays
 * id-only and `null`-returning. The Rust twin has no name to mirror — it folds
 * this lookup into `verify_repo_secret` (`internal_routes.rs`).
 *
 * Both views of `data` come back: the `narrow` drives every read, and `raw` is
 * the write-back base so keys outside `RepoCellData` survive the update
 * (the Rust twin's `VerifiedRepoCell` carries the same pair).
 */
const lookup_push_target_cell = async (
	deps: RepoInternalRoutesDeps,
	repo_id: string
): Promise<{ cell_id: Uuid; raw: JsonObject; narrow: RepoCellData } | null> => {
	// `repo_id` is the cell-id UUID embedded in the hook scripts. Guard with
	// `RepoId` — the one repo-id wire grammar, twin of the Rust
	// `verify_repo_secret`'s `is_valid_repo_id` gate — so a malformed value
	// returns null (auth failure) instead of erroring on the Postgres uuid
	// cast.
	if (!is(RepoId, repo_id)) return null;
	const cell = await query_cell_get(deps.query_deps, repo_id as Uuid);
	// Only a cell the forge serves as a repo: `kind = 'repo'` at a
	// `repos/<slug>` path, the address git auth resolves, so a hook exists for
	// it. The cell layer stores any `data` a caller sends, so `data` that
	// narrows proves nothing about who made the cell; `path` writes are
	// admin-only, and the create authorizer keeps the `repo` kind admin-only
	// (`fuz_forge_cell_create_authorize.ts`). Twin: `verify_repo_secret`.
	if (cell?.kind !== 'repo' || !cell.path?.startsWith(REPO_PATH_PREFIX)) return null;
	const narrow = narrow_repo_cell_data(cell.data);
	if (!narrow) return null;
	// The narrow proved `cell.data` is a non-array object.
	return { cell_id: cell.id, raw: cell.data as JsonObject, narrow };
};

/**
 * Body-free phase 1 of internal auth: raw connection IP must be
 * loopback; `Origin` / `Referer` must be absent; secret header must
 * be present (the value is checked later against the cell once
 * `repo_id` is known).
 *
 * Runs before any body parsing, so a non-loopback caller can't
 * trigger schema-validation 400s and enumerate the endpoint shape.
 */
const internal_pre_auth_ok = (deps: RepoInternalRoutesDeps, c: Context): boolean => {
	const conn_ip = deps.get_connection_ip(c);
	if (!is_loopback(conn_ip)) {
		deps.log.warn(`repo_internal: non-loopback connection rejected (conn_ip=${conn_ip})`);
		return false;
	}
	if (c.req.header('Origin') !== undefined || c.req.header('Referer') !== undefined) {
		deps.log.warn('repo_internal: rejecting request with Origin/Referer header');
		return false;
	}
	if (c.req.header(HOOK_SECRET_HEADER) === undefined) return false;
	return true;
};

/**
 * Phase 2 of internal auth: resolve the cell for `repo_id` and verify
 * the provided secret matches in constant time. Caller MUST have run
 * `internal_pre_auth_ok` first.
 */
const internal_verify_repo_secret = async (
	deps: RepoInternalRoutesDeps,
	c: Context,
	repo_id: string
): Promise<{ cell_id: Uuid; raw: JsonObject; narrow: RepoCellData } | null> => {
	const provided_secret = c.req.header(HOOK_SECRET_HEADER);
	if (!provided_secret) return null;
	const lookup = await lookup_push_target_cell(deps, repo_id);
	if (!lookup) return null;
	if (
		!strings_equal_constant_time(hash_hook_secret(provided_secret), lookup.narrow.hook_secret_hash)
	) {
		deps.log.warn(`repo_internal: secret mismatch for repo_id=${repo_id}`);
		return null;
	}
	return lookup;
};

/**
 * Apply ref updates to the cell. Walks the updates list looking for the
 * default-branch ref (`refs/heads/<default_branch>`) — its `new` SHA
 * becomes `head_sha`. If the push didn't touch the default branch,
 * `head_sha` is preserved from the previous cell snapshot.
 *
 * The next `data` spreads the cell's **raw** object, not the narrow: a repo
 * cell is server-owned state that other tooling may annotate, and spreading
 * the narrow would silently drop every key `RepoCellData` doesn't name
 * (while materializing `null`s for absent optional ones). The Rust twin writes
 * the same four push fields into the raw object via `PushFacts::write_into`.
 */
const compute_next_cell_data = (
	prev: { raw: JsonObject; narrow: RepoCellData },
	updates: ReadonlyArray<{ old: string; new: string; ref: string }>,
	now_iso: string,
	pushed_by: string | null,
	push_username: string | null
): { next: JsonObject; head_sha: string | null } => {
	const default_ref = `refs/heads/${prev.narrow.default_branch}`;
	let head_sha = prev.narrow.head_sha;
	const ZERO_SHA = '0000000000000000000000000000000000000000';
	for (const update of updates) {
		if (update.ref === default_ref) {
			// Branch deletion sets new = zero-SHA; treat as null head.
			head_sha = update.new === ZERO_SHA ? null : update.new;
		}
	}
	const next: JsonObject = {
		...prev.raw,
		head_sha,
		last_pushed_at: now_iso,
		last_pushed_by: pushed_by,
		last_push_username: push_username
	};
	return { next, head_sha };
};

/** Build the internal callback route specs. */
export const create_repo_internal_route_specs = (
	deps: RepoInternalRoutesDeps
): Array<RouteSpec> => {
	return [
		define_route({
			method: 'GET',
			// `:id` is the cell-id UUID embedded in the hook scripts; the
			// `org/repo` slug never reaches this route, so no multi-segment
			// match is needed.
			path: '/internal/repo-config/:id',
			auth: { account: 'none', actor: 'none' },
			description:
				'Pre-receive hook callback: returns {default_branch} after loopback + secret check (in-handler auth)',
			input: literal(null),
			params: object({ id: pipe(string, min_length(1)) }),
			output: object({ default_branch: string }),
			transaction: false,
			handler: async (c) => {
				if (!internal_pre_auth_ok(deps, c)) return route_raw(unauthorized(c));
				const id = c.req.param('id');
				if (!id) return route_raw(unauthorized(c));
				const lookup = await internal_verify_repo_secret(deps, c, id);
				if (!lookup) return route_raw(unauthorized(c));
				return route_ok({ default_branch: lookup.narrow.default_branch });
			}
		}),
		define_route({
			method: 'POST',
			path: '/internal/repo-receive-callback',
			auth: { account: 'none', actor: 'none' },
			description:
				'Post-receive hook callback: updates cell head_sha/last_pushed_* and broadcasts fuz_forge_repo_updated (in-handler auth, in-handler body validation)',
			// `input: literal(null)` skips the pre-handler validation middleware
			// so a malformed body from a non-loopback caller returns the
			// same generic 401 as everything else — no issues-listing 400
			// enumerates the schema. The real schema is validated inside
			// the handler via `RepoReceiveCallbackBody`.
			input: literal(null),
			output: object({ ok: literal(true) }),
			// Cell update + broadcast are not transactional with each other
			// (broadcast is fan-out, not DB); the cell write itself is a
			// single statement so the route doesn't need a wrapping tx.
			transaction: false,
			handler: async (c) => {
				if (!internal_pre_auth_ok(deps, c)) return route_raw(unauthorized(c));

				const raw_body = await read_json_body(c.req);
				if (!raw_body.ok) return route_raw(unauthorized(c));
				const parsed = parse(RepoReceiveCallbackBody, raw_body.value);
				if (!parsed.ok) return route_raw(unauthorized(c));
				const body = parsed.value;

				const lookup = await internal_verify_repo_secret(deps, c, body.repo_id);
				if (!lookup) return route_raw(unauthorized(c));

				const now_iso = to_iso8601_seconds(new Date());
				const { next, head_sha } = compute_next_cell_data(
					lookup,
					body.updates,
					now_iso,
					body.pushed_by,
					body.push_username
				);

				// Uncaught by design: a DB failure here throws to the route-spec
				// error mapper, which renders the canonical
				// `500 {error: 'internal_error'}` — the same body the Rust twin
				// builds explicitly (`internal_routes.rs`). See the module doc.
				await query_cell_update(deps.query_deps, lookup.cell_id, { data: next });

				void deps.broadcast.fuz_forge_repo_updated({
					repo_id: body.repo_id,
					head_sha,
					last_pushed_at: now_iso,
					last_pushed_by: body.pushed_by
				});

				return route_ok({ ok: true });
			}
		})
	];
};
