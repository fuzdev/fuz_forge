//! Repo identity primitives — the `<id-or-slug>` lookup shape and CLI-facing
//! parse helpers.
//!
//! The slug grammar + UUID detection are single-sourced in [`fuz_forge_wire`]
//! (shared verbatim with the `fuzfd` server's create + git-auth paths); this
//! module wraps them in the CLI's [`RepoLookup`] / [`RepoIdError`] surface. A
//! repo's stable machine key is its cell `id` (a UUID), which is also the
//! wire/dir/URL handle; the human identity is the `org/repo` slug. They
//! disambiguate structurally: a UUID has no `/`, a slug has exactly one.

use fuz_forge_wire::{RepoSlugError, looks_like_uuid, validate_repo_slug};
use serde_json::{Value, json};
use thiserror::Error;

/// A repo lookup target — exactly one of the cell-id UUID or the `org/repo`
/// slug. Serializes as the `fuz_forge_repo_get` (and friends) params shape.
#[derive(Debug, Clone)]
pub enum RepoLookup {
    /// Cell-id UUID handle.
    Id(String),
    /// `org/repo` clone handle (lowercase-canonical).
    Slug(String),
}

/// Errors parsing an `<id-or-slug>` argument.
#[derive(Debug, Error)]
pub enum RepoIdError {
    /// Input contains `/` but isn't a valid `org/repo` slug; renders the wire
    /// grammar's own message.
    #[error(transparent)]
    InvalidSlug(#[from] RepoSlugError),

    /// Input has no `/` but isn't a valid UUID.
    #[error("invalid repo id: {0} (expected a UUID or an org/repo slug)")]
    InvalidId(String),
}

/// Parse + lowercase-canonicalize an `org/repo` slug. Delegates the grammar +
/// per-segment length check to [`fuz_forge_wire::validate_repo_slug`], wrapping
/// its error in the CLI's [`RepoIdError::InvalidSlug`].
///
/// # Errors
///
/// Returns [`RepoIdError::InvalidSlug`] when `input` is not a valid `org/repo`
/// slug.
pub fn parse_slug(input: &str) -> Result<String, RepoIdError> {
    Ok(validate_repo_slug(input)?)
}

/// Disambiguate an `<id-or-slug>` CLI argument: a `/` makes it a slug, else a
/// UUID id. Pure — the structural `/` check needs no RPC roundtrip.
///
/// Uses the deliberately loose [`looks_like_uuid`] shape check, not the
/// strict `fuz_forge_wire::is_valid_repo_id` wire grammar: this function's
/// job is picking which lookup to perform, and the server is the authority
/// on validity — a loose-passing, strict-failing id is forwarded and comes
/// back as the server's own invalid-params error rather than being refused
/// client-side.
///
/// # Errors
///
/// Returns [`RepoIdError::InvalidSlug`] for a `/`-bearing non-slug, or
/// [`RepoIdError::InvalidId`] for a slash-free non-UUID.
pub fn resolve_repo_id_or_slug(input: &str) -> Result<RepoLookup, RepoIdError> {
    if input.contains('/') {
        Ok(RepoLookup::Slug(parse_slug(input)?))
    } else if looks_like_uuid(input) {
        Ok(RepoLookup::Id(input.to_string()))
    } else {
        Err(RepoIdError::InvalidId(input.to_string()))
    }
}

/// Build the `{id}` xor `{slug}` params object an id-xor-slug RPC accepts
/// (`fuz_forge_repo_get` and friends). Lives beside `RepoLookup` since it's a
/// pure projection onto the wire shape, with no client state.
pub fn lookup_params(lookup: &RepoLookup) -> Value {
    match lookup {
        RepoLookup::Id(id) => json!({"id": id}),
        RepoLookup::Slug(slug) => json!({"slug": slug}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPO_SLUG_FIXTURE: &str =
        include_str!("../../../src/test/fixtures/parity/repo_slug.json");

    /// Rows of one shared parity fixture table, with the envelope's declared
    /// row count asserted. Twin: `src/test/fixtures/parity/load.ts`.
    fn parity_rows(raw: &str, table: &str) -> Vec<serde_json::Map<String, Value>> {
        let fixture: Value = serde_json::from_str(raw).expect("parity fixture parses");
        let rows: Vec<serde_json::Map<String, Value>> =
            serde_json::from_value(fixture["tables"][table].clone()).expect("parity table");
        assert!(!rows.is_empty(), "parity table {table} is empty");
        assert_eq!(fixture["counts"][table], rows.len(), "parity table {table}");
        rows
    }

    /// The client's `<id-or-slug>` slug half, asserted against
    /// `src/test/fixtures/parity/repo_slug.json` — the same rows the server's
    /// create path and git-auth gate read, so the CLI refuses exactly what the
    /// server would and canonicalizes it the same way.
    #[test]
    fn slugs_match_the_shared_grammar() {
        for row in parity_rows(REPO_SLUG_FIXTURE, "slugs") {
            let input = row["input"].as_str().expect("an input");
            if row["accepted"].as_bool().expect("a bool") {
                let canonical = row["canonical"].as_str().expect("a canonical form");
                assert_eq!(parse_slug(input).expect("accepted"), canonical, "{input:?}");
            } else {
                assert!(parse_slug(input).is_err(), "{input:?}");
            }
        }
    }

    #[test]
    fn id_or_slug_disambiguation() {
        assert!(matches!(
            resolve_repo_id_or_slug("fuzdev/fuz_app").unwrap(),
            RepoLookup::Slug(s) if s == "fuzdev/fuz_app"
        ));
        assert!(matches!(
            resolve_repo_id_or_slug("3f8a1c2e-1234-4abc-9def-0123456789ab").unwrap(),
            RepoLookup::Id(_)
        ));
        assert!(resolve_repo_id_or_slug("bare_name").is_err());
    }

    /// A refused slug renders the wire grammar's message unwrapped, its length
    /// bound included.
    #[test]
    fn invalid_slug_renders_the_wire_message() {
        let err = parse_slug("a/").unwrap_err();
        assert_eq!(err.to_string(), RepoSlugError("a/".to_string()).to_string());
        assert!(err.to_string().contains("1-64 chars of"), "{err}");
    }
}
