//! The PostgreSQL leg's hand-kept crate list agrees with the tree.
//!
//! The `Test (Postgres)` step of `.github/workflows/check.yml` runs
//! `cargo test -p <crates> -- --include-ignored` under `FUZ_TEST_POSTGRES_URL`.
//! A crate with database tests missing from that `-p` list leaves the job
//! green while its tests never meet PostgreSQL, and its `postgres-only:` tests
//! never run at all. So this holds the list, in both directions, to the
//! workspace members with database tests: a crate whose sources open a test
//! database (`TestingDbOptions`, `fresh_test_db`) or carry a `postgres-only:`
//! or `pglet:` ignore, or whose `Cargo.toml` lists `fuz_testing` under
//! `[dev-dependencies]` (an opener none of those names catches). Twin of the
//! spine's `crates/xtask/tests/db_suite_lists.rs`, cut to this workspace's
//! one list.

#![expect(
    clippy::expect_used,
    reason = "test helpers outside `#[test]` fns panic on a failed read"
)]

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const WORKFLOW: &str = ".github/workflows/check.yml";
// split, so this file doesn't name them itself
const MARKERS: &[&str] = &[
    concat!("TestingDb", "Options"),
    concat!("fresh_test", "_db"),
    concat!("postgres", "-only:"),
    // the ignore reason's opening quote, so a `pglet::` path doesn't match
    concat!("#[ignore = \"pglet", ": "),
];

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

/// The `-p` names of every `cargo test` line that runs `--include-ignored`.
fn workflow_list(root: &Path) -> BTreeSet<String> {
    let workflow = fs::read_to_string(root.join(WORKFLOW)).expect("read the workflow");
    let mut names = BTreeSet::new();
    for line in workflow.lines() {
        let line = line.trim_start();
        if line.starts_with('#')
            || !line.contains("cargo test")
            || !line.contains("--include-ignored")
        {
            continue;
        }
        let mut words = line.split_whitespace();
        while let Some(word) = words.next() {
            if word == "-p" {
                names.insert(words.next().expect("a crate after -p").to_owned());
            }
        }
    }
    assert!(
        !names.is_empty(),
        "{WORKFLOW} names no `--include-ignored` crate"
    );
    names
}

/// Whether any `.rs` file under `dir` names a marker outside a `//` comment.
fn names_a_marker(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        if path.is_dir() {
            return path.file_name().is_none_or(|name| name != "target") && names_a_marker(&path);
        }
        path.extension().is_some_and(|ext| ext == "rs")
            && fs::read_to_string(&path).is_ok_and(|source| {
                source.lines().any(|line| {
                    let code = line.trim_start();
                    !code.starts_with("//") && MARKERS.iter().any(|marker| code.contains(marker))
                })
            })
    })
}

/// Whether the crate at `dir` lists `fuz_testing` under `[dev-dependencies]`.
fn dev_depends_on_fuz_testing(dir: &Path) -> bool {
    let Ok(manifest) = fs::read_to_string(dir.join("Cargo.toml")) else {
        return false;
    };
    let mut in_dev_dependencies = false;
    manifest.lines().any(|line| {
        let line = line.trim();
        if line.starts_with('[') {
            in_dev_dependencies = line == "[dev-dependencies]";
            return false;
        }
        in_dev_dependencies
            && (line.starts_with("fuz_testing ")
                || line.starts_with("fuz_testing.")
                || line.starts_with("fuz_testing="))
    })
}

/// The workspace members (`crates/<name>/`) with database tests.
fn crates_with_db_tests(root: &Path) -> BTreeSet<String> {
    fs::read_dir(root.join("crates"))
        .expect("read crates/")
        .flatten()
        .filter(|entry| dev_depends_on_fuz_testing(&entry.path()) || names_a_marker(&entry.path()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect()
}

#[test]
fn the_postgres_leg_lists_every_crate_with_db_tests() {
    let root = workspace_root();
    assert_eq!(
        workflow_list(&root),
        crates_with_db_tests(&root),
        "the `-p` list of {WORKFLOW}'s `--include-ignored` step (left) must name \
         exactly the crates with database tests (right)"
    );
}
