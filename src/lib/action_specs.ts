/**
 * Action spec definitions for fuz_forge.
 *
 * Shared between server (handlers) and frontend (typed client).
 * Server imports with `.ts` extensions, frontend gen files with `.js`.
 *
 * @module
 */

import { meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	array,
	boolean,
	check,
	integer,
	literal,
	max_length,
	max_value,
	message,
	min_length,
	min_value,
	nullable,
	number,
	object,
	optional,
	pipe,
	string,
	union,
	variant,
	void as fuz_void,
	with_default,
	with_default_fn,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';
import type {
	RemoteNotificationActionSpec,
	RequestResponseActionSpec,
	ActionSpecUnion
} from '@fuzdev/fuz_app/actions/action_spec.ts';
import { heartbeat_action_spec } from '@fuzdev/fuz_app/actions/heartbeat.ts';
import { cancel_action_spec } from '@fuzdev/fuz_app/actions/cancel.ts';
import { peer_ping_action_spec } from '@fuzdev/fuz_app/actions/peer_ping.ts';
import { protocol_action_specs } from '@fuzdev/fuz_app/actions/protocol.ts';
import { ActingActor } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { ERROR_TOKEN_LIFETIME_INVALID } from '@fuzdev/fuz_app/auth/account_action_specs.ts';
import { TokenLifetimeInput } from '@fuzdev/fuz_app/auth/token_lifetime.ts';
// brings in the `invalid_reason` meta key, merged into fuz_schema's `SchemaMeta`
import type {} from '@fuzdev/fuz_app/schema_meta.ts';
import type {} from '@fuzdev/fuz_app/sensitivity.ts';

// Re-export so codegen (which builds `import * as specs from './action_specs'`)
// resolves `specs.heartbeat_action_spec` / `specs.cancel_action_spec` via the
// namespace lookup. `all_fuz_forge_action_specs` references each protocol spec once
// via `protocol_action_specs`; the re-exports are name aliases only.
export { heartbeat_action_spec, cancel_action_spec, peer_ping_action_spec };

import { RepoId, RepoSlug } from './fuz_forge/repo/repo_id.ts';
import { RepoListSince } from './fuz_forge/repo/repo_list_since.ts';
import { seed_from_url_canonical, SEED_FROM_URL_MESSAGE } from './fuz_forge/repo/seed_from.ts';

// Output schemas — match the serialized DB row shapes, not internal types.

/**
 * Forge-hosted repo summary as serialized for the admin UI.
 *
 * Mirrors `RepoCellData` (`fuz_forge/repo/plan_repo.ts`) plus the cell-row
 * timestamps callers want — `created_at` is the cell-create time
 * (when the repo was first applied), `updated_at` is bumped on every
 * cell mutation including the post-receive callback.
 *
 * `hook_secret_hash` is intentionally absent — it's the digest of the
 * credential between the bare repo's hook scripts and the loopback
 * callback, server-only state no list/get response carries.
 */
export const FuzForgeRepoOutput = object({
	/** Cell-id UUID — the repo's wire/dir/URL handle. */
	id: string,
	/** Canonical `org/repo` clone handle. */
	slug: string,
	/** Repo-name segment of the slug. */
	name: string,
	default_branch: string,
	seed_from: nullable(string),
	seed_completed_at: nullable(string),
	head_sha: nullable(string),
	last_pushed_at: nullable(string),
	last_pushed_by: nullable(string),
	last_push_username: nullable(string),
	created_at: string,
	updated_at: string
});
export type FuzForgeRepoOutput = Infer<typeof FuzForgeRepoOutput>;

// Remote notifications (backend → frontend via SSE)

/**
 * Broadcast emitted by the post-receive callback when a push
 * lands on a forge-hosted repo. UI consumers refresh repo overview /
 * list without re-fetching the cell. Fan-out is admin-only, gated by
 * the upgrade-time `require_role(ROLE_ADMIN)` on `/api/ws`.
 *
 * `head_sha` is non-null only when the push touched the cell's
 * `default_branch`; otherwise the field stays at its prior value and
 * is echoed here unchanged. `last_pushed_by` is the account_id behind
 * the API token that authenticated the push.
 */
export const fuz_forge_repo_updated_action_spec = {
	method: 'fuz_forge_repo_updated',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	async: true,
	input: object({
		repo_id: string,
		head_sha: nullable(string),
		last_pushed_at: string,
		last_pushed_by: nullable(string)
	}),
	output: fuz_void,
	description: 'A forge-hosted repo received a push'
} satisfies RemoteNotificationActionSpec;

// RPC request/response actions

/**
 * Input for `fuz_forge_repo_list`. All filters optional; default returns every
 * repo cell under the `repos` hub ordered newest-first.
 *
 * - `slug_prefix`: exact, case-sensitive prefix match against `data.slug`
 *   (which is already lowercase-canonicalized by `RepoSlug`). Useful for
 *   "show me all repos under `owner/`".
 * - `since`: filter to repos with `last_pushed_at >= since`. The grammar is
 *   `RepoListSince` — a UTC `YYYY-MM-DDTHH:MM(:SS(.sss)?)?Z` and nothing else,
 *   plus a 64-character cap and a year floor of 1. An off-grammar value is
 *   `-32602` on both backends rather than a silently-skipped filter: the two
 *   stores resolve the string with different date parsers (`Date.parse` on TS,
 *   a `timestamptz` cast on Rust) and those disagree on Postgres's special
 *   words — `yesterday` / `today` / `now` / `epoch` / `infinity` all parse
 *   there and are `NaN` here — so without one grammar in front of them the
 *   same request filtered on one backend and listed everything on the other.
 *   The cap and the year floor close the same split from the other side, where
 *   a plain ISO datetime regex is *wider* than the Postgres cast: year `0000` and a
 *   150-digit fraction both pass it and both made the Rust
 *   backend answer `-32603` against a `200` here. Rust twin:
 *   `require_iso8601_datetime` in `handlers/repo_list_since.rs`, over the same
 *   `MIN_ISO8601_YEAR` / `SINCE_MAX_LENGTH`.
 *   Repos that have never been pushed (`last_pushed_at IS NULL`) are excluded
 *   when `since` is set — they have no recent activity to match.
 *
 *   `fuz_forge_repo_log`'s `since` is deliberately a *different* grammar: it
 *   is handed to `git log --since=` verbatim on both backends, so it reads
 *   git's approxidate (`2 weeks ago`) and is identical by construction. Wider,
 *   not laxer — git never errors on a spelling it doesn't recognize, but it
 *   resolves one to *now* rather than to no filter, which is the behavior this
 *   field refuses to inherit.
 */
export const FuzForgeRepoListInput = with_default_fn(
	object({
		slug_prefix: optional(pipe(string, max_length(255))),
		since: optional(RepoListSince),
		acting: ActingActor
	}),
	() => ({})
);
export type FuzForgeRepoListInput = Infer<typeof FuzForgeRepoListInput>;

export const fuz_forge_repo_list_action_spec = {
	method: 'fuz_forge_repo_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: ['admin'] },
	side_effects: false,
	async: true,
	input: FuzForgeRepoListInput,
	output: object({ repos: array(FuzForgeRepoOutput) }),
	description: 'List forge-hosted repos'
} satisfies RequestResponseActionSpec;

/**
 * Input for `fuz_forge_repo_get` — by `id` (the cell-id UUID) **or**
 * `slug` (the public clone-URL path). Exactly one must be provided;
 * a `check` rejects both-empty and both-set so the input-validation
 * phase surfaces the constraint rather than the handler.
 *
 * `id` is validated as a UUID; `slug` is lowercase-canonicalized. The
 * handler branches on which field is set: id → `query_cell_get(uuid)`;
 * slug → `repos/<slug>` cell-path lookup (both indexed).
 */
export const FuzForgeRepoGetInput = pipe(
	object({
		id: optional(RepoId),
		slug: optional(RepoSlug),
		acting: ActingActor
	}),
	message(
		check((v: { id?: string; slug?: string }) => (v.id !== undefined) !== (v.slug !== undefined)),
		'must provide exactly one of id or slug'
	)
);
export type FuzForgeRepoGetInput = Infer<typeof FuzForgeRepoGetInput>;

export const fuz_forge_repo_get_action_spec = {
	method: 'fuz_forge_repo_get',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: ['admin'] },
	side_effects: false,
	async: true,
	input: FuzForgeRepoGetInput,
	output: object({ repo: FuzForgeRepoOutput }),
	description: 'Get a forge-hosted repo by id'
} satisfies RequestResponseActionSpec;

