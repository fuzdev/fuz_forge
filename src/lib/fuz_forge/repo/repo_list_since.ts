/**
 * The `since` grammar for `fuz_forge_repo_list`.
 *
 * A UTC ISO 8601 datetime and nothing else — `YYYY-MM-DDTHH:MM`, an optional
 * `:SS`, an optional fractional part after that, then a literal `Z`. No offset
 * form, no local form, no bare date.
 *
 * **Why the field has a grammar at all.** The filter is resolved by each
 * backend's own store — `Date.parse` on this one, a `timestamptz` cast on the
 * Rust twin — and the two disagree. Postgres accepts its special words
 * (`yesterday`, `today`, `now`, `epoch`, `infinity`); `Date.parse` returns
 * `NaN` for every one of them and the filter degraded to a no-op. So
 * `{since: 'yesterday'}` filtered on one backend and listed *everything* on the
 * other, with no error on either side to reveal it. One grammar in front of
 * both stores makes the divergence unreachable rather than documented.
 *
 * **Two bounds sit outside `z.iso.datetime()`**, and both exist because zod's
 * grammar is *wider* than what Postgres will parse — a value that passes the
 * schema but not the cast is a `-32603`/500 on the Rust backend against a
 * `200` here, which is the same class of split the grammar was added to close:
 *
 * - **Year zero.** Zod's regex is `\d{4}`, so `0000-01-01T00:00:00Z` passes
 *   (and `0000-02-29T00:00:00Z` too — year 0 is a leap year by the Gregorian
 *   rule). Postgres has no year zero and answers `date/time field value out of
 *   range`; `0000` is the only 4-digit year it refuses. Hence
 *   `MIN_ISO8601_YEAR`.
 * - **Length.** The fractional part is `\.\d+`, unbounded. Postgres rejects a
 *   fraction at 129 digits with `invalid input syntax`. `SINCE_MAX_LENGTH`
 *   caps the whole value well under that (64 characters leaves room for 43
 *   fractional digits), which is cheaper and more legible than bounding the
 *   fraction alone.
 *
 * **The seconds-optional form is spelled out.** `z.iso.datetime()` requires
 * seconds before a `Z` (RFC 3339 does), so `YYYY-MM-DDTHH:MMZ` is admitted by a
 * second, minute-precision member rather than the default one. The grammar
 * predates that and both backends still take it.
 *
 * The Rust twin is `require_iso8601_datetime` in
 * `crates/fuz_forge_server/src/handlers/repo_list_since.rs`, which applies the
 * same two bounds under the same names — `MIN_ISO8601_YEAR` beside its
 * month/day checks, and `SINCE_MAX_LENGTH` through `require_opt_len` ahead of
 * the grammar. Both unit suites read the shared accept/reject cases from
 * `src/test/fixtures/parity/repo_list_since.json`.
 *
 * `fuz_forge_repo_log`'s `since` is deliberately a *different* grammar: it is
 * handed to `git log --since=` verbatim on both backends, so it reads git's
 * approxidate (`2 weeks ago`) and is identical by construction.
 *
 * @module
 */

import { z } from 'zod';

/**
 * The one rejection message both sides raise for an off-grammar `since`.
 *
 * Only the Rust backend puts it on the wire — here the grammar is on the input
 * schema and the dispatcher flattens every schema failure to a bare `invalid
 * params` with a DEV-only `data.issues`. Both sides answer `-32602`, so that
 * code is the cross-backend contract; the text is not.
 */
export const SINCE_DATETIME_MESSAGE =
	'since must be a UTC ISO 8601 datetime (YYYY-MM-DDTHH:MM[:SS[.sss]]Z)';

/**
 * Lowest year the grammar admits. Postgres has no year zero, and `0000` is the
 * only 4-digit year its `timestamptz` parser refuses — so this is the whole
 * calendar gap between zod's `\d{4}` and what the Rust backend can store.
 */
export const MIN_ISO8601_YEAR = 1;

/**
 * Cap on the whole `since` value. Bounds the otherwise-unbounded fractional
 * part below the 129 digits at which Postgres stops parsing; 64 characters
 * leaves 43 fractional digits, far past any real caller.
 */
export const SINCE_MAX_LENGTH = 64;

/**
 * `fuz_forge_repo_list`'s `since` — a UTC ISO 8601 datetime both backends
 * parse to the same instant. See the module docs for the two bounds layered
 * over `z.iso.datetime()` and the minute-precision member.
 *
 * Forge-local rather than fuz_app's `Datetime` brand: that one is
 * `z.iso.datetime()` exactly, and cannot express either bound.
 */
export const RepoListSince = z
	.union([
		z.iso.datetime().max(SINCE_MAX_LENGTH),
		// fixed-width (`YYYY-MM-DDTHH:MMZ`), so no length bound
		z.iso.datetime({ precision: -1 })
	])
	// The year is the first four characters of a value the regex has already
	// admitted, so a slice is the whole parse.
	.refine((value) => Number(value.slice(0, 4)) >= MIN_ISO8601_YEAR, {
		message: SINCE_DATETIME_MESSAGE
	});
export type RepoListSince = z.infer<typeof RepoListSince>;
