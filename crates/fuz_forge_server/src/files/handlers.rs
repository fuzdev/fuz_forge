//! File-store HTTP handlers — upload, download/meta, list, delete.
//!
//! The four catch-all handlers plus their request-local helpers (the strict
//! `acting` query read, the per-file capability gate, and the traversal-safe
//! key validator). The handlers are referenced by
//! [`super::files_router`]; the cell shape they read/write lives in
//! [`super::content_type`] and the disk-budget preflight in
//! [`super::disk_budget`].

use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::{Extension, Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures::TryStreamExt;
use fuz_cell::cell_queries::{
    query_cell_create, query_cell_delete, query_cell_get_by_path, query_cell_update,
};
use serde_json::json;
use tokio_util::io::StreamReader;

use fuz_auth::{ResolvedAuth, token_scope_surface_denied_response};
use fuz_crypto::ContentHash;
use fuz_db::iso8601_timestamp_column;
use fuz_fact::FactError;
use fuz_http::ClientIp;
use uuid::Uuid;

use crate::fact_store::{FactContent, PutOptions};
use crate::query_params::{first_query_param, has_unknown_query_key};
use crate::route_auth::resolve_acting_actor;
use crate::token_policy::{FuzForgeCapability, FuzForgeTokenPolicy, policy_check};
use crate::token_surfaces::{SURFACE_FILE_STORE, token_scope_admits_forge_surface};
use fuz_auth::parse_acting_query;
use fuz_http::{
    PAYLOAD_TOO_LARGE_REASON, db_unavailable_response_with_source,
    internal_error_response_with_source, invalid_route_params_response, rest_error_response,
};

use fuz_forge_wire::output::{
    FileDeleteOutput, FileListOutput, FileMetaOutput, FileUploadOutput, UploadStatus,
};

use super::FilesRouteState;
use super::content_type::{
    FileCellData, file_cell_path, filename_from_cell_path, infer_content_type,
};
use super::disk_budget::{check_disk_budget, storage_full_response};

/// Answer a fact-store failure with no route-specific meaning: the store's own
/// pool checkout failing (`FactError::Pool`) is the spine's flat 503, like
/// every other checkout failure (the TS twin's `DbCheckoutError`), and
/// anything else is the logged 500.
fn fact_store_error_response(context: &str, error: &FactError) -> Response {
    if matches!(error, FactError::Pool(_)) {
        db_unavailable_response_with_source(context, error)
    } else {
        internal_error_response_with_source(context, error)
    }
}

/// Query key carrying the acting-actor selector on the file mutation routes.
const ACTING_QUERY_KEY: &str = "acting";

/// Read the `acting` actor selector for the file mutation routes (POST /
/// DELETE) under the TS twins' `query: object({acting: ActingActor})`.
///
/// Two halves, both off the raw query: an unrecognized key fails the parse
/// (the strict-`object` part), and the recognized one collapses to its first
/// value (what `c.req.query()` hands the schema). The value is a bare UUID,
/// decoded by [`parse_acting_query`]; absent ⇒ the credential's primary
/// actor.
///
/// Read raw rather than through an axum `Query<T>` extractor, whose serde
/// decode refuses a duplicated key outright — a 400 where the TS twin takes
/// the first value and proceeds. The `?meta` selector on [`handle_get`] and
/// the git route's `?service=` had the same shape and the same fix.
///
/// # Errors
///
/// Returns the 400 `invalid_query_params` `Response` for an unknown key or an
/// `acting` value that isn't a UUID — the one body the TS strict `object`
/// answers for either.
#[allow(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
fn parse_acting_strict_query(raw_query: Option<&str>) -> Result<Option<Uuid>, Response> {
    if has_unknown_query_key(raw_query, &[ACTING_QUERY_KEY]) {
        return Err(rest_error_response(
            StatusCode::BAD_REQUEST,
            "invalid_query_params",
        ));
    }
    parse_acting_query(first_query_param(raw_query, ACTING_QUERY_KEY).as_deref())
}

/// 403 `{error: "forbidden", required: "<capability>"}` — the TS
/// `enforce_capability` denial body. Returned when a scoped token lacks
/// the file capability the handler requires.
fn capability_forbidden(capability: &FuzForgeCapability<'_>) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({"error": "forbidden", "required": capability.as_string()})),
    )
        .into_response()
}

