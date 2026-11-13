#![expect(
    clippy::doc_markdown,
    reason = "doc prose writes project names, wire field names, and CIDR ranges like fuz_forge, author_email, and fe80::/10 as plain words"
)]

//! `fuz_forge_server` — Rust backend for fuz_forge.
//!
//! Web/storage/forge facets. Consumes the spine crates (`fuz_db`, `fuz_auth`,
//! `fuz_http`, `fuz_cell`, `fuz_fact`, and others — see `Cargo.toml`) and
//! contributes the fuz_forge-specific half. The list below is the mounted
//! surface — this crate's own work, except where a bullet names the spine
//! router it re-mounts:
//!
//! - **Forge git smart-HTTP** ([`forge_git`]) — `/:slug.git/...` routes
//!   that proxy `git http-backend` via streaming subprocess.
//! - **File store + fact substrate** ([`fact_store`]) — content-addressed
//!   storage backed by PG + disk overflow at the 1 MiB threshold. The
//!   [`files`] module serves the cell-primary `/api/fuz_forge/files/*` REST
//!   surface over it.
//! - **Db-admin browser** — the spine's [`fuz_db_admin::db_admin_router`],
//!   re-mounted here at `/api/db/*`, browsing the `public` schema generically
//!   (twin of the TS `create_db_route_specs`). This crate's contribution is the
//!   configuration: it picks the `required_role` (admin) and the
//!   `credential_gate` (session-only) that the spine's router then enforces.
//! - **`fuz_forge_token_policy`** ([`token_policy`]) — the scoped-token policy
//!   grammar plus its hydrate and check for the file store and git. RPC
//!   methods and the WS upgrade are gated by the spine's `api_token.scope`.
//! - **fuz_forge RPC action specs** ([`actions`]) — the fuz_forge-specific
//!   `request_response` methods (repo reads + git subprocess wrappers +
//!   scoped-token CRUD) that compose alongside the spine's standard
//!   actions and the `fuz_cell` cell surface.
//! - **fuz_forge WS broadcasts** ([`broadcasts`]) — `fuz_forge_repo_updated`.
//! - **Subprocess primitives** ([`subprocess`]) —
//!   [`subprocess::spawn_streaming`] + [`subprocess::spawn_collect`] over
//!   `tokio::process::Command`.
//!
//! ## Provisioning/deployment scope
//!
//! The forge delegates its own provisioning and deployment to the
//! standalone `zap` CLI — it carries no convergence engine, and no
//! run/host/apply actions, broadcasts, or tables. This crate ships only the
//! web/storage/forge surface.
//!
//! ## Composition root
//!
//! [`FuzForgeApp`] holds the long-lived Arcs the request handlers need: the
//! spine core (`fuz_actions::server::AppBackend` — `pool`, `keyring`,
//! `audit_emitter`, `realtime`, …) beside `fact_store` and
//! `fuz_forge_token_state`. It's not a "god object" handler context —
//! handlers receive narrow `*RouteState` slices via `axum::State`.

pub mod app;
pub mod env;
pub mod error;
#[cfg(test)]
mod parity;
mod text;

// === fuz_forge-specific subsystems ===
pub mod actions;
pub mod broadcasts;
pub mod cell_create_authorize;
pub mod fact_store;
pub mod files;
pub mod forge_git;
pub mod handlers;
pub mod internal_routes;
pub mod query_params;
pub mod repo_storage;
pub mod route_auth;
pub mod subprocess;
pub mod token_policy;
pub mod token_surfaces;

// === wiring ===
pub mod migrations;
pub mod router;
pub mod runtime;

pub use app::FuzForgeApp;
pub use env::FuzForgeEnv;
pub use error::FuzForgeError;
