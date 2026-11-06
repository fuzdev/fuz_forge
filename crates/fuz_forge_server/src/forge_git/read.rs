//! Git subprocess read layer.
//!
//! Port of `src/lib/server/git/read.ts`: the `git log` / `git show` /
//! `for-each-ref` / `ls-tree` / `cat-file` / `rev-parse` runners over the
//! locked-down [`git_env`], each with its own byte cap and error mapping,
//! plus the blob body union ([`BlobBody`] + [`blob_response`]) and the
//! text/binary sniff. Parsing of the captured stdout is delegated to
//! [`super::parse`]; this module owns the process spawn + I/O.
//!
//! Every git call routes through one classifier ([`git_run`] → [`GitFail`]),
//! the twin of `read.ts`'s `run_git` → `GitRun`: a spawn failure or an
//! output-cap overflow is a *transient read failure* (503), never a
//! `-32603`, and only a non-zero exit reaches a caller's own `not_found`
//! mapping. Argv-shape guards (ref name, path) live in the `read_*` fn
//! that spawns the argv, not in the handlers — again mirroring `read.ts`.
//!
//! Below the shared spawn/classify/resolve prefix the readers appear in
//! `read.ts`'s order — log, default-branch tip, show, refs, tree, blob — so
//! the two files can be diffed against each other top to bottom.

use fuz_forge_wire::output::{
    BlobBody, CommitDetail, CommitDiff, CommitSummary, RefEntry, RepoBlobOutput, TreeEntry,
};
use fuz_http::{JsonrpcError, invalid_params, not_found, service_unavailable};

use super::parse::{
    COMMIT_DETAIL_FORMAT, LOG_RECORD_FORMAT, REF_RECORD_FORMAT, is_full_sha,
    is_invalid_pattern_stderr, is_no_such_path_stderr, is_no_such_ref_stderr, is_safe_path,
    is_safe_ref_name, parse_commit_detail, parse_log_records, parse_ref_records,
    parse_tree_records,
};
use crate::subprocess::{SpawnCollectOptions, spawn_collect};

/// Cap on `git log` stdout bytes.
const MAX_LOG_BYTES: usize = 1_000_000;
/// Cap on `git show --no-patch` commit metadata.
const MAX_COMMIT_META_BYTES: usize = 1_000_000;
/// Cap on `git show -p` diff body bytes.
const MAX_DIFF_BYTES: usize = 5_000_000;

/// Cap on `git for-each-ref` stdout bytes.
const MAX_REFS_BYTES: usize = 1_000_000;
/// Cap on `git ls-tree` stdout bytes.
const MAX_TREE_BYTES: usize = 5_000_000;
/// Cap on `git cat-file blob` stdout bytes.
const MAX_BLOB_BYTES: usize = 5_000_000;
/// Bytes of a blob scanned for a NUL when classifying text vs binary.
const BLOB_BINARY_SNIFF_BYTES: usize = 8192;

/// Fixed message both backends answer an uncompilable `--author` pattern with.
/// Fixed rather than git's stderr, which echoes the pattern back and carries a
/// platform-dependent `regcomp` message. Twin:
/// `read.ts:INVALID_AUTHOR_PATTERN_MESSAGE`.
const INVALID_AUTHOR_PATTERN_MESSAGE: &str = "invalid author pattern";

/// Fallback `PATH` for the forge's git subprocesses when the daemon's own
/// environment carries none.
///
/// Twin of `DEFAULT_GIT_PATH` in `src/lib/server/git/read.ts`, which pins the same
/// literal — a shorter list on either side would resolve `git` differently
/// than the other backend on a host that starts the server without `PATH`.
/// Both sides assert the literal in a unit test so a one-sided edit fails.
/// Applied at the env seam ([`crate::env::FuzForgeEnv::from_vars`]), which is
/// where the TS twin's `deps.env_get('PATH') ?? DEFAULT_GIT_PATH` sits too.
pub const DEFAULT_GIT_PATH: &str = "/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin";

