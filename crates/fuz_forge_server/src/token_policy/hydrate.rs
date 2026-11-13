//! Reading a token's policy **out of the database**, and the columns that read
//! projects through.
//!
//! Twin of `src/lib/server/fuz_forge_token_policy_middleware.ts`: that file
//! hydrates the document onto the Hono context after bearer auth, this one
//! hands it to the two forge surfaces that mount outside the middleware chain
//! as well as the ones inside it. [`hydrate_policy`] hands back a failed pool
//! checkout (the caller answers the spine's 503) and fails **soft** on any
//! other read failure — see it for why that is safe — while git smart-HTTP
//! calls [`FuzForgeTokenRouteState::lookup`] itself and answers a failed read
//! with a 500 (503 for a failed checkout), as its TS twin does; a row that
//! parses to nothing usable fails **closed** through
//! [`super::check::policy_from_stored`] either way.

use deadpool_postgres::{Pool, PoolError};

use crate::error::FuzForgeError;

use super::check::policy_from_stored;
use super::types::FuzForgeTokenPolicy;

/// The `fuz_forge_api_token_policy` table's columns.
///
/// Twin of the TS `FUZ_FORGE_API_TOKEN_POLICY_COLUMNS` in
/// `src/lib/server/db/fuz_forge_api_token_policy_queries.ts` (same names,
/// same order). This backend reads the table narrowly — the `policy::text`
/// lookup in [`FuzForgeTokenRouteState::lookup`] and the two-column listing in
/// `handlers::token` — so no read projects the whole const; it exists for the
/// PG-gated `columns` registry test, which asserts it names every live column
/// so the table can't grow a column neither backend knows about.
pub const FUZ_FORGE_API_TOKEN_POLICY_COLUMNS: [&str; 5] = [
    "api_token_id",
    "policy",
    "policy_version",
    "template",
    "created_at",
];

/// Per-process state for the scoped-token policy subsystem.
///
/// Holds the [`Pool`] for `fuz_forge_api_token_policy` lookups.
#[derive(Debug, Clone)]
pub struct FuzForgeTokenRouteState {
    pool: Pool,
}

impl FuzForgeTokenRouteState {
    #[must_use]
    pub const fn new(pool: Pool) -> Self {
        Self { pool }
    }

    /// Fetch the policy row for `api_token_id`. `None` ⇒ no scoped
    /// policy (admin-equivalent — caller treats the token as full
    /// admin per the unscoped-token contract).
    ///
    /// Port of `query_token_policy_by_id` from
    /// `db/fuz_forge_api_token_policy_queries.ts`. SELECTs `policy::text`
    /// (jsonb → text round-trip) and deserializes via `serde_json`.
    ///
    /// A malformed row body (the column should be otherwise readonly, but
    /// defense-in-depth) resolves to [`super::DENY_ALL_POLICY`], not to an error and
    /// not to `None`: the row exists, so the token *is* scoped, and the two
    /// non-denying outcomes would each widen it — `None` to unscoped, a query
    /// error to the hydrate caller's soft-fail, which is also unscoped. The TS twin
    /// substitutes the same document at the same seam.
    ///
    /// # Errors
    ///
    /// Returns [`FuzForgeError::Pool`] if the deadpool checkout fails or
    /// [`FuzForgeError::Database`] for query failures.
    pub async fn lookup(
        &self,
        api_token_id: &str,
    ) -> Result<Option<FuzForgeTokenPolicy>, FuzForgeError> {
        let client = self.pool.get().await.map_err(FuzForgeError::Pool)?;
        let row = client
            .query_opt(
                "SELECT policy::text FROM fuz_forge_api_token_policy \
                 WHERE api_token_id = $1 \
                 LIMIT 1",
                &[&api_token_id],
            )
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let policy_text: String = row.get(0);
        // TODO: the *wiring* — that a row failing the grammar reaches the gates
        // as deny-all — is pinned end-to-end only on the TS side
        // (`files.scoped_token.db.test.ts` § unreadable policy row), since the
        // mint refuses to write such a row and nothing cross-process can plant
        // one. Here it rests on `policy_from_stored`'s unit table plus this
        // being a straight call; a PG-gated route test in the `tests/columns.rs`
        // style would close it.
        Ok(Some(policy_from_stored(&policy_text, api_token_id)))
    }
}

/// Hydrate the scoped-token policy for a request from its `api_token_id`.
///
/// `Ok(None)` (unscoped) when there's no bearer token id or no policy row; a
/// row that exists but doesn't parse is [`super::DENY_ALL_POLICY`], not `None`
/// (see [`FuzForgeTokenRouteState::lookup`]).
///
/// A failed pool **checkout** is the `Err`: the database is unavailable, and
/// the caller answers the spine's flat 503
/// ([`fuz_http::db_unavailable_response_with_source`]) as every other checkout
/// site does — the TS twin's middleware rethrows its `DbCheckoutError` to the
/// app's `onError`, which answers the same body. Any other read failure (a
/// query error on a checked-out client) is logged and falls through
/// unscoped, `Ok(None)`, mirroring `fuz_forge_token_policy_middleware.ts`.
///
/// What makes that soft-fail safe on the resource-bound surfaces is the other
/// axis: with the policy absent,
/// [`crate::token_surfaces::token_scope_admits_forge_surface`] falls to
/// `api_token.scope`, and every token `fuz_forge_token_create_scoped` writes a
/// policy row for carries a `Methods` scope by construction, which admits no
/// non-RPC surface — so a blip refuses those tokens rather than widening them.
/// Only a policy-row token whose scope were `Full` would widen, and the mint
/// never writes that pair (the `Admin` template takes the `Full` scope and
/// writes no row).
///
/// # Errors
///
/// Returns the [`PoolError`] when the pool checkout fails.
pub async fn hydrate_policy(
    state: &FuzForgeTokenRouteState,
    api_token_id: Option<&str>,
) -> Result<Option<FuzForgeTokenPolicy>, PoolError> {
    let Some(id) = api_token_id else {
        return Ok(None);
    };
    match state.lookup(id).await {
        Ok(policy) => Ok(policy),
        Err(FuzForgeError::Pool(e)) => Err(e),
        Err(e) => {
            tracing::warn!(
                api_token_id = id,
                error = %fuz_sys::cli::format_error_chain(&e),
                "fuz_forge_token_policy: policy lookup failed; falling through unscoped",
            );
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A failed checkout is handed back for the caller's 503, not swallowed
    /// into the unscoped fall-through — over a pool that never connects. A
    /// request with no bearer token id never touches the pool.
    #[tokio::test]
    async fn a_failed_checkout_is_returned_not_soft_failed() {
        let backend = fuz_testing::inert_app_backend(
            &crate::router::FUZ_FORGE_BACKEND_SPEC,
            "http://localhost:5173",
        );
        let state = FuzForgeTokenRouteState::new(backend.pool.clone());
        assert!(matches!(hydrate_policy(&state, None).await, Ok(None)));
        assert!(
            hydrate_policy(&state, Some("00000000-0000-4000-8000-000000000001"))
                .await
                .is_err()
        );
    }
}
