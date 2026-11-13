//! `fuzf version` — show version + git info.
//!
//! `FUZ_FORGE_GIT_INFO` is embedded by `build.rs` (`git describe`).

use argh::FromArgs;

use crate::CliError;

/// Show version information.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "version")]
pub struct Version {}

#[expect(
    clippy::unnecessary_wraps,
    reason = "every subcommand handler returns `Result<(), CliError>` for `run`'s dispatch `match`"
)]
pub fn cmd_version(_args: &Version) -> Result<(), CliError> {
    println!(
        "fuzf {} ({})",
        env!("CARGO_PKG_VERSION"),
        env!("FUZ_FORGE_GIT_INFO")
    );
    Ok(())
}
