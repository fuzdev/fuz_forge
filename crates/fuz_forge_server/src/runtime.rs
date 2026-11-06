//! [`run_app`] — the `fuz_forge_server` lifecycle.
//!
//! Over the spine's server toolkit (`fuz_actions::server`): env load, signal
//! handler, router build, listener bind, the upkeep tasks
//! ([`upkeep_options`]), graceful drain — so the production `fuzfd`'s
//! `main.rs` and `testing_fuz_forge_server`'s `main.rs` collapse to a
//! tracing-init + swap-point selection + `run_app` call.

use std::net::SocketAddr;

use fuz_actions::server::{
    ServeOptions, SpineRunOptions, StartupError, UpkeepOptions, serve_until_shutdown,
};

use crate::app::FuzForgeApp;
use crate::env::FuzForgeEnv;
use crate::router::{BuildRouterOptions, BuiltRouter, build_router};

/// The name the forge's sentinels and `GET /` carry.
pub const SERVER_NAME: &str = "fuz_forge_server";

/// Default loopback bind for the production binary — `HOST` / `PORT` override
/// either half.
pub const DEFAULT_ADDR: SocketAddr =
    SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 4041);

/// The forge's concrete instantiation of
/// [`fuz_actions::ExtraActionSpecsFactory`] over [`FuzForgeApp`] — extra specs
/// folded in after the standard fuz_forge set.
///
/// Production passes `None`; the `testing_fuz_forge_server` binary passes
/// `Some(_)` to inject `_testing_reset`, closing over `fuz_testing` types in
/// its own process so the production graph stays clean
/// (`cargo xtask check-release`).
pub type ExtraActionSpecsFactory = fuz_actions::ExtraActionSpecsFactory<FuzForgeApp>;

/// Factory that builds action specs over the **assembled** spec list, run
/// after [`ExtraActionSpecsFactory`].
///
/// The seam `_testing_action_manifest` needs: that spec dumps the live RPC
/// method set, so it must be built from every spec mounted above it —
/// something [`ExtraActionSpecsFactory`] can't do (it sees only its own
/// inputs). `testing_spine_stub` gets this for free by assembling its specs
/// inline; a consumer server assembles them behind `build_router`, so the
/// last-position hook is the equivalent. Twin of the TS
/// `ServerTestingOptions.final_rpc_actions_factory`.
///
/// Production passes `None`; the `testing_fuz_forge_server` binary passes
/// `Some(_)`, closing over `fuz_testing` in its own process so the production
/// graph stays clean (`cargo xtask check-release`).
pub type FinalActionSpecsFactory =
    Box<dyn FnOnce(&[fuz_actions::ActionSpec]) -> Vec<fuz_actions::ActionSpec> + Send>;

/// Options for [`run_app`].
///
/// The spine's shared run options plus the forge's own swap points.
#[allow(missing_debug_implementations)] // Arc-of-dyn + boxed-closure fields
pub struct RunAppOptions {
    /// The spine's swap points. Production: the [`fuz_auth::Argon2idHasher`],
    /// [`DEFAULT_ADDR`], [`fuz_http::DEFAULT_DRAIN_TIMEOUT`], the auth limiters
    /// (login, signup) enforced, no daemon token, no hook, no in-flight audit
    /// tracking. The `testing_fuz_forge_server` binary: the fast test hasher,
    /// `127.0.0.1:4141` (so both can run side by side), the auth limiters
    /// `DisabledForTesting` unless its login env gate asks for `Enforced` (the
    /// twin of the TS testing server's `create_testing_wiring`, `app_assembly.ts`
    /// — a host firing many signup/login round-trips per backend lifetime
    /// would trip the 5-per-15-min per-IP login budget), the daemon-token
    /// state `_testing_reset` resolves the keeper through, the env-gated
    /// schema wipe, and in-flight tracking so `_testing_drain_effects` is a
    /// real barrier (the TS testing server's `track_inflight: true`).
    pub spine: SpineRunOptions,
    /// Factory injecting extra action specs after the standard set.
    /// Production: `None`. Test binary: `Some(_)` for `_testing_reset`.
    pub extra_action_specs_factory: Option<ExtraActionSpecsFactory>,
    /// Factory injecting action specs built **from** the assembled spec list.
    /// Production: `None`. Test binary: `Some(_)` for
    /// `_testing_action_manifest`, which must enumerate every method mounted
    /// above it.
    pub final_action_specs_factory: Option<FinalActionSpecsFactory>,
    /// Whether the two action rate limiters (per-IP and per-account, shared by
    /// the dispatcher on both transports and the spine's auth spec set) are
    /// built. Production: [`fuz_auth::RateLimiterMode::Enforced`]. Test
    /// binary: `DisabledForTesting` unless its action env gate asks for
    /// `Enforced` — the twin of the TS testing server passing
    /// `action_ip_rate_limiter` / `action_account_rate_limiter` to
    /// `create_app_server` from the same gate.
    pub action_rate_limiters: fuz_auth::RateLimiterMode,
    /// Replaces both action limiters' `max_attempts` (the windows and key
    /// bounds stay the spine defaults). Production: `None` — the defaults
    /// pinned by `src/test/fixtures/parity/rate_limits.json`. Test binary: the
    /// action env cap, so a cross suite reaches the throttle in a few calls.
    pub action_rate_limit_max_attempts: Option<u32>,
}

