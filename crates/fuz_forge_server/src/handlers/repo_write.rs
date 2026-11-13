//! Write-side RPC handlers for forge repos.
//!
//! Port of `src/lib/server/routes/fuz_forge_repo_write.ts`:
//! `fuz_forge_repo_create` / `resync` / `rotate_secret`. Each runs inside the
//! dispatcher transaction (`ctx.db` is the `Tx`). `create` and `rotate_secret`
//! pair their cell write with explicit on-disk bare-repo / hook-script side
//! effects and unwind disk state by hand when the transactional cell rolls
//! back; `resync` writes no disk state — it reads the on-disk default-branch
//! tip back into the cell, so the transaction alone is its rollback.

use std::sync::Arc;

use futures::future::BoxFuture;
use fuz_actions::ActionContext;
use fuz_db::iso8601_timestamp_column;
use fuz_forge_wire::output::{OkResponse, RepoEnvelope, RepoOutput, RepoResyncOutput};
use fuz_http::{
    JsonrpcError, conflict, internal_error, internal_error_with_source, not_found,
    parse_strict_params, service_unavailable, validation_error,
};
use fuz_sys::rfc3339_now;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::app::FuzForgeApp;
use crate::forge_git::read::read_default_branch_tip;
use crate::repo_storage;

use super::input_bounds::{RepoSelector, require_len, require_opt_len, require_repo_selector};
use super::repo_cell::{
    PushFacts, REPO_PATH_PREFIX, RepoCellData, hash_hook_secret, query_repo_cell,
    query_repo_cell_by_slug,
};
use super::repo_id::validate_repo_slug;
use super::seed_from::require_seed_from_url;
use super::to_value_out;

// =============================================================================
//  fuz_forge_repo_create / fuz_forge_repo_resync / fuz_forge_repo_rotate_secret
// =============================================================================

/// The -32603 message `fuz_forge_repo_create` answers a failed on-disk
/// assembly with, on both backends — the seeded form when `seed_from` was
/// set, else [`REPO_CREATE_ASSEMBLY_FAILED_MESSAGE`].
///
/// Fixed rather than detailed on purpose: git's stderr for a failed
/// `clone --bare` names the absolute store root, the `.tmp` assembly scheme
/// and the cell UUID the surrounding transaction is about to roll back — all
/// operator-only. The detail goes to `tracing::error!` here and `log.error`
/// on the TS twin. Twin constant: `REPO_CREATE_SEED_FAILED_MESSAGE` in
/// `src/lib/server/routes/fuz_forge_repo_write.ts`.
const REPO_CREATE_SEED_FAILED_MESSAGE: &str = "repo create failed: seed clone failed";
/// The unseeded twin of [`REPO_CREATE_SEED_FAILED_MESSAGE`]
/// (`REPO_CREATE_ASSEMBLY_FAILED_MESSAGE` on the TS side).
const REPO_CREATE_ASSEMBLY_FAILED_MESSAGE: &str = "repo create failed: repo assembly failed";

/// The -32603 messages `fuz_forge_repo_rotate_secret` answers a disk failure
/// with, on both backends (the same-named constants in
/// `src/lib/server/routes/fuz_forge_repo_write.ts`): the installed scripts
/// could not be read, so nothing changed; the rewrite failed and the old
/// scripts were restored; or the restore failed too.
const ROTATE_SECRET_UNREADABLE_MESSAGE: &str =
    "rotate-secret failed; hook scripts unreadable, nothing changed";
/// See [`ROTATE_SECRET_UNREADABLE_MESSAGE`].
const ROTATE_SECRET_REVERTED_MESSAGE: &str = "rotate-secret failed; reverted to old secret";
/// See [`ROTATE_SECRET_UNREADABLE_MESSAGE`].
const ROTATE_SECRET_PARTIAL_MESSAGE: &str = "rotate-secret partially applied: hook scripts on \
    disk may not match cell.hook_secret_hash; manual reconciliation required";

/// Mirrors `FuzForgeRepoCreateInput` in `action_specs.ts`. `slug` is a
/// bounded plain string on the wire (the strict `org/repo` grammar is a
/// handler-side `validation_error` on both backends); the length bounds and
/// `default_branch`'s `'main'` default are the schema's.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoCreateInput {
    slug: String,
    #[serde(default = "default_branch_main")]
    default_branch: String,
    #[serde(default)]
    seed_from: Option<String>,
    /// Dispatcher-owned actor selector, read off the raw params before the
    /// handler runs. Declared so `deny_unknown_fields` admits it; never read
    /// here.
    #[serde(default, deserialize_with = "fuz_http::deserialize_optional_wire_uuid")]
    #[expect(dead_code, reason = "resolved by the dispatcher, not the handler")]
    acting: Option<Uuid>,
}

