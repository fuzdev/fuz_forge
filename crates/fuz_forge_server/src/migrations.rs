//! FuzForge-namespace migrations.
//!
//! Single `"fuz_forge"` migration namespace, applied last in the chain
//! [`crate::router::fuz_forge_migration_namespaces`] builds —
//! [`fuz_auth::AUTH_MIGRATIONS`], [`fuz_cell::CELL_MIGRATIONS`],
//! [`fuz_fact::FACT_MIGRATIONS`], then this one — and handed to
//! [`fuz_db::run_migrations`]. The auth namespace runs first because
//! `fuz_forge_api_token_policy.api_token_id` references `api_token(id)`; the
//! cell substrate is owned by `fuz_cell` and the fact substrate by `fuz_fact`.
//!
//! ## Migration list
//!
//! - `fuz_forge_initial` — the scoped-token policy table
//!   (`fuz_forge_api_token_policy`) only. The fact substrate (`fact`,
//!   `fact_ref`, `memo`, `fact_holder`) lives in `fuz_fact::FACT_MIGRATIONS` (`fuz_facts`
//!   namespace); the cell substrate in `fuz_cell::CELL_MIGRATIONS` (repos and
//!   the file store are reflected as cells there). There are no
//!   provisioning/deployment tables — the forge delegates its own convergence
//!   to the standalone `zap` CLI and carries no run engine.
//!
//! ## Source
//!
//! DDL is the Rust port of the TS schema in `src/lib/server/db/`:
//!
//! - `fuz_forge_api_token_policy_schema.ts` — `fuz_forge_api_token_policy`
//!
//! The fact substrate (`fact`, `fact_ref`, `memo`, `fact_holder`) is defined by
//! `fuz_fact::FACT_MIGRATIONS`, and the unified `cell` / `cell_grant` /
//! `cell_field` / `cell_item` tables in
//! `fuz_cell::CELL_MIGRATIONS` — not here.

use fuz_db::{Migration, MigrationNamespace};

use crate::router::FUZ_FORGE_MIGRATIONS_NAMESPACE;

/// The forge's own initial migration DDL.
///
/// Just `fuz_forge_api_token_policy` — the fact substrate (`fact`, `fact_ref`,
/// `memo`, `fact_holder`) belongs to the shared `fuz_fact::FACT_MIGRATIONS` (`fuz_facts`
/// namespace), so the forge carries no copy of it. The token-policy table FKs
/// `api_token(id)` `ON DELETE CASCADE`, tying policy lifetime to token
/// lifetime.
///
/// The cell substrate (`cell`, `cell_grant`, `cell_field`, `cell_item`) is
/// owned by `fuz_cell::CELL_MIGRATIONS` and runs in
/// its own namespace. There are no convergence tables — the forge delegates
/// provisioning/deployment to the `zap` CLI.
///
/// One `batch_execute` so the DDL either lands together or rolls back
/// together (per [`fuz_db::run_migrations`]'s chain-transaction
/// semantics).
const FUZ_FORGE_INITIAL_DDL: &str = r"
-- fuz_forge_initial: scoped-token policy (the fact substrate lives in fuz_facts)

CREATE TABLE IF NOT EXISTS fuz_forge_api_token_policy (
    api_token_id   TEXT        PRIMARY KEY REFERENCES api_token(id) ON DELETE CASCADE,
    policy         JSONB       NOT NULL,
    policy_version INTEGER     NOT NULL DEFAULT 1,
    template       TEXT        NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
";

/// Static migration list consumed by [`fuz_forge_migrations_namespace`].
pub const FUZ_FORGE_MIGRATIONS: &[Migration] = &[Migration {
    name: "fuz_forge_initial",
    sql: FUZ_FORGE_INITIAL_DDL,
}];

/// Construct the fuz_forge-namespace migration set.
///
/// Splices into [`fuz_db::run_migrations`] as the last namespace of
/// [`crate::router::fuz_forge_migration_namespaces`], after the auth, cell,
/// and fact namespaces. Auth runs first because
/// `fuz_forge_api_token_policy.api_token_id` carries an FK into `api_token`.
#[must_use]
pub const fn fuz_forge_migrations_namespace() -> MigrationNamespace {
    MigrationNamespace::new(FUZ_FORGE_MIGRATIONS_NAMESPACE, FUZ_FORGE_MIGRATIONS)
}
