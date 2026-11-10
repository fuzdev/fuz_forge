//! Unit coverage for the failure classifier and its caller mappings.
//!
//! The `#[tokio::test]`s here spawn a **real `git`** — they need `git` on
//! `PATH` (as does every cross-backend suite, where both backends spawn it)
//! and they write a throwaway bare repo under the system temp dir.
//! Everything else is a pure-function assertion.

use fuz_http::JsonrpcErrorCode;

use super::*;
use crate::parity::{field, parity_rows};

const READ_BOUNDS_FIXTURE: &str =
    include_str!("../../../../../src/test/fixtures/parity/git_read_bounds.json");
const GIT_ENV_FIXTURE: &str = include_str!("../../../../../src/test/fixtures/parity/git_env.json");

/// The `PATH` the real-subprocess cases hand the git spawns — the process
/// env's, falling back to [`DEFAULT_GIT_PATH`], exactly as the env seam
/// resolves it in production.
fn test_git_path() -> String {
    std::env::var("PATH").unwrap_or_else(|_| DEFAULT_GIT_PATH.to_owned())
}

/// Every bound this layer applies is declared twice, and each one is a
/// *wire* contract rather than an implementation detail: a smaller diff cap
/// on one backend answers `truncated: true` where the other returns the
/// patch, a smaller blob cap answers `{kind: "truncated"}` where the other
/// returns the bytes, and a narrower sniff window calls a blob binary where
/// the other calls it text. Asserted against
/// `src/test/fixtures/parity/git_read_bounds.json`, which the TS twin
/// (`src/test/server/git/read.test.ts` § read-layer bounds) reads too. The
/// page limits live with the handler that clamps them —
/// `handlers::repo_read`, whose own test reads the same fixture's other table.
#[test]
fn read_layer_bounds_match_the_ts_twin() {
    for row in parity_rows(READ_BOUNDS_FIXTURE, "byte_caps") {
        let declared = match field(&row, "name") {
            "MAX_LOG_BYTES" => MAX_LOG_BYTES,
            "MAX_COMMIT_META_BYTES" => MAX_COMMIT_META_BYTES,
            "MAX_DIFF_BYTES" => MAX_DIFF_BYTES,
            "MAX_REFS_BYTES" => MAX_REFS_BYTES,
            "MAX_TREE_BYTES" => MAX_TREE_BYTES,
            "MAX_BLOB_BYTES" => MAX_BLOB_BYTES,
            "BLOB_BINARY_SNIFF_BYTES" => BLOB_BINARY_SNIFF_BYTES,
            other => panic!("no such read-layer bound: {other}"),
        };
        assert_eq!(row["value"], declared, "{}", field(&row, "name"));
    }
}

/// The env is a security surface — it keeps `/etc/gitconfig`, `~/.gitconfig`
/// and the server's own environment out of every `git` the forge runs — and it
/// is hand-written twice, so both halves are asserted against
/// `src/test/fixtures/parity/git_env.json`, which the TS twin's `git_env`
/// suite reads too. A shorter `DEFAULT_GIT_PATH` resolves `git` differently on
/// a host that starts the server without `PATH`.
#[test]
fn git_env_carries_the_injected_path_and_the_locked_down_keys() {
    for row in parity_rows(GIT_ENV_FIXTURE, "constants") {
        assert_eq!(field(&row, "name"), "DEFAULT_GIT_PATH");
        assert_eq!(field(&row, "value"), DEFAULT_GIT_PATH);
    }
    let env = git_env("/injected/bin");
    assert_eq!(env["PATH"], "/injected/bin", "PATH comes from the seam");
    // The exact key set the TS `git_env(deps)` builds — no server env leaks in.
    let mut keys: Vec<&str> = env.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let expected: Vec<String> = parity_rows(GIT_ENV_FIXTURE, "keys")
        .iter()
        .map(|row| field(row, "name").to_owned())
        .collect();
    assert_eq!(keys, expected);
    for row in parity_rows(GIT_ENV_FIXTURE, "env") {
        let name = field(&row, "name");
        assert_eq!(env[name], field(&row, "value"), "{name}");
    }
}

/// A throwaway `git init --bare` repo under the system temp dir, removed on
/// drop. The forge workspace deliberately doesn't dep `tempfile` (same
/// hand-rolled scratch-dir posture as `tests/signed_tool_install.rs`).
struct ScratchBareRepo(std::path::PathBuf);

