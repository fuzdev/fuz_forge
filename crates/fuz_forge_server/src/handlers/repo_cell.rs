//! The repo **cell** layer: the shape a forge repo takes in the unified cell
//! store, and every read that resolves one.
//!
//! One repo is one `cell` at `repos/<slug>` with `kind = 'repo'`; its `data`
//! is [`RepoCellData`] and its push-derived fields are [`PushFacts`]. The
//! handlers on either side of this module — the read RPCs in
//! [`super::repo_read`], the mutation RPCs in [`super::repo_write`] and the
//! `/internal/*` hook callbacks in [`crate::internal_routes`] — all reach a
//! repo through here, so one module decides what a usable repo cell is, how it
//! is looked up, and how it becomes wire output.
//!
//! Twin of the TS `src/lib/fuz_forge/repo/plan_repo.ts` narrow plus the
//! cell-select helpers in `src/lib/server/routes/fuz_forge_repo_cell.ts`.

use fuz_db::iso8601_timestamp_column;
use fuz_forge_wire::is_valid_repo_id;
use fuz_forge_wire::output::RepoOutput;
use fuz_http::{
    JsonrpcError, internal_error_with_source, invalid_params, not_found, service_unavailable,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::app::FuzForgeApp;

/// The at-rest form of a repo's hook secret: the 64-lowercase-hex BLAKE3 of
/// its UTF-8 bytes, the value the cell stores as `hook_secret_hash`.
///
/// The plaintext lives only in the repo's hook scripts on disk; the cell
/// holds this digest, and the `/internal/*` callbacks compare the digest of
/// the presented secret against it in constant time. Unkeyed is enough: the
/// secret is a random v4 UUID, so the digest admits no offline guess. Bare hex,
/// not a `blake3:` fact address, so the cell layer's ref walk never reads it
/// as a fact. Twin: `hash_hook_secret` in
/// `src/lib/server/routes/fuz_forge_repo_cell.ts`.
pub fn hash_hook_secret(secret: &str) -> String {
    fuz_crypto::ContentHash::blake3(secret.as_bytes()).to_hex()
}

/// Global `cell.path` prefix for forge repo cells (mirrors
/// `REPO_PATH_PREFIX` in `plan_repo.ts`). A repo's cell lives at
/// `repos/<slug>` with the top-level `cell.kind = 'repo'` — no hub. The cell's `id`
/// (a UUID) is the wire/dir handle; the slug is mirrored into the path
/// for an indexed slug lookup + uniqueness.
pub const REPO_PATH_PREFIX: &str = "repos/";

/// The push-derived fields of a repo cell, written and cleared as a unit. A
/// push refreshes the `last_push*` trio and (for a default-branch update)
/// `head_sha`; `head_sha` is `None` on a never-pushed repo or a default-branch
/// delete. Grouping them is the "co-present → struct" rule — the field set
/// lives in one place, so a new push field is added here once and every writer
/// picks it up via [`PushFacts::write_into`].
///
/// `#[serde(flatten)]`-ed into the cell `data`, so the wire shape stays flat
/// (the TS reference backend reads the same top-level keys).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PushFacts {
    #[serde(default)]
    pub head_sha: Option<String>,
    #[serde(default)]
    pub last_pushed_at: Option<String>,
    #[serde(default)]
    pub last_pushed_by: Option<String>,
    #[serde(default)]
    pub last_push_username: Option<String>,
}

impl PushFacts {
    /// Write the four push fields into a cell-`data` object, overwriting any
    /// prior values and leaving every other key intact. Use on JSONB-bound
    /// data (Postgres normalizes key order); for ordered wire output, read the
    /// fields directly. The written set is whatever `PushFacts` serializes.
    pub fn write_into(&self, map: &mut serde_json::Map<String, Value>) {
        if let Ok(Value::Object(fields)) = serde_json::to_value(self) {
            map.extend(fields);
        }
    }
}

