//! Readers for the shared TS ↔ Rust parity fixtures under
//! `src/test/fixtures/parity/`, used by the unit tests that assert against
//! them. Twin: `src/test/fixtures/parity/load.ts`.
//!
//! Each test module keeps its own `include_str!` of the fixture it reads —
//! `tests/parity_fixture_census.rs` scans for those to prove every fixture
//! is read — and hands the text here.

use serde_json::{Map, Value};

/// Rows of one shared parity fixture table, with the envelope's declared row
/// count asserted.
pub fn parity_rows(raw: &str, table: &str) -> Vec<Map<String, Value>> {
    let fixture: Value = serde_json::from_str(raw).expect("parity fixture parses");
    let rows: Vec<Map<String, Value>> =
        serde_json::from_value(fixture["tables"][table].clone()).expect("parity table");
    assert!(!rows.is_empty(), "parity table {table} is empty");
    assert_eq!(fixture["counts"][table], rows.len(), "parity table {table}");
    rows
}

/// A row's string field.
pub fn field<'a>(row: &'a Map<String, Value>, key: &str) -> &'a str {
    row[key].as_str().expect("parity row carries a string")
}

/// A row's boolean field.
pub fn flag(row: &Map<String, Value>, key: &str) -> bool {
    row[key].as_bool().expect("parity row carries a bool")
}