/// The upkeep [`run_app`] runs beside the server, each task a pass now and
/// then one per interval until shutdown:
///
/// - the spine's auth cleanup ([`fuz_auth::spawn_auth_cleanup`]): expired
///   sessions deleted and the connections they opened closed (through the
///   app's closer, over the sockets and the audit streams), expired
///   role-grant offers audited once (through the app's emitter, so the expiry
///   audits reach the admin audit streams), every
///   [`fuz_auth::DEFAULT_AUTH_CLEANUP_INTERVAL`];
/// - the fact store's orphan-temp sweeper
///   ([`fuz_fact::spawn_orphan_temp_sweeper`]) over the facts root, every
///   [`fuz_fact::ORPHAN_TEMP_SWEEP_INTERVAL`]: the crash backstop for the
///   streaming-upload temps (`.tmp/*`).
///
/// `auth_cleanup` is the app's ([`fuz_actions::server::AppBackend::auth_cleanup_options`]):
/// its emitter, so the expiry audits reach the admin audit streams, and its
/// closer, over the sockets and the streams.
#[must_use]
pub fn upkeep_options(
    auth_cleanup: fuz_auth::AuthCleanupOptions,
    fact_store_root: std::path::PathBuf,
) -> UpkeepOptions {
    UpkeepOptions {
        auth_cleanup,
        extra: vec![Box::new(move |shutdown| {
            fuz_fact::spawn_orphan_temp_sweeper(fact_store_root, shutdown)
        })],
    }
}

/// Run the `fuz_forge_server` lifecycle to completion.
///
/// Reads the env, installs the SIGINT/SIGTERM handler, builds the router via
/// [`build_router`], and serves until the signal
/// ([`fuz_actions::server::serve_until_shutdown`]): every live WebSocket is
/// closed with 1001 and every audit stream ended, then in-flight requests
/// drain. With a database, the upkeep ([`upkeep_options`]) runs beside the
/// server, from the bind until shutdown begins, and is joined before this
/// returns. `serve_with_shutdown` inserts `ConnectInfo<SocketAddr>` into every
/// request — the `/internal/*` callback routes gate on a loopback peer
/// (defense-in-depth alongside the per-repo secret; see
/// `crate::internal_routes`).
///
/// Every configuration knob lives on [`RunAppOptions`]; everything not named
/// there flows from the process environment via [`FuzForgeEnv`].
///
/// # Errors
///
/// [`StartupError`] for env or config failures, database connectivity or
/// migration failures, a database not at READ COMMITTED, and bind or serve
/// failures.
pub async fn run_app(options: RunAppOptions) -> Result<(), StartupError> {
    let RunAppOptions {
        spine:
            SpineRunOptions {
                backend,
                default_addr,
                drain_timeout,
            },
        extra_action_specs_factory,
        final_action_specs_factory,
        action_rate_limiters,
        action_rate_limit_max_attempts,
    } = options;

    let env = FuzForgeEnv::from_process()?;
    let addr = env.base.bind_addr(default_addr)?;
    let shutdown = fuz_http::shutdown_token();

    let BuiltRouter { router, app } = build_router(
        &env,
        BuildRouterOptions {
            backend,
            extra_action_specs_factory,
            final_action_specs_factory,
            action_rate_limiters,
            action_rate_limit_max_attempts,
        },
    )
    .await?;

    serve_until_shutdown(
        router,
        ServeOptions {
            server_name: SERVER_NAME,
            addr,
            drain_timeout,
            shutdown,
            connection_closer: app.as_ref().map(|app| app.backend.connection_closer()),
            upkeep: app.as_ref().map(|app| {
                upkeep_options(app.backend.auth_cleanup_options(), env.fact_store_root())
            }),
        },
    )
    .await
}
