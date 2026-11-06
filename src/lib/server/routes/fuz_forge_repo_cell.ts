/**
 * The repo cell layer the forge's RPC handlers share.
 *
 * One repo is one `cell` at `repos/<slug>` with `kind = 'repo'`. Both handler
 * factories — the reads in `server/routes/fuz_forge_repo_read.ts` and the
 * writes in `server/routes/fuz_forge_repo_write.ts` — reach a repo through
 * here, so one module decides what a usable repo cell is, how it is looked up,
 * and how it becomes wire output. `FuzForgeRoutesDeps`, the bundle both
 * factories close over, lives here for the same reason.
 *
 * File-for-file twin of `crates/fuz_forge_server/src/handlers/repo_cell.rs`.
 * The file pairing is exact; the members inside are not — the two sides carve
 * the same work differently, and this side additionally carries two
 * subprocess guards `repo_cell.rs` has no counterpart for (one is TS-only,
 * the other's twin lives in `forge_git/read.rs`):
 *
 * | this module | Rust twin | how they differ |
 * | --- | --- | --- |
 * | `repo_cell_to_output` | `repo_cell_to_output` | same concept, same name; the Rust one takes the `method` + `message` its warn log needs, this one leaves logging to callers |
 * | `lookup_repo_cell` | `query_repo_cell` + `query_repo_cell_by_slug` | one id-xor-slug function that throws `not_found('repo')`, against two `Option`-returning queries whose callers decide the miss |
 * | `resolve_repo_cell` | `resolve_repo_path` + `resolve_repo_mutation` | one resolver serving reads and writes, against a read-side one in `handlers/repo_cell.rs` and a mutation-side one in `handlers/repo_write.rs` |
 * | `require_spawn_collect` | — | TS-only: this side's `spawn_collect` dep is optional and needs a 503 guard, where the Rust app always carries its `git_path` |
 * | `subprocess_failed_error` | `git_unavailable` (`forge_git/read.rs`) | the same 503 tail over the same message strings (`failed to read repo history` / `…default-branch tip` / `…commit` / `…refs` / `…tree` / `…blob`), logged at different layers: here in the handler at error level with the repo's cell path, there at the git layer at warn level with a step label |
 * | `hash_hook_secret` | `hash_hook_secret` | same function, same name |
 * | `FuzForgeRoutesDeps` | `FuzForgeApp` | a field-level pairing only — the Rust app struct is the whole application state, not a routes-scoped dep bundle |
 *
 * @module
 */

import { jsonrpc_errors, type ThrownJsonrpcError } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import type { RuntimeDeps } from '@fuzdev/fuz_app/runtime/deps.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import type { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import type { JsonObject } from '@fuzdev/fuz_util/json.ts';
import { hash_blake3 } from '@fuzdev/fuz_util/hash_blake3.ts';
import {
	query_cell_get,
	query_cell_get_by_path,
	type CellRow
} from '@fuzdev/fuz_app/db/cell_queries.ts';

import {
	repo_cell_path,
	narrow_repo_cell_data,
	type RepoCellData
} from '../../fuz_forge/repo/plan_repo.ts';
import { RepoId } from '../../fuz_forge/repo/repo_id.ts';
import { repo_path } from '../../fuz_forge/repo/storage.ts';
import type { SpawnCollect } from '../subprocess.ts';
import type { FuzForgeRepoOutput } from '../../action_specs.ts';

/**
 * The at-rest form of a repo's hook secret: the 64-lowercase-hex BLAKE3 of its
 * UTF-8 bytes, the value the cell stores as `hook_secret_hash`.
 *
 * The plaintext lives only in the repo's hook scripts on disk; the cell holds
 * this digest, and the `/internal/*` callbacks compare the digest of the
 * presented secret against it in constant time. Unkeyed is enough: the secret
 * is a random v4 UUID, so the digest admits no offline guess. Bare hex, not a
 * `blake3:` fact hash, so the cell layer's ref walk never reads it as a fact.
 * Twin: `hash_hook_secret` in `handlers/repo_cell.rs`.
 */