/// The crate's single authority on a repo cell's `data` shape — the twin of
/// `narrow_repo_cell_data` in `plan_repo.ts`. Every site that reads a repo
/// cell (the read RPCs, the mutation RPCs, and the `/internal/*` hook
/// callbacks) parses through this struct, so one shape decides everywhere
/// what counts as a usable cell.
///
/// Required fields mirror the TS narrow (`slug` + `name` + `default_branch` +
/// `hook_secret_hash`): a cell missing any of them fails to deserialize and is
/// treated as a missing cell — skipped on list, 404 on view, 401 on the
/// internal callbacks — matching the TS narrow's null-on-missing. The two
/// backends thus give a corrupt/partial cell identical wire behavior.
///
/// The optional fields are `Option<String>` and **reject a wrong-typed value**
/// rather than coercing it: `{"head_sha": 5}` fails to deserialize, so the cell
/// is "missing" on both backends (the TS narrow's `is_optional_str` guard is
/// the twin). An absent key and an explicit `null` are both `None`.
///
/// Unknown keys are accepted (no `deny_unknown_fields`): the TS narrow ignores
/// them too, and a cell is server-owned state rather than caller input. Every
/// mutation writes back over the cell's **raw** `data` object so those keys
/// survive the round-trip.
///
/// The struct carries `hook_secret_hash`, so it must not leave the crate. It
/// can't:
/// `repo_cell` is a private module of `handlers`, so the `pub` here is capped
/// at the crate boundary regardless, and the only crate-level path to the type
/// is the `pub(crate) use` in `handlers/mod.rs`. (Spelling the item itself
/// `pub(crate)` would be the redundancy clippy's `redundant_pub_crate` names.)
/// Its `Debug` redacts the digest, so a logged cell can't carry it either.
#[derive(Deserialize)]
pub struct RepoCellData {
    slug: String,
    /// Repo-name segment of the slug.
    name: String,
    pub default_branch: String,
    /// [`hash_hook_secret`] of the hook scripts' secret, read by the
    /// `/internal/*` callbacks for the constant-time compare; the read DTO never
    /// exposes it. Required so a cell without one (a cell carrying a plaintext
    /// `hook_secret` instead included) narrows to "missing", matching the TS
    /// narrow's `hook_secret_hash` check.
    pub hook_secret_hash: String,
    #[serde(default)]
    seed_from: Option<String>,
    #[serde(default)]
    seed_completed_at: Option<String>,
    #[serde(flatten)]
    pub push: PushFacts,
}

impl std::fmt::Debug for RepoCellData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RepoCellData")
            .field("slug", &self.slug)
            .field("name", &self.name)
            .field("default_branch", &self.default_branch)
            .field("hook_secret_hash", &"<redacted>")
            .field("seed_from", &self.seed_from)
            .field("seed_completed_at", &self.seed_completed_at)
            .field("push", &self.push)
            .finish()
    }
}

/// Shared `SELECT` column list for repo cell reads. `updated_at` coalesces to
/// `created_at` (the unified cell layer leaves `updated_at` NULL until the
/// first edit). Timestamps project through `fuz_db::iso8601_timestamp_column`
/// so the forge emits the spine's canonical second-precision UTC wire shape.
pub(super) fn repo_cell_select() -> String {
    format!(
        "SELECT c.id, c.path, c.data::text, {created}, {updated} FROM cell c ",
        created = iso8601_timestamp_column("c", "created_at"),
        updated = iso8601_timestamp_column("", "COALESCE(c.updated_at, c.created_at)"),
    )
}

/// Shared body for the repo-cell point lookups: acquire the pool, wrap
/// `repo_cell_select()` in the `kind = 'repo' AND not-deleted` envelope under
/// the caller's `where_clause`, and map both failures with the caller's
/// `label`. The SQL envelope lives in one place so the two lookups can't drift.
async fn query_repo_cell_where(
    app: &FuzForgeApp,
    where_clause: &str,
    param: &(dyn tokio_postgres::types::ToSql + Sync),
    label: &str,
) -> Result<Option<tokio_postgres::Row>, JsonrpcError> {
    let client = app
        .backend
        .pool
        .get()
        .await
        .map_err(|e| fuz_http::db_unavailable_with_source(&format!("{label}: pool"), &e))?;
    client
        .query_opt(
            &format!(
                "{} WHERE {where_clause} AND c.kind = 'repo' AND c.deleted_at IS NULL \
                 LIMIT 1",
                repo_cell_select()
            ),
            &[param],
        )
        .await
        .map_err(|e| internal_error_with_source(&format!("{label}: query"), &e))
}