/**
 * Input shape shared by every repo mutation RPC — `id` xor `slug`,
 * same piped `check` as `FuzForgeRepoGetInput`. Reused so the wire
 * contract for `fuz_forge_repo_resync` and `fuz_forge_repo_rotate_secret` (and
 * future mutation RPCs) stays uniform with
 * the get-side surface.
 */
export const FuzForgeRepoMutationInput = pipe(
	object({
		id: optional(RepoId),
		slug: optional(RepoSlug),
		acting: ActingActor
	}),
	message(
		check((v: { id?: string; slug?: string }) => (v.id !== undefined) !== (v.slug !== undefined)),
		'must provide exactly one of id or slug'
	)
);
export type FuzForgeRepoMutationInput = Infer<typeof FuzForgeRepoMutationInput>;

/**
 * Output for `fuz_forge_repo_resync`. Both fields are SHA-or-null:
 * `previous_head_sha` is the cell's `head_sha` before the resync;
 * `head_sha` is the on-disk truth that just got written. The two are
 * equal when resync was a no-op (cell already matched disk).
 */
export const FuzForgeRepoResyncOutput = object({
	previous_head_sha: nullable(string),
	head_sha: nullable(string)
});
export type FuzForgeRepoResyncOutput = Infer<typeof FuzForgeRepoResyncOutput>;

