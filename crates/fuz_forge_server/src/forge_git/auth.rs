//! Forge git smart-HTTP auth chain.
//!
//! Twin of `src/lib/server/routes/repo_git_auth.ts`. The clone-URL grammar
//! gate (two `RepoSlug` segments + the `.git` suffix) runs before any of this, in
//! `forge_git/mod.rs`. [`authenticate_git_request`] is then the full gate:
//! Origin/Referer browser-context rejection → HTTP Basic → the token-shape
//! precheck → `query_validate_api_token` (the Basic password is the api-token raw value;
//! the username is ignored, per GitHub/GitLab PAT semantics) → global `admin`
//! role-grant on a live actor → `repos/<slug>` cell lookup → per-token
//! authority gate. On any refusal the caller returns the generic 401
//! ([`unauthorized_response`]) — no enumeration via distinct error shapes; a
//! database fault on the way is a 500 instead ([`refusal_response`]).
//!
//! Git smart-HTTP is one of the forge's own non-RPC surfaces
//! (`surface:git_http`), so [`check_repo_capability`] resolves both per-token
//! authority axes: the resource-bound `fuz_forge_api_token_policy` row when the
//! token has one, and the spine's `api_token.scope` when it does not. See
//! [`crate::token_surfaces`].

use std::path::PathBuf;

use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use fuz_auth::account_queries::query_account_by_id;
use fuz_auth::actor_queries::query_account_has_active_global_role;
use fuz_auth::api_token_queries::{query_validate_api_token, spawn_api_token_touch};
use fuz_auth::token_scope::TokenScope;
use fuz_auth::{ROLE_ADMIN, hash_api_token, is_api_token_shaped};

use crate::error::FuzForgeError;
use crate::token_policy::{FuzForgeTokenPolicy, policy_check};
use crate::token_surfaces::{SURFACE_GIT_HTTP, token_scope_admits_forge_surface};

use super::{ForgeRouteState, GitOp};

/// Build the generic 401 response. Locked-down posture: no enumeration
/// via body shape, matches `repo_git_auth.ts:git_unauthorized`.
pub fn unauthorized_response() -> Response {
    let mut resp = (
        StatusCode::UNAUTHORIZED,
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (
                header::WWW_AUTHENTICATE,
                "Basic realm=\"fuz_forge forge\", charset=\"UTF-8\"",
            ),
        ],
        "Unauthorized\n",
    )
        .into_response();
    *resp.status_mut() = StatusCode::UNAUTHORIZED;
    resp
}

/// The answer to a failed [`authenticate_git_request`]: the generic 401 for a
/// refusal ([`FuzForgeError::Forbidden`]), and the spine's flat
/// `500 {"error": "internal_error"}` ([`fuz_http::internal_error_response`])
/// for a fault, logged here. A failed pool checkout
/// ([`FuzForgeError::Pool`]) answers the flat 503
/// `{"error": "service_unavailable"}` instead — the TS twin's
/// `DbCheckoutError` answer.
///
/// The 500 is the TS twin's answer: its credential reads run inside the route
/// handler, so a throw reaches the route pipeline's error mapper, which
/// renders that body. A fault never reads as a 401 — a git client would
/// re-prompt for a credential that may be fine, and an outage would look like
/// a revoked token.
pub fn refusal_response(err: &FuzForgeError) -> Response {
    if matches!(err, FuzForgeError::Forbidden) {
        return unauthorized_response();
    }
    if matches!(err, FuzForgeError::Pool(_)) {
        return fuz_http::db_unavailable_response_with_source(
            "forge_git: the auth chain's pool checkout failed",
            err,
        );
    }
    fuz_http::internal_error_response_with_source("forge_git: the auth chain's read failed", err)
}

/// Per-request data extracted by [`authenticate_git_request`].
#[derive(Debug, Clone)]
pub struct GitAuthOk {
    pub account_id: uuid::Uuid,
    pub username: String,
    pub repo_id: String,
    pub repo_path: PathBuf,
    /// The credential's `api_token.scope`, carried from the validated row: the
    /// policy middleware doesn't fire on these app-root routes, so nothing else
    /// on the request holds it. Read by [`check_repo_capability`] when the token
    /// has no policy row.
    pub scope: TokenScope,
    /// The hydrated scoped-token policy. `None` for an unscoped token /
    /// session — [`check_repo_capability`] treats `None` as "all capabilities
    /// granted" (the global `admin` role gate already passed).
    pub policy: Option<FuzForgeTokenPolicy>,
}

