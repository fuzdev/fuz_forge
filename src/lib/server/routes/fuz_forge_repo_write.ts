/**
 * Write-side RPC handlers for forge repos.
 *
 * `fuz_forge_repo_create` / `_resync` / `_rotate_secret`. Each runs inside the
 * dispatcher transaction (`side_effects: true`, so `ctx.db` is the
 * transaction). `_create` and `_rotate_secret` pair their cell write with
 * explicit on-disk bare-repo / hook-script side effects and unwind disk state
 * by hand when the transactional cell rolls back; `_resync` writes no disk
 * state — it reads the on-disk default-branch tip back into the cell, so the
 * transaction alone is its rollback.
 *
 * All three mount at the single JSON-RPC 2.0 endpoint (`/rpc`, composed under
 * `/api` to become `/api/rpc`); the same handler closures are reused by the
 * WebSocket dispatcher. Action spec definitions live in `action_specs.ts`
 * (shared with the frontend typed client) — this module provides the
 * server-side handlers.
 *
 * The repo-cell shape, its lookups and the subprocess guards live in
 * `server/routes/fuz_forge_repo_cell.ts`.
 *
 * Twin of `crates/fuz_forge_server/src/handlers/repo_write.rs`.
 *
 * @module
 */

import { rpc_action, type RpcAction } from '@fuzdev/fuz_app/actions/action_types.ts';
import { jsonrpc_errors } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import type { RuntimeDeps } from '@fuzdev/fuz_app/runtime/deps.ts';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import type { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import type { JsonObject } from '@fuzdev/fuz_util/json.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import {
	query_cell_get_by_path,
	query_cell_create,
	query_cell_update,
	type CellRow
} from '@fuzdev/fuz_app/db/cell_queries.ts';

import { repo_cell_path, type RepoCellData } from '../../fuz_forge/repo/plan_repo.ts';
import { format_issue, parse } from '@fuzdev/fuz_schema/schema.ts';
import { RepoSlug, repo_name_from_slug } from '../../fuz_forge/repo/repo_id.ts';
import {
	seed_from_host_is_private,
	seed_from_url_canonical,
	SEED_FROM_HOST_MESSAGE,
	SEED_FROM_URL_MESSAGE
} from '../../fuz_forge/repo/seed_from.ts';
import {
	build_callback_url_base,
	clone_bare_repo,
	init_bare_repo,
	install_hooks,
	remove_repo_dir,
	repo_path,
	restore_hooks,
	set_default_head,
	snapshot_hooks,
	type HookSnapshot,
	type RepoStorageDeps
} from '../../fuz_forge/repo/storage.ts';
import { read_default_branch_tip } from '../git/read.ts';
import { to_iso8601_seconds } from '../timestamp.ts';
import {
	hash_hook_secret,
	repo_cell_to_output,
	resolve_repo_cell,
	require_spawn_collect,
	subprocess_failed_error,
	type FuzForgeRoutesDeps
} from './fuz_forge_repo_cell.ts';
import {
	fuz_forge_repo_create_action_spec,
	fuz_forge_repo_resync_action_spec,
	fuz_forge_repo_rotate_secret_action_spec,
	type FuzForgeRepoCreateInput,
	type FuzForgeRepoCreateOutput,
	type FuzForgeRepoMutationInput,
	type FuzForgeRepoResyncOutput,
	type FuzForgeRepoRotateSecretOutput
} from '../../action_specs.ts';

/**
 * The `-32603` message `fuz_forge_repo_create` answers a failed on-disk
 * assembly with, on both backends — the seeded form when `seed_from` was
 * set, else the unseeded one.
 *
 * Fixed rather than detailed on purpose: git's stderr for a failed
 * `clone --bare` (or `init --bare`) names the absolute store root, the `.tmp`
 * assembly scheme and the cell UUID that the surrounding transaction is about
 * to roll back — all operator-only. The detail goes to `log.error` here and
 * `tracing::error!` on the Rust twin (`handlers/repo_write.rs`).
 */
