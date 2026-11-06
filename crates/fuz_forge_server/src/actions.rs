//! fuz_forge-specific RPC action specs.
//!
//! Composes the fuz_forge-specific `request_response` actions from the TS
//! handler modules under `src/lib/server/routes/` + `action_specs.ts` into
//! [`fuz_actions::ActionSpec`] rows for the unified registry. The generic
//! cell surface (cell CRUD + grants + fields + items + audit) is mounted
//! separately from `fuz_cell` in [`crate::router`].
//!
//! ## Provisioning/deployment actions OMITTED
//!
//! The forge delegates its own provisioning and deployment to the
//! standalone `zap` CLI; it carries no convergence engine. No
//! run/host/apply method (`fuz_forge_apply`, `fuz_forge_plan`,
//! `fuz_forge_run_*`, `fuz_forge_host_*`) is registered here; a test pins a
//! sentinel name from each.
//!
//! ## Actions INCLUDED
//!
//! - `fuz_forge_repo_list`, `fuz_forge_repo_get` — repo cell reads (the
//!   `repos/<slug>` cells with the top-level `cell.kind = 'repo'`, no hub;
//!   `id` is the cell-id UUID).
//! - `fuz_forge_repo_log`, `fuz_forge_repo_commit`, `fuz_forge_repo_refs`,
//!   `fuz_forge_repo_tree`, `fuz_forge_repo_blob` — subprocess wrappers around
//!   `git log` / `git show` / `git for-each-ref` / `git ls-tree` /
//!   `git cat-file` via [`crate::subprocess::spawn_collect`].
//! - `fuz_forge_repo_create`, `fuz_forge_repo_resync`,
//!   `fuz_forge_repo_rotate_secret` — repo mutations (bare-repo init + cell
//!   create, default-branch tip re-read, hook-secret rotation).
//! - `fuz_forge_token_create_scoped`, `fuz_forge_token_policy_list` — scoped API
//!   token CRUD.
//!
//! ## Rate limiting
//!
//! These specs declare [`RateLimitClass::Account`] — the three
//! credential-lifecycle / mutation surfaces (`fuz_forge_repo_rotate_secret`,
//! `fuz_forge_repo_create`, `fuz_forge_token_create_scoped`) and the token
//! enumeration surface (`fuz_forge_token_policy_list`) — matching the
//! `rate_limit: 'account'` markings on their TS twins in
//! `src/lib/action_specs.ts`. The dispatcher consults the class in
//! `fuz_actions::perform_action` against the account limiter wired into the
//! RPC + WS states by [`crate::router`] (one budget across both transports).
//! The repo *reads* stay unclassed on both backends, for parity with the TS
//! specs; `fuz_forge_token_policy_list` carries a class despite being a read
//! because it is an enumeration oracle over the account's policies. The five
//! subprocess-backed reads are the open question on both backends: each forks
//! `git`; `fuz_forge_repo_tree` / `fuz_forge_repo_blob` collect up to 5 MB of
//! output per call, and `fuz_forge_repo_commit` forks twice (1 MB of metadata
//! + a 5 MB diff — `forge_git::read`'s byte caps).
//!
//! The gate ordering matches across the two backends: both dispatchers run
//! 401 → authorization → 403 → **429** → 400, so a class declared here is
//! charged ahead of input validation on either. Throttle-before-validate is
//! deliberate on both sides (`fuz_actions::perform_action`, fuz_app's
//! `perform_action`) — a flood of malformed bodies costs the sender its
//! budget instead of slipping past the limiter on a cheap 400, and a
//! throttled caller is answered 429 rather than a `-32602` describing the
//! input shape of a method the gates refuse it. The
//! `action_throttle_order` cross-backend case pins that 429/400 adjacency
//! against both backends, spending a full per-account budget on a dedicated
//! account.

// TODO: settle a rate-limit class for the subprocess-backed repo reads
// (`log`/`commit`/`refs`/`tree`/`blob`) — TS and Rust must move together

use std::sync::Arc;

use futures::future::FutureExt;
use fuz_actions::{ActionContext, ActionHandler, ActionSpec};
use fuz_auth::{AuthSpec, CredentialGate, ROLE_ADMIN, RateLimitClass};
use fuz_http::{InputShape, JsonrpcError};
use serde_json::Value;

