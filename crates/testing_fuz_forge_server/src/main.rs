//! `testing_fuz_forge_server` — test-mode `fuz_forge_server` binary.
//!
//! **NEVER ship this in a release.** The binary wires
//! [`fuz_testing::TestingArgon2idHasher`] in place of
//! [`fuz_auth::Argon2idHasher`] so cross-process integration tests hash
//! with a fast test hasher instead of the production argon2 cost, and
//! registers the **whole** `fuz_testing` seam bundle so the upstream
//! cross-backend suites reach the same method set on both forge backends:
//! `_testing_reset` (auth-table wipe + fresh-keeper re-seed),
//! `_testing_drain_effects` (audit barrier), `_testing_flood_notifications`
//! (a burst onto the caller's own socket), `_testing_mint_session`
//! (expired-by-construction session), `_testing_put_fact` (fact-row
//! seeder), `_testing_schema_snapshot`, `_testing_migration_tracker`,
//! `_testing_origin_check` (the origin allowlist's parse and match),
//! `_testing_shorten_credential_expiry` (pull an account's credential expiry
//! in), and — appended last over the assembled registry —
//! `_testing_action_manifest`.
//! It also mounts one forge-local seam of its own,
//! [`create_testing_await_signal_action_spec`], which lets a cross-process
//! test observe whether a client `cancel` reached a handler's signal.
//! The TS twin registers the same set in
//! `src/lib/server/testing_rpc_actions.ts`
//! (`create_fuz_forge_testing_rpc_actions` and
//! `create_fuz_forge_testing_final_rpc_actions`).
//! Three layered guardrails keep this from leaking into production:
//!
//! 1. The build (`gro.config.ts`) and the GitHub release
//!    (`scripts/release.ts`) name their binaries by an exact allowlist, and
//!    `fuzf tool publish` refuses a source binary named `testing_*`.
//! 2. `cargo xtask check-release` walks `cargo metadata` and asserts
//!    no production binary reaches `fuz_testing` through a runtime
//!    dependency. The `testing_fuz_forge_server` crate is a separate
//!    package, so the sibling `fuz_forge_server` package takes
//!    `fuz_testing` only as a dev-dependency for its Postgres suites, an
//!    edge that never reaches `fuzfd` (this crate is `fuz_testing`'s only
//!    runtime dependent).
//! 3. `TestingArgon2idHasher::new` logs `WARN: test-mode argon2 hasher
//!    active` at construction — a sentinel for log-scraping audits.
//!
//! Otherwise it shares the production binary's router composition, tracing
//! init, `run_app` lifecycle, shutdown, and strict command line — except that
//! no arguments serves, as the cross-process harness spawns it (`fuzfd`
//! requires `start`) — and adds the rate-limiter env gates and the env-gated
//! startup DB reset.
//! Production defaults to `127.0.0.1:4041`
//! ([`fuz_forge_server::runtime::DEFAULT_ADDR`]); this binary defaults to
//! `127.0.0.1:4141` so a developer running both locally doesn't
//! collide. Override via `HOST` / `PORT` exactly as the production
//! binary supports.

use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;

use fuz_actions::server::{
    ServerInvocation, SpineBackendOptions, SpineRunOptions, StartCommand, StartupError,
    server_invocation,
};
use fuz_actions::{ActionContext, ActionHandler, ActionSpec};
use fuz_auth::{AuthSpec, CredentialGate};
use fuz_http::{DEFAULT_DRAIN_TIMEOUT, InputShape};
use fuz_testing::{
    create_testing_action_manifest_action_spec, create_testing_flood_notifications_action_spec,
    create_testing_migration_tracker_action_spec, create_testing_mint_session_action_spec,
    create_testing_origin_check_action_spec, create_testing_put_fact_action_spec,
    create_testing_schema_snapshot_action_spec,
    create_testing_shorten_credential_expiry_action_spec, require_daemon_token_from_env,
    testing_backend_options, testing_reset_specs, truncate_reset_state,
};
use serde::Deserialize;
use serde_json::{Value, json};

use fuz_forge_server::router::fuz_forge_migration_namespaces;
use fuz_forge_server::runtime::{
    ExtraActionSpecsFactory, FinalActionSpecsFactory, RunAppOptions, run_app,
};

/// Default loopback bind for the testing binary. Distinct from the
/// production default (`127.0.0.1:4041`) so both binaries can run
/// side-by-side on `localhost` during local development. The
/// cross-process harness can override via `HOST` / `PORT` anyway.
const TESTING_DEFAULT_ADDR: SocketAddr =
    SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 4141);