export const fuz_forge_repo_resync_action_spec = {
	method: 'fuz_forge_repo_resync',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: ['admin'] },
	side_effects: true,
	async: true,
	input: FuzForgeRepoMutationInput,
	output: FuzForgeRepoResyncOutput,
	description:
		"Re-read the on-disk default-branch tip and write it to the cell's head_sha. Idempotent."
} satisfies RequestResponseActionSpec;

/**
 * Output for `fuz_forge_repo_rotate_secret`. Intentionally shape-free
 * besides the success literal — the new secret is never returned on
 * the wire (it lives only on disk in the rendered hook scripts; the cell's
 * `data.hook_secret_hash` holds its digest) and no other observable state
 * changes shape.
 */
export const FuzForgeRepoRotateSecretOutput = object({ ok: literal(true) });
export type FuzForgeRepoRotateSecretOutput = Infer<typeof FuzForgeRepoRotateSecretOutput>;

export const fuz_forge_repo_rotate_secret_action_spec = {
	method: 'fuz_forge_repo_rotate_secret',
	kind: 'request_response',
	initiator: 'frontend',
	// Session-only — mirrors `fuz_forge_token_create_scoped`'s posture on
	// credential-channel mutations. A leaked bearer or scoped api-token
	// cannot rotate the hook-callback credential and lock the daemon
	// out of its own forge.
	auth: {
		account: 'required',
		actor: 'required',
		credential_types: ['session'],
		roles: ['admin']
	},
	side_effects: true,
	async: true,
	input: FuzForgeRepoMutationInput,
	output: FuzForgeRepoRotateSecretOutput,
	description:
		'Mint a fresh per-repo hook secret, rewrite both hook scripts on disk, and update the cell.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

/**
 * Input for `fuz_forge_repo_create`. `slug` is the `org/repo` clone handle
 * (and canonical human id); the repo-name segment is derived server-side.
 * `default_branch` defaults to `main`. `seed_from`, when set, is consumed
 * once at create time for a one-shot `git clone --bare` import from an
 * existing upstream — restricted to an absolute `http`/`https` URL with a
 * host and no embedded credentials (`seed_from_url_canonical`), since the
 * value becomes git's remote and is recorded on the cell.
 */
export const FuzForgeRepoCreateInput = object({
	// Bounded plain string on the wire; the handler parses it as a strict
	// `RepoSlug` (same loose-spec / strict-handler split as `sha` on the
	// commit input). Keeping the regex off the spec lets the generated
	// round-trip/attack-surface harness synthesize a body — its generator
	// can't satisfy the two-segment `org/repo` pattern.
	slug: meta(pipe(string, min_length(3), max_length(129)), {
		description: 'org/repo clone handle (canonical human id); validated server-side'
	}),
	default_branch: meta(with_default(pipe(string, min_length(1), max_length(255)), 'main'), {
		description: 'default branch name (force-push protected)'
	}),
	// Unlike `slug`, the grammar lives ON the schema: `seed_from` is optional,
	// so the generated attack-surface/round-trip harness never has to
	// synthesize one, and the value is handed to `git clone --bare` as the
	// remote — a boundary that belongs at dispatch, before any disk or DB
	// work. Rust twin: `require_seed_from_url` in `handlers/seed_from.rs`.
	//
	// The check only *admits* the value; it deliberately does not normalize
	// it, so the schema stays a plain string in the generated attack surface —
	// the handler re-runs `seed_from_url_canonical` right after parse and
	// stores/clones the canonical form (see
	// `server/routes/fuz_forge_repo_write.ts`).
	seed_from: meta(
		optional(
			pipe(
				string,
				min_length(1),
				max_length(2048),
				message(
					check((value: string) => seed_from_url_canonical(value) !== null),
					SEED_FROM_URL_MESSAGE
				)
			)
		),
		{
			description:
				'one-shot upstream URL to clone --bare from at create time; absolute http(s), host required, no embedded credentials; recorded and cloned in canonical (parser-serialized) form'
		}
	),
	acting: ActingActor
});
export type FuzForgeRepoCreateInput = Infer<typeof FuzForgeRepoCreateInput>;

/** Output for `fuz_forge_repo_create` — the freshly-created repo row. */
export const FuzForgeRepoCreateOutput = object({ repo: FuzForgeRepoOutput });
export type FuzForgeRepoCreateOutput = Infer<typeof FuzForgeRepoCreateOutput>;

export const fuz_forge_repo_create_action_spec = {
	method: 'fuz_forge_repo_create',
	kind: 'request_response',
	initiator: 'frontend',
	// Admin role, any credential type — the forge CLI (API-token auth) is
	// the primary creation path, so this is NOT session-only (unlike
	// rotate_secret). Slug uniqueness is enforced by the `repos/<slug>`
	// cell-path unique index.
	auth: { account: 'required', actor: 'required', roles: ['admin'] },
	side_effects: true,
	async: true,
	input: FuzForgeRepoCreateInput,
	output: FuzForgeRepoCreateOutput,
	description:
		'Create a forge-hosted repo: init (or seed) the bare repo on disk, install hooks, and create the cell.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

/**
 * Single commit summary returned by `fuz_forge_repo_log`. Shape matches the
 * `LOG_RECORD_FORMAT` parser in `server/git/parse.ts`. `parents` is an
 * array (zero entries for root commits, two-plus for merges).
 */
export const FuzForgeRepoCommitSummary = object({
	sha: string,
	short_sha: string,
	subject: string,
	author_name: string,
	author_email: string,
	author_date: string,
	parents: array(string)
});
export type FuzForgeRepoCommitSummary = Infer<typeof FuzForgeRepoCommitSummary>;

/**
 * Length cap on `fuz_forge_repo_log.since`. The value is a git approxidate
 * handed to `git log --since` on both backends (deliberately NOT the ISO grammar
 * `fuz_forge_repo_list.since` takes — `SINCE_MAX_LENGTH` is that field's cap),
 * so this is a plain byte bound. Twin of the Rust `LOG_SINCE_MAX_LENGTH` in
 * `handlers/repo_read.rs`.
 */
export const LOG_SINCE_MAX_LENGTH = 64;

/**
 * Input for `fuz_forge_repo_log` — filtered, cursor-paginated commit list
 * for the `/admin/repos/[id]/log` page.
 *
 * `ref` defaults to the repo's `default_branch` server-side when
 * omitted. `cursor` is the full SHA of the last commit shown on the
 * previous page; the server walks `<cursor>^` so a force-push between
 * pages yields an empty next page rather than silently shifting the
 * window. Limits cap to 200 (`MAX_LOG_LIMIT` in `server/git/read.ts`)
 * to keep the per-request output bounded under `MAX_LOG_BYTES`.
 */
export const FuzForgeRepoLogInput = object({
	id: RepoId,
	ref: optional(pipe(string, max_length(255))),
	limit: optional(pipe(number, integer, min_value(1), max_value(200))),
	cursor: optional(pipe(string, max_length(64))),
	author: optional(meta(pipe(string, max_length(200)), { sensitivity: 'personal' })),
	since: optional(pipe(string, max_length(LOG_SINCE_MAX_LENGTH))),
	path: optional(pipe(string, max_length(1024))),
	acting: ActingActor
});
export type FuzForgeRepoLogInput = Infer<typeof FuzForgeRepoLogInput>;

/**
 * Output for `fuz_forge_repo_log`. `next_cursor` is a SHA the client passes
 * back as `cursor` to fetch the next page; `null` means the end of
 * history (no more pages, or the repo is empty). `ref` echoes the
 * branch the log was actually read from — useful when `input.ref` was
 * omitted and the client wants to display "log of <branch>".
 */
export const FuzForgeRepoLogOutput = object({
	commits: array(FuzForgeRepoCommitSummary),
	next_cursor: nullable(string),
	ref: string
});
export type FuzForgeRepoLogOutput = Infer<typeof FuzForgeRepoLogOutput>;

export const fuz_forge_repo_log_action_spec = {
	method: 'fuz_forge_repo_log',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: ['admin'] },
	side_effects: false,
	async: true,
	input: FuzForgeRepoLogInput,
	output: FuzForgeRepoLogOutput,
	description: 'Filtered, cursor-paginated commit log for a forge-hosted repo'
} satisfies RequestResponseActionSpec;

/**
 * Single-commit detail returned by `fuz_forge_repo_commit`. Superset of
 * `FuzForgeRepoCommitSummary` — adds committer fields (author and
 * committer routinely differ on merges/rebases) and the raw body so
 * the UI can render the full commit message under the subject line.
 */
export const FuzForgeRepoCommitDetail = object({
	sha: string,
	short_sha: string,
	subject: string,
	author_name: string,
	author_email: string,
	author_date: string,
	committer_name: string,
	committer_email: string,
	committer_date: string,
	parents: array(string),
	body: string
});
export type FuzForgeRepoCommitDetail = Infer<typeof FuzForgeRepoCommitDetail>;

/**
 * Diff body for a single commit. `text` is the unified-diff output of
 * `git show -p` for the SHA. `truncated` flips true when the server
 * hit its diff-size cap (5 MB by default); in that case
 * `text` is empty and the UI shows a "diff exceeded the size limit"
 * notice rather than a partial dump.
 *
 * There is no server-side hunk parsing: the wire carries raw text + a
 * truncated flag. Structured hunks are deferred until something needs
 * them (e.g. inline review comments anchored to lines).
 */
export const FuzForgeRepoCommitDiff = object({
	text: string,
	truncated: boolean
});
export type FuzForgeRepoCommitDiff = Infer<typeof FuzForgeRepoCommitDiff>;

/**
 * Input for `fuz_forge_repo_commit` — fetch a single commit's metadata +
 * diff body. `sha` is a string with a max-length cap; the read
 * helper rejects anything that isn't a 40-char hex SHA-1 pre-spawn
 * (→ 404 not_found), same defense-in-depth posture as `read_log`'s
 * cursor validation.
 */
export const FuzForgeRepoCommitInput = object({
	id: RepoId,
	sha: pipe(string, max_length(64)),
	acting: ActingActor
});
export type FuzForgeRepoCommitInput = Infer<typeof FuzForgeRepoCommitInput>;

export const FuzForgeRepoCommitOutput = object({
	commit: FuzForgeRepoCommitDetail,
	diff: FuzForgeRepoCommitDiff
});
export type FuzForgeRepoCommitOutput = Infer<typeof FuzForgeRepoCommitOutput>;

export const fuz_forge_repo_commit_action_spec = {
	method: 'fuz_forge_repo_commit',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: ['admin'] },
	side_effects: false,
	async: true,
	input: FuzForgeRepoCommitInput,
	output: FuzForgeRepoCommitOutput,
	description: 'Single commit metadata + diff for a forge-hosted repo'
} satisfies RequestResponseActionSpec;

