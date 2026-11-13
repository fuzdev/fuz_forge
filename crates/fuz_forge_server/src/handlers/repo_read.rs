//! Read-side RPC handlers for forge repos.
//!
//! Port of `src/lib/server/routes/fuz_forge_repo_read.ts`:
//! `fuz_forge_repo_list` / `get` / `log` / `commit` / `refs` / `tree` / `blob`.
//! The repo-cell shape, its lookups and the on-disk path resolver live in
//! [`super::repo_cell`]; the git subprocess + parse work is delegated to
//! [`crate::forge_git`].

use std::fmt::Write as _;
use std::sync::Arc;

use futures::future::BoxFuture;
use fuz_actions::ActionContext;
use fuz_forge_wire::output::{
    RepoCommitOutput, RepoEnvelope, RepoListOutput, RepoLogOutput, RepoOutput, RepoRefsOutput,
    RepoTreeOutput,
};
use fuz_http::{JsonrpcError, internal_error_with_source, not_found, parse_strict_params};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use super::input_bounds::{
    RepoSelector, require_int_range, require_len, require_opt_len, require_repo_selector,
};
use super::repo_cell::{
    REPO_CELL_MALFORMED_MESSAGE, REPO_CELL_SKIPPED_MESSAGE, query_repo_cell,
    query_repo_cell_by_slug, repo_cell_select, repo_row_to_output, resolve_repo_path,
};
use super::repo_list_since::{SINCE_MAX_LENGTH, require_iso8601_datetime};
use super::to_value_out;
use crate::app::FuzForgeApp;
use crate::forge_git::parse::is_full_sha;
use crate::forge_git::read::{LogFilters, read_blob, read_commit, read_log, read_refs, read_tree};

/// Default page size for git log.
const DEFAULT_LOG_LIMIT: usize = 50;

/// Length cap on `fuz_forge_repo_log.since`. The value is a git approxidate
/// handed to `git log --since` on both backends (deliberately NOT the ISO
/// grammar `fuz_forge_repo_list.since` takes — `SINCE_MAX_LENGTH` is that
/// field's cap), so this is a plain byte bound. Twin of the TS
/// `LOG_SINCE_MAX_LENGTH` in `action_specs.ts`.
const LOG_SINCE_MAX_LENGTH: usize = 64;
/// Max page size accepted by `fuz_forge_repo_log`.
const MAX_LOG_LIMIT: usize = 200;

/// The context [`to_value_out`] names on a failed serialize.
const SERIALIZE_CONTEXT: &str = "fuz_forge_repo: serialize output";

// =============================================================================
//  fuz_forge_repo_list / fuz_forge_repo_get
// =============================================================================

/// Filter inputs for `fuz_forge_repo_list`. Both optional, mirroring
/// `FuzForgeRepoListInput` in `action_specs.ts`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoListInput {
    /// Prefix match on `data.slug`, applied **case-sensitively** — the twin
    /// of the TS contract (see `FuzForgeRepoListInput`). Slugs are stored
    /// lowercase-canonical, so a caller passes a lowercase prefix; `MyOrg/`
    /// matches nothing rather than being folded.
    #[serde(default)]
    slug_prefix: Option<String>,
    /// Keep repos with `last_pushed_at >= since`; repos that have never
    /// been pushed (`last_pushed_at IS NULL`) are excluded when set.
    #[serde(default)]
    since: Option<String>,
    /// Dispatcher-owned actor selector, read off the raw params before the
    /// handler runs ([`fuz_actions`]). Declared so `deny_unknown_fields`
    /// admits it; never read here.
    #[serde(default, deserialize_with = "fuz_http::deserialize_optional_wire_uuid")]
    #[expect(dead_code, reason = "resolved by the dispatcher, not the handler")]
    acting: Option<Uuid>,
}

