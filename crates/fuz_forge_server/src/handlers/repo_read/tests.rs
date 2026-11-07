use fuz_http::JsonrpcErrorCode;
use serde_json::json;

use super::*;
use crate::parity::parity_rows;

const ID: &str = "3f8a1c2e-1234-4abc-9def-0123456789ab";

const READ_BOUNDS_FIXTURE: &str =
    include_str!("../../../../../src/test/fixtures/parity/git_read_bounds.json");

/// The page limits are a *wire* contract, not an implementation detail: a
/// different default pages a different first response, and a different max
/// clamps a client's `limit` differently. Asserted against
/// `src/test/fixtures/parity/git_read_bounds.json`, which the TS twin
/// (`src/test/server/git/read.test.ts` § read-layer bounds) reads beside the
/// byte caps.
#[test]
fn log_page_limits_match_the_ts_twin() {
    for row in parity_rows(READ_BOUNDS_FIXTURE, "log_page_limits") {
        let name = row["name"].as_str().expect("a name");
        let declared = match name {
            "DEFAULT_LOG_LIMIT" => DEFAULT_LOG_LIMIT,
            "MAX_LOG_LIMIT" => MAX_LOG_LIMIT,
            other => panic!("no such log page limit: {other}"),
        };
        assert_eq!(row["value"], declared, "{name}");
    }
}

/// Every input-shape refusal is the `-32602` a TS dispatch-schema failure
/// produces. Asserted through the spine's [`parse_strict_params`] rather than a
/// bare `serde_json::from_value`, because the envelope is the contract —
/// a struct that merely "fails to parse" says nothing about which code the
/// wire sees.
fn assert_invalid_params(err: &JsonrpcError) {
    assert_eq!(err.code, JsonrpcErrorCode::InvalidParams);
}

/// `deny_unknown_fields` is the `z.strictObject` twin: a key no read
/// input declares is refused at parse, so the handler never runs on a
/// silently-dropped field (a typo'd filter would otherwise read as
/// "no filter" on Rust and 400 on TS).
#[test]
fn read_inputs_reject_an_unknown_key() {
    assert_invalid_params(&parse_strict_params::<RepoListInput>(json!({"nope": 1})).unwrap_err());
    assert_invalid_params(
        &parse_strict_params::<RepoGetInput>(json!({"id": ID, "nope": 1})).unwrap_err(),
    );
    assert_invalid_params(
        &parse_strict_params::<RepoLogInput>(json!({"id": ID, "nope": 1})).unwrap_err(),
    );
    assert_invalid_params(
        &parse_strict_params::<RepoCommitInput>(json!({"id": ID, "sha": "x", "nope": 1}))
            .unwrap_err(),
    );
    assert_invalid_params(
        &parse_strict_params::<RepoRefsInput>(json!({"id": ID, "nope": 1})).unwrap_err(),
    );
    assert_invalid_params(
        &parse_strict_params::<RepoTreeInput>(json!({"id": ID, "ref": "main", "nope": 1}))
            .unwrap_err(),
    );
    assert_invalid_params(
        &parse_strict_params::<RepoBlobInput>(
            json!({"id": ID, "ref": "main", "path": "a", "nope": 1}),
        )
        .unwrap_err(),
    );
}

/// The dispatcher reads `acting` off the raw params, so every input that
/// declares it in the TS spec must still accept it once the struct is
/// strict — otherwise a multi-actor account's request would 400.
#[test]
fn read_inputs_accept_the_dispatcher_owned_acting_selector() {
    assert!(parse_strict_params::<RepoListInput>(json!({"acting": ID})).is_ok());
    assert!(parse_strict_params::<RepoGetInput>(json!({"id": ID, "acting": ID})).is_ok());
    assert!(parse_strict_params::<RepoLogInput>(json!({"id": ID, "acting": ID})).is_ok());
    assert!(
        parse_strict_params::<RepoCommitInput>(json!({"id": ID, "sha": "x", "acting": ID})).is_ok()
    );
    assert!(parse_strict_params::<RepoRefsInput>(json!({"id": ID, "acting": ID})).is_ok());
    assert!(
        parse_strict_params::<RepoTreeInput>(json!({"id": ID, "ref": "main", "acting": ID}))
            .is_ok()
    );
    assert!(
        parse_strict_params::<RepoBlobInput>(
            json!({"id": ID, "ref": "main", "path": "a", "acting": ID})
        )
        .is_ok()
    );
}

/// The spine's [`parse_strict_params`] runs the `null` walk ahead of the
/// decode: `null` on an optional key is `-32602` on TS (`.optional()` admits
/// absence only) but `None` to serde, which would read as "no filter" and
/// answer 200. On the repo selector that difference is load-bearing —
/// `{"id": null, "slug": "org/repo"}` would otherwise resolve as a slug-only
/// lookup the TS twin refuses.
#[test]
fn read_inputs_reject_a_null_on_an_optional_key() {
    assert_invalid_params(
        &parse_strict_params::<RepoListInput>(json!({"slug_prefix": null})).unwrap_err(),
    );
    assert_invalid_params(
        &parse_strict_params::<RepoListInput>(json!({"since": null})).unwrap_err(),
    );
    assert_invalid_params(
        &parse_strict_params::<RepoGetInput>(json!({"id": null, "slug": "org/repo"})).unwrap_err(),
    );
    assert_invalid_params(
        &parse_strict_params::<RepoGetInput>(json!({"id": ID, "acting": null})).unwrap_err(),
    );
    assert_invalid_params(
        &parse_strict_params::<RepoLogInput>(json!({"id": ID, "limit": null})).unwrap_err(),
    );
    assert_invalid_params(
        &parse_strict_params::<RepoLogInput>(json!({"id": ID, "author": null})).unwrap_err(),
    );
    assert_invalid_params(
        &parse_strict_params::<RepoLogInput>(json!({"id": ID, "cursor": null})).unwrap_err(),
    );
    assert_invalid_params(
        &parse_strict_params::<RepoLogInput>(json!({"id": ID, "path": null})).unwrap_err(),
    );
    assert_invalid_params(
        &parse_strict_params::<RepoTreeInput>(json!({"id": ID, "ref": null})).unwrap_err(),
    );
    assert!(parse_strict_params::<RepoTreeInput>(json!({"id": ID, "ref": "main"})).is_ok());
}

/// `ref` is a Rust keyword, so the field spells `ref_` and carries a
/// `rename`. Without it the wire key lands nowhere and the log silently
/// reads the default branch — the exact failure `deny_unknown_fields`
/// now also catches.
#[test]
fn repo_log_input_binds_the_wire_ref_key() {
    let input: RepoLogInput =
        parse_strict_params(json!({"id": ID, "ref": "topic"})).expect("parses");
    assert_eq!(input.ref_.as_deref(), Some("topic"));
}

/// `limit` is carried as the raw JSON value so the integral-float
/// spellings the TS `integer` schema accepts survive to [`require_int_range`]; an
/// `Option<usize>` field would 400 on `50.0`, which the TS twin mints.
#[test]
fn repo_log_input_carries_the_raw_limit_value() {
    let input: RepoLogInput =
        parse_strict_params(json!({"id": ID, "limit": 50.0})).expect("parses");
    assert_eq!(
        require_int_range(
            "limit",
            input.limit.as_ref().expect("present"),
            1,
            MAX_LOG_LIMIT
        )
        .unwrap(),
        50
    );
}
