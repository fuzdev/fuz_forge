/**
 * Shared cell-data types for forge-hosted repos.
 *
 * Each forge repo is one cell with the top-level `cell.kind = 'repo'`. The
 * cell's `id`
 * (a `Uuid`) is the public handle — the on-disk bare-repo directory name
 * (`<uuid>.git`), the admin browse URL segment, and the wire id every
 * repo RPC accepts. The cell's `path` is `repos/<slug>` (the `org/repo`
 * clone handle, also stored in `data.slug`): the global-unique path index
 * enforces slug uniqueness and backs the indexed slug→cell lookup. The
 * repo browse/push/resync routes narrow a cell's `data` to
 * `RepoCellData` for slug-immutability and `default_branch` drift
 * checks, and surface malformed cells as planning errors.
 *
 * @module
 */

import type { JsonObject } from '@fuzdev/fuz_util/json.ts';

/**
 * Cell `data` shape for a forge repo (one cell per repo).
 *
 * `slug` (the `org/repo` clone handle) and `name` (its repo segment) are
 * set at create time and immutable thereafter — `slug` is mirrored into
 * `cell.path` as `repos/<slug>`. Push-derived fields (`head_sha`,
 * `last_pushed_at`, `last_pushed_by`, `last_push_username`) are written by
 * the internal `post-receive` callback handler on each push — they are
 * absent on a freshly-created cell and surface as `null` until the first
 * push lands. Extends `JsonObject` so the literal is directly assignable
 * to `cell.data: Json` without a cast.
 */
export interface RepoCellData extends JsonObject {
	/** Canonical `org/repo` clone handle; mirrored into `cell.path`. */
	slug: string;
	/** Repo-name segment of the slug (`fuzdev/fuz_app` → `fuz_app`). */
	name: string;
	default_branch: string;
	seed_from: string | null;
	seed_completed_at: string | null;
	/**
	 * BLAKE3 digest (bare lowercase hex) of the per-repo hook secret. The
	 * plaintext lives only in the hook scripts on disk; see `hash_hook_secret`
	 * in `server/routes/fuz_forge_repo_cell.ts`.
	 */
	hook_secret_hash: string;
	/** Tip SHA of the default branch as of the last observed push. */
	head_sha: string | null;
	/** ISO-8601 timestamp of the most recent push that touched any ref. */
	last_pushed_at: string | null;
	/** Account id (uuid) backing the API token used for the most recent push. */
	last_pushed_by: string | null;
	/**
	 * HTTP Basic username supplied with the most recent push. Per
	 * locked-down posture, this is required to equal the
	 * account's `username` at push time; capturing the literal value is
	 * a small audit-trail nicety in case the policy ever loosens.
	 */
	last_push_username: string | null;
}

/**
 * Global `cell.path` prefix for forge-hosted repo cells. A repo's cell
 * lives at `${REPO_PATH_PREFIX}<slug>` — the prefix keeps repo paths from
 * colliding with other cell kinds (e.g. files at `files/<filename>`) now
 * that `path` is globally unique rather than hub-scoped. The path carries
 * the `org/repo` slug (with its `/`), not the cell-id handle.
 */
export const REPO_PATH_PREFIX = 'repos/';

/** Build the canonical `cell.path` for a repo from its `RepoSlug`. */
export const repo_cell_path = (slug: string): string => `${REPO_PATH_PREFIX}${slug}`;

/**
 * Whether a value is an acceptable optional string field: absent, `null`, or
 * a string. A wrong-typed value (a number, a bool, an object) is **not**
 * coerced to `null` — it fails the narrow, so the whole cell reads as
 * malformed. Twin of the Rust `RepoCellData`'s `Option<String>` fields, where
 * serde rejects `{"head_sha": 5}` outright, so a type-corrupt cell reads the
 * same on both backends.
 */
const is_optional_str = (v: unknown): v is string | null | undefined =>
	v === undefined || v === null || typeof v === 'string';

/**
 * Narrow a cell's `data` JSON to `RepoCellData`. Returns `null`
 * for any required-field shape mismatch — and for a wrong-typed optional
 * field (`is_optional_str`) — so a malformed cell behaves
 * like a missing cell, which keeps repo listing/browsing making
 * forward progress on cell corruption rather than getting stuck. The
 * cell-kind discriminator lives on the top-level `cell.kind` column, not
 * in `data`, so it plays no part here.
 *
 * Keys the shape doesn't name are dropped from the returned narrow but are
 * **not** an error; every write-back path spreads over the cell's raw `data`
 * object rather than this narrow, so they survive a mutation.
 */
export const narrow_repo_cell_data = (data: unknown): RepoCellData | null => {
	if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.slug !== 'string') return null;
	if (typeof d.name !== 'string') return null;
	if (typeof d.default_branch !== 'string') return null;
	if (typeof d.hook_secret_hash !== 'string') return null;
	if (!is_optional_str(d.seed_from)) return null;
	if (!is_optional_str(d.seed_completed_at)) return null;
	if (!is_optional_str(d.head_sha)) return null;
	if (!is_optional_str(d.last_pushed_at)) return null;
	if (!is_optional_str(d.last_pushed_by)) return null;
	if (!is_optional_str(d.last_push_username)) return null;
	return {
		slug: d.slug,
		name: d.name,
		default_branch: d.default_branch,
		seed_from: d.seed_from ?? null,
		seed_completed_at: d.seed_completed_at ?? null,
		hook_secret_hash: d.hook_secret_hash,
		head_sha: d.head_sha ?? null,
		last_pushed_at: d.last_pushed_at ?? null,
		last_pushed_by: d.last_pushed_by ?? null,
		last_push_username: d.last_push_username ?? null
	};
};
