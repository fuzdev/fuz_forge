//! Shared session/bearer auth gating for fuz_forge's hand-mounted REST
//! routes (the file store and `GET /api/server/status`).
//!
//! The spine's `account_router` / RPC dispatch resolve auth internally, and the
//! db-admin browser is the spine's `fuz_db_admin` router, gated by the role and
//! credential gate this crate configures at its mount; the two families above
//! are hand-mounted axum routes, so they enter the spine's front door here:
//! [`fuz_auth::AuthGate::preflight`] (the origin check, then the credential
//! walk — daemon-token → cookie → bearer) plus a role gate. The error bodies
//! match the TS spine's flat REST shape
//! (`{ "error": <code> }`) so the cross-backend round-trip + data-exposure
//! suites see one wire shape on both backends.

use axum::http::HeaderMap;
use axum::response::Response;
use deadpool_postgres::Pool;
use fuz_auth::{AuthGate, ROLE_ADMIN, ResolvedAuth};
use fuz_http::{db_unavailable_response_with_source, internal_error_response_with_source};
use uuid::Uuid;

/// 401 `{ "error": "authentication_required" }` — the spine's
/// `ERROR_AUTHENTICATION_REQUIRED` (derived `ApiError` schema), built by the
/// shared [`fuz_http::authentication_required_response`] alongside its 403 and
/// 500 siblings, so all three of this family's denials come from one place
/// rather than one of them being hand-assembled to the same bytes.
fn auth_required() -> Response {
    fuz_http::authentication_required_response()
}

/// 403 `{ "error": "insufficient_permissions", "required_roles": ["admin"] }`
/// — the spine's `PermissionError` shape, built by the shared
/// [`fuz_http::insufficient_permissions_response`] so this route family, the
/// spine's own role gates (`fuz_db_admin`, the audit-stream SSE, the WS
/// upgrade), and the TS `require_role` 403 all emit one body.
fn insufficient_permissions() -> Response {
    fuz_http::insufficient_permissions_response(&[ROLE_ADMIN])
}

/// Require the `admin` role on an already-resolved credential, at **account
/// grain** — the credential resolves an account (not an actor), so this admits
/// the request when *any* active actor on the account holds the global `admin`
/// role.
///
/// Separate from [`require_auth`] rather than fused with it because the TS
/// route runner orders the authorization phases `pre-authorization (401) →
/// acting-actor resolution (400) → post-authorization role gate (403)`: a
/// route carrying an `acting` selector must resolve the actor between the two,
/// or it answers 403 where TS answers 400 (see the per-file capability gate in
/// [`crate::files`]).
///
/// The tombstone-aware role query is the one that matches TS, where the grant
/// read hangs off a resolved acting actor and a soft-deleted actor never
/// resolves; the tombstone-blind sibling (`query_account_has_global_role`)
/// exists for the keeper removability guard, where over-reporting is the
/// fail-safe direction — here it would be fail-open.
///
/// Applies **no** token-scope gate, and that is a decision rather than an
/// omission: the forge's own two surfaces need the `fuz_forge_api_token_policy`
/// row to know which authority axis governs (see [`crate::token_surfaces`]), so
/// they gate where that row is read.
///
/// ## Multi-actor posture (deferred — security + UX consequential)
///
/// This gate never consults the `?acting=` actor, so it is account-grain by
/// construction. Under the current single-actor-per-account model that is
/// exactly equivalent to a per-actor check. Once accounts can hold multiple
/// actors with **distinct** privilege, account-grain admission means a
/// *non-admin* persona inherits admin here from an admin sibling on the same
/// account — and the per-mutation file routes then stamp the write with
/// whichever actor `resolve_acting_actor` picks, so the audit trail can record
/// a non-admin actor performing an admin-gated op. Whether to keep this coarse
/// posture or gate per-*resolved*-actor (like the fact-serving `resolve_admin`
/// and the spine's RPC admin gate, both of which check the acting actor's own
/// grants) is deferred to the multi-actor product design. Revisit — and treat
/// as a privilege-confusion review point — before real multi-actor accounts
/// ship.
///
/// # Errors
///
/// Returns the 403 denial `Response` (`Err`) when no actor on the account is
/// an admin, or a logged 500 on a DB failure.
#[allow(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
pub(crate) async fn require_admin_role(pool: &Pool, auth: &ResolvedAuth) -> Result<(), Response> {
    let client = pool
        .get()
        .await
        .map_err(|e| db_unavailable_response_with_source("require_admin_role pool", &e))?;
    let is_admin = fuz_auth::actor_queries::query_account_has_active_global_role(
        &client,
        &auth.account.id,
        ROLE_ADMIN,
    )
    .await
    .map_err(|e| internal_error_response_with_source("require_admin_role role check", &e))?;
    if is_admin {
        Ok(())
    } else {
        Err(insufficient_permissions())
    }
}

