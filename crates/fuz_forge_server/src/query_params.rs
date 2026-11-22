//! The one-key query read shared by the hand-mounted REST routes that read a
//! parameter themselves, past their own gates.
//!
//! Twin of the TS `query_params.ts`. Both read the query through their spine's
//! strict reader (`fuz_http::read_query_pairs` here, `fuz_app`'s
//! `read_query_pairs` behind the route context's `query_pairs` there): keys are
//! percent-decoded before comparison, `+` is a space, the **first** matching
//! pair wins, and an escape that doesn't decode — anywhere in the query, a key
//! no handler reads included — refuses the whole query rather than reading as
//! text or as U+FFFD. Neither side reads a query through a framework helper:
//! axum's `Query<T>` and Hono's `c.req.query()` each decode leniently, and
//! differently from each other.

use fuz_http::{PercentDecodeError, query_first, read_query_pairs};

/// The first value for `key` in a raw query string, percent-decoded strictly.
///
/// Deliberately **not** an axum `Query<T>` extractor. An extractor runs before
/// the handler body, so a query it can't deserialize — a duplicate key, say —
/// is refused with axum's own 400 naming the field, ahead of the route's auth
/// gate and visible to anonymous callers. Reading the raw query inside the
/// handler keeps auth first, as the TS twin's handler reads it.
///
/// `Ok(None)` when the key is absent, and `Ok(Some(""))` for a bare or
/// empty-valued key (`?meta`, `?meta=`) — so presence is `is_some()`, not a
/// non-empty value.
///
/// # Errors
///
/// [`PercentDecodeError`] when any name or value in the query doesn't decode;
/// a caller answers the flat `400 invalid_query_params`, or its transport's
/// own refusal.
pub(crate) fn first_query_param(
    raw_query: Option<&str>,
    key: &str,
) -> Result<Option<String>, PercentDecodeError> {
    let pairs = read_query_pairs(raw_query)?;
    Ok(query_first(&pairs, key).map(str::to_owned))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parity::parity_rows;

    const QUERY_PARAM_FIXTURE: &str =
        include_str!("../../../src/test/fixtures/parity/query_param.json");

    /// The shared table, asserted against
    /// `src/test/fixtures/parity/query_param.json` — the TS twin's
    /// `src/test/server/query_params.test.ts` reads the same rows. A row
    /// carries `refused` (the refusal's wire name) or `expected` (the value,
    /// `null` for absent).
    #[test]
    fn first_query_param_reads_strictly() {
        for row in parity_rows(QUERY_PARAM_FIXTURE, "queries") {
            let raw_query = row["input"].as_str();
            let key = row["key"].as_str().expect("a key");
            let got = first_query_param(raw_query, key);
            match row.get("refused") {
                Some(refused) => assert_eq!(
                    got.map_err(PercentDecodeError::as_str),
                    Err(refused.as_str().expect("a refusal name")),
                    "raw_query {raw_query:?}",
                ),
                None => assert_eq!(
                    got.as_ref().map(Option::as_deref),
                    Ok(row["expected"].as_str()),
                    "raw_query {raw_query:?}",
                ),
            }
        }
    }
}
