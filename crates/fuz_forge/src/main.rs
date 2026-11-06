//! `fuz_forge` client CLI (`fuzf`).
//!
//! The forge *client*: it talks to a running forge over JSON-RPC + the
//! content-addressed file store. It does **not** provision or deploy machines
//! (that's the standalone `zap` CLI), and it does **not** run the server (that
//! ships as the separate `fuzfd` binary).
//!
//! Commands:
//! - `init` — write `<fuz_forge_home>/config.json` (server URL)
//! - `file put|get|list|delete` — content-addressed file store
//! - `repo list|create|view|clone|log|show|refs|resync` — forge repos
//! - `tool publish` — the Rust-native producer half: signs (ed25519 over the
//!   domain-tagged canonical JSON, single-sourced via `fuz_sign`) and uploads
//!   first-party tool artifacts; the forge never signs.
//! - `version` — version + git info
//!
//! # Exit codes
//!
//! A small, stable contract keyed to the caller's remediation, not to error
//! type:
//! - `0` — success.
//! - `2` — the caller must change something local before re-running: the
//!   invocation (bad/missing args, a declined confirmation, a request the
//!   forge refuses as malformed — `400` / `-32602`, a `tool publish` name,
//!   version, or binary it refuses), the config (no or malformed server URL,
//!   unresolved home, an unloadable signing key), or the credentials (no
//!   token, or one the forge refuses — `401` / `403` / `-32001` / `-32002`).
//!   "Don't retry as-is."
//! - `1` — anything else: a server/RPC error, a transient network failure,
//!   local I/O, a decode error, or a missing target. "A retry may help, or it
//!   is out of the caller's hands."
//!
//! `--json` shapes success output only; errors are text on stderr, with no
//! further exit codes.

mod cli;
mod client;
mod config;
mod error;
mod format;
mod output;
mod repo_id;

use argh::FromArgs;
pub use error::CliError;
use std::process::ExitCode;

/// fuzf — forge client CLI.
#[derive(FromArgs, Debug)]
struct TopLevel {
    #[argh(subcommand)]
    nested: Subcommand,
}

#[derive(FromArgs, Debug)]
#[argh(subcommand)]
enum Subcommand {
    Init(cli::init::Init),
    File(cli::file::File),
    Repo(cli::repo::Repo),
    Tool(cli::tool::Tool),
    Version(cli::version::Version),
}

fn main() -> ExitCode {
    // Usage errors exit 2 (argh's own `from_env()` would exit 1); `--help`
    // prints to stdout and exits 0 (the version is the `version` subcommand).
    let cmd = match fuz_sys::cli::parse_env_args::<TopLevel>(fuz_sys::cli::EXIT_USAGE) {
        Ok(cmd) => cmd,
        Err(code) => return code,
    };
    let Err(e) = run(cmd) else {
        return ExitCode::SUCCESS;
    };
    // Confirmation-declined paths print their own prompt and carry no message.
    if let Some(code) = e.silent_exit_code() {
        return ExitCode::from(code);
    }
    eprintln!("error: {}", fuz_sys::cli::format_error_chain(&e));
    if let Some(hint) = e.hint() {
        eprintln!("hint: {hint}");
    }
    ExitCode::from(e.exit_code())
}

// Async because every command does network and/or file I/O on tokio.
#[tokio::main]
async fn run(cmd: TopLevel) -> Result<(), CliError> {
    match cmd.nested {
        Subcommand::Init(args) => cli::init::cmd_init(&args),
        Subcommand::File(args) => cli::file::cmd_file(args).await,
        Subcommand::Repo(args) => cli::repo::cmd_repo(args).await,
        Subcommand::Tool(args) => cli::tool::cmd_tool(args).await,
        Subcommand::Version(args) => cli::version::cmd_version(&args),
    }
}
