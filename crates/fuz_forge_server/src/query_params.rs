//! Raw query-string reads shared by the hand-mounted REST routes.
//!
//! Twin of the TS `query_params.ts`. Both backends read query
//! parameters with WHATWG `application/x-www-form-urlencoded` semantics: keys
//! are percent-decoded before comparison, `+` is a space in the value, and the
//! **first** matching pair wins. Neither side reads a query through a
//! framework helper — axum's `Query<T>` extractor and Hono's `c.req.query()`
//! each answer differently from the standard, and differently from each other.

/// The first value for `key` in a raw query string, percent-decoded.
///
/// Deliberately **not** an axum `Query<T>` extractor. An extractor runs before
/// the handler body, so a query it can't deserialize — a duplicate key, say —
/// is refused with axum's own 400 naming the field, ahead of the route's auth
/// gate and visible to anonymous callers. Reading the raw query inside the
/// handler keeps auth first and the leniency the TS twin has.
///
/// Returns `None` when the key is absent, and `Some("")` for a bare or
/// empty-valued key (`?meta`, `?meta=`) — so presence is `is_some()`, not a
/// non-empty value.
pub(crate) fn first_query_param(raw_query: Option<&str>, key: &str) -> Option<String> {
    url::form_urlencoded::parse(raw_query?.as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, value)| value.into_owned())
}

/// Whether `raw_query` carries a key outside `allowed` — the refusal half of a
/// TS `z.strictObject({...})` query schema.
///
/// The accept half is [`first_query_param`]: a duplicated *known* key collapses
/// to its first value, exactly as `c.req.query()` builds the record the TS
/// schema parses. What `strictObject` adds on top is that an *unknown* key
/// fails the parse, and this is that check, read off the same raw query so the
/// two halves see the same pairs.
///
/// An empty key name is ignored, matching Hono's record builder (it skips a
/// nameless pair, so `?=x` reaches the schema as `{}`) — otherwise this side
/// would refuse a request the TS twin accepts.
pub(crate) fn has_unknown_query_key(raw_query: Option<&str>, allowed: &[&str]) -> bool {
    let Some(raw_query) = raw_query else {
        return false;
    };
    url::form_urlencoded::parse(raw_query.as_bytes())
        .any(|(key, _)| !key.is_empty() && !allowed.contains(&key.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parity::parity_rows;

    const QUERY_PARAM_FIXTURE: &str =
        include_str!("../../../src/test/fixtures/parity/query_param.json");

    /// The shared table, asserted against
    /// `src/test/fixtures/parity/query_param.json` — the TS twin's
    /// `src/test/server/query_params.test.ts` reads the same rows.
    #[test]
    fn first_query_param_reads_whatwg_form_urlencoded() {
        for row in parity_rows(QUERY_PARAM_FIXTURE, "queries") {
            let raw_query = row["input"].as_str();
            let key = row["key"].as_str().expect("a key");
            let expected = row["expected"].as_str();
            assert_eq!(
                first_query_param(raw_query, key).as_deref(),
                expected,
                "raw_query {raw_query:?}",
            );
        }
    }

    /// The strict-object half. There is no shared fixture for it: the TS side
    /// has no helper of this shape — it reads the refusal off a
    /// `z.strictObject` query schema — so the rows below are this side's alone.
    #[test]
    fn has_unknown_query_key_mirrors_strict_object() {
        // Nothing to refuse.
        assert!(!has_unknown_query_key(None, &["acting"]));
        assert!(!has_unknown_query_key(Some(""), &["acting"]));
        assert!(!has_unknown_query_key(Some("acting=x"), &["acting"]));
        // A duplicated known key is still only the known key.
        assert!(!has_unknown_query_key(
            Some("acting=a&acting=b"),
            &["acting"]
        ));
        // A nameless pair is ignored, as Hono's record builder ignores it.
        assert!(!has_unknown_query_key(Some("=x"), &["acting"]));
        // Any other key fails the parse, wherever it sits.
        assert!(has_unknown_query_key(Some("other=1"), &["acting"]));
        assert!(has_unknown_query_key(Some("acting=a&other=1"), &["acting"]));
        assert!(has_unknown_query_key(Some("other=1&acting=a"), &["acting"]));
        // Keys are percent-decoded before comparison, so an encoded spelling of
        // a known key is known.
        assert!(!has_unknown_query_key(Some("%61cting=a"), &["acting"]));
    }
}
