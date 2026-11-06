use fuz_http::{JsonrpcError, JsonrpcErrorCode};

use super::*;
use crate::parity::{field, flag, parity_rows};

const SEED_FROM_URL_FIXTURE: &str =
    include_str!("../../../../../src/test/fixtures/parity/seed_from_url.json");
const SEED_FROM_HOST_FIXTURE: &str =
    include_str!("../../../../../src/test/fixtures/parity/seed_from_host_policy.json");

/// Every bound failure in this module is the `-32602` a TS dispatch-schema
/// failure produces, never a 404 or a `validation_error`.
fn assert_invalid_params(err: &JsonrpcError) {
    assert_eq!(err.code, JsonrpcErrorCode::InvalidParams);
}

#[test]
fn require_seed_from_url_admits_absence() {
    assert!(require_seed_from_url(None, false).unwrap().is_none());
}

/// The *grammar* table, driven with the host policy overridden — loopback and
/// the private ranges are grammatical, and the host tables below decide them.
#[test]
fn require_seed_from_url_matches_the_shared_grammar() {
    for row in parity_rows(SEED_FROM_URL_FIXTURE, "urls") {
        let url = field(&row, "input");
        if flag(&row, "accepted") {
            assert!(
                require_seed_from_url(Some(url), true).is_ok(),
                "{url} must be accepted"
            );
        } else {
            let err = require_seed_from_url(Some(url), true)
                .expect_err(&format!("{url} must be rejected"));
            assert_invalid_params(&err);
        }
    }
}

/// The value handed to `git clone --bare` and written to the cell is the
/// parser's serialization, not the caller's bytes. This is the table the
/// authority-confusion fix rests on: the backslash spellings parse with host
/// `example.invalid` / `93.184.216.34` but would make git dial the host after
/// the `\`, so the canonical form is what gets stored and cloned.
#[test]
fn require_seed_from_url_returns_the_canonical_form() {
    for row in parity_rows(SEED_FROM_URL_FIXTURE, "canonicalized") {
        let raw = field(&row, "input");
        let got = require_seed_from_url(Some(raw), true)
            .unwrap_or_else(|_| panic!("{raw} must be accepted"))
            .unwrap_or_else(|| panic!("{raw} must yield a value"));
        assert_eq!(got, field(&row, "expected"), "{raw} must canonicalize");
    }
}

#[test]
fn seed_from_host_is_private_matches_the_shared_policy() {
    for row in parity_rows(SEED_FROM_HOST_FIXTURE, "hosts") {
        let host = field(&row, "input");
        assert_eq!(
            seed_from_host_is_private(host),
            !flag(&row, "accepted"),
            "{host}"
        );
    }
}

/// The host policy is the third gate, and the operator override lifts it —
/// the same URL is `-32602` with the override off and canonical with it on.
/// The rows are end-to-end rather than host-only because the spellings that
/// matter most are the ones the parser rewrites before the policy sees them.
#[test]
fn require_seed_from_url_applies_the_host_policy_unless_overridden() {
    for row in parity_rows(SEED_FROM_HOST_FIXTURE, "private_urls") {
        let url = field(&row, "input");
        // `accepted` is the row's verdict with the override **off**, read the
        // same way the TS twin reads it.
        let admitted = flag(&row, "accepted");
        let policed = require_seed_from_url(Some(url), false);
        assert_eq!(policed.is_ok(), admitted, "{url} under the host policy");
        if let Err(err) = policed {
            assert_invalid_params(&err);
            assert!(
                err.message.contains(SEED_FROM_HOST_MESSAGE),
                "{url} must be refused with the host message, got {}",
                err.message,
            );
        }
        assert!(
            require_seed_from_url(Some(url), true).is_ok(),
            "{url} must be admitted with the override on"
        );
    }
}

/// The grammar runs **before** the host policy, so an off-grammar value
/// with a private host is refused as a grammar failure on both backends.
#[test]
fn the_grammar_answers_before_the_host_policy() {
    let err = require_seed_from_url(Some("ssh://git@127.0.0.1/x.git"), false)
        .expect_err("must be refused");
    assert!(
        err.message.contains(SEED_FROM_URL_MESSAGE),
        "the grammar message must win, got {}",
        err.message,
    );
}