export const REPO_CREATE_SEED_FAILED_MESSAGE = 'repo create failed: seed clone failed';
/** The unseeded twin of `REPO_CREATE_SEED_FAILED_MESSAGE`. */
export const REPO_CREATE_ASSEMBLY_FAILED_MESSAGE = 'repo create failed: repo assembly failed';

/**
 * The `-32603` messages `fuz_forge_repo_rotate_secret` answers a disk failure
 * with, on both backends (the same-named constants in
 * `handlers/repo_write.rs`): the installed scripts could not be read, so
 * nothing changed; the rewrite failed and the old scripts were restored; or
 * the restore failed too.
 */
export const ROTATE_SECRET_UNREADABLE_MESSAGE =
	'rotate-secret failed; hook scripts unreadable, nothing changed';
/** See `ROTATE_SECRET_UNREADABLE_MESSAGE`. */
export const ROTATE_SECRET_REVERTED_MESSAGE = 'rotate-secret failed; reverted to old secret';
/** See `ROTATE_SECRET_UNREADABLE_MESSAGE`. */
export const ROTATE_SECRET_PARTIAL_MESSAGE =
	'rotate-secret partially applied: hook scripts on disk may not match cell.hook_secret_hash; manual reconciliation required';

/**
 * Deps for `assemble_repo`.
 */
interface AssembleRepoDeps {
	/**
	 * Storage capabilities the bare-repo and hook writes run through — and the
	 * `spawn_collect` the seeded-tip read borrows off it.
	 */
	storage: RepoStorageDeps;
	/**
	 * Runtime env access — the repo store root, the hook callback base URL, and
	 * the `PATH` `read_default_branch_tip`'s `git_env` locks its subprocess to.
	 */
	runtime: RuntimeDeps;
	/**
	 * The request transaction's query deps, so the seeded-tip write rolls back
	 * with the create.
	 */
	tx_deps: QueryDeps;
}

/**
 * Options for `assemble_repo`. Twin of the Rust `AssembleRepoOptions` struct
 * (`handlers/repo_write.rs`), which carves the same assembly differently in
 * three places: it carries the subprocess `PATH`, the repo store root and the
 * hook callback base its app resolves once at startup, where this side derives
 * all three from `runtime`; it carries the INSERT's `created_at` because its
 * `assemble_repo` returns the `updated_at` string and so needs the fallback
 * stamp in the bag, where this side's `assemble_repo` returns the row (or
 * `null`) and leaves the create to pick between the row `query_cell_update`
 * wrote and the INSERT row it already holds; and it takes `cell_data` as a
 * separate `&mut Value` parameter rather than a field on the bag.
 */
interface AssembleRepoOptions {
	/**
	 * The created cell's id — the on-disk bare-repo dir name and the hook
	 * scripts' repo id.
	 */
	cell_id: Uuid;
	/** The canonical seed URL, or `null` for an unseeded create. */
	seed_from: string | null;
	default_branch: string;
	/**
	 * Per-repo shared secret the installed hooks authenticate their callback
	 * with — the plaintext the scripts embed; the cell holds its digest.
	 */
	hook_secret: string;
	/** The cell data the create wrote — also the base the seeded-tip write sends. */
	cell_data: RepoCellData;
}