use crate::app::FuzForgeApp;
use crate::handlers;

/// Build the full list of fuz_forge-specific RPC action specs.
///
/// Composes alongside the spine's standard actions:
///
/// ```ignore
/// let specs = build_account_specs(audit, closer)
///     .into_iter()
///     .chain(build_admin_specs(audit, closer, roles))
///     .chain(PROTOCOL_ACTION_SPECS.iter().map(...))
///     .chain(fuz_forge_action_specs::all(&app))
///     .collect();
/// let registry = ActionRegistry::compile(specs)?;
/// ```
#[must_use]
pub fn all(app: &FuzForgeApp) -> Vec<ActionSpec> {
    let app = Arc::new(app.clone());
    vec![
        // ─── repo cell reads ───
        ActionSpec::read_only(
            "fuz_forge_repo_list",
            admin_auth(),
            InputShape::Object,
            wrap(Arc::clone(&app), handlers::fuz_forge_repo_list),
        ),
        ActionSpec::read_only(
            "fuz_forge_repo_get",
            admin_auth(),
            InputShape::Object,
            wrap(Arc::clone(&app), handlers::fuz_forge_repo_get),
        ),
        // ─── repo subprocess wrappers ───
        ActionSpec::read_only(
            "fuz_forge_repo_log",
            admin_auth(),
            InputShape::Object,
            wrap(Arc::clone(&app), handlers::fuz_forge_repo_log),
        ),
        ActionSpec::read_only(
            "fuz_forge_repo_commit",
            admin_auth(),
            InputShape::Object,
            wrap(Arc::clone(&app), handlers::fuz_forge_repo_commit),
        ),
        ActionSpec::read_only(
            "fuz_forge_repo_refs",
            admin_auth(),
            InputShape::Object,
            wrap(Arc::clone(&app), handlers::fuz_forge_repo_refs),
        ),
        ActionSpec::read_only(
            "fuz_forge_repo_tree",
            admin_auth(),
            InputShape::Object,
            wrap(Arc::clone(&app), handlers::fuz_forge_repo_tree),
        ),
        ActionSpec::read_only(
            "fuz_forge_repo_blob",
            admin_auth(),
            InputShape::Object,
            wrap(Arc::clone(&app), handlers::fuz_forge_repo_blob),
        ),
        // ─── repo mutations ───
        ActionSpec::with_side_effects(
            "fuz_forge_repo_create",
            admin_auth(),
            InputShape::Object,
            wrap(Arc::clone(&app), handlers::fuz_forge_repo_create),
        )
        .with_rate_limit(RateLimitClass::Account),
        ActionSpec::with_side_effects(
            "fuz_forge_repo_resync",
            admin_auth(),
            InputShape::Object,
            wrap(Arc::clone(&app), handlers::fuz_forge_repo_resync),
        ),
        // Session-only: a leaked api_token must not rotate the hook secret
        // and lock the daemon out (mirrors `fuz_forge_token_create_scoped`).
        ActionSpec::with_side_effects(
            "fuz_forge_repo_rotate_secret",
            session_admin_auth(),
            InputShape::Object,
            wrap(Arc::clone(&app), handlers::fuz_forge_repo_rotate_secret),
        )
        .with_rate_limit(RateLimitClass::Account),
        // ─── scoped token CRUD (session-only) ───
        ActionSpec::with_side_effects(
            "fuz_forge_token_create_scoped",
            session_admin_auth(),
            InputShape::Object,
            wrap(Arc::clone(&app), handlers::fuz_forge_token_create_scoped),
        )
        .with_rate_limit(RateLimitClass::Account),
        ActionSpec::read_only(
            "fuz_forge_token_policy_list",
            session_admin_auth(),
            InputShape::Object,
            wrap(app, handlers::fuz_forge_token_policy_list),
        )
        .with_rate_limit(RateLimitClass::Account),
    ]
}

