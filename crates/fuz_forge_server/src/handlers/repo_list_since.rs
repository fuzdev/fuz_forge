//! The `since` grammar for `fuz_forge_repo_list`.
//!
//! A UTC ISO 8601 datetime and nothing else — `YYYY-MM-DDTHH:MM`, an optional
//! `:SS`, an optional fractional part after that, then a literal `Z`. No
//! offset form, no local form, no bare date.
//!
//! The filter is resolved by each backend's own store — a `timestamptz` cast
//! here, `Date.parse` on TS — and the two disagree, so one grammar in front of
//! both stores makes the divergence unreachable instead of documented; see
//! [`require_iso8601_datetime`] for the case that motivated it. Two bounds sit
//! outside the datetime regex because its shape is *wider* than what
//! Postgres will parse: [`MIN_ISO8601_YEAR`] and [`SINCE_MAX_LENGTH`].
//!
//! Twin of `src/lib/fuz_forge/repo/repo_list_since.ts`, which applies the same
//! two bounds under the same names. `fuz_forge_repo_log`'s `since` is
//! deliberately a *different* grammar — a git approxidate handed to `git log
//! --since=` verbatim on both backends, identical by construction.

use fuz_http::{JsonrpcError, invalid_params};

/// The one rejection message both sides raise for an off-grammar
/// `fuz_forge_repo_list` `since`.
///
/// The TS twin raises it from the input schema, where the dispatcher flattens
/// it to a bare `invalid params` (with a DEV-only `data.issues` carrying the
/// schema message), so only this backend puts the text on the wire — as with
/// [`super::seed_from::SEED_FROM_URL_MESSAGE`], the `-32602` code is the
/// contract and the text is not.
pub(super) const SINCE_DATETIME_MESSAGE: &str =
    "since must be a UTC ISO 8601 datetime (YYYY-MM-DDTHH:MM[:SS[.sss]]Z)";

/// Lowest year the grammar admits. Postgres has no year zero, and `0000` is
/// the only 4-digit year its `timestamptz` parser refuses (`date/time field
/// value out of range`) — so this is the whole calendar gap between the TS regex's
/// `\d{4}` and what this backend can store. Twin of `MIN_ISO8601_YEAR` in
/// `src/lib/fuz_forge/repo/repo_list_since.ts`.
const MIN_ISO8601_YEAR: u16 = 1;

/// Cap on the whole `fuz_forge_repo_list` `since` value, applied through
/// [`super::input_bounds::require_opt_len`] *before* the grammar. Bounds the
/// otherwise-unbounded fractional part below the 129 digits at which Postgres
/// stops parsing (`invalid input syntax`); 64 characters leaves 43 fractional
/// digits, far past any real caller. Twin of `SINCE_MAX_LENGTH` in
/// `src/lib/fuz_forge/repo/repo_list_since.ts`, where it is a `.max()` on the
/// same field.
pub(super) const SINCE_MAX_LENGTH: usize = 64;

/// Hold `fuz_forge_repo_list`'s `since` to the one datetime grammar both
/// backends share, and hand back the value.
///
/// **Why a grammar at all.** The filter is resolved by each backend's own
/// store — a `timestamptz` cast here, `Date.parse` on TS — and the two
/// disagree. Postgres accepts its special words (`yesterday`, `today`, `now`,
/// `epoch`, `infinity`); `Date.parse` returns `NaN` for every one of them and
/// the TS filter degrades to a no-op. So `{"since": "yesterday"}` filtered
/// here and listed *everything* there, and `{"since": "infinity"}` answered
/// zero rows here and every row there. Putting one grammar in front of both
/// stores makes the divergence unreachable instead of documenting it.
///
/// **The grammar** is the forge-local `RepoListSince` that
/// `FuzForgeRepoListInput.since` declares: a union of `z.iso.datetime()`,
/// which requires seconds, and its minute-precision form
/// (`z.iso.datetime({precision: -1})`), with a year floor. UTC only:
/// `YYYY-MM-DDTHH:MM`, an optional `:SS`, an optional fractional part after
/// that, then a literal `Z`. No offset form, no local form, no bare date, no
/// lowercase `t`/`z`. The calendar is validated, leap years included, because
/// the TS regex does (`2020-02-30T00:00:00Z` and `2021-02-29T00:00:00Z` are
/// refused there, so they are refused here).
///
/// **Two bounds sit outside that regex**, and both exist because the TS regex
/// is *wider* than what Postgres will parse — a value the schema admits and
/// the cast refuses is a `-32603` here against a `200` on TS, the same class
/// of split the grammar was added to close. [`MIN_ISO8601_YEAR`] refuses year
/// zero, which `\d{4}` admits (and which is a leap year by the Gregorian
/// rule, so `0000-02-29T00:00:00Z` passed too). [`SINCE_MAX_LENGTH`], applied
/// by the caller through [`super::input_bounds::require_opt_len`] *before*
/// this function, bounds the unbounded `\.\d+` fraction. Both are named the
/// same on the TS side.
///
/// `fuz_forge_repo_log`'s `since` keeps its own `require_opt_len` and no
/// grammar — it stays a free-form git approxidate string on both backends.
///
/// # Errors
///
/// [`invalid_params`] (-32602) when a present value is not such a datetime.
pub(super) fn require_iso8601_datetime(
    value: Option<&str>,
) -> Result<Option<String>, JsonrpcError> {
    let Some(value) = value else { return Ok(None) };
    if is_iso8601_datetime(value) {
        return Ok(Some(value.to_owned()));
    }
    Err(invalid_params(
        &format!("invalid params: {SINCE_DATETIME_MESSAGE}"),
        None,
    ))
}