/// Locked-down subprocess env: `PATH` + `LC_ALL` + `GIT_TERMINAL_PROMPT` +
/// `GIT_CONFIG_NOSYSTEM` only, never the server's own environment.
///
/// `git_path` is the resolved `PATH` from [`crate::env::FuzForgeEnv::git_path`]
/// — read through the `from_vars` seam like every other var, not a
/// `std::env::var` here, so a test can inject it. Twin of the TS
/// `git_env(deps)`, which takes its `deps` for exactly the same reason.
///
/// Shared with [`crate::repo_storage`] (as `read.ts:git_env` is shared with
/// `storage.ts`), so the read layer and the `git clone --bare` seed path are
/// isolated identically.
///
/// `GIT_CONFIG_NOSYSTEM=1` is load-bearing, not hygiene: without it
/// `/etc/gitconfig` can carry a `url.<base>.insteadOf` that silently rewrites
/// the remote a validated `seed_from` names, or a `credential.helper` that
/// hands credentials to it. `HOME` is already absent (so `~/.gitconfig` is out
/// of reach) and `GIT_TERMINAL_PROMPT=0` keeps git from blocking on an
/// interactive credential prompt.
pub fn git_env(git_path: &str) -> std::collections::HashMap<String, String> {
    let mut env = std::collections::HashMap::new();
    env.insert("PATH".into(), git_path.to_owned());
    env.insert("LC_ALL".into(), "C.UTF-8".into());
    env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    env.insert("GIT_CONFIG_NOSYSTEM".into(), "1".into());
    env
}

/// Run `git -C <repo_path> <sub_args...>` with the locked-down [`git_env`] and
/// an output cap. The exact structural twin of `read.ts:git_collect`: both
/// factor only the argv prefix + spawn options shared by every git read. The
/// error-mapping envelope is layered on top in [`git_run`].
async fn git_collect(
    git_path: &str,
    repo_path: &std::path::Path,
    sub_args: impl IntoIterator<Item = String>,
    cap: usize,
) -> Result<crate::subprocess::SpawnCollectResult, crate::error::FuzForgeError> {
    let mut args: Vec<String> = vec!["-C".into(), repo_path.display().to_string()];
    args.extend(sub_args);
    spawn_collect(
        "git",
        args,
        &SpawnCollectOptions {
            env: git_env(git_path),
            cwd: None,
            max_output_bytes: Some(cap),
        },
    )
    .await
}

/// The failure half of a [`git_run`] outcome — the twin of `read.ts:GitRun`'s
/// three non-`ok` variants.
///
/// [`GitFail::TooLarge`] is split from [`GitFail::Thrown`] so a caller can
/// degrade a cap overflow into a structured outcome (the commit diff's
/// `truncated`, the blob body's [`BlobBody::Truncated`]) instead of a failure,
/// and [`GitFail::Nonzero`] carries the stderr (decoded once) + exit code so
/// each caller keeps its own `not_found` mapping.
#[derive(Debug)]
enum GitFail {
    /// The spawn itself failed — missing binary, process limit, io error.
    Thrown(String),
    /// Output exceeded the caller's byte cap; the subprocess was killed.
    TooLarge,
    /// git ran and exited non-zero.
    Nonzero { stderr: String, code: i32 },
}

/// [`git_collect`] wrapped in the shared error envelope: folds the spawn error
/// (splitting [`crate::error::FuzForgeError::PayloadTooLarge`] into
/// [`GitFail::TooLarge`]) and a non-zero exit into one classifier, so no caller
/// re-derives what a spawn failure means. The twin of `read.ts:run_git`.
async fn git_run(
    git_path: &str,
    repo_path: &std::path::Path,
    sub_args: impl IntoIterator<Item = String>,
    cap: usize,
) -> Result<Vec<u8>, GitFail> {
    match git_collect(git_path, repo_path, sub_args, cap).await {
        Ok(result) if result.success() => Ok(result.stdout),
        Ok(result) => Err(GitFail::Nonzero {
            stderr: String::from_utf8_lossy(&result.stderr).into_owned(),
            code: result.code,
        }),
        Err(crate::error::FuzForgeError::PayloadTooLarge) => Err(GitFail::TooLarge),
        Err(e) => Err(GitFail::Thrown(e.to_string())),
    }
}