pub fn fuz_forge_repo_list(
    app: Arc<FuzForgeApp>,
    params: Value,
    _ctx: ActionContext<'_>,
) -> BoxFuture<'_, Result<Value, JsonrpcError>> {
    Box::pin(async move {
        // Absent params reach here as `Value::Null`, which `parse_strict_params`
        // maps to `{}` — the twin of the TS dispatcher's `raw_params ?? {}`
        // against the spec's `with_default_fn`. Its `null` walk is a no-op on a
        // non-object, so a no-arg call needs no branch of its own.
        let input: RepoListInput = parse_strict_params(params)?;
        require_opt_len("slug_prefix", input.slug_prefix.as_deref(), 0, 255)?;
        // Length first, then the grammar — the same order the TS twin's
        // `RepoListSince` applies its `.max()` and its regex. The cap is not
        // redundant with the grammar: the fractional part is `\.\d+`, so
        // without it a 150-digit fraction passes the shape on both backends and
        // then fails Postgres's bound-param parse here (`invalid input syntax`
        // at 129 digits) — a `-32603` against a `200` on TS.
        require_opt_len("since", input.since.as_deref(), 0, SINCE_MAX_LENGTH)?;
        let since = require_iso8601_datetime(input.since.as_deref())?;
        let client =
            app.backend.pool.get().await.map_err(|e| {
                fuz_http::db_unavailable_with_source("fuz_forge_repo_list: pool", &e)
            })?;

        // Both filters apply in SQL with the exact TS semantics:
        //   - `slug_prefix`: exact CASE-SENSITIVE prefix on `data.slug`
        //     (`starts_with`, no LIKE-wildcard escaping needed). Slugs are
        //     lowercase-canonical, so callers use lowercase prefixes; an
        //     uppercase prefix matches nothing (matches the TS contract).
        //   - `since`: `last_pushed_at >= since`, excluding NULL
        //     `last_pushed_at` (a never-pushed repo has no recent activity).
        //
        // The two `since` fields carry **different grammars on purpose**, and
        // each is identical across the backends.
        //
        // `fuz_forge_repo_list`'s is the shared UTC ISO 8601 datetime —
        // `require_iso8601_datetime` above, `RepoListSince` on the TS input
        // schema — so an off-grammar value is `-32602` on both before any store
        // sees it. It has to be: the filter is then resolved by each backend's
        // own parser (the `timestamptz` cast below, `Date.parse` there), and
        // those disagree in *both* directions. Postgres's special words
        // (`yesterday` / `today` / `now` / `epoch` / `infinity`) parse here and
        // are `NaN` there; year `0000` and a 150-digit fraction pass
        // the TS datetime regex and are refused by the cast here. The grammar plus
        // its two bounds (`MIN_ISO8601_YEAR`, `SINCE_MAX_LENGTH`) make both
        // directions unreachable, so the cast below cannot fail and there is no
        // probe-and-degrade step left.
        //
        // `fuz_forge_repo_log`'s is git's **approxidate**: the raw string goes
        // to `git log --since=` on both backends, which is identical by
        // construction and much wider (`2 weeks ago`). Wider, not laxer — git
        // never *fails* on a spelling it doesn't recognize, but it does not
        // ignore it either: `git rev-parse --since=garbage` resolves to
        // `--max-age=<now>`, so a garbage window silently drops every past
        // commit. That is the trade `fuz_forge_repo_list` refuses to make,
        // which is why its own `since` is the strict grammar above. Twin:
        // `src/lib/server/routes/fuz_forge_repo_read.ts`.
        let slug_prefix = input.slug_prefix.filter(|p| !p.is_empty());

        // `path IS NOT NULL` in the SQL, not only in `repo_cell_to_output`: a
        // pathless repo cell is skipped either way, and this way the scan never
        // loads one. Twin: `query_addressed_cells_by_kind`
        // (`src/lib/server/db/fuz_forge_cell_queries.ts`).
        let mut sql = format!(
            "{} WHERE c.kind = 'repo' AND c.path IS NOT NULL AND c.deleted_at IS NULL",
            repo_cell_select()
        );
        let mut bind: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = Vec::new();
        if let Some(ref prefix) = slug_prefix {
            bind.push(prefix);
            // `write!` to a `String` is infallible; the trait import keeps the
            // bind index inline without an intermediate allocation.
            let _ = write!(sql, " AND starts_with(c.data->>'slug', ${})", bind.len());
        }
        if let Some(ref since) = since {
            bind.push(since);
            // `${}::text::timestamptz` (not a bare `::timestamptz`) keeps the
            // bound param `text` so tokio-postgres can serialize the `String`;
            // the left side is a JSONB-extracted text already.
            let _ = write!(
                sql,
                " AND c.data->>'last_pushed_at' IS NOT NULL \
                  AND (c.data->>'last_pushed_at')::timestamptz >= ${}::text::timestamptz",
                bind.len()
            );
        }
        sql.push_str(" ORDER BY c.created_at DESC");

        let rows = client
            .query(&sql, &bind)
            .await
            .map_err(|e| internal_error_with_source("fuz_forge_repo_list: query", &e))?;
        let repos: Vec<RepoOutput> = rows
            .into_iter()
            .filter_map(|row| {
                repo_row_to_output("fuz_forge_repo_list", REPO_CELL_SKIPPED_MESSAGE, &row)
            })
            .collect();
        to_value_out(&RepoListOutput { repos }, SERIALIZE_CONTEXT)
    })
}

