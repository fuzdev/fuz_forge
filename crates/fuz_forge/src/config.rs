//! `fuz_forge` CLI configuration + home / token / server resolution.
//!
//! The CLI keeps a small JSON config at `<fuz_forge_home>/config.json`
//! recording the forge server URL. `<fuz_forge_home>` and the bearer token are
//! resolved by `fuz_storage::forge_home`, the resolver `fuz` shares, so both
//! send the same token: `FUZ_FORGE_HOME` (if set, tilde-expanded) else
//! `$HOME/.fuz_forge`, the home being `fuz_sys::home_dir`'s (non-empty and
//! absolute) — letting one machine run several isolated forge environments (a
//! project-local dev home alongside a prod-pointed `~/.fuz_forge/`) without
//! colliding config or token.
//!
//! The config records the server URL and **no database URL**: the client never
//! touches the DB (every operation goes through the server), and provisioning
//! belongs to the `zap` CLI.

use std::path::PathBuf;

use fuz_storage::base_url::{BaseUrl, BaseUrlRefusal, validate_base_url};
use fuz_storage::forge_base_url_refusal_message;
use fuz_storage::forge_home::{
    ForgeBaseUrlNotUnicode, ForgeHomeError, ForgeTokenError, forge_base_url_env, forge_home_dir,
    resolve_forge_token,
};
use fuz_sys::cli::HintMessage;
use fuz_sys::fs::write_atomic;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Config filename under `<fuz_forge_home>/`.
const CONFIG_FILE: &str = "config.json";

/// CLI config (`<fuz_forge_home>/config.json`).
///
/// The `fuz_forge_config_` field prefix is kept from the TS schema so the
/// on-disk shape is self-documenting and existing configs round-trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FuzForgeConfig {
    /// `fuz_forge` server URL for RPC + file-store operations.
    pub fuz_forge_config_server_url: String,
}