/// Render the log detail for a failed git read: the stderr (or `exit code N`
/// when stderr is empty) for a non-zero exit, else the failure's own message.
/// Twin of `read.ts:fail_detail`.
fn fail_detail(fail: &GitFail) -> String {
    match fail {
        GitFail::Thrown(detail) => detail.clone(),
        GitFail::TooLarge => "output too large".to_owned(),
        GitFail::Nonzero { stderr, code } => {
            if stderr.is_empty() {
                format!("exit code {code}")
            } else {
                stderr.clone()
            }
        }
    }
}

/// Log a failed git read and build its 503. Every [`GitFail`] a caller doesn't
/// map itself lands here — a spawn failure and a cap overflow included, so a
/// missing `git` binary answers `service_unavailable` like the TS twin's
/// `subprocess_failed` / `output_too_large` rather than a `-32603` that reads
/// as a server bug.
fn git_unavailable(label: &str, message: &str, fail: &GitFail) -> JsonrpcError {
    tracing::warn!(label = %label, detail = %fail_detail(fail), "git read failed");
    service_unavailable(message)
}

/// The failure half of a [`resolve_sha`] outcome — the twin of
/// `read.ts:resolve_sha`'s `no_such_ref` / `subprocess_failed` reason split.
/// The kinds stay unmapped here because the same failure is a 404 for the tree
/// reader and a `null` tip for the resync reader.
#[derive(Debug)]
enum ResolveFail {
    /// git exited non-zero with its no-such-ref vocabulary
    /// ([`is_no_such_ref_stderr`]): absent branch, empty repo, GC'd rev.
    NoSuchRef,
    /// A spawn failure, a cap overflow, or a non-zero exit whose stderr git's
    /// no-such-ref vocabulary doesn't cover.
    ReadFailed(GitFail),
    /// `rev-parse` exited 0 but stdout wasn't a full SHA-1.
    NonSha,
}

/// Resolve a rev to a full object SHA via `git rev-parse`, mapping the outcome
/// to the [`ResolveFail`] split shared by [`read_default_branch_tip`] and
/// [`read_tree`]. Twin of `read.ts:resolve_sha`. ([`read_blob`] resolves
/// its own rev inline — it needs the extra ref-vs-path disambiguation probe.)
async fn resolve_sha(
    git_path: &str,
    repo_path: &std::path::Path,
    rev_args: Vec<String>,
) -> Result<String, ResolveFail> {
    let stdout = match git_run(git_path, repo_path, rev_args, 4096).await {
        Ok(stdout) => stdout,
        Err(GitFail::Nonzero { ref stderr, .. }) if is_no_such_ref_stderr(stderr) => {
            return Err(ResolveFail::NoSuchRef);
        }
        Err(fail) => return Err(ResolveFail::ReadFailed(fail)),
    };
    let sha = String::from_utf8_lossy(&stdout).trim().to_owned();
    if is_full_sha(&sha) {
        Ok(sha)
    } else {
        Err(ResolveFail::NonSha)
    }
}

/// Optional `git log` filters mirroring `read.ts:ReadLogOptions`'s
/// `author` / `since` / `path`. Empty strings are treated as absent so
/// the argv stays tight (matching the TS `length > 0` guards).
#[derive(Debug, Default)]
pub struct LogFilters<'a> {
    /// `--author=<pattern>` regex, passed through unmodified.
    pub author: Option<&'a str>,
    /// `--since=<approxidate>` (e.g. "2 weeks ago", ISO date).
    pub since: Option<&'a str>,
    /// Path filter applied after the `--` separator.
    pub path: Option<&'a str>,
}