/// Refuse the file store to a credential the resource policy does not govern.
///
/// The scope half of the two-axis rule, on its own, because one route needs it
/// without the capability half: [`handle_list`] filters rather than 403s, so it
/// cannot go through [`enforce_capability`], and a token with no policy row has
/// nothing to filter *by*. Sharing the branch is what keeps the two routes from
/// drifting.
///
/// Port of the TS `enforce_surface`, which takes the surface as a parameter
/// because it lives in the shared policy middleware; this one is a private
/// helper in the file-store module and names its own.
#[allow(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
fn enforce_surface(
    auth: &ResolvedAuth,
    policy: Option<&FuzForgeTokenPolicy>,
) -> Result<(), Response> {
    if token_scope_admits_forge_surface(policy, auth.scope()) {
        Ok(())
    } else {
        Err(token_scope_surface_denied_response(SURFACE_FILE_STORE))
    }
}

/// Enforce a file capability against the request's authority over this surface.
///
/// The single funnel for the file store's per-file routes, so both per-token
/// axes resolve in one place and neither can be applied without the other:
///
/// - A token **with** a policy row is governed by it — `policy_check` decides,
///   and a denial is the resource-bound `{error: "forbidden", required:
///   "<capability>"}`.
/// - A token **without** one is governed by its spine scope, via
///   [`enforce_surface`]. A narrowed token is refused with the spine's flat
///   `{error: "token_scope_required", required_scope}`, because the caller's
///   problem is its scope and not the filename it asked for.
///
/// See [`crate::token_surfaces`] for why it splits that way. Port of the TS
/// `enforce_capability` gate.
#[allow(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
fn enforce_capability(
    auth: &ResolvedAuth,
    policy: Option<&FuzForgeTokenPolicy>,
    capability: &FuzForgeCapability<'_>,
) -> Result<(), Response> {
    enforce_surface(auth, policy)?;
    if policy_check(policy, capability) {
        Ok(())
    } else {
        Err(capability_forbidden(capability))
    }
}

/// A coded REST error with its prose in `message` — `{error: <code>,
/// message: <prose>}`, the TS twin's `c.json({error, message}, status)`.
fn rest_error_with_message(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({"error": code, "message": message}))).into_response()
}

/// `{ "error": "file_not_found", "message": "File not found" }` 404 — the
/// shared file-miss response, the TS twin's `REST_FILE_NOT_FOUND`.
fn file_not_found() -> Response {
    rest_error_with_message(StatusCode::NOT_FOUND, "file_not_found", "File not found")
}

/// `{ "error": "payload_too_large", "message": <the cap> }` 413 — an upload
/// over the file-store cap, the TS twin's `REST_FILE_TOO_LARGE`.
fn file_too_large(message: &str) -> Response {
    rest_error_with_message(
        StatusCode::PAYLOAD_TOO_LARGE,
        PAYLOAD_TOO_LARGE_REASON,
        message,
    )
}

/// Traversal-safe filename validation, delegating to
/// [`fuz_storage::validate_forge_key`] — the single source of truth shared with
/// the `ForgeStorage` producer. Allows interior `/` (the release layout is
/// path-structured, `tools/<name>/<version>/...`); rejects empty,
/// `..`/`.`/leading-dot/empty segments, absolute (leading `/`), trailing `/`,
/// over-length, and out-of-charset keys. On rejection returns the canonical
/// 400 `{error: "invalid_route_params"}` (the filename is the route param) — the
/// same code the TS twin returns, and what the spine's derived error schema
/// already declares for these routes.
///
/// Filenames here are DB cell-path keys (`files/<filename>`), not filesystem
/// paths — bytes are content-addressed by blake3 in the fact store — so this is
/// key hygiene + producer parity, not the FS-escape defense (there is no
/// filename-derived filesystem path to traverse).
#[allow(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
fn validate_file_key(filename: &str) -> Result<(), Response> {
    fuz_storage::validate_forge_key(filename).map_err(|_| invalid_route_params_response())
}