/**
 * One ref entry returned by `fuz_forge_repo_refs`. `name` is the full ref
 * path (`refs/heads/main`, `refs/tags/v1.0`); `object_type` is
 * typically `'commit'` for branches and either `'commit'` (lightweight
 * tag) or `'tag'` (annotated tag) for tags. `target_sha` is non-empty
 * only for annotated tags. `committer_date` is empty for tags.
 */
export const FuzForgeRepoRefEntry = object({
	name: string,
	object_type: string,
	sha: string,
	target_sha: string,
	committer_date: string
});
export type FuzForgeRepoRefEntry = Infer<typeof FuzForgeRepoRefEntry>;

export const FuzForgeRepoRefsInput = object({ id: RepoId, acting: ActingActor });
export type FuzForgeRepoRefsInput = Infer<typeof FuzForgeRepoRefsInput>;

export const FuzForgeRepoRefsOutput = object({
	refs: array(FuzForgeRepoRefEntry),
	default_branch: string
});
export type FuzForgeRepoRefsOutput = Infer<typeof FuzForgeRepoRefsOutput>;

export const fuz_forge_repo_refs_action_spec = {
	method: 'fuz_forge_repo_refs',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: ['admin'] },
	side_effects: false,
	async: true,
	input: FuzForgeRepoRefsInput,
	output: FuzForgeRepoRefsOutput,
	description: 'List branches and tags on a forge-hosted repo'
} satisfies RequestResponseActionSpec;