fn default_branch_main() -> String {
    "main".into()
}

/// The context [`to_value_out`] names on a failed serialize.
const SERIALIZE_CONTEXT: &str = "fuz_forge_repo: serialize output";

/// `id` xor `slug` selector shared by `fuz_forge_repo_resync` /
/// `fuz_forge_repo_rotate_secret`. Mirrors `FuzForgeRepoMutationInput` in
/// `action_specs.ts`, whose piped `check` makes the xor a schema failure —
/// [`require_repo_selector`] is the twin.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoMutationInput {
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

pub fn fuz_forge_repo_create(
    app: Arc<FuzForgeApp>,
    params: Value,
    ctx: ActionContext<'_>,
) -> BoxFuture<'_, Result<Value, JsonrpcError>> {
    Box::pin(async move {
        let input: RepoCreateInput = parse_strict_params(params)?;
        require_len("slug", &input.slug, 3, 129)?;
        require_len("default_branch", &input.default_branch, 1, 255)?;
        require_opt_len("seed_from", input.seed_from.as_deref(), 1, 2048)?;
        // The seed URL is handed to `git clone --bare` as the remote, so hold
        // it to the http(s) grammar *before* any disk or DB work — the twin of
        // the `seed_from_url_canonical` `check` on the TS input schema. The
        // *canonical* serialization is what gets stored and cloned below: the
        // WHATWG parser and git disagree on spellings like
        // `https://host\user:pw@evil/x`, so only the canonical form
        // guarantees the host validated here is the host git dials.
        let seed_from = require_seed_from_url(
            input.seed_from.as_deref(),
            app.seed_from_allow_private_hosts,
        )?;
        // The wire `slug` is a bounded string; enforce the real `org/repo`
        // shape here (lowercase-canonicalized on success).
        let slug = validate_repo_slug(&input.slug)
            .map_err(|msg| validation_error(&format!("invalid slug: {msg}")))?;
        let name = slug
            .split_once('/')
            .map_or_else(|| slug.clone(), |(_, repo)| repo.to_owned());
        let Some(repo_root) = app.repo_path.clone() else {
            return Err(service_unavailable("repo storage not configured"));
        };
        let actor_id: Uuid = ctx
            .auth
            .actor()
            .map(|a| a.actor.id)
            .ok_or_else(|| internal_error("fuz_forge_repo_create: missing auth"))?;

        let cell_path = format!("{REPO_PATH_PREFIX}{slug}");
        // Friendly duplicate error. The `repos/<slug>` unique path index is the
        // authoritative guard (it also closes the TOCTOU race), but a 409 reads
        // better than a raw constraint violation.
        let existing = ctx
            .db
            .query_opt(
                "SELECT 1 FROM cell WHERE path = $1 AND deleted_at IS NULL LIMIT 1",
                &[&cell_path],
            )
            .await
            .map_err(|e| internal_error_with_source("fuz_forge_repo_create: dup check", &e))?;
        if existing.is_some() {
            return Err(conflict(&format!("repo slug already exists: {slug}"), None));
        }

        let hook_secret = Uuid::new_v4().to_string();
        // `seed_completed_at` ≈ create time for a seeded repo. `rfc3339_now`
        // is the spine's canonical second-precision UTC formatter, byte-identical
        // to the SQL `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` wire shape — so
        // the seed path needs no DB round-trip just to format the clock.
        let seed_completed_at: Option<String> = seed_from.is_some().then(rfc3339_now);

        let mut cell_data = json!({
            "slug": slug,
            "name": name,
            "default_branch": input.default_branch,
            "seed_from": seed_from,
            "seed_completed_at": seed_completed_at,
            // The cell keeps the digest; the plaintext goes only into the
            // hook scripts `assemble_repo` installs.
            "hook_secret_hash": hash_hook_secret(&hook_secret),
        });
        // A fresh repo has never been pushed; `PushFacts::default()` writes the
        // four null fields (JSONB normalizes key order, so appending is fine).
        if let Value::Object(map) = &mut cell_data {
            PushFacts::default().write_into(map);
        }
        let data_text = serde_json::to_string(&cell_data)
            .map_err(|e| internal_error_with_source("fuz_forge_repo_create: serialize", &e))?;

        // Create the cell first so its DB-generated `id` becomes the on-disk
        // bare-repo dir name and the hook scripts' repo id. A throw past this
        // point rolls the cell back with the surrounding transaction; the
        // filesystem isn't transactional, so disk state is unwound explicitly.
        //
        // Inlined INSERT rather than `fuz_cell::query_cell_create`. Equivalent
        // for a repo cell — `visibility` omitted takes the column default
        // `'private'` (the COALESCE default `query_cell_create` applies) and a
        // repo cell carries no blake3 refs, so `extract_refs` would be a no-op.
        // `kind` is the write-once top-level `cell.kind` column — `'repo'`
        // here, not a `data` field (a `kind` inside `data` is rejected
        // upstream).
        // TODO: swap to `query_cell_create`, run over `ctx.db` with
        // `fuz_db::action_db_dispatch!`.
        let row = ctx
            .db
            .query_opt(
                &format!(
                    "INSERT INTO cell (path, data, kind, created_by) \
                     VALUES ($1, $2::text::jsonb, 'repo', $3) \
                     RETURNING id, {}",
                    iso8601_timestamp_column("", "created_at")
                ),
                &[&cell_path, &data_text, &actor_id],
            )
            .await
            .map_err(|e| internal_error_with_source("fuz_forge_repo_create: insert", &e))?;
        let Some(row) = row else {
            return Err(internal_error(
                "fuz_forge_repo_create: insert returned no row",
            ));
        };
        let cell_id: Uuid = row.get(0);
        let created_at: String = row.get(1);

        // Everything that can still fail after the cell INSERT lives behind
        // `assemble_repo`, so every failure past it takes the one unwind below.
        let assembly = assemble_repo(
            &ctx,
            &AssembleRepoOptions {
                git_path: &app.git_path,
                repo_root: &repo_root,
                cell_id,
                seed_from: seed_from.as_deref(),
                default_branch: &input.default_branch,
                hook_secret: &hook_secret,
                callback_url_base: &app.callback_url_base,
                created_at: &created_at,
            },
            &mut cell_data,
        )
        .await;
        let (head_sha, updated_at) = match assembly {
            Ok(resolved) => resolved,
            Err(detail) => {
                // Best-effort disk unwind; the cell insert rolls back when this
                // error aborts the dispatcher's transaction.
                repo_storage::remove_repo_dir(&repo_root, cell_id).await;
                tracing::error!(slug = %slug, error = %detail, "fuz_forge_repo_create failed");
                // The detail is operator-only: git's stderr names the store root,
                // the `.tmp` assembly scheme and the cell UUID that is about to
                // roll back. The wire gets the fixed message both backends answer
                // with (`REPO_CREATE_SEED_FAILED_MESSAGE` /
                // `REPO_CREATE_ASSEMBLY_FAILED_MESSAGE` in
                // `src/lib/server/routes/fuz_forge_repo_write.ts`).
                return Err(internal_error(if seed_from.is_some() {
                    REPO_CREATE_SEED_FAILED_MESSAGE
                } else {
                    REPO_CREATE_ASSEMBLY_FAILED_MESSAGE
                }));
            }
        };

        to_value_out(
            &RepoEnvelope {
                repo: RepoOutput {
                    id: cell_id.to_string(),
                    slug,
                    name,
                    default_branch: input.default_branch,
                    seed_from,
                    seed_completed_at,
                    head_sha,
                    last_pushed_at: None,
                    last_pushed_by: None,
                    last_push_username: None,
                    created_at,
                    updated_at,
                },
            },
            SERIALIZE_CONTEXT,
        )
    })
}