/// Run `git log` against `repo_path` and parse the records. Fields are
/// NUL-separated and records RS-terminated ([`LOG_RECORD_FORMAT`] plus the
/// `%x1e` this argv appends): `sha`, `short_sha`, `subject`, `author_name`,
/// `author_email`, `author_date`, `parents` (space-separated parent SHAs).
/// Tab/newline-safe —
/// subjects can contain tabs, which a `\t`-delimited format could not carry.
///
/// `filters` add `--author` / `--since` before the rev and the path
/// pathspec after the `--` separator, mirroring `read.ts:read_log`'s argv
/// construction exactly (same flag forms, same `length > 0` skip, same
/// post-`--` path placement).
///
/// An argv-unsafe `ref_`, a non-SHA `cursor`, and a well-formed-but-absent ref
/// are all the **empty page**, never an error: they are the same "nothing to
/// show" answer to the client (`read.ts:read_log` returns `no_such_ref` for all
/// three and the handler renders `{commits: [], next_cursor: null}`).
/// Over-long values are still `-32602`, refused by the handler's length bounds
/// before this layer is reached — as is an `author` pattern git's regex
/// compiler refuses, which this layer classifies from git's own stderr.
pub async fn read_log(
    git_path: &str,
    repo_path: &std::path::Path,
    ref_: &str,
    cursor: Option<&str>,
    limit: usize,
    filters: &LogFilters<'_>,
) -> Result<Vec<CommitSummary>, JsonrpcError> {
    if !is_safe_ref_name(ref_) {
        return Ok(Vec::new());
    }
    // The cursor goes into an argv slot; anything but a plain SHA-1 is refused
    // as defense-in-depth in case a `-flag` slipped past the length bound.
    if let Some(c) = cursor
        && !is_full_sha(c)
    {
        return Ok(Vec::new());
    }
    let rev = cursor.map_or_else(|| ref_.to_owned(), |c| format!("{c}^"));
    let mut args: Vec<String> = vec![
        "log".into(),
        "-n".into(),
        limit.to_string(),
        format!("--format={LOG_RECORD_FORMAT}%x1e"),
    ];
    if let Some(author) = filters.author
        && !author.is_empty()
    {
        // A regex passed through unmodified: git compiles it, and an
        // uncompilable one becomes the `-32602` below via
        // [`is_invalid_pattern_stderr`] rather than a transient failure.
        args.push(format!("--author={author}"));
    }
    if let Some(since) = filters.since
        && !since.is_empty()
    {
        args.push(format!("--since={since}"));
    }
    args.push(rev);
    args.push("--".into());
    if let Some(path) = filters.path
        && !path.is_empty()
    {
        args.push(path.to_owned());
    }
    let stdout = match git_run(git_path, repo_path, args, MAX_LOG_BYTES).await {
        Ok(stdout) => stdout,
        // An uncompilable `--author` pattern is a client-input miss, so it is
        // `-32602` with a fixed message rather than the 503 every other stderr
        // produces. Same code, same words on the TS twin (`read_log`'s
        // `invalid_pattern` reason, mapped in
        // `src/lib/server/routes/fuz_forge_repo_read.ts`).
        //
        // This arm runs FIRST, and the order is load-bearing rather than
        // stylistic: git echoes the client's pattern into this stderr, so
        // `--author=bad revision [` produces a message the substring
        // [`is_no_such_ref_stderr`] below also matches — and would answer the
        // empty page where `-32602` is the truth. [`is_invalid_pattern_stderr`]
        // is anchored (a line must *start with* git's prefix), so it can only
        // fire on a real compile failure; asking it first therefore cannot
        // steal a genuine ref miss, while asking it second would let a client
        // forge one. Same order, same reason, in `read.ts:collect_git_log`.
        Err(GitFail::Nonzero { ref stderr, .. }) if is_invalid_pattern_stderr(stderr) => {
            return Err(invalid_params(INVALID_AUTHOR_PATTERN_MESSAGE, None));
        }
        // A "no such ref" exit is the empty-repo / unpushed-branch / GC'd-cursor
        // case — surfaced as an empty page, not an error.
        Err(GitFail::Nonzero { ref stderr, .. }) if is_no_such_ref_stderr(stderr) => {
            return Ok(Vec::new());
        }
        Err(fail) => {
            return Err(git_unavailable(
                "fuz_forge_repo_log",
                "failed to read repo history",
                &fail,
            ));
        }
    };
    Ok(parse_log_records(&String::from_utf8_lossy(&stdout)))
}

