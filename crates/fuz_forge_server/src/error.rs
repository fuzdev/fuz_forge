//! Typed errors for `fuz_forge_server`.
//!
//! Per ecosystem convention, every crate exposes a `thiserror` enum. Startup
//! failures are the spine's `fuz_actions::server::StartupError`, which carries
//! the binary's exit-code policy.

/// Cross-cutting errors raised from fuz_forge-specific subsystems
/// (forge_git, subprocess, token_policy).
///
/// REST handlers do **not** render this type: every response body is written
/// at the handler as a `rest_error_response(status, "<literal>")`. [`Self::code`] is the
/// snake_case discriminant those literals are meant to agree with — a
/// convention the compiler does not enforce, so a new variant needs its
/// handler-side literal added by hand.
#[derive(Debug, thiserror::Error)]
pub enum FuzForgeError {
    #[error("forbidden")]
    Forbidden,

    #[error("payload too large")]
    PayloadTooLarge,

    #[error("subprocess failed: {0}")]
    Subprocess(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("database error: {0}")]
    Database(#[from] tokio_postgres::Error),

    /// A connection-pool checkout (`pool.get().await`) failed. Where it is
    /// rendered it answers 503 `service_unavailable`
    /// ([`fuz_http::db_unavailable_response`]): the database is unavailable.
    #[error("pool checkout failed")]
    Pool(#[source] deadpool_postgres::PoolError),

    #[error("internal error: {0}")]
    Internal(String),
}

impl FuzForgeError {
    /// Stable short discriminant for `{error: ...}` response bodies.
    /// Mirrors the TS Hono handlers' string codes for cross-backend
    /// HTTP-level parity.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Forbidden => "forbidden",
            Self::PayloadTooLarge => "payload_too_large",
            Self::Subprocess(_) => "subprocess_failed",
            Self::Pool(_) => "service_unavailable",
            Self::Io(_) | Self::Database(_) | Self::Internal(_) => "internal_error",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_faults_have_distinct_codes() {
        // The variants a client can act on carry their own wire code rather
        // than folding into the generic `internal_error` bucket — an oversized
        // payload is the caller's to fix, a pool or io failure is not.
        assert_eq!(FuzForgeError::PayloadTooLarge.code(), "payload_too_large");
        assert_eq!(FuzForgeError::Forbidden.code(), "forbidden");
        assert_eq!(
            FuzForgeError::Pool(deadpool_postgres::PoolError::Closed).code(),
            "service_unavailable",
        );
        assert_eq!(
            FuzForgeError::Io(std::io::Error::other("x")).code(),
            "internal_error",
        );
    }
}
