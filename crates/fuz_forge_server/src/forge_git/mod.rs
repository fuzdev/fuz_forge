//! Forge git smart-HTTP routes.
//!
//! Port of `src/lib/server/routes/repo_git.ts`. The concern is split into
//! three structurally-parallel modules, mirroring the TS twin
//! (`src/lib/server/routes/repo_git.ts` +
//! `src/lib/server/routes/repo_git_auth.ts` +
//! `src/lib/server/routes/git_cgi.ts`):
//!
//! - **this module** — routing: the [`forge_router`] factory, the route
//!   handlers, the [`GitOp`] discriminator, and the `serve_*` glue that gates
//!   on [`auth`] then proxies through [`cgi`].
//! - [`auth`] — the locked-down auth chain ([`auth::authenticate_git_request`]).
//! - [`cgi`] — the `git http-backend` streaming proxy
//!   ([`cgi::proxy_to_git_http_backend`]) and CGI head parsing.
//!
//! ## Routes (mounted at app root, NOT `/api/*`)
//!
//! | Method | Path | Auth chain |
//! |---|---|---|
//! | `GET /:slug.git/info/refs?service=git-upload-pack` | Basic → admin → `forge.pull` |
//! | `GET /:slug.git/info/refs?service=git-receive-pack` | Basic → admin → `forge.push` |
//! | `POST /:slug.git/git-upload-pack` | Basic → admin → `forge.pull` |
//! | `POST /:slug.git/git-receive-pack` | Basic → admin → `forge.push` |
//!
//! The `<slug>` is the canonical two-segment `org/repo` and the `.git` suffix
//! is mandatory: a URL outside that grammar never reaches the auth chain (see
//! [`bare_slug_from_segments`]).

mod auth;
mod cgi;
pub(crate) mod parse;
pub(crate) mod read;

use axum::body::Body;
use axum::extract::{Path as AxumPath, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Router};
use fuz_http::ClientIp;

use crate::query_params::first_query_param;
use crate::token_policy;

/// State for the forge router.
#[derive(Clone)]
pub struct ForgeRouteState {
    pub app: crate::FuzForgeApp,
}

impl std::fmt::Debug for ForgeRouteState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForgeRouteState").finish_non_exhaustive()
    }
}

/// Build the forge axum router.
///
/// Mount path is the consumer's choice; conventionally the routes go at
/// the app root (`/:slug.git/...`). The TS impl uses a Hono regex route
/// (`/:slug_with_git{.+\.git}`) matching a multi-segment slug ending in
/// `.git`.
///
/// **Slug shape (axum 0.8):** axum forbids a `{param}.git` segment (param +
/// literal in one segment), and a single `{param}` can't span the `/` in an
/// `org/repo` slug. A `RepoSlug` is *always* exactly two segments
/// (`org/repo`; see `repo_id.ts`), so the routes capture both as `{org}` +
/// `{repo}` — `{repo}` must carry the trailing `.git`, checked and stripped in
/// [`bare_slug_from_segments`] — and the bare slug is reassembled as
/// `org/repo`. The TS forge uses a Hono regex (`/:slug_with_git{.+\.git}`);
/// this is the axum equivalent for the canonical two-segment slug.
///
/// Because the `.git` can't live in the route pattern here, the check moves
/// into the handlers: a `{repo}` without the suffix is **not** a git URL, and
/// the handler answers the router's own [`fuz_actions::server::not_found_response`]
/// — the same thing an unrouted path gets — rather than serving the repo. The
/// TS twin gets this from its route regex, which simply never matches a
/// suffix-less URL.
pub fn forge_router(state: ForgeRouteState) -> Router {
    Router::new()
        .route("/{org}/{repo}/info/refs", get(handle_info_refs))
        .route("/{org}/{repo}/git-upload-pack", post(handle_upload_pack))
        .route("/{org}/{repo}/git-receive-pack", post(handle_receive_pack))
        .with_state(state)
}

/// The suffix every git smart-HTTP clone URL carries (`<org>/<repo>.git/…`).
const GIT_SUFFIX: &str = ".git";