pub fn fuz_forge_repo_resync(
    app: Arc<FuzForgeApp>,
    params: Value,
    ctx: ActionContext<'_>,
) -> BoxFuture<'_, Result<Value, JsonrpcError>> {
    Box::pin(async move {
        let input: RepoMutationInput = parse_strict_params(params)?;
        let resolved = resolve_repo_mutation(&app, &input).await?;
        // Both reads come from the narrow, never the raw JSON: a cell without a
        // `default_branch` is a 404 at `resolve_repo_mutation`, so there is
        // nothing to fall back to (the TS twin 404s the same cell).
        let previous_head_sha = resolved.cell.push.head_sha.clone();
        // `subprocess_failed` surfaces as 503 (don't blow away a known-good
        // head_sha on a transient failure); `no_such_ref` resolves to `None`
        // (empty repo / branch deleted).
        let head_sha = read_default_branch_tip(
            &app.git_path,
            &resolved.repo_path,
            &resolved.cell.default_branch,
        )
        .await?;
        if head_sha.as_deref() != previous_head_sha.as_deref() {
            // Write back over the RAW object so keys outside `RepoCellData`
            // survive the round-trip.
            let mut next = resolved.raw.clone();
            next["head_sha"] = head_sha.clone().map_or(Value::Null, Value::String);
            // TODO: insert fuz_forge_repo_event row
            update_repo_cell_data(&ctx, resolved.cell_id, &next).await?;
        }
        to_value_out(
            &RepoResyncOutput {
                previous_head_sha,
                head_sha,
            },
            SERIALIZE_CONTEXT,
        )
    })
}