/// Errors from config / connection resolution.
#[derive(Debug, Error)]
pub enum ConfigError {
    /// `<fuz_forge_home>` did not resolve (an unusable home directory).
    #[error(transparent)]
    Home(#[from] ForgeHomeError),

    /// The config file exists but could not be read or parsed.
    #[error("failed to read forge config {0}: {1}")]
    ConfigInvalid(PathBuf, String),

    /// Writing the config file failed.
    #[error("failed to write forge config {0}: {1}")]
    ConfigWrite(PathBuf, #[source] std::io::Error),

    /// No forge server resolved from flag, env, or config.
    #[error("fuz_forge server URL not configured")]
    NoForgeServer,

    /// No bearer token resolved from env or the token file.
    #[error(transparent)]
    Token(#[from] ForgeTokenError),

    /// `FUZ_FORGE_BASE_URL` is set but not UTF-8.
    #[error(transparent)]
    BaseUrlEnv(#[from] ForgeBaseUrlNotUnicode),

    /// The resolved server URL fails the forge's base-URL policy
    /// (`fuz_storage::base_url`, the rules `forge://` storage applies):
    /// plaintext to a remote host, another scheme, credentials, a query.
    /// Worded as `forge://` words it; the refusal is kept out of `source()`,
    /// so the error chain does not repeat it in the neutral wording.
    #[error("{}", forge_base_url_refusal_message(.0))]
    InvalidServerUrl(BaseUrlRefusal),
}

impl From<BaseUrlRefusal> for ConfigError {
    fn from(refusal: BaseUrlRefusal) -> Self {
        Self::InvalidServerUrl(refusal)
    }
}

/// Hint for a missing or refused server URL.
const SERVER_URL_HINT: &str = "run `fuzf init --server <url>` with an https:// URL (http:// only for localhost), or set FUZ_FORGE_BASE_URL";

impl ConfigError {
    /// Process exit code — config/usage errors are `2`, I/O failures `1`.
    pub const fn exit_code(&self) -> u8 {
        match self {
            Self::ConfigWrite(..) => 1,
            Self::Home(_)
            | Self::ConfigInvalid(..)
            | Self::NoForgeServer
            | Self::Token(_)
            | Self::BaseUrlEnv(_)
            | Self::InvalidServerUrl(_) => 2,
        }
    }

    /// User-facing hint, if any.
    pub const fn hint(&self) -> Option<HintMessage> {
        match self {
            Self::NoForgeServer | Self::InvalidServerUrl(_) => {
                Some(HintMessage::Static(SERVER_URL_HINT))
            }
            Self::BaseUrlEnv(_) => Some(HintMessage::Static(
                "unset or fix FUZ_FORGE_BASE_URL (it must be UTF-8)",
            )),
            Self::Home(e) => Some(HintMessage::Static(e.hint())),
            Self::Token(e) => Some(HintMessage::Static(e.hint())),
            _ => None,
        }
    }
}

/// Resolve `<fuz_forge_home>` — `FUZ_FORGE_HOME` (tilde-expanded) else
/// `$HOME/.fuz_forge`, through the resolver `fuz` shares.
pub fn fuz_forge_dir() -> Result<PathBuf, ConfigError> {
    Ok(forge_home_dir()?)
}

/// Path to the config file (`<fuz_forge_home>/config.json`).
pub fn config_path() -> Result<PathBuf, ConfigError> {
    Ok(fuz_forge_dir()?.join(CONFIG_FILE))
}

/// Load the config, or `None` when the file is absent.
///
/// Fails loud when the file is present but unreadable / malformed — at that
/// point it is the chosen source, not a fall-through.
pub fn load_config() -> Result<Option<FuzForgeConfig>, ConfigError> {
    let path = config_path()?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map(Some)
            .map_err(|e| ConfigError::ConfigInvalid(path, e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ConfigError::ConfigInvalid(path, e.to_string())),
    }
}

/// Write the config atomically, creating `<fuz_forge_home>/` if needed.
pub fn save_config(config: &FuzForgeConfig) -> Result<(), ConfigError> {
    let dir = fuz_forge_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| ConfigError::ConfigWrite(dir.clone(), e))?;
    let path = dir.join(CONFIG_FILE);
    // unwrap is safe: a struct of owned strings always serializes.
    #[allow(clippy::unwrap_used)]
    let body = serde_json::to_vec_pretty(config).unwrap();
    write_atomic(&path, &body, 0o644).map_err(|e| ConfigError::ConfigWrite(path, e))?;
    Ok(())
}

/// Resolve and validate the forge server URL: `--server` flag, else
/// `FUZ_FORGE_BASE_URL` (blank = unset, read by the resolver `fuz` shares),
/// else the config's `fuz_forge_config_server_url`.
///
/// Validated here, once per command, by the policy `forge://` storage applies
/// (`fuz_storage::base_url`), so a refused URL is a config error (exit 2)
/// rather than one surfacing deeper in the HTTP client.
pub fn resolve_server_url(flag: Option<&str>) -> Result<BaseUrl, ConfigError> {
    let url = resolve_server_url_from(
        flag,
        || Ok(forge_base_url_env()?),
        || Ok(load_config()?.map(|c| c.fuz_forge_config_server_url)),
    )?;
    Ok(validate_base_url(&url)?)
}

/// Pure precedence behind `resolve_server_url`, with the env read and config
/// load injected so the flag → env → config ladder is unit-testable without
/// touching process env. A blank flag is skipped; the env reader skips a
/// blank variable itself. The closures stay lazy: env is only read when no
/// flag wins, and the config only loaded when neither flag nor env wins — so
/// a `--server` override never depends on a readable config file.
fn resolve_server_url_from(
    flag: Option<&str>,
    env: impl FnOnce() -> Result<Option<String>, ConfigError>,
    load: impl FnOnce() -> Result<Option<String>, ConfigError>,
) -> Result<String, ConfigError> {
    if let Some(s) = flag.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(s.to_string());
    }
    if let Some(s) = env()? {
        return Ok(s);
    }
    load()?.ok_or(ConfigError::NoForgeServer)
}

/// Resolve the bearer token: `FUZ_FORGE_TOKEN`, else
/// `<fuz_forge_home>/api_token`, through the resolver `fuz` shares.
pub fn resolve_token() -> Result<String, ConfigError> {
    Ok(resolve_forge_token()?)
}

/// Resolve the validated server URL + bearer `token` together — the
/// connection every RPC / file-store command opens with.
pub fn load_connection() -> Result<(BaseUrl, String), ConfigError> {
    let server_url = resolve_server_url(None)?;
    let token = resolve_token()?;
    Ok((server_url, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared resolver's errors are config errors here: exit 2, with the
    /// resolver's hint.
    #[test]
    fn home_and_token_errors_are_config_errors_with_their_hint() {
        let errors = [
            ConfigError::from(ForgeHomeError::NoHome(fuz_sys::HomeDirError::Empty)),
            ConfigError::from(ForgeHomeError::OverrideTilde(fuz_sys::HomeDirError::Empty)),
            ConfigError::from(ForgeTokenError::Empty {
                path: PathBuf::from("/h/api_token"),
            }),
        ];
        for error in errors {
            assert_eq!(error.exit_code(), 2, "{error}");
            assert!(error.hint().is_some(), "{error}");
        }
    }

    #[test]
    fn server_url_prefers_trimmed_flag() {
        let got = resolve_server_url_from(
            Some("  https://flag  "),
            || Ok(Some("https://env".to_string())),
            || Ok(Some("https://config".to_string())),
        )
        .unwrap();
        assert_eq!(got, "https://flag");
    }

    #[test]
    fn server_url_falls_back_to_env_when_flag_blank() {
        let got = resolve_server_url_from(
            Some("   "),
            || Ok(Some("https://env".to_string())),
            || Ok(Some("https://config".to_string())),
        )
        .unwrap();
        assert_eq!(got, "https://env");
    }

    #[test]
    fn server_url_falls_back_to_config_when_env_unset() {
        let got =
            resolve_server_url_from(None, || Ok(None), || Ok(Some("https://config".to_string())))
                .unwrap();
        assert_eq!(got, "https://config");
    }

    #[test]
    fn server_url_errors_when_nothing_resolves() {
        let err = resolve_server_url_from(None, || Ok(None), || Ok(None)).unwrap_err();
        assert!(matches!(err, ConfigError::NoForgeServer));
    }

    /// A refused URL is a config error at resolution — before any client is
    /// built: exit 2, with the init hint, in the wording `forge://` storage
    /// prints, and printed once (the refusal is not a `source()` the error
    /// chain would repeat). The loopback carve-out stays open for dev.
    #[test]
    fn server_url_refusal_is_a_config_error() {
        let err = resolve_server_url(Some("http://forge.example.com")).unwrap_err();
        assert!(
            matches!(
                err,
                ConfigError::InvalidServerUrl(BaseUrlRefusal::PlaintextHost(_))
            ),
            "{err:?}"
        );
        assert_eq!(err.exit_code(), 2);
        assert!(err.hint().is_some());
        assert_eq!(
            fuz_sys::cli::format_error_chain(&err),
            "refusing to send a bearer token over plaintext http to non-loopback host \
             'forge.example.com'; use https"
        );
        let err = resolve_server_url(Some("ftp://forge.example.com")).unwrap_err();
        assert_eq!(
            fuz_sys::cli::format_error_chain(&err),
            "invalid forge base URL: unsupported scheme 'ftp' (expected https, or http for a \
             loopback host)"
        );
        let base = resolve_server_url(Some(" http://LOCALHOST:4041/ ")).unwrap();
        assert_eq!(base.url, "http://localhost:4041");
        assert!(!base.is_https);
    }
}
