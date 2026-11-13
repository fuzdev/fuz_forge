//! File-store REST routes (`/api/fuz_forge/files/*`) — upload, download,
//! list, delete.
//!
//! Twin of the TS forge's `src/lib/server/routes/files.ts`, **cell-primary**:
//! a file is a cell + a fact and nothing else. File metadata lives in a
//! `cell` at the globally unique path `files/<filename>` with the top-level
//! `cell.kind = "file"`; bytes live in the
//! content-addressed [`crate::fact_store`]. Wire shapes + error strings mirror
//! the TS handlers so the cross-backend suites see one contract on both
//! backends.
//!
//! | Method | Path | Auth | Returns |
//! |---|---|---|---|
//! | `POST` | `/{*filename}` | admin | `{filename, blake3_hash, size_bytes, content_type, status}` |
//! | `GET` | `/` | any account | `{files: [...]}` |
//! | `GET` | `/{*filename}` | any account | raw bytes + `x-blake3-hash` |
//! | `GET` | `/{*filename}?meta` | any account | metadata (no body fetch) |
//! | `DELETE` | `/{*filename}` | admin | `{deleted, filename}` |
//!
//! Each JSON success body is a `fuz_forge_wire::output` type
//! ([`fuz_forge_wire::output::FileUploadOutput`],
//! [`fuz_forge_wire::output::FileListOutput`],
//! [`fuz_forge_wire::output::FileMetaOutput`],
//! [`fuz_forge_wire::output::FileDeleteOutput`]) rather than a `json!` literal,
//! so what this server constructs is what the `fuzf` client deserializes —
//! except the delete body, which the client discards. The download row above
//! has no body type at all: it answers with raw bytes, hash-tagged by an
//! `x-blake3-hash` header. A disk-backed fact streams off disk without being
//! re-hashed (the TS twin re-hashes and answers 404 on a mismatch), so the
//! header is what a client checks the bytes against.
//!
//! Keys are path-structured (interior `/` allowed); validation is traversal-safe
//! via [`fuz_storage::validate_forge_key`] (the single source of truth shared
//! with the `ForgeStorage` producer). The metadata endpoint is a `?meta` query
//! on the download route, not a `/meta` path suffix — axum 0.8 catch-alls are
//! terminal.
//!
//! **Per-token file authority.** Beyond the role gate, each handler resolves
//! the request's authority per-file through `enforce_capability`, matching the
//! TS handlers': `POST` requires `files.write:<filename>`, `GET` (meta /
//! download) requires `files.read:<filename>`, `DELETE` requires
//! `files.delete:<filename>`. A denied capability returns 403 `{error:
//! "forbidden", required: "files.<op>:<filename>"}` — the TS body shape. The
//! list route filters to readable entries rather than 403ing (it's the
//! discovery entry point).
//!
//! Two axes resolve there, and which one governs depends on the token: a
//! `fuz_forge_api_token_policy` row when it has one, and the spine's
//! `api_token.scope` when it does not — the latter refusing a narrowed token
//! with the flat `{error: "token_scope_required", required_scope:
//! "surface:file_store"}`. Sessions, daemon tokens, and grandfathered bearers
//! resolve to a `full` scope and keep the role-gate-only behavior. See
//! [`crate::token_surfaces`].
//!
//! **`acting` actor selector.** The mutation routes (`POST` / `DELETE`)
//! accept the spine's optional `acting` UUID query param and resolve it via
//! [`crate::route_auth::resolve_acting_actor`] — `acting` omitted uses the
//! account's sole actor (multi-actor ⇒ 400 `actor_required`); a supplied id
//! must belong to the account (foreign ⇒ 400 `actor_not_on_account`). The
//! resolved actor is stamped as `created_by` / `updated_by` / `deleted_by`
//! on the cell mutation, matching the TS routes' `query: {acting:
//! ActingActor}`.
//!
//! ## Module layout
//!
//! The concern splits by stage:
//!
//! - **this module** — the [`FilesRouteState`] + the [`files_router`] factory
//!   and the route state's auth helpers.
//! - [`handlers`] — the four HTTP handlers + their request-local helpers
//!   (strict query shapes, the per-file capability gate, key validation).
//! - [`disk_budget`] — the free-space preflight (`507 storage_full`).
//! - [`content_type`] — content-type inference + the file-store cell shape
//!   ([`content_type::FileCellData`]) and cell-path helpers.

mod content_type;
mod disk_budget;
mod handlers;

use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use fuz_auth::{AuthGate, ResolvedAuth};
use tokio::sync::Semaphore;

use crate::fact_store::FactStoreHandle;
use crate::route_auth::{require_admin_role, require_auth};
use crate::token_policy::{FuzForgeTokenPolicy, FuzForgeTokenRouteState, hydrate_policy};

