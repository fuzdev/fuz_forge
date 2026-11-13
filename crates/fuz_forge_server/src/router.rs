//! Top-level `axum::Router` composition for fuz_forge_server.
//!
//! Consumers compose their own router over the spine's `fuz_actions::server`
//! toolkit; this module is the forge's.
//! It composes:
//!
//! - `fuz_auth::account_router` → `/api/account/{status,login,logout,password}`
//! - `fuz_auth::bootstrap_router` → `/api/account/bootstrap`
//! - `fuz_auth::signup_router` → `/api/account/signup`
//! - `fuz_actions::create_rpc_router` → `/api/rpc`
//! - `fuz_actions::register_action_ws` → `/api/ws`
//! - `fuz_db_admin::db_admin_router` → `/api/db/...` (table browser; the forge
//!   picks the admin role + the session-only credential gate, the spine
//!   enforces both — a bearer `api_token` never reaches it)
//! - `fuz_fact_serving::fact_routers` → `/api/cells/{cell_id}/facts/{hash}` +
//!   `/api/facts/{hash}` (cell-scoped + admin-only fact reads)
//! - `fuz_realtime::audit_stream_router` → `/api/admin/audit/stream`
//! - `fuz_http::ready_router` → `/ready` (the schema-drift deploy gate, built
//!   by the spine's `create_app_backend`)
//! - `crate::files::files_router` → `/api/fuz_forge/files/...` (file store)
//! - `crate::forge_git::forge_router` → `/:slug.git/...`
//! - `crate::internal_routes::internal_router` → `/internal/...` (the
//!   loopback-only git-hook callbacks)
//! - `fuz_actions::server::probe_router` → `/health`, `/`, and
//!   `fuz_actions::server::fallback_group` → the `not found` fallback
//! - a handler in [`compose`] → `/api/server/status`
//!
//! The middleware is `fuz_http::compose_stack`'s, in its fixed order: request
//! tracing around everything, then per route group the body cap, the origin
//! check, and client-IP resolution. The cap sits outside the origin check, so a
//! declared over-cap body answers `413` ahead of a `403` — except in the file
//! store and git groups, whose handlers own their caps. Every path is
//! origin-checked, the probes and the `not_found` fallback included, except
//! the `/internal` callbacks, carved out by name. The group → policy table and
//! the reasoning are in [`compose`]. The boot-only router (no database)
//! composes through the same stack.
//!
//! ## Migration namespace
//!
//! Single `"fuz_forge"` migration namespace, applied last in the chain
//! [`fuz_forge_migration_namespaces`] builds — `fuz_auth::AUTH_MIGRATIONS`,
//! `fuz_cell::CELL_MIGRATIONS`, `fuz_fact::FACT_MIGRATIONS`, then fuz_forge's
//! own — handed to `fuz_db::run_migrations`. The fuz_forge namespace owns only
//! `fuz_forge_api_token_policy`; the cell substrate
//! (`cell`/`cell_grant`/`cell_field`/`cell_item`) belongs to
//! `fuz_cell` and the fact substrate (`fact`/`fact_ref`/`memo`/`fact_holder`) to
//! `fuz_fact`.

use fuz_actions::server::{
    AppBackendSpec, BootedAppBackend, SpineBackendOptions, StartupError, boot_only,
    create_app_backend,
};
use fuz_db::MigrationNamespace;
use fuz_http::GatedRouter;

use crate::app::FuzForgeApp;
use crate::env::FuzForgeEnv;
use crate::runtime::{ExtraActionSpecsFactory, FinalActionSpecsFactory, SERVER_NAME};

mod action_registry;
mod compose;

use compose::compose_full_router;

/// Migration namespace for fuz_forge consumer-supplied DDL.
///
/// Splices after `fuz_auth::AUTH_MIGRATIONS_NAMESPACE`; the live
/// migration list lives in [`crate::migrations`]. Auth runs first
/// because the fuz_forge tables FK into `actor(id)` / `api_token(id)`.
pub const FUZ_FORGE_MIGRATIONS_NAMESPACE: &str = "fuz_forge";

/// Session cookie name for the forge.
///
/// Diverges from the spine default (`fuz_session`) to match the TS
/// forge's `fuz_forge_session` so both backends emit + read the same
/// cookie (the spine takes this as a per-app override, see
/// `fuz_auth::SESSION_COOKIE_NAME`).
pub const FUZ_FORGE_SESSION_COOKIE_NAME: &str = "fuz_forge_session";

/// The tables forge's db-admin browser exposes.
///
/// Everything in the forge DB except the credential tables (`account`,
/// `auth_session`, `api_token`, `bootstrap_lock`), which `fuz_db_admin`'s
/// `NON_BROWSABLE_TABLES` floor refuses regardless. An explicit enumeration,
/// so a future secret-bearing migration stays unlisted until someone names it
/// here. Note the listed set is not free of server-only state: `cell` rows
/// carry each repo's `hook_secret_hash` in `cell.data`, which is part of why
/// the mount is session-only.
pub const FUZ_FORGE_BROWSABLE_TABLES: &[&str] = &[
    // auth domain (non-credential)
    "actor",
    "role_grant",
    "role_grant_offer",
    "invite",
    "audit_log",
    "app_settings",
    "schema_version",
    // cell substrate
    "cell",
    "cell_grant",
    "cell_field",
    "cell_item",
    // fact substrate
    "fact",
    "fact_ref",
    "memo",
    // forge domain
    "fuz_forge_api_token_policy",
];

