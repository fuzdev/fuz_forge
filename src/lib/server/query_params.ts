/**
 * The one-key query read shared by the server's hand-written route handlers
 * that read a parameter themselves, past their own gates.
 *
 * Twin of `crates/fuz_forge_server/src/query_params.rs`. Both read the query
 * through their spine's strict reader (`fuz_app`'s `read_query_pairs`, behind
 * the route context's `query_pairs`, here; `fuz_http::read_query_pairs` there):
 * keys are percent-decoded before comparison, `+` is a space, the **first**
 * matching pair wins, and an escape that doesn't decode — anywhere in the
 * query, a key no handler reads included — refuses the whole query rather than
 * reading as text or as U+FFFD. Neither side reads a query through its
 * framework's helper: Hono's `c.req.query()` and axum's `Query<T>` each decode
 * leniently, and differently from each other.
 *
 * @module
 */

import type { Result } from '@fuzdev/fuz_util/result.ts';
import {
	query_first,
	type PercentDecodeError,
	type QueryPairsRead
} from '@fuzdev/fuz_app/http/request_target.ts';

/**
 * The first value for `key` in a strictly read query.
 *
 * Hono's `c.req.query(key)` is **not** these semantics and is what this
 * replaces: it first scans the un-decoded query for the literal key substring
 * and only falls back to a decoding parse when that finds nothing, so
 * `?%73ervice=git-upload-pack&service=bogus` reads as `bogus` there and as
 * `git-upload-pack` here.
 *
 * @param query_pairs - the query as the spine read it, the route context's
 *   `query_pairs`
 * @param key - the parameter name, compared after percent-decoding
 * @returns the value: `undefined` when the key is absent, the empty string for
 *   a bare or empty-valued key (`?meta`, `?meta=`), so presence is
 *   `!== undefined`; or the refusal when the query doesn't decode, which a
 *   caller answers with `REST_INVALID_QUERY_PARAMS` or its transport's own
 */
export const first_query_param = (
	query_pairs: QueryPairsRead,
	key: string
): Result<{ value: string | undefined }, { error: PercentDecodeError }> =>
	query_pairs.ok ? { ok: true, value: query_first(query_pairs.value, key) } : query_pairs;