#[allow(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
pub(super) async fn handle_upload(
    State(state): State<FilesRouteState>,
    Path(filename): Path<String>,
    RawQuery(raw_query): RawQuery,
    client_ip: Option<Extension<ClientIp>>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, Response> {
    // The TS route runner's phase order, which this handler mirrors step for
    // step: content type (415) → query shape (400) → authenticate (401) →
    // resolve the acting actor (400) → role (403) → the handler's own gates.
    // Running the role gate ahead of the actor resolution answered 403 where
    // TS answers 400 for the same request; see `apply_route_specs` /
    // `apply_authorization_phase` in fuz_app.
    //
    // The content-type gate is the TS `raw_body` route's: any type but none or
    // a CORS-safelisted one, which a browser could send cross-origin without a
    // preflight (`fuz_http::simple_request`).
    if fuz_http::is_cors_simple_content_type(&headers) {
        return Err(fuz_http::unsupported_content_type_response());
    }
    let acting = parse_acting_strict_query(raw_query.as_deref())?;
    // The XFF-resolved client IP (`ClientIp` extension, set app-wide by
    // `fuz_http::client_ip_middleware`) — the Rust analog of TS `get_client_ip`.
    let client_ip = ClientIp::as_str_or_unresolved(client_ip.as_ref());
    let auth = state.require_auth(&headers, client_ip).await?;
    // The actor stamped as `created_by` / `updated_by` on the cell mutation.
    let actor_id = resolve_acting_actor(&state.gate.pool, &auth, acting).await?;
    state.require_admin_role(&auth).await?;

    validate_file_key(&filename)?;

    // Scoped-token gate: `files.write:<filename>`. Runs after the role
    // gate + filename validation, before the body is consumed — matching
    // the TS handler's `enforce_capability` placement.
    let policy = state.request_policy(&auth).await?;
    enforce_capability(
        &auth,
        policy.as_ref(),
        &FuzForgeCapability::FilesWrite {
            filename: &filename,
        },
    )?;

    let declared_content_length = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());

    // Reject an over-cap upload from the declared `Content-Length` before
    // reading a single byte — the cheap, common path (the TS twin does the
    // same). The streaming byte-counter in `put_stream` is the backstop for
    // chunked / mis-declared lengths.
    if let Some(content_length) = declared_content_length
        && content_length > state.max_upload_bytes as u64
    {
        return Err(file_too_large(&format!(
            "File too large: {content_length} bytes exceeds {} byte limit",
            state.max_upload_bytes
        )));
    }

    // Bound concurrent streaming uploads: hold a permit for the rest of the
    // handler so *both* the free-space preflight below and the disk-writing
    // `put_stream` window see at most `max_concurrent_uploads` in flight. Taken
    // before the preflight (but after the cheap header-only over-cap reject
    // above) so the free-space probe reflects bounded concurrency rather than
    // racing the full request fan-out. `acquire_owned` only errors if the
    // semaphore is closed, which never happens here.
    let _permit = Arc::clone(&state.upload_semaphore)
        .acquire_owned()
        .await
        .map_err(|e| internal_error_response_with_source("files.upload semaphore", &e))?;

    // Disk-budget preflight: reject before streaming when the volume wouldn't
    // hold the declared upload plus the configured headroom (`507 storage_full`).
    check_disk_budget(
        state.disk_root.as_deref(),
        declared_content_length,
        state.free_space_margin_bytes,
    )?;

    let content_type = infer_content_type(&filename);
    let cell_path = file_cell_path(&filename);

    // Look up the existing cell *before* streaming so the post-stream blake3
    // decides Created / Updated / Unchanged. The hash isn't known until the
    // stream ends, so (unlike the buffered handler) an unchanged re-upload
    // streams-then-dedups rather than short-circuiting up front — acceptable;
    // the CAS dedups the bytes and we skip only the cell write. The client is
    // scoped to the lookup: it goes back to the pool before the stream, which
    // can run for minutes and whose fact-row insert checks out its own
    // connection, so concurrent uploads can't exhaust the pool against
    // themselves. No transaction spans these steps.
    let existing = {
        let client = state
            .gate
            .pool
            .get()
            .await
            .map_err(|e| db_unavailable_response_with_source("files.upload pool", &e))?;
        query_cell_get_by_path(&client, &cell_path)
            .await
            .map_err(|e| internal_error_response_with_source("files.upload cell_get", &e))?
    };
    let existing_blake3 = existing
        .as_ref()
        .and_then(|c| FileCellData::from_cell_data(&c.data).map(|d| d.blake3));

    // Stream the body into the fact store: bounded memory, content-addressed,
    // cap enforced mid-stream. `into_data_stream` → an `AsyncRead` the fact
    // store reads in chunks (no whole-artifact buffer).
    let reader = StreamReader::new(body.into_data_stream().map_err(std::io::Error::other));
    let outcome = state
        .fact_store
        .inner()
        .put_stream(
            Box::pin(reader),
            state.max_upload_bytes,
            PutOptions {
                content_type: Some(content_type.to_owned()),
                refs: None,
                // the acting admin holds what it uploaded (cell ref admission)
                holder: Some(actor_id),
            },
        )
        .await
        .map_err(|e| match e {
            FactError::PayloadTooLarge => file_too_large(&format!(
                "File too large: exceeds {} byte limit",
                state.max_upload_bytes
            )),
            // Mid-stream disk-full (ENOSPC) — the backstop for what the
            // free-space preflight can't catch (chunked uploads, TOCTOU races).
            FactError::StorageFull => storage_full_response(),
            other => fact_store_error_response("files.upload put_stream", &other),
        })?;

    if outcome.size == 0 {
        return Err(rest_error_with_message(
            StatusCode::BAD_REQUEST,
            "empty_body",
            "Empty body",
        ));
    }

    // Idempotent: identical bytes → no cell write (the fact already deduped).
    if existing_blake3.as_ref() == Some(&outcome.hash) {
        return Ok(upload_response(
            &filename,
            &outcome.hash,
            outcome.size,
            content_type,
            UploadStatus::Unchanged,
        ));
    }

    let cell_data = serde_json::to_value(FileCellData {
        content_type: content_type.to_owned(),
        size: outcome.size,
        blake3: outcome.hash.clone(),
    })
    .map_err(|e| internal_error_response_with_source("files.upload cell_data encode", &e))?;

    let client = state
        .gate
        .pool
        .get()
        .await
        .map_err(|e| db_unavailable_response_with_source("files.upload cell write pool", &e))?;
    let status = if let Some(cell) = &existing {
        query_cell_update(
            &client,
            cell.id,
            Some(&cell_data),
            None,
            None,
            Some(actor_id),
        )
        .await
        .map_err(|e| internal_error_response_with_source("files.upload cell_update", &e))?;
        UploadStatus::Updated
    } else {
        query_cell_create(
            &client,
            &cell_data,
            // `kind` is the write-once top-level `cell.kind` column — not a
            // `data` field (a `kind` inside `data` is rejected upstream).
            Some("file"),
            None,
            Some(&cell_path),
            None, // parent_id — files are unparented (no containment tree)
            None, // root_id
            None, // moderation — not a gated contribution
            None, // policy
            Some(actor_id),
        )
        .await
        .map_err(|e| internal_error_response_with_source("files.upload cell_create", &e))?;
        UploadStatus::Created
    };

    Ok(upload_response(
        &filename,
        &outcome.hash,
        outcome.size,
        content_type,
        status,
    ))
}