/// Params for `_testing_await_signal`.
///
/// Twin of the TS
/// `z.strictObject({timeout_ms: z.number().int().positive().max(60_000)})`:
/// `deny_unknown_fields` is the `strictObject`; the field is an `f64` so an
/// integral float (`1e3`, `1.0`) passes the way `z.number().int()` passes it
/// (JSON has one number type), with the handler's `fract() == 0` check the
/// `.int()` and its `1..=60_000` range check the `.positive()` + `.max()`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AwaitSignalParams {
    timeout_ms: f64,
}

/// The inclusive `timeout_ms` bound, mirroring the TS schema's
/// `.positive().max(60_000)`.
const AWAIT_SIGNAL_TIMEOUT_MS_RANGE: std::ops::RangeInclusive<f64> = 1.0..=60_000.0;

/// Build the forge-local `_testing_await_signal` spec.
///
/// Input `{timeout_ms: number}` (an integer in `1..=60_000`, validated the
/// way the TS twin's zod schema validates it), output
/// `{cancelled: boolean}`. The handler races [`ActionContext::signal`]
/// against that timeout and reports which won, so a test can observe from
/// the wire whether a `cancel` notification actually reached the handler's
/// signal — the one thing a cancel's silence hides. Twin of the TS
/// `_testing_await_signal` in `src/lib/server/testing_rpc_actions.ts`.
///
/// **Auth diverges from the `_testing_*` family on purpose.** The rest of
/// the bundle is daemon-token gated (`fuz_testing::TESTING_ACTION_AUTH`),
/// but the cross-process WS transport authenticates the upgrade with a
/// session cookie and carries no way to present a bearer token, so a
/// daemon-token spec is unreachable on the transport this action exists to
/// exercise. It takes the weakest gate that still admits that socket —
/// account-grain, any credential — which on the forge means admin anyway,
/// since the WS upgrade is `require_role(ROLE_ADMIN)`. The action reads no
/// state and writes none; the fence that matters is the binary, which
/// never ships.
fn create_testing_await_signal_action_spec() -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        Box::pin(async move {
            let AwaitSignalParams { timeout_ms } = fuz_http::parse_strict_params(params)?;
            if timeout_ms.fract() != 0.0 || !AWAIT_SIGNAL_TIMEOUT_MS_RANGE.contains(&timeout_ms) {
                return Err(fuz_http::invalid_params(
                    "_testing_await_signal requires an integer timeout_ms in 1..=60000",
                    None,
                ));
            }
            // integral and within 1..=60_000, so the cast is exact
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let timeout_ms = timeout_ms as u64;
            let cancelled = tokio::time::timeout(
                std::time::Duration::from_millis(timeout_ms),
                ctx.signal.cancelled(),
            )
            .await
            .is_ok();
            Ok(json!({ "cancelled": cancelled }))
        })
    });

    // Read-only: the dispatcher hands a pooled client rather than opening a
    // transaction, so parking here holds a pool slot for `timeout_ms` and
    // nothing wider — which is what the range bound above caps.
    ActionSpec::read_only(
        "_testing_await_signal",
        AuthSpec::account_grain(CredentialGate::Any),
        InputShape::Object,
        handler,
    )
}

/// Env var gating the login rate limiters, shared with the TS testing server
/// and `testing_spine_stub`: `FUZ_LOGIN_RATE_LIMIT_ENABLED` (`fuz_app` spells the
/// name `LOGIN_RATE_LIMIT_ENABLED_ENV` in
/// `testing/cross_backend/spine_surface_constants.ts`). One `BackendConfig`
/// option drives both impls, so no new name is minted here.
const LOGIN_RATE_LIMIT_ENABLED_ENV: &str = "FUZ_LOGIN_RATE_LIMIT_ENABLED";

/// Env var gating the action rate limiters — `fuz_app`'s
/// `ACTION_RATE_LIMIT_ENABLED_ENV`, read by the TS testing server and
/// `testing_spine_stub` too.
const ACTION_RATE_LIMIT_ENABLED_ENV: &str = "FUZ_ACTION_RATE_LIMIT_ENABLED";

/// Env var replacing both action limiters' `max_attempts` — `fuz_app`'s
/// `ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV`, read by the TS testing server and
/// `testing_spine_stub` too.
const ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV: &str = "FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS";

/// Read a limiter gate through `fuz_sys::env::parse_stringbool`'s closed set.
/// Unset is `false`; an unrecognized value is a startup error, never a silent
/// `false` — the twin of the TS testing server's `EnvStringbool` parse.
fn parse_gate(name: &str, raw: Option<&str>) -> Result<bool, StartupError> {
    let Some(raw) = raw else { return Ok(false) };
    fuz_sys::env::parse_stringbool(raw).map_err(|e| StartupError::Config(format!("{name}: {e}")))
}

