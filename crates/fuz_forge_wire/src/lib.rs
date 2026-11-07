//! Single-sourced forge wire types — the validators, the JSON-RPC output DTOs,
//! and the file-store REST bodies.
//!
//! This module owns the string grammars. The canonical `RepoSlug`
//! (`<segment>/<segment>`) and the canonical repo cell-id
//! ([`is_valid_repo_id`]) are held to parity with the TS schemas in
//! `src/lib/fuz_forge/repo/repo_id.ts` (`RepoSlug`, `RepoId`) — the slug
//! grammar called from both the `fuzf` client and the `fuzfd` server, the id
//! validator from the server's ingresses. [`looks_like_uuid`] is the client's
//! own disambiguator and has no TS twin, deliberately (see below).
//!
//! [`output`] owns the other half — the serde DTOs for the JSON-RPC success
//! bodies and for the file-store REST bodies under `/api/fuz_forge/files`. The
//! `fuzfd` server constructs all of them; the `fuzf` client deserializes the
//! subset backing its own commands. The serialization invariants, the parity
//! guards, and that server/client split are stated once, in that module's doc.
//!
//! Pure string + serde logic; no spine dependency.
//!
//! A repo's stable machine key is its cell `id` (a UUID), which is also the
//! wire/dir/URL handle; the human identity is the `org/repo` slug. They
//! disambiguate structurally: a UUID has no `/`, a slug has exactly one.
//!
//! Two UUID functions on purpose, with different jobs:
//!
//! - [`is_valid_repo_id`] is the *validator* — the one wire grammar a repo
//!   `id` must satisfy, enforced by every server ingress on both backends.
//! - [`looks_like_uuid`] is the *disambiguator* — a deliberately looser
//!   shape check the CLI's `<id-or-slug>` argument uses to pick which
//!   lookup to perform. It must stay loose: its job is routing, and the
//!   server's validator is the authority on what an id may be. Do not
//!   "unify" them.

use thiserror::Error;

pub mod output;

/// Min length for one slug segment. Single-char names are permitted (math
/// notation, scratch buckets, short codenames).
pub const REPO_SEGMENT_LENGTH_MIN: usize = 1;

/// Max length for one slug segment.
pub const REPO_SEGMENT_LENGTH_MAX: usize = 64;

/// Error validating an `org/repo` `RepoSlug`.
///
/// Carries the offending input so callers can surface it in a user-facing
/// message; the `Display` form is the canonical single-line description shared
/// by every backend.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error(
    "invalid slug: {0} (expected <segment>/<segment> with exactly one `/`; each segment is 1-64 chars of [a-zA-Z0-9] with optional single `-`/`_` between alphanumerics)"
)]
pub struct RepoSlugError(pub String);

/// Validate one slug segment against the canonical grammar + length bound.
///
/// Matches `[a-zA-Z0-9](?:[a-zA-Z0-9]|[_-][a-zA-Z0-9])*` within 1..=64 chars:
/// ASCII, starts and ends alphanumeric, single `-`/`_` separators only between
/// alphanumerics (no consecutive or edge separators). The canonical building
/// block — `validate_repo_slug` and the git-auth slug gate both compose it.
#[must_use]
pub fn is_valid_repo_segment(seg: &str) -> bool {
    if !seg.is_ascii() {
        return false;
    }
    let bytes = seg.as_bytes();
    let len = bytes.len();
    if !(REPO_SEGMENT_LENGTH_MIN..=REPO_SEGMENT_LENGTH_MAX).contains(&len) {
        return false;
    }
    if !bytes[0].is_ascii_alphanumeric() || !bytes[len - 1].is_ascii_alphanumeric() {
        return false;
    }
    // A 1-char segment has no interior to scan (and `bytes[1..len - 1]` would
    // underflow when `len == 1`).
    if len >= 2 {
        let mut prev_sep = false;
        for &b in &bytes[1..len - 1] {
            if b.is_ascii_alphanumeric() {
                prev_sep = false;
            } else if b == b'-' || b == b'_' {
                if prev_sep {
                    return false;
                }
                prev_sep = true;
            } else {
                return false;
            }
        }
    }
    true
}

