//! [`FuzForgeApp`] — composition root for the fuz_forge_server process.
//!
//! `FuzForgeApp` is the wiring root, NOT a god-object handler context: the
//! spine's `AppBackend` beside the forge's own state.
//! Handlers receive narrow `*RouteState` slices via `axum::State` —
//! the [`fuz_auth::AccountRouteState`], [`fuz_actions::ActionDispatch`],
//! [`fuz_actions::WsRouteState`], and fuz_forge-specific
//! [`crate::token_policy::FuzForgeTokenRouteState`] /
//! [`crate::fact_store::FactStoreHandle`] are built once from
//! `FuzForgeApp` and passed to the router factory.

use std::sync::Arc;

use fuz_actions::server::AppBackend;

use crate::env::FuzForgeEnv;
use crate::fact_store::FactStoreHandle;
use crate::token_policy::FuzForgeTokenRouteState;

/// Long-lived state composed once at startup.
///
/// Every field is `Arc`-wrapped (or itself an `Arc`-backed handle like
/// `fuz_db::Pool`) so `Clone` is cheap. Handlers never see `FuzForgeApp` directly;
/// the [`crate::router`] factory carves out per-router state slices.
#[derive(Clone)]
pub struct FuzForgeApp {
    // ─── spine ───
    /// The spine core: pool, keyring, hasher, audit emitter, limiters,
    /// daemon-token state (always `None` in production — the credential's
    /// producer lives in `fuz_testing`, so only `testing_fuzfd` can mint one
    /// and inject it), the WebSocket registry, and the audit-log SSE registry
    /// behind `GET /api/admin/audit/stream`. Its
    /// [`AppBackend::connection_closer`] closes both.
    pub backend: AppBackend,

    // ─── fuz_forge-specific ───
    pub fact_store: FactStoreHandle,
    pub fuz_forge_token_state: Arc<FuzForgeTokenRouteState>,

    // ─── filesystem paths ───
    pub repo_path: Option<std::path::PathBuf>,

    // ─── git subprocess env ───
    /// `PATH` handed to every git/chmod subprocess the forge spawns outside
    /// the CGI proxy, resolved once from [`FuzForgeEnv::git_path`] and passed
    /// down to `forge_git::read::git_env` / [`crate::repo_storage`]. Carried on
    /// the App rather than read from the process env at the spawn site so the
    /// `FuzForgeEnv::from_vars` seam stays the one env reader.
    pub git_path: String,
    /// Loopback callback base (`http://127.0.0.1:<port>`) embedded into the
    /// per-repo git hook scripts, resolved once from the env's `PORT` (`FuzForgeEnv::base`).
    /// Twin of the TS `build_callback_url_base(runtime)` call in
    /// `src/lib/server/routes/fuz_forge_repo_write.ts`.
    pub callback_url_base: String,

    // ─── seed policy ───
    /// Whether `fuz_forge_repo_create` admits a `seed_from` whose host is a
    /// loopback / link-local / unspecified / RFC 1918 / ULA address (or
    /// `localhost`). From [`FuzForgeEnv::seed_from_allow_private_hosts`]; off in
    /// production. Twin of the TS `FuzForgeRoutesDeps.seed_from_allow_private_hosts`
    /// (`src/lib/server/routes/fuz_forge_repo_cell.ts`).
    pub seed_from_allow_private_hosts: bool,
}

impl std::fmt::Debug for FuzForgeApp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FuzForgeApp")
            .field("backend", &self.backend)
            .finish_non_exhaustive()
    }
}

impl FuzForgeApp {
    /// Compose the forge's state over a booted spine core and the validated
    /// env: the fact store over the facts root, the token-policy state, the
    /// repo root, and the git subprocess env.
    #[must_use]
    pub fn new(backend: AppBackend, env: &FuzForgeEnv) -> Self {
        Self {
            fact_store: FactStoreHandle::new(backend.pool.clone(), Some(env.fact_store_root())),
            fuz_forge_token_state: Arc::new(FuzForgeTokenRouteState::new(backend.pool.clone())),
            repo_path: Some(env.repo_store_root()),
            git_path: env.git_path.clone(),
            callback_url_base: crate::repo_storage::build_callback_url_base(env.base.port),
            seed_from_allow_private_hosts: env.seed_from_allow_private_hosts,
            backend,
        }
    }
}
