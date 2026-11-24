//! Shared setup for `fuz_forge_server`'s database-backed suites.
//!
//! Lives under `tests/common/` so Cargo doesn't compile it as its own test
//! binary — each suite includes it via `mod common;`.
//!
//! Each test opens a database of its own through the spine's
//! `fuz_testing::fresh_test_db`: an in-process pglet server by default, or a
//! PostgreSQL database created and dropped through `FUZ_TEST_POSTGRES_URL`.
//! This module holds the suites' openings of it, bare and migrated.

// `columns` carries no crate-level `expect`, so this module needs its own.
#![expect(
    clippy::expect_used,
    reason = "test helpers outside `#[test]` fns panic on a failed setup or check"
)]

use fuz_forge_server::router::fuz_forge_migration_namespaces;
use fuz_testing::{TestDb, TestEngine, TestingDbOptions, fresh_test_db};

/// A bare database: no migrations, no scratch DDL.
const BARE_DB: TestingDbOptions<'static> = TestingDbOptions {
    suite: "fuz_forge_server",
    migrations: &[],
    setup_sql: None,
    engine: TestEngine::Any,
};

/// [`BARE_DB`] over the chain `build_router` runs.
const MIGRATED_DB: TestingDbOptions<'static> = TestingDbOptions {
    migrations: &fuz_forge_migration_namespaces(),
    ..BARE_DB
};

/// A database with nothing in it, for a suite whose `build_router` call runs
/// the migration chain itself; boot `build_router` over its `url()`.
#[allow(dead_code, reason = "each test binary uses only part of this module")]
pub async fn bare_db() -> TestDb {
    assert_bare(fresh_test_db(BARE_DB).await).await
}

/// [`bare_db`] on PostgreSQL alone, for a test observing what only PostgreSQL
/// has.
#[allow(dead_code, reason = "each test binary uses only part of this module")]
pub async fn bare_postgres_db() -> TestDb {
    assert_bare(fresh_test_db(BARE_DB.postgres_only()).await).await
}

/// A database under the chain `build_router` runs — a fresh bootstrap of what
/// `fuzfd` migrates on boot.
#[allow(dead_code, reason = "each test binary uses only part of this module")]
pub async fn fresh_db() -> TestDb {
    fresh_test_db(MIGRATED_DB).await
}

/// `db`, checked to hold no migration tracker: the bare form is what makes
/// these suites the in-crate guard that `build_router` migrates, so nothing
/// may exist for it to build on.
async fn assert_bare(db: TestDb) -> TestDb {
    let tracker: Option<String> = db
        .get()
        .await
        .expect("pool.get")
        .query_one("SELECT to_regclass('public.schema_version')::text", &[])
        .await
        .expect("probe schema_version")
        .get(0);
    assert!(
        tracker.is_none(),
        "a bare database must hand back an unmigrated schema"
    );
    db
}