/// Whether `value` is a UTC ISO 8601 datetime in `RepoListSince`'s grammar:
/// the union of `z.iso.datetime()` and its minute-precision form, plus the
/// [`MIN_ISO8601_YEAR`] floor its `.refine` adds. Twin of `RepoListSince` in
/// `src/lib/fuz_forge/repo/repo_list_since.ts`; the shared case table is
/// `src/test/fixtures/parity/repo_list_since.json`, asserted by this module's
/// tests and by `src/test/fuz_forge/repo/repo_list_since.test.ts`.
fn is_iso8601_datetime(value: &str) -> bool {
    let bytes = value.as_bytes();
    // `YYYY-MM-DDT` then at least `HH:MM` then `Z` — 17 bytes minimum.
    if bytes.len() < 17 || !value.is_ascii() {
        return false;
    }
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let (date, rest) = value.split_at(10);
    if !rest.starts_with('T') {
        return false;
    }
    // Date: `YYYY-MM-DD`, calendar-validated.
    let (Some(year), Some(month), Some(day)) = (date.get(0..4), date.get(5..7), date.get(8..10))
    else {
        return false;
    };
    if date.as_bytes()[4] != b'-' || date.as_bytes()[7] != b'-' {
        return false;
    }
    if !digits(year) || !digits(month) || !digits(day) {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) =
        (year.parse::<u16>(), month.parse::<u8>(), day.parse::<u8>())
    else {
        return false;
    };
    // The year floor is Postgres's, not the TS regex's — see `MIN_ISO8601_YEAR`.
    if year < MIN_ISO8601_YEAR
        || !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
    {
        return false;
    }
    // Time: `HH:MM`, an optional `:SS`, an optional `.fraction`, then `Z`.
    let time = &rest[1..];
    let Some(time) = time.strip_suffix('Z') else {
        return false;
    };
    let (hh_mm, tail) = time.split_at(time.len().min(5));
    if hh_mm.len() != 5 || hh_mm.as_bytes()[2] != b':' {
        return false;
    }
    let (Some(hh), Some(mm)) = (hh_mm.get(0..2), hh_mm.get(3..5)) else {
        return false;
    };
    if !digits(hh) || !digits(mm) {
        return false;
    }
    let (Ok(hh), Ok(mm)) = (hh.parse::<u8>(), mm.parse::<u8>()) else {
        return false;
    };
    if hh > 23 || mm > 59 {
        return false;
    }
    if tail.is_empty() {
        return true;
    }
    // `:SS` is required before any fractional part.
    let Some(tail) = tail.strip_prefix(':') else {
        return false;
    };
    let (ss, frac) = tail.split_at(tail.len().min(2));
    if ss.len() != 2 || !digits(ss) || ss.parse::<u8>().is_ok_and(|s| s > 59) {
        return false;
    }
    if frac.is_empty() {
        return true;
    }
    // A fractional part is `.` plus one or more digits — no bare `.`.
    frac.strip_prefix('.')
        .is_some_and(|d| !d.is_empty() && digits(d))
}

/// Days in a Gregorian month, leap years included — the calendar rule the TS
/// datetime regex encodes (divisible by 4, except centuries not
/// divisible by 400).
const fn days_in_month(year: u16, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        _ => 0,
    }
}

#[cfg(test)]
mod tests;