/// Parse a `Basic <base64>` Authorization header.
///
/// Returns `None` for any shape violation. Colon-split is bounded to
/// the first occurrence so passwords may legally contain `:`.
fn parse_basic_auth(header_value: Option<&str>) -> Option<(String, String)> {
    let h = header_value?;
    let stripped = h
        .strip_prefix("Basic ")
        .or_else(|| h.strip_prefix("basic "))?;
    let trimmed = stripped.trim();
    if trimmed.is_empty() {
        return None;
    }
    let decoded = BASE64_STANDARD.decode(trimmed).ok()?;
    let s = String::from_utf8(decoded).ok()?;
    let colon = s.find(':')?;
    let (u, rest) = s.split_at(colon);
    let p = &rest[1..];
    if u.is_empty() || p.is_empty() {
        return None;
    }
    Some((u.to_owned(), p.to_owned()))
}

/// The API token a git request presents: the password of its `Basic`
/// `Authorization` header, when that password has a token's shape.
///
/// The shape check ([`is_api_token_shaped`], the spine bearer leg's precheck)
/// runs before any pool checkout, so a password that cannot be a token costs
/// no database work — git smart-HTTP is pre-auth and has no rate limiter in
/// front of it. `None` answers the same generic 401 as every other refusal.
/// Twin: the `is_api_token_shaped` check in `repo_git_auth.ts`.
fn basic_api_token(headers: &HeaderMap) -> Option<String> {
    let auth_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let (_basic_user, basic_pass) = parse_basic_auth(auth_header)?;
    is_api_token_shaped(&basic_pass).then_some(basic_pass)
}

/// Validate a clone-handle slug as a canonical `RepoSlug` (`org/repo`).
///
/// Delegates to [`fuz_forge_wire::validate_repo_slug`] so the crate carries one
/// repo-slug grammar — the same rule `fuz_forge_repo_create` applies, so git
/// auth accepts exactly what can exist on disk (and no path traversal: `..` is
/// off-charset). Case-agnostic, like the wire validator, so it runs before the
/// lookup's lowercase fold.
///
/// Defense in depth rather than the primary gate: the git routes already run
/// the same grammar pre-auth in `bare_slug_from_segments`, so no off-grammar
/// slug reaches here. Kept because this function guards the *cell lookup*,
/// which any future caller of [`authenticate_git_request`] would also need.
#[must_use]
fn is_valid_repo_slug(slug: &str) -> bool {
    fuz_forge_wire::validate_repo_slug(slug).is_ok()
}

