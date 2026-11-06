use fuz_http::{JsonrpcError, JsonrpcErrorCode};

use super::*;
use crate::handlers::input_bounds::require_opt_len;
use crate::parity::{field, flag, parity_rows};

const SINCE_FIXTURE: &str =
    include_str!("../../../../../src/test/fixtures/parity/repo_list_since.json");

/// Every bound failure in this module is the `-32602` a TS dispatch-schema
/// failure produces, never a 404 or a `validation_error`.
fn assert_invalid_params(err: &JsonrpcError) {
    assert_eq!(err.code, JsonrpcErrorCode::InvalidParams);
}

/// Both `since` bounds in the order `fuz_forge_repo_list` applies them —
/// the length cap, then the grammar. The fixture's rows are the *field's*
/// contract, not one function's, so they have to run the same pair; the TS
/// twin gets both from one `RepoListSince` schema.
fn check_since(value: &str) -> Result<Option<String>, JsonrpcError> {
    require_opt_len("since", Some(value), 0, SINCE_MAX_LENGTH)?;
    require_iso8601_datetime(Some(value))
}

#[test]
fn require_iso8601_datetime_admits_absence() {
    assert!(require_iso8601_datetime(None).unwrap().is_none());
}

/// The load-bearing half runs in both directions: the Postgres special words
/// at the top of the reject rows parse *here* and not on TS, and the three at
/// the bottom parse on TS and not here.
#[test]
fn require_iso8601_datetime_matches_the_shared_grammar() {
    for row in parity_rows(SINCE_FIXTURE, "since") {
        let value = field(&row, "input");
        if flag(&row, "accepted") {
            let got = check_since(value).unwrap_or_else(|_| panic!("{value} must be accepted"));
            assert_eq!(got.as_deref(), Some(value), "{value} must pass through");
        } else {
            let err = check_since(value).expect_err(&format!("{value:?} must be rejected"));
            assert_invalid_params(&err);
        }
    }
}

/// The shared length cap, read off the same fixture the TS `.max()` is.
#[test]
fn since_max_length_matches_the_ts_twin() {
    for row in parity_rows(SINCE_FIXTURE, "constants") {
        assert_eq!(field(&row, "name"), "SINCE_MAX_LENGTH");
        assert_eq!(row["value"], SINCE_MAX_LENGTH);
    }
}

/// The grammar's own message reaches the wire for every off-grammar value —
/// the over-cap one is the exception, refused a step earlier by the length
/// bound with `require_opt_len`'s own wording.
#[test]
fn require_iso8601_datetime_carries_the_shared_message() {
    for row in parity_rows(SINCE_FIXTURE, "since") {
        let value = field(&row, "input");
        if flag(&row, "accepted") || value.len() > SINCE_MAX_LENGTH {
            continue;
        }
        let err = require_iso8601_datetime(Some(value))
            .expect_err(&format!("{value:?} must be rejected"));
        assert!(
            err.message.contains(SINCE_DATETIME_MESSAGE),
            "{value:?} must carry the since message, got {}",
            err.message,
        );
    }
}