export const hash_hook_secret = (secret: string): string => hash_blake3(secret);

/**
 * Convert a `cell` row into the public list/get repo output. Returns
 * `null` when the cell's `data` doesn't match `RepoCellData` or when
 * `cell.path` is null (impossible for a repo cell but the column allows
 * it). Callers treat `null` as "skip + warn" on list and "404" on get.
 */
export const repo_cell_to_output = (cell: CellRow): FuzForgeRepoOutput | null => {
	const data = narrow_repo_cell_data(cell.data);
	if (!data || cell.path === null) return null;
	return {
		id: cell.id,
		slug: data.slug,
		name: data.name,
		default_branch: data.default_branch,
		seed_from: data.seed_from,
		seed_completed_at: data.seed_completed_at,
		head_sha: data.head_sha,
		last_pushed_at: data.last_pushed_at,
		last_pushed_by: data.last_pushed_by,
		last_push_username: data.last_push_username,
		// The cell layer projects both stamps as the canonical second-precision
		// UTC string, so they go to the wire as read.
		created_at: cell.created_at,
		// `updated_at` is NULL until the first edit on the unified cell layer.
		updated_at: cell.updated_at ?? cell.created_at
	};
};

/**
 * Resolve a repo by `id` xor `slug` to its `cell` row, throwing
 * `not_found('repo')` when absent. The id path is guarded with `RepoId` —
 * the one repo-id wire grammar — so a non-id 404s rather than erroring on
 * the Postgres cast (every wire-`id` is already `RepoId`-validated by its
 * spec — this is defense-in-depth, kept on the same grammar so the forge
 * has exactly one). Both lookups are indexed: `id` via `query_cell_get` on
 * the cell PK, `slug` via the `repos/<slug>` cell path. Shared by the
 * `fuz_forge_repo_get` handler and `resolve_repo_cell`.
 */
export const lookup_repo_cell = async (
	query_deps: QueryDeps,
	input: { id?: string; slug?: string }
): Promise<CellRow> => {
	let cell: CellRow | null = null;
	if (input.id !== undefined) {
		if (!RepoId.safeParse(input.id).success) throw jsonrpc_errors.not_found('repo');
		cell = await query_cell_get(query_deps, input.id as Uuid);
	} else if (input.slug !== undefined) {
		cell = await query_cell_get_by_path(query_deps, repo_cell_path(input.slug));
	}
	if (!cell) throw jsonrpc_errors.not_found('repo');
	return cell;
};

/**
 * Resolve a repo by `id` xor `slug` to its cell + narrowed data +
 * on-disk repo path. Throws a `not_found('repo')` JSON-RPC error for
 * any missing/malformed step (missing cell, malformed `data`) —
 * handlers can call this at the top of their body and treat any throw
 * as the 404 path.
 *
 * Mutating callers read through `data` (the narrow) and write back over
 * `raw_data` (the cell's own `data` object), so keys outside
 * `RepoCellData` survive the update — the Rust twin's
 * `ResolvedRepoMutation` carries the same pair for the same reason.
 *
 * The on-disk repo dir is keyed on the cell-id UUID.
 *
 * Id-only callers (the read-only handlers `fuz_forge_repo_log` /
 * `_commit` / `_refs` / `_tree` / `_blob`) pass `{id: input.id}`.
 * Mutation handlers (`fuz_forge_repo_resync` / `_rotate_secret`) forward
 * their `FuzForgeRepoMutationInput` directly.
 */