/// Re-export the migration namespace construction for the runner.
#[must_use]
pub const fn fuz_forge_migrations_namespace() -> MigrationNamespace {
    crate::migrations::fuz_forge_migrations_namespace()
}

/// The full migration chain fuz_forge applies, in order.
///
/// The spine (auth → cell → fact) plus fuz_forge's own
/// namespace. Shared by [`build_router`]'s migration run and the `fuzfd
/// db-status` subcommand so the two never drift.
#[must_use]
pub const fn fuz_forge_migration_namespaces() -> [MigrationNamespace; 4] {
    [
        fuz_auth::AUTH_MIGRATIONS,
        fuz_cell::CELL_MIGRATIONS,
        fuz_fact::FACT_MIGRATIONS,
        fuz_forge_migrations_namespace(),
    ]
}

/// What the forge's server is: its cookie, its chain, the committed
/// `expected_schema.json`, and the admin audit stream.
///
/// The fixture is the full migration-chain column map the TS forge's `/ready`
/// reads too — column-presence is engine-portable, so one fixture is the
/// cross-impl contract (the schema-parity gate in `cross_backend_parity`
/// proves the two backends converge). It is embedded at compile time, so the
/// production deploy-gate binary is self-contained; zap's post-deploy poll
/// targets `/ready`, rolling back a drifted release.
pub const FUZ_FORGE_BACKEND_SPEC: AppBackendSpec = AppBackendSpec {
    session_cookie_name: FUZ_FORGE_SESSION_COOKIE_NAME,
    migration_namespaces: &fuz_forge_migration_namespaces(),
    expected_schema_json: Some(include_str!("../../../src/lib/server/expected_schema.json")),
    audit_sse: Some(fuz_actions::server::AuditSseSpec::DEFAULT),
    browser_gates: fuz_actions::server::BrowserGateSpec::DEFAULT,
};

/// Assembly swap points for [`build_router`] — every knob the production
/// binary and the `testing_fuz_forge_server` binary differ on, in one named
/// bag rather than a positional tail.
///
/// The field docs on [`crate::runtime::RunAppOptions`] (which forwards each of
/// these verbatim) carry the production-vs-test rationale.
#[expect(
    missing_debug_implementations,
    reason = "the spine options and the boxed action-spec factories have no `Debug`"
)]
pub struct BuildRouterOptions {
    /// The spine's swap points: hasher, auth limiter mode, daemon-token state,
    /// pre-migration hook, in-flight audit tracking.
    pub backend: SpineBackendOptions,
    /// Extra specs folded in after the standard set.
    pub extra_action_specs_factory: Option<ExtraActionSpecsFactory>,
    /// Specs built from the assembled spec list, appended last.
    pub final_action_specs_factory: Option<FinalActionSpecsFactory>,
    /// Whether the two action rate limiters are built.
    pub action_rate_limiters: fuz_auth::RateLimiterMode,
    /// Replaces both action limiters' `max_attempts` when set.
    pub action_rate_limit_max_attempts: Option<u32>,
}

/// What [`build_router`] builds: the router, and the composition root behind
/// it for the work [`crate::runtime::run_app`] runs beside the server (the
/// upkeep tasks, [`crate::runtime::upkeep_options`]).
#[derive(Debug)]
pub struct BuiltRouter {
    /// The composed router — served by `fuz_http::serve_with_shutdown`, the
    /// only thing that takes it.
    pub router: GatedRouter,
    /// `None` in boot-only mode, with no database.
    pub app: Option<FuzForgeApp>,
}