/// Auth spec for the most common shape: session OR api_token, admin role.
///
/// [`CredentialGate::Any`] is deliberate, not a default — `fuzf`'s repo
/// commands drive these methods over `Authorization: Bearer`, so narrowing
/// this gate would break the CLI. Least privilege on that channel is the
/// scoped-token policy ([`crate::token_policy`]), which bounds *which* methods
/// a given token may call.
#[must_use]
const fn admin_auth() -> AuthSpec {
    AuthSpec::authenticated_gated(CredentialGate::Any, &[ROLE_ADMIN])
}

/// Session-only admin: rejects api_token / daemon_token credentials.
#[must_use]
const fn session_admin_auth() -> AuthSpec {
    AuthSpec::authenticated_gated(CredentialGate::SESSION_ONLY, &[ROLE_ADMIN])
}

/// Wrap a typed handler fn into the type-erased [`ActionHandler`].
///
/// Captures an [`Arc<FuzForgeApp>`] via clone so the closure stays `Send +
/// Sync + 'static`. The handler fn signature is
/// `async fn(Arc<FuzForgeApp>, Value, ActionContext<'_>) -> Result<Value, JsonrpcError>`
/// — see [`crate::handlers`] for the per-method bodies.
fn wrap<F>(app: Arc<FuzForgeApp>, handler: F) -> ActionHandler
where
    F: for<'a> Fn(
            Arc<FuzForgeApp>,
            Value,
            ActionContext<'a>,
        ) -> futures::future::BoxFuture<'a, Result<Value, JsonrpcError>>
        + Send
        + Sync
        + 'static,
{
    Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        handler(app, params, ctx).boxed()
    })
}

#[cfg(test)]
mod tests {

    use fuz_auth::AuthAxis;

    use super::*;

