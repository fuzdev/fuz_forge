//! Every accepted / rejected / expected table here is asserted against a
//! shared parity fixture under `src/test/fixtures/parity/`. The TS twin is
//! the `src/test/server/git/parse.{validators,stderr,records,streams}.test.ts`
//! family, which reads the same bytes, so a one-sided edit to either
//! implementation fails on one side against a table neither side owns.

use serde_json::{Map, Value};

use super::*;
use crate::parity::{field, flag, parity_rows};

const REF_NAME_FIXTURE: &str =
    include_str!("../../../../../src/test/fixtures/parity/git_ref_name.json");
const SAFE_PATH_FIXTURE: &str =
    include_str!("../../../../../src/test/fixtures/parity/git_safe_path.json");
const FULL_SHA_FIXTURE: &str =
    include_str!("../../../../../src/test/fixtures/parity/git_full_sha.json");
const FIELD_COUNT_FIXTURE: &str =
    include_str!("../../../../../src/test/fixtures/parity/git_record_field_counts.json");
const STREAM_FIXTURE: &str =
    include_str!("../../../../../src/test/fixtures/parity/git_real_streams.json");
const STDERR_FIXTURE: &str =
    include_str!("../../../../../src/test/fixtures/parity/git_stderr_classification.json");

/// A row's repeat count for a generated case.
fn repeat(row: &Map<String, Value>) -> usize {
    usize::try_from(row["repeat"].as_u64().expect("parity row carries a repeat"))
        .expect("repeat fits usize")
}

#[test]
fn safe_ref_name_matches_check_ref_format() {
    for row in parity_rows(REF_NAME_FIXTURE, "refs") {
        let input = field(&row, "input");
        assert_eq!(is_safe_ref_name(input), flag(&row, "accepted"), "{input:?}");
    }
    // The 255-codepoint cap, generated rather than listed.
    for row in parity_rows(REF_NAME_FIXTURE, "generated") {
        let input = field(&row, "unit").repeat(repeat(&row));
        assert_eq!(
            is_safe_ref_name(&input),
            flag(&row, "accepted"),
            "{input:?}"
        );
    }
}

/// Accepts the root, normal paths, and a `..` *substring* within a segment;
/// rejects whole-segment `.`/`..`, empty segments, and the leading `-`/`/`
/// argv guards.
#[test]
fn safe_path_matches_ts_per_segment() {
    for row in parity_rows(SAFE_PATH_FIXTURE, "paths") {
        let input = field(&row, "input");
        assert_eq!(is_safe_path(input), flag(&row, "accepted"), "{input:?}");
    }
}

/// The 4096 cap counts UTF-16 code units on both backends; each generated
/// case is a byte-vs-unit boundary a byte measure would answer differently.
#[test]
fn safe_path_bounds_utf16_code_units_like_ts() {
    for row in parity_rows(SAFE_PATH_FIXTURE, "generated") {
        let unit = field(&row, "unit");
        let input = unit.repeat(repeat(&row));
        assert_eq!(
            is_safe_path(&input),
            flag(&row, "accepted"),
            "{unit:?} x {}",
            repeat(&row)
        );
    }
}

/// Extra NUL-separated fields are a dropped record on both backends, not a
/// record whose last field silently absorbs them. Each side frames the bare
/// record its own reader takes: these parsers are per-record, so the fixture's
/// rows arrive unframed here.
#[test]
fn record_parsers_require_exact_field_counts() {
    for row in parity_rows(FIELD_COUNT_FIXTURE, "log") {
        let input = field(&row, "input");
        let parses = flag(&row, "parses");
        assert_eq!(parse_log_record(input).is_some(), parses, "{input:?}");
    }
    for row in parity_rows(FIELD_COUNT_FIXTURE, "refs") {
        let input = field(&row, "input");
        let parses = flag(&row, "parses");
        assert_eq!(parse_ref_record(input).is_some(), parses, "{input:?}");
    }
    for row in parity_rows(FIELD_COUNT_FIXTURE, "tree") {
        let input = field(&row, "input");
        let parses = flag(&row, "parses");
        assert_eq!(parse_tree_record(input).is_some(), parses, "{input:?}");
    }
    for row in parity_rows(FIELD_COUNT_FIXTURE, "commit_detail") {
        let input = field(&row, "input");
        assert_eq!(
            parse_commit_detail(input).is_some(),
            flag(&row, "parses"),
            "{input:?}"
        );
    }
}