export const resolve_repo_cell = async (
	deps: Pick<FuzForgeRoutesDeps, 'query_deps' | 'runtime'>,
	log: Logger,
	method: string,
	input: { id?: string; slug?: string }
): Promise<{
	cell: CellRow & { path: string };
	data: RepoCellData;
	raw_data: JsonObject;
	repo_path: string;
}> => {
	const cell = await lookup_repo_cell(deps.query_deps, input);
	const data = narrow_repo_cell_data(cell.data);
	if (!data || cell.path === null) {
		log.warn(`[${method}] malformed cell ${cell.id} (path=${cell.path})`);
		throw jsonrpc_errors.not_found('repo');
	}
	// `cell.path === null` narrowing is local to this function; the
	// cast hands the tightened invariant out to callers so handlers
	// that pass `cell.path` to a downstream API don't need their own
	// dead null check.
	return {
		cell: cell as CellRow & { path: string },
		data,
		// The narrow above proved `cell.data` is a non-array object.
		raw_data: cell.data as JsonObject,
		// On-disk repo dir is keyed on the cell-id UUID, not the
		// `repos/<slug>` cell path or the clone handle.
		repo_path: repo_path(deps.runtime, cell.id)
	};
};

/**
 * Narrow the optional `FuzForgeRoutesDeps.spawn_collect` for a forge
 * action that needs a subprocess, or fail the request with a 503 when it isn't
 * wired. Production always configures it via `create_app`; the dep is optional
 * only for tests/runtimes that don't supply a subprocess primitive. Guards
 * before any DB round-trip so a misconfigured server fails fast.
 */
export const require_spawn_collect = (
	spawn_collect: SpawnCollect | undefined,
	log: Logger,
	method: string,
	unavailable_message: string
): SpawnCollect => {
	if (!spawn_collect) {
		log.error(`[${method}] spawn_collect not configured`);
		throw jsonrpc_errors.service_unavailable(unavailable_message);
	}
	return spawn_collect;
};

/**
 * Log a forge subprocess failure with the repo's cell path for context and
 * build the 503 error to raise. The shared tail every read/resync handler
 * reaches for a `subprocess_failed` outcome — callers `throw` the returned
 * error so control-flow narrowing applies at the callsite.
 */
export const subprocess_failed_error = (
	log: Logger,
	method: string,
	cell_path: string,
	detail: string,
	message: string
): ThrownJsonrpcError => {
	log.error(`[${method}] subprocess failed for ${cell_path}: ${detail}`);
	return jsonrpc_errors.service_unavailable(message);
};

/**
 * Dependencies for fuz_forge routes.
 */
export interface FuzForgeRoutesDeps {
	runtime: RuntimeDeps;
	/**
	 * Server-level (pool) db every read-only repo handler goes through —
	 * `fuz_forge_repo_list` and `_get` reach it directly, `_log` / `_commit` /
	 * `_refs` / `_tree` / `_blob` via `resolve_repo_cell`. The three mutations
	 * never touch it: each runs inside the dispatcher transaction and builds
	 * its own deps over `ctx.db`, because a pool-level call would deadlock
	 * against the held connection on a single-connection driver.
	 */
	query_deps: QueryDeps;
	/**
	 * Buffered subprocess primitive every forge action that shells out to git
	 * takes through `require_spawn_collect` — the five read actions
	 * (`fuz_forge_repo_log`, `fuz_forge_repo_commit`, `fuz_forge_repo_refs`,
	 * `fuz_forge_repo_tree`, `fuz_forge_repo_blob`) and all three mutations
	 * (`fuz_forge_repo_create`, `fuz_forge_repo_resync`,
	 * `fuz_forge_repo_rotate_secret`). Optional — when omitted those actions
	 * return a 503, worded `forge read subprocess unavailable` on the reads and
	 * `forge subprocess unavailable` on the mutations. Production always wires
	 * it via `create_app`.
	 */
	spawn_collect?: SpawnCollect;
	/**
	 * Whether `fuz_forge_repo_create` admits a `seed_from` whose host is a
	 * loopback / link-local / unspecified / RFC 1918 / ULA address (or
	 * `localhost`). From `FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS`; off in
	 * production. Twin of the Rust `FuzForgeApp.seed_from_allow_private_hosts`.
	 */
	seed_from_allow_private_hosts: boolean;
	log: Logger;
}