impl ScratchBareRepo {
    fn create() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "fuz_forge_git_read_{}.git",
            fuz_sys::rand::random_hex_suffix()
        ));
        let status = std::process::Command::new("git")
            .args(["init", "--bare", "--quiet", "--initial-branch=main"])
            .arg(&dir)
            .status()
            .expect("spawn `git init --bare` (this test needs `git` on PATH)");
        // Construct the guard *before* asserting: `git init` can fail after
        // having created the dir, and a panic here would leak it into the
        // system temp dir on every run. `Drop` runs during the unwind.
        let repo = Self(dir);
        assert!(status.success(), "`git init --bare` failed");
        repo
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }

    /// Put one commit on `refs/heads/main` with git plumbing — an empty
    /// tree, `commit-tree`, `update-ref` — so a reader that needs the rev
    /// to *resolve* has something to walk. A bare repo has no work tree, so
    /// there is no `git commit` to reach for.
    ///
    /// Load-bearing for the `--author` cases: git resolves the rev before
    /// it compiles a header pattern, so on an empty repo an uncompilable
    /// pattern never reaches the compiler and the reader answers the
    /// empty page for the *ref*, not the pattern.
    fn seed_commit(&self) {
        let git = |args: &[&str]| -> String {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .env("GIT_AUTHOR_NAME", "Forge Test")
                .env("GIT_AUTHOR_EMAIL", "test@fuz.dev")
                .env("GIT_COMMITTER_NAME", "Forge Test")
                .env("GIT_COMMITTER_EMAIL", "test@fuz.dev")
                .output()
                .expect("spawn git (this test needs `git` on PATH)");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_owned()
        };
        let tree = git(&["hash-object", "-w", "-t", "tree", "/dev/null"]);
        let commit = git(&["commit-tree", &tree, "-m", "seed"]);
        git(&["update-ref", "refs/heads/main", &commit]);
    }
}

impl Drop for ScratchBareRepo {
    fn drop(&mut self) {
        drop(std::fs::remove_dir_all(&self.0));
    }
}

/// The classifier's contract: a spawn failure and a cap overflow are both
/// *transient read failures* (`-32007`/503), never the `-32603`/500 that
/// reads as a server bug. Matches `read.ts`, where both fold into
/// `subprocess_failed` / `output_too_large` and every handler maps those to
/// `service_unavailable`.
#[test]
fn spawn_failure_and_cap_overflow_map_to_service_unavailable() {
    let thrown = GitFail::Thrown("spawn git: No such file or directory".to_owned());
    let err = git_unavailable("test", "failed to read repo history", &thrown);
    assert_eq!(err.code, JsonrpcErrorCode::ServiceUnavailable);
    assert_eq!(err.message, "failed to read repo history");
    let too_large = git_unavailable("test", "failed to read tree", &GitFail::TooLarge);
    assert_eq!(too_large.code, JsonrpcErrorCode::ServiceUnavailable);
    assert_eq!(too_large.message, "failed to read tree");
}

#[test]
fn fail_detail_mirrors_the_ts_rendering() {
    assert_eq!(fail_detail(&GitFail::Thrown("boom".to_owned())), "boom");
    assert_eq!(
        fail_detail(&GitFail::Nonzero {
            stderr: "fatal: nope".to_owned(),
            code: 128,
        }),
        "fatal: nope"
    );
    // Empty stderr falls back to the exit code (`read.ts:fail_detail`).
    assert_eq!(
        fail_detail(&GitFail::Nonzero {
            stderr: String::new(),
            code: 128,
        }),
        "exit code 128"
    );
}

/// Real subprocess against a real bare repo: an absent ref exits non-zero,
/// and its stderr is wording [`is_no_such_ref_stderr`] admits — the arm
/// every caller's `not_found` / empty-page / `None`-tip mapping keys off.
/// The repo has to be real for the stderr half to mean anything (pointed at
/// an arbitrary cwd, git can fail for unrelated reasons and the assertion
/// passes by accident).
///
/// This argv shape — `rev-parse --verify refs/heads/<absent>` — is the
/// default-branch tip's, and git answers it with `fatal: Needed a single
/// revision`, not the log reader's `bad revision`.
#[tokio::test]
async fn git_run_classifies_a_real_nonzero_exit() {
    let repo = ScratchBareRepo::create();
    let fail = git_run(
        &test_git_path(),
        repo.path(),
        vec![
            "rev-parse".to_owned(),
            "--verify".to_owned(),
            "refs/heads/fuz-forge-no-such-ref-xyz".to_owned(),
        ],
        4096,
    )
    .await
    .unwrap_err();
    let GitFail::Nonzero { code, stderr } = fail else {
        panic!("expected a non-zero exit, got {fail:?}");
    };
    assert_ne!(code, 0);
    assert!(
        is_no_such_ref_stderr(&stderr),
        "the classifier must admit git's real wording: {stderr:?}"
    );
}

