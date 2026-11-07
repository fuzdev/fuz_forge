/**
 * Read-side RPC handlers for forge repos.
 *
 * `fuz_forge_repo_list` / `_get` / `_log` / `_commit` / `_refs` / `_tree` /
 * `_blob`. All seven mount at the single JSON-RPC 2.0 endpoint (`/rpc`,
 * composed under `/api` to become `/api/rpc`); the same handler closures are
 * reused by the WebSocket dispatcher. Action spec definitions live in
 * `action_specs.ts` (shared with the frontend typed client) — this module
 * provides the server-side handlers.
 *
 * The repo-cell shape, its lookups and the on-disk path resolver live in
 * `server/routes/fuz_forge_repo_cell.ts`; the git subprocess and record
 * parsing are delegated to `server/git/read.ts`.
 *
 * Twin of `crates/fuz_forge_server/src/handlers/repo_read.rs`.
 *
 * @module
 */

import { rpc_action, type RpcAction } from '@fuzdev/fuz_app/actions/action_types.ts';
import { jsonrpc_errors } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { query_addressed_cells_by_kind } from '../db/fuz_forge_cell_queries.ts';
import {
	read_log,
	read_commit,
	read_refs,
	read_tree,
	read_blob,
	DEFAULT_LOG_LIMIT,
	MAX_LOG_LIMIT,
	INVALID_AUTHOR_PATTERN_MESSAGE
} from '../git/read.ts';
import {
	repo_cell_to_output,
	lookup_repo_cell,
	resolve_repo_cell,
	require_spawn_collect,
	subprocess_failed_error,
	type FuzForgeRoutesDeps
} from './fuz_forge_repo_cell.ts';
import {
	fuz_forge_repo_list_action_spec,
	fuz_forge_repo_get_action_spec,
	fuz_forge_repo_log_action_spec,
	fuz_forge_repo_commit_action_spec,
	fuz_forge_repo_refs_action_spec,
	fuz_forge_repo_tree_action_spec,
	fuz_forge_repo_blob_action_spec,
	type FuzForgeRepoOutput,
	type FuzForgeRepoGetInput,
	type FuzForgeRepoListInput,
	type FuzForgeRepoLogInput,
	type FuzForgeRepoLogOutput,
	type FuzForgeRepoCommitInput,
	type FuzForgeRepoCommitOutput,
	type FuzForgeRepoRefsInput,
	type FuzForgeRepoRefsOutput,
	type FuzForgeRepoTreeInput,
	type FuzForgeRepoTreeOutput,
	type FuzForgeRepoBlobInput,
	type FuzForgeRepoBlobOutput
} from '../../action_specs.ts';

/**
 * Read-only RPC actions for forge repos.
 *
 * Handler logic is transport-agnostic: receives validated input and a
 * minimum `ctx` with `notify`/`signal` (plus extra fields when invoked via
 * HTTP RPC that the handler can ignore). fuz_forge-specific deps (runtime,
 * query_deps) are closed over from `FuzForgeRoutesDeps`.
 */