/// `id` xor `slug` lookup for `fuz_forge_repo_get`. `id` is the cell-id
/// UUID (PK lookup); `slug` (the `org/repo` clone handle) resolves on the
/// `repos/<slug>` cell path. Mirrors `FuzForgeRepoGetInput` in
/// `action_specs.ts`, whose piped `check` makes the xor a schema failure —
/// [`require_repo_selector`] is the twin.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoGetInput {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    slug: Option<String>,
    /// Dispatcher-owned actor selector; declared so `deny_unknown_fields`
    /// admits it, never read here.
    #[serde(default, deserialize_with = "fuz_http::deserialize_optional_wire_uuid")]
    #[expect(dead_code, reason = "resolved by the dispatcher, not the handler")]
    acting: Option<Uuid>,
}

pub fn fuz_forge_repo_get(
    app: Arc<FuzForgeApp>,
    params: Value,
    _ctx: ActionContext<'_>,
) -> BoxFuture<'_, Result<Value, JsonrpcError>> {
    Box::pin(async move {
        let input: RepoGetInput = parse_strict_params(params)?;
        let row = match require_repo_selector(input.id.as_deref(), input.slug.as_deref())? {
            RepoSelector::Id(id) => query_repo_cell(&app, id).await?,
            RepoSelector::Slug(slug) => query_repo_cell_by_slug(&app, slug).await?,
        };
        let Some(row) = row else {
            return Err(not_found("repo", None));
        };
        let Some(repo) =
            repo_row_to_output("fuz_forge_repo_get", REPO_CELL_MALFORMED_MESSAGE, &row)
        else {
            return Err(not_found("repo", None));
        };
        to_value_out(&RepoEnvelope { repo }, SERIALIZE_CONTEXT)
    })
}

// =============================================================================
//  fuz_forge_repo_log / fuz_forge_repo_commit
// =============================================================================

/// Mirrors `FuzForgeRepoLogInput` in `action_specs.ts`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoLogInput {
    id: String,
    /// The branch/tag to read. `ref` is a Rust keyword, so the field is
    /// `ref_` with the wire name restored by `rename` — without it the
    /// caller's `ref` would be silently dropped and the log read from the
    /// default branch instead.
    #[serde(default, rename = "ref")]
    ref_: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    /// `pipe(number, integer, min_value(1), max_value(200))` on the TS side. Kept as the raw
    /// JSON value so [`require_int_range`] can accept the integral floats the TS
    /// schema accepts — `Option<usize>` would refuse `50.0`, which the twin admits.
    #[serde(default)]
    limit: Option<Value>,
    /// `--author=<pattern>` regex, passed through unmodified.
    #[serde(default)]
    author: Option<String>,
    /// `--since=<approxidate>` (e.g. "2 weeks ago", ISO date).
    #[serde(default)]
    since: Option<String>,
    /// Path filter applied after the `--` separator.
    #[serde(default)]
    path: Option<String>,
    /// Dispatcher-owned actor selector; declared so `deny_unknown_fields`
    /// admits it, never read here.
    #[serde(default, deserialize_with = "fuz_http::deserialize_optional_wire_uuid")]
    #[expect(dead_code, reason = "resolved by the dispatcher, not the handler")]
    acting: Option<Uuid>,
}

/// Mirrors `FuzForgeRepoCommitInput` in `action_specs.ts`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoCommitInput {
    id: String,
    sha: String,
    /// Dispatcher-owned actor selector; declared so `deny_unknown_fields`
    /// admits it, never read here.
    #[serde(default, deserialize_with = "fuz_http::deserialize_optional_wire_uuid")]
    #[expect(dead_code, reason = "resolved by the dispatcher, not the handler")]
    acting: Option<Uuid>,
}