/// `cell.path` prefix for file-store cells.
const FILE_PATH_PREFIX: &str = "files/";

/// State for the file-store router.
#[derive(Clone)]
pub struct FilesRouteState {
    /// The front door every file route checks a request at — the origin
    /// allowlist, then the credential walk — and the pool the handlers read.
    pub gate: AuthGate,
    pub fact_store: FactStoreHandle,
    /// Scoped-token policy hydration source — looks up the
    /// `fuz_forge_api_token_policy` row for a bearer token's `api_token_id`.
    pub token_state: Arc<FuzForgeTokenRouteState>,
    /// Upload cap (bytes) for the catch-all POST, from
    /// `env.file_store_max_bytes`. The files group mounts no body layer, so
    /// the handler is the only gate: a `Content-Length` pre-check rejects an
    /// over-cap upload before reading, and `FactStore::put_stream`'s byte
    /// counter is the mid-stream backstop for chunked / mis-declared lengths.
    pub max_upload_bytes: usize,

    /// Disk root backing the fact store (`env.fact_store_root()`), for the
    /// free-space preflight. `None` (embedded-only, no disk overflow) skips the
    /// preflight — there's no volume whose free space to probe.
    pub disk_root: Option<PathBuf>,

    /// Free-space headroom (bytes) kept beyond a declared upload — the upload is
    /// rejected with `507 storage_full` when `free < declared + margin`. The
    /// per-request cap bounds one upload; this bounds the *aggregate* so
    /// concurrent uploads can't fill the disk to zero. See
    /// [`crate::env::DEFAULT_FILE_STORE_FREE_SPACE_MARGIN_BYTES`].
    pub free_space_margin_bytes: u64,

    /// Bounds how many uploads stream to disk concurrently — a permit is held
    /// across `put_stream`, so excess uploads wait rather than racing to fill
    /// the disk (caps aggregate in-flight temp churn on top of the preflight).
    /// See [`crate::env::DEFAULT_FILE_STORE_MAX_CONCURRENT_UPLOADS`].
    pub upload_semaphore: Arc<Semaphore>,
}

impl std::fmt::Debug for FilesRouteState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FilesRouteState").finish_non_exhaustive()
    }
}

impl FilesRouteState {
    /// The `admin` role gate, taken **after** the acting actor resolves — the
    /// mutation handlers run the TS route runner's phase order (401 → the
    /// `acting` 400s → the role 403).
    #[expect(
        clippy::result_large_err,
        reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
    )]
    async fn require_admin_role(&self, auth: &ResolvedAuth) -> Result<(), Response> {
        require_admin_role(&self.gate.pool, auth).await
    }

    /// Check the request's origin, then resolve its credential.
    ///
    /// `client_ip` is the XFF-resolved address the handler extracted from its
    /// `ClientIp` extension — see [`require_auth`].
    #[expect(
        clippy::result_large_err,
        reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
    )]
    async fn require_auth(
        &self,
        headers: &HeaderMap,
        client_ip: &str,
    ) -> Result<ResolvedAuth, Response> {
        require_auth(&self.gate, headers, client_ip).await
    }

    /// Hydrate the request's scoped-token policy from the resolved auth.
    ///
    /// Returns `Ok(None)` (unscoped) for session / daemon-token auth or for a
    /// bearer token with no `fuz_forge_api_token_policy` row — those keep
    /// the role-gate-only behavior. Mirrors the TS in-handler
    /// `get_request_policy` for the `/api/*` middleware-hydrated policy.
    ///
    /// A failed pool checkout answers the spine's flat 503, as the TS
    /// `get_request_policy` rethrows the middleware's stored
    /// `DbCheckoutError`.
    #[expect(
        clippy::result_large_err,
        reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
    )]
    async fn request_policy(
        &self,
        auth: &ResolvedAuth,
    ) -> Result<Option<FuzForgeTokenPolicy>, Response> {
        hydrate_policy(self.token_state.as_ref(), auth.api_token_id())
            .await
            .map_err(|e| fuz_http::db_unavailable_response_with_source("files.policy pool", &e))
    }
}

/// Build the file-store axum router (mount under `/api/fuz_forge/files`).
///
/// Keys are path-structured: the download/upload/delete route is a **catch-all**
/// (`/{*filename}`) so multi-segment keys (`tools/<name>/<version>/...`) match
/// natively. axum 0.8 catch-alls must be terminal, so there's no
/// `/{*filename}/meta` route — metadata rides on the same catch-all GET via a
/// `?meta` query param (see [`handlers::handle_get`]).
pub fn files_router(state: FilesRouteState) -> Router {
    Router::new()
        .route("/", get(handlers::handle_list))
        .route(
            "/{*filename}",
            post(handlers::handle_upload)
                .get(handlers::handle_get)
                .delete(handlers::handle_delete),
        )
        .with_state(state)
}
