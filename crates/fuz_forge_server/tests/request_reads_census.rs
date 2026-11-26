//! The request-reads census over this workspace: a forge handler reads its
//! query and its path params only through the spine's strict readers —
//! `fuz_http::read_query_pairs` over axum's `RawQuery`, and
//! `fuz_http::RouteParams`. The checks are the spine's shared
//! request-reads census in `fuz_testing` (its `assert_*` checks; what each
//! pins, and what it cannot see, is its crate doc § The request-reads
//! census); this file holds this workspace's inputs — its [`SUPPRESSIONS`]
//! and its positive controls.
//!
//! The positive controls below use each disallowed item under an `#[expect]`,
//! so a path that stops resolving under this workspace's `clippy.toml` (an axum
//! or `url` upgrade moving it) leaves the expectation unfulfilled — an error
//! under `-D warnings`. This crate links `url`, so the two method disallows
//! have their controls here beside the axum types'.

use std::path::PathBuf;

use fuz_testing::{
    Suppression, assert_clippy_configs_disallow_lenient_readers,
    assert_no_lints_table_allows_disallows, assert_suppressions_listed,
};

// Positive controls: each uses one disallowed item, so the `#[expect]` is
// fulfilled only while clippy resolves that entry. One item per entry — a
// shared expectation is fulfilled by any one of them.

#[expect(
    dead_code,
    clippy::disallowed_types,
    reason = "positive control: unfulfilled once `axum::extract::Path` stops resolving"
)]
const fn path_control(_: &axum::extract::Path<String>) {}

#[expect(
    dead_code,
    clippy::disallowed_types,
    reason = "positive control: unfulfilled once `axum::extract::RawPathParams` stops resolving"
)]
const fn raw_path_params_control(_: &axum::extract::RawPathParams) {}

#[expect(
    dead_code,
    clippy::disallowed_types,
    reason = "positive control: unfulfilled once `axum::extract::Query` stops resolving"
)]
const fn query_control(_: &axum::extract::Query<Vec<(String, String)>>) {}

#[expect(
    dead_code,
    clippy::disallowed_types,
    reason = "positive control: unfulfilled once `axum::extract::Form` stops resolving"
)]
const fn form_control(_: &axum::extract::Form<Vec<(String, String)>>) {}

#[expect(
    dead_code,
    clippy::disallowed_methods,
    reason = "positive control: unfulfilled once `form_urlencoded::parse` stops resolving"
)]
fn form_urlencoded_parse_control() -> usize {
    url::form_urlencoded::parse(b"").count()
}

#[expect(
    dead_code,
    clippy::disallowed_methods,
    reason = "positive control: unfulfilled once `url::Url::query_pairs` stops resolving"
)]
fn url_query_pairs_control(url: &url::Url) -> usize {
    url.query_pairs().count()
}

/// Every source file that suppresses the disallow lints, each with its reason.
/// Every other file names none.
const SUPPRESSIONS: &[Suppression] = &[Suppression {
    file: "fuz_forge_server/tests/request_reads_census.rs",
    sites: 6,
    reason: "the positive controls of the axum type and `url` method disallows",
}];

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

#[test]
fn every_clippy_config_disallows_the_lenient_readers() {
    assert_clippy_configs_disallow_lenient_readers(&workspace_root());
}

#[test]
fn every_suppression_of_the_disallows_is_listed() {
    assert_suppressions_listed(&workspace_root(), SUPPRESSIONS);
}

#[test]
fn no_lints_table_allows_the_disallows() {
    assert_no_lints_table_allows_disallows(&workspace_root());
}