    /// One row of [`EXPECTED_SPECS`].
    struct ExpectedSpec {
        method: &'static str,
        credentials: CredentialGate,
        roles: Option<&'static [&'static str]>,
        rate_limit: Option<RateLimitClass>,
        side_effects: bool,
    }

    /// Terse row constructor so the table below reads as a table.
    const fn row(
        method: &'static str,
        credentials: CredentialGate,
        roles: Option<&'static [&'static str]>,
        rate_limit: Option<RateLimitClass>,
        side_effects: bool,
    ) -> ExpectedSpec {
        ExpectedSpec {
            method,
            credentials,
            roles,
            rate_limit,
            side_effects,
        }
    }

    const ADMIN: Option<&[&str]> = Some(&[ROLE_ADMIN]);
    const ACCOUNT_RL: Option<RateLimitClass> = Some(RateLimitClass::Account);

    /// The full per-method expectation table — the hand-written twin of the
    /// metadata on the TS specs in `src/lib/action_specs.ts`.
    ///
    /// Columns: method, credential gate, required roles, rate-limit class,
    /// `side_effects`. Every forge `request_response` action appears exactly
    /// once, and [`table_covers_the_real_registry`] proves the list is neither
    /// short nor long against the live [`all`] table — so a new Rust spec must
    /// be added here, with its gate and its rate-limit class, before the suite
    /// passes.
    ///
    /// The guard is Rust-side only: this is a Rust literal with no mechanical
    /// tie to the TS specs, so cross-backend parity rests on review and on the
    /// `cross_backend_*` suites. The spine's `_testing_action_manifest` parity
    /// gate is the mechanical check for the auth columns; the forge test
    /// binary does not register it.
    ///
    /// `fuz_forge_repo_updated` is absent on purpose: it is a broadcast-only
    /// spec on the TS side (`auth: null`) with no Rust `ActionSpec`.
    const EXPECTED_SPECS: &[ExpectedSpec] = &[
        // ─── repo cell reads ───
        row(
            "fuz_forge_repo_list",
            CredentialGate::Any,
            ADMIN,
            None,
            false,
        ),
        row(
            "fuz_forge_repo_get",
            CredentialGate::Any,
            ADMIN,
            None,
            false,
        ),
        // ─── repo subprocess wrappers ───
        row(
            "fuz_forge_repo_log",
            CredentialGate::Any,
            ADMIN,
            None,
            false,
        ),
        row(
            "fuz_forge_repo_commit",
            CredentialGate::Any,
            ADMIN,
            None,
            false,
        ),
        row(
            "fuz_forge_repo_refs",
            CredentialGate::Any,
            ADMIN,
            None,
            false,
        ),
        row(
            "fuz_forge_repo_tree",
            CredentialGate::Any,
            ADMIN,
            None,
            false,
        ),
        row(
            "fuz_forge_repo_blob",
            CredentialGate::Any,
            ADMIN,
            None,
            false,
        ),
        // ─── repo mutations ───
        row(
            "fuz_forge_repo_create",
            CredentialGate::Any,
            ADMIN,
            ACCOUNT_RL,
            true,
        ),
        row(
            "fuz_forge_repo_resync",
            CredentialGate::Any,
            ADMIN,
            None,
            true,
        ),
        row(
            "fuz_forge_repo_rotate_secret",
            CredentialGate::SESSION_ONLY,
            ADMIN,
            ACCOUNT_RL,
            true,
        ),
        // ─── scoped token CRUD (session-only) ───
        row(
            "fuz_forge_token_create_scoped",
            CredentialGate::SESSION_ONLY,
            ADMIN,
            ACCOUNT_RL,
            true,
        ),
        row(
            "fuz_forge_token_policy_list",
            CredentialGate::SESSION_ONLY,
            ADMIN,
            ACCOUNT_RL,
            false,
        ),
    ];

    /// Methods that must NOT be registered — the provisioning/deployment
    /// surface the forge delegated to the standalone `zap` CLI.
    const RETIRED_METHODS: &[&str] = &[
        "fuz_forge_apply",
        "fuz_forge_plan",
        "fuz_forge_run_delete",
        "fuz_forge_host_list",
    ];

    /// Build the REAL [`all`] table over a connectionless stand-in app.
    ///
    /// `FuzForgeApp` is a pure wiring record — every field is an `Arc` handle
    /// or a lazily-connecting [`deadpool_postgres::Pool`], and
    /// `fuz_db::create_pool` never dials the DB — so the specs' *metadata*
    /// (method / auth / rate-limit class / `side_effects`) is readable without
    /// Postgres. Only the handler closures would need a live pool, and no test
    /// here dispatches one. That is what lets this assert the production table
    /// rather than a hand-copied sentinel list.
    fn real_specs() -> Vec<ActionSpec> {
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
        all(&app)
    }

    #[test]
    fn table_covers_the_real_registry() {
        let specs = real_specs();
        let actual: Vec<&str> = specs.iter().map(|s| s.method).collect();
        let expected: Vec<&str> = EXPECTED_SPECS.iter().map(|e| e.method).collect();
        assert_eq!(
            actual, expected,
            "EXPECTED_SPECS must list every forge action spec, in registration order"
        );
    }

    /// Per-method `{credential gate, roles, rate_limit, side_effects}` — the
    /// twin of the TS `action_specs.ts` metadata, asserted against the live
    /// table.
    #[test]
    fn spec_metadata_matches_the_expectation_table() {
        let specs = real_specs();
        for expected in EXPECTED_SPECS {
            let method = expected.method;
            let spec = specs
                .iter()
                .find(|s| s.method == method)
                .unwrap_or_else(|| panic!("missing spec: {method}"));
            assert_eq!(
                spec.auth.credentials, expected.credentials,
                "{method}: credential gate"
            );
            assert_eq!(spec.auth.roles, expected.roles, "{method}: required roles");
            assert_eq!(
                spec.rate_limit, expected.rate_limit,
                "{method}: rate-limit class"
            );
            assert_eq!(
                spec.side_effects, expected.side_effects,
                "{method}: side_effects"
            );
            // Every forge spec is actor-bound and account-required; the role
            // gate reads the RESOLVED actor's grants, and `roles: Some(..)`
            // implies `actor: Required` (spine invariant 1).
            assert_eq!(
                spec.auth.account,
                AuthAxis::Required,
                "{method}: account axis"
            );
            assert_eq!(spec.auth.actor, AuthAxis::Required, "{method}: actor axis");
        }
    }

    #[test]
    fn provisioning_methods_stay_unregistered() {
        let specs = real_specs();
        let names: Vec<&str> = specs.iter().map(|s| s.method).collect();
        for retired in RETIRED_METHODS {
            assert!(
                !names.contains(retired),
                "{retired} is delegated to `zap` and must not be registered"
            );
        }
    }
}
