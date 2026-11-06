//! Pure parsers + validators for the git read layer.
//!
//! Port of `src/lib/server/git/parse.ts`: the `--format=` byte contracts,
//! ref/path/SHA validators and the record parsers for `git log` / `git show` /
//! `for-each-ref` / `ls-tree` output, plus the stderr classifiers that map
//! git's no-such-ref / no-such-path messages to 404s. No subprocess or I/O —
//! every function here is a total transform over strings.

use fuz_forge_wire::output::{CommitDetail, CommitSummary, RefEntry, TreeEntry};

use crate::text::utf16_len;

/// git-log format string. `%x1e` (RS) terminates each record — appended at the
/// argv site in `read.rs:read_log`, not carried here — and `%x00` (NUL)
/// separates fields within a record. Both bytes are forbidden in the
/// placeholders the forge uses, so a parser keyed off them is unambiguous.
///
/// Field order: `H h s an ae aI P` →
/// (full_sha, short_sha, subject, author_name, author_email, author_date_iso, parents).
///
/// Byte-identical to `parse.ts:LOG_RECORD_FORMAT` (the TS twin).
pub const LOG_RECORD_FORMAT: &str = "%H%x00%h%x00%s%x00%an%x00%ae%x00%aI%x00%P";

/// git-show format string for the single-commit metadata fetch. Extends
/// [`LOG_RECORD_FORMAT`] with committer fields and the raw body (`%B` =
/// subject + blank line + body, so the body field carries the full commit
/// message verbatim).
///
/// Field order: `H h s an ae aI cn ce cI P B` → 11 fields.
///
/// No trailing `%x1e` — a single-commit fetch yields exactly one record, and
/// [`parse_commit_detail`] is happy with or without the terminator.
///
/// Byte-identical to `parse.ts:COMMIT_DETAIL_FORMAT` (the TS twin).
pub const COMMIT_DETAIL_FORMAT: &str =
    "%H%x00%h%x00%s%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%P%x00%B";

/// Validate a ref name against `git check-ref-format`, byte-for-byte identical
/// to `parse.ts:is_safe_ref_name` (the TS twin). Defense-in-depth — args go to
/// `git` as a vector, not a shell, but a malformed name could still be read as
/// a `-`flag/pathspec. A plain character allowlist (`[A-Za-z0-9_/.-]`) would
/// be stricter than git itself and reject git-valid exotic names (e.g.
/// `feat@2`), diverging from TS.
#[allow(
    clippy::case_sensitive_file_extension_comparisons,
    reason = "`.lock` is a git ref suffix, not a file extension — git check-ref-format is case-sensitive"
)]
pub fn is_safe_ref_name(name: &str) -> bool {
    // The 255 cap is a defensive bound (git has none); the structural rules
    // below are the real validation. `chars().count()` vs the TS twin's UTF-16
    // `.length` differs only for >255 astral-plane chars — a non-case for
    // branch names, which are ASCII in practice.
    if name.is_empty() || name.chars().count() > 255 {
        return false;
    }
    // Leading `-` is the stricter-than-git arg-injection guard.
    if name.starts_with('-') || name.starts_with('.') || name.starts_with('/') {
        return false;
    }
    if name.ends_with('.') || name.ends_with('/') || name.ends_with(".lock") {
        return false;
    }
    if name.contains("..") || name.contains("//") || name.contains("@{") || name == "@" {
        return false;
    }
    // Per-component: no slash-separated component may begin with `.` or end
    // with `.lock` (the whole-ref checks above only cover the first/last).
    for segment in name.split('/') {
        if segment.starts_with('.') || segment.ends_with(".lock") {
            return false;
        }
    }
    name.chars().all(|c| {
        let code = c as u32;
        code > 0x20 && code != 0x7f && !matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
    })
}