/// The `POST` success body — [`FileUploadOutput`], the shape the `fuzf` client
/// deserializes. It carries `status` and no `uploaded_at`; the metadata read is
/// what resolves that (see [`FileCellData::to_meta_output`]).
fn upload_response(
    filename: &str,
    fact: &ContentHash,
    size: i64,
    content_type: &str,
    status: UploadStatus,
) -> Response {
    Json(FileUploadOutput {
        filename: filename.to_owned(),
        blake3_hash: fact.to_hex(),
        size_bytes: size,
        content_type: content_type.to_owned(),
        status,
    })
    .into_response()
}

/// GET the file — download bytes, or (with `?meta`) the metadata JSON.
///
/// One handler for both because they share the same gate (`files.read`),
/// validation, and cell lookup; `?meta` only flips whether the bytes are
/// fetched. Merging keeps a single validation + capability path (no drift
/// surface between a separate meta route and the download route), and is what
/// lets the metadata endpoint live on the terminal catch-all. The TS twin is
/// the same single GET handler branching on the `meta` query.
#[allow(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
pub(super) async fn handle_get(
    State(state): State<FilesRouteState>,
    Path(filename): Path<String>,
    RawQuery(raw_query): RawQuery,
    client_ip: Option<Extension<ClientIp>>,
    headers: HeaderMap,
) -> Result<Response, Response> {
    // The XFF-resolved client IP (`ClientIp` extension, set app-wide by
    // `fuz_http::client_ip_middleware`) — the Rust analog of TS `get_client_ip`.
    let client_ip = ClientIp::as_str_or_unresolved(client_ip.as_ref());
    let auth = state.require_auth(&headers, client_ip).await?;
    validate_file_key(&filename)?;
    let policy = state.request_policy(&auth).await?;
    enforce_capability(
        &auth,
        policy.as_ref(),
        &FuzForgeCapability::FilesRead {
            filename: &filename,
        },
    )?;

    // scoped: the client goes back to the pool before `open`, which checks
    // out its own connection
    let cell = {
        let client = state
            .gate
            .pool
            .get()
            .await
            .map_err(|e| db_unavailable_response_with_source("files.get pool", &e))?;
        query_cell_get_by_path(&client, &file_cell_path(&filename))
            .await
            .map_err(|e| internal_error_response_with_source("files.get cell_get", &e))?
    };
    let Some(cell) = cell else {
        return Err(file_not_found());
    };
    let Some(file_data) = FileCellData::from_cell_data(&cell.data) else {
        return Err(file_not_found());
    };

    // `?meta`: metadata only — no fact-store byte fetch. Presence selects the
    // branch whatever the value (a bare `?meta` decodes to the empty string),
    // and any other key is ignored — the TS twin's rule, read here off the raw
    // query rather than through an axum `Query<T>` extractor. An extractor runs
    // before the handler body, so a duplicate `?meta` key was refused with
    // axum's own pre-auth 400 naming the field, where TS takes the first value
    // and serves the metadata; the git route's `?service=` had the same shape
    // and the same fix.
    if first_query_param(raw_query.as_deref(), "meta").is_some() {
        let uploaded_at = cell.updated_at.unwrap_or(cell.created_at);
        return Ok(Json(file_data.to_meta_output(&filename, &uploaded_at)).into_response());
    }

    // Download: serve the content-addressed bytes. Disk-backed facts stream
    // straight off disk (bounded memory, GB-scale safe); small embedded facts
    // come back as bytes. A row whose `external_url` is not its own hash's
    // address is refused by the store as `Ok(None)`, so it is the same 404 as
    // a missing fact, like the TS twin's null `get`.
    let content = state
        .fact_store
        .inner()
        .open(&file_data.blake3)
        .await
        .map_err(|e| fact_store_error_response("files.get fact_store.open", &e))?;
    let Some(content) = content else {
        return Err(file_not_found());
    };

    let disposition = format!("attachment; filename=\"{filename}\"");
    let blake3_hex = file_data.blake3_hex();
    let headers = [
        (header::CONTENT_TYPE, file_data.content_type),
        (header::CONTENT_DISPOSITION, disposition),
        (header::HeaderName::from_static("x-blake3-hash"), blake3_hex),
    ];

    match content {
        FactContent::Embedded(bytes) => Ok((StatusCode::OK, headers, bytes).into_response()),
        FactContent::Disk { path, size } => {
            let file = tokio::fs::File::open(&path)
                .await
                .map_err(|e| internal_error_response_with_source("files.get open disk fact", &e))?;
            let stream = tokio_util::io::ReaderStream::new(file);
            let body = Body::from_stream(stream);
            let mut response = (StatusCode::OK, headers, body).into_response();
            // Advertise the length so clients show progress and ForgeStorage's
            // Content-Length size guard works; the body itself streams.
            if let Ok(len) = header::HeaderValue::from_str(&size.to_string()) {
                response.headers_mut().insert(header::CONTENT_LENGTH, len);
            }
            Ok(response)
        }
    }
}