/// Read the default-branch tip from disk via `git rev-parse --verify`. `Ok(Some)`
/// is the tip SHA, `Ok(None)` is `no_such_ref` (empty repo / branch never
/// pushed / branch deleted), and `Err` is a transient subprocess failure
/// (mapped to 503 so a known-good `head_sha` isn't clobbered). Mirrors
/// `read.ts:read_default_branch_tip`.
///
/// `--verify` on an absent `refs/heads/<b>` prints `Needed a single revision`,
/// not the `bad revision` the log reader sees — see
/// [`is_no_such_ref_stderr`]'s per-argv table.
pub async fn read_default_branch_tip(
    git_path: &str,
    repo_path: &std::path::Path,
    default_branch: &str,
) -> Result<Option<String>, JsonrpcError> {
    if !is_safe_ref_name(default_branch) {
        return Ok(None);
    }
    let args: Vec<String> = vec![
        "rev-parse".into(),
        "--verify".into(),
        format!("refs/heads/{default_branch}"),
    ];
    match resolve_sha(git_path, repo_path, args).await {
        Ok(sha) => Ok(Some(sha)),
        Err(ResolveFail::NoSuchRef) => Ok(None),
        Err(ResolveFail::ReadFailed(fail)) => Err(git_unavailable(
            "read_default_branch_tip",
            "failed to read default-branch tip",
            &fail,
        )),
        Err(ResolveFail::NonSha) => Err(service_unavailable("failed to read default-branch tip")),
    }
}

