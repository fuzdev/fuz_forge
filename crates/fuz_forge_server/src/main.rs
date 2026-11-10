//! `fuz_forge_server` production binary.
//!
//! Thin entry point — wires [`fuz_auth::Argon2idHasher`] (the production
//! argon2 cost) and hands off to
//! [`fuz_forge_server::runtime::run_app`] which owns the full server
//! lifecycle (env, signal handler, router build, listener bind, drain).
//!
//! The `testing_fuz_forge_server` binary in `crates/testing_fuz_forge_server/`
//! ships the same lifecycle with `fuz_testing::TestingArgon2idHasher`
//! swapped in, a fast test hasher, during cross-process integration tests.
//!
//! Two commands, one of which is required: `fuzfd start` runs the server in
//! the foreground, configured by the process environment alone (the service
//! units pass `start`). `--help` / `-h` prints usage and exits `0`; anything
//! else — no command, an unknown one, an extra argument — prints usage to
//! stderr and exits `2`, so a typo never boots a server.
//!
//! The `db-status` subcommand (`fuzfd db-status`) is the read-only
//! migration-tracker report — connectivity, table row counts, and per-namespace
//! applied/pending migration state (spine + the `fuz_forge` namespace), with
//! name-divergence detection. Delegates to the shared
//! [`fuz_db::status::run_db_status_cli`]; the Rust twin of the TS `npm run
//! db:status`. Safe in any environment; it never mutates.

use std::process::ExitCode;
use std::sync::Arc;

use fuz_actions::server::{
    ServerInvocation, SpineBackendOptions, SpineRunOptions, StartCommand, server_invocation,
};
use fuz_auth::{Argon2idHasher, PasswordHasher};

use fuz_forge_server::router::fuz_forge_migration_namespaces;
use fuz_forge_server::runtime::{DEFAULT_ADDR, RunAppOptions, run_app};

/// The auth limiters' (login, signup) mode in production —
/// enforced, at the spine's default bounds.
const PRODUCTION_RATE_LIMITERS: fuz_auth::RateLimiterMode = fuz_auth::RateLimiterMode::Enforced;

/// The action limiters' mode in production — enforced, the twin of the TS
/// `create_testing_wiring`'s production bundle.
const PRODUCTION_ACTION_RATE_LIMITERS: fuz_auth::RateLimiterMode =
    fuz_auth::RateLimiterMode::Enforced;

/// The action limiters' `max_attempts` cap in production — none, so the bounds
/// are the spine defaults pinned by `src/test/fixtures/parity/rate_limits.json`.
/// Only the test binary sets one.
const PRODUCTION_ACTION_RATE_LIMIT_MAX_ATTEMPTS: Option<u32> = None;

#[tokio::main]
async fn main() -> ExitCode {
    let invocation = match server_invocation("fuzfd", StartCommand::Required) {
        Ok(invocation) => invocation,
        Err(exit) => return exit,
    };

    // Non-blocking stdout logging so a stalled stdout consumer can't starve
    // the async runtime. `_log_guard` must stay live for the whole process;
    // the helper `try_init`s, so a pre-installed subscriber (tests) is a
    // silent no-op. Returning `ExitCode` (rather than `std::process::exit`)
    // lets this guard drop and flush its final records on the error path.
    let _log_guard = fuz_sys::logging::init_non_blocking_stdout("info,fuz_forge_server=info");

    // `db-status` ops subcommand — read-only migration report via the shared
    // spine helper. Diverges before `run_app`; needs no password hasher.
    if invocation == ServerInvocation::DbStatus {
        return fuz_db::status::run_db_status_cli(&fuz_forge_migration_namespaces()).await;
    }

    let password_hasher: Arc<dyn PasswordHasher> = Arc::new(Argon2idHasher::new());

    let result = run_app(RunAppOptions {
        spine: SpineRunOptions {
            backend: SpineBackendOptions {
                rate_limiters: PRODUCTION_RATE_LIMITERS,
                // No daemon-token auth in production: nothing sends
                // `X-Daemon-Token` (the CLI authenticates with API tokens), and
                // the credential's producer lives in `fuz_testing`, which this
                // binary must never link. No hook, and no in-flight audit
                // tracking: the counter exists only so the test binary's
                // `_testing_drain_effects` can await detached audit writes.
                ..SpineBackendOptions::production(password_hasher)
            },
            default_addr: DEFAULT_ADDR,
            drain_timeout: fuz_http::DEFAULT_DRAIN_TIMEOUT,
        },
        extra_action_specs_factory: None,
        final_action_specs_factory: None,
        action_rate_limiters: PRODUCTION_ACTION_RATE_LIMITERS,
        action_rate_limit_max_attempts: PRODUCTION_ACTION_RATE_LIMIT_MAX_ATTEMPTS,
    })
    .await;
    match result {
        Ok(()) => ExitCode::SUCCESS,
        // Config/env failures exit `2`, runtime failures `1`
        // (`StartupError::exit_code`).
        Err(e) => fuz_sys::cli::report_failure(&e, e.hint(), e.exit_code()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Production enforces every limiter at the spine defaults — the test
    /// binary's gates and cap never reach it.
    #[test]
    fn production_enforces_every_limiter_uncapped() {
        assert_eq!(
            PRODUCTION_RATE_LIMITERS,
            fuz_auth::RateLimiterMode::Enforced
        );
        assert_eq!(
            PRODUCTION_ACTION_RATE_LIMITERS,
            fuz_auth::RateLimiterMode::Enforced
        );
        assert_eq!(PRODUCTION_ACTION_RATE_LIMIT_MAX_ATTEMPTS, None);
    }
}