/**
 * One entry in a `git ls-tree -l` listing. `size` is the file's byte
 * count for blobs, `'-'` for trees and submodules per ls-tree
 * semantics — kept as a string so the wire shape mirrors git's output
 * exactly.
 */
export const FuzForgeRepoTreeEntry = object({
	mode: string,
	type: string,
	sha: string,
	size: string,
	name: string
});
export type FuzForgeRepoTreeEntry = Infer<typeof FuzForgeRepoTreeEntry>;

/**
 * Input for `fuz_forge_repo_tree`. `path` is the directory within the tree
 * to list — empty string means the root. The server validates the
 * path with `is_safe_path` (no `..`, no leading `-`, no absolute
 * paths) before spawning git.
 */
export const FuzForgeRepoTreeInput = object({
	id: RepoId,
	ref: pipe(string, max_length(255)),
	path: with_default(pipe(string, max_length(4096)), ''),
	acting: ActingActor
});
export type FuzForgeRepoTreeInput = Infer<typeof FuzForgeRepoTreeInput>;

export const FuzForgeRepoTreeOutput = object({
	entries: array(FuzForgeRepoTreeEntry),
	/** SHA the ref resolved to at fetch time — for stable URLs + breadcrumb anchoring. */
	resolved_sha: string
});
export type FuzForgeRepoTreeOutput = Infer<typeof FuzForgeRepoTreeOutput>;