pub fn fuz_forge_repo_rotate_secret(
    app: Arc<FuzForgeApp>,
    params: Value,
    ctx: ActionContext<'_>,
) -> BoxFuture<'_, Result<Value, JsonrpcError>> {
    Box::pin(async move {
        let input: RepoMutationInput = parse_strict_params(params)?;
        let resolved = resolve_repo_mutation(&app, &input).await?;
        let cell_id = resolved.cell_id;
        let Some(repo_root) = app.repo_path.clone() else {
            return Err(service_unavailable("repo storage not configured"));
        };
        let new_secret = Uuid::new_v4().to_string();
        let callback = app.callback_url_base.clone();

        // The cell holds only the old secret's digest, so a failed rewrite is
        // rolled back from the scripts' bytes, read before anything changes.
        let snapshot = match repo_storage::snapshot_hooks(&repo_root, cell_id).await {
            Ok(snapshot) => snapshot,
            Err(detail) => {
                tracing::error!(error = %detail, "fuz_forge_repo_rotate_secret: hook read failed");
                return Err(internal_error(ROTATE_SECRET_UNREADABLE_MESSAGE));
            }
        };

        // Stage the new digest in the dispatcher's transaction. Any error below
        // rolls the cell back automatically; the explicit disk-side recovery
        // just keeps the on-disk scripts consistent with the rolled-back cell.
        let next = rotated_repo_cell_data(&resolved.raw, &new_secret);
        // TODO: insert fuz_forge_repo_event row
        update_repo_cell_data(&ctx, cell_id, &next).await?;

        if let Err(forward) =
            repo_storage::install_hooks(&app.git_path, &repo_root, cell_id, &new_secret, &callback)
                .await
        {
            tracing::error!(error = %forward, "fuz_forge_repo_rotate_secret: hook write failed");
            return Err(
                match repo_storage::restore_hooks(&app.git_path, &repo_root, cell_id, &snapshot)
                    .await
                {
                    Ok(()) => internal_error(ROTATE_SECRET_REVERTED_MESSAGE),
                    Err(rb) => {
                        tracing::error!(error = %rb, "fuz_forge_repo_rotate_secret: disk rollback failed");
                        internal_error(ROTATE_SECRET_PARTIAL_MESSAGE)
                    }
                },
            );
        }
        to_value_out(&OkResponse { ok: true }, SERIALIZE_CONTEXT)
    })
}

/// The cell data a rotation writes: the RAW object, so keys outside
/// [`RepoCellData`] survive, with `hook_secret_hash` set to the new secret's
/// digest and any legacy plaintext `hook_secret` key dropped. A cell that held
/// the plaintext and was given a digest by hand would otherwise carry the old
/// plaintext through every later rotation. Twin: the rotate handler in
/// `src/lib/server/routes/fuz_forge_repo_write.ts`.
fn rotated_repo_cell_data(raw: &Value, new_secret: &str) -> Value {
    let mut next = raw.clone();
    if let Some(obj) = next.as_object_mut() {
        obj.remove("hook_secret");
    }
    next["hook_secret_hash"] = Value::String(hash_hook_secret(new_secret));
    next
}