/// Authenticate a forge HTTP request and resolve the repo cell — **op-agnostic**
/// (the `forge.push`/`pull` capability check is [`check_repo_capability`]).
///
/// Port of `repo_git_auth.ts:authenticate_git_request` (the TS twin's matching
/// op-agnostic half; its `check_repo_capability` is mirrored separately). On
/// any failure returns [`FuzForgeError::Forbidden`]; callers map that to the
/// generic 401 response (locked-down posture — no enumeration via distinct
/// error shapes).
///
/// Steps mirror the TS:
///
/// 1. Reject any request bearing `Origin` or `Referer` — git never
///    sends these, so a browser replay is a CSRF window.
/// 2. Parse Basic auth from `Authorization`, and refuse a password that is not
///    [`is_api_token_shaped`] before any database work.
/// 3. blake3-hash the password (Basic password is the api token raw
///    value), query `api_token` for a non-expired row; record the token use
///    (`last_used_at` + `last_used_ip` from `client_ip`), fire-and-forget.
/// 4. Load the account from the token. The Basic-auth username is NOT
///    validated against it (any username works with a valid token —
///    GitHub/GitLab PAT semantics); the token already identifies the account.
/// 5. Check the account has a global `admin` role grant.
/// 6. Validate the slug, look up the repo cell.
/// 7. Hydrate the scoped-token policy into [`GitAuthOk::policy`] (the
///    op-specific check is deferred to [`check_repo_capability`]).
///
/// # Errors
///
/// Returns [`FuzForgeError::Forbidden`] for any auth/authz failure, which
/// [`refusal_response`] answers with the generic 401. Any other variant is a
/// fault — a pool checkout or query that failed, or no repo storage
/// configured — and answers a 500: a credential the database could not read
/// is neither admitted nor refused.
pub async fn authenticate_git_request(
    state: &ForgeRouteState,
    slug: &str,
    headers: &HeaderMap,
    client_ip: &str,
) -> Result<GitAuthOk, FuzForgeError> {
    // (1) Browser-context replay defense.
    if headers.get(header::ORIGIN).is_some() || headers.get(header::REFERER).is_some() {
        tracing::warn!("forge: rejecting request with Origin/Referer header");
        return Err(FuzForgeError::Forbidden);
    }

    // (2) Basic auth, and (3) the password's token shape.
    let Some(raw_token) = basic_api_token(headers) else {
        return Err(FuzForgeError::Forbidden);
    };

    // (3) Hash the token and validate.
    let token_hash = hash_api_token(&raw_token);
    let client = state
        .app
        .backend
        .pool
        .get()
        .await
        .map_err(FuzForgeError::Pool)?;
    let Some(api_token) = query_validate_api_token(&client, &token_hash).await? else {
        return Err(FuzForgeError::Forbidden);
    };

    // Record the token use (last_used_at + last_used_ip), fire-and-forget via
    // the shared spine helper — mirrors the bearer resolve path and the TS git
    // auth's `query_validate_api_token` touch. Fires on a valid token regardless
    // of the later admin / capability gates (the token *was* used).
    spawn_api_token_touch(&state.app.backend.pool, &api_token.id, client_ip);

    // (4) Resolve the account (needed for the admin check + GitAuthOk). The
    // Basic-auth username is NOT validated against it: the token already
    // identifies the account, so requiring a matching username adds friction
    // (and a footgun) without security — usernames aren't secret. Matches
    // GitHub/GitLab PAT semantics: any username + a valid token authenticates.
    let Some(account) = query_account_by_id(&client, &api_token.account_id).await? else {
        return Err(FuzForgeError::Forbidden);
    };

    // (5) Global admin role check via the shared spine helper's
    // `scope_id IS NULL` global-grant query. (A join without that filter
    // would let a *scoped* admin grant confer full git push/pull.)
    //
    // Tombstone-aware, like `route_auth::require_admin_role`: the grant counts
    // only while the account **and** the granting actor are both live. This
    // path reads the grant straight off `api_token.account_id` with no
    // acting-actor resolution in front of it, so the blind
    // `query_account_has_global_role` would keep admitting a push on a grant
    // held by a soft-deleted actor — fail-open on an admission gate. Twin:
    // `repo_git_auth.ts`, which reads fuz_app's
    // `query_account_has_active_global_role`. Tighten together, never one.
    let has_admin =
        query_account_has_active_global_role(&client, &api_token.account_id, ROLE_ADMIN).await?;
    if !has_admin {
        return Err(FuzForgeError::Forbidden);
    }

    // (6) Slug check + repo cell lookup.
    if !is_valid_repo_slug(slug) {
        return Err(FuzForgeError::Forbidden);
    }
    // Repo slugs are case-insensitive (canonical lowercase): cells are stored
    // at the lowercase slug (creation folds via `validate_repo_slug`), so the
    // raw clone-URL slug is lowercased before the lookup — `MyOrg/MyRepo`
    // resolves the same cell as `myorg/myrepo`. (`is_valid_repo_slug` is
    // case-agnostic, so this runs after the gate.)
    let slug = slug.to_lowercase();
    // Repo cells live at `repos/<slug>` with the top-level `cell.kind =
    // 'repo'` — no
    // hub. The clone URL carries the slug, so match on the path (indexed,
    // unique). The cell's `id` (UUID) is the on-disk dir + wire handle.
    let cell_row = client
        .query_opt(
            "SELECT c.id FROM cell c \
             WHERE c.path = $1 AND c.kind = 'repo' AND c.deleted_at IS NULL \
             LIMIT 1",
            &[&format!("repos/{slug}")],
        )
        .await?;
    let Some(cell_row) = cell_row else {
        return Err(FuzForgeError::Forbidden);
    };
    // On-disk repo dir + CGI PATH_INFO are keyed on the cell-id UUID.
    let cell_id: uuid::Uuid = cell_row.get(0);
    let repo_id = cell_id.to_string();

    // (7) Read the scoped-token policy. The op-specific capability check is
    // [`check_repo_capability`], which the route handler calls AFTER it
    // validates the `service` param — mirroring the TS `authenticate_git_request`
    // (op-agnostic) + `check_repo_capability` (op-specific) split, so an
    // unauthenticated request to `info/refs?service=bogus` gets 401 (auth) not
    // 400 (service). Drop the pool client before the token-state lookup (it
    // acquires its own).
    //
    // A failed read is a fault, not "no policy": the file store's
    // `hydrate_policy` falls through unscoped on a query error, but here the TS twin's
    // `query_token_policy_by_id` throws to its route pipeline's 500 (503 for a
    // failed checkout), so this side answers the same.
    drop(client);
    let policy: Option<FuzForgeTokenPolicy> = state
        .app
        .fuz_forge_token_state
        .lookup(&api_token.id)
        .await?;

    // Resolve the on-disk repo path. `repo_path` on the app is the
    // store root; the slug-derived id lands at `<root>/<id>.git`.
    let repo_root = state
        .app
        .repo_path
        .as_ref()
        .ok_or_else(|| FuzForgeError::Internal("repo storage not configured".into()))?;
    let repo_path = crate::repo_storage::repo_dir(repo_root, cell_id);

    Ok(GitAuthOk {
        account_id: api_token.account_id,
        username: account.username,
        repo_id,
        repo_path,
        scope: api_token.scope,
        policy,
    })
}