export const fuz_forge_repo_tree_action_spec = {
	method: 'fuz_forge_repo_tree',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: ['admin'] },
	side_effects: false,
	async: true,
	input: FuzForgeRepoTreeInput,
	output: FuzForgeRepoTreeOutput,
	description: 'List tree entries at a path within a ref of a forge-hosted repo'
} satisfies RequestResponseActionSpec;

/**
 * Body of a blob response. Three shapes:
 * - `text`: UTF-8 decoded content suitable for `<pre>` rendering
 * - `binary`: binary file detected (NUL byte in first 8 KB) — the body
 *   carries no bytes, so the UI shows a notice rather than rendering
 * - `truncated`: file exceeds the server's blob-size cap (5 MB); the UI
 *   shows a notice + the `git show <sha>` fallback hint (the blob's own sha,
 *   which the body omits but the response still carries)
 */
export const FuzForgeRepoBlobBody = variant('kind', [
	object({ kind: literal('text'), text: string }),
	object({ kind: literal('binary') }),
	object({ kind: literal('truncated'), size: number })
]);
export type FuzForgeRepoBlobBody = Infer<typeof FuzForgeRepoBlobBody>;

export const FuzForgeRepoBlobInput = object({
	id: RepoId,
	ref: pipe(string, max_length(255)),
	path: pipe(string, min_length(1), max_length(4096)),
	acting: ActingActor
});
export type FuzForgeRepoBlobInput = Infer<typeof FuzForgeRepoBlobInput>;

