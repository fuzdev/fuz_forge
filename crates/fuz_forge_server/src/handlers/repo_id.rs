//! Repo slug + segment validators.
//!
//! Thin adapter over the single-sourced [`fuz_forge_wire`] validators: the
//! canonical `org/repo` slug shape and its per-segment grammar.
//! [`validate_repo_slug`] adapts the wire crate's typed error into the
//! per-reason `Result<String, String>` strings the create handler surfaces —
//! the `fuz_forge_repo_create` RPC's `validation_error` wire shape.

use fuz_forge_wire::{
    REPO_SEGMENT_LENGTH_MAX, is_valid_repo_segment, validate_repo_slug as wire_validate_repo_slug,
};

/// Validate + lowercase-canonicalize a `RepoSlug` (`org/repo`). Delegates the
/// grammar + 1..=64 per-segment check to [`fuz_forge_wire::validate_repo_slug`],
/// then derives the per-reason error strings the create handler surfaces
/// through `validation_error` — the wire error envelope both backends emit.
pub(super) fn validate_repo_slug(input: &str) -> Result<String, String> {
    if let Ok(slug) = wire_validate_repo_slug(input) {
        return Ok(slug);
    }
    // Derive the reason on the (rare) error path: the wire validator has
    // already rejected, and this reproduces the per-reason message the create
    // RPC's `validation_error` carries.
    let slug = input.to_lowercase();
    let mut parts = slug.split('/');
    let (Some(org), Some(repo), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err("slug must be exactly `org/repo`".into());
    };
    for segment in [org, repo] {
        if segment.len() > REPO_SEGMENT_LENGTH_MAX {
            return Err(format!("segment too long (max 64): {segment}"));
        }
        if !is_valid_repo_segment(segment) {
            return Err(format!("invalid segment: {segment}"));
        }
    }
    // Unreachable: the wire validator and this re-derivation agree on validity.
    Err(format!("invalid segment: {slug}"))
}

#[cfg(test)]
mod tests {
    use fuz_forge_wire::is_valid_repo_id;

    use super::*;
    use crate::parity::{field, flag, parity_rows};

    const REPO_ID_FIXTURE: &str = include_str!("../../../../src/test/fixtures/parity/repo_id.json");
    const REPO_SLUG_FIXTURE: &str =
        include_str!("../../../../src/test/fixtures/parity/repo_slug.json");

    /// The one repo-id wire grammar, asserted against
    /// `src/test/fixtures/parity/repo_id.json` — the TS twin's `RepoId schema`
    /// suite reads the same rows. The wire crate's own `mod tests` keeps its
    /// hand-written vectors so the crate stays self-contained and relocatable;
    /// this is the fixture-driven consumer.
    #[test]
    fn repo_id_matches_the_shared_grammar() {
        for row in parity_rows(REPO_ID_FIXTURE, "ids") {
            let input = field(&row, "input");
            assert_eq!(is_valid_repo_id(input), flag(&row, "accepted"), "{input:?}");
        }
    }

    /// The `org/repo` grammar and its lowercase canonicalization, asserted
    /// against `src/test/fixtures/parity/repo_slug.json` — the TS twin's
    /// `RepoSlug schema` suite, `forge_git::auth`'s validity gate and the
    /// `fuzf` client's `parse_slug` all read the same rows.
    #[test]
    fn validate_repo_slug_matches_the_shared_grammar() {
        for row in parity_rows(REPO_SLUG_FIXTURE, "slugs") {
            let input = field(&row, "input");
            if flag(&row, "accepted") {
                assert_eq!(
                    validate_repo_slug(input),
                    Ok(field(&row, "canonical").to_owned()),
                    "{input:?}",
                );
            } else {
                assert!(validate_repo_slug(input).is_err(), "{input:?}");
            }
        }
    }

    /// The per-segment cap the wire crate single-sources, read off the same
    /// fixture the TS segment `check` is.
    #[test]
    fn repo_segment_length_max_matches_the_ts_twin() {
        for row in parity_rows(REPO_SLUG_FIXTURE, "constants") {
            assert_eq!(field(&row, "name"), "REPO_SEGMENT_LENGTH_MAX");
            assert_eq!(row["value"], REPO_SEGMENT_LENGTH_MAX);
        }
    }

    #[test]
    fn validate_repo_slug_preserves_reason_strings() {
        // The create RPC surfaces these through `validation_error`, so the
        // observable wire shape is unchanged. Rust-only: the TS dispatcher
        // flattens an input-schema failure to a bare `invalid params`.
        assert_eq!(
            validate_repo_slug("foobar"),
            Err("slug must be exactly `org/repo`".to_owned()),
        );
        let long = "a".repeat(REPO_SEGMENT_LENGTH_MAX + 1);
        assert_eq!(
            validate_repo_slug(&format!("{long}/repo")),
            Err(format!("segment too long (max 64): {long}")),
        );
        assert_eq!(
            validate_repo_slug("a--b/repo"),
            Err("invalid segment: a--b".to_owned()),
        );
    }
}