/// Reassemble the canonical `org/repo` slug from the two captured route
/// segments, requiring — and stripping — the `.git` suffix `{repo}` must carry
/// (e.g. `("org", "repo.git")` → `Some("org/repo")`).
///
/// The reassembled slug goes through [`fuz_forge_wire::validate_repo_slug`], so
/// **this gate is the clone-URL grammar itself** (`docs/forge.md`
/// § Clone-URL grammar), not merely a suffix check: an off-charset segment
/// (a non-ASCII homoglyph, a percent-decoded control byte) and a
/// percent-encoded `/` that reassembles into a third segment are refused here
/// too, before the auth chain runs. The returned slug is the lowercase
/// canonical form `validate_repo_slug` produces.
///
/// `None` means the URL is outside the grammar. The caller answers the
/// router's 404 — the request never reaches the auth chain, matching the TS
/// twin, whose route regex requires the suffix and whose `resolve_slug` runs
/// the same `RepoSlug` grammar before the lookup.
fn bare_slug_from_segments(org: &str, repo: &str) -> Option<String> {
    let name = repo.strip_suffix(GIT_SUFFIX)?;
    fuz_forge_wire::validate_repo_slug(&format!("{org}/{name}")).ok()
}

/// The content-type refusal both POST handlers run first: `415` for a `POST` a
/// browser could send cross-origin without a preflight (no `Content-Type`, or
/// a CORS-safelisted one — `fuz_http::is_cors_simple_content_type`). git
/// sends `application/x-git-*-request`, so no real client is refused.
///
/// The TS twin's route pipeline runs this check on its `raw_body` git routes
/// ahead of the handler, but only once its route regex has matched — a
/// `{repo}` without the `.git` suffix never reaches it there and 404s. So the
/// check runs here only for a suffixed `{repo}`, ahead of the slug grammar
/// (which the TS twin checks in-handler, after the content type).
fn git_post_content_type_refused(repo: &str, headers: &HeaderMap) -> bool {
    repo.ends_with(GIT_SUFFIX) && fuz_http::is_cors_simple_content_type(headers)
}

/// The 400 body both backends answer for a missing or unsupported
/// `?service=` on the advertise endpoint. Converged onto the TS literal
/// (`repo_git.ts`'s `c.text('Bad Request\n', 400)`): the check is post-auth,
/// so a generic refusal carries no enumeration risk and there is no reason for
/// the two backends to spell it differently.
const BAD_REQUEST_BODY: &str = "Bad Request\n";

/// The shared `?service=` refusal (see [`BAD_REQUEST_BODY`]).
fn service_bad_request() -> Response {
    (StatusCode::BAD_REQUEST, BAD_REQUEST_BODY).into_response()
}

/// The first `service` value in a raw query string, percent-decoded.
///
/// Deliberately **not** an axum `Query<T>` extractor. An extractor runs before
/// the handler body, so a duplicate `?service=` key would be rejected with axum's
/// own `400 Failed to deserialize query string: duplicate field \`service\``
/// — pre-auth and pre-grammar, contradicting both this module's auth-first
/// ordering and the off-grammar-404 invariant, and naming an internal field to
/// anonymous callers. Reading the raw query inside the handler keeps
/// grammar → auth → service in order.
///
/// [`first_query_param`] is WHATWG `application/x-www-form-urlencoded`: keys
/// are percent-decoded before comparison, `+` is a space in the value, and the
/// first matching pair wins. Hono's `c.req.query('service')` is *not* those
/// semantics — it scans the un-decoded query for the literal key substring
/// first and only falls back to a decoding parse when that finds nothing, so
/// `?%73ervice=git-upload-pack&service=bogus` reads as `bogus` there — so the
/// TS twin was converged onto the standard (`new URLSearchParams`) instead of
/// this side adopting the quirk. `repo_git.ts`'s `first_service_param` is the
/// twin.
fn first_service_param(raw_query: Option<&str>) -> Option<String> {
    first_query_param(raw_query, "service")
}