/**
 * Assemble a created repo's on-disk state and, for a seeded repo, read its
 * default-branch tip back into the cell.
 *
 * Everything that can still fail after the cell INSERT lives here, so every
 * failure past it takes the same unwind at the callsite: the disk dir is
 * removed, the cell rolls back with the transaction, and the wire gets the
 * fixed message. That includes the seeded-tip cell UPDATE — a DB failure there
 * outside this boundary would roll the cell back and leave `<id>.git` on disk
 * forever, under a `-32603` naming the SQL step. The Rust twin's
 * `assemble_repo` (`handlers/repo_write.rs`) draws the same boundary.
 *
 * @param deps - storage, runtime, and transaction-scoped query deps
 * @param options - the created cell's id plus the create input the assembly reads
 * @returns the row the seeded-tip write returned, or `null` for an unseeded
 * repo, a seed carrying no branch by that name, or a raced delete
 * @mutates `options.cell_data` - sets `head_sha` when a seeded tip resolves
 * @throws Error when any storage step, the seeded-tip read, or the seeded-tip
 * cell write fails, so the caller's `catch` owns the disk unwind and the fixed
 * message
 */
const assemble_repo = async (
	deps: AssembleRepoDeps,
	options: AssembleRepoOptions
): Promise<CellRow | null> => {
	const { storage, runtime, tx_deps } = deps;
	const { cell_id, seed_from, default_branch, hook_secret, cell_data } = options;
	if (seed_from) {
		await clone_bare_repo(storage, cell_id, seed_from);
	} else {
		await init_bare_repo(storage, cell_id);
	}
	await set_default_head(storage, cell_id, default_branch);
	await install_hooks(storage, {
		id: cell_id,
		hook_secret,
		callback_url_base: build_callback_url_base(runtime)
	});
	if (!seed_from) return null;
	// A seeded repo already has history, so read its default-branch tip into
	// the cell now — the same read `fuz_forge_repo_resync` performs, against
	// the same on-disk repo. Without it a freshly mirrored repo browses with an
	// EMPTY commit log (`fuz_forge_repo_log` takes the never-pushed shortcut on
	// a null `head_sha`) until an operator resyncs, while `_refs` / `_tree` /
	// `_blob` all work — mirroring is the forge's first use case, so that split
	// is a defect, not a nicety.
	//
	// `no_such_ref` is NOT a failure: the upstream may simply carry no branch
	// by this name (a `master` upstream cloned into a `main` repo), which is
	// the same null tip an unseeded create has. Only a real subprocess failure
	// throws — from inside this boundary, so it unwinds the disk and answers
	// the fixed seed message like any other step.
	const tip = await read_default_branch_tip(
		{ spawn_collect: storage.spawn_collect, runtime },
		{ repo_path: repo_path(runtime, cell_id), default_branch }
	);
	if (!tip.ok && tip.reason === 'subprocess_failed') {
		throw new Error(`failed to read seeded default-branch tip: ${tip.detail}`);
	}
	if (!tip.ok) return null;
	cell_data.head_sha = tip.sha;
	// Keep the row the response is built from in step with the write,
	// `updated_at` included — the update stamps it, so returning the pre-update
	// row would hand the client a repo whose `updated_at` a following
	// `fuz_forge_repo_get` could contradict.
	//
	// Today the two stamps are equal, and deliberately so: both writes run in
	// one transaction and Postgres `NOW()` is transaction-scoped, so the
	// INSERT's `created_at` and this UPDATE's `updated_at` are the same instant.
	// Reading back the updated row is defensive — it holds if the create is ever
	// split across transactions, or if either write moves to `clock_timestamp()`.
	// Same note on the Rust twin's `update_repo_cell_data_returning_updated_at`.
	return query_cell_update(tx_deps, cell_id, {
		data: cell_data
	});
};

/**
 * Mutation RPC actions for forge repos.
 *
 * Handler logic is transport-agnostic: receives validated input and a
 * minimum `ctx` with `notify`/`signal` (plus extra fields when invoked via
 * HTTP RPC that the handler can ignore). fuz_forge-specific deps (runtime,
 * spawn_collect) are closed over from `FuzForgeRoutesDeps`.
 */