/// Record framing is LF-only on both backends: a CR belongs to the record,
/// not the separator. [`str::lines`] would strip the trailing CR and serve
/// `foo` where the TS backend serves `foo\r`, which is why these readers frame
/// on `\n` themselves.
///
/// The ref case is unobservable in practice — git forbids control characters
/// in a ref name and the other fields can't carry one — but the two readers
/// use one framing rule, so the fixture is the same shape.
#[test]
fn record_framing_keeps_a_trailing_cr() {
    for row in parity_rows(STREAM_FIXTURE, "tree_framing_cr") {
        let entries = parse_tree_records(field(&row, "stream"));
        assert_eq!(serde_json::to_value(&entries).unwrap(), row["expected"]);
    }
    for row in parity_rows(STREAM_FIXTURE, "ref_framing_cr") {
        let records = parse_ref_records(field(&row, "stream"));
        assert_eq!(serde_json::to_value(&records).unwrap(), row["expected"]);
    }
}

/// The uppercase pair is the load-bearing one: git would resolve either, so a
/// backend that admitted them would page a `fuz_forge_repo_log` cursor the
/// other backend answers with the empty page.
#[test]
fn full_sha_check() {
    for row in parity_rows(FULL_SHA_FIXTURE, "shas") {
        let input = field(&row, "input");
        assert_eq!(is_full_sha(input), flag(&row, "accepted"), "{input:?}");
    }
}

/// Real git streams, captured verbatim from a scratch repo — see each table's
/// `note` in `src/test/fixtures/parity/git_real_streams.json` for the command
/// and the history that produced it.
///
/// The log stream's framing lives only here on the Rust side (the per-record
/// parser is unit-covered separately): split on RS, drop blank records, parse
/// each. The same fixture runs through the TS twin's `parse_log_records`, so a
/// framing change on one backend shows up as a different record set on one
/// side only.
#[test]
fn parse_log_records_frames_a_real_git_stream() {
    for row in parity_rows(STREAM_FIXTURE, "log") {
        let commits = parse_log_records(field(&row, "stream"));
        assert_eq!(serde_json::to_value(&commits).unwrap(), row["expected"]);
    }
}

#[test]
fn parse_ref_records_reads_a_real_git_stream() {
    for row in parity_rows(STREAM_FIXTURE, "refs") {
        let refs = parse_ref_records(field(&row, "stream"));
        assert_eq!(serde_json::to_value(&refs).unwrap(), row["expected"]);
    }
}

#[test]
fn parse_tree_records_reads_a_real_git_stream() {
    for row in parity_rows(STREAM_FIXTURE, "tree") {
        let entries = parse_tree_records(field(&row, "stream"));
        assert_eq!(serde_json::to_value(&entries).unwrap(), row["expected"]);
    }
}

#[test]
fn parse_log_record_nul_separated() {
    // NUL-separated fields: sha, short_sha, subject, an, ae, aI, parents.
    let record = "deadbeefcafef00d\u{0}deadbee\u{0}initial commit\u{0}Alice\u{0}alice@x.y\u{0}2026-05-17T12:00:00Z\u{0}p1 p2";
    let v = parse_log_record(record).unwrap();
    assert_eq!(v.sha, "deadbeefcafef00d");
    assert_eq!(v.short_sha, "deadbee");
    assert_eq!(v.author_email, "alice@x.y");
    assert_eq!(v.subject, "initial commit");
    assert_eq!(v.parents, vec!["p1".to_owned(), "p2".to_owned()]);
}