pub fn fuz_forge_repo_log(
    app: Arc<FuzForgeApp>,
    params: Value,
    _ctx: ActionContext<'_>,
) -> BoxFuture<'_, Result<Value, JsonrpcError>> {
    Box::pin(async move {
        let input: RepoLogInput = parse_strict_params(params)?;
        require_opt_len("ref", input.ref_.as_deref(), 0, 255)?;
        require_opt_len("cursor", input.cursor.as_deref(), 0, 64)?;
        require_opt_len("author", input.author.as_deref(), 0, 200)?;
        require_opt_len("since", input.since.as_deref(), 0, LOG_SINCE_MAX_LENGTH)?;
        require_opt_len("path", input.path.as_deref(), 0, 1024)?;
        // the TS `limit` schema (`1..=200`) rejects 0 and 201 outright;
        // clamping here would accept a request the TS twin refuses.
        let limit = match input.limit {
            Some(ref value) => require_int_range("limit", value, 1, MAX_LOG_LIMIT)?,
            None => DEFAULT_LOG_LIMIT,
        };
        let (repo_path, data) = resolve_repo_path(&app, &input.id).await?;
        // `default_branch` is a required cell field (see `RepoCellData`), so
        // it's the fallback when no explicit ref is requested.
        let ref_ = input
            .ref_
            .as_deref()
            .unwrap_or(data.default_branch.as_str());
        if data.push.head_sha.is_none() && input.cursor.is_none() {
            return to_value_out(
                &RepoLogOutput {
                    commits: Vec::new(),
                    next_cursor: None,
                    ref_name: ref_.to_owned(),
                },
                SERIALIZE_CONTEXT,
            );
        }
        let request = limit + 1; // +1 to detect more-pages
        let commits = read_log(
            &app.git_path,
            &repo_path,
            ref_,
            input.cursor.as_deref(),
            request,
            &LogFilters {
                author: input.author.as_deref(),
                // `since` is git's approxidate here, not the date parser
                // `fuz_forge_repo_list` uses — see the note there. Same on both
                // backends: the string reaches `git log --since=` verbatim.
                since: input.since.as_deref(),
                path: input.path.as_deref(),
            },
        )
        .await?;
        let has_more = commits.len() > limit;
        let page: Vec<_> = commits.into_iter().take(limit).collect();
        let next_cursor = if has_more {
            page.last().map(|c| c.sha.clone())
        } else {
            None
        };
        to_value_out(
            &RepoLogOutput {
                commits: page,
                next_cursor,
                ref_name: ref_.to_owned(),
            },
            SERIALIZE_CONTEXT,
        )
    })
}

pub fn fuz_forge_repo_commit(
    app: Arc<FuzForgeApp>,
    params: Value,
    _ctx: ActionContext<'_>,
) -> BoxFuture<'_, Result<Value, JsonrpcError>> {
    Box::pin(async move {
        let input: RepoCommitInput = parse_strict_params(params)?;
        require_len("sha", &input.sha, 0, 64)?;
        // Order is the contract, not an implementation detail: input bounds
        // first, then the repo (id grammar → -32602, absent repo →
        // `not_found("repo")`), then the sha. The TS twin gets this ordering
        // structurally — the dispatcher validates the whole input, then
        // `resolve_repo_cell` runs, and only `read_commit` maps the sha — so
        // guarding the sha ahead of the lookup here would answer
        // `commit not found` for a repo that does not exist.
        let (repo_path, _data) = resolve_repo_path(&app, &input.id).await?;
        if !is_full_sha(&input.sha) {
            // Bare `not_found('commit')` with `data: undefined` — matches the
            // TS handler's data-leak-minimal shape (`read.ts` maps an invalid
            // sha to `no_such_ref`, which `fuz_forge_repo_read.ts` surfaces as
            // a bare `not_found('commit')`).
            return Err(not_found("commit", None));
        }
        let (commit, diff) = read_commit(&app.git_path, &repo_path, &input.sha).await?;
        to_value_out(&RepoCommitOutput { commit, diff }, SERIALIZE_CONTEXT)
    })
}

