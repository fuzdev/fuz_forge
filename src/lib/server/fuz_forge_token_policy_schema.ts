/**
 * Schema for the scoped-token policy document.
 *
 * A policy is a strict allow-only JSON document. Tokens with
 * `policy = null` (no row in `fuz_forge_api_token_policy`) are unscoped —
 * they pass every `policy_check` unchanged. Tokens with a
 * policy are denied any capability not explicitly allowed.
 *
 * **Grammar (v1):**
 *
 * - `version: 1` — schema version literal; future grammar changes
 *   bump this and a migration runs.
 * - `forge.push` / `forge.pull` — per-repo push/pull allowlist.
 *   Values: `'*'` (any repo) or `{<repo_id>: true | {}}` (explicit
 *   allowlist; the per-key object reserves space for v2 qualifiers
 *   like `{branches: ['main']}` without a schema break).
 * - `files.read` / `files.write` / `files.delete` — per-filename
 *   file store allowlist. Same shape as forge.
 * - `rpc` — the methods the `rpc_subset` template named. `'*'` (any method) or
 *   `{<method_name>: true | {}}`. **A record, not a grant** — unlike the two
 *   above, nothing checks it: the spine's `api_token.scope`, derived from the
 *   same template at mint, is what gates RPC. It is stored so the row says what
 *   the token was minted for. `FuzForgeCapability` has no `rpc` variant, and
 *   adding one would put a second gate in front of a decision this layer does
 *   not make.
 *
 * **Semantics:**
 *
 * - Allow-only. Anything not explicitly listed is denied (the checked grants —
 *   `forge` and `files`).
 * - Wildcards via literal `'*'`. No glob patterns.
 * - Per-key payload is the object value — `true` is shorthand for
 *   "no qualifiers"; `{}` is the canonical empty-qualifier form
 *   (semantically identical to `true` in v1).
 * - Per-token expiry only — there is no per-capability expiry.
 *   The whole token (and its policy) expires via the existing
 *   `api_token.expires_at` column.
 *
 * Cap serialized policy at 4 KB on write to keep jsonb queries
 * cheap. Enforce in the create-token handler, not here — keeping
 * the schema pure.
 *
 * @module
 */

import {
	literal,
	object,
	optional,
	record,
	union,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

/**
 * Per-resource allowlist: either `'*'` (any) or a record from
 * resource id (repo id, filename, RPC method) to either `true` or an
 * empty qualifier object.
 *
 * The per-key object is intentionally empty in v1; the shape exists
 * so v2 can add qualifiers (e.g. `branches: ['main']`) without
 * breaking the schema.
 */
export const FuzForgeTokenPolicyResourceMap = union([
	literal('*'),
	record(union([literal(true), object({})]))
]);
export type FuzForgeTokenPolicyResourceMap = Infer<typeof FuzForgeTokenPolicyResourceMap>;

/**
 * Forge-section grammar: per-operation per-repo allowlist.
 */
export const FuzForgeTokenPolicyForge = object({
	push: optional(FuzForgeTokenPolicyResourceMap),
	pull: optional(FuzForgeTokenPolicyResourceMap)
});
export type FuzForgeTokenPolicyForge = Infer<typeof FuzForgeTokenPolicyForge>;

/**
 * File-store-section grammar: per-operation per-filename allowlist.
 */
export const FuzForgeTokenPolicyFiles = object({
	read: optional(FuzForgeTokenPolicyResourceMap),
	write: optional(FuzForgeTokenPolicyResourceMap),
	delete: optional(FuzForgeTokenPolicyResourceMap)
});
export type FuzForgeTokenPolicyFiles = Infer<typeof FuzForgeTokenPolicyFiles>;

/**
 * The full policy document. Stored as `policy` in
 * `fuz_forge_api_token_policy`. Validated on write by the create-scoped-
 * token handler and again on read by `policy_from_stored`, which resolves a
 * document that fails this schema to `DENY_ALL_POLICY` rather than
 * trusting the stored shape — the column is otherwise readonly to consumers,
 * so the read-side check is defense-in-depth against a hand-edited row or a
 * grammar bump.
 *
 * The `rpc` field reuses `FuzForgeTokenPolicyResourceMap` directly —
 * RPC method allowlists share the exact same shape as forge / files
 * (a `'*'` literal or a record keyed by resource id with `true` /
 * empty-qualifier values) — though only forge / files are ever checked
 * against it; see the `rpc` note above.
 */
export const FuzForgeTokenPolicy = object({
	version: literal(1),
	forge: optional(FuzForgeTokenPolicyForge),
	files: optional(FuzForgeTokenPolicyFiles),
	rpc: optional(FuzForgeTokenPolicyResourceMap)
});
export type FuzForgeTokenPolicy = Infer<typeof FuzForgeTokenPolicy>;

/**
 * The policy a stored document that cannot be read resolves to: a bare
 * `{version: 1}`, which grants nothing.
 *
 * A row in `fuz_forge_api_token_policy` says its token is *scoped*, so a
 * document that fails `FuzForgeTokenPolicy` must not be treated as an
 * absent row — that is the one outcome that would widen the token, since
 * `policy_check(null, …)` abstains. Both backends substitute this instead, so
 * an unreadable policy denies every resource-bound capability and lists
 * nothing. Twin of the Rust `DENY_ALL_POLICY` (`token_policy/types.rs`), which is a
 * `const` there; frozen here so a caller handed the fallback can't widen it
 * for every later caller by writing a grant onto the shared object.
 */
export const DENY_ALL_POLICY: FuzForgeTokenPolicy = Object.freeze({ version: 1 });

/**
 * Maximum serialized policy size, in bytes.
 *
 * Enforced at write time in the create-scoped-token handler — past
 * 4 KB, jsonb queries get progressively more expensive and the UX
 * for a single-operator forge has no honest need for larger
 * policies (the templates produce documents in the hundreds of
 * bytes range at most).
 */
export const MAX_POLICY_BYTES = 4 * 1024;
