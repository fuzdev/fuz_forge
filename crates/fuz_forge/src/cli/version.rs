//! `fuzf version` — show version + git info.
//!
//! `FUZ_FORGE_GIT_INFO` is embedded by `build.rs` (`git describe`).

use argh::FromArgs;

use crate::CliError;

/// Show version information.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "version")]
pub struct Version {}

#[allow(clippy::unnecessary_wraps)] // uniform handler signature
pub fn cmd_version(_args: &Version) -> Result<(), CliError> {
    println!(
        "fuzf {} ({})",
        env!("CARGO_PKG_VERSION"),
        env!("FUZ_FORGE_GIT_INFO")
    );
    Ok(())
}