/// The caller mapping the classifier exists for: a no-such-ref non-zero
/// exit becomes [`read_log`]'s documented **empty page**, not a 503.
/// Real subprocess against an empty bare repo — the shape a client hits on
/// a never-pushed repo.
#[tokio::test]
async fn read_log_maps_a_no_such_ref_exit_to_the_empty_page() {
    let repo = ScratchBareRepo::create();
    let commits = read_log(
        &test_git_path(),
        repo.path(),
        "main",
        None,
        10,
        &LogFilters::default(),
    )
    .await
    .expect("an absent ref is the empty page, never an error");
    assert!(
        commits.is_empty(),
        "expected the empty page, got {commits:?}"
    );
}

/// The other caller mapping: `rev-parse --verify refs/heads/<absent>`'s
/// `Needed a single revision` is the `null` tip
/// [`read_default_branch_tip`] documents (and `fuz_forge_repo_resync`
/// writes), not a 503 that would leave a stale `head_sha` in place.
#[tokio::test]
async fn read_default_branch_tip_is_none_on_an_empty_repo() {
    let repo = ScratchBareRepo::create();
    let tip = read_default_branch_tip(&test_git_path(), repo.path(), "main")
        .await
        .expect("an absent default branch is `None`, never a 503");
    assert_eq!(tip, None);
}

/// Real subprocess against a real repo with real history: an `--author`
/// pattern git's regex compiler refuses is `-32602` with the fixed message,
/// not the 503 an unclassified stderr produces and not the empty page a
/// forged ref-miss vocabulary would produce.
///
/// The pattern is the adversarial one on purpose. git echoes it into the
/// stderr the classifiers read, so `bad revision [` yields
/// `fatal: header, 'bad revision [': ...` — which [`is_no_such_ref_stderr`]
/// *also* matches. This case is therefore the pin on the classifier
/// **order** in [`read_log`], which no predicate test can express: with
/// the arms swapped the call returns `Ok(vec![])` and this fails. The
/// assertion below on the raw stderr proves the collision is live rather
/// than hypothetical. Twin: `read.test.ts`'s injected-stderr case, and the
/// `repo_read_shapes` cross case that drives the same pattern over both
/// wires.
#[tokio::test]
async fn read_log_refuses_an_uncompilable_author_pattern() {
    let repo = ScratchBareRepo::create();
    // git resolves the rev before compiling the pattern, so the repo needs
    // a reachable `main` or the pattern is never reached at all.
    repo.seed_commit();
    let git_path = test_git_path();
    // The collision is real: git's own stderr for this pattern satisfies
    // the ref-miss predicate as well as the pattern one.
    let raw = git_run(
        &git_path,
        repo.path(),
        vec![
            "log".to_owned(),
            "-n".to_owned(),
            "5".to_owned(),
            "--author=bad revision [".to_owned(),
            "main".to_owned(),
            "--".to_owned(),
        ],
        4096,
    )
    .await
    .unwrap_err();
    let GitFail::Nonzero { stderr, .. } = raw else {
        panic!("expected a non-zero exit, got {raw:?}");
    };
    assert!(is_invalid_pattern_stderr(&stderr), "{stderr:?}");
    assert!(
        is_no_such_ref_stderr(&stderr),
        "the echoed pattern forges a ref miss, which is why order matters: {stderr:?}"
    );

    let err = read_log(
        &git_path,
        repo.path(),
        "main",
        None,
        10,
        &LogFilters {
            author: Some("bad revision ["),
            ..LogFilters::default()
        },
    )
    .await
    .expect_err("an uncompilable author pattern is a refusal, never the empty page");
    assert_eq!(err.code, JsonrpcErrorCode::InvalidParams);
    assert_eq!(err.message, INVALID_AUTHOR_PATTERN_MESSAGE);
}

/// Real subprocess: `git --version` writes ~20 bytes, so a 1-byte cap
/// trips `PayloadTooLarge` — which must classify as `TooLarge` (the arm the
/// diff / blob-body callers degrade to `truncated`), not `Thrown`.
#[tokio::test]
async fn git_run_classifies_a_real_cap_overflow() {
    let fail = git_run(
        &test_git_path(),
        std::path::Path::new("."),
        vec!["--version".to_owned()],
        1,
    )
    .await
    .unwrap_err();
    assert!(
        matches!(fail, GitFail::TooLarge),
        "expected TooLarge, got {fail:?}"
    );
}