/// The mode a gate selects.
const fn gate_mode(enabled: bool) -> fuz_auth::RateLimiterMode {
    if enabled {
        fuz_auth::RateLimiterMode::Enforced
    } else {
        fuz_auth::RateLimiterMode::DisabledForTesting
    }
}

/// Pick the auth limiters' (login, signup) mode from the login env gate.
///
/// Off by default (`DisabledForTesting`) — the standard cross-process suites
/// fire hundreds of logins from one host, far past the 5-per-15-min per-IP
/// budget. The `cross_backend_login_security_*` projects spawn this binary with
/// the gate on, because the suite they run drives the 429 wire shape and the
/// `X-Forwarded-For` bucket keying over a real socket, which needs the limiters
/// **enforced**. Mirrors `testing_spine_stub`'s `enable_login_rate_limit`. Twin
/// of the TS testing server's `resolve_testing_login_rate_limiter_mode`.
///
/// # Errors
///
/// [`StartupError::Config`] when the var is set to something outside
/// `fuz_sys::env::parse_stringbool`'s closed set.
fn resolve_login_rate_limiter_mode(
    raw: Option<&str>,
) -> Result<fuz_auth::RateLimiterMode, StartupError> {
    let enabled = parse_gate(LOGIN_RATE_LIMIT_ENABLED_ENV, raw)?;
    if enabled {
        tracing::info!("login rate limiting enabled (5/15min per-IP, 10/30min per-account)");
    }
    Ok(gate_mode(enabled))
}

/// The action limiters' mode and optional cap, for
/// [`RunAppOptions::action_rate_limiters`] and
/// [`RunAppOptions::action_rate_limit_max_attempts`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ActionRateLimitGate {
    mode: fuz_auth::RateLimiterMode,
    max_attempts: Option<u32>,
}

/// Pick the action limiters' mode and cap from the action env pair.
///
/// Off by default, for the same reason as the login gate. On, the forge's
/// action limiters are built — one per-IP and one per-account, shared by the
/// dispatcher on both transports and the spine's auth spec set — with the cap
/// replacing both `max_attempts` when given, so the action rate-limit cross
/// suite reaches the throttle in a few calls. A cap is a positive integer
/// (`raw.trim().parse::<u32>()`, then `> 0`), and one set without the gate is
/// refused — a cap that silently does nothing would leave a suite asserting a
/// throttle the binary never built. Mirrors `testing_spine_stub`'s
/// `parse_action_rate_limit_max_attempts`. Twin of the TS testing server's
/// `resolve_testing_action_rate_limiters`.
///
/// # Errors
///
/// [`StartupError::Config`] on an unrecognized gate value, a malformed or
/// non-positive cap, or a cap without the gate.
fn resolve_action_rate_limits(
    enabled_raw: Option<&str>,
    max_attempts_raw: Option<&str>,
) -> Result<ActionRateLimitGate, StartupError> {
    let enabled = parse_gate(ACTION_RATE_LIMIT_ENABLED_ENV, enabled_raw)?;
    let max_attempts = match max_attempts_raw {
        None => None,
        Some(raw) => {
            let max_attempts = raw
                .trim()
                .parse::<u32>()
                .ok()
                .filter(|n| *n > 0)
                .ok_or_else(|| {
                    StartupError::Config(format!(
                        "{ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV}: expected a positive integer, got {raw:?}"
                    ))
                })?;
            if !enabled {
                return Err(StartupError::Config(format!(
                    "{ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV} is set but {ACTION_RATE_LIMIT_ENABLED_ENV} is not"
                )));
            }
            Some(max_attempts)
        }
    };
    if enabled {
        tracing::info!(
            max_attempts = ?max_attempts,
            "action rate limiting enabled (one IP + one account limiter shared by RPC, WS, and the auth families)"
        );
    }
    Ok(ActionRateLimitGate {
        mode: gate_mode(enabled),
        max_attempts,
    })
}