/// The inputs [`assemble_repo`] reads, borrowed from the create handler's
/// frame. Twin: the `AssembleRepoOptions` interface in
/// `src/lib/server/routes/fuz_forge_repo_write.ts`. The two bags carve the
/// same assembly differently in three places: this one carries the `git_path`
/// / `repo_root` / `callback_url_base` the app resolves once at startup, where
/// the TS side derives all three from its `runtime` deps; this one carries
/// `created_at` because this side's `assemble_repo` returns the `updated_at`
/// **string** and so needs the fallback stamp in the bag, where the TS twin
/// returns the row (or `null`) and its caller picks between the UPDATE row and
/// the INSERT row it already holds; and the TS bag carries the `cell_data`
/// this side takes as a separate `&mut Value` parameter.
struct AssembleRepoOptions<'a> {
    /// The `PATH` handed to every git/chmod subprocess the assembly spawns —
    /// a search list, not an executable path: `forge_git::read::git_env`
    /// installs it as the child's `PATH` and the storage steps spawn the bare
    /// `git` / `chmod` names against it.
    git_path: &'a str,
    /// The repo store root the bare repo is assembled under.
    repo_root: &'a std::path::Path,
    /// The created cell's id — the on-disk bare-repo dir name and the hook
    /// scripts' repo id.
    cell_id: Uuid,
    /// The canonical seed URL, or `None` for an unseeded create.
    seed_from: Option<&'a str>,
    default_branch: &'a str,
    /// Per-repo shared secret the installed hooks authenticate their callback
    /// with — the plaintext the scripts embed; the cell holds its digest.
    hook_secret: &'a str,
    /// Base URL the installed hooks call back into.
    callback_url_base: &'a str,
    /// The INSERT's stamp, handed back as the response's `updated_at` whenever
    /// no seeded-tip write happens.
    created_at: &'a str,
}

/// Assemble a created repo's on-disk state and, for a seeded repo, read its
/// default-branch tip back into the cell.
///
/// Everything that can still fail after the cell INSERT lives here, so every
/// failure past it takes the same unwind at the callsite: the disk dir is
/// removed, the cell rolls back with the transaction, and the wire gets the
/// fixed message. That includes the seeded-tip **cell UPDATE** — a DB failure
/// there outside this boundary would roll the cell back and leave
/// `<cell_id>.git` on disk forever, under a `-32603` naming the SQL step.
///
/// Twin: the TS `assemble_repo` in
/// `src/lib/server/routes/fuz_forge_repo_write.ts`, which draws the same
/// boundary — it throws on any of the same failures, and the create
/// handler's `try` / `catch` around the call owns the disk unwind and the
/// fixed message.
///
/// `Ok((Some(sha), _))` is a seeded repo whose default branch resolved,
/// `Ok((None, _))` an unseeded repo or a seed with no branch by that name; the
/// second element is the `updated_at` the response must carry. The `Err`
/// payload is the operator-only detail the caller logs, never a wire message.
async fn assemble_repo(
    ctx: &ActionContext<'_>,
    options: &AssembleRepoOptions<'_>,
    cell_data: &mut Value,
) -> Result<(Option<String>, String), String> {
    if let Some(url) = options.seed_from {
        repo_storage::clone_bare_repo(options.git_path, options.repo_root, options.cell_id, url)
            .await?;
    } else {
        repo_storage::init_bare_repo(options.git_path, options.repo_root, options.cell_id).await?;
    }
    repo_storage::set_default_head(
        options.git_path,
        options.repo_root,
        options.cell_id,
        options.default_branch,
    )
    .await?;
    repo_storage::install_hooks(
        options.git_path,
        options.repo_root,
        options.cell_id,
        options.hook_secret,
        options.callback_url_base,
    )
    .await?;
    if options.seed_from.is_none() {
        return Ok((None, options.created_at.to_owned()));
    }
    // A seeded repo already has history, so read its default-branch tip now —
    // the same read `fuz_forge_repo_resync` performs, against the same on-disk
    // repo. Without it a freshly mirrored repo browses with an EMPTY commit log
    // (`fuz_forge_repo_log` takes the never-pushed shortcut on a null
    // `head_sha`) until an operator resyncs, while `_refs` / `_tree` / `_blob`
    // all work — mirroring is the forge's first use case, so that split is a
    // defect, not a nicety.
    //
    // A `None` tip is NOT a failure: the upstream may carry no branch by this
    // name (a `master` upstream cloned into a `main` repo), which is the same
    // null tip an unseeded create has. Only a real read failure is an error,
    // and raising it here unwinds the disk and answers the fixed seed message
    // like any other assembly step. Twin: the `read_default_branch_tip` call in
    // the create of `src/lib/server/routes/fuz_forge_repo_write.ts`.
    let repo_dir = repo_storage::repo_dir(options.repo_root, options.cell_id);
    let tip = read_default_branch_tip(options.git_path, &repo_dir, options.default_branch)
        .await
        .map_err(|e| format!("failed to read seeded default-branch tip: {}", e.message))?;
    let Some(ref sha) = tip else {
        return Ok((None, options.created_at.to_owned()));
    };
    // The seeded tip is a second write on the row the INSERT just made, so the
    // response has to carry the `updated_at` that write stamped — returning the
    // INSERT's would hand the client a repo whose `updated_at` a following
    // `fuz_forge_repo_get` could contradict. Twin: the TS create, which builds
    // its response from the row `query_cell_update` returns.
    cell_data["head_sha"] = Value::String(sha.clone());
    let updated_at = update_repo_cell_data_returning_updated_at(ctx, options.cell_id, cell_data)
        .await
        .map_err(|e| format!("seeded head_sha write failed: {}", e.message))?;
    Ok((tip, updated_at))
}