export const FuzForgeRepoBlobOutput = object({
	sha: string,
	size: number,
	body: FuzForgeRepoBlobBody
});
export type FuzForgeRepoBlobOutput = Infer<typeof FuzForgeRepoBlobOutput>;

export const fuz_forge_repo_blob_action_spec = {
	method: 'fuz_forge_repo_blob',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: ['admin'] },
	side_effects: false,
	async: true,
	input: FuzForgeRepoBlobInput,
	output: FuzForgeRepoBlobOutput,
	description: 'Fetch a single file blob at a path within a ref'
} satisfies RequestResponseActionSpec;

// -- fuz_forge_token_create_scoped -----------------------------------------------
//
// Mint a per-account API token narrowed by a JSON policy. Issuer must
// hold the global `admin` role (no privilege escalation through a
// scoped token). `credential_types: ['session']` follows fuz_app's stance
// on credential-channel mutations: they take a session, never a bearer, so a
// leaked bearer can't compose this to widen its own surface.
//
// `FuzForgeTokenTemplateInput` is the one template grammar — the wire shape
// and the server helpers' parameter type, so the two can't drift. Each
// variant has the input fields the template builder needs;
// `policy_from_template` is a pure function over this shape and produces a
// `FuzForgeTokenPolicy` (or `null` for the `admin` template).

/**
 * The repo ids a `forge_push` / `forge_pull` template names.
 *
 * **UUIDs, not slugs**, and validated rather than merely documented: the git
 * gate checks `forge.push:<repo cell id>`, so a slug here produces a policy that
 * can never match. That failure is invisible by construction — git smart-HTTP
 * answers every refusal with one generic 401 — so the token would look minted
 * and simply never authorize anything, with no way for the operator to tell why.
 * Rejecting it at mint is the only point where the mistake can still be
 * reported. Twin: the Rust `TokenTemplateInput::into_template`.
 *
 * Reuses `RepoId` — the fuz_schema twin of the schema every repo RPC takes an
 * `id` as, with its grammar — rather than an inline `uuid`, so the forge has one
 * repo-id grammar on this side.
 */
const FuzForgeTokenTemplateRepoIds = pipe(array(RepoId), min_length(1), max_length(64));

/** The `filenames` a `files_*` template names: `'*'` for every file, or a list. */
const FuzForgeTokenTemplateFilenames = union([
	literal('*'),
	pipe(array(pipe(string, min_length(1))), min_length(1), max_length(256))
]);

/**
 * Discriminated union of the scoped-token templates the operator picks from at
 * create time, a `@fuzdev/fuz_schema` schema. `admin` is the unscoped template —
 * it produces no policy row, so the token carries its account's full authority;
 * every other variant produces the minimal policy document its name describes.
 */
export const FuzForgeTokenTemplateInput = variant('kind', [
	object({ kind: literal('admin') }),
	object({ kind: literal('forge_push'), repo_ids: FuzForgeTokenTemplateRepoIds }),
	object({ kind: literal('forge_pull'), repo_ids: FuzForgeTokenTemplateRepoIds }),
	object({ kind: literal('files_read'), filenames: FuzForgeTokenTemplateFilenames }),
	object({ kind: literal('files_write'), filenames: FuzForgeTokenTemplateFilenames }),
	object({ kind: literal('files_read_write'), filenames: FuzForgeTokenTemplateFilenames }),
	object({
		kind: literal('rpc_subset'),
		methods: pipe(array(pipe(string, min_length(1))), min_length(1), max_length(64))
	})
]);
export type FuzForgeTokenTemplateInput = Infer<typeof FuzForgeTokenTemplateInput>;

/** Input for `fuz_forge_token_create_scoped`, a `@fuzdev/fuz_schema` schema. */
export const FuzForgeTokenCreateScopedInput = object({
	name: meta(pipe(string, min_length(1), max_length(80)), {
		description: 'Human-friendly label; shown in the token list.'
	}),
	template: FuzForgeTokenTemplateInput,
	lifetime: meta(TokenLifetimeInput, {
		description:
			"How long the token lives — required, mirroring the spine's `account_token_create`: " +
			"`{kind:'eternal'}` never expires, `{kind:'ttl',days:N}` expires N days from mint.",
		invalid_reason: ERROR_TOKEN_LIFETIME_INVALID
	}),
	acting: ActingActor
});
export type FuzForgeTokenCreateScopedInput = Infer<typeof FuzForgeTokenCreateScopedInput>;

