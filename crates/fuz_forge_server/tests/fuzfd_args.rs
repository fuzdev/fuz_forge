//! `fuzfd`'s argument handling, against the real binary: `--help` exits `0`
//! with usage on stdout, and an invocation that names no known command exits
//! `2` with usage on stderr — before reading any env or binding any port — and
//! a configuration failure exits `2` with its error, so none of these needs a
//! database.

#![allow(clippy::expect_used)]

use std::process::{Command, Output};

fn fuzfd(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_fuzfd"))
        .args(args)
        .env_clear()
        .output()
        .expect("spawn fuzfd")
}

#[test]
fn help_prints_usage_and_exits_zero() {
    for flag in ["--help", "-h"] {
        let out = fuzfd(&[flag]);
        assert_eq!(out.status.code(), Some(0), "{flag}");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.starts_with("Usage: fuzfd <command>"),
            "{flag}: {stdout}"
        );
    }
}

#[test]
fn anything_else_prints_usage_and_exits_two() {
    for args in [
        &[][..],
        &["strat"],
        &["--env_file", "x"],
        &["start", "extra"],
    ] {
        let out = fuzfd(args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            stderr.contains("Usage: fuzfd <command>"),
            "{args:?}: {stderr}"
        );
        assert!(out.stdout.is_empty(), "{args:?}: nothing on stdout");
    }
}

#[test]
fn a_config_error_exits_two_with_the_error_chain() {
    let out = fuzfd(&["start"]);
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("error: invalid configuration: FUZ_ALLOWED_ORIGINS: "),
        "{stderr}"
    );
}