// =============================================================================
//  fuz_forge_repo_refs / fuz_forge_repo_tree / fuz_forge_repo_blob
// =============================================================================

/// Mirrors `FuzForgeRepoRefsInput` in `action_specs.ts`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoRefsInput {
    id: String,
    /// Dispatcher-owned actor selector; declared so `deny_unknown_fields`
    /// admits it, never read here.
    #[serde(default, deserialize_with = "fuz_http::deserialize_optional_wire_uuid")]
    #[expect(dead_code, reason = "resolved by the dispatcher, not the handler")]
    acting: Option<Uuid>,
}

/// Mirrors `FuzForgeRepoTreeInput` in `action_specs.ts`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoTreeInput {
    id: String,
    #[serde(rename = "ref")]
    ref_: String,
    #[serde(default)]
    path: String,
    /// Dispatcher-owned actor selector; declared so `deny_unknown_fields`
    /// admits it, never read here.
    #[serde(default, deserialize_with = "fuz_http::deserialize_optional_wire_uuid")]
    #[expect(dead_code, reason = "resolved by the dispatcher, not the handler")]
    acting: Option<Uuid>,
}

/// Mirrors `FuzForgeRepoBlobInput` in `action_specs.ts`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoBlobInput {
    id: String,
    #[serde(rename = "ref")]
    ref_: String,
    path: String,
    /// Dispatcher-owned actor selector; declared so `deny_unknown_fields`
    /// admits it, never read here.
    #[serde(default, deserialize_with = "fuz_http::deserialize_optional_wire_uuid")]
    #[expect(dead_code, reason = "resolved by the dispatcher, not the handler")]
    acting: Option<Uuid>,
}

pub fn fuz_forge_repo_refs(
    app: Arc<FuzForgeApp>,
    params: Value,
    _ctx: ActionContext<'_>,
) -> BoxFuture<'_, Result<Value, JsonrpcError>> {
    Box::pin(async move {
        let input: RepoRefsInput = parse_strict_params(params)?;
        let (repo_path, data) = resolve_repo_path(&app, &input.id).await?;
        let refs = read_refs(&app.git_path, &repo_path).await?;
        // `default_branch` is a required cell field (see `RepoCellData`).
        to_value_out(
            &RepoRefsOutput {
                refs,
                default_branch: data.default_branch,
            },
            SERIALIZE_CONTEXT,
        )
    })
}

pub fn fuz_forge_repo_tree(
    app: Arc<FuzForgeApp>,
    params: Value,
    _ctx: ActionContext<'_>,
) -> BoxFuture<'_, Result<Value, JsonrpcError>> {
    Box::pin(async move {
        let input: RepoTreeInput = parse_strict_params(params)?;
        require_len("ref", &input.ref_, 0, 255)?;
        require_len("path", &input.path, 0, 4096)?;
        let (repo_path, _data) = resolve_repo_path(&app, &input.id).await?;
        // Argv-shape validation lives in `read_tree` (as in the TS twin's
        // `read_tree`) — an unsafe ref/path is the same `not_found` there.
        let (entries, resolved_sha) =
            read_tree(&app.git_path, &repo_path, &input.ref_, &input.path).await?;
        to_value_out(
            &RepoTreeOutput {
                entries,
                resolved_sha,
            },
            SERIALIZE_CONTEXT,
        )
    })
}

pub fn fuz_forge_repo_blob(
    app: Arc<FuzForgeApp>,
    params: Value,
    _ctx: ActionContext<'_>,
) -> BoxFuture<'_, Result<Value, JsonrpcError>> {
    Box::pin(async move {
        let input: RepoBlobInput = parse_strict_params(params)?;
        require_len("ref", &input.ref_, 0, 255)?;
        require_len("path", &input.path, 1, 4096)?;
        let (repo_path, _data) = resolve_repo_path(&app, &input.id).await?;
        // Argv-shape validation lives in `read_blob` (as in the TS twin's
        // `read_blob`) — an unsafe ref/path is the same `not_found` there.
        let blob = read_blob(&app.git_path, &repo_path, &input.ref_, &input.path).await?;
        to_value_out(&blob, SERIALIZE_CONTEXT)
    })
}

#[cfg(test)]
mod tests;