/// Validate + lowercase-canonicalize an `org/repo` `RepoSlug`: exactly two
/// `/`-separated segments, each a valid [`is_valid_repo_segment`]. Returns the
/// lowercased canonical slug on success.
///
/// # Errors
///
/// Returns [`RepoSlugError`] (carrying the original input) when the input is
/// not exactly two valid segments.
pub fn validate_repo_slug(input: &str) -> Result<String, RepoSlugError> {
    let mut parts = input.split('/');
    let (Some(org), Some(repo), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(RepoSlugError(input.to_owned()));
    };
    if is_valid_repo_segment(org) && is_valid_repo_segment(repo) {
        Ok(input.to_lowercase())
    } else {
        Err(RepoSlugError(input.to_owned()))
    }
}

/// Whether `s` is a valid repo cell-id — the canonical wire grammar for a
/// forge repo `id`, shared by every server ingress on both backends.
///
/// Twin of the TS `RepoId` schema (`fuz_schema`'s `uuid`, the grammar of
/// `fuz_app`'s `Uuid`, in `src/lib/fuz_forge/repo/repo_id.ts`), mirroring its
/// grammar exactly so the two backends accept and reject the same strings:
/// hyphenated 8-4-4-4-12 hex (case-insensitive) with the RFC 9562 version
/// nibble in `1..=8` and the variant nibble in `[89abAB]`, plus the two
/// special values admitted alongside the versioned grammar — nil (all zeros)
/// and max (all `f`s, in any case, as RFC 9562 §4 reads a UUID
/// case-insensitively). Non-hyphenated, braced, and URN forms are rejected — Postgres and
/// Rust's `Uuid::parse_str` would accept them, the TS backend would not.
///
/// Every real repo cell id is a Postgres `gen_random_uuid()` v4, so the
/// strictness rejects nothing a legitimate flow produces; it exists so both
/// backends refuse the same synthetic input with the same error.
///
/// Not [`looks_like_uuid`] — that is the CLI's slug-vs-id disambiguator and
/// deliberately looser (see the module doc).
///
/// The spine carries the same grammar as `fuz_http`'s `is_valid_uuid`,
/// guarding every UUID it decodes off the wire, and `fuz_app`'s `Uuid` and
/// `fuz_schema`'s `uuid` carry it on the TS side: one UUID grammar across the
/// stack. This crate is spine-free by design and so cannot call
/// `is_valid_uuid`. The two are **behaviorally** identical, not textually —
/// this one delegates its shape check to [`looks_like_uuid`], which the spine
/// has no use for — and their test tables carry the same grammar rows plus
/// each side's own domain negatives (a repo slug here, a fixture trap there).
/// Change the grammar in one, change it in both.
#[must_use]
pub fn is_valid_repo_id(s: &str) -> bool {
    if !looks_like_uuid(s) {
        return false;
    }
    let bytes = s.as_bytes();
    if matches!(bytes[14], b'1'..=b'8')
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
    {
        return true;
    }
    // Shape is already pinned (36 chars, dashes at 8/13/18/23, hex
    // elsewhere), so "every byte is `0` or `-`" is exactly the nil UUID and
    // "every byte is `f`, `F` or `-`" exactly the max UUID, in any case.
    bytes.iter().all(|&b| b == b'0' || b == b'-')
        || bytes.iter().all(|&b| matches!(b, b'f' | b'F' | b'-'))
}

/// Whether `s` is a canonical 8-4-4-4-12 hex UUID string.
///
/// A *disambiguator*, not a validator: the CLI's `<id-or-slug>` argument
/// uses it to decide which lookup to perform, so it stays deliberately
/// looser than [`is_valid_repo_id`] — tightening it would make the CLI
/// refuse to even ask the server, whose validator is the authority.
#[must_use]
pub fn looks_like_uuid(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(i, &c)| match i {
        8 | 13 | 18 | 23 => c == b'-',
        _ => c.is_ascii_hexdigit(),
    })
}

#[cfg(test)]
mod tests {
    //! Crate-local vectors, deliberately not fixture-driven: this crate is
    //! spine-free and relocatable by design, so it carries no `include_str!`
    //! reaching outside its own root. The cross-language tables for these two
    //! grammars are `src/test/fixtures/parity/repo_slug.json` and
    //! `…/repo_id.json`, asserted by the TS schemas and by every Rust consumer
    //! of this crate (`fuz_forge_server`'s `handlers::repo_id` and
    //! `forge_git::auth`, the `fuzf` client's `repo_id`).

    use super::*;