#[allow(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
pub(super) async fn handle_list(
    State(state): State<FilesRouteState>,
    client_ip: Option<Extension<ClientIp>>,
    headers: HeaderMap,
) -> Result<Response, Response> {
    // The XFF-resolved client IP (`ClientIp` extension, set app-wide by
    // `fuz_http::client_ip_middleware`) — the Rust analog of TS `get_client_ip`.
    let client_ip = ClientIp::as_str_or_unresolved(client_ip.as_ref());
    let auth = state.require_auth(&headers, client_ip).await?;
    // Scoped tokens see only entries their policy permits to read. Filter
    // rather than 403 — list is the discovery entry point CLIs use to
    // learn what they CAN read.
    let policy = state.request_policy(&auth).await?;
    // Ahead of the listing query, matching every other route's
    // refuse-before-work placement: a token with no policy row has nothing to
    // filter *by*, so it is refused outright rather than shown everything
    // — and it should not cost a full store enumeration to be told.
    enforce_surface(&auth, policy.as_ref())?;

    let client = state
        .gate
        .pool
        .get()
        .await
        .map_err(|e| db_unavailable_response_with_source("files.list pool", &e))?;

    // The whole `file` kind, unbounded: the file store treats files as
    // account-readable (not cell-visibility gated), and the store *is* the
    // namespace — a page cap would silently hide files from a client that
    // asked for the list. So this is not `query_cell_list`, whose
    // `CELL_LIST_LIMIT_MAX` page cap would truncate a large store. Only cells
    // at a path: a file is addressed by its `files/<key>` path, so a pathless
    // `file` cell is no entry, and filtering it in the SQL means the scan never
    // loads one. It reads the three columns the entry needs, `uploaded_at`
    // projected as the spine projects a cell's timestamps. Twin: the TS
    // `query_addressed_cells_by_kind` (`src/lib/server/db/fuz_forge_cell_queries.ts`).
    // TODO: unbounded — the whole `file` kind is read into memory and
    // serialized as one response, so a store of N files costs N rows and N
    // metadata objects per list call. Bounding it is a **product** change, not
    // an internal one: the store is the namespace, so a page cap would silently
    // hide files from a client that asked for the list, and paging needs a
    // cursor on the wire, in `fuzf file list`, and on both backends at once.
    // Revisit when a real store outgrows one response. Twin TODO:
    // `src/lib/server/routes/files.ts`.
    let rows = client
        .query(
            &format!(
                "SELECT path, data::text, {uploaded_at} FROM cell \
                 WHERE kind = 'file' AND path IS NOT NULL AND deleted_at IS NULL",
                uploaded_at = iso8601_timestamp_column("", "COALESCE(updated_at, created_at)"),
            ),
            &[],
        )
        .await
        .map_err(|e| internal_error_response_with_source("files.list query", &e))?;

    let mut files: Vec<FileMetaOutput> = Vec::with_capacity(rows.len());
    for row in rows {
        let path: String = row.get(0);
        let data_text: String = row.get(1);
        let uploaded_at: String = row.get(2);
        let data: serde_json::Value = serde_json::from_str(&data_text)
            .map_err(|e| internal_error_response_with_source("files.list data", &e))?;
        let Some(file_data) = FileCellData::from_cell_data(&data) else {
            continue;
        };
        let entry_filename = filename_from_cell_path(&path);
        // Scoped read-filter: hide entries the policy can't read.
        if !policy_check(
            policy.as_ref(),
            &FuzForgeCapability::FilesRead {
                filename: entry_filename,
            },
        ) {
            continue;
        }
        files.push(file_data.to_meta_output(entry_filename, &uploaded_at));
    }
    // Byte order, not locale collation — file keys are ASCII, so this is
    // identical to the TS twin's `<`/`>` compare in
    // `src/lib/server/routes/files.ts`.
    files.sort_by(|a, b| a.filename.cmp(&b.filename));

    Ok(Json(FileListOutput { files }).into_response())
}