/// A repo cell resolved for a mutation: the cell-id UUID, its on-disk
/// bare-repo path, the raw `data` JSON (the write-back base, so keys outside
/// [`RepoCellData`] survive a round-trip update), and the typed narrow.
struct ResolvedRepoMutation {
    cell_id: Uuid,
    repo_path: std::path::PathBuf,
    raw: Value,
    cell: RepoCellData,
}

/// Narrow a repo cell's stored `data` text for a mutation: the raw object plus
/// the typed [`RepoCellData`] view. `None` when the text isn't JSON, isn't an
/// object, or doesn't satisfy the narrow — the caller maps that to
/// `not_found("repo")`, which is what the TS twin's `resolve_repo_cell` does
/// with a `narrow_repo_cell_data` returning `null`.
fn narrow_repo_mutation_cell(data_text: &str) -> Option<(Value, RepoCellData)> {
    let raw: Value = serde_json::from_str(data_text).ok()?;
    if !raw.is_object() {
        return None;
    }
    let cell = RepoCellData::deserialize(&raw).ok()?;
    Some((raw, cell))
}

/// Resolve a repo cell by `id` xor `slug` for a mutation.
///
/// The `data` is narrowed through [`RepoCellData`] here, so every mutation
/// reads `default_branch` / `hook_secret_hash` from a typed value instead of
/// poking the raw JSON with a fallback — a partial cell is a 404 on both
/// backends rather than a callback that invents `main` or an empty secret.
async fn resolve_repo_mutation(
    app: &FuzForgeApp,
    input: &RepoMutationInput,
) -> Result<ResolvedRepoMutation, JsonrpcError> {
    let row = match require_repo_selector(input.id.as_deref(), input.slug.as_deref())? {
        RepoSelector::Id(id) => query_repo_cell(app, id).await?,
        RepoSelector::Slug(slug) => query_repo_cell_by_slug(app, slug).await?,
    };
    let Some(row) = row else {
        return Err(not_found("repo", None));
    };
    let cell_id: Uuid = row.get(0);
    let data_text: String = row.get(2);
    let Some((raw, cell)) = narrow_repo_mutation_cell(&data_text) else {
        return Err(not_found("repo", None));
    };
    let Some(repo_root) = app.repo_path.as_ref() else {
        return Err(service_unavailable("repo storage not configured"));
    };
    let repo_path = repo_storage::repo_dir(repo_root, cell_id);
    Ok(ResolvedRepoMutation {
        cell_id,
        repo_path,
        raw,
        cell,
    })
}

/// Update a repo cell's `data` JSONB in the dispatcher transaction
/// (`ctx.db` is the `Tx` because the spec is `side_effects: true`).
async fn update_repo_cell_data(
    ctx: &ActionContext<'_>,
    cell_id: Uuid,
    data: &Value,
) -> Result<(), JsonrpcError> {
    let data_text = serde_json::to_string(data)
        .map_err(|e| internal_error_with_source("repo cell update: serialize", &e))?;
    ctx.db
        .execute(
            // `$1::text::jsonb`, not `$1::jsonb` — see the token-policy insert.
            "UPDATE cell SET data = $1::text::jsonb, updated_at = NOW() \
             WHERE id = $2 AND deleted_at IS NULL",
            &[&data_text, &cell_id],
        )
        .await
        .map_err(|e| internal_error_with_source("repo cell update", &e))?;
    Ok(())
}

