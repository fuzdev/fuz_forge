//! Loopback-only internal callback routes the git hooks call back into.
//!
//! Rust port of `src/lib/server/routes/repo_internal.ts`. Two routes, both
//! gated to same-host callers (raw-TCP-loopback peer + no `Origin`/`Referer`)
//! and a per-repo shared secret (`X-FuzForge-Repo-Secret`, whose BLAKE3 digest
//! is constant-time compared against the repo cell's `hook_secret_hash`):
//!
//! - `GET  /internal/repo-config/{id}` — the `pre-receive` hook reads the
//!   repo's `default_branch` (to enforce force-push protection).
//! - `POST /internal/repo-receive-callback` — the `post-receive` hook reports
//!   ref updates; the handler folds them into the repo cell (`head_sha` +
//!   `last_pushed_*`) and broadcasts `fuz_forge_repo_updated`.
//!
//! The loopback peer check is defense-in-depth: a reverse proxy on the same
//! host would make every peer loopback, so the per-repo secret is the real
//! guard. Every *rejection* returns a bare `401` with no detail — no schema or
//! existence enumeration — except a callback `POST` whose `Content-Type` isn't
//! `application/json`, refused first with the spine's flat
//! [`fuz_http::unsupported_content_type_response`] (`415`), as the TS twin's
//! route pipeline refuses every non-`raw_body` `POST` ahead of the handler; it
//! names no repo and reads no body. An unexpected internal failure (the cell
//! lookup or write) instead returns the spine's canonical flat-REST
//! [`fuz_http::internal_error_response`] — `500 {"error": "internal_error"}`,
//! the same body the TS twin's route-spec error mapper produces for a thrown
//! `Error` (`http/route_spec.ts`); a failed pool checkout returns the flat
//! `503 {"error": "service_unavailable"}` ([`fuz_http::db_unavailable_response`]),
//! the twin's answer to a `DbCheckoutError`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

use axum::Router;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use fuz_db::Pool;
use fuz_http::{
    db_unavailable_response, internal_error_response, internal_error_response_with_source,
};
use fuz_realtime::ConnectionRegistry;
use fuz_sys::rfc3339_now;
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::broadcasts::{FuzForgeRepoUpdatedParams, broadcast_repo_updated};
use crate::forge_git::parse::is_full_sha;
use crate::handlers::{PushFacts, REPO_PATH_PREFIX, RepoCellData, hash_hook_secret};

/// The all-zero object id git sends for a created/deleted ref.
const ZERO_SHA: &str = "0000000000000000000000000000000000000000";

/// Per-repo shared-secret header the hooks send.
const REPO_SECRET_HEADER: &str = "x-fuzforge-repo-secret";

/// State for the internal callback routes.
#[derive(Debug, Clone)]
pub struct InternalRouteState {
    pub pool: Pool,
    pub realtime: Arc<ConnectionRegistry>,
}

/// Build the `/internal/*` callback router (mount via `.nest("/internal", …)`).
pub fn internal_router(state: InternalRouteState) -> Router {
    Router::new()
        .route("/repo-config/{id}", get(handle_repo_config))
        .route("/repo-receive-callback", post(handle_repo_receive_callback))
        .with_state(state)
}

/// `401 Unauthorized` with a bare plain-text body — no enumeration.
fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "Unauthorized\n").into_response()
}

/// Body-free phase-1 gate: loopback peer, no browser-context headers, and a
/// secret header present (its value is verified later against the cell).
fn pre_auth_ok(peer: SocketAddr, headers: &HeaderMap) -> bool {
    // Exact loopback set, matching the TS `LOOPBACK_IPS`
    // (`{127.0.0.1, ::1, ::ffff:127.0.0.1}`) — NOT the whole `127.0.0.0/8` that
    // `Ipv4Addr::is_loopback()` admits. `to_canonical()` folds an IPv4-mapped
    // peer (`::ffff:127.0.0.1`, how a dual-stack bind sees IPv4 hook clients)
    // to `127.0.0.1`, so the two literals below cover all three TS entries and
    // reject `127.0.0.2`/`127.1.2.3` like TS does.
    let canonical = peer.ip().to_canonical();
    if canonical != IpAddr::V4(Ipv4Addr::LOCALHOST) && canonical != IpAddr::V6(Ipv6Addr::LOCALHOST)
    {
        return false;
    }
    if headers.contains_key(header::ORIGIN) || headers.contains_key(header::REFERER) {
        return false;
    }
    headers.contains_key(REPO_SECRET_HEADER)
}