    #[test]
    fn valid_slugs() {
        assert_eq!(
            validate_repo_slug("fuzdev/fuz_app").unwrap(),
            "fuzdev/fuz_app"
        );
        assert_eq!(validate_repo_slug("a/b").unwrap(), "a/b");
        assert!(validate_repo_slug("someone/some-analysis").is_ok());
        assert!(validate_repo_slug("org_1/repo-2").is_ok());
    }

    #[test]
    fn validate_repo_slug_folds_to_lowercase() {
        // Repo slugs are case-insensitive (canonical lowercase): a mixed-case
        // input validates and canonicalizes to lowercase, so the create-side
        // (and every slug lookup) keys off the same lowercase path.
        assert_eq!(validate_repo_slug("MyOrg/MyRepo").unwrap(), "myorg/myrepo");
        assert_eq!(validate_repo_slug("Org/Repo").unwrap(), "org/repo");
        // Already-lowercase is a no-op; uppercased halves both fold.
        assert_eq!(validate_repo_slug("foo/bar").unwrap(), "foo/bar");
        assert_eq!(validate_repo_slug("FOO/BAR").unwrap(), "foo/bar");
    }

    #[test]
    fn invalid_slugs() {
        assert!(validate_repo_slug("noslash").is_err()); // single segment
        assert!(validate_repo_slug("foobar").is_err());
        assert!(validate_repo_slug("too/many/slashes").is_err()); // three segments
        assert!(validate_repo_slug("foo/bar/baz").is_err());
        assert!(validate_repo_slug("-lead/repo").is_err());
        assert!(validate_repo_slug("trail-/repo").is_err());
        assert!(validate_repo_slug("a--b/repo").is_err());
        assert!(validate_repo_slug("/repo").is_err());
        assert!(validate_repo_slug("org/").is_err());
        assert!(validate_repo_slug("../etc").is_err()); // traversal
        assert!(validate_repo_slug("foo.bar/baz").is_err()); // `.` not in charset
    }

    #[test]
    fn rejects_segment_over_max_length() {
        // The per-segment cap is the canonicalization this crate single-sources:
        // 64 chars is the boundary, 65 is rejected.
        let seg_64 = "a".repeat(REPO_SEGMENT_LENGTH_MAX);
        let seg_65 = "a".repeat(REPO_SEGMENT_LENGTH_MAX + 1);
        assert!(is_valid_repo_segment(&seg_64));
        assert!(!is_valid_repo_segment(&seg_65));
        assert!(validate_repo_slug(&format!("{seg_64}/ok")).is_ok());
        assert!(validate_repo_slug(&format!("{seg_65}/ok")).is_err());
        assert!(validate_repo_slug(&format!("ok/{seg_65}")).is_err());
    }

    #[test]
    fn segment_validity_edge_cases() {
        assert!(is_valid_repo_segment("a"));
        assert!(is_valid_repo_segment("foo"));
        assert!(is_valid_repo_segment("org_1"));
        assert!(is_valid_repo_segment("repo-2"));
        assert!(!is_valid_repo_segment("")); // empty
        assert!(!is_valid_repo_segment("-lead"));
        assert!(!is_valid_repo_segment("trail-"));
        assert!(!is_valid_repo_segment("a--b"));
        assert!(!is_valid_repo_segment("foo.bar")); // `.` not in charset
        assert!(!is_valid_repo_segment(".."));
    }

    #[test]
    fn uuid_detection() {
        assert!(looks_like_uuid("3f8a1c2e-1234-4abc-9def-0123456789ab"));
        assert!(!looks_like_uuid("fuzdev/fuz_app"));
        assert!(!looks_like_uuid("not-a-uuid"));
        assert!(!looks_like_uuid("3f8a1c2e12344abc9def0123456789ab"));
    }

