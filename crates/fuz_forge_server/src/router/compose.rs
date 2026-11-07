//! The mount table: which sub-router sits under which prefix, behind which
//! middleware policy.
//!
//! [`compose_full_router`] is the whole of it — every route group the forge
//! serves, the group → policy table that decides what each carries, and the
//! `/api/server/status` handler that has no sub-router of its own. The spine
//! states it hands out come from the spine core's builders
//! (`fuz_actions::server::AppBackend`), the registry from
//! [`super::action_registry`]; the lifecycle around it is split: the boot
//! (migrations, bootstrap, `/ready`) is [`super::build_router`]'s, the upkeep
//! tasks beside the server [`crate::runtime::run_app`]'s.

use std::sync::Arc;
use std::time::Instant;

use axum::Json;
use axum::Router;
use axum::extract::{Extension, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use fuz_actions::server::{StartupError, fallback_group, probe_router};
use fuz_actions::{ActionRateLimits, create_rpc_router, register_action_ws};
use fuz_auth::AuthGate;
use fuz_http::{
    BodyCap, ClientIp, DEFAULT_BODY_LIMIT_BYTES, GatedRouter, RouteGroup, compose_stack,
};
use serde::Serialize;

use crate::app::FuzForgeApp;
use crate::env::FuzForgeEnv;
use crate::runtime::{ExtraActionSpecsFactory, FinalActionSpecsFactory, SERVER_NAME};

use super::FUZ_FORGE_BROWSABLE_TABLES;
use super::action_registry::build_action_registry;

/// Server version reported by `GET /api/server/status`.
///
/// The TS forge reports its generated `build_info` `VERSION`; the Rust
/// backend reports its own crate version. The wire shape (`{version,
/// uptime_ms}`) is what parity asserts — the loose output schema
/// (`loose_object({version: string, uptime_ms: nonnegative integer})`) compares
/// types, not the impl-specific version constant.
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// State for the authenticated `GET /api/server/status` route.
#[derive(Clone)]
struct ServerStatusRouteState {
    /// The origin check and credential walk [`server_status`] runs.
    gate: AuthGate,
    /// Captured at router composition (mirrors the TS `started_at = Date.now()`
    /// in `create_app`), so `uptime_ms` measures time since the app began
    /// serving.
    started_at: Instant,
}

#[derive(Serialize)]
struct ServerStatusResponse {
    version: &'static str,
    uptime_ms: u64,
}

/// `GET /api/server/status` — authenticated server version + uptime.
///
/// Mirrors the TS `create_server_status_route_spec` (`auth: account
/// required, actor none`; body `{version, uptime_ms}`). The frontend
/// (`capabilities.svelte.ts`) fetches it after login.
#[allow(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
async fn server_status(
    State(state): State<ServerStatusRouteState>,
    client_ip: Option<Extension<ClientIp>>,
    headers: HeaderMap,
) -> Result<Response, Response> {
    // No token-scope gate: the spine ships this route shape
    // (`create_server_status_route_spec`) ungated and the TS backend mounts it
    // unchanged. Whether a build version + uptime read should be closed to
    // narrowed tokens is fuz_app's call on its own route, not the forge's to
    // diverge on.
    // The XFF-resolved client IP (`ClientIp` extension, set app-wide by
    // `fuz_http::client_ip_middleware`) — the Rust analog of TS `get_client_ip`.
    let client_ip = ClientIp::as_str_or_unresolved(client_ip.as_ref());
    crate::route_auth::require_auth(&state.gate, &headers, client_ip).await?;
    let uptime_ms = u64::try_from(state.started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
    Ok(Json(ServerStatusResponse {
        version: SERVER_VERSION,
        uptime_ms,
    })
    .into_response())
}

/// The forge's per-account action budget.
///
/// An alias for the spine default rather than a tuned bundle: fuz_app's
/// `default_action_account_rate_limit` carries the same numbers, so accepting
/// the default *is* the parity position. The alias exists so the wiring below
/// and `tests::action_rate_limit_bounds_match_the_ts_twin` read one name — a
/// tuned bundle would otherwise be pinned nowhere.
const FORGE_ACTION_ACCOUNT_RATE_LIMIT: fuz_auth::RateLimiterOptions =
    fuz_auth::DEFAULT_ACTION_ACCOUNT_RATE_LIMIT;

/// The forge's per-IP action budget — same alias rationale as
/// [`FORGE_ACTION_ACCOUNT_RATE_LIMIT`].
const FORGE_ACTION_IP_RATE_LIMIT: fuz_auth::RateLimiterOptions =
    fuz_auth::DEFAULT_ACTION_IP_RATE_LIMIT;

/// `options` with `max_attempts` replaced by `cap` when one is given — the
/// test binary's action-limiter cap
/// ([`crate::runtime::RunAppOptions::action_rate_limit_max_attempts`]).
/// Production passes `None`, which leaves `options` as it is.
const fn with_action_rate_limit_cap(
    options: fuz_auth::RateLimiterOptions,
    cap: Option<u32>,
) -> fuz_auth::RateLimiterOptions {
    match cap {
        Some(max_attempts) => fuz_auth::RateLimiterOptions {
            max_attempts,
            ..options
        },
        None => options,
    }
}

/// Compose the full app router with every subsystem wired.
pub(super) fn compose_full_router(
    app: FuzForgeApp,
    env: &FuzForgeEnv,
    ready: Router,
    extra_action_specs_factory: Option<ExtraActionSpecsFactory>,
    final_action_specs_factory: Option<FinalActionSpecsFactory>,
    action_rate_limiters: fuz_auth::RateLimiterMode,
    action_rate_limit_max_attempts: Option<u32>,
) -> Result<GatedRouter, StartupError> {
    // Captured here (server-app composition), mirroring the TS `started_at =
    // Date.now()` inside `create_app`, so `/api/server/status` reports uptime
    // since the app began serving.
    let started_at = Instant::now();
    // One gate for the whole server: every route state below that resolves a
    // credential through the spine takes a clone of it, and the stack's
    // options read its allowlist, so the stack's origin check and each
    // handler's in-handler one cannot drift apart. Git smart-HTTP and
    // `/internal` take none — they authenticate on their own fences.
    let backend = &app.backend;
    let gate = backend.auth_gate();
    let stack_options = backend.stack_options();
    // The per-action limiters, built once and shared by both dispatcher
    // states, which charge every spec declaring a class — the spine's auth
    // spec set and the forge's own — with one budget across the HTTP RPC + WS
    // transports. Sharing is load-bearing rather than tidy — the TS twin
    // threads one `action_account_rate_limiter` through `create_app_server`
    // deps, so a second instance for one transport would hand a caller two
    // independent budgets where the twin gives one.
    // `cross_backend/action_throttle_order.cross.test.ts` spends the budget
    // across both transports and is the pin.
    //
    // The ACCOUNT axis is live: these forge specs declare
    // `RateLimitClass::Account` (`fuz_forge_repo_rotate_secret`,
    // `fuz_forge_repo_create`, `fuz_forge_token_create_scoped`,
    // `fuz_forge_token_policy_list` — twins of the TS `rate_limit: 'account'`
    // markings), so this bucket is the one that fires for them. The
    // `actions::tests::spec_metadata_matches_the_expectation_table` twin table
    // pins which specs carry the class.
    //
    // Every method on the IP axis is the spine's, not the forge's:
    // `peer/ping` declares `RateLimitClass::Ip` on both spines (`rate_limit:
    // 'ip'` on the TS `peer_ping_action_spec`), and the mounted cell bundle
    // adds `cell_get` / `cell_list` / `cell_field_list` / `cell_item_list`,
    // whose TS twins carry the same class. On this backend `peer/ping`'s class
    // is what stops an anonymous HTTP caller looping the no-transport refusal
    // for two pool checkouts apiece; the TS twin's public auth shape skips the
    // authorization phase, so there it only bounds fan-out.
    //
    // Both spines carry the same bounds — `DEFAULT_ACTION_IP_RATE_LIMIT` is
    // 600 / 15 min beside fuz_app's `default_action_ip_rate_limit`, and the
    // account bucket is 1200 / 15 min on both — so a forge spec that opts into
    // `Ip` / `Both` inherits the same budget its TS twin does and needs no
    // tuned `RateLimiterOptions` here to stay in parity. The pin is
    // `src/test/fixtures/parity/rate_limits.json`, read by
    // `tests::action_rate_limit_bounds_match_the_ts_twin` below and by the TS
    // twin in `src/test/server/action_rate_limit_bounds.test.ts`: a bound that
    // moved on one side alone fails on both.
    //
    // Their mode and cap are their own, not the auth limiters' — the test
    // binary gates them separately (`FUZ_ACTION_RATE_LIMIT_ENABLED`, plus a
    // small `max_attempts` cap so a cross suite reaches the throttle in a few
    // calls); production passes `Enforced` and no cap.
    let limits = ActionRateLimits::new(
        action_rate_limiters,
        with_action_rate_limit_cap(
            FORGE_ACTION_ACCOUNT_RATE_LIMIT,
            action_rate_limit_max_attempts,
        ),
        with_action_rate_limit_cap(FORGE_ACTION_IP_RATE_LIMIT, action_rate_limit_max_attempts),
    );
    let registry =
        build_action_registry(&app, extra_action_specs_factory, final_action_specs_factory)?;
    let dispatch = backend.action_dispatch(gate.clone(), registry, &limits);
    // Admin-only sockets — twin of the TS server's `build_ws_endpoint_specs`
    // (`required_roles: [ROLE_ADMIN]`,
    // `src/lib/server/routes/fuz_forge_route_specs.ts`). Every fuz_forge RPC
    // action already requires `admin`, but the socket needs its own gate: a
    // connected client receives every `fuz_forge_repo_updated` broadcast with
    // no per-recipient filter, so signup-created non-admin accounts must not
    // be able to hold one (see `crate::broadcasts`).
    let ws_state = backend.ws_route_state(dispatch.clone(), vec![fuz_auth::ROLE_ADMIN]);
    let forge_state = crate::forge_git::ForgeRouteState { app: app.clone() };

    // Mount sub-routers. Account REST + bootstrap + signup all nest under
    // `/api/account` (→ `/api/account/bootstrap` + `/api/account/signup`),
    // matching the spine contract every other consumer + the TS forge use.
    // RPC + WS nest under `/api`. Signup mounts through the production path so
    // the cross-process harness can mint per-test accounts (mirrors the TS
    // forge + `testing_spine_stub`); invite-gated by default
    // (`app_settings.open_signup = false`).
    let api_account = backend.auth_rest_routes(gate.clone()).into_router();
    // RPC + WS mount bare — the spine's `api_token.scope` owns both
    // scoped-token gates: the per-method check inside `perform_action`
    // (credential → scope → role), and rule 3's refusal of a narrowed token at
    // the WS upgrade. Forge adds no layer of its own, which is what keeps these
    // routes to a single credential resolution: a gate here would resolve the
    // request and then the spine's handler would resolve it again, costing two
    // `api_token` lookups and two background touch UPDATEs racing on the same
    // row per bearer request.
    //
    // Forge's `fuz_forge_api_token_policy` row governs its resource-bound REST
    // surfaces (files / git) instead, and those hydrate from an
    // already-resolved auth.
    let api = Router::new()
        .merge(create_rpc_router(dispatch))
        .merge(register_action_ws(ws_state));

    let forge = crate::forge_git::forge_router(forge_state);

    // Loopback-only callback routes the git hooks POST/GET back into
    // (`/internal/repo-config/{id}` + `/internal/repo-receive-callback`). Gated
    // on a loopback peer + per-repo secret; see `crate::internal_routes`.
    let internal =
        crate::internal_routes::internal_router(crate::internal_routes::InternalRouteState {
            pool: backend.pool.clone(),
            realtime: Arc::clone(&backend.realtime),
        });

    // fuz_forge admin + file-store REST families. The db-admin browser is
    // the spine's `fuz_db_admin` router; the gate below is this crate's
    // configuration (admin role, session-only) and the spine's router is what
    // enforces it. The file mutation routes gate on the `admin` role via
    // `crate::route_auth`, and the file read routes (`meta` / list /
    // download) require only a valid account.
    let db_admin = fuz_db_admin::db_admin_router(fuz_db_admin::DbAdminRouteState {
        gate: gate.clone(),
        required_role: fuz_auth::ROLE_ADMIN,
        // Session-only: the admin dashboard is the sole consumer of
        // `/api/db`, and a browser session is the only channel that needs it —
        // a bearer `api_token` (even Full) cannot bulk-read browsable
        // rows (e.g. repo `hook_secret_hash`es in `cell.data`). The TS wrapper
        // (`src/lib/server/routes/db.ts`) declares the same
        // `credential_types: ['session']`; rule 3 (the `surface:db_admin`
        // scope gate) stays behind it as the dormant second fence.
        credential_gate: fuz_auth::CredentialGate::SESSION_ONLY,
        browsable_tables: FUZ_FORGE_BROWSABLE_TABLES,
        // No forge tables beyond the builtin NON_DELETABLE_TABLES floor.
        non_deletable_tables: &[],
        audit: Arc::clone(&backend.audit_emitter),
    });
    let files = crate::files::files_router(crate::files::FilesRouteState {
        gate: gate.clone(),
        fact_store: app.fact_store.clone(),
        token_state: Arc::clone(&app.fuz_forge_token_state),
        max_upload_bytes: env.file_store_max_bytes,
        disk_root: Some(env.fact_store_root()),
        free_space_margin_bytes: env.file_store_free_space_margin_bytes,
        upload_semaphore: Arc::new(tokio::sync::Semaphore::new(
            env.file_store_max_concurrent_uploads,
        )),
    });

    // Content-addressed fact serving — the shared `fuz_fact_serving`
    // reader-facade, mounted as both routes (`fact_routers`): the cell-scoped
    // per-reference read (`GET /api/cells/{cell_id}/facts/{hash}`, capability-free
    // pure cell visibility) and the admin-only bare-hash read
    // (`GET /api/facts/{hash}`). The generic form of the path-keyed `files`
    // store above: it serves any viewable cell's referenced bytes (registry
    // blobs, README / blog images), not only `files/<filename>` cells. The TS
    // twin mounts the same pair through `create_serve_cell_fact_route_spec` +
    // `create_serve_fact_route_spec`. Disk-streams from the facts dir here (no
    // X-Accel prefix); a production nginx X-Accel wiring would set the prefix and
    // assert the location is `internal;` via
    // `fuz_fact_serving::validate_facts_internal_location`.
    //
    // X-Accel offload is off here (the disk-stream path). To enable it in
    // production, build a validated `fuz_fact_serving::XAccelConfig::new(prefix,
    // nginx_config)?` and pass `x_accel: Some(...)` — `XAccelConfig` refuses to
    // construct unless the facts `location` is `internal;`, so the prefix can't
    // be enabled without the fail-loud boot check (a public facts location would
    // bypass every cell-visibility check).
    let facts = fuz_fact_serving::fact_routers(fuz_fact_serving::FactServingRouteState {
        gate: gate.clone(),
        facts_dir: env.fact_store_root(),
        x_accel: None,
    });

    // Admin-gated audit-log SSE stream (`GET /api/admin/audit/stream`) — the
    // shared spine router at the spine defaults: the admin role, over the
    // forge's own session cookie only, like the forge's db-admin mount —
    // nothing streams the audit log over a bearer, and the SSE close-on-revoke
    // set is built on the premise that a stream is opened under a cookie
    // session. Mirrors the TS forge's `create_audit_log_route_specs({stream})`.
    let audit_stream = backend.audit_stream_router(gate.clone())?;

    // Authenticated server version + uptime (`GET /api/server/status`).
    // Mirrors the TS forge's `create_server_status_route_spec`.
    let server_status_router = Router::new()
        .route("/status", get(server_status))
        .with_state(ServerStatusRouteState { gate, started_at });

    drop(app); // composition root no longer needed; sub-states own clones.

    // The router is `fuz_http::compose_stack`'s: five route groups and the
    // fallback, each behind the stack's fixed order (body cap → origin check →
    // client-IP resolution), the whole wrapped in request tracing:
    //
    // | group      | body cap                      | origin check                 | mounts                                                                             |
    // | ---------- | ----------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
    // | `api`      | 1 MiB                         | checked                      | `/api/account`, `/api/db`, `/api/server`, `/api` (RPC + WS), audit SSE, cell facts |
    // | `internal` | 1 MiB                         | carved out                   | `/internal`                                                                        |
    // | `files`    | handler-owned                 | checked                      | `/api/fuz_forge/files`                                                             |
    // | `git`      | handler-owned                 | checked                      | git smart-HTTP                                                                     |
    // | `probes`   | 1 MiB                         | checked                      | `/health`, `/`, `/ready`                                                           |
    // | fallback   | 1 MiB                         | checked                      | the `not_found` answer for every unrouted path                                     |
    //
    // ## The body cap
    //
    // A capped group answers a declared `Content-Length` over 1 MiB with `413`
    // ahead of every other gate, a foreign `Origin` included — the TS twin's
    // order, whose `generic_body_cap_middleware()` is first in its chain. The
    // body-less routes (`/api/server/status`, the audit SSE stream, the
    // cell-fact reads, the probes) are capped too: the cap only inspects the
    // *request* body, so it costs them nothing.
    //
    // The two handler-owned groups are the one recorded exception to 413-first,
    // so there a foreign `Origin` answers `403` before the handler's own cap:
    //
    // - The file-store upload streams the raw `axum::body::Body` and enforces
    //   `env.file_store_max_bytes` itself — a `Content-Length` pre-check plus a
    //   per-byte counter in `FactStore::put_stream` — answering
    //   `payload_too_large` with the file-store cap in its `message`, as the TS
    //   twin does, where a stack cap would answer the bare 1 MiB one.
    // - `git http-backend` is the size authority for a push: the pack handlers
    //   stream the body straight into the subprocess stdin, and a pack
    //   routinely exceeds 1 MiB.
    //
    // ## The origin check
    //
    // Every path is checked, the probes and the fallback included — the TS
    // twin's origin check covers every path too. A request with no `Origin`
    // passes, so a probe, `git`, and the `fuzf` CLI are unaffected; what is
    // refused is a page from a foreign origin, on any path.
    //
    // The git group stays checked although its handlers refuse *any* `Origin`
    // or `Referer` themselves (`forge_git::auth`): `git` sends none, so the
    // check changes only which refusal a browser replay sees — `403
    // forbidden_origin` for a foreign page, the handler's generic `401` for an
    // allowed one.
    //
    // `/internal` is the one carve-out. Its loopback-only hook callbacks refuse
    // any `Origin` or `Referer` in-handler, on top of a loopback peer check and
    // a per-repo secret, and answer every refusal with the same bare `401`, so a
    // browser replay learns nothing about which fence it hit.
    //
    // `origin_scope.cross.test.ts` pins the scope on both backends, each
    // negative against an `/api` positive control.
    //
    // ## Client IP
    //
    // `client_ip_middleware` is in every group, over whatever
    // `FUZ_FORGE_TRUSTED_PROXIES` parses to, an empty set included: an empty
    // set is the *more* conservative posture, not a disabled one — every peer
    // fails `is_trusted_ip`, so `X-Forwarded-For` is never believed and the TCP
    // peer is recorded. A missing layer would leave the extension absent, which
    // is what actually degrades behavior: the IP-keyed rate limiters
    // (`login_ip_rate_limiter`, `signup_ip_rate_limiter`, and the dispatcher's
    // `FORGE_ACTION_IP_RATE_LIMIT` bucket) would key every caller under one
    // shared `fuz_http::UNRESOLVED_CLIENT_IP`, and every bearer request's
    // `api_token` touch would record that sentinel instead of the real address
    // (`route_auth::require_auth`).
    let api_group = RouteGroup::new(
        "api",
        Router::new()
            .nest("/api/account", api_account)
            .nest("/api/db", db_admin)
            .nest("/api/server", server_status_router)
            .nest("/api", api)
            .merge(audit_stream)
            .merge(facts),
        BodyCap::Bytes(DEFAULT_BODY_LIMIT_BYTES),
    );
    let internal_group = RouteGroup::new(
        "internal",
        Router::new().nest("/internal", internal),
        BodyCap::Bytes(DEFAULT_BODY_LIMIT_BYTES),
    )
    .origin_carve_out("loopback-only hook callbacks; refuse any Origin/Referer in-handler");
    let files_group = RouteGroup::new(
        "files",
        Router::new().nest("/api/fuz_forge/files", files),
        BodyCap::HandlerOwned {
            reason: "streamed upload answers its own payload_too_large 413",
        },
    );
    let git_group = RouteGroup::new(
        "git",
        forge,
        BodyCap::HandlerOwned {
            reason: "git http-backend owns pack limits",
        },
    );
    let probes_group = RouteGroup::new(
        "probes",
        probe_router(SERVER_NAME).merge(ready),
        BodyCap::Bytes(DEFAULT_BODY_LIMIT_BYTES),
    );
    let fallback = fallback_group();

    Ok(compose_stack(
        [
            api_group,
            internal_group,
            files_group,
            git_group,
            probes_group,
        ],
        fallback,
        &stack_options,
    ))
}

#[cfg(test)]
mod tests {
    use crate::parity::parity_rows;

    const RATE_LIMITS_FIXTURE: &str =
        include_str!("../../../../src/test/fixtures/parity/rate_limits.json");

    /// The two action buckets are a **wire-visible** contract, not tuning: the
    /// bound decides how many calls a caller gets before the dispatcher answers
    /// `429` instead of doing the work, so a backend with a looser budget serves
    /// requests its twin refuses. Both spines default to the same numbers, and
    /// this holds them there against
    /// `src/test/fixtures/parity/rate_limits.json`, which the TS twin
    /// (`src/test/server/action_rate_limit_bounds.test.ts`) reads too.
    #[test]
    fn action_rate_limit_bounds_match_the_ts_twin() {
        for (table, options) in [
            ("action_ip", super::FORGE_ACTION_IP_RATE_LIMIT),
            ("action_account", super::FORGE_ACTION_ACCOUNT_RATE_LIMIT),
        ] {
            for row in parity_rows(RATE_LIMITS_FIXTURE, table) {
                let name = row["name"].as_str().expect("a name");
                let declared: u64 = match name {
                    "max_attempts" => u64::from(options.max_attempts),
                    "window_ms" => options.window_ms,
                    "max_keys" => options.max_keys.expect("the forge caps the key set") as u64,
                    other => panic!("no such rate-limit field: {other}"),
                };
                assert_eq!(row["value"], declared, "{table}.{name}");
            }
        }
    }

    /// The **wiring** pin: the bounds above are only the forge's if the forge
    /// actually wires them.
    ///
    /// The two consts alias the spine defaults, and the wiring reads the
    /// consts, so a tuned bundle introduced at either wiring site — the
    /// dispatcher's limiters or the auth spec set's — either moves this
    /// assertion or moves the fixture, and moving the fixture fails the TS
    /// twin. Without it the fixture pins two upstream constants that nothing
    /// in this repo is obliged to use.
    #[test]
    fn the_forge_wires_the_spine_action_rate_limits() {
        /// `RateLimiterOptions` carries no `PartialEq`, so compare the fields
        /// it has — which also makes a field added upstream a compile error
        /// here rather than a silently uncompared value.
        fn fields(options: fuz_auth::RateLimiterOptions) -> (u32, u64, Option<usize>) {
            let fuz_auth::RateLimiterOptions {
                max_attempts,
                window_ms,
                max_keys,
            } = options;
            (max_attempts, window_ms, max_keys)
        }
        assert_eq!(
            fields(super::FORGE_ACTION_ACCOUNT_RATE_LIMIT),
            fields(fuz_auth::DEFAULT_ACTION_ACCOUNT_RATE_LIMIT)
        );
        assert_eq!(
            fields(super::FORGE_ACTION_IP_RATE_LIMIT),
            fields(fuz_auth::DEFAULT_ACTION_IP_RATE_LIMIT)
        );
        // no cap is what production passes, and it leaves the bounds alone
        assert_eq!(
            fields(super::with_action_rate_limit_cap(
                super::FORGE_ACTION_ACCOUNT_RATE_LIMIT,
                None
            )),
            fields(fuz_auth::DEFAULT_ACTION_ACCOUNT_RATE_LIMIT)
        );
    }

    /// The test binary's cap replaces `max_attempts` and nothing else — the
    /// window and key bound stay the forge's.
    #[test]
    fn the_action_cap_replaces_only_max_attempts() {
        let capped = super::with_action_rate_limit_cap(super::FORGE_ACTION_IP_RATE_LIMIT, Some(4));
        assert_eq!(capped.max_attempts, 4);
        assert_eq!(
            capped.window_ms,
            super::FORGE_ACTION_IP_RATE_LIMIT.window_ms
        );
        assert_eq!(capped.max_keys, super::FORGE_ACTION_IP_RATE_LIMIT.max_keys);
    }
}

#[cfg(test)]
mod client_ip_posture {
    //! The empty-trusted-proxy posture [`super::compose_full_router`] relies on.
    //!
    //! `FUZ_FORGE_TRUSTED_PROXIES` defaults to loopback, so the composed router
    //! normally layers `client_ip_middleware` over a non-empty set — but an
    //! operator can opt out with a value that parses empty (`,`). These tests
    //! pin what the layer does over an *empty* set — record the real TCP peer,
    //! never believe a forged `X-Forwarded-For` — because it is the whole
    //! reason the layer mounts unconditionally rather than only when proxies
    //! are configured.

    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};

    use axum::Router;
    use axum::body::Body;
    use axum::extract::{ConnectInfo, Extension};
    use axum::http::{Request, StatusCode};
    use axum::middleware::from_fn_with_state;
    use axum::routing::get;
    use fuz_http::{ClientIp, ParsedProxy, client_ip_middleware};
    use tower::ServiceExt;

    /// Drive one request through the composer's empty-set layer shape and
    /// return the `ClientIp` the middleware resolved.
    async fn resolved_client_ip(peer: &str, forwarded_for: Option<&str>) -> String {
        let seen: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let sink = Arc::clone(&seen);
        // The same empty vec `FuzForgeEnv` yields for the explicit `,` opt-out.
        let proxies: Arc<Vec<ParsedProxy>> = Arc::new(Vec::new());
        let app = Router::new()
            .route(
                "/ip",
                get(move |Extension(ClientIp(ip)): Extension<ClientIp>| {
                    let sink = Arc::clone(&sink);
                    async move {
                        *sink.lock().expect("sink is uncontended") = Some(ip);
                        StatusCode::OK
                    }
                }),
            )
            .layer(from_fn_with_state(proxies, client_ip_middleware));

        let mut builder = Request::builder().uri("/ip").method("GET");
        if let Some(value) = forwarded_for {
            builder = builder.header("x-forwarded-for", value);
        }
        let mut req = builder.body(Body::empty()).expect("request builds");
        // `fuz_http::serve_with_shutdown` inserts `ConnectInfo` into every
        // request; a `oneshot` has no connection, so plumb the peer by hand.
        req.extensions_mut().insert(ConnectInfo(
            peer.parse::<SocketAddr>().expect("peer parses"),
        ));

        let response = app.oneshot(req).await.expect("router responds");
        // A 500 here would mean the `ClientIp` extension was missing — i.e. the
        // middleware was not mounted.
        assert_eq!(response.status(), StatusCode::OK, "ClientIp was populated");

        seen.lock()
            .expect("sink is uncontended")
            .clone()
            .expect("the middleware always populates ClientIp")
    }

    #[tokio::test]
    async fn no_forwarded_for_resolves_to_the_peer() {
        assert_eq!(
            resolved_client_ip("203.0.113.7:51234", None).await,
            "203.0.113.7"
        );
    }

    #[tokio::test]
    async fn forged_forwarded_for_from_an_untrusted_peer_is_ignored() {
        // With no trusted proxies every peer fails the trust check, so the
        // spoofable header is never believed — a caller cannot mint a fresh
        // per-IP rate-limit bucket by inventing an `X-Forwarded-For`.
        assert_eq!(
            resolved_client_ip("203.0.113.7:51234", Some("198.51.100.9")).await,
            "203.0.113.7"
        );
    }
}