/// Run `git show --no-patch` for commit metadata, then `git show -p`
/// for the diff body. Two subprocesses with independent byte caps so
/// metadata never gets poisoned by a too-large diff.
pub async fn read_commit(
    git_path: &str,
    repo_path: &std::path::Path,
    sha: &str,
) -> Result<(CommitDetail, CommitDiff), JsonrpcError> {
    // --- metadata ---
    let meta_args: Vec<String> = vec![
        "show".into(),
        "--no-patch".into(),
        format!("--format={COMMIT_DETAIL_FORMAT}"),
        sha.into(),
        "--".into(),
    ];
    let meta_stdout = match git_run(git_path, repo_path, meta_args, MAX_COMMIT_META_BYTES).await {
        Ok(stdout) => stdout,
        // `bad object <sha>` is git's miss for a well-formed-but-absent SHA;
        // map it to 404 like the TS twin (`read_commit` checks it alongside
        // `is_no_such_ref_stderr`) rather than letting it fall through to 503.
        Err(GitFail::Nonzero { ref stderr, .. })
            if is_no_such_ref_stderr(stderr) || stderr.contains("bad object") =>
        {
            return Err(not_found("commit", None));
        }
        Err(fail) => {
            return Err(git_unavailable(
                "fuz_forge_repo_commit: meta",
                "failed to read commit",
                &fail,
            ));
        }
    };
    let meta_stdout = String::from_utf8_lossy(&meta_stdout);
    // Unparseable metadata is a *client* miss, not a server bug: `git show
    // --no-patch --format=… <sha> --` exits 0 with non-commit output whenever
    // `sha` names a blob or a tree — and `fuz_forge_repo_blob` hands clients
    // blob SHAs to paste back here. 404 like the TS twin, whose `read_commit`
    // answers `no_such_ref` for the same input and lets the handler render
    // `not_found('commit')`.
    let commit_obj = parse_commit_detail(&meta_stdout).ok_or_else(|| not_found("commit", None))?;
    // An annotated **tag** sha is the case the parse alone doesn't catch: git
    // exits 0 and prints its tag preamble (`tag <name>` / `Tagger: …` / the tag
    // message) followed by the *peeled* commit's full 11-field record, so the
    // parse succeeds with `%H` carrying the preamble ahead of the commit sha.
    // `fuz_forge_repo_refs` hands clients exactly that sha for every
    // `refs/tags/*` annotated tag, so it is trivially reachable. Requiring `%H`
    // to echo the requested sha rejects it — and covers blob/tree by
    // construction. Same guard, same 404, in `read.ts:read_commit`. It is *not*
    // what rejects a case-variant sha: `is_full_sha` is lowercase-only on both
    // backends, so an uppercase sha never reaches git in the first place (the
    // guard sits in `repo_read.rs`'s `fuz_forge_repo_commit` handler here).
    if commit_obj.sha != sha {
        return Err(not_found("commit", None));
    }

    // --- diff body ---
    let diff_args: Vec<String> = vec![
        "show".into(),
        "-p".into(),
        "--format=".into(),
        // Match the TS twin's diff flags: `--no-color` blocks ANSI escapes if
        // the host sets `color.ui=always`; `--full-index` emits stable full
        // blob hashes. Without them the commit diff text diverges from TS.
        "--no-color".into(),
        "--full-index".into(),
        sha.into(),
        "--".into(),
    ];
    let diff = match git_run(git_path, repo_path, diff_args, MAX_DIFF_BYTES).await {
        Ok(stdout) => CommitDiff {
            text: String::from_utf8_lossy(&stdout).into_owned(),
            truncated: false,
        },
        // Only the byte-cap overflow degrades to `truncated: true` — the
        // metadata is still useful. Every other failure, a non-zero
        // `git show -p` included (e.g. a corrupt object surfacing only in the
        // diff pass), is the TS twin's `subprocess_failed` -> 503.
        Err(GitFail::TooLarge) => CommitDiff {
            text: String::new(),
            truncated: true,
        },
        Err(fail) => {
            return Err(git_unavailable(
                "fuz_forge_repo_commit: diff",
                "failed to read commit",
                &fail,
            ));
        }
    };
    Ok((commit_obj, diff))
}

/// `git for-each-ref` over `refs/heads` + `refs/tags`, NUL-delimited fields.
pub async fn read_refs(
    git_path: &str,
    repo_path: &std::path::Path,
) -> Result<Vec<RefEntry>, JsonrpcError> {
    let args: Vec<String> = vec![
        "for-each-ref".into(),
        format!("--format={REF_RECORD_FORMAT}"),
        "refs/heads".into(),
        "refs/tags".into(),
    ];
    let stdout = git_run(git_path, repo_path, args, MAX_REFS_BYTES)
        .await
        .map_err(|fail| git_unavailable("fuz_forge_repo_refs", "failed to read refs", &fail))?;
    let stdout = String::from_utf8_lossy(&stdout);
    Ok(parse_ref_records(&stdout))
}