/// [`update_repo_cell_data`] that hands back the `updated_at` the write
/// stamped, in the canonical second-precision UTC wire shape.
///
/// The create path needs it: its response is built in memory rather than
/// re-read, so without the returned stamp a seeded create would report the
/// INSERT's `updated_at` for a row the tip write has already moved on.
///
/// **Today the two stamps are equal**, and deliberately so: both writes run in
/// the dispatcher's single transaction and Postgres `NOW()` is
/// transaction-scoped, so the INSERT's `created_at` and this UPDATE's
/// `updated_at` are the same instant. Returning `created_at` here would
/// therefore pass every test. This is defensive rather than currently
/// observable — it holds if the create is ever split across transactions, or if
/// either write moves to `clock_timestamp()`. The wire contract the tests *can*
/// see is the weaker one it guarantees: the create response's `updated_at` is
/// what a following `fuz_forge_repo_get` returns.
async fn update_repo_cell_data_returning_updated_at(
    ctx: &ActionContext<'_>,
    cell_id: Uuid,
    data: &Value,
) -> Result<String, JsonrpcError> {
    let data_text = serde_json::to_string(data)
        .map_err(|e| internal_error_with_source("repo cell update: serialize", &e))?;
    let row = ctx
        .db
        .query_opt(
            &format!(
                // `$1::text::jsonb`, not `$1::jsonb` — see the token-policy insert.
                "UPDATE cell SET data = $1::text::jsonb, updated_at = NOW() \
                 WHERE id = $2 AND deleted_at IS NULL RETURNING {}",
                iso8601_timestamp_column("", "updated_at")
            ),
            &[&data_text, &cell_id],
        )
        .await
        .map_err(|e| internal_error_with_source("repo cell update", &e))?;
    row.map(|row| row.get(0))
        .ok_or_else(|| internal_error("repo cell update returned no row"))
}

#[cfg(test)]
mod tests {
    use fuz_http::JsonrpcErrorCode;

    use super::*;

    const ID: &str = "3f8a1c2e-1234-4abc-9def-0123456789ab";

    /// Every input-shape refusal is the `-32602` a TS dispatch-schema failure
    /// produces, asserted through the spine's [`parse_strict_params`] so the
    /// envelope — not merely "it failed to parse" — is what the case pins.
    fn assert_invalid_params(err: &JsonrpcError) {
        assert_eq!(err.code, JsonrpcErrorCode::InvalidParams);
    }

    /// `deny_unknown_fields` is the strict `object` twin — a key the write
    /// inputs don't declare is refused at parse rather than dropped.
    #[test]
    fn write_inputs_reject_an_unknown_key() {
        assert_invalid_params(
            &parse_strict_params::<RepoCreateInput>(json!({"slug": "org/repo", "nope": 1}))
                .unwrap_err(),
        );
        assert_invalid_params(
            &parse_strict_params::<RepoMutationInput>(json!({"id": ID, "nope": 1})).unwrap_err(),
        );
    }

    /// A rotation writes the new digest, keeps keys outside the narrow, and
    /// drops a legacy plaintext `hook_secret`.
    #[test]
    fn rotation_drops_a_legacy_plaintext_secret() {
        let raw = json!({
            "slug": "org/repo",
            "hook_secret": "legacy-plaintext",
            "hook_secret_hash": hash_hook_secret("legacy-plaintext"),
            "extra": 1,
        });
        let next = rotated_repo_cell_data(&raw, "new-secret");
        assert_eq!(
            next,
            json!({
                "slug": "org/repo",
                "hook_secret_hash": hash_hook_secret("new-secret"),
                "extra": 1,
            })
        );
    }

    /// The dispatcher reads `acting` off the raw params, so the strict structs
    /// must still admit the key.
    #[test]
    fn write_inputs_accept_the_dispatcher_owned_acting_selector() {
        assert!(
            parse_strict_params::<RepoCreateInput>(json!({"slug": "org/repo", "acting": ID}))
                .is_ok()
        );
        assert!(parse_strict_params::<RepoMutationInput>(json!({"id": ID, "acting": ID})).is_ok());
    }