/// Resolve a repo cell by its cell-id UUID (the wire `id`).
///
/// The single ingress for every wire repo `id` on the RPC surface
/// (`repo_get` + `resolve_repo_path` + `resolve_repo_mutation`), so the
/// grammar gate lives here: an `id` failing [`is_valid_repo_id`] returns
/// `invalid_params` (-32602) — the handler-level twin of the TS dispatcher
/// validating `id: RepoId` before the handler runs. A
/// grammar-valid but absent id (including nil/max) resolves to `None`
/// (404). The gate also keeps a Postgres cast error unreachable.
pub(super) async fn query_repo_cell(
    app: &FuzForgeApp,
    id: &str,
) -> Result<Option<tokio_postgres::Row>, JsonrpcError> {
    if !is_valid_repo_id(id) {
        return Err(invalid_params(&format!("invalid repo id: {id:?}"), None));
    }
    let Ok(uuid) = Uuid::parse_str(id) else {
        // Unreachable: every `is_valid_repo_id` string is hyphenated hex,
        // which `parse_str` accepts.
        return Ok(None);
    };
    query_repo_cell_where(app, "c.id = $1", &uuid, "query_repo_cell").await
}

/// Resolve a repo cell by its `org/repo` slug, mirrored into the
/// `repos/<slug>` cell path (indexed, at most one match).
///
/// Repo slugs are case-insensitive (canonical lowercase): cells are stored at
/// the lowercase slug (creation folds via
/// [`fuz_forge_wire::validate_repo_slug`]), so the input
/// slug is lowercased here before the lookup — `MyOrg/MyRepo` resolves the same
/// cell as `myorg/myrepo`. (serde does not fold like the TS `RepoSlug`
/// `to_lower_case`, so this keeps `repo_get`/`_resync`/`_rotate_secret`-by-slug at
/// parity with the TS backend on mixed-case input.)
pub(super) async fn query_repo_cell_by_slug(
    app: &FuzForgeApp,
    slug: &str,
) -> Result<Option<tokio_postgres::Row>, JsonrpcError> {
    let path = format!("{REPO_PATH_PREFIX}{}", slug.to_lowercase());
    query_repo_cell_where(app, "c.path = $1", &path, "query_repo_cell_by_slug").await
}

/// The decoded columns of one [`repo_cell_select`] row. Split out so the
/// narrow below is unit-testable without a live `tokio_postgres::Row`.
#[derive(Debug)]
struct RepoCellRow {
    id: Uuid,
    /// `cell.path` — nullable in the schema, though a repo cell always has one.
    path: Option<String>,
    data_text: String,
    created_at: String,
    updated_at: String,
}

/// The WARN message `fuz_forge_repo_list` logs on a malformed cell — the list
/// keeps making progress over the rest of the page, so the line says the row
/// was skipped. Twin of the TS `[fuz_forge_repo_list] skipping malformed cell
/// …`.
pub(super) const REPO_CELL_SKIPPED_MESSAGE: &str = "skipping malformed repo cell";

/// The WARN message `fuz_forge_repo_get` logs on a malformed cell — it answers
/// `not_found` rather than skipping past anything, so the line doesn't claim a
/// skip. Twin of the TS `[fuz_forge_repo_get] malformed cell …`.
pub(super) const REPO_CELL_MALFORMED_MESSAGE: &str = "malformed repo cell";