/// Build the top-level axum router.
///
/// Spawns nothing: the background upkeep that runs beside the server is
/// [`crate::runtime::run_app`]'s, over the returned [`BuiltRouter::app`].
///
/// Boots the spine core through `fuz_actions::server::create_app_backend` —
/// the READ COMMITTED guard, the pre-migration hook (the test binary's
/// env-gated schema wipe), the migration chain (auth → cell → fact → the
/// forge's token-policy table), the keeper resolved into the daemon-token
/// state when the test binary injected one, bootstrap availability, the
/// audit-row fan-out to the admin audit streams and then the one revocation
/// guard over every live transport (WebSockets and those streams), and
/// `/ready` — then composes the forge over it.
///
/// `options.backend.daemon_token_state` is only ever supplied by the test
/// binary (via `fuz_testing`, the sole producer of the credential), so a
/// production assembly is `None` and the daemon-token leg of the gate's
/// credential walk is unreachable. No rotation task: the initial token stays
/// valid until process exit, and the cross-process harness reads it once.
///
/// Falls back to a minimal "boot mode" router (`/health` and `/`) when
/// `DATABASE_URL` is absent — operators can still smoke-test the binary
/// without a live PG.
///
/// # Errors
///
/// [`StartupError`] when the spine core can't boot or the action registry
/// refuses its specs.
pub async fn build_router(
    env: &FuzForgeEnv,
    options: BuildRouterOptions,
) -> Result<BuiltRouter, StartupError> {
    let BuildRouterOptions {
        backend,
        extra_action_specs_factory,
        final_action_specs_factory,
        action_rate_limiters,
        action_rate_limit_max_attempts,
    } = options;
    // Hello-world / smoke-test path: no DB, no spine wiring. Useful for a
    // boot / smoke check before a deploy wires up real PostgreSQL.
    if env.base.database_url.is_none() {
        return Ok(BuiltRouter {
            router: boot_only(&env.base, &FUZ_FORGE_BACKEND_SPEC, SERVER_NAME)?,
            app: None,
        });
    }

    let BootedAppBackend { backend, ready } =
        create_app_backend(&env.base, &FUZ_FORGE_BACKEND_SPEC, backend).await?;
    // the spec embeds a fixture, so the boot built `/ready`
    let ready = ready.unwrap_or_default();
    let app = FuzForgeApp::new(backend, env);

    // The router takes its own handle on the app (every field is an `Arc` or
    // an `Arc`-backed pool), leaving one for `run_app`.
    let router = compose_full_router(
        app.clone(),
        env,
        ready,
        extra_action_specs_factory,
        final_action_specs_factory,
        action_rate_limiters,
        action_rate_limit_max_attempts,
    )?;
    Ok(BuiltRouter {
        router,
        app: Some(app),
    })
}

#[cfg(test)]
mod tests {
    //! The boot-only router composes through the stack (the spine's
    //! `boot_only`, pinned in `fuz_actions`): the forge's env feeds it.

    use std::net::SocketAddr;

    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Request, StatusCode, header};
    use tower::ServiceExt;

    use crate::env::FuzForgeEnv;

    /// The forge env over `origins` (no database: boot-only), with the
    /// wildcard opt-in as given.
    fn env_over(origins: &str, allow_origin_wildcards: bool) -> FuzForgeEnv {
        FuzForgeEnv::from_vars(&|k| match k {
            "FUZ_ALLOWED_ORIGINS" => Some(origins.to_owned()),
            "FUZ_ALLOW_ORIGIN_WILDCARDS" => allow_origin_wildcards.then(|| "true".to_owned()),
            _ => None,
        })
        .expect("the env parses")
    }

    fn options() -> super::BuildRouterOptions {
        super::BuildRouterOptions {
            backend: fuz_actions::server::SpineBackendOptions::production(std::sync::Arc::new(
                fuz_auth::Argon2idHasher::new(),
            )),
            extra_action_specs_factory: None,
            final_action_specs_factory: None,
            action_rate_limiters: fuz_auth::RateLimiterMode::Enforced,
            action_rate_limit_max_attempts: None,
        }
    }

    async fn send(path: &str, origin: Option<&str>) -> (StatusCode, String) {
        let built = super::build_router(&env_over("http://localhost:5173", false), options())
            .await
            .expect("boot-only builds without a database");
        assert!(built.app.is_none());
        let mut builder = Request::builder().uri(path);
        if let Some(origin) = origin {
            builder = builder.header(header::ORIGIN, origin);
        }
        let mut request = builder.body(Body::empty()).expect("the request builds");
        // `serve_with_shutdown` inserts the peer; a `oneshot` has no connection
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:40000"
                .parse::<SocketAddr>()
                .expect("the peer parses"),
        ));
        let response = built
            .router
            .into_router_for_testing()
            .oneshot(request)
            .await
            .expect("the router answers");
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("the body reads");
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    /// The boot-only branch refuses a wildcard allowlist without the opt-in,
    /// as the full boot does, before any database exists — and boots with it.
    #[tokio::test]
    async fn without_a_database_a_wildcard_origin_still_needs_the_opt_in() {
        let refused = super::build_router(&env_over("http://localhost:*", false), options()).await;
        let message = match refused {
            Err(fuz_actions::server::StartupError::Config(message)) => message,
            Err(other) => other.to_string(),
            Ok(_) => String::new(),
        };
        assert!(
            message.starts_with("FUZ_ALLOWED_ORIGINS holds a wildcard entry"),
            "{message:?}"
        );
        let built = super::build_router(&env_over("http://localhost:*", true), options()).await;
        assert!(built.is_ok_and(|built| built.app.is_none()));
    }

    #[tokio::test]
    async fn without_a_database_the_probes_answer_behind_the_origin_check() {
        assert_eq!(
            send("/", None).await,
            (
                StatusCode::OK,
                "fuz_forge_server (rust) — see /health\n".to_owned()
            )
        );
        assert_eq!(send("/health", None).await.0, StatusCode::OK);
        assert_eq!(
            send("/health", Some("http://evil.invalid")).await.0,
            StatusCode::FORBIDDEN
        );
        // the fallback answers the spine's `not found` body, as the full router does
        assert_eq!(
            send("/nope", None).await,
            (StatusCode::NOT_FOUND, "not found\n".to_owned())
        );
    }
}