export const create_fuz_forge_repo_read_rpc_actions = (
	fuz_forge_deps: FuzForgeRoutesDeps
): Array<RpcAction> => {
	const { runtime, query_deps, spawn_collect, log } = fuz_forge_deps;

	return [
		rpc_action(fuz_forge_repo_list_action_spec, async (input: FuzForgeRepoListInput) => {
			// Repo cells are the globally-pathed `repos/<slug>` cells with
			// the top-level `cell.kind = 'repo'`; list them by kind (no hub).
			const cells = await query_addressed_cells_by_kind(query_deps, 'repo');
			// Filters run client-side (post-narrow). Admin-only forge has
			// low repo counts, so a JS-side filter is fine for v1; revisit
			// with an indexed query if counts grow past O(100).
			//
			// The two `since` fields carry **different grammars on purpose**,
			// and each is identical across the backends.
			//
			// `fuz_forge_repo_list`'s is the shared UTC ISO 8601 datetime —
			// `RepoListSince` (the UTC ISO 8601 regex plus the year ≥ 1 and
			// 64-char bounds Postgres needs) on the input schema here,
			// `require_iso8601_datetime` on Rust — so an off-grammar value is
			// `-32602` on both before any store sees it. It has to be: the
			// filter is then resolved by each backend's own parser
			// (`Date.parse` below, a `timestamptz` cast there), and those
			// disagree on Postgres's special words — `yesterday` / `today` /
			// `now` / `epoch` / `infinity` all parse there and are `NaN`
			// here, so an ungated `{since: 'yesterday'}` would filter on Rust
			// and list everything here. The grammar makes that unreachable; the schema
			// having already run, `Date.parse` below cannot return `NaN`.
			//
			// `fuz_forge_repo_log`'s is git's **approxidate**: the raw string
			// goes to `git log --since=` on both backends, which is identical
			// by construction and much wider (`2 weeks ago`). Wider, not
			// laxer — git never *fails* on a spelling it doesn't recognize,
			// but it does not ignore it either: `git rev-parse --since=garbage`
			// resolves to `--max-age=<now>`, so a garbage window silently
			// drops every past commit. That is the trade `repo_list` refuses
			// to make, which is why its own `since` is the strict grammar
			// above. Twin: `handlers/repo_read.rs`.
			const since_ms = input.since ? Date.parse(input.since) : null;
			// `slug_prefix` is an exact, CASE-SENSITIVE prefix on `data.slug`
			// (lowercase-canonical, so callers use lowercase prefixes; an
			// uppercase prefix matches nothing — see action_specs.ts).
			const slug_prefix = input.slug_prefix;
			const repos: Array<FuzForgeRepoOutput> = [];
			for (const cell of cells) {
				const output = repo_cell_to_output(cell);
				if (!output) {
					// Malformed cell: log and skip so the list keeps making
					// progress instead of failing wholesale. Same posture
					// as the planner uses on cell-narrowing failure.
					log.warn(`[fuz_forge_repo_list] skipping malformed cell ${cell.id} (path=${cell.path})`);
					continue;
				}
				if (slug_prefix && !output.slug.startsWith(slug_prefix)) continue;
				if (since_ms !== null && !Number.isNaN(since_ms)) {
					if (!output.last_pushed_at) continue;
					if (Date.parse(output.last_pushed_at) < since_ms) continue;
				}
				repos.push(output);
			}
			return { repos };
		}),
		rpc_action(fuz_forge_repo_get_action_spec, async (input: FuzForgeRepoGetInput) => {
			const cell = await lookup_repo_cell(query_deps, input);
			const output = repo_cell_to_output(cell);
			if (!output) {
				// Cell exists but its `data` doesn't match `RepoCellData` —
				// treat as not-found to match list-side skip semantics and
				// avoid leaking the malformed shape to clients.
				log.warn(`[fuz_forge_repo_get] malformed cell ${cell.id} (path=${cell.path})`);
				throw jsonrpc_errors.not_found('repo');
			}
			return { repo: output };
		}),
		rpc_action(
			fuz_forge_repo_log_action_spec,
			async (input: FuzForgeRepoLogInput): Promise<FuzForgeRepoLogOutput> => {
				const sc = require_spawn_collect(
					spawn_collect,
					log,
					'fuz_forge_repo_log',
					'forge read subprocess unavailable'
				);
				const {
					cell,
					data,
					repo_path: log_repo_path
				} = await resolve_repo_cell({ query_deps, runtime }, log, 'fuz_forge_repo_log', {
					id: input.id
				});
				const ref = input.ref ?? data.default_branch;
				// Empty repo / branch not yet pushed: skip the subprocess for
				// the no-cursor case (first page). With a cursor, defer to
				// `read_log` so a stale cursor still surfaces as no_such_ref
				// → empty page with `next_cursor: null`.
				if (!data.head_sha && input.cursor === undefined) {
					return { commits: [], next_cursor: null, ref };
				}

				// Clamp the page size here (mirrors the Rust handler); `read_log`
				// then honors `limit + 1` verbatim so the pagination probe isn't
				// re-clamped away at the MAX_LOG_LIMIT boundary.
				const limit = Math.min(input.limit ?? DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT);
				// Request `limit + 1` so the trailing extra signals "more
				// pages exist" without a second round-trip. Sliced off
				// before returning to the client.
				const result = await read_log(
					{ spawn_collect: sc, runtime },
					{
						repo_path: log_repo_path,
						ref,
						cursor: input.cursor,
						limit: limit + 1,
						author: input.author,
						// `since` is git's approxidate here, not the ISO 8601
						// grammar `fuz_forge_repo_list` holds its own `since` to —
						// see the note there. Identical on both backends by
						// construction: the raw string reaches `git log --since=`
						// verbatim. An unrecognized spelling never errors, but it
						// resolves to *now* rather than to no filter.
						since: input.since,
						path: input.path
					}
				);
				if (!result.ok) {
					if (result.reason === 'no_such_ref') {
						return { commits: [], next_cursor: null, ref };
					}
					// An `author` pattern git's regex compiler refuses is a
					// client-input miss, so it answers `-32602` with a fixed
					// message rather than the 503 every other stderr produces.
					// Same code, same words on the Rust twin (`read_log`).
					if (result.reason === 'invalid_pattern') {
						throw jsonrpc_errors.invalid_params(INVALID_AUTHOR_PATTERN_MESSAGE);
					}
					throw subprocess_failed_error(
						log,
						'fuz_forge_repo_log',
						cell.path,
						result.detail,
						'failed to read repo history'
					);
				}
				const has_more = result.commits.length > limit;
				const page = has_more ? result.commits.slice(0, limit) : result.commits;
				const next_cursor = has_more ? page[page.length - 1]!.sha : null;
				return { commits: page, next_cursor, ref };
			}
		),
		rpc_action(
			fuz_forge_repo_commit_action_spec,
			async (input: FuzForgeRepoCommitInput): Promise<FuzForgeRepoCommitOutput> => {
				const sc = require_spawn_collect(
					spawn_collect,
					log,
					'fuz_forge_repo_commit',
					'forge read subprocess unavailable'
				);
				const { cell, repo_path: commit_repo_path } = await resolve_repo_cell(
					{ query_deps, runtime },
					log,
					'fuz_forge_repo_commit',
					{ id: input.id }
				);
				const result = await read_commit(
					{ spawn_collect: sc, runtime },
					{ repo_path: commit_repo_path, sha: input.sha }
				);
				if (!result.ok) {
					if (result.reason === 'no_such_ref') {
						throw jsonrpc_errors.not_found('commit');
					}
					throw subprocess_failed_error(
						log,
						'fuz_forge_repo_commit',
						cell.path,
						result.detail,
						'failed to read commit'
					);
				}
				return { commit: result.commit, diff: result.diff };
			}
		),
		rpc_action(
			fuz_forge_repo_refs_action_spec,
			async (input: FuzForgeRepoRefsInput): Promise<FuzForgeRepoRefsOutput> => {
				const sc = require_spawn_collect(
					spawn_collect,
					log,
					'fuz_forge_repo_refs',
					'forge read subprocess unavailable'
				);
				const {
					cell,
					data,
					repo_path: refs_repo_path
				} = await resolve_repo_cell({ query_deps, runtime }, log, 'fuz_forge_repo_refs', {
					id: input.id
				});
				const result = await read_refs(
					{ spawn_collect: sc, runtime },
					{ repo_path: refs_repo_path }
				);
				if (!result.ok) {
					throw subprocess_failed_error(
						log,
						'fuz_forge_repo_refs',
						cell.path,
						result.detail,
						'failed to read refs'
					);
				}
				return { refs: result.refs, default_branch: data.default_branch };
			}
		),
		rpc_action(
			fuz_forge_repo_tree_action_spec,
			async (input: FuzForgeRepoTreeInput): Promise<FuzForgeRepoTreeOutput> => {
				const sc = require_spawn_collect(
					spawn_collect,
					log,
					'fuz_forge_repo_tree',
					'forge read subprocess unavailable'
				);
				const { cell, repo_path: tree_repo_path } = await resolve_repo_cell(
					{ query_deps, runtime },
					log,
					'fuz_forge_repo_tree',
					{ id: input.id }
				);
				const result = await read_tree(
					{ spawn_collect: sc, runtime },
					{ repo_path: tree_repo_path, ref: input.ref, path: input.path }
				);
				if (!result.ok) {
					if (result.reason === 'no_such_ref' || result.reason === 'no_such_path') {
						throw jsonrpc_errors.not_found(result.reason === 'no_such_ref' ? 'ref' : 'path');
					}
					throw subprocess_failed_error(
						log,
						'fuz_forge_repo_tree',
						cell.path,
						result.detail,
						'failed to read tree'
					);
				}
				return { entries: result.entries, resolved_sha: result.resolved_sha };
			}
		),
		rpc_action(
			fuz_forge_repo_blob_action_spec,
			async (input: FuzForgeRepoBlobInput): Promise<FuzForgeRepoBlobOutput> => {
				const sc = require_spawn_collect(
					spawn_collect,
					log,
					'fuz_forge_repo_blob',
					'forge read subprocess unavailable'
				);
				const { cell, repo_path: blob_repo_path } = await resolve_repo_cell(
					{ query_deps, runtime },
					log,
					'fuz_forge_repo_blob',
					{ id: input.id }
				);
				const result = await read_blob(
					{ spawn_collect: sc, runtime },
					{ repo_path: blob_repo_path, ref: input.ref, path: input.path }
				);
				if (!result.ok) {
					// Propagate distinct 404 reasons so the client can tell
					// "branch gone" from "file gone" from "path resolved to a
					// tree" — sibling handlers (`fuz_forge_repo_tree`,
					// `fuz_forge_repo_commit`) make the same distinction.
					if (result.reason === 'no_such_ref') throw jsonrpc_errors.not_found('ref');
					if (result.reason === 'no_such_path') throw jsonrpc_errors.not_found('path');
					if (result.reason === 'not_a_blob') throw jsonrpc_errors.not_found('blob');
					throw subprocess_failed_error(
						log,
						'fuz_forge_repo_blob',
						cell.path,
						result.detail,
						'failed to read blob'
					);
				}
				return { sha: result.sha, size: result.size, body: result.body };
			}
		)
	];
};
