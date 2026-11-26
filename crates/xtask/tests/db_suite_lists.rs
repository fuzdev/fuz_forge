//! The PostgreSQL leg's hand-kept crate list agrees with the tree.
//!
//! The `Test (Postgres)` step of `.github/workflows/check.yml` runs
//! `cargo test -p <crates> -- --include-ignored` under `FUZ_TEST_POSTGRES_URL`.
//! A crate with database tests missing from that `-p` list leaves the job
//! green while its tests never meet PostgreSQL, and its `postgres-only:` tests
//! never run at all. So this holds the list, in both directions, to the
//! workspace members with database tests: a crate whose sources open a test
//! database (`TestingDbOptions`, `fresh_test_db`) or carry a `postgres-only:`
//! or `pglet:` ignore, or whose `Cargo.toml` declares a dev-dependency on
//! `fuz_testing` under a table header (`[dev-dependencies]` or a target's, the
//! dependency's own table, a rename), which catches an opener none of those
//! names does. Twin of the spine's `crates/xtask/tests/db_suite_lists.rs`, cut
//! to this workspace's one list.

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

/// Whether the crate at `dir` declares a dev-dependency on `fuz_testing`, as
/// [`has_fuz_testing_dev_dependency`] reads its `Cargo.toml`.
fn dev_depends_on_fuz_testing(dir: &Path) -> bool {
    fs::read_to_string(dir.join("Cargo.toml"))
        .is_ok_and(|manifest| has_fuz_testing_dev_dependency(&manifest))
}

/// The crate whose dev-dependency edge marks a member as having database
/// tests.
const TESTING_CRATE: &str = "fuz_testing";

/// Which part of a manifest a line sits in, as far as dev-dependencies go.
#[derive(Clone, Copy, PartialEq, Eq)]
enum DevSection {
    /// Not a dev-dependency table.
    Other,
    /// `[dev-dependencies]` or `[target.<spec>.dev-dependencies]`: each key is
    /// a dependency.
    Table,
    /// `[dev-dependencies.<name>]` (or under a target): one dependency's own
    /// table, `true` when `<name>` is `fuz_testing`.
    Entry(bool),
}

/// Whether a member's `manifest` declares a dev-dependency on `fuz_testing`
/// under a table header: a key in `[dev-dependencies]` or
/// `[target.<spec>.dev-dependencies]` (bare, quoted or dotted), the
/// dependency's own `[dev-dependencies.fuz_testing]` table (under a target
/// too), or another name renamed to it with `package = "fuz_testing"`.
/// Headers may carry whitespace and a trailing comment.
///
/// Read line by line: the workspace carries no TOML parser, and this is not
/// worth adding one for. So a dotted key that opens the table itself
/// (`dev-dependencies.fuz_testing` at the root or under `[target.<spec>]`) is
/// not read, and an inline table spread over several lines is read only from
/// its first.
fn has_fuz_testing_dev_dependency(manifest: &str) -> bool {
    let mut section = DevSection::Other;
    for line in manifest.lines() {
        let line = strip_toml_comment(line).trim();
        if let Some(header) = line.strip_prefix('[') {
            section = dev_section(header);
            if section == DevSection::Entry(true) {
                return true;
            }
            continue;
        }
        let Some((key, rest)) = toml_key(line) else {
            continue;
        };
        if !rest.trim_start().starts_with('=') {
            continue;
        }
        let found = match section {
            DevSection::Other => false,
            DevSection::Table => {
                key.first().map(String::as_str) == Some(TESTING_CRATE)
                    || renames_to_testing_crate(rest)
            }
            DevSection::Entry(_) => key == ["package"] && renames_to_testing_crate(line),
        };
        if found {
            return true;
        }
    }
    false
}

/// The [`DevSection`] a table header opens, given the text after its `[`.
fn dev_section(header: &str) -> DevSection {
    // `None` too for `[[…]]`, an array of tables (`[[bin]]`, `[[test]]`),
    // which holds no dependency
    let Some((key, rest)) = toml_key(header) else {
        return DevSection::Other;
    };
    if rest.trim_start().strip_prefix(']').map(str::trim) != Some("") {
        return DevSection::Other;
    }
    let key: Vec<&str> = key.iter().map(String::as_str).collect();
    let tail = match key.as_slice() {
        ["target", _, tail @ ..] => tail,
        all => all,
    };
    match tail {
        ["dev-dependencies"] => DevSection::Table,
        ["dev-dependencies", name] => DevSection::Entry(*name == TESTING_CRATE),
        _ => DevSection::Other,
    }
}

/// Whether `text` holds `package = "fuz_testing"` (either quote, any spacing).
fn renames_to_testing_crate(text: &str) -> bool {
    let packed: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    packed.contains(&format!("package=\"{TESTING_CRATE}\""))
        || packed.contains(&format!("package='{TESTING_CRATE}'"))
}

/// `line` up to its first `#` outside a string.
fn strip_toml_comment(line: &str) -> &str {
    let mut quote = None;
    let mut escaped = false;
    for (i, c) in line.char_indices() {
        match quote {
            Some('"') if escaped => escaped = false,
            Some('"') if c == '\\' => escaped = true,
            Some(q) if c == q => quote = None,
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '#' => return line.split_at(i).0,
            Some(_) | None => {}
        }
    }
    line
}

