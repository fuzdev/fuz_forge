//! Subcommand modules — one per top-level command.
//!
//! Each module owns its argh `FromArgs` struct and `cmd_*` handler. Commands
//! with sub-verbs (`file`, `repo`, `tool`) use a nested `#[argh(subcommand)]`
//! enum, a parent struct plus a `*Sub` enum.
//!
//! # Flag-naming convention
//!
//! argh long-names are **kebab-case only** — `long = "snake_case"` is a compile
//! error. The default derivation already kebabs the field name (`key_file` →
//! `--key-file`), so multi-word flags land as kebab-case with no override,
//! matching the sibling `fuz` Rust CLIs. A single-word flag needs no override
//! at all; short aliases use `#[argh(switch, short = 'y')]`.

pub mod file;
pub mod init;
pub mod repo;
pub mod tool;
pub mod version;

use serde::Serialize;

use crate::CliError;
use crate::client::ClientError;
use crate::format::render_json;

/// Print `value` as the CLI's tab-indented `--json` (the shared `--json`
/// convention). Serialization writes into an in-memory buffer and can't
/// realistically fail for an already-parsed `Value` / render DTO, but the
/// (unreachable) error is surfaced as `CliError` rather than unwrapped.
pub fn print_json<T: Serialize>(value: &T) -> Result<(), CliError> {
    render_json(value).map_err(|e| ClientError::Decode(e).into())
}