/// Resolve `ref` to a SHA, then `git ls-tree -l <sha>:<path>`.
///
/// The argv guards live here rather than in the handler (mirroring
/// `read.ts:read_tree`): the fn that builds the argv owns the validation, so
/// every caller gets the same `not_found` shape.
pub async fn read_tree(
    git_path: &str,
    repo_path: &std::path::Path,
    ref_: &str,
    path: &str,
) -> Result<(Vec<TreeEntry>, String), JsonrpcError> {
    if !is_safe_ref_name(ref_) {
        return Err(not_found("ref", None));
    }
    if !is_safe_path(path) {
        return Err(not_found("path", None));
    }
    // `rev-parse <ref>` with no `--verify` and no `--`, so an absent ref comes
    // back as `ambiguous argument … unknown revision` (not the `bad revision`
    // the log reader sees, nor the `Needed a single revision` the
    // default-branch tip sees) — see [`is_no_such_ref_stderr`].
    let resolved_sha = match resolve_sha(
        git_path,
        repo_path,
        vec!["rev-parse".into(), ref_.to_owned()],
    )
    .await
    {
        Ok(sha) => sha,
        Err(ResolveFail::NoSuchRef) => return Err(not_found("ref", None)),
        Err(ResolveFail::ReadFailed(fail)) => {
            // One message for every non-ok read in this fn, matching the TS
            // twin: `read.ts:read_tree`'s resolve failure falls through to the
            // handler's single `'failed to read tree'` 503, which never names
            // the rev-parse sub-step.
            return Err(git_unavailable(
                "fuz_forge_repo_tree: rev-parse",
                "failed to read tree",
                &fail,
            ));
        }
        Err(ResolveFail::NonSha) => return Err(service_unavailable("failed to read tree")),
    };
    let args: Vec<String> = vec![
        "ls-tree".into(),
        "-l".into(),
        format!("{resolved_sha}:{path}"),
    ];
    let stdout = match git_run(git_path, repo_path, args, MAX_TREE_BYTES).await {
        Ok(stdout) => stdout,
        Err(GitFail::Nonzero { ref stderr, .. }) if is_no_such_path_stderr(stderr) => {
            return Err(not_found("path", None));
        }
        Err(fail) => {
            return Err(git_unavailable(
                "fuz_forge_repo_tree",
                "failed to read tree",
                &fail,
            ));
        }
    };
    let stdout = String::from_utf8_lossy(&stdout);
    Ok((parse_tree_records(&stdout), resolved_sha))
}

/// Build the `{sha, size, body}` blob response from the typed [`BlobBody`].
/// The blob union itself is single-sourced in [`fuz_forge_wire::output`].
fn blob_response(sha: &str, size: u64, body: BlobBody) -> RepoBlobOutput {
    RepoBlobOutput {
        sha: sha.to_owned(),
        size,
        body,
    }
}

/// Text/binary heuristic: a NUL in the first [`BLOB_BINARY_SNIFF_BYTES`]
/// classifies the blob as binary (mirrors `read.ts:looks_binary`).
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(BLOB_BINARY_SNIFF_BYTES).any(|&b| b == 0)
}