/// The dotted key at the start of `text` — bare, `"basic"` (escapes kept
/// raw) or `'literal'` segments joined by `.`, with whitespace around the
/// dots — and the text after it; `None` when `text` opens no key.
fn toml_key(text: &str) -> Option<(Vec<String>, &str)> {
    let mut segments = Vec::new();
    let mut rest = text;
    loop {
        rest = rest.trim_start();
        let (segment, after) = if let Some(quoted) = rest.strip_prefix('"') {
            let mut escaped = false;
            let end = quoted.char_indices().find_map(|(i, c)| {
                let closes = c == '"' && !escaped;
                escaped = c == '\\' && !escaped;
                closes.then_some(i)
            })?;
            let (segment, after) = quoted.split_at(end);
            (segment, after.strip_prefix('"')?)
        } else if let Some(quoted) = rest.strip_prefix('\'') {
            quoted.split_once('\'')?
        } else {
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                .unwrap_or(rest.len());
            if end == 0 {
                return None;
            }
            rest.split_at(end)
        };
        segments.push(segment.to_string());
        match after.trim_start().strip_prefix('.') {
            Some(next) => rest = next,
            None => return Some((segments, after)),
        }
    }
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

#[test]
fn a_target_dev_dependencies_table_counts() {
    for header in [
        "[target.'cfg(unix)'.dev-dependencies]",
        "[target.\"cfg(target_os = \\\"linux\\\")\".dev-dependencies]",
        "[target.x86_64-unknown-linux-gnu.dev-dependencies]",
        // a `#` inside a string is no comment
        "[target.'cfg(feature = \"a#b\")'.dev-dependencies]",
    ] {
        let manifest =
            format!("[package]\nname = \"x\"\n\n{header}\nfuz_testing.workspace = true\n");
        assert!(has_fuz_testing_dev_dependency(&manifest), "{header}");
    }
    let normal = "[target.'cfg(unix)'.dependencies]\nfuz_testing.workspace = true\n";
    assert!(!has_fuz_testing_dev_dependency(normal));
}

#[test]
fn the_dependency_s_own_table_counts() {
    assert!(has_fuz_testing_dev_dependency(
        "[dev-dependencies.fuz_testing]\nworkspace = true\n"
    ));
    assert!(has_fuz_testing_dev_dependency(
        "[target.'cfg(unix)'.dev-dependencies.fuz_testing]\nworkspace = true\n"
    ));
    assert!(has_fuz_testing_dev_dependency(
        "[dev-dependencies . \"fuz_testing\"] # the DB harness\nworkspace = true\n"
    ));
    assert!(!has_fuz_testing_dev_dependency(
        "[dependencies.fuz_testing]\nworkspace = true\n"
    ));
    assert!(!has_fuz_testing_dev_dependency(
        "[dev-dependencies.fuz_testing_extra]\nworkspace = true\n"
    ));
}

#[test]
fn a_header_with_spacing_or_a_trailing_comment_counts() {
    for header in [
        "[dev-dependencies] # test-only",
        "[dev-dependencies]# test-only",
        "[ dev-dependencies ]",
        "  [dev-dependencies]",
    ] {
        let manifest = format!("{header}\nfuz_testing = {{ workspace = true }}\n");
        assert!(has_fuz_testing_dev_dependency(&manifest), "{header}");
    }
    // a header with text after it that is no comment opens no table
    assert!(!has_fuz_testing_dev_dependency(
        "[dev-dependencies] x\nfuz_testing.workspace = true\n"
    ));
}

#[test]
fn a_key_s_spellings_and_a_rename_count() {
    for entry in [
        "fuz_testing.workspace = true",
        "fuz_testing = { workspace = true }",
        "fuz_testing={workspace=true}",
        "\"fuz_testing\" = { workspace = true }",
        "'fuz_testing'.workspace = true",
        "  fuz_testing . workspace = true",
        "testing = { package = \"fuz_testing\", workspace = true }",
    ] {
        let manifest = format!("[dev-dependencies]\n{entry}\n");
        assert!(has_fuz_testing_dev_dependency(&manifest), "{entry}");
    }
    assert!(has_fuz_testing_dev_dependency(
        "[dev-dependencies.testing]\npackage = 'fuz_testing'\nworkspace = true\n"
    ));
    for entry in [
        "# fuz_testing.workspace = true",
        "fuz_testing_extra.workspace = true",
        "other = { workspace = true } # package = \"fuz_testing\"",
        "other = { package = \"fuz_testing_extra\" }",
    ] {
        let manifest = format!("[dev-dependencies]\n{entry}\n");
        assert!(!has_fuz_testing_dev_dependency(&manifest), "{entry}");
    }
    // a value's continuation line is no key
    assert!(!has_fuz_testing_dev_dependency(
        "[dev-dependencies]\nother = { workspace = true, features = [\n    \"fuz_testing\",\n] }\n"
    ));
    // the edge ends with its table
    assert!(!has_fuz_testing_dev_dependency(
        "[dev-dependencies]\ntokio.workspace = true\n\n[features]\nfuz_testing = []\n"
    ));
    assert!(!has_fuz_testing_dev_dependency(
        "[dev-dependencies]\n\n[[bench]]\nfuz_testing = true\n"
    ));
}
