//! Shared setup for `fuz_forge_server`'s Postgres-backed suites.
//!
//! Lives under `tests/common/` so Cargo doesn't compile it as its own test
//! binary — each suite includes it via `mod common;`.
//!
//! The suites are `#[ignore]`-gated (they need a reachable Postgres) and share
//! one database, `fuz_forge_server_test` (override with
//! `FUZ_FORGE_SERVER_TEST_URL`), whose `public` schema each one drops and
//! recreates — run them with `--ignored --test-threads=1`. The cycle itself is
//! the spine's `fuz_testing::fresh_db`; this module holds the suites' openings
//! of it, bare and migrated.

// `columns` carries no crate-level `expect`, so this module needs its own.
#![expect(
    clippy::expect_used,
    reason = "test helpers outside `#[test]` fns panic on a failed setup or check"
)]

use fuz_db::Pool;
use fuz_forge_server::router::fuz_forge_migration_namespaces;
use fuz_testing::{TestingDbOptions, fresh_test_db_pool};

/// The suites' database, reset and left bare: `FUZ_FORGE_SERVER_TEST_URL`
/// (default `postgres://localhost/fuz_forge_server_test`), no migrations, no
/// scratch DDL.
const BARE_DB: TestingDbOptions<'static> = TestingDbOptions {
    env_var: "FUZ_FORGE_SERVER_TEST_URL",
    default_db: "fuz_forge_server_test",
    migrations: &[],
    setup_sql: None,
};

/// [`BARE_DB`] over the chain `build_router` runs.
const MIGRATED_DB: TestingDbOptions<'static> = TestingDbOptions {
    migrations: &fuz_forge_migration_namespaces(),
    ..BARE_DB
};

/// The test database's URL: `FUZ_FORGE_SERVER_TEST_URL`, or the default — what
/// a suite booting `build_router` hands it as `database_url`.
#[allow(dead_code, reason = "each test binary uses only part of this module")]
pub fn test_url() -> String {
    BARE_DB.url()
}

/// Reset the `public` schema and run nothing: a pool over an empty database,
/// for a suite whose `build_router` call runs the migration chain itself.
#[allow(dead_code, reason = "each test binary uses only part of this module")]
pub async fn bare_db_pool() -> Pool {
    let pool = fresh_test_db_pool(BARE_DB).await;
    // the bare form is what makes these suites the in-crate guard that
    // `build_router` migrates: nothing may exist for it to build on
    let tracker: Option<String> = pool
        .get()
        .await
        .expect("pool.get")
        .query_one("SELECT to_regclass('public.schema_version')::text", &[])
        .await
        .expect("probe schema_version")
        .get(0);
    assert!(
        tracker.is_none(),
        "bare_db_pool must hand back an unmigrated schema"
    );
    pool
}

/// Reset the `public` schema, then run the chain `build_router` runs — a fresh
/// bootstrap of what `fuzfd` migrates on boot.
#[allow(dead_code, reason = "each test binary uses only part of this module")]
pub async fn fresh_db_pool() -> Pool {
    fresh_test_db_pool(MIGRATED_DB).await
}
