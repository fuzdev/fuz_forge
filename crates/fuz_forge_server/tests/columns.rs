//! Registry guard for the per-table projection constants over the full forge
//! migration chain: every live table is either a `*_COLUMNS` const naming
//! exactly its live columns or a reasoned exemption.
//!
//! Composes the spine chains' exported registries (`fuz_db` tracker,
//! `fuz_auth`, `fuz_cell`, `fuz_fact`) with this crate's own
//! `fuz_forge_api_token_policy` set, so a table added to any spine chain
//! reaches this guard through the one set its crate exports. The assertion
//! over the composed registries is the spine's shared
//! `fuz_testing::assert_column_projections`. Twin of the TS
//! `fuz_forge_api_token_policy_queries.db.test.ts` guard.
//!
//! `--ignored`-gated (needs Postgres, `createdb fuz_forge_server_test`):
//!
//! ```sh
//! cargo test -p fuz_forge_server --test columns -- --ignored
//! ```

mod common;

use common::fresh_db_pool;
use fuz_auth::AUTH_COLUMN_PROJECTIONS;
use fuz_cell::CELL_COLUMN_PROJECTIONS;
use fuz_db::{ColumnProjections, DB_COLUMN_PROJECTIONS};
use fuz_fact::FACT_COLUMN_PROJECTIONS;
use fuz_forge_server::token_policy::FUZ_FORGE_API_TOKEN_POLICY_COLUMNS;
use fuz_testing::assert_column_projections;

/// The forge chain's own contribution: the scoped-token policy table.
const FUZ_FORGE_COLUMN_PROJECTIONS: ColumnProjections = ColumnProjections {
    projections: &[(
        "fuz_forge_api_token_policy",
        &FUZ_FORGE_API_TOKEN_POLICY_COLUMNS,
    )],
    exempt: &[],
};

#[tokio::test]
#[ignore = "needs Postgres"]
async fn columns_match_live_schema() {
    let pool = fresh_db_pool().await;
    assert_column_projections(
        &pool,
        &[
            DB_COLUMN_PROJECTIONS,
            AUTH_COLUMN_PROJECTIONS,
            CELL_COLUMN_PROJECTIONS,
            FACT_COLUMN_PROJECTIONS,
            FUZ_FORGE_COLUMN_PROJECTIONS,
        ],
    )
    .await;
}
