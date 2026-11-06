/**
 * Raw query-string reads shared by the server's hand-written route handlers.
 *
 * Twin of `crates/fuz_forge_server/src/query_params.rs`. Both backends read
 * query parameters with WHATWG `application/x-www-form-urlencoded` semantics:
 * keys are percent-decoded before comparison, `+` is a space in the value, and
 * the **first** matching pair wins. Neither side reads a query through its
 * framework's helper — Hono's `c.req.query()` and axum's `Query<T>` extractor
 * each answer differently from the standard, and differently from each other,
 * so a route that used one drifted from its twin.
 *
 * @module
 */

/**
 * The first value for `key` in a raw query string, percent-decoded.
 *
 * Hono's `c.req.query(key)` is **not** these semantics and is what this
 * replaces: it first scans the un-decoded query for the literal key substring
 * and only falls back to a decoding parse when that finds nothing, so
 * `?%73ervice=git-upload-pack&service=bogus` reads as `bogus` there and as
 * `git-upload-pack` under the standard.
 *
 * @param raw_query - the query string with no leading `?`, or `undefined`
 * @param key - the parameter name, compared after percent-decoding
 * @returns `undefined` when the key is absent; the empty string for a bare or
 *   empty-valued key (`?meta`, `?meta=`), so presence is `!== undefined`
 */
export const first_query_param = (
	raw_query: string | undefined,
	key: string
): string | undefined =>
	raw_query === undefined ? undefined : (new URLSearchParams(raw_query).get(key) ?? undefined);

/**
 * The raw query string of a request URL, or `undefined` when there is none.
 *
 * TS-side plumbing with no Rust twin — axum hands a handler the raw query
 * directly via its `RawQuery` extractor, while Hono only exposes the full URL
 * (`c.req.raw.url`) with the pre-decode spelling intact.
 */
export const raw_query_of = (url: string): string | undefined => {
	const query_at = url.indexOf('?');
	return query_at < 0 ? undefined : url.slice(query_at + 1);
};