async fn handle_info_refs(
    State(state): State<ForgeRouteState>,
    AxumPath((org, repo)): AxumPath<(String, String)>,
    RawQuery(raw_query): RawQuery,
    client_ip: Option<Extension<ClientIp>>,
    headers: HeaderMap,
) -> Response {
    // Grammar gate BEFORE auth: a URL without the `.git` suffix is not a git
    // URL at all, so it gets the router's 404 rather than a credential check
    // (the TS twin's route regex never matches it). Purely syntactic — it
    // reveals nothing about which repos exist.
    let Some(slug) = bare_slug_from_segments(&org, &repo) else {
        return fuz_actions::server::not_found_response();
    };
    // The XFF-resolved client IP (`ClientIp` extension, set app-wide by
    // `fuz_http::client_ip_middleware`) — the Rust analog of TS `get_client_ip`.
    // Two shapes on purpose: the CGI env keeps the `Option` (an unresolved
    // caller leaves `REMOTE_ADDR` unset — see `cgi::CgiEnvOptions`), while the
    // `api_token` touch has no skip-the-column form and takes the sentinel.
    let ip = ClientIp::from_extension(client_ip.as_ref());
    let touch_ip = ClientIp::as_str_or_unresolved(client_ip.as_ref());
    // Auth FIRST (op-agnostic), so an unauthenticated request with a bogus /
    // missing `?service=` gets the generic 401 — not a pre-auth 400 that would
    // signal request-shape details. Matches the TS post-auth service check.
    let auth = match auth::authenticate_git_request(&state, &slug, &headers, touch_ip).await {
        Ok(auth) => auth,
        Err(err) => return auth::refusal_response(&err),
    };
    let Some(service) = first_service_param(raw_query.as_deref()) else {
        return service_bad_request();
    };
    let op = match service.as_str() {
        "git-upload-pack" => GitOp::Pull,
        "git-receive-pack" => GitOp::Push,
        _ => return service_bad_request(),
    };
    if !auth::check_repo_capability(&auth, op) {
        return auth::unauthorized_response();
    }
    serve_advertise(&auth, op, &headers, ip).await
}

async fn handle_upload_pack(
    state: State<ForgeRouteState>,
    path: AxumPath<(String, String)>,
    client_ip: Option<Extension<ClientIp>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    handle_pack(GitOp::Pull, state, path, client_ip, headers, body).await
}

async fn handle_receive_pack(
    state: State<ForgeRouteState>,
    path: AxumPath<(String, String)>,
    client_ip: Option<Extension<ClientIp>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    handle_pack(GitOp::Push, state, path, client_ip, headers, body).await
}

/// The body both pack POST handlers share: content type, slug, auth, then the
/// capability `op` requires, before the CGI runs.
async fn handle_pack(
    op: GitOp,
    State(state): State<ForgeRouteState>,
    AxumPath((org, repo)): AxumPath<(String, String)>,
    client_ip: Option<Extension<ClientIp>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if git_post_content_type_refused(&repo, &headers) {
        return fuz_http::unsupported_content_type_response();
    }
    let Some(slug) = bare_slug_from_segments(&org, &repo) else {
        return fuz_actions::server::not_found_response();
    };
    // The XFF-resolved client IP (`ClientIp` extension, set app-wide by
    // `fuz_http::client_ip_middleware`) — the Rust analog of TS `get_client_ip`.
    // Two shapes on purpose: the CGI env keeps the `Option` (an unresolved
    // caller leaves `REMOTE_ADDR` unset — see `cgi::CgiEnvOptions`), while the
    // `api_token` touch has no skip-the-column form and takes the sentinel.
    let ip = ClientIp::from_extension(client_ip.as_ref());
    let touch_ip = ClientIp::as_str_or_unresolved(client_ip.as_ref());
    let auth = match auth::authenticate_git_request(&state, &slug, &headers, touch_ip).await {
        Ok(auth) => auth,
        Err(err) => return auth::refusal_response(&err),
    };
    if !auth::check_repo_capability(&auth, op) {
        return auth::unauthorized_response();
    }
    serve_pack(&auth, op, &headers, ip, body).await
}

/// Pull / push discriminator for capability gating + CGI env build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GitOp {
    Pull,
    Push,
}

impl GitOp {
    /// The scoped-token capability this op requires, keyed on the repo id
    /// it targets. The TS forge keys `forge.push`/`forge.pull` by repo id
    /// (`repo_git.ts`), so the policy's per-repo allowlist gates each op.
    #[must_use]
    pub(crate) const fn capability(self, repo_id: &str) -> token_policy::FuzForgeCapability<'_> {
        match self {
            Self::Pull => token_policy::FuzForgeCapability::ForgePull { repo_id },
            Self::Push => token_policy::FuzForgeCapability::ForgePush { repo_id },
        }
    }
}

