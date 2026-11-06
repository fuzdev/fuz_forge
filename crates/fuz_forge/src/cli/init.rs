//! `fuzf init` — write the forge server URL to `<fuz_forge_home>/config.json`.
//!
//! Server URL only: the client never touches the DB, and provisioning is
//! delegated to `zap`.

use argh::FromArgs;
use fuz_storage::base_url::validate_base_url;

use crate::CliError;
use crate::config::{self, ConfigError, FuzForgeConfig};

/// Initialize or update forge configuration.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "init")]
pub struct Init {
    /// forge server URL (e.g. <https://forge.example.com>)
    #[argh(option)]
    pub server: Option<String>,
}

pub fn cmd_init(args: &Init) -> Result<(), CliError> {
    let existing = config::load_config()?;
    let path = config::config_path()?;

    match (args.server.as_deref(), existing) {
        (Some(server), existing) => {
            // Refuse a URL every later command would refuse, before writing
            // it, and save its normalized form — trimmed first, as the
            // `--server` flag and `FUZ_FORGE_BASE_URL` are on resolution.
            let server = validate_base_url(server.trim()).map_err(ConfigError::from)?;
            config::save_config(&FuzForgeConfig {
                fuz_forge_config_server_url: server.url,
            })?;
            let verb = if existing.is_some() {
                "Updated"
            } else {
                "Created"
            };
            println!("{verb} {}", path.display());
            Ok(())
        }
        (None, Some(cfg)) => {
            println!(
                "{} already configured (server: {}).",
                path.display(),
                cfg.fuz_forge_config_server_url
            );
            println!("Update with: fuzf init --server <url>");
            Ok(())
        }
        (None, None) => Err(CliError::Usage(
            "fuzf init requires --server <url>".to_string(),
        )),
    }
}