#[allow(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
pub(super) async fn handle_delete(
    State(state): State<FilesRouteState>,
    Path(filename): Path<String>,
    RawQuery(raw_query): RawQuery,
    client_ip: Option<Extension<ClientIp>>,
    headers: HeaderMap,
) -> Result<Response, Response> {
    // Same phase order as [`handle_upload`] — query shape (400) →
    // authenticate (401) → acting actor (400) → role (403) → the handler's
    // own gates.
    let acting = parse_acting_strict_query(raw_query.as_deref())?;
    // The XFF-resolved client IP (`ClientIp` extension, set app-wide by
    // `fuz_http::client_ip_middleware`) — the Rust analog of TS `get_client_ip`.
    let client_ip = ClientIp::as_str_or_unresolved(client_ip.as_ref());
    let auth = state.require_auth(&headers, client_ip).await?;
    // The actor stamped as `deleted_by` on the cell tombstone.
    let actor_id = resolve_acting_actor(&state.gate.pool, &auth, acting).await?;
    state.require_admin_role(&auth).await?;

    validate_file_key(&filename)?;
    let policy = state.request_policy(&auth).await?;
    enforce_capability(
        &auth,
        policy.as_ref(),
        &FuzForgeCapability::FilesDelete {
            filename: &filename,
        },
    )?;

    let client = state
        .gate
        .pool
        .get()
        .await
        .map_err(|e| db_unavailable_response_with_source("files.delete pool", &e))?;
    let cell = query_cell_get_by_path(&client, &file_cell_path(&filename))
        .await
        .map_err(|e| internal_error_response_with_source("files.delete cell_get", &e))?;
    let Some(cell) = cell else {
        return Err(file_not_found());
    };

    // Soft-delete the cell; the fact is intentionally left for GC.
    query_cell_delete(&client, cell.id, Some(actor_id))
        .await
        .map_err(|e| internal_error_response_with_source("files.delete cell_delete", &e))?;

    Ok(Json(FileDeleteOutput {
        deleted: true,
        filename,
    })
    .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fact store's own failed checkout answers the flat 503, not the
    /// catch-all 500. Hard to reach end to end: the handler's own checkout from
    /// the same pool usually fails first.
    #[tokio::test]
    async fn a_fact_store_checkout_failure_answers_the_503() {
        let response = fact_store_error_response(
            "test",
            &FactError::Pool(deadpool_postgres::PoolError::Closed),
        );
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("a body");
        assert_eq!(&bytes[..], br#"{"error":"service_unavailable"}"#);

        let response = fact_store_error_response("test", &FactError::Internal("x".to_owned()));
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn validate_file_key_accepts_path_keys_and_rejects_traversal() {
        // Path-structured release keys are accepted natively (interior `/`).
        assert!(validate_file_key("latest.json").is_ok());
        assert!(
            validate_file_key("tools/zap/0.1.0/zap-0.1.0-x86_64-unknown-linux-gnu.tar.gz").is_ok()
        );
        // Traversal / malformed keys → 400 (mirrors `fuz_storage::validate_forge_key`).
        for bad in [
            "",
            "/abs",
            "trailing/",
            "a//b",
            "tools/../etc/passwd",
            "tools/./x",
            "tools/.hidden",
            "tools/zap latest.json", // space is out of charset
        ] {
            let err = validate_file_key(bad).expect_err("should reject");
            assert_eq!(
                err.status(),
                StatusCode::BAD_REQUEST,
                "key {bad:?} should be 400"
            );
        }
    }
}