/**
 * Output for `fuz_forge_token_create_scoped`, a `@fuzdev/fuz_schema` schema.
 * `token` is the raw secret — returned exactly once. `template` echoes which
 * template minted the token so the UI can render the same summary it'll show
 * on the list view (`admin` for unscoped, the named template otherwise).
 */
export const FuzForgeTokenCreateScopedOutput = object({
	ok: literal(true),
	token: string,
	id: string,
	name: string,
	template: string
});
export type FuzForgeTokenCreateScopedOutput = Infer<typeof FuzForgeTokenCreateScopedOutput>;

export const fuz_forge_token_create_scoped_action_spec = {
	method: 'fuz_forge_token_create_scoped',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {
		account: 'required',
		actor: 'required',
		credential_types: ['session'],
		roles: ['admin']
	},
	side_effects: true,
	async: true,
	input: FuzForgeTokenCreateScopedInput,
	output: FuzForgeTokenCreateScopedOutput,
	description:
		'Mint a scoped API token narrowed by a template-derived policy. Issuer must hold global admin.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

/**
 * Output for `fuz_forge_token_policy_list`. Each entry maps an `api_token`
 * row's id to the template name that minted its policy. Unscoped tokens
 * (no `fuz_forge_api_token_policy` row) are absent from the list — the UI
 * treats absence as "admin (unscoped)".
 */
export const FuzForgeTokenPolicyListOutput = object({
	policies: array(
		object({
			api_token_id: string,
			template: string
		})
	)
});
export type FuzForgeTokenPolicyListOutput = Infer<typeof FuzForgeTokenPolicyListOutput>;

export const fuz_forge_token_policy_list_action_spec = {
	method: 'fuz_forge_token_policy_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {
		account: 'required',
		actor: 'required',
		credential_types: ['session'],
		roles: ['admin']
	},
	side_effects: false,
	async: true,
	input: with_default_fn(object({ acting: ActingActor }), () => ({})),
	output: FuzForgeTokenPolicyListOutput,
	description:
		'List per-token policy template names for the calling account. Absent tokens are unscoped.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

/**
 * All action specs — includes the protocol actions (`heartbeat`, `cancel`)
 * up front so the frontend Proxy client types `app.api.heartbeat()` against
 * the shared fuz_app spec. Protocol actions are dispatcher-owned at runtime
 * (via `protocol_actions` on the WS server, `FrontendWebsocketClient`'s
 * activity-aware timer on the client) but live in the registry so the typed
 * surface stays honest.
 */
export const all_fuz_forge_action_specs: Array<ActionSpecUnion> = [
	...protocol_action_specs,
	fuz_forge_repo_updated_action_spec,
	fuz_forge_repo_list_action_spec,
	fuz_forge_repo_get_action_spec,
	fuz_forge_repo_log_action_spec,
	fuz_forge_repo_commit_action_spec,
	fuz_forge_repo_refs_action_spec,
	fuz_forge_repo_tree_action_spec,
	fuz_forge_repo_blob_action_spec,
	fuz_forge_repo_create_action_spec,
	fuz_forge_repo_resync_action_spec,
	fuz_forge_repo_rotate_secret_action_spec,
	fuz_forge_token_create_scoped_action_spec,
	fuz_forge_token_policy_list_action_spec
];

/**
 * RPC-only action specs (mounted on the single JSON-RPC endpoint), derived
 * from `all_fuz_forge_action_specs` so the subset cannot drift from the
 * superset. It is every `request_response` spec except the protocol actions
 * (`heartbeat` is `request_response` but mounts via `protocol_action_specs`,
 * so the `!protocol_action_specs.includes` clause is load-bearing).
 */
export const fuz_forge_rpc_action_specs: Array<RequestResponseActionSpec> =
	all_fuz_forge_action_specs.filter(
		(s): s is RequestResponseActionSpec =>
			s.kind === 'request_response' && !protocol_action_specs.includes(s)
	);