#[tokio::main]
async fn main() -> ExitCode {
    // The production binary's strict command line (no arguments serves, as
    // the cross-process harness spawns it), refused before the env is read.
    let invocation = match server_invocation("testing_fuzfd", StartCommand::Implicit) {
        Ok(invocation) => invocation,
        Err(exit) => return exit,
    };

    // Non-blocking stdout logging so a stalled stdout consumer can't starve
    // the async runtime. `_log_guard` must stay live for the whole process.
    let _log_guard = fuz_sys::logging::init_non_blocking_stdout(
        "info,fuz_forge_server=info,testing_fuz_forge_server=info",
    );

    if invocation == ServerInvocation::DbStatus {
        return fuz_db::status::run_db_status_cli(&fuz_forge_migration_namespaces()).await;
    }

    // Always-visible startup sentinel — survives any RUST_LOG filter that
    // would suppress `info!`. The sister `WARN: test-mode argon2 hasher
    // active` line is emitted by `TestingArgon2idHasher::new` itself.
    eprintln!("testing_fuz_forge_server starting (test-mode argon2 active)");

    // Daemon-token credential for `_testing_reset`. `fuz_testing` owns the
    // only producer of this credential — `fuz_forge_server` cannot mint one —
    // so the test binary constructs it here and injects the handle. The
    // cross-process `BackendConfig` sets this var. Unset is a configuration
    // error: `_testing_reset` authenticates with it.
    let daemon_token_state = match require_daemon_token_from_env("FUZ_FORGE_DAEMON_TOKEN_DIR").await
    {
        Ok(state) => state,
        Err(e) => return fuz_sys::cli::report_failure(&e, e.hint(), e.exit_code()),
    };

    // The seam bundle, minus the manifest (which needs the assembled registry
    // and so rides `final_specs_factory` below). Each entry's own note is
    // inline; the long one belongs to `_testing_reset`, whose domain-state
    // callback truncates fuz_forge's cell + fact tables on the **reset
    // transaction's** `ActionDb` (mirrors the TS `reset_state(db)`): the
    // spine's `CELL_DROP_TABLES` and `FACT_DROP_TABLES`, the set the TS
    // `fuz_forge_domain_truncate_tables` names (`fact_holder` beside the rest,
    // where the TS list leaves it to its `fact` FK under `CASCADE`). There's no
    // separate file table — the forge is cell-primary, so file metadata is a
    // cell and bytes are facts. Keeping this in lockstep with the TS list
    // matters even though `memo` is currently unwritten: the instant either
    // backend populates it, a missing entry here would leak rows across tests
    // on one backend only. `_testing_drain_effects` rides with the reset; the
    // `audit_inflight_tracking` the test backend options turn on is what gives
    // it something to await (the TS twin builds its emitter with
    // `track_inflight: true` for the same reason).
    let extra_specs_factory: ExtraActionSpecsFactory = Box::new(move |_app, runtime| {
        let mut specs = testing_reset_specs(
            &runtime,
            Some(truncate_reset_state(
                &[fuz_cell::CELL_DROP_TABLES, fuz_fact::FACT_DROP_TABLES].concat(),
            )),
        )?;
        specs.extend([
            // `_testing_flood_notifications` — queue a burst of notifications
            // onto the caller's own WebSocket connection inside one handler
            // poll, so a suite can push a connection's outbound queue past its
            // byte budget; over HTTP it refuses (no connection to queue onto).
            // fuz_app's `create_testing_actions` bundles the TS twin.
            create_testing_flood_notifications_action_spec(),
            // `_testing_mint_session` — forge an expired-by-construction
            // server-side session (backdated `auth_session` row behind a
            // still-valid cookie) for the expiry conformance principal.
            create_testing_mint_session_action_spec(
                Arc::clone(&runtime.keyring),
                runtime.session_cookie_name,
            ),
            // `_testing_put_fact` — seed a fact row (embedded, or external by
            // URL) for suites that drive over real HTTP and hold no
            // `FactStoreHandle`.
            create_testing_put_fact_action_spec(),
            create_testing_schema_snapshot_action_spec(),
            // `_testing_migration_tracker` — dump the `schema_version` rows for
            // the cross-impl migration-identity gate (the provenance half the
            // schema snapshot excludes by design).
            create_testing_migration_tracker_action_spec(),
            // `_testing_origin_check` — answer the origin allowlist's parse and
            // match for the shared conformance table; the TS twin mounts
            // fuz_app's `create_testing_origin_check_action`.
            create_testing_origin_check_action_spec(),
            // `_testing_shorten_credential_expiry` — pull an account's session
            // and token expiry in, for the credential-deadline close; the TS
            // twin mounts fuz_app's `create_testing_shorten_credential_expiry_action`.
            create_testing_shorten_credential_expiry_action_spec(),
            create_testing_await_signal_action_spec(),
        ]);
        Ok(specs)
    });

    // `_testing_action_manifest` — appended over the **assembled** registry so
    // it enumerates every method mounted above it plus its own descriptor.
    // Can't ride `extra_specs_factory` (that one sees only its own inputs),
    // hence the dedicated last-position seam; the twin of
    // `testing_spine_stub`'s inline
    // `create_testing_action_manifest_action_spec(&specs)` push and of the TS
    // `create_testing_action_manifest_action(actions)`.
    let final_specs_factory: FinalActionSpecsFactory =
        Box::new(|mounted| vec![create_testing_action_manifest_action_spec(mounted)]);

    let env_var = |name: &str| std::env::var(name).ok();
    let limits = resolve_login_rate_limiter_mode(env_var(LOGIN_RATE_LIMIT_ENABLED_ENV).as_deref())
        .and_then(|rate_limiters| {
            resolve_action_rate_limits(
                env_var(ACTION_RATE_LIMIT_ENABLED_ENV).as_deref(),
                env_var(ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV).as_deref(),
            )
            .map(|action| (rate_limiters, action))
        });
    let (rate_limiters, action_rate_limits) = match limits {
        Ok(limits) => limits,
        Err(e) => return fuz_sys::cli::report_failure(&e, e.hint(), e.exit_code()),
    };

    let result = run_app(RunAppOptions {
        spine: SpineRunOptions {
            backend: SpineBackendOptions {
                // Twin of the TS testing server's `create_testing_wiring`
                // resolving fuz_app's `rate_limiters` option to
                // `'disabled_for_testing'`, except for the login-security cross
                // project — see `resolve_login_rate_limiter_mode`.
                rate_limiters,
                ..testing_backend_options(daemon_token_state)
            },
            default_addr: TESTING_DEFAULT_ADDR,
            drain_timeout: DEFAULT_DRAIN_TIMEOUT,
        },
        extra_action_specs_factory: Some(extra_specs_factory),
        final_action_specs_factory: Some(final_specs_factory),
        // Twin of the TS testing server's explicit action limiters: off unless
        // the action gate asks, then capped — see `resolve_action_rate_limits`.
        action_rate_limiters: action_rate_limits.mode,
        action_rate_limit_max_attempts: action_rate_limits.max_attempts,
    })
    .await;
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => fuz_sys::cli::report_failure(&e, e.hint(), e.exit_code()),
    }
}

