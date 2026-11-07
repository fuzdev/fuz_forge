//! `fuz_forge_token_policy` — scoped API token policy subsystem.
//!
//! Port of the three-file TS subsystem
//! (`fuz_forge_token_policy_schema.ts` + `fuz_forge_token_policy.ts` +
//! `fuz_forge_token_policy_middleware.ts`).
//!
//! ## Grammar
//!
//! Policy doc shape (port of `fuz_forge_token_policy_schema.ts`):
//!
//! ```json
//! {
//!   "version": 1,
//!   "forge": { "push": "*" | {"<repo_id>": true | {}},
//!              "pull": "*" | {"<repo_id>": true | {}} },
//!   "files": { "read":   "*" | {"<filename>": true | {}},
//!              "write":  "*" | {"<filename>": true | {}},
//!              "delete": "*" | {"<filename>": true | {}} },
//!   "rpc": "*" | { "<method>": true | {} }
//! }
//! ```
//!
//! Each grant is a [`ResourceMap`] — the literal `"*"` (any resource id)
//! or a per-id allowlist whose values are `true` or an empty `{}`
//! qualifier object (reserved for v2). Anything not listed is denied;
//! unscoped tokens (no policy row) pass every check. This is the exact
//! wire shape of the TS `FuzForgeTokenPolicy` schema — both backends
//! read the same `fuz_forge_api_token_policy.policy` JSONB.
//!
//! Cap at 4 KiB serialized ([`MAX_POLICY_BYTES`]).
//!
//! ## What this policy still governs
//!
//! Forge's **resource-bound REST surfaces only** — the file store
//! (`files.read:<filename>` …, [`crate::files`]) and git
//! (`forge.push:<repo_id>` …, [`crate::forge_git`]). Both read the policy
//! for an already-resolved auth and check it with [`policy_check`]; neither
//! re-resolves a credential. The file store reads it through
//! [`hydrate_policy`], which hands back a failed pool checkout (the file store
//! answers the spine's 503) and falls through unscoped on any other failed
//! read; git calls
//! [`FuzForgeTokenRouteState::lookup`] directly and answers a failed read with
//! a 500 (503 for a failed checkout), as its TS twin does.
//!
//! It does **not** govern RPC methods or the WS upgrade — the spine's
//! `api_token.scope` does: `fuz_auth::TokenScope` runs the per-method gate
//! inside `perform_action` (credential → scope → role), and rule 3 refuses a
//! narrowed token at the WS upgrade along with every other non-RPC spine surface.
//! [`fuz_forge_token_create_scoped`](crate::handlers::fuz_forge_token_create_scoped)
//! derives that scope from the same template it derives this policy from, so a
//! `rpc_subset` token carries its method set in the column the spine reads.
//!
//! The document's [`rpc`](FuzForgeTokenPolicy::rpc) grant is therefore the
//! mint-time record of what the template granted — the input to that
//! derivation — and not something forge enforces. Nothing reads it back at all:
//! [`FuzForgeCapability`] has no `Rpc` variant, and
//! `fuz_forge_token_policy_list` returns `{api_token_id, template}` rather than
//! the document. It is stored so the row says what the token was minted for.
//!
//! ## Module layout
//!
//! The three modules mirror the TS trio they are twins of, so a change on
//! one side has an obvious home on the other:
//!
//! - [`types`] — the document grammar (`fuz_forge_token_policy_schema.ts`).
//! - [`check`] — enforcement + the template builders (`fuz_forge_token_policy.ts`).
//! - [`hydrate`] — the row read + the table's columns
//!   (`fuz_forge_token_policy_middleware.ts`).
//!
//! Every name stays reachable as `crate::token_policy::<name>`; this module is
//! the only path consumers use.

mod check;
mod hydrate;
mod types;

pub use check::{
    FuzForgeCapability, FuzForgeTokenTemplate, TemplateResources, policy_check, policy_from_stored,
    policy_from_template,
};
pub use hydrate::{FUZ_FORGE_API_TOKEN_POLICY_COLUMNS, FuzForgeTokenRouteState, hydrate_policy};
pub use types::{
    DENY_ALL_POLICY, EmptyQualifiers, FilesGrant, ForgeGrant, FuzForgeTokenPolicy,
    MAX_POLICY_BYTES, PolicyVersion1, ResourceGrant, ResourceMap, TrueLiteral, WildcardLiteral,
};

#[cfg(test)]
mod tests;