/// A full 40-char **lowercase**-hex SHA-1 object id, byte-for-byte identical to
/// `parse.ts:is_full_sha`'s `/^[0-9a-f]{40}$/` (the TS twin).
///
/// Gates every callsite that puts a client-supplied object id into an argv slot
/// (`read.rs:read_log`'s cursor, `repo_read.rs`'s commit sha) and the
/// `rev-parse` outputs the readers parse back. Lowercase-only is load-bearing,
/// not incidental: git resolves an uppercase sha happily, so admitting `A-F`
/// here would make a `fuz_forge_repo_log` cursor page on this backend while the
/// TS twin answers the empty page. git's own output is always lowercase, so the
/// `rev-parse` callsites are unaffected.
pub fn is_full_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Validate a tree/blob path mirroring `parse.ts:is_safe_path`. The empty
/// string is the repo root (valid for `tree`); `blob` rejects it separately.
///
/// The 4096 cap counts **UTF-16 code units**, not bytes: `parse.ts` measures
/// `path.length`, and the handler bound (`require_len("path", …, 0, 4096)`)
/// already measures the same way. Bytes would refuse a CJK or astral path this
/// backend's own input bound just accepted, and that the TS twin serves.
pub fn is_safe_path(path: &str) -> bool {
    if path.is_empty() {
        return true;
    }
    if utf16_len(path) > 4096 {
        return false;
    }
    if path.starts_with('-') || path.starts_with('/') || path.ends_with('/') {
        return false;
    }
    if path
        .bytes()
        .any(|b| b == 0 || b == 0x7f || (b < 0x20 && b != b'\t'))
    {
        return false;
    }
    // Per-segment, mirroring `parse.ts:is_safe_path`: reject empty segments
    // (`//`) and whole-segment `.`/`..`. A substring check would wrongly
    // reject a legitimate filename like `a..b` and wrongly accept `a/./b`.
    path.split('/')
        .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

/// Parse one RS-delimited `git log` record (NUL-separated fields). A leading
/// newline (git emits one after each record's terminator) is trimmed first.
///
/// Exactly 7 fields, mirroring `parse.ts:parse_record`'s `fields.length !== 7`
/// guard: an 8th NUL-separated field means the record is not what
/// [`LOG_RECORD_FORMAT`] describes (a NUL inside `%s`/`%an` is the only way to
/// get one), so it is dropped on both backends rather than folded into
/// `parents` on one and dropped on the other.
pub fn parse_log_record(record: &str) -> Option<CommitSummary> {
    let mut parts = record.trim_start_matches(['\n', '\r']).split('\u{0}');
    let sha = parts.next()?;
    let short_sha = parts.next()?;
    let subject = parts.next()?;
    let author_name = parts.next()?;
    let author_email = parts.next()?;
    let author_date = parts.next()?;
    let parents = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    Some(CommitSummary {
        sha: sha.to_owned(),
        short_sha: short_sha.to_owned(),
        subject: subject.to_owned(),
        author_name: author_name.to_owned(),
        author_email: author_email.to_owned(),
        author_date: author_date.to_owned(),
        parents: parents_field(parents),
    })
}

/// Split a `git log --format=<LOG_RECORD_FORMAT>%x1e` stream into its records,
/// dropping the ones that don't parse.
///
/// Twin of `parse.ts:parse_log_records`. The framing is RS-delimited with
/// blank records skipped: `--format=` is a *tformat*, so git writes
/// `<record> RS LF` for **every** record including the last, which means each
/// record past the first arrives with the previous record's LF attached —
/// trimmed per-record by [`parse_log_record`], while the stream's own trailing
/// `RS LF` is what the blank-record filter drops.
pub fn parse_log_records(stdout: &str) -> Vec<CommitSummary> {
    stdout
        .split('\u{1e}')
        .filter(|record| !record.trim().is_empty())
        .filter_map(parse_log_record)
        .collect()
}

/// `%P` is a space-separated list of parent SHAs (empty for a root commit).
fn parents_field(raw: &str) -> Vec<String> {
    raw.split_whitespace().map(str::to_owned).collect()
}

/// Parse `git show --no-patch --format=<COMMIT_DETAIL_FORMAT>` — 11 NUL-separated
/// fields, the last (`%B`) the raw body. Mirrors `parse.ts:parse_commit_detail`.
///
/// All 11 fields are required: `splitn(11)` keeps NULs a committer wrote into
/// the body intact, and the 11th part is mandatory so a truncated 10-field
/// record is `None` here exactly as it is `null` on the TS twin.
pub fn parse_commit_detail(output: &str) -> Option<CommitDetail> {
    let mut parts = output.splitn(11, '\u{0}');
    let sha = parts.next()?;
    let short_sha = parts.next()?;
    let subject = parts.next()?;
    let author_name = parts.next()?;
    let author_email = parts.next()?;
    let author_date = parts.next()?;
    let committer_name = parts.next()?;
    let committer_email = parts.next()?;
    let committer_date = parts.next()?;
    let parents = parts.next()?;
    // `%B` is the last field; trim the single trailing newline `git show`
    // appends after the format so the body reads as the raw message.
    let raw_body = parts.next()?;
    let body = raw_body.strip_suffix('\n').unwrap_or(raw_body);
    Some(CommitDetail {
        sha: sha.to_owned(),
        short_sha: short_sha.to_owned(),
        subject: subject.to_owned(),
        author_name: author_name.to_owned(),
        author_email: author_email.to_owned(),
        author_date: author_date.to_owned(),
        committer_name: committer_name.to_owned(),
        committer_email: committer_email.to_owned(),
        committer_date: committer_date.to_owned(),
        parents: parents_field(parents),
        body: body.to_owned(),
    })
}

/// `git for-each-ref` format. NUL-separated fields, one record per line. Field
/// order: `refname objecttype objectname *objectname committerdate:iso-strict`.
///
/// `*objectname` resolves to the target sha of an annotated tag (empty for
/// lightweight tags and for branches) — keeping it in the format lets the
/// client distinguish "tag points at commit X" from "tag is an annotated tag
/// whose target is commit X".
///
/// `committerdate` is empty for tags (where the date is in the tag object, not
/// a commit) — left empty rather than fabricated so the UI can decide whether
/// to fall back to taggerdate.
///
/// Byte-identical to `parse.ts:REF_RECORD_FORMAT` (the TS twin).
pub const REF_RECORD_FORMAT: &str =
    "%(refname)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(committerdate:iso-strict)";

/// Parse one `git for-each-ref --format=<REF_RECORD_FORMAT>` line. Exactly 5
/// NUL-separated fields, mirroring `parse.ts:parse_ref_record`'s
/// `fields.length !== 5` guard — a 6th field means the line is not what the
/// format describes, so both backends drop it.
pub fn parse_ref_record(line: &str) -> Option<RefEntry> {
    let mut parts = line.split('\u{0}');
    let name = parts.next()?;
    let object_type = parts.next()?;
    let sha = parts.next()?;
    let target_sha = parts.next()?;
    let committer_date = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    Some(RefEntry {
        name: name.to_owned(),
        object_type: object_type.to_owned(),
        sha: sha.to_owned(),
        target_sha: target_sha.to_owned(),
        committer_date: committer_date.to_owned(),
    })
}

/// Split a `git for-each-ref --format=<REF_RECORD_FORMAT>` stream into its
/// records, dropping the ones that don't parse.
///
/// The split rule is LF-only, with empty records skipped — the twin of
/// `parse.ts:parse_ref_records`. `str::lines` would additionally strip a
/// trailing CR from each record; for refs the two rules are indistinguishable
/// (`git check-ref-format` forbids control characters in a ref name, and none
/// of the other four fields can carry one either), but both readers here use
/// the one rule so there is a single record-framing story to reason about.
pub fn parse_ref_records(stdout: &str) -> Vec<RefEntry> {
    stdout
        .split('\n')
        .filter(|record| !record.is_empty())
        .filter_map(parse_ref_record)
        .collect()
}

/// Split a `git ls-tree -l` stream into its records, dropping the ones that
/// don't parse.
///
/// LF-only, empty records skipped — the twin of `parse.ts:parse_tree_records`.
/// Unlike the ref stream this rule is observable: a tracked path may end in a
/// CR, and `str::lines` would strip it, serving `foo` where the TS backend
/// serves `foo\r`. (git's default `core.quotePath` escapes such a name before
/// it reaches here, so the divergence needs a repo that turned quoting off —
/// which is exactly the kind of edge the two backends should not answer
/// differently.)
pub fn parse_tree_records(stdout: &str) -> Vec<TreeEntry> {
    stdout
        .split('\n')
        .filter(|record| !record.is_empty())
        .filter_map(parse_tree_record)
        .collect()
}

/// Parse one `git ls-tree -l` line (`<mode> SP <type> SP <sha> SP* <size> HT
/// <name>`). The header must split into exactly 4 whitespace-separated fields,
/// mirroring `parse.ts:parse_tree_records`' `parts.length !== 4` guard — a 5th
/// means the line is not `ls-tree -l` output, so both backends skip it.
pub fn parse_tree_record(line: &str) -> Option<TreeEntry> {
    let (header, name) = line.split_once('\t')?;
    let mut header_parts = header.split_whitespace();
    let mode = header_parts.next()?;
    let entry_type = header_parts.next()?;
    let sha = header_parts.next()?;
    let size = header_parts.next()?;
    if header_parts.next().is_some() {
        return None;
    }
    Some(TreeEntry {
        mode: mode.to_owned(),
        entry_type: entry_type.to_owned(),
        sha: sha.to_owned(),
        size: size.to_owned(),
        name: name.to_owned(),
    })
}

/// git's "no such ref" stderr vocabulary. Converged branch-for-branch with
/// `read.ts:is_no_such_ref_stderr`.
///
/// Which message git emits for the same absent ref is decided by the argv
/// shape, so all three of the forge's rev-bearing shapes need a branch here
/// (wordings from git 2.47):
///
/// - `git log … <rev> --` (`read.rs:read_log`) → `bad revision '<rev>'`.
///   Every read that passes the `--` separator lands here: the separator
///   settles the rev-vs-pathspec question up front, so git never reaches the
///   `ambiguous argument` wording.
/// - `git rev-parse <ref>` (`read.rs:resolve_sha` for `read.rs:read_tree` —
///   no `--verify`, no `--`) → `ambiguous argument '<ref>': unknown revision or
///   path not in the working tree.` This is why the `ambiguous argument` /
///   `unknown revision` branches stay load-bearing.
/// - `git rev-parse --verify refs/heads/<b>` (`read.rs:resolve_sha` for
///   `read.rs:read_default_branch_tip`) → `Needed a single revision`.
///   `--verify` reports the arity failure without ever naming the rev, and it
///   is the wording for an empty repo, for a repo whose configured default
///   branch was never pushed, and for a deleted branch alike.
///
/// `does not have any commits yet` is git's unborn-HEAD wording for a bare
/// `git log` with *no* rev argument; the forge always passes a rev, so that
/// branch is defensive rather than reachable from a current argv.
///
/// Over-matching is bounded: `Needed a single revision` is also what
/// `git rev-parse --verify <ref>:<path>` prints, but that call
/// (`read.rs:read_blob`'s resolve and its `read.rs:blob_resolve_error`
/// probe) keys on the exit code alone and never consults this predicate.
///
/// Without these branches an absent branch, an empty repo, and a
/// force-push-GC'd cursor all answer 503 instead of the empty page / `null`
/// tip the readers document.
pub fn is_no_such_ref_stderr(stderr: &str) -> bool {
    stderr.contains("unknown revision")
        || stderr.contains("ambiguous argument")
        || stderr.contains("bad revision")
        || stderr.contains("Needed a single revision")
        || stderr.contains("does not have any commits yet")
}

/// git's "that path isn't in this tree-ish" stderr vocabulary. Converged
/// branch-for-branch with `read.ts:is_no_such_path_stderr` — the two
/// classifiers must agree or the same repo answers 404 on one backend and 503
/// on the other.
///
/// Three message families, all kept on both sides:
///
/// - `Not a valid object name <rev>:<path>` — git's plain `get_oid` miss, what
///   `git ls-tree <sha>:<path>` emits (the only caller today, via
///   `read.rs:read_tree`), on a bare repo and a worktree alike.
///   git prints the same wording when the **rev** half is the miss
///   (`git ls-tree <absent-sha>:README.md`), so a caller that passed an
///   unresolved rev would answer 404 `path` where 404 `ref` is the truth.
///   Latent, not reachable: `read.rs:read_tree` resolves the rev with its
///   own `git rev-parse` first and only ever interpolates a sha git just
///   returned. The day a reader passes an unresolved rev, a `<rev>:` shape
///   check belongs here — and in the TS twin the same day, or the same repo
///   answers differently on each backend.
/// - `not a tree object` — three producers share this one wording, all from the
///   same `git ls-tree <sha>:<path>`: the path resolves but names a **blob** (a
///   client asking for a tree listing at a file path), it names a **gitlink**
///   (a submodule entry, whose commit object isn't in this repo), or the tree
///   object is **missing/corrupt** in the object store. The first two are
///   genuine 404 `path`; the third is repo corruption folded into the same 404
///   — a deliberate trade, since a client can't tell the difference and a 503
///   would misreport the two common cases as transient.
///   TODO: disambiguate with a `cat-file -t <sha>:<path>` probe if operators
///   ever need corruption to surface as a 503 instead of a 404.
/// - `path '<p>' does not exist in '<rev>'` and `path '<p>' exists on disk, but
///   not in '<rev>'` — git's `diagnose_invalid_oid_path` forms, emitted by the
///   `git show` / `git cat-file` `<rev>:<path>` family. Reachable on a bare
///   repo: `git -C <bare> show <sha>:config` prints the "exists on disk" form,
///   because the bare dir's own `config` file exists next to git's cwd. Kept so
///   a future `<rev>:<path>` reader classifies instead of falling through to a
///   503.
pub fn is_no_such_path_stderr(stderr: &str) -> bool {
    (stderr.contains("path '") && stderr.contains("does not exist"))
        || stderr.contains("Not a valid object name")
        || stderr.contains("not a tree object")
        || stderr.contains("exists on disk, but not in")
}

/// The one stderr prefix git renders for a header-pattern compile failure:
/// `compile_regexp` writes `<where>'<pattern>': <errbuf>`, with `header, ` the
/// `where` for the `--author` / `--committer` / `--grep` family — of which
/// `--author` is the only member either backend puts on an argv. Twin of
/// `parse.ts:FATAL_HEADER_PREFIX`.
const FATAL_HEADER_PREFIX: &str = "fatal: header, '";

/// git's "that header pattern isn't a regular expression" stderr vocabulary.
/// Converged branch-for-branch with `parse.ts:is_invalid_pattern_stderr`.
///
/// `read.rs:read_log` passes `--author=<pattern>` through unmodified, so a
/// client can hand git a pattern its regex compiler refuses (`[`, `[a-`, a
/// trailing `\`). git exits 128 with `fatal: header, '<pattern>': <compiler
/// message>` — a client-input miss, not a transient read failure, so both
/// backends answer `-32602` rather than the 503 an unclassified stderr would
/// produce.
///
/// Two shape decisions, both load-bearing and both mirrored on the TS side:
///
/// - **Anchored, not a substring search.** git echoes the *client's pattern*
///   into this message, so a substring test would let a client write any other
///   classifier's vocabulary into the stderr the classifiers read:
///   `--author=bad revision [` produces `fatal: header, 'bad revision [':
///   Invalid regular expression`, which a substring [`is_no_such_ref_stderr`]
///   also matches. Requiring a line to *start with* the prefix puts the echoed
///   pattern permanently past the anchor, where it cannot forge one.
/// - **Per line, not per message.** git may print a `warning:` line ahead of
///   the `fatal:` one (an ambiguous refname does), so the prefix is not always
///   at byte 0 of the stderr.
///
/// The compiler message *after* the prefix is never consulted: that text comes
/// from the platform's `regcomp`, so the same pattern reads `Invalid regular
/// expression` on the glibc target and something else on the musl one.
///
/// The anchor bounds what a client can forge but does not by itself make the
/// three classifiers disjoint — a pattern echoing `bad revision` still matches
/// [`is_no_such_ref_stderr`]. **Order** settles that: `read.rs:read_log`
/// consults this predicate first, and a stderr carrying this prefix is by
/// construction a compile failure, so the pattern answer is the true one.
pub fn is_invalid_pattern_stderr(stderr: &str) -> bool {
    stderr
        .split('\n')
        .any(|line| line.starts_with(FATAL_HEADER_PREFIX))
}

#[cfg(test)]
mod tests;
