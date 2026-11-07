use fuz_http::JsonrpcErrorCode;
use serde_json::json;

use super::*;

/// Every bound failure in this module is the `-32602` a TS dispatch-schema
/// failure produces, never a 404 or a `validation_error`.
fn assert_invalid_params(err: &JsonrpcError) {
    assert_eq!(err.code, JsonrpcErrorCode::InvalidParams);
}

#[test]
fn require_len_pins_both_edges() {
    assert!(require_len("name", "a", 1, 80).is_ok());
    assert!(require_len("name", &"a".repeat(80), 1, 80).is_ok());
    assert_invalid_params(&require_len("name", "", 1, 80).unwrap_err());
    assert_invalid_params(&require_len("name", &"a".repeat(81), 1, 80).unwrap_err());
}

#[test]
fn require_len_counts_utf16_code_units_like_js() {
    // `String.length` in JS is 2 for an astral-plane char, so a 40-char
    // emoji string is 80 units — at the `name` ceiling, not half of it.
    let emoji = "\u{1f600}".repeat(40);
    assert_eq!(utf16_len(&emoji), 80);
    assert!(require_len("name", &emoji, 1, 80).is_ok());
    assert_invalid_params(&require_len("name", &"\u{1f600}".repeat(41), 1, 80).unwrap_err());
}

#[test]
fn require_opt_len_admits_absence() {
    assert!(require_opt_len("since", None, 0, 64).is_ok());
    assert_invalid_params(&require_opt_len("since", Some(&"a".repeat(65)), 0, 64).unwrap_err());
}

#[test]
fn require_nonempty_entries_pins_count_and_emptiness() {
    let one = vec!["a".to_owned()];
    assert!(require_nonempty_entries("methods", &one, 1, 64).is_ok());
    assert_invalid_params(&require_nonempty_entries("methods", &[], 1, 64).unwrap_err());
    assert_invalid_params(
        &require_nonempty_entries("methods", &vec!["a".to_owned(); 65], 1, 64).unwrap_err(),
    );
    assert_invalid_params(
        &require_nonempty_entries("methods", &[String::new()], 1, 64).unwrap_err(),
    );
}

#[test]
fn require_int_range_pins_both_edges() {
    assert_eq!(require_int_range("limit", &json!(1), 1, 200).unwrap(), 1);
    assert_eq!(
        require_int_range("limit", &json!(200), 1, 200).unwrap(),
        200
    );
    assert_invalid_params(&require_int_range("limit", &json!(0), 1, 200).unwrap_err());
    assert_invalid_params(&require_int_range("limit", &json!(201), 1, 200).unwrap_err());
    // Negative values must not wrap through the `usize` conversion.
    assert_invalid_params(&require_int_range("limit", &json!(-1), 1, 200).unwrap_err());
}

/// JSON has one number type and the TS `integer` schema asks only whether the
/// value is integral, so `50.0` is a valid `limit` on the TS side — and a
/// JS client cannot even spell it differently from `50`. Deserializing
/// straight into `usize` would refuse it, making Rust stricter than its
/// twin. Twin of the same widening in the spine's
/// `parse_token_lifetime_param`.
#[test]
fn require_int_range_accepts_integral_floats_like_ts() {
    assert_eq!(
        require_int_range("limit", &json!(50.0), 1, 200).unwrap(),
        50
    );
    assert_eq!(require_int_range("limit", &json!(5e1), 1, 200).unwrap(), 50);
    assert_invalid_params(&require_int_range("limit", &json!(50.5), 1, 200).unwrap_err());
    assert_invalid_params(&require_int_range("limit", &json!("50"), 1, 200).unwrap_err());
    assert_invalid_params(&require_int_range("limit", &json!(true), 1, 200).unwrap_err());
    // integers past the `as_integral_i64` guard are a range failure, not a type failure
    let overflow = require_int_range("limit", &json!(1e19), 1, 200).unwrap_err();
    assert_invalid_params(&overflow);
    assert!(
        overflow.message.contains("must be 1-200"),
        "{}",
        overflow.message
    );
    let overflow =
        require_int_range("limit", &json!(18_446_744_073_709_551_615_u64), 1, 200).unwrap_err();
    assert!(
        overflow.message.contains("must be 1-200"),
        "{}",
        overflow.message
    );
}

#[test]
fn require_repo_selector_takes_exactly_one() {
    const ID: &str = "3f8a1c2e-1234-4abc-9def-0123456789ab";
    assert!(matches!(
        require_repo_selector(Some(ID), None),
        Ok(RepoSelector::Id(ID))
    ));
    assert!(matches!(
        require_repo_selector(None, Some("org/repo")),
        Ok(RepoSelector::Slug("org/repo"))
    ));
    assert_invalid_params(&require_repo_selector(Some(ID), Some("org/repo")).unwrap_err());
    assert_invalid_params(&require_repo_selector(None, None).unwrap_err());
}

/// A malformed slug is a schema failure on the TS side (`RepoSlug` is part
/// of the input schema), so it must not fall through to a 404.
#[test]
fn require_repo_selector_holds_slug_to_the_grammar() {
    for bad in ["a", "noslash", "too/many/slashes", "-lead/repo", "../etc"] {
        assert_invalid_params(&require_repo_selector(None, Some(bad)).unwrap_err());
    }
}