/// Assert each of the three classifiers answers `stderr` as declared. Every
/// fixture row runs through this, so a predicate that widens into another's
/// territory fails here rather than silently moving a 404 to a 400.
///
/// Exclusivity is only *asserted*, never *guaranteed*, and the two halves have
/// different guarantees behind them. For the pattern family it comes from the
/// anchor plus the caller's ordering — the echoed pattern lands past
/// `fatal: header, '` so it cannot forge that predicate, and `read.rs:read_log`
/// asks that predicate first so a forged sibling cannot win; the fixture's
/// `invalid_pattern_collisions` table carries the strings where a sibling
/// genuinely does also match. For the ref/path families it comes from the
/// curated lists alone: those predicates are substring tests over git's own
/// wording, so nothing structural keeps a future git message out of both — a
/// new case has to be added to the fixture to find out.
fn assert_classified(row: &Map<String, Value>) {
    let stderr = field(row, "stderr");
    assert_eq!(
        is_no_such_ref_stderr(stderr),
        flag(row, "ref_miss"),
        "no_such_ref: {stderr:?}"
    );
    assert_eq!(
        is_no_such_path_stderr(stderr),
        flag(row, "path_miss"),
        "no_such_path: {stderr:?}"
    );
    assert_eq!(
        is_invalid_pattern_stderr(stderr),
        flag(row, "bad_pattern"),
        "invalid_pattern: {stderr:?}"
    );
}

/// The stderr classifiers gate the 404-vs-400-vs-503 split, so the two
/// backends must agree on every message. The fixture's strings are real git
/// 2.47 output captured from a bare repo, and every table pins all three
/// predicates — including the `anchor` row, a **synthetic** stderr that merely
/// *contains* the pattern prefix mid-line and must not read as a compile
/// failure.
#[test]
fn stderr_classification_cases() {
    for table in [
        "no_such_ref",
        "no_such_path",
        "invalid_pattern",
        "invalid_pattern_collisions",
        "neither",
        "anchor",
    ] {
        for row in parity_rows(STDERR_FIXTURE, table) {
            assert_classified(&row);
        }
    }
}

#[test]
fn parse_commit_detail_fields() {
    let out =
        "sha1\u{0}sha\u{0}subj\u{0}An\u{0}ae@x\u{0}d1\u{0}Cn\u{0}ce@x\u{0}d2\u{0}\u{0}body text\n";
    let v = parse_commit_detail(out).unwrap();
    assert_eq!(v.committer_name, "Cn");
    assert!(v.parents.is_empty());
    assert_eq!(v.body, "body text");
}

/// Why `read.rs:read_commit` can't trust the parse alone. Real git 2.47
/// output for `git show --no-patch --format=<11 fields> <annotated-tag-sha>
/// --`: exit 0, the tag preamble, then the **peeled commit's** full record.
/// So the parse *succeeds* and `%H` comes back carrying the preamble ahead
/// of the commit sha — never the tag sha the client asked for.
/// `fuz_forge_repo_refs` hands clients that tag sha for every
/// `refs/tags/*` annotated tag, which is what makes the reader's
/// `commit_obj.sha != sha` guard load-bearing rather than defensive.
/// Twin: `parse.records.test.ts:parse_commit_detail`'s annotated-tag case.
#[test]
fn parse_commit_detail_succeeds_on_an_annotated_tag_preamble() {
    let tag_sha = "1bd361675e9b182695e39e13a2c66815a2bad48c";
    let commit_sha = "fc6c0969eea2604ac4a0f3aba893967e6511bd9c";
    let out = format!(
        "tag v1\nTagger: T <t@t>\n\ntag msg\n{commit_sha}\u{0}fc6c096\u{0}init\u{0}T\u{0}t@t\u{0}d1\u{0}T\u{0}t@t\u{0}d2\u{0}\u{0}init\n"
    );
    let v = parse_commit_detail(&out).expect("git's tag output still parses as 11 fields");
    assert_ne!(v.sha, tag_sha, "the tag sha is never echoed back");
    assert!(
        v.sha.contains("Tagger:") && v.sha.ends_with(commit_sha),
        "`%H` carries the preamble ahead of the peeled commit sha: {:?}",
        v.sha
    );
}