/// Op-specific per-token authority check, split out of
/// [`authenticate_git_request`] to mirror the TS `check_repo_capability`.
///
/// Resolves both axes, the same rule the file store applies through its
/// `enforce_capability`: a token **with** a `fuz_forge_api_token_policy` row is
/// governed by it, and a token **without** one falls through to its spine
/// scope, where a narrowed token is refused. The second half is what refuses a
/// token minted through the spine's own `account_token_create` — narrowed
/// scope, no policy row, and `policy_check(None, …)` alone would have admitted
/// it. See [`crate::token_surfaces`].
///
/// The caller answers a denial with the same generic 401 as every other
/// failure on this route, so the two axes are distinguished only in the log.
#[must_use]
pub(super) fn check_repo_capability(auth: &GitAuthOk, op: GitOp) -> bool {
    if !token_scope_admits_forge_surface(auth.policy.as_ref(), &auth.scope) {
        tracing::warn!(
            account_id = %auth.account_id,
            surface = SURFACE_GIT_HTTP.as_str(),
            "forge_git: token scope denied",
        );
        return false;
    }
    policy_check(auth.policy.as_ref(), &op.capability(&auth.repo_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parity::parity_rows;

    const REPO_SLUG_FIXTURE: &str =
        include_str!("../../../../src/test/fixtures/parity/repo_slug.json");

    /// The pre-auth slug gate, asserted against
    /// `src/test/fixtures/parity/repo_slug.json` — the same rows the TS
    /// `RepoSlug` schema and the create handler's `validate_repo_slug` read, so
    /// a URL this gate admits is a slug the create path could have produced.
    #[test]
    fn validates_two_segment_repo_slug() {
        for row in parity_rows(REPO_SLUG_FIXTURE, "slugs") {
            let input = row["input"].as_str().expect("an input");
            let accepted = row["accepted"].as_bool().expect("a bool");
            assert_eq!(is_valid_repo_slug(input), accepted, "{input:?}");
        }
    }

    /// `Authorization: Basic` over `user:password`.
    fn basic_headers(password: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        let encoded = BASE64_STANDARD.encode(format!("git:{password}"));
        headers.insert(
            header::AUTHORIZATION,
            format!("Basic {encoded}").parse().expect("a header value"),
        );
        headers
    }

    #[test]
    fn only_a_token_shaped_password_reaches_the_lookup() {
        let token = fuz_auth::api_token::generate_api_token().token;
        assert_eq!(
            basic_api_token(&basic_headers(&token)).as_deref(),
            Some(token.as_str())
        );
        let truncated = &token[..token.len() - 1];
        for junk in [
            "hunter2",
            truncated,
            "secret_fuz_token_",
            &format!("{token}x"),
        ] {
            assert_eq!(basic_api_token(&basic_headers(junk)), None, "{junk:?}");
        }
        assert_eq!(basic_api_token(&HeaderMap::new()), None);
    }

    #[test]
    fn is_valid_repo_slug_is_case_agnostic() {
        // Repo slugs are case-insensitive (canonical lowercase): the validity
        // gate accepts mixed-case input identically to its lowercase form, so
        // lowercasing the slug AFTER the gate (for the cell-path lookup) is
        // safe — the lookup key folds `MyOrg/MyRepo` to `myorg/myrepo`.
        assert!(is_valid_repo_slug("MyOrg/MyRepo"));
        assert_eq!(
            is_valid_repo_slug("MyOrg/MyRepo"),
            is_valid_repo_slug("myorg/myrepo"),
        );
        assert_eq!("MyOrg/MyRepo".to_lowercase(), "myorg/myrepo");
    }
}