export const create_fuz_forge_repo_write_rpc_actions = (
	fuz_forge_deps: FuzForgeRoutesDeps
): Array<RpcAction> => {
	// No `query_deps`: every mutation runs inside the dispatcher transaction
	// and reads/writes through `ctx.db`, so the pool-level db would deadlock
	// against the held connection on a single-connection driver.
	const { runtime, spawn_collect, seed_from_allow_private_hosts, log } = fuz_forge_deps;

	return [
		rpc_action(
			fuz_forge_repo_create_action_spec,
			async (input: FuzForgeRepoCreateInput, ctx): Promise<FuzForgeRepoCreateOutput> => {
				const storage: RepoStorageDeps = {
					...runtime,
					spawn_collect: require_spawn_collect(
						spawn_collect,
						log,
						'fuz_forge_repo_create',
						'forge subprocess unavailable'
					)
				};
				// `side_effects: true` wraps this in `db.transaction`; route all
				// DB calls through `ctx.db` so a single-connection driver doesn't
				// deadlock against the held connection.
				const tx_deps: QueryDeps = { db: ctx.db };
				// The input schema's check admitted the seed URL but left it
				// verbatim (the schema stays a plain string in the generated
				// attack surface). Re-serialize it here, before
				// anything reads it: the WHATWG parser and git disagree on
				// spellings like `https://host\user:pw@evil/x`, so only the
				// canonical form guarantees the host validated is the host git
				// dials. This is what lands on the cell and in `git clone`.
				//
				// Ahead of the slug parse, matching the Rust handler's order, so
				// the refusal a caller gets for a bad seed *and* a bad slug is
				// the seed's `-32602` on both backends.
				let seed_from: string | null = null;
				if (input.seed_from !== undefined) {
					seed_from = seed_from_url_canonical(input.seed_from);
					if (seed_from === null) {
						// Unreachable — the schema `check` already ran — but the
						// canonical form is load-bearing, so don't assert it.
						throw jsonrpc_errors.validation_error(`invalid seed_from: ${SEED_FROM_URL_MESSAGE}`);
					}
					// Host policy, last of the three seed gates (grammar →
					// canonicalize → host). The check runs on the canonical host,
					// so the address judged is the address git dials. It lives
					// here rather than on the input schema because the schema is
					// env-free and this gate is operator-configurable; the Rust
					// twin folds it into `require_seed_from_url`, which can read
					// the flag off the app.
					if (
						!seed_from_allow_private_hosts &&
						seed_from_host_is_private(new URL(seed_from).hostname)
					) {
						throw jsonrpc_errors.invalid_params(`invalid params: ${SEED_FROM_HOST_MESSAGE}`);
					}
				}

				const { default_branch } = input;
				// The spec types `slug` as a bounded string; enforce the real
				// `org/repo` shape here (lowercase-canonicalized on success).
				const slug_parsed = parse(RepoSlug, input.slug);
				if (!slug_parsed.ok) {
					throw jsonrpc_errors.validation_error(
						`invalid slug: ${slug_parsed.issues.map((i) => i.message ?? format_issue(i)).join('; ')}`
					);
				}
				const slug = slug_parsed.value;
				const name = repo_name_from_slug(slug);

				// Friendly duplicate error. The `repos/<slug>` unique path index
				// is the authoritative guard (it also closes the TOCTOU race),
				// but a 409 reads better than a raw constraint violation.
				const existing = await query_cell_get_by_path(tx_deps, repo_cell_path(slug));
				if (existing) throw jsonrpc_errors.conflict(`repo slug already exists: ${slug}`);

				const hook_secret = crypto.randomUUID();
				const seed_completed_at = seed_from ? to_iso8601_seconds(new Date()) : null;
				// `head_sha` starts null and stays null for an unseeded create —
				// an empty repo has no tip until the first push. A *seeded*
				// create resolves the cloned default-branch tip below, after the
				// bare repo is on disk.
				const cell_data: RepoCellData = {
					slug,
					name,
					default_branch,
					seed_from,
					seed_completed_at,
					// The cell keeps the digest; the plaintext goes only into the
					// hook scripts `assemble_repo` installs.
					hook_secret_hash: hash_hook_secret(hook_secret),
					head_sha: null,
					last_pushed_at: null,
					last_pushed_by: null,
					last_push_username: null
				};

				// Set by the seeded-tip write in `assemble_repo`, when there is
				// one; the response is built from it so the client sees the same
				// row a following `fuz_forge_repo_get` returns.
				let seeded_cell: CellRow | null = null;

				// Create the cell first so its DB-generated `id` becomes the
				// on-disk bare-repo dir name and the hook scripts' repo id. A
				// throw past this point rolls the cell back with the surrounding
				// transaction; the filesystem isn't transactional, so disk state
				// is unwound explicitly in the catch.
				const cell = await query_cell_create(tx_deps, {
					path: repo_cell_path(slug),
					data: cell_data,
					// `kind` is the write-once top-level `cell.kind` column — not a
					// `data` field (a `kind` inside `data` is rejected upstream).
					kind: 'repo',
					// Cells are owned by the acting actor (the `created_by` FK
					// references `actor`, not `account`), matching the package's
					// own cell-create actions.
					created_by: ctx.auth.actor.id
				});

				try {
					// Everything that can still fail after the cell INSERT lives
					// behind `assemble_repo`, so every failure past it takes the
					// one unwind in the `catch` below.
					seeded_cell = await assemble_repo(
						{ storage, runtime, tx_deps },
						{ cell_id: cell.id, seed_from, default_branch, hook_secret, cell_data }
					);
				} catch (err) {
					// Best-effort disk unwind; the cell insert rolls back when
					// this throw aborts the transaction.
					await remove_repo_dir(runtime, cell.id);
					const detail = to_error_message(err);
					log.error(`[fuz_forge_repo_create] failed for slug=${slug}: ${detail}`);
					// The detail is operator-only: git's stderr names the store
					// root, the `.tmp` assembly scheme and the cell UUID that is
					// about to roll back. The wire gets the fixed message both
					// backends answer with.
					throw jsonrpc_errors.internal_error(
						seed_from ? REPO_CREATE_SEED_FAILED_MESSAGE : REPO_CREATE_ASSEMBLY_FAILED_MESSAGE
					);
				}

				const output = repo_cell_to_output(seeded_cell ?? cell);
				if (!output) {
					// Unreachable — we just built `cell_data` — but keep the 500
					// path honest rather than asserting non-null.
					throw jsonrpc_errors.internal_error('repo create produced a malformed cell');
				}
				return { repo: output };
			}
		),
		rpc_action(
			fuz_forge_repo_resync_action_spec,
			async (input: FuzForgeRepoMutationInput, ctx): Promise<FuzForgeRepoResyncOutput> => {
				const sc = require_spawn_collect(
					spawn_collect,
					log,
					'fuz_forge_repo_resync',
					'forge subprocess unavailable'
				);
				// `side_effects: true` wraps the handler in `db.transaction`,
				// so every DB call inside must route through `ctx.db` —
				// reading or writing via the pool would deadlock against
				// the held connection on single-connection drivers.
				const tx_deps: QueryDeps = { db: ctx.db };
				const {
					cell,
					data,
					raw_data,
					repo_path: resync_repo_path
				} = await resolve_repo_cell(
					{ query_deps: tx_deps, runtime },
					log,
					'fuz_forge_repo_resync',
					input
				);
				const tip = await read_default_branch_tip(
					{ spawn_collect: sc, runtime },
					{ repo_path: resync_repo_path, default_branch: data.default_branch }
				);
				if (!tip.ok && tip.reason === 'subprocess_failed') {
					// Don't blow away a known-good head_sha based on a
					// transient subprocess failure — leave the cell alone
					// and surface the error so the operator can retry.
					throw subprocess_failed_error(
						log,
						'fuz_forge_repo_resync',
						cell.path,
						tip.detail,
						'failed to read default-branch tip'
					);
				}
				const previous_head_sha = data.head_sha;
				const head_sha = tip.ok ? tip.sha : null;
				if (head_sha !== previous_head_sha) {
					// Spread the RAW cell object, not the narrow — keys outside
					// `RepoCellData` survive the write-back (Rust twin does the same).
					const next_data: JsonObject = { ...raw_data, head_sha };
					await query_cell_update(tx_deps, cell.id, { data: next_data });
				}
				// TODO: insert fuz_forge_repo_event row
				// {event_type: 'resync', actor_id: ctx.auth.account.id,
				//  payload: {previous_head_sha, head_sha}}.
				return { previous_head_sha, head_sha };
			}
		),
		rpc_action(
			fuz_forge_repo_rotate_secret_action_spec,
			async (input: FuzForgeRepoMutationInput, ctx): Promise<FuzForgeRepoRotateSecretOutput> => {
				const storage: RepoStorageDeps = {
					...runtime,
					spawn_collect: require_spawn_collect(
						spawn_collect,
						log,
						'fuz_forge_repo_rotate_secret',
						'forge subprocess unavailable'
					)
				};
				const tx_deps: QueryDeps = { db: ctx.db };
				const { cell, raw_data } = await resolve_repo_cell(
					{ query_deps: tx_deps, runtime },
					log,
					'fuz_forge_repo_rotate_secret',
					input
				);
				const new_secret = crypto.randomUUID();
				const callback_url_base = build_callback_url_base(runtime);

				// The cell holds only the old secret's digest, so a failed rewrite
				// is rolled back from the scripts' text, read before anything
				// changes.
				let snapshot: HookSnapshot;
				try {
					snapshot = await snapshot_hooks(storage, cell.id);
				} catch (read_err) {
					log.error(
						`[fuz_forge_repo_rotate_secret] hook read failed for ${cell.path}: ${to_error_message(read_err)}`
					);
					throw jsonrpc_errors.internal_error(ROTATE_SECRET_UNREADABLE_MESSAGE);
				}

				// Stage the new digest in the dispatcher's transaction
				// (`side_effects: true` wraps the handler in db.transaction).
				// Any throw below this point rolls the cell back automatically;
				// the explicit disk-side recovery just keeps the on-disk
				// scripts consistent with the rolled-back cell.
				// Raw spread, same reason as resync, minus any legacy plaintext
				// `hook_secret`: a cell that held one and was given a digest by
				// hand would otherwise carry the old plaintext through every
				// later rotation.
				const { hook_secret: _legacy_plaintext, ...kept_data } = raw_data;
				const next_data: JsonObject = {
					...kept_data,
					hook_secret_hash: hash_hook_secret(new_secret)
				};
				await query_cell_update(tx_deps, cell.id, { data: next_data });

				try {
					await install_hooks(storage, {
						id: cell.id,
						hook_secret: new_secret,
						callback_url_base
					});
				} catch (forward_err) {
					const forward_detail = to_error_message(forward_err);
					log.error(
						`[fuz_forge_repo_rotate_secret] hook write failed for ${cell.path}: ${forward_detail}`
					);
					try {
						await restore_hooks(storage, cell.id, snapshot);
					} catch (rollback_err) {
						const rb_detail = to_error_message(rollback_err);
						log.error(
							`[fuz_forge_repo_rotate_secret] disk rollback failed for ${cell.path}: ${rb_detail}`
						);
						throw jsonrpc_errors.internal_error(ROTATE_SECRET_PARTIAL_MESSAGE);
					}
					throw jsonrpc_errors.internal_error(ROTATE_SECRET_REVERTED_MESSAGE);
				}
				// TODO: insert fuz_forge_repo_event row
				// {event_type: 'rotate_secret', actor_id: ctx.auth.account.id}.
				return { ok: true as const };
			}
		)
	];
};