/// Constant-time string comparison (length-independent short-circuit only).
fn ct_eq(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

/// A repo cell resolved and secret-verified for an internal callback: the
/// cell id, its raw `data` (the update base, so keys outside
/// [`RepoCellData`] survive a write-back), and the typed narrow.
struct VerifiedRepoCell {
    id: Uuid,
    raw: Value,
    cell: RepoCellData,
}

/// Look up a repo cell by id, narrow its `data` through the crate's single
/// cell shape ([`RepoCellData`]), and constant-time-compare the provided
/// secret's [`hash_hook_secret`] digest against the narrowed
/// `hook_secret_hash`. `Ok(None)` (→ 401) for a bad uuid, a missing cell, a
/// cell that is not `kind = 'repo'` at a `repos/<slug>` path, malformed data,
/// or a mismatch; `Err` is the 503 for a failed pool checkout, the 500 for a
/// failed query.
///
/// Narrowing before the compare is what makes a partial cell behave like a
/// missing one: the TS twin resolves the cell through `narrow_repo_cell_data`
/// (`plan_repo.ts`), which requires `slug` + `name` + `default_branch` +
/// `hook_secret_hash` and returns `null` — a 401 — when any is absent. Reading
/// `hook_secret_hash` off the raw JSON instead would have admitted a cell with no
/// `default_branch`, which the callbacks then have to invent.
///
/// The id gate is the shared wire grammar (`is_valid_repo_id`, the `RepoId`
/// twin) rather than bare `Uuid::parse_str`, which would also accept the
/// non-hyphenated/braced/URN spellings of a real id that the TS twin
/// (`repo_internal.ts`) 401s — the hooks always send the canonical form.
#[expect(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
async fn verify_repo_secret(
    pool: &Pool,
    id_str: &str,
    provided_secret: &str,
) -> Result<Option<VerifiedRepoCell>, Response> {
    if !fuz_forge_wire::is_valid_repo_id(id_str) {
        return Ok(None);
    }
    let Ok(id) = Uuid::parse_str(id_str) else {
        return Ok(None);
    };
    let client = pool.get().await.map_err(|e| {
        tracing::error!(error = ?e, "internal_routes: the repo cell lookup's pool checkout failed");
        db_unavailable_response()
    })?;
    // Only a cell the forge serves as a repo: `kind = 'repo'` at a
    // `repos/<slug>` path, the address git auth resolves, so a hook exists for
    // it. The cell layer stores any `data` a caller sends, so `data` that
    // narrows proves nothing about who made the cell; `path` writes are
    // admin-only, and the create authorizer keeps the `repo` kind admin-only
    // (`crate::cell_create_authorize`). Twin: `lookup_push_target_cell`.
    let row = client
        .query_opt(
            "SELECT data::text FROM cell \
             WHERE id = $1 AND kind = 'repo' AND starts_with(path, $2) \
               AND deleted_at IS NULL",
            &[&id, &REPO_PATH_PREFIX],
        )
        .await
        // A fault is not a refusal: the TS twin's lookup throws to its route
        // pipeline's error mapper, which renders the same 500 body, so the hook
        // sees a 500 there and here rather than a 401 that reads as a wrong
        // secret.
        .map_err(|e| internal_error_response_with_source("internal_routes repo cell lookup", &e))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let data_text: String = row.get(0);
    let Ok(raw) = serde_json::from_str::<Value>(&data_text) else {
        return Ok(None);
    };
    // Borrowed deserialize — no `raw.clone()` just to hand serde an owned value.
    let Ok(cell) = RepoCellData::deserialize(&raw) else {
        return Ok(None);
    };
    if !ct_eq(&cell.hook_secret_hash, &hash_hook_secret(provided_secret)) {
        return Ok(None);
    }
    Ok(Some(VerifiedRepoCell { id, raw, cell }))
}

/// Read the `X-FuzForge-Repo-Secret` header as a `&str`, or `None`. An empty
/// value is `None`, like an absent one — the TS twin's falsy check — so a cell
/// whose digest is that of the empty string never admits an empty header.
fn secret_header(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(REPO_SECRET_HEADER)?
        .to_str()
        .ok()
        .filter(|s| !s.is_empty())
}

/// `GET /internal/repo-config/{id}` — return the repo's `default_branch`.
async fn handle_repo_config(
    State(state): State<InternalRouteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !pre_auth_ok(peer, &headers) {
        return unauthorized();
    }
    let Some(secret) = secret_header(&headers) else {
        return unauthorized();
    };
    let verified = match verify_repo_secret(&state.pool, &id, secret).await {
        Ok(Some(verified)) => verified,
        Ok(None) => return unauthorized(),
        Err(fault) => return fault,
    };
    // `default_branch` is a required field of the narrow, so there is nothing
    // to fall back to — a cell without one never gets past `verify_repo_secret`.
    Json(json!({ "default_branch": verified.cell.default_branch })).into_response()
}

/// A required-but-nullable wire field: the key must be present, its value may
/// be `null`. The twin of the TS `nullable`, which — unlike `optional` —
/// does not admit an absent key. A bare `Option<T>` field can't express this:
/// serde's derive fills a missing `Option` field with `None`, so the key would
/// silently become optional on the Rust side alone. (Nor can
/// `#[serde(transparent)]` be used here: it forwards to `Option`'s
/// `deserialize_option`, which serde's missing-field deserializer answers with
/// `None`. The plain newtype derive asks for `deserialize_newtype_struct`,
/// which a missing field cannot supply.)
#[derive(Debug, Deserialize)]
struct RequiredNullable<T>(Option<T>);

/// Twin of the TS `RepoReceiveCallbackBody` schema (`repo_internal.ts`).
///
/// `deny_unknown_fields` is the strict-`object` half: an extra key is a
/// parse failure, which the handler answers with the same bare 401 as every
/// other rejection. [`RefUpdate::new`] is held to the full-sha grammar after
/// the parse ([`updates_are_valid`]). `pushed_by` / `push_username` are
/// [`RequiredNullable`] rather than `Option` because the TS schema spells
/// them `nullable(string)` — the hooks always send both keys, `null` when the push
/// carried no endpoint context.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoReceiveCallbackBody {
    repo_id: String,
    updates: Vec<RefUpdate>,
    pushed_by: RequiredNullable<String>,
    push_username: RequiredNullable<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RefUpdate {
    #[expect(dead_code, reason = "wire field; only `new`/`ref` drive cell state")]
    old: String,
    /// The ref's new object id: a full 40-hex sha, or the all-zero id for a
    /// deleted ref. It becomes the cell's `head_sha` on a default-branch
    /// update, which the read RPCs then hand to git.
    new: String,
    #[serde(rename = "ref")]
    ref_: String,
}

/// Whether every update's `new` is a full lowercase sha ([`is_full_sha`], which
/// [`ZERO_SHA`] satisfies). Twin of the `new` `check` on the TS
/// `RepoReceiveCallbackBody`; a body failing it is the same bare 401 as a
/// schema failure.
fn updates_are_valid(body: &RepoReceiveCallbackBody) -> bool {
    body.updates.iter().all(|u| is_full_sha(&u.new))
}

/// `POST /internal/repo-receive-callback` — fold ref updates into the repo
/// cell and broadcast. Body validation happens *after* the loopback gate so a
/// malformed body from a non-loopback caller still looks like a bare `401`.
async fn handle_repo_receive_callback(
    State(state): State<InternalRouteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if !fuz_http::is_json_content_type(&headers) {
        return fuz_http::unsupported_content_type_response();
    }
    if !pre_auth_ok(peer, &headers) {
        return unauthorized();
    }
    let Some(secret) = secret_header(&headers) else {
        return unauthorized();
    };
    let Ok(parsed) = serde_json::from_slice::<RepoReceiveCallbackBody>(&body) else {
        return unauthorized();
    };
    if !updates_are_valid(&parsed) {
        return unauthorized();
    }
    let verified = match verify_repo_secret(&state.pool, &parsed.repo_id, secret).await {
        Ok(Some(verified)) => verified,
        Ok(None) => return unauthorized(),
        Err(fault) => return fault,
    };

    let now_iso = rfc3339_now();
    let (next, head_sha) = compute_next_cell_data(&verified, &parsed, &now_iso);

    let Ok(data_text) = serde_json::to_string(&next) else {
        return internal_error_response();
    };
    let client = match state.pool.get().await {
        Ok(client) => client,
        Err(e) => {
            tracing::error!(error = ?e, "internal_routes: pool checkout failed");
            return db_unavailable_response();
        }
    };
    if client
        .execute(
            "UPDATE cell SET data = $1::text::jsonb, updated_at = NOW() \
             WHERE id = $2 AND deleted_at IS NULL",
            &[&data_text, &verified.id],
        )
        .await
        .is_err()
    {
        return internal_error_response();
    }

    broadcast_repo_updated(
        &state.realtime,
        FuzForgeRepoUpdatedParams {
            repo_id: parsed.repo_id,
            head_sha,
            last_pushed_at: Some(now_iso),
            last_pushed_by: parsed.pushed_by.0,
        },
    );
    Json(json!({ "ok": true })).into_response()
}

/// Fold ref updates into the repo cell's `data`. An update to
/// `refs/heads/<default_branch>` sets `head_sha` (or clears it on a delete /
/// zero-sha); other refs leave the prior `head_sha` intact. `last_pushed_*` is
/// always refreshed. Returns the next `data` and the resolved `head_sha`.
fn compute_next_cell_data(
    verified: &VerifiedRepoCell,
    body: &RepoReceiveCallbackBody,
    now_iso: &str,
) -> (Value, Option<String>) {
    let default_ref = format!("refs/heads/{}", verified.cell.default_branch);

    let mut head_sha = verified.cell.push.head_sha.clone();
    for update in &body.updates {
        if update.ref_ == default_ref {
            head_sha = if update.new == ZERO_SHA {
                None
            } else {
                Some(update.new.clone())
            };
        }
    }

    let mut next = verified.raw.clone();
    if let Value::Object(map) = &mut next {
        PushFacts {
            head_sha: head_sha.clone(),
            last_pushed_at: Some(now_iso.to_owned()),
            last_pushed_by: body.pushed_by.0.clone(),
            last_push_username: body.push_username.0.clone(),
        }
        .write_into(map);
    }
    (next, head_sha)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A verified cell built from a raw `data` object — the tests exercise
    /// [`compute_next_cell_data`] through the same typed narrow the handler
    /// uses, so a fixture missing a required field fails here too.
    fn verified(data: Value) -> VerifiedRepoCell {
        let cell: RepoCellData =
            serde_json::from_value(data.clone()).expect("test cell must narrow");
        VerifiedRepoCell {
            id: Uuid::nil(),
            raw: data,
            cell,
        }
    }

    /// A minimally-complete repo cell `data` — the four fields the narrow
    /// requires — plus whatever the case overrides.
    fn cell_data(default_branch: &str, head_sha: &Value) -> Value {
        json!({
            "slug": "org/repo",
            "name": "repo",
            "default_branch": default_branch,
            "hook_secret_hash": hash_hook_secret("s3cr3t"),
            "head_sha": head_sha,
        })
    }

    fn body(updates: Vec<(&str, &str, &str)>) -> RepoReceiveCallbackBody {
        RepoReceiveCallbackBody {
            repo_id: "r".into(),
            updates: updates
                .into_iter()
                .map(|(old, new, ref_)| RefUpdate {
                    old: old.into(),
                    new: new.into(),
                    ref_: ref_.into(),
                })
                .collect(),
            pushed_by: RequiredNullable(Some("acct".into())),
            push_username: RequiredNullable(Some("user".into())),
        }
    }

    fn secret_headers() -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(REPO_SECRET_HEADER, "s".parse().unwrap());
        h
    }

    fn peer(s: &str) -> SocketAddr {
        SocketAddr::new(s.parse().unwrap(), 4041)
    }

    #[test]
    fn pre_auth_ok_admits_only_exact_loopback_set() {
        // Exact set matching the TS `LOOPBACK_IPS` {127.0.0.1, ::1,
        // ::ffff:127.0.0.1}; the rest of `127.0.0.0/8` is rejected (TS rejects
        // it too — `Ipv4Addr::is_loopback`'s /8 breadth was the divergence).
        let headers = secret_headers();
        assert!(pre_auth_ok(peer("127.0.0.1"), &headers));
        assert!(pre_auth_ok(peer("::1"), &headers));
        assert!(pre_auth_ok(peer("::ffff:127.0.0.1"), &headers)); // IPv4-mapped
        assert!(!pre_auth_ok(peer("127.0.0.2"), &headers)); // in /8, not the set
        assert!(!pre_auth_ok(peer("127.1.2.3"), &headers));
        assert!(!pre_auth_ok(peer("10.0.0.1"), &headers));
        assert!(!pre_auth_ok(peer("1.2.3.4"), &headers));
    }

    #[test]
    fn pre_auth_ok_rejects_browser_headers_and_missing_secret() {
        // A non-loopback peer can't fake loopback via X-Forwarded-For — the
        // gate reads the real TCP peer, never a header.
        let mut xff = secret_headers();
        xff.insert("x-forwarded-for", "127.0.0.1".parse().unwrap());
        assert!(!pre_auth_ok(peer("1.2.3.4"), &xff));
        // Origin/Referer (browser context) → reject even from loopback.
        let mut with_origin = secret_headers();
        with_origin.insert(header::ORIGIN, "http://x".parse().unwrap());
        assert!(!pre_auth_ok(peer("127.0.0.1"), &with_origin));
        // Missing secret header → reject.
        assert!(!pre_auth_ok(peer("127.0.0.1"), &HeaderMap::new()));
    }

    #[test]
    fn secret_header_reads_an_empty_value_as_absent() {
        assert_eq!(secret_header(&secret_headers()), Some("s"));
        assert_eq!(secret_header(&HeaderMap::new()), None);
        let mut empty = HeaderMap::new();
        empty.insert(REPO_SECRET_HEADER, "".parse().unwrap());
        assert_eq!(secret_header(&empty), None);
    }

    #[test]
    fn default_branch_push_sets_head() {
        let v = verified(cell_data("main", &Value::Null));
        let b = body(vec![("0".repeat(40).as_str(), "abc123", "refs/heads/main")]);
        let (next, head) = compute_next_cell_data(&v, &b, "2026-01-01T00:00:00Z");
        assert_eq!(head.as_deref(), Some("abc123"));
        assert_eq!(next["head_sha"], "abc123");
        assert_eq!(next["last_pushed_by"], "acct");
    }

    #[test]
    fn non_default_branch_preserves_head() {
        let v = verified(cell_data("main", &Value::String("keep".into())));
        let b = body(vec![("x", "y", "refs/heads/feature")]);
        let (next, head) = compute_next_cell_data(&v, &b, "2026-01-01T00:00:00Z");
        assert_eq!(head.as_deref(), Some("keep"));
        assert_eq!(next["head_sha"], "keep");
    }

    #[test]
    fn default_branch_delete_clears_head() {
        let v = verified(cell_data("main", &Value::String("old".into())));
        let b = body(vec![("old", ZERO_SHA, "refs/heads/main")]);
        let (next, head) = compute_next_cell_data(&v, &b, "2026-01-01T00:00:00Z");
        assert!(head.is_none());
        assert_eq!(next["head_sha"], Value::Null);
    }

    #[test]
    fn non_default_branch_uses_the_cell_branch_not_a_main_fallback() {
        // A repo whose default branch is `trunk`: a push to `refs/heads/main`
        // must NOT move `head_sha`. The old `.unwrap_or("main")` fallback made
        // this indistinguishable from a default-branch push whenever the cell
        // was read loosely; the narrow now supplies the real branch.
        let v = verified(cell_data("trunk", &Value::String("keep".into())));
        let b = body(vec![("x", "abc123", "refs/heads/main")]);
        let (next, head) = compute_next_cell_data(&v, &b, "2026-01-01T00:00:00Z");
        assert_eq!(head.as_deref(), Some("keep"));
        assert_eq!(next["head_sha"], "keep");
    }

    #[test]
    fn cell_without_default_branch_does_not_narrow() {
        // Twin of the TS `narrow_repo_cell_data` null-on-missing: the handler
        // resolves the cell through `RepoCellData`, so a cell missing any
        // required field is a 401, never a callback that invents `main`.
        for missing in ["slug", "name", "default_branch", "hook_secret_hash"] {
            let mut obj = cell_data("main", &Value::Null);
            obj.as_object_mut().expect("object").remove(missing);
            assert!(
                serde_json::from_value::<RepoCellData>(obj).is_err(),
                "cell missing `{missing}` must fail to narrow",
            );
        }
    }

    #[test]
    fn updates_must_carry_a_full_sha_or_the_zero_sha() {
        let full = "a".repeat(40);
        assert!(updates_are_valid(&body(vec![(
            "x",
            full.as_str(),
            "refs/heads/main"
        )])));
        assert!(updates_are_valid(&body(vec![(
            "x",
            ZERO_SHA,
            "refs/heads/main"
        )])));
        assert!(updates_are_valid(&body(vec![])));
        for bad in [
            "abc123".to_owned(),
            "A".repeat(40),
            "a".repeat(64),
            String::new(),
            format!("{full} "),
        ] {
            let b = body(vec![
                ("x", full.as_str(), "refs/heads/feature"),
                ("x", bad.as_str(), "refs/heads/main"),
            ]);
            assert!(!updates_are_valid(&b), "{bad:?} must be refused");
        }
    }

    #[test]
    fn callback_body_is_strict_and_requires_the_push_attribution_keys() {
        let base = json!({
            "repo_id": "r",
            "updates": [{"old": "a", "new": "b", "ref": "refs/heads/main"}],
            "pushed_by": null,
            "push_username": null,
        });
        assert!(serde_json::from_value::<RepoReceiveCallbackBody>(base.clone()).is_ok());

        // strict `object` twin — an extra key at either level is a parse
        // failure (→ the bare 401), not a silently-ignored field.
        let mut extra_top = base.clone();
        extra_top["surprise"] = json!(1);
        assert!(serde_json::from_value::<RepoReceiveCallbackBody>(extra_top).is_err());
        let mut extra_nested = base.clone();
        extra_nested["updates"][0]["surprise"] = json!(1);
        assert!(serde_json::from_value::<RepoReceiveCallbackBody>(extra_nested).is_err());

        // `nullable` is not `optional` — an absent key is a parse
        // failure on both sides.
        for missing in ["repo_id", "updates", "pushed_by", "push_username"] {
            let mut obj = base.clone();
            obj.as_object_mut().expect("object").remove(missing);
            assert!(
                serde_json::from_value::<RepoReceiveCallbackBody>(obj).is_err(),
                "body missing `{missing}` must fail to parse",
            );
        }
    }

    /// A lookup whose pool checkout fails is the database-unavailable 503 on
    /// both routes, never the 401 a wrong secret gets — over a pool that never
    /// connects, with a request that passes every gate ahead of the lookup.
    #[tokio::test]
    async fn a_failed_lookup_checkout_answers_the_503() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt as _;

        let backend = fuz_testing::inert_app_backend(
            &crate::router::FUZ_FORGE_BACKEND_SPEC,
            "http://localhost:5173",
        );
        let router = internal_router(InternalRouteState {
            pool: backend.pool.clone(),
            realtime: Arc::clone(&backend.realtime),
        });
        let id = "00000000-0000-4000-8000-000000000001";
        let callback = serde_json::to_string(&json!({
            "repo_id": id,
            "updates": [],
            "pushed_by": null,
            "push_username": null,
        }))
        .expect("serializes");
        for (method, uri, body) in [
            ("GET", format!("/repo-config/{id}"), String::new()),
            ("POST", "/repo-receive-callback".to_owned(), callback),
        ] {
            let mut request = Request::builder()
                .method(method)
                .uri(&uri)
                .header(REPO_SECRET_HEADER, "s3cr3t")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .expect("a request");
            request
                .extensions_mut()
                .insert(ConnectInfo(peer("127.0.0.1")));
            let response = router.clone().oneshot(request).await.expect("infallible");
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE, "{uri}");
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("a body");
            assert_eq!(
                serde_json::from_slice::<Value>(&bytes).expect("JSON"),
                json!({"error": "service_unavailable"}),
                "{uri}"
            );
        }
    }
}