/// Resolve `<ref>:<path>` to a blob SHA, read its size, then its body (capped).
///
/// Argv guards live here, not in the handler — the twin of
/// `read.ts:read_blob`, which rejects an unsafe ref, an unsafe path, and the
/// empty path (the root tree is never a blob) before spawning.
pub async fn read_blob(
    git_path: &str,
    repo_path: &std::path::Path,
    ref_: &str,
    path: &str,
) -> Result<RepoBlobOutput, JsonrpcError> {
    if !is_safe_ref_name(ref_) {
        return Err(not_found("ref", None));
    }
    // The empty path is the root tree, valid for `tree` and never a blob. The
    // RPC handler's length bound refuses it earlier; the guard stays here so
    // the fn's contract matches its TS twin for every caller.
    if !is_safe_path(path) || path.is_empty() {
        return Err(not_found("path", None));
    }
    // --- resolve to object SHA ---
    // `<ref>:<path>` names the object directly via `git rev-parse`; do NOT
    // append a `^{blob}` peel suffix — git 2.47.x parses the trailing
    // `^{blob}` as part of the *path* (`<path>^{blob}`), turning a valid
    // blob into a 404 path-not-found. The object's type is asserted
    // separately below via `cat-file -t` so a tree (directory) path still
    // maps to `not_a_blob`.
    let resolve_spec = format!("{ref_}:{path}");
    let resolve_args: Vec<String> = vec!["rev-parse".into(), "--verify".into(), resolve_spec];
    // One source for the read-failure response reused at every step below.
    let blob_unavailable = || service_unavailable("failed to read blob");
    let resolved = match git_run(git_path, repo_path, resolve_args, 4096).await {
        Ok(stdout) => stdout,
        // Only a non-zero exit disambiguates missing ref vs missing path (by
        // re-resolving the ref alone); a spawn failure or cap overflow is a
        // transient read failure, matching `read.ts:read_blob`.
        Err(GitFail::Nonzero { .. }) => {
            return Err(blob_resolve_error(git_path, repo_path, ref_).await);
        }
        Err(fail) => {
            return Err(git_unavailable(
                "fuz_forge_repo_blob: resolve",
                "failed to read blob",
                &fail,
            ));
        }
    };
    let sha = String::from_utf8_lossy(&resolved).trim().to_owned();
    if !is_full_sha(&sha) {
        return Err(blob_unavailable());
    }

    // --- assert the object is a blob ---
    // `<ref>:<dir>` resolves to a tree SHA; without this guard a directory
    // path would fail confusingly at the body fetch instead of as a 404 blob.
    let type_args: Vec<String> = vec!["cat-file".into(), "-t".into(), sha.clone()];
    let type_stdout = git_run(git_path, repo_path, type_args, 64)
        .await
        .map_err(|fail| {
            git_unavailable("fuz_forge_repo_blob: type", "failed to read blob", &fail)
        })?;
    let object_type = String::from_utf8_lossy(&type_stdout).trim().to_owned();
    if object_type != "blob" {
        return Err(not_found("blob", None));
    }

    // --- size ---
    let size_args: Vec<String> = vec!["cat-file".into(), "-s".into(), sha.clone()];
    let size_stdout = git_run(git_path, repo_path, size_args, 64)
        .await
        .map_err(|fail| {
            git_unavailable("fuz_forge_repo_blob: size", "failed to read blob", &fail)
        })?;
    let size: u64 = String::from_utf8_lossy(&size_stdout)
        .trim()
        .parse()
        .map_err(|_| blob_unavailable())?;

    // --- body (only when under the cap) ---
    if size > MAX_BLOB_BYTES as u64 {
        return Ok(blob_response(&sha, size, BlobBody::Truncated { size }));
    }
    let body_args: Vec<String> = vec!["cat-file".into(), "blob".into(), sha.clone()];
    let bytes = match git_run(git_path, repo_path, body_args, MAX_BLOB_BYTES).await {
        Ok(stdout) => stdout,
        Err(GitFail::TooLarge) => {
            return Ok(blob_response(&sha, size, BlobBody::Truncated { size }));
        }
        Err(fail) => {
            return Err(git_unavailable(
                "fuz_forge_repo_blob: body",
                "failed to read blob",
                &fail,
            ));
        }
    };
    let body = if looks_binary(&bytes) {
        BlobBody::Binary
    } else {
        BlobBody::Text {
            text: String::from_utf8_lossy(&bytes).to_string(),
        }
    };
    Ok(blob_response(&sha, size, body))
}

/// On a failed blob resolve, decide whether the
/// `ref` or the `path` was the miss by re-resolving the bare ref.
async fn blob_resolve_error(
    git_path: &str,
    repo_path: &std::path::Path,
    ref_: &str,
) -> JsonrpcError {
    let args: Vec<String> = vec![
        "rev-parse".into(),
        "--verify".into(),
        format!("{ref_}^{{commit}}"),
    ];
    // The probe's own failure falls back to the conservative `ref` bucket —
    // the caller maps both to 404 anyway (mirrors `read.ts:read_blob`).
    match git_run(git_path, repo_path, args, 4096).await {
        Ok(_) => not_found("path", None),
        Err(_) => not_found("ref", None),
    }
}

#[cfg(test)]
mod tests;
