//! Top-level CLI error type.
//!
//! Per-command/library errors live in their own modules with their own
//! `exit_code()` / `hint()`; this enum wraps them via `#[error(transparent)]` +
//! `#[from]` and dispatches. `Declined` is the no-action confirmation path
//! (`file delete` / `repo resync` without `--yes`): the handler prints the
//! prompt to stdout, returns `Declined`, and `main` exits 2 with no `error:`
//! line.

use fuz_sys::cli::HintMessage;
use thiserror::Error;

use crate::client::ClientError;
use crate::config::ConfigError;
use crate::repo_id::RepoIdError;

/// Errors that can occur during CLI operations.
#[derive(Debug, Error)]
pub enum CliError {
    /// Config / home / token / server resolution failed.
    #[error(transparent)]
    Config(#[from] ConfigError),

    /// A forge HTTP/RPC operation failed.
    #[error(transparent)]
    Client(#[from] ClientError),

    /// `fuzf tool publish` failed.
    #[error(transparent)]
    Publish(#[from] crate::cli::tool::PublishError),

    /// An external command (`git clone` via `repo clone --exec`) ran but exited
    /// non-zero. Runtime (exit 1): fuzf invoked it correctly; the tool itself
    /// failed, and its own stderr already explains why.
    #[error("{0}")]
    Command(String),

    /// A repo `<id-or-slug>` argument failed to parse (exit 2). A usage-level
    /// error rather than a forge `ClientError`, even though it can surface
    /// mid-RPC via `ForgeClient::resolve_repo_id`.
    #[error(transparent)]
    RepoId(#[from] RepoIdError),

    /// Missing or invalid arguments (exit 2).
    #[error("{0}")]
    Usage(String),

    /// A confirmation gate was not satisfied (`--yes` omitted). The handler
    /// already printed the prompt; `main` exits 2 silently.
    #[error("")]
    Declined,
}

impl CliError {
    /// When `Some(code)`, `main` exits with that code printing nothing — the
    /// handler owns the user-facing output (confirmation prompts).
    pub const fn silent_exit_code(&self) -> Option<u8> {
        match self {
            Self::Declined => Some(2),
            _ => None,
        }
    }

    /// Process exit code (for `ExitCode::from`).
    pub const fn exit_code(&self) -> u8 {
        match self {
            Self::Config(e) => e.exit_code(),
            Self::Client(e) => e.exit_code(),
            Self::Publish(e) => e.exit_code(),
            Self::Command(_) => 1,
            Self::Usage(_) | Self::Declined | Self::RepoId(_) => 2,
        }
    }

    /// User-facing hint, if any.
    pub fn hint(&self) -> Option<HintMessage> {
        match self {
            Self::Config(e) => e.hint(),
            Self::Client(e) => e.hint(),
            Self::Publish(e) => e.hint(),
            Self::Usage(_) | Self::Declined | Self::RepoId(_) | Self::Command(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::path::PathBuf;

    use super::CliError;
    use crate::client::ClientError;
    use crate::config::ConfigError;
    use crate::repo_id::RepoIdError;

    /// The exit-code contract by category (see the crate-level `# Exit codes`):
    /// caller-side remediation (invocation / config / credentials) → `2`,
    /// everything else → `1`.
    #[test]
    fn exit_codes_by_category() {
        // Caller-side → 2.
        assert_eq!(CliError::Usage("x".to_string()).exit_code(), 2);
        assert_eq!(CliError::Declined.exit_code(), 2);
        assert_eq!(
            CliError::RepoId(RepoIdError::InvalidId("x".to_string())).exit_code(),
            2
        );
        assert_eq!(CliError::Config(ConfigError::NoForgeServer).exit_code(), 2);
        assert_eq!(
            CliError::Config(ConfigError::InvalidServerUrl(
                fuz_storage::base_url::BaseUrlRefusal::NoHost
            ))
            .exit_code(),
            2
        );
        assert_eq!(
            CliError::Client(ClientError::NotAFile(PathBuf::from("x"))).exit_code(),
            2
        );
        assert_eq!(
            CliError::Client(ClientError::Forbidden("x".to_string())).exit_code(),
            2
        );
        assert_eq!(
            CliError::Client(ClientError::Url("x".to_string())).exit_code(),
            2
        );
        assert_eq!(
            CliError::Client(ClientError::Redirected {
                context: "x".to_string(),
                status: reqwest::StatusCode::FOUND,
            })
            .exit_code(),
            2
        );
        for status in [400, 401, 403] {
            assert_eq!(client_status(status).exit_code(), 2, "{status}");
        }
        for code in [-32602, -32001, -32002] {
            assert_eq!(client_rpc(code).exit_code(), 2, "{code}");
        }

        // Not the caller's invocation → 1.
        assert_eq!(CliError::Command("x".to_string()).exit_code(), 1);
        assert_eq!(
            CliError::Config(ConfigError::ConfigWrite(
                PathBuf::from("x"),
                io::Error::other("y")
            ))
            .exit_code(),
            1
        );
        assert_eq!(
            CliError::Client(ClientError::FileNotFound("x".to_string())).exit_code(),
            1
        );
        for status in [404, 409, 413, 500, 502, 507] {
            assert_eq!(client_status(status).exit_code(), 1, "{status}");
        }
        for code in [-32603, -32003, -32004, -32006] {
            assert_eq!(client_rpc(code).exit_code(), 1, "{code}");
        }
    }

    fn client_status(status: u16) -> CliError {
        CliError::Client(ClientError::Status {
            context: "x".to_string(),
            status: reqwest::StatusCode::from_u16(status).unwrap(),
            body: String::new(),
        })
    }

    fn client_rpc(code: i64) -> CliError {
        CliError::Client(ClientError::Rpc {
            method: "x".to_string(),
            code,
            message: "y".to_string(),
        })
    }

    /// `Declined` prints its own prompt, so `main` exits silently with `2`.
    #[test]
    fn declined_exits_silently() {
        assert_eq!(CliError::Declined.silent_exit_code(), Some(2));
        assert_eq!(CliError::Usage("x".to_string()).silent_exit_code(), None);
    }
}