pub(super) fn repo_row_to_output(
    method: &str,
    message: &str,
    row: &tokio_postgres::Row,
) -> Option<RepoOutput> {
    repo_cell_to_output(
        method,
        message,
        RepoCellRow {
            id: row.get(0),
            path: row.get(1),
            data_text: row.get(2),
            created_at: row.get(3),
            updated_at: row.get(4),
        },
    )
}

/// Convert a repo `cell` row into the public list/get output, or `None` when
/// its `data` doesn't match [`RepoCellData`] **or** its `cell.path` is `NULL`.
///
/// The path gate is the TS twin's (`!data || cell.path === null`): `path` is
/// what carries the repo's `repos/<slug>` address, and a repo cell without one
/// can't be addressed by slug, cloned, or resynced — so it's as unusable as one
/// whose `data` fails the narrow, and takes the same exit.
///
/// A malformed cell is **skipped with a warning**, never silently dropped:
/// `fuz_forge_repo_list` keeps making progress over the rest of the page and
/// `fuz_forge_repo_get` answers `not_found`, so without the log line the cell
/// is invisible to an operator. Twin of the TS `repo_cell_to_output`
/// (`src/lib/server/routes/fuz_forge_repo_cell.ts`) plus the `log.warn` its two
/// warning callers emit (`fuz_forge_repo_list`'s skip line and
/// `fuz_forge_repo_get`'s malformed line, both in
/// `src/lib/server/routes/fuz_forge_repo_read.ts`), which is why the caller
/// supplies `message` — the two say different things about what
/// happened next ([`REPO_CELL_SKIPPED_MESSAGE`] /
/// [`REPO_CELL_MALFORMED_MESSAGE`]).
/// `method` is the caller's RPC method, carried as a structured tracing field
/// where the TS line inlines it as a `[<method>]` prefix.
///
/// The TS function has a third caller with no counterpart here:
/// `fuz_forge_repo_create` (`src/lib/server/routes/fuz_forge_repo_write.ts`)
/// projects the row it just wrote and throws `internal_error` on a `null`
/// instead of warning, where this backend's create builds its `RepoOutput`
/// inline.
fn repo_cell_to_output(method: &str, message: &str, cell: RepoCellRow) -> Option<RepoOutput> {
    let RepoCellRow {
        id,
        path,
        data_text,
        created_at,
        updated_at,
    } = cell;
    let warn = |path: Option<&str>| {
        tracing::warn!(
            method,
            cell_id = %id,
            path = path.unwrap_or("null"),
            "{message}"
        );
    };
    let Ok(data) = serde_json::from_str::<RepoCellData>(&data_text) else {
        warn(path.as_deref());
        return None;
    };
    if path.is_none() {
        warn(None);
        return None;
    }
    Some(RepoOutput {
        id: id.to_string(),
        slug: data.slug,
        name: data.name,
        default_branch: data.default_branch,
        seed_from: data.seed_from,
        seed_completed_at: data.seed_completed_at,
        head_sha: data.push.head_sha,
        last_pushed_at: data.push.last_pushed_at,
        last_pushed_by: data.push.last_pushed_by,
        last_push_username: data.push.last_push_username,
        created_at,
        updated_at,
    })
}

/// Resolve the on-disk repo path + cell data for a repo `id`.
pub(super) async fn resolve_repo_path(
    app: &FuzForgeApp,
    id: &str,
) -> Result<(std::path::PathBuf, RepoCellData), JsonrpcError> {
    let row = query_repo_cell(app, id).await?;
    let Some(row) = row else {
        return Err(not_found("repo", None));
    };
    let cell_id: Uuid = row.get(0);
    let data_text: String = row.get(2);
    let data: RepoCellData =
        serde_json::from_str(&data_text).map_err(|_| not_found("repo", None))?;
    let Some(repo_root) = app.repo_path.as_ref() else {
        return Err(service_unavailable("repo storage not configured"));
    };
    // On-disk repo dir is keyed on the cell-id UUID, not the
    // `repos/<slug>` cell path.
    let repo_path = crate::repo_storage::repo_dir(repo_root, cell_id);
    Ok((repo_path, data))
}

#[cfg(test)]
mod tests;
