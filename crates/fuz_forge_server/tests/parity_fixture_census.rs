//! **The parity-fixture census (Rust)** — every fixture under
//! `src/test/fixtures/parity/` is read by at least one `include_str!` under
//! `crates/`, and every path an `include_str!` names exists.
//!
//! ## What counts as reading a fixture
//!
//! Only an `include_str!("…/<name>.json")` does. The scan is anchored to the
//! macro token rather than matching the path substring anywhere in a `.rs`
//! file, because a **rustdoc mention** of a fixture is not a consumer: a
//! module doc naming `src/test/fixtures/parity/repo_slug.json` would otherwise
//! keep that fixture "protected" long after the last test module stopped
//! reading it, which is exactly the orphaning this census exists to catch.
//!
//! ## Why this test exists
//!
//! A shared fixture is only anti-drift while both sides read it. The failure
//! this catches is not "someone changed a row" — the row tables fail loudly on
//! their own — it is **"someone stopped reading the file."** A test module
//! refactored back onto a hand-written table leaves the fixture in place, still
//! correct, still asserted by the *other* backend, and silently no longer a
//! shared contract. Orphaning is invisible without a census, so the set of
//! consumed fixtures is an assertion.
//!
//! The TS half is `src/test/fixtures/parity/parity_fixtures.meta.test.ts`,
//! which asks the same question of the `load_parity_fixture(...)` callsites
//! under `src/test/`. Both must pass for a fixture to be doing its job.
//!
//! It also parses every fixture, so the envelope guards — `tables` present,
//! every table non-empty and object-rowed, `counts` agreeing with `tables` —
//! run over the whole directory rather than only the tables a test module
//! happens to touch. The scan is the pattern `tests/token_surface_census.rs`
//! established: walk `crates/` at runtime off `CARGO_MANIFEST_DIR`, skipping
//! `target/`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests panic on assertion failure by design"
)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// `<repo>/crates`.
fn crates_dir() -> PathBuf {
    // `CARGO_MANIFEST_DIR` is `<repo>/crates/fuz_forge_server`.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates dir")
        .to_path_buf()
}

/// `<repo>/src/test/fixtures/parity`.
fn parity_dir() -> PathBuf {
    crates_dir()
        .parent()
        .expect("repo root")
        .join("src/test/fixtures/parity")
}

/// Every fixture basename in the parity directory.
fn fixture_names() -> BTreeSet<String> {
    std::fs::read_dir(parity_dir())
        .expect("the parity fixture directory exists")
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "json") {
                Some(
                    path.file_stem()
                        .expect("a file stem")
                        .to_string_lossy()
                        .into_owned(),
                )
            } else {
                None
            }
        })
        .collect()
}

/// Every `.rs` file under `crates/`, skipping build output.
fn rs_sources() -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![crates_dir()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // Skip build output; it contains generated copies.
                if path.file_name().is_some_and(|n| n == "target") {
                    continue;
                }
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "rs")
                && let Ok(text) = std::fs::read_to_string(&path)
            {
                found.push(text);
            }
        }
    }
    found
}

/// The directory prefix every `include_str!` of a parity fixture carries.
const PARITY_PREFIX: &str = "src/test/fixtures/parity/";

/// The macro token a real consumer is anchored to.
const INCLUDE_STR: &str = "include_str!";

/// The fixture basename an `include_str!` string literal names, if it names
/// one. `literal` is the macro's argument with its quotes already stripped.
fn fixture_basename(literal: &str) -> Option<&str> {
    let (_, tail) = literal.rsplit_once(PARITY_PREFIX)?;
    let name = tail.strip_suffix(".json")?;
    let is_basename = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    is_basename.then_some(name)
}

/// The fixture basenames named by an `include_str!` anywhere under `crates/`.
///
/// Anchored to the `include_str!(` token, so a rustdoc mention of a fixture
/// path is prose rather than consumption — see the module doc.
fn included_names() -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for source in rs_sources() {
        for (index, marker) in source.match_indices(INCLUDE_STR) {
            // `include_str!` `(` `"` <path> `"`, whitespace (a wrapped line
            // included) allowed between the tokens.
            let rest = source[index + marker.len()..].trim_start();
            let Some(rest) = rest.strip_prefix('(') else {
                continue;
            };
            let Some(rest) = rest.trim_start().strip_prefix('"') else {
                continue;
            };
            let Some(end) = rest.find('"') else {
                continue;
            };
            if let Some(name) = fixture_basename(&rest[..end]) {
                found.insert(name.to_owned());
            }
        }
    }
    found
}

#[test]
fn the_parity_directory_is_not_empty() {
    assert!(
        !fixture_names().is_empty(),
        "no parity fixtures found under {}",
        parity_dir().display(),
    );
}

#[test]
fn every_fixture_is_read_by_at_least_one_crate() {
    let included = included_names();
    let orphaned: Vec<String> = fixture_names()
        .into_iter()
        .filter(|name| !included.contains(name))
        .collect();
    assert!(
        orphaned.is_empty(),
        "orphaned parity fixtures (no `include_str!` under crates/): {orphaned:?}",
    );
}

#[test]
fn every_included_name_names_a_fixture() {
    let present = fixture_names();
    let missing: Vec<String> = included_names()
        .into_iter()
        .filter(|name| !present.contains(name))
        .collect();
    assert!(
        missing.is_empty(),
        "crates include parity fixtures that do not exist: {missing:?}",
    );
}

/// Whether a `source_ts` / `source_rust` field is well-formed: a path, or a
/// non-empty list of them where a fixture has more than one home on that side.
fn names_sources(value: &Value) -> bool {
    match value {
        Value::String(_) => true,
        Value::Array(paths) => !paths.is_empty() && paths.iter().all(Value::is_string),
        _ => false,
    }
}

/// The envelope guards, over the whole directory: `tables` present, every
/// table a non-empty list of objects, `counts` agreeing with `tables`, and the
/// three descriptive fields named. Twin: the TS loader's own guards.
#[test]
fn every_fixture_satisfies_the_envelope_guards() {
    for name in fixture_names() {
        let path = parity_dir().join(format!("{name}.json"));
        let raw = std::fs::read_to_string(&path).expect("fixture reads");
        let fixture: Value = serde_json::from_str(&raw).expect("fixture parses");
        assert!(fixture["function"].is_string(), "{name} names no function");
        for field in ["source_ts", "source_rust"] {
            assert!(names_sources(&fixture[field]), "{name} names no {field}");
        }
        let tables = fixture["tables"]
            .as_object()
            .unwrap_or_else(|| panic!("{name} has no tables"));
        let counts = fixture["counts"]
            .as_object()
            .unwrap_or_else(|| panic!("{name} has no counts"));
        for (table, rows) in tables {
            let rows: &Vec<Value> = rows
                .as_array()
                .unwrap_or_else(|| panic!("{name} table {table} is not a list"));
            assert!(!rows.is_empty(), "{name} table {table} is empty");
            for row in rows {
                let is_row = |row: &Map<String, Value>| !row.is_empty();
                assert!(
                    row.as_object().is_some_and(is_row),
                    "{name} table {table} has a non-object row",
                );
            }
            assert_eq!(
                counts.get(table),
                Some(&Value::from(rows.len())),
                "{name} table {table} count",
            );
        }
        for table in counts.keys() {
            assert!(
                tables.contains_key(table),
                "{name} counts name an absent table {table}",
            );
        }
    }
}