/// Proxy the capability advertisement for an already-authenticated request.
/// `remote_addr` is the XFF-resolved client IP for the CGI `REMOTE_ADDR`.
async fn serve_advertise(
    auth: &auth::GitAuthOk,
    op: GitOp,
    headers: &HeaderMap,
    remote_addr: Option<&str>,
) -> Response {
    let service = match op {
        GitOp::Pull => "git-upload-pack",
        GitOp::Push => "git-receive-pack",
    };
    let path_info = format!("/{}.git/info/refs", auth.repo_id);
    let query_string = format!("service={service}");
    cgi::proxy_to_git_http_backend(
        auth,
        headers,
        cgi::ProxyOptions {
            request_method: "GET",
            path_info: &path_info,
            query_string: &query_string,
            body: Body::empty(),
        },
        remote_addr,
    )
    .await
}

/// Proxy an upload/receive-pack for an already-authenticated request.
async fn serve_pack(
    auth: &auth::GitAuthOk,
    op: GitOp,
    headers: &HeaderMap,
    remote_addr: Option<&str>,
    body: Body,
) -> Response {
    let path_suffix = match op {
        GitOp::Pull => "/git-upload-pack",
        GitOp::Push => "/git-receive-pack",
    };
    let path_info = format!("/{}.git{path_suffix}", auth.repo_id);
    cgi::proxy_to_git_http_backend(
        auth,
        headers,
        cgi::ProxyOptions {
            request_method: "POST",
            path_info: &path_info,
            query_string: "",
            body,
        },
        remote_addr,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{bare_slug_from_segments, first_service_param};
    use crate::parity::parity_rows;

    /// The git routes' answers ahead of any repo, over a stand-in app whose
    /// pool never connects (`fuz_testing::inert_app_backend`): every database
    /// read on this router fails.
    mod auth_answers {
        use std::sync::Arc;

        use axum::body::Body;
        use axum::http::{Request, StatusCode, header};
        use base64::Engine as _;
        use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
        use tower::ServiceExt as _;

        use super::super::{ForgeRouteState, forge_router};
        use crate::FuzForgeApp;

        fn router() -> axum::Router {
            let backend = fuz_testing::inert_app_backend(
                &crate::router::FUZ_FORGE_BACKEND_SPEC,
                "http://localhost:5173",
            );
            let pool = backend.pool.clone();
            let app = FuzForgeApp {
                fact_store: crate::fact_store::FactStoreHandle::new(pool.clone(), None),
                fuz_forge_token_state: Arc::new(crate::token_policy::FuzForgeTokenRouteState::new(
                    pool,
                )),
                repo_path: None,
                git_path: crate::forge_git::read::DEFAULT_GIT_PATH.to_owned(),
                callback_url_base: crate::repo_storage::build_callback_url_base(None),
                seed_from_allow_private_hosts: false,
                backend,
            };
            forge_router(ForgeRouteState { app })
        }

        /// `(status, WWW-Authenticate, body)` for each git route, presenting
        /// `password` as the Basic password.
        async fn answers(password: &str) -> Vec<(StatusCode, Option<String>, String)> {
            let authorization = format!(
                "Basic {}",
                BASE64_STANDARD.encode(format!("git:{password}"))
            );
            let mut out = Vec::new();
            for (method, uri, content_type) in [
                (
                    "GET",
                    "/org/repo.git/info/refs?service=git-upload-pack",
                    None,
                ),
                (
                    "POST",
                    "/org/repo.git/git-upload-pack",
                    Some("application/x-git-upload-pack-request"),
                ),
                (
                    "POST",
                    "/org/repo.git/git-receive-pack",
                    Some("application/x-git-receive-pack-request"),
                ),
            ] {
                let mut request = Request::builder()
                    .method(method)
                    .uri(uri)
                    .header(header::AUTHORIZATION, &authorization);
                if let Some(content_type) = content_type {
                    request = request.header(header::CONTENT_TYPE, content_type);
                }
                let response = router()
                    .oneshot(request.body(Body::empty()).expect("a request"))
                    .await
                    .expect("infallible");
                let status = response.status();
                let challenge = response
                    .headers()
                    .get(header::WWW_AUTHENTICATE)
                    .map(|v| v.to_str().expect("ascii").to_owned());
                let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .expect("a body");
                out.push((
                    status,
                    challenge,
                    String::from_utf8(bytes.to_vec()).expect("utf-8"),
                ));
            }
            out
        }

        /// A token-shaped password is looked up, the lookup's pool checkout
        /// fails, and the answer is the database-unavailable 503 — never the
        /// 401 that would read as a bad credential.
        #[tokio::test]
        async fn a_failed_credential_checkout_answers_the_503() {
            let token = fuz_auth::api_token::generate_api_token().token;
            for (status, challenge, body) in answers(&token).await {
                assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
                assert_eq!(challenge, None);
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&body).expect("JSON"),
                    serde_json::json!({"error": "service_unavailable"})
                );
            }
        }

        /// A password with no token's shape is refused with the generic 401
        /// over the same broken pool — so it never reached the database,
        /// where it would have answered the 503 above.
        #[tokio::test]
        async fn a_malformed_password_is_refused_without_a_read() {
            for (status, challenge, body) in answers("hunter2").await {
                assert_eq!(status, StatusCode::UNAUTHORIZED);
                assert!(challenge.is_some_and(|c| c.starts_with("Basic ")));
                assert_eq!(body, "Unauthorized\n");
            }
        }
    }

    #[test]
    fn requires_the_git_suffix_and_two_non_empty_segments() {
        assert_eq!(
            bare_slug_from_segments("org", "repo.git").as_deref(),
            Some("org/repo")
        );
        // No suffix → not a git URL. This is the divergence the TS twin's
        // route regex (`.+\.git`) enforces by never matching.
        assert_eq!(bare_slug_from_segments("org", "repo"), None);
        // A bare `.git` leaves an empty repo name.
        assert_eq!(bare_slug_from_segments("org", ".git"), None);
        assert_eq!(bare_slug_from_segments("", "repo.git"), None);
    }

    #[test]
    fn the_pre_auth_gate_is_the_slug_grammar() {
        // Only the TRAILING `.git` is the suffix, and `.` is outside the
        // segment charset — so `org/repo.git.git` names no repo that can
        // exist and is refused rather than resolving `org/repo.git`.
        assert_eq!(bare_slug_from_segments("org", "repo.git.git"), None);
        // A non-ASCII homoglyph must not reach the auth chain, where the
        // lowercase fold for the cell lookup would map U+212A onto `k` and
        // serve `org/repok`.
        assert_eq!(bare_slug_from_segments("org", "repo\u{212a}.git"), None);
        // A percent-decoded control byte (`%00`) likewise.
        assert_eq!(bare_slug_from_segments("org", "re\u{0}po.git"), None);
        // A percent-decoded `/` (`%2F`) reassembles into a third segment;
        // axum routes on the raw path, so this is the shape that reaches here.
        assert_eq!(bare_slug_from_segments("org", "a/b.git"), None);
        // Mixed case is in-grammar and canonicalizes to lowercase.
        assert_eq!(
            bare_slug_from_segments("MyOrg", "MyRepo.git").as_deref(),
            Some("myorg/myrepo")
        );
    }

    const SERVICE_PARAM_FIXTURE: &str =
        include_str!("../../../../src/test/fixtures/parity/service_param.json");

    /// WHATWG `application/x-www-form-urlencoded` reading of `?service=`, the
    /// contract the TS twin's `first_service_param` (`repo_git.ts`) was
    /// converged onto. Asserted against
    /// `src/test/fixtures/parity/service_param.json`, which the TS side's
    /// `repo_git.service_param.test.ts` reads too.
    #[test]
    fn service_param_reads_the_query_as_urlsearchparams_does() {
        for row in parity_rows(SERVICE_PARAM_FIXTURE, "queries") {
            let raw_query = row["input"].as_str();
            let expected = row["expected"].as_str();
            assert_eq!(
                first_service_param(raw_query).as_deref(),
                expected,
                "raw_query {raw_query:?}",
            );
        }
    }
}