    /// The spine's `parse_strict_params` walks for `null` ahead of the
    /// decode — `null` on an optional key is `-32602` on TS and `None` to
    /// serde. On the mutation selector that difference is load-bearing:
    /// `{"id": null, "slug": "..."}` would otherwise resolve as a slug-only
    /// lookup the TS twin refuses.
    #[test]
    fn write_inputs_reject_a_null_on_an_optional_key() {
        for params in [
            json!({"slug": "org/repo", "seed_from": null}),
            json!({"slug": "org/repo", "default_branch": null}),
            json!({"slug": "org/repo", "acting": null}),
        ] {
            assert_invalid_params(&parse_strict_params::<RepoCreateInput>(params).unwrap_err());
        }
        for params in [
            json!({"id": null, "slug": "org/repo"}),
            json!({"id": ID, "slug": null}),
        ] {
            assert_invalid_params(&parse_strict_params::<RepoMutationInput>(params).unwrap_err());
        }
        assert!(parse_strict_params::<RepoMutationInput>(json!({"id": ID})).is_ok());
    }

    /// A minimally-complete repo cell `data` — the four fields the narrow
    /// requires — plus an unknown key no `RepoCellData` field names.
    fn mutation_cell_text() -> String {
        json!({
            "slug": "org/repo",
            "name": "repo",
            "default_branch": "trunk",
            "hook_secret_hash": "s3cr3t",
            "head_sha": "abc123",
            "x_extra": 1,
        })
        .to_string()
    }

    /// The mutation handlers read `default_branch` / `hook_secret_hash` /
    /// `head_sha` off the narrow, and write back over the raw object. Both
    /// halves are pinned here: the narrow carries the real values (no
    /// `.unwrap_or("main")` / `.unwrap_or_default()` fallback left), and the
    /// raw keeps the unknown key the write-back preserves.
    #[test]
    fn mutation_narrow_reads_typed_fields_and_keeps_the_raw_object() {
        let (raw, cell) = narrow_repo_mutation_cell(&mutation_cell_text()).expect("narrows");
        assert_eq!(cell.default_branch, "trunk");
        assert_eq!(cell.hook_secret_hash, "s3cr3t");
        assert_eq!(cell.push.head_sha.as_deref(), Some("abc123"));
        assert_eq!(raw["x_extra"], json!(1));
    }

    /// Twin of `narrow_repo_cell_data`'s null-on-missing: a cell missing any
    /// required field is `None` here, so the mutation 404s rather than
    /// inventing a default branch or an empty secret digest.
    #[test]
    fn mutation_narrow_rejects_a_partial_cell() {
        for missing in ["slug", "name", "default_branch", "hook_secret_hash"] {
            let mut obj: Value = serde_json::from_str(&mutation_cell_text()).unwrap();
            obj.as_object_mut().expect("object").remove(missing);
            assert!(
                narrow_repo_mutation_cell(&obj.to_string()).is_none(),
                "cell missing `{missing}` must not narrow",
            );
        }
    }

    /// A wrong-typed *optional* field is a rejection too, not a coercion to
    /// `null` — the twin of the TS narrow's `is_optional_str` guard.
    #[test]
    fn mutation_narrow_rejects_a_wrong_typed_optional() {
        for (key, bad) in [
            ("head_sha", json!(5)),
            ("last_pushed_at", json!(true)),
            ("seed_from", json!({"nested": 1})),
        ] {
            let mut obj: Value = serde_json::from_str(&mutation_cell_text()).unwrap();
            obj[key] = bad;
            assert!(
                narrow_repo_mutation_cell(&obj.to_string()).is_none(),
                "cell with a non-string `{key}` must not narrow",
            );
        }
    }

    /// A non-object `data` (or non-JSON text) is a missing cell, not a panic.
    #[test]
    fn mutation_narrow_rejects_non_object_data() {
        assert!(narrow_repo_mutation_cell("[]").is_none());
        assert!(narrow_repo_mutation_cell("\"nope\"").is_none());
        assert!(narrow_repo_mutation_cell("not json").is_none());
    }

    /// `default_branch` defaults to `main` when the key is absent, matching the
    /// TS `with_default(..., 'main')`.
    #[test]
    fn repo_create_input_defaults_the_branch() {
        let input: RepoCreateInput =
            parse_strict_params(json!({"slug": "org/repo"})).expect("parses");
        assert_eq!(input.default_branch, "main");
        assert_eq!(input.seed_from, None);
    }
}
