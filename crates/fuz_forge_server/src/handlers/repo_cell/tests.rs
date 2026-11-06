use serde_json::{Map, Value, json};

use super::*;

#[test]
fn repo_cell_data_debug_redacts_the_hook_secret_hash() {
    let cell: RepoCellData = serde_json::from_value(json!({
        "slug": "org/repo",
        "name": "repo",
        "default_branch": "main",
        "hook_secret_hash": "hook-secret-Pw6eJ3",
    }))
    .unwrap();
    let rendered = format!("{cell:?}");
    assert!(!rendered.contains("hook-secret-Pw6eJ3"), "{rendered}");
    assert!(rendered.contains("<redacted>"), "{rendered}");
    assert!(rendered.contains("org/repo"), "{rendered}");
}

#[test]
fn repo_cell_data_requires_slug_name_default_branch_hook_secret_hash() {
    // A complete cell parses. The push facts are all optional.
    let full = json!({
        "slug": "org/repo",
        "name": "repo",
        "default_branch": "main",
        "hook_secret_hash": "s3cr3t",
    });
    assert!(serde_json::from_value::<RepoCellData>(full).is_ok());

    // Missing any required field narrows to a parse error — the read sites
    // map that to a skipped (list) / 404 (view) cell, matching the TS
    // `narrow_repo_cell_data` null-on-missing for the same four fields.
    for missing in ["slug", "name", "default_branch", "hook_secret_hash"] {
        let mut obj = Map::new();
        for k in ["slug", "name", "default_branch", "hook_secret_hash"] {
            if k != missing {
                obj.insert(k.into(), Value::String("x".into()));
            }
        }
        assert!(
            serde_json::from_value::<RepoCellData>(Value::Object(obj)).is_err(),
            "cell missing `{missing}` must fail to parse",
        );
    }
}

#[test]
fn hash_hook_secret_is_the_bare_lowercase_blake3_hex() {
    // The BLAKE3 test vector for "abc" — the TS twin hashes the same UTF-8
    // bytes through `hash_blake3`.
    assert_eq!(
        hash_hook_secret("abc"),
        "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"
    );
}

#[test]
fn a_cell_holding_only_a_plaintext_hook_secret_does_not_narrow() {
    // A cell carrying a plaintext `hook_secret` and no digest reads as
    // missing (re-create the repo, or reset the dev database), never as a
    // cell whose callbacks compare against plaintext.
    let legacy = json!({
        "slug": "org/repo",
        "name": "repo",
        "default_branch": "main",
        "hook_secret": "s3cr3t",
    });
    assert!(serde_json::from_value::<RepoCellData>(legacy).is_err());
}

/// A malformed repo cell on the read path is **skipped with a warning**,
/// not dropped silently — the TS twin's posture (`log.warn` + `continue`
/// on list, `log.warn` + 404 on get). Captures the `tracing` output on
/// this thread so the log line itself is asserted, since the skip alone is
/// indistinguishable from the silent drop it replaced.
///
/// Also pins the two ways a cell is unusable — a `data` that fails the
/// [`RepoCellData`] narrow and a `NULL` `cell.path` — and that the caller
/// chooses the message, so the list's "skipping" line never appears on the
/// `get` path (which answers `not_found` instead of skipping past anything).
#[test]
fn a_malformed_repo_cell_is_skipped_with_a_warning() {
    const WELL_FORMED_DATA: &str =
        r#"{"slug":"org/repo","name":"repo","default_branch":"main","hook_secret_hash":"s"}"#;
    let id = Uuid::nil();
    let row = |data_text: &str, path: Option<&str>| RepoCellRow {
        id,
        path: path.map(str::to_owned),
        data_text: data_text.to_owned(),
        created_at: "2026-01-01T00:00:00Z".to_owned(),
        updated_at: "2026-01-01T00:00:00Z".to_owned(),
    };
    let path = Some("repos/org/repo");

    // Positive control: a well-formed cell converts, and logs nothing.
    let (ok, quiet) = capture_warnings(|| {
        repo_cell_to_output(
            "fuz_forge_repo_list",
            REPO_CELL_SKIPPED_MESSAGE,
            row(WELL_FORMED_DATA, path),
        )
    });
    assert!(ok.is_some(), "a well-formed cell must convert");
    assert!(quiet.is_empty(), "the happy path must log nothing: {quiet}");

    // A cell missing `hook_secret_hash` fails the narrow → skipped + warned,
    // with the caller's method and the cell id in the line.
    let (skipped, warned) = capture_warnings(|| {
        repo_cell_to_output(
            "fuz_forge_repo_list",
            REPO_CELL_SKIPPED_MESSAGE,
            row(
                r#"{"slug":"org/repo","name":"repo","default_branch":"main"}"#,
                path,
            ),
        )
    });
    assert!(skipped.is_none(), "a malformed cell must be skipped");
    assert!(
        warned.contains(REPO_CELL_SKIPPED_MESSAGE),
        "expected the skip warning, got: {warned}"
    );
    assert!(
        warned.contains("fuz_forge_repo_list") && warned.contains(&id.to_string()),
        "the warning must name the caller + the cell id, got: {warned}"
    );

    // A `NULL` `cell.path` takes the same exit even with well-formed
    // `data` — the TS gate is `!data || cell.path === null`, and a repo
    // cell with no `repos/<slug>` address can't be looked up by slug,
    // cloned, or resynced.
    let (no_path, warned_no_path) = capture_warnings(|| {
        repo_cell_to_output(
            "fuz_forge_repo_list",
            REPO_CELL_SKIPPED_MESSAGE,
            row(WELL_FORMED_DATA, None),
        )
    });
    assert!(
        no_path.is_none(),
        "a cell with a NULL path must be skipped even with well-formed data"
    );
    assert!(
        warned_no_path.contains(REPO_CELL_SKIPPED_MESSAGE)
            && warned_no_path.contains(r#"path="null""#),
        "the NULL-path skip must warn and say so, got: {warned_no_path}"
    );

    // The `get` caller's message is its own — it 404s rather than skipping,
    // so its line must not claim a skip (the TS twin's two distinct
    // `log.warn` strings).
    let (_, warned_get) = capture_warnings(|| {
        repo_cell_to_output(
            "fuz_forge_repo_get",
            REPO_CELL_MALFORMED_MESSAGE,
            row(WELL_FORMED_DATA, None),
        )
    });
    assert!(
        warned_get.contains(REPO_CELL_MALFORMED_MESSAGE)
            && !warned_get.contains(REPO_CELL_SKIPPED_MESSAGE),
        "the get caller must log its own message, got: {warned_get}"
    );
}

/// Run `f` with a thread-local `tracing` subscriber capturing WARN-level
/// output, returning its value alongside the captured text.
fn capture_warnings<T>(f: impl FnOnce() -> T) -> (T, String) {
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct SharedBuf(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for SharedBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("buffer lock").extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let buf = SharedBuf(Arc::new(Mutex::new(Vec::new())));
    let subscriber = tracing_subscriber::fmt()
        .with_writer({
            let buf = buf.clone();
            move || buf.clone()
        })
        .with_max_level(tracing::Level::WARN)
        .with_ansi(false)
        .finish();
    let value = tracing::subscriber::with_default(subscriber, f);
    let captured = String::from_utf8(buf.0.lock().expect("buffer lock").clone())
        .expect("captured log is utf-8");
    (value, captured)
}