/// Check the request's origin, then resolve its auth, requiring only a valid
/// account (any role).
///
/// The origin check comes first — a page from a foreign origin is `403
/// forbidden_origin` before any credential is read — and is the in-handler
/// half of the belt the stack's origin layer also wears, so a route of this
/// family stays refused to a foreign page wherever it is mounted.
///
/// Applies no token-scope gate; see [`require_admin_role`] for why. Callers
/// needing the `admin` role follow this with [`require_admin_role`].
///
/// Returns the resolved auth on success, a 401 `Response` when no credential
/// resolves, or the spine's plain-text 500 when a credential read fails.
/// Every hand-mounted route family enters here: the
/// read-only file routes (`account: required, actor: none`), the file
/// mutation routes (which follow it with [`require_admin_role`]), and
/// `GET /api/server/status`, a spine route shape fuz_app ships ungated. The
/// db-admin browser never enters here: it is the spine's `fuz_db_admin` router,
/// configured at its mount with the role and credential gate the spine enforces.
///
/// `client_ip` is the caller's XFF-resolved address, threaded from each
/// handler's `ClientIp` extension — the shape the spine's own
/// `fuz_db_admin::require_role` takes. The composed router mounts
/// `client_ip_middleware` unconditionally — for any `FUZ_FORGE_TRUSTED_PROXIES`
/// value, the explicit empty opt-out included — so only a bare test router that
/// skips the layer reaches here with the unresolved sentinel.
///
/// # Errors
///
/// Returns the 403 origin refusal `Response` (`Err`) for a disallowed
/// `Origin`, the 401 denial when auth is absent, or the spine's
/// `fuz_auth::CredentialReadFault` 500 when a credential read fails.
#[allow(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
pub(crate) async fn require_auth(
    gate: &AuthGate,
    headers: &HeaderMap,
    client_ip: &str,
) -> Result<ResolvedAuth, Response> {
    // the bearer leg records `client_ip` as `api_token.last_used_ip`
    gate.preflight(headers, client_ip)
        .await?
        .ok_or_else(auth_required)
}

/// Resolve the acting actor for an authenticated, actor-required request.
///
/// The file mutation routes declare `auth.actor = 'required'`, so this runs
/// the spine's authorization phase — [`fuz_auth::route_helpers::require_acting_actor`],
/// which owns the resolution rules and the three denial bodies (400
/// `actor_required` with the available list, opaque 400
/// `actor_not_on_account`, 500 `no_actors_on_account`). This route family used
/// to spell that match itself, as three other surfaces did; they now share one
/// body, so a wire-shape change lands everywhere at once.
///
/// The returned [`Uuid`] is the actor stamped on the mutation
/// (`created_by` / `updated_by` / `deleted_by`).
///
/// # Errors
///
/// Returns a denial `Response` (`Err`) for each non-resolving outcome, or a
/// logged 500 on a pool / DB failure.
#[allow(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
pub(crate) async fn resolve_acting_actor(
    pool: &Pool,
    auth: &ResolvedAuth,
    acting: Option<Uuid>,
) -> Result<Uuid, Response> {
    let client = pool
        .get()
        .await
        .map_err(|e| db_unavailable_response_with_source("acting pool", &e))?;
    let actor =
        fuz_auth::route_helpers::require_acting_actor(&client, &auth.account.id, acting, "forge")
            .await?;
    Ok(actor.id)
}

#[cfg(test)]
mod tests {
    //! [`require_auth`]'s order: the origin check before the credential walk.
    //!
    //! In the composed router the stack's origin layer refuses a foreign page
    //! first, so the in-handler half of the belt is pinned here, over a gate
    //! alone — a `require_auth` that skipped `check_origin` would pass every
    //! cross case behind the stack.

    use std::sync::Arc;

    use axum::http::{HeaderMap, HeaderValue, StatusCode, header};

    use super::require_auth;

    /// A gate over a pool that never connects — `create_pool` only parses the
    /// URL, so a request the origin check refuses never reaches it.
    fn gate() -> fuz_auth::AuthGate {
        fuz_auth::AuthGate {
            pool: fuz_db::create_pool(
                "postgres://route_auth@127.0.0.1:1/none",
                &fuz_db::PoolOptions::default(),
            )
            .expect("a lazy pool"),
            keyring: Arc::new(
                fuz_auth::Keyring::new(&"k".repeat(fuz_auth::keyring::MIN_KEY_LENGTH))
                    .expect("a keyring"),
            ),
            daemon_token_state: None,
            session_cookie_name: crate::router::FUZ_FORGE_SESSION_COOKIE_NAME,
            allowed_origins: fuz_http::AllowedOrigins::parse("http://localhost:*")
                .expect("an allowlist"),
        }
    }

    async fn status_and_body(headers: &HeaderMap) -> (StatusCode, serde_json::Value) {
        let response = require_auth(&gate(), headers, fuz_http::UNRESOLVED_CLIENT_IP)
            .await
            .expect_err("no credential resolves here");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("a body");
        (status, serde_json::from_slice(&bytes).expect("a JSON body"))
    }

    #[tokio::test]
    async fn a_foreign_origin_is_refused_before_the_credential_walk() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://evil.invalid"),
        );
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer secret_fuz_token_unused"),
        );
        let (status, body) = status_and_body(&headers).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body, serde_json::json!({"error": "forbidden_origin"}));
    }

    #[tokio::test]
    async fn an_allowed_or_absent_origin_reaches_the_credential_walk() {
        let mut allowed = HeaderMap::new();
        allowed.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:5173"),
        );
        for headers in [HeaderMap::new(), allowed] {
            let (status, body) = status_and_body(&headers).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert_eq!(
                body,
                serde_json::json!({"error": "authentication_required"})
            );
        }
    }

    /// The shared checkout-failure mapping answers the spine's flat 503, the
    /// TS twin's `DbCheckoutError` answer — every REST handler's pool checkout
    /// maps through it.
    #[tokio::test]
    async fn a_failed_checkout_answers_the_flat_503() {
        let response = fuz_http::db_unavailable_response_with_source(
            "test",
            &deadpool_postgres::PoolError::Closed,
        );
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/json")
        );
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("a body");
        assert_eq!(&bytes[..], br#"{"error":"service_unavailable"}"#);
    }
}