    /// Crate-local vectors. The cross-language table lives in
    /// `src/test/fixtures/parity/repo_id.json`, which the TS `RepoId` schema
    /// suite and `fuz_forge_server`'s `handlers::repo_id` both assert against;
    /// this crate stays self-contained (no `include_str!` outside its own root)
    /// so it remains relocatable, and keeps its own vectors for the grammar it
    /// owns. The spine's `fuz_http::params` `is_valid_uuid` tests
    /// carry the same grammar rows for the same grammar, each keeping its own
    /// domain negatives besides.
    #[test]
    fn repo_id_accepts_rfc_uuids() {
        // Postgres gen_random_uuid() v4 — the only shape real ids take.
        assert!(is_valid_repo_id("3f8a1c2e-1234-4abc-9def-0123456789ab"));
        // Hex is case-insensitive in the versioned grammar.
        assert!(is_valid_repo_id("3F8A1C2E-1234-4ABC-9DEF-0123456789AB"));
        // Every RFC 9562 version nibble 1..=8 is admitted, not just v4.
        assert!(is_valid_repo_id("3f8a1c2e-1234-1abc-9def-0123456789ab"));
        assert!(is_valid_repo_id("3f8a1c2e-1234-8abc-9def-0123456789ab"));
        // All four variant nibbles, either case.
        assert!(is_valid_repo_id("3f8a1c2e-1234-4abc-8def-0123456789ab"));
        assert!(is_valid_repo_id("3f8a1c2e-1234-4abc-Bdef-0123456789ab"));
    }

    #[test]
    fn repo_id_accepts_nil_and_max_in_any_case() {
        assert!(is_valid_repo_id("00000000-0000-0000-0000-000000000000"));
        assert!(is_valid_repo_id("ffffffff-ffff-ffff-ffff-ffffffffffff"));
        // The max alternative takes either case, as the spine's
        // `is_valid_uuid` does (RFC 9562 §4), mixed case included.
        assert!(is_valid_repo_id("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"));
        assert!(is_valid_repo_id("ffffffff-FFFF-ffff-FFFF-ffffffffffff"));
        // One digit off the max is a versioned UUID with version nibble `f`.
        assert!(!is_valid_repo_id("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFE"));
    }

    #[test]
    fn repo_id_rejects_bad_nibbles() {
        // Version nibble 0 — the synthetic near-nil id that exposed the
        // grammar split (`Uuid::parse_str` accepted it, the TS grammar did not).
        assert!(!is_valid_repo_id("00000000-0000-0000-0000-000000000001"));
        // The all-ones id every hand-written fixture reaches for is itself
        // rejected: version nibble `1` is fine, variant nibble `1` is not.
        assert!(!is_valid_repo_id("11111111-1111-1111-1111-111111111111"));
        // Version nibble 9 and hex-but-not-version nibbles.
        assert!(!is_valid_repo_id("3f8a1c2e-1234-9abc-9def-0123456789ab"));
        assert!(!is_valid_repo_id("3f8a1c2e-1234-fabc-9def-0123456789ab"));
        // Variant nibble outside [89abAB].
        assert!(!is_valid_repo_id("3f8a1c2e-1234-4abc-1def-0123456789ab"));
        assert!(!is_valid_repo_id("3f8a1c2e-1234-4abc-cdef-0123456789ab"));
    }

    #[test]
    fn repo_id_rejects_non_hyphenated_forms() {
        // `Uuid::parse_str` (and Postgres) accept all of these; the wire
        // grammar does not — the TS backend never did.
        assert!(!is_valid_repo_id("3f8a1c2e12344abc9def0123456789ab"));
        assert!(!is_valid_repo_id("{3f8a1c2e-1234-4abc-9def-0123456789ab}"));
        assert!(!is_valid_repo_id(
            "urn:uuid:3f8a1c2e-1234-4abc-9def-0123456789ab"
        ));
        assert!(!is_valid_repo_id("fuzdev/fuz_app"));
        assert!(!is_valid_repo_id("not-a-uuid"));
        assert!(!is_valid_repo_id(""));
    }

    /// The validator is a strict subset of the disambiguator: every valid
    /// repo id looks like a UUID, so the CLI always routes a valid id to the
    /// id lookup. The reverse is deliberately false.
    #[test]
    fn repo_id_is_subset_of_looks_like_uuid() {
        for id in [
            "3f8a1c2e-1234-4abc-9def-0123456789ab",
            "00000000-0000-0000-0000-000000000000",
            "ffffffff-ffff-ffff-ffff-ffffffffffff",
            "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
        ] {
            assert!(is_valid_repo_id(id) && looks_like_uuid(id));
        }
        // Loose-passing, strict-failing: the CLI forwards these and the
        // server's validator answers.
        assert!(looks_like_uuid("00000000-0000-0000-0000-000000000001"));
        assert!(!is_valid_repo_id("00000000-0000-0000-0000-000000000001"));
    }
}