#[cfg(test)]
mod tests {
    use super::{ActionRateLimitGate, resolve_action_rate_limits, resolve_login_rate_limiter_mode};

    const ENFORCED: fuz_auth::RateLimiterMode = fuz_auth::RateLimiterMode::Enforced;
    const DISABLED: fuz_auth::RateLimiterMode = fuz_auth::RateLimiterMode::DisabledForTesting;

    #[test]
    fn the_login_gate_reads_the_stringbool_set() {
        assert_eq!(resolve_login_rate_limiter_mode(None).ok(), Some(DISABLED));
        assert_eq!(
            resolve_login_rate_limiter_mode(Some("true")).ok(),
            Some(ENFORCED)
        );
        assert_eq!(
            resolve_login_rate_limiter_mode(Some("off")).ok(),
            Some(DISABLED)
        );
        assert!(resolve_login_rate_limiter_mode(Some("ture")).is_err());
    }

    #[test]
    fn the_action_limits_are_off_unless_gated() {
        let off = ActionRateLimitGate {
            mode: DISABLED,
            max_attempts: None,
        };
        assert_eq!(resolve_action_rate_limits(None, None).ok(), Some(off));
        assert_eq!(
            resolve_action_rate_limits(Some("false"), None).ok(),
            Some(off)
        );
    }

    #[test]
    fn the_action_gate_enforces_with_an_optional_cap() {
        assert_eq!(
            resolve_action_rate_limits(Some("true"), None).ok(),
            Some(ActionRateLimitGate {
                mode: ENFORCED,
                max_attempts: None
            })
        );
        assert_eq!(
            resolve_action_rate_limits(Some("1"), Some(" 6 ")).ok(),
            Some(ActionRateLimitGate {
                mode: ENFORCED,
                max_attempts: Some(6)
            })
        );
    }

    #[test]
    fn a_bad_action_pair_refuses_to_start() {
        // a cap without the gate would do nothing
        assert!(resolve_action_rate_limits(None, Some("6")).is_err());
        assert!(resolve_action_rate_limits(Some("false"), Some("6")).is_err());
        for cap in ["0", "-1", "", "six", "4294967296"] {
            assert!(
                resolve_action_rate_limits(Some("true"), Some(cap)).is_err(),
                "{cap}"
            );
        }
        assert!(resolve_action_rate_limits(Some("enable"), None).is_err());
    }
}
