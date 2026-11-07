//! Input bound checks shared by the forge RPC handlers.
//!
//! The twin of the schema bounds declared on the forge action inputs in
//! `src/lib/action_specs.ts`. The TS dispatcher enforces them *before* the
//! handler runs (the input parse → `-32602`), so the Rust handlers
//! enforce them immediately after `fuz_http::parse_strict_params` and return
//! the same [`invalid_params`] envelope.
//!
//! Serde covers the shape half of a strict `object` — required-vs-optional,
//! types, and (with `#[serde(deny_unknown_fields)]` on every input struct)
//! unknown keys; the one place it is *more permissive* than the TS schema, mapping a
//! JSON `null` onto `Option::None` where `optional` refuses it, is closed
//! by the spine's `fuz_http::parse_strict_params`, which every handler
//! decodes through. What neither expresses is the length/count half, which is
//! what lives here.
//!
//! String lengths are measured in **UTF-16 code units**, not chars: the TS
//! side is `min_length` / `max_length`, which count JavaScript `String.length`
//! (UTF-16 units). Counting chars or bytes would agree on every ASCII input and
//! drift on astral-plane text, which is exactly the kind of silent divergence
//! this module exists to prevent.

use fuz_http::{JsonrpcError, as_integral_i64, invalid_params};
use serde_json::Value;

use super::repo_id::validate_repo_slug;
use crate::text::utf16_len;

/// The one selector a repo lookup carries. `id` xor `slug` is a wire
/// invariant, so the resolved form makes "both" and "neither" unrepresentable
/// past [`require_repo_selector`].
#[derive(Debug)]
pub(super) enum RepoSelector<'a> {
    /// The repo cell-id UUID. Grammar-checked at the lookup ingress
    /// ([`super::repo_cell::query_repo_cell`]).
    Id(&'a str),
    /// The `org/repo` clone handle, already grammar-checked.
    Slug(&'a str),
}

/// Bound a string field to `min..=max` UTF-16 code units.
///
/// # Errors
///
/// [`invalid_params`] (-32602) when the length falls outside the range.
pub(super) fn require_len(
    field: &str,
    value: &str,
    min: usize,
    max: usize,
) -> Result<(), JsonrpcError> {
    let len = utf16_len(value);
    if (min..=max).contains(&len) {
        return Ok(());
    }
    Err(invalid_params(
        &format!("invalid params: {field} must be {min}-{max} characters, got {len}"),
        None,
    ))
}

/// [`require_len`] over an optional field — absent is always in bounds
/// (the TS twins are `.optional()`).
///
/// # Errors
///
/// [`invalid_params`] (-32602) when a present value falls outside the range.
pub(super) fn require_opt_len(
    field: &str,
    value: Option<&str>,
    min: usize,
    max: usize,
) -> Result<(), JsonrpcError> {
    value.map_or(Ok(()), |value| require_len(field, value, min, max))
}

/// Bound a list field to `min..=max` entries and require every entry to be
/// non-empty — the twin of `array(pipe(string, min_length(1)))` bounded to `m..=n` entries.
///
/// # Errors
///
/// [`invalid_params`] (-32602) on an out-of-range count or an empty entry.
pub(super) fn require_nonempty_entries(
    field: &str,
    entries: &[String],
    min: usize,
    max: usize,
) -> Result<(), JsonrpcError> {
    if !(min..=max).contains(&entries.len()) {
        return Err(invalid_params(
            &format!(
                "invalid params: {field} must have {min}-{max} entries, got {}",
                entries.len()
            ),
            None,
        ));
    }
    if entries.iter().any(String::is_empty) {
        return Err(invalid_params(
            &format!("invalid params: {field} entries must be non-empty"),
            None,
        ));
    }
    Ok(())
}

/// Bound an integer field to `min..=max`, taken from the raw JSON value so an
/// integral float passes the way the TS `integer` schema passes it.
///
/// The field is `Option<Value>` on the input struct rather than
/// `Option<usize>` on purpose: serde would refuse `50.0` outright, which is
/// *stricter* than the TS twin, and a strictness divergence is a divergence.
///
/// # Errors
///
/// [`invalid_params`] (-32602) when the value is not an integral number, or
/// falls outside the range.
pub(super) fn require_int_range(
    field: &str,
    value: &Value,
    min: usize,
    max: usize,
) -> Result<usize, JsonrpcError> {
    let out_of_range = || {
        invalid_params(
            &format!("invalid params: {field} must be {min}-{max}, got {value}"),
            None,
        )
    };
    // `fuz_http::as_integral_i64` reads the integral-float spellings
    // the TS `integer` schema accepts (`50.0`, `5e1`) alongside a bare `50`
    let integer = as_integral_i64(value).ok_or_else(|| {
        if value.is_number() {
            // an integer that overflowed the `as_integral_i64` guard — still a
            // range failure, not a type failure
            return out_of_range();
        }
        invalid_params(
            &format!("invalid params: {field} must be an integer, got {value}"),
            None,
        )
    })?;
    let Ok(integer) = usize::try_from(integer) else {
        return Err(out_of_range());
    };
    if (min..=max).contains(&integer) {
        return Ok(integer);
    }
    Err(out_of_range())
}

/// Resolve the `id` xor `slug` repo selector, mirroring the `.refine()` on
/// the TS `FuzForgeRepoGetInput` / `FuzForgeRepoMutationInput` (which rejects
/// both-set and neither-set at dispatch). A present `slug` is additionally
/// held to the `RepoSlug` grammar the TS schema applies at the same point.
///
/// # Errors
///
/// [`invalid_params`] (-32602) when both or neither selector is present, or
/// when `slug` is not a valid `org/repo` handle.
pub(super) fn require_repo_selector<'a>(
    id: Option<&'a str>,
    slug: Option<&'a str>,
) -> Result<RepoSelector<'a>, JsonrpcError> {
    match (id, slug) {
        (Some(id), None) => Ok(RepoSelector::Id(id)),
        (None, Some(slug)) => {
            validate_repo_slug(slug)
                .map_err(|msg| invalid_params(&format!("invalid params: slug: {msg}"), None))?;
            Ok(RepoSelector::Slug(slug))
        }
        (Some(_), Some(_)) | (None, None) => Err(invalid_params(
            "invalid params: must provide exactly one of id or slug",
            None,
        )),
    }
}

#[cfg(test)]
mod tests;
