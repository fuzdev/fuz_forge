//! RPC handler bodies for the fuz_forge-specific actions.
//!
//! Port of the TS handler modules `src/lib/server/routes/fuz_forge_repo_read.ts`,
//! `fuz_forge_repo_write.ts` and `fuz_forge_token.ts` over the shared
//! `fuz_forge_repo_cell.ts` cell layer. Each handler takes:
//!
//! - <code>[Arc](std::sync::Arc)<[FuzForgeApp](crate::FuzForgeApp)></code> for
//!   app-level deps (pool, repo path, broadcast).
//! - The validated JSON `params` (typed via per-handler structs).
//! - [`fuz_actions::ActionContext`] for transport-shaped fields (db, auth, notify).
//!
//! Returns either a serialized `Value` (the JSON-RPC `result`) or a
//! [`fuz_http::JsonrpcError`] (the JSON-RPC `error`). The `Value` is always a
//! serialized [`fuz_forge_wire::output`] DTO — the single source of truth for
//! the success-body wire shape, deserialized by the `fuzf` client from the same
//! types.
//!
//! ## Module layout
//!
//! The handlers split by concern (the same seams the TS twin's
//! `routes/fuz_forge_{repo_read,repo_write,token,repo_cell}.ts` +
//! `fuz_forge/repo/` boundaries draw); every handler is re-exported here so
//! `actions.rs` reaches them as `handlers::fuz_forge_*`:
//!
//! - [`repo_read`] — read RPCs (`repo_list`/`get`/`log`/`commit`/`refs`/`tree`/`blob`).
//! - [`repo_cell`] — the crate-wide repo-cell shape ([`RepoCellData`] +
//!   [`PushFacts`]), the cell-select + point-lookup helpers, the cell→output
//!   narrow, and the on-disk path resolver the five subprocess reads go
//!   through (`resync` and `rotate_secret` resolve through
//!   `resolve_repo_mutation` in [`repo_write`]).
//! - [`repo_write`] — mutation RPCs (`repo_create`/`resync`/`rotate_secret`).
//! - [`token`] — scoped-token RPCs (`token_create_scoped`/`token_policy_list`).
//! - [`repo_id`] — the create RPC's slug validator over the `fuz_forge_wire`
//!   grammar (keeping its `validation_error` strings).
//! - [`input_bounds`] — the length/count/selector checks the TS action specs
//!   declare as zod bounds.
//! - [`repo_list_since`] — the `fuz_forge_repo_list` `since` datetime grammar.
//! - [`seed_from`] — the `fuz_forge_repo_create` `seed_from` URL grammar and
//!   host policy.
//!
//! The git subprocess + parse layer lives under [`crate::forge_git`]
//! (`read` + `parse`), mirroring the TS `git/read.ts` + `git/parse.ts`.
//!
//! ## Out of scope
//!
//! Provisioning/deployment is delegated to the standalone `zap` CLI, so
//! the run/host/apply observability handlers are gone. The generic cell
//! surface (cell CRUD + grants + fields + items + audit) lives in the
//! `fuz_cell` spine crate and is mounted directly in [`crate::router`];
//! repos and the file store are reflected as cells.
//!
//! JSON-RPC `params` decoding goes through the spine's
//! `fuz_http::parse_strict_params` — never a local re-declaration — so the
//! `invalid_params` envelope stays single-sourced with the cross-backend
//! parity contract.
//!
//! ## Input strictness
//!
//! Every input struct carries `#[serde(deny_unknown_fields)]`, the twin of the
//! `z.strictObject` each TS action input is built from: an unrecognized key is
//! `invalid_params` (-32602) before the handler body runs, on both backends.
//! That makes the dispatcher-owned `acting` selector and
//! `fuz_forge_token_create_scoped`'s `lifetime` explicit (accepted, then
//! ignored) fields on the structs that declare them — a key the wire carries
//! must be declared somewhere, and silently dropping it is what the strictness
//! is there to prevent. Each `acting` decodes through
//! `fuz_http::deserialize_optional_wire_uuid`, so the UUID grammar its
//! `ActingActor` twin declares gates the field itself, not only the
//! dispatcher's value check. The zod length/count bounds are enforced alongside
//! them via [`input_bounds`].
//!
//! Two things serde does *not* give for free:
//!
//! - A **fieldless** template arm has to be spelled `Admin {}`, not `Admin` —
//!   `deny_unknown_fields` on an internally-tagged enum is applied per-arm, and
//!   a unit variant has no deserializer to apply it with.
//! - A JSON `null` on an optional key deserializes to `None`, where zod's
//!   `.optional()` refuses it. That half is the spine's, not the forge's:
//!   `fuz_http::parse_strict_params` walks the raw `params` for a `null` on
//!   any key before decoding, and every handler decodes through it. No forge
//!   input is `.nullable()`, so the walk is blanket here — an input that ever
//!   gains a nullable field names it through
//!   `fuz_http::parse_strict_params_allowing_null`.

mod input_bounds;
mod repo_cell;
mod repo_id;
mod repo_list_since;
mod repo_read;
mod repo_write;
mod seed_from;
mod token;

pub use repo_read::{
    fuz_forge_repo_blob, fuz_forge_repo_commit, fuz_forge_repo_get, fuz_forge_repo_list,
    fuz_forge_repo_log, fuz_forge_repo_refs, fuz_forge_repo_tree,
};
pub use repo_write::{fuz_forge_repo_create, fuz_forge_repo_resync, fuz_forge_repo_rotate_secret};
pub use token::{fuz_forge_token_create_scoped, fuz_forge_token_policy_list};

pub(crate) use repo_cell::{PushFacts, REPO_PATH_PREFIX, RepoCellData, hash_hook_secret};

/// Serialize a typed output DTO (single-sourced in [`fuz_forge_wire::output`])
/// into the JSON-RPC success `Value`, naming `context` on failure.
/// `serde_json::to_value` is infallible for these plain structs (every field is
/// a `String` / number / `bool` / `Vec` / `Option`), but the error maps to a 500
/// for safety.
fn to_value_out<T: serde::Serialize>(
    out: &T,
    context: &'static str,
) -> Result<serde_json::Value, fuz_http::JsonrpcError> {
    serde_json::to_value(out).map_err(|e| fuz_http::internal_error_with_source(context, &e))
}
