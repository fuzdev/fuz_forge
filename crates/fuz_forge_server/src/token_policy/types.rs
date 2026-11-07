//! The policy **document grammar** — the wire shape both backends read out of
//! `fuz_forge_api_token_policy.policy`.
//!
//! Twin of `src/lib/server/fuz_forge_token_policy_schema.ts`: the schema
//! there and the serde types here describe one JSON document, so the two
//! backends accept and reject the same bytes. Grammar only — nothing here
//! decides whether a capability is allowed ([`super::check`]) or reads a row
//! ([`super::hydrate`]).
//!
//! The literal newtypes ([`WildcardLiteral`], [`TrueLiteral`],
//! [`EmptyQualifiers`], [`PolicyVersion1`]) are how serde spells the TS
//! `literal(...)`: each accepts exactly one JSON value and serializes back to
//! it, so a document that drifts fails to parse rather than round-tripping into
//! a different shape.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Per fuz_app schema: `fuz_forge_api_token_policy` rows cap at 4 KiB
/// serialized to prevent abuse.
pub const MAX_POLICY_BYTES: usize = 4 * 1024;

/// Per-resource allowlist — `'*'` (any resource id) or a per-id map.
///
/// Port of `FuzForgeTokenPolicyResourceMap` in
/// `fuz_forge_token_policy_schema.ts`. The literal `"*"` permits any
/// resource id; otherwise a per-id record allows only listed ids. Each
/// listed value is `true` or an empty `{}` qualifier object — both
/// "allowed, no extra conditions"; the per-key payload reserves space
/// for v2 qualifiers without a schema break.
///
/// `#[serde(untagged)]` so `"*"` deserializes to [`ResourceMap::Wildcard`]
/// and an object to [`ResourceMap::Map`], matching the TS union.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ResourceMap {
    /// Wildcard literal `"*"` — any resource id permitted.
    Wildcard(WildcardLiteral),
    /// Per-id allowlist. Each entry's value is `true` or `{}` (both
    /// "allowed"). Keyed by repo id / filename / RPC method.
    Map(BTreeMap<String, ResourceGrant>),
}

impl ResourceMap {
    /// Does this map allow `id`?
    ///
    /// Port of `resource_map_allows` in `fuz_forge_token_policy.ts`:
    /// `'*'` allows any id; a per-id map allows only listed keys.
    #[must_use]
    pub fn allows(&self, id: &str) -> bool {
        match self {
            Self::Wildcard(_) => true,
            Self::Map(m) => m.contains_key(id),
        }
    }
}

/// A per-id grant value: `true`, or the empty qualifier object `{}`.
///
/// Port of the TS `union([literal(true), object({})])` inside
/// `FuzForgeTokenPolicyResourceMap`. The two spellings are semantically
/// identical in v1 — the object form exists so v2 can add qualifiers (e.g.
/// `{branches: ['main']}`) without a schema break — but the enum keeps them
/// distinct so a stored document round-trips byte-for-byte.
///
/// Modeling the value (rather than accepting any `serde_json::Value`) is what
/// makes both backends refuse the same document: `false`, `1`, `"yes"`,
/// `{"x": 1}`, `[]` and `null` are all outside the grammar, and a policy that
/// carries one fails to parse rather than being read as a grant on one backend
/// and refused on the other.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ResourceGrant {
    /// `true` — allowed, no qualifiers. What the templates write.
    Allowed(TrueLiteral),
    /// `{}` — the canonical empty-qualifier form.
    Qualifiers(EmptyQualifiers),
}

/// The `true` literal.
///
/// Modeled so `serde(untagged)` accepts only that exact boolean — `false` is
/// not a grant value, the grammar being allow-only, so "denied" is expressed
/// by absence. Serializes back to `true`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrueLiteral;

impl Serialize for TrueLiteral {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for TrueLiteral {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("expected the literal `true`"))
        }
    }
}

/// The empty qualifier object `{}`.
///
/// Hand-written rather than a `#[serde(deny_unknown_fields)] struct
/// EmptyQualifiers {}`: a derived empty struct also deserializes from an empty
/// *sequence*, so `[]` would have been read as a grant here and refused by the
/// TS `object({})`. This accepts an empty JSON object and nothing else
/// — `{"branches": [...]}` is a v2 document neither backend reads as a v1
/// grant. Serializes back to `{}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmptyQualifiers;

impl Serialize for EmptyQualifiers {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serde::ser::SerializeMap::end(serializer.serialize_map(Some(0))?)
    }
}

impl<'de> Deserialize<'de> for EmptyQualifiers {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let map = serde_json::Map::<String, serde_json::Value>::deserialize(deserializer)?;
        if map.is_empty() {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(
                "expected the empty qualifier object `{}`",
            ))
        }
    }
}

/// Deserialize an optional grant field that refuses an explicit `null`.
///
/// `#[serde(default)] Option<T>` alone accepts three spellings — absent,
/// `null`, and a value — mapping the first two onto `None`. The TS twin's
/// `.optional()` accepts only two: absent, or a value. So a stored
/// `{"version": 1, "files": null, "forge": {"push": "*"}}` parsed here as
/// "no files section, push granted" while the same row failed the TS schema
/// outright and resolved to the deny-all document. Paired with `default`,
/// this runs only when the key is *present*, and hands the value straight to
/// `T` — which has no `null` in its grammar — so absence stays `None` and an
/// explicit `null` fails the document.
///
/// # Errors
///
/// Returns the deserializer's error when the present value isn't a `T`,
/// `null` included.
fn deserialize_optional_rejecting_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// The `"*"` wildcard literal, modeled so `serde(untagged)` accepts only
/// the exact string. Serializes back to `"*"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WildcardLiteral;

impl Serialize for WildcardLiteral {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str("*")
    }
}

impl<'de> Deserialize<'de> for WildcardLiteral {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        if s == "*" {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("expected wildcard literal \"*\""))
        }
    }
}

/// Forge-section grammar — per-operation per-repo allowlist (`forge.push`,
/// `forge.pull`). Port of `FuzForgeTokenPolicyForge`. Absent (`None`)
/// operation ⇒ denied.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ForgeGrant {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_rejecting_null"
    )]
    pub push: Option<ResourceMap>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_rejecting_null"
    )]
    pub pull: Option<ResourceMap>,
}

/// File-store-section grammar — per-operation per-filename allowlist.
/// Port of `FuzForgeTokenPolicyFiles`. Absent (`None`) operation ⇒
/// denied.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FilesGrant {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_rejecting_null"
    )]
    pub read: Option<ResourceMap>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_rejecting_null"
    )]
    pub write: Option<ResourceMap>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_rejecting_null"
    )]
    pub delete: Option<ResourceMap>,
}

/// The `version` literal `1` — the only policy grammar there is.
///
/// Port of the TS `version: literal(1)`. A `u32` here would have read a
/// stored `{"version": 2}` as a v1 document and enforced its grants under v1
/// rules, where TS refuses it; the unit type refuses it at deserialization on
/// this side too, so a future grammar bump can only be understood by a backend
/// that knows it. Serializes back to `1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyVersion1;

impl PolicyVersion1 {
    /// The numeric form, for the `fuz_forge_api_token_policy.policy_version`
    /// column (the TS insert writes `input.policy.version`).
    #[must_use]
    pub const fn number(self) -> i32 {
        1
    }
}

impl Serialize for PolicyVersion1 {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u32(1)
    }
}

impl<'de> Deserialize<'de> for PolicyVersion1 {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        // Accept the integral-float spelling `1.0` alongside a bare `1`, the
        // same widening `fuz_http::as_integral_i64` applies to RPC number
        // inputs. The two backends read this column
        // through different channels — Rust selects `policy::text` and parses
        // the JSON itself, where `1.0` stays a float, while TS receives the
        // jsonb pre-parsed by the driver, which hands `literal(1)` the JS
        // number `1`. Refusing `1.0` here would be a divergence written into
        // the channel rather than into the grammar.
        let version = value.as_u64().or_else(|| {
            value.as_f64().and_then(|f| {
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "guarded to a finite non-negative integral f64 inside u64 range"
                )]
                if f.is_finite() && f.fract() == 0.0 && (0.0..4.2e9).contains(&f) {
                    Some(f as u64)
                } else {
                    None
                }
            })
        });
        if version == Some(1) {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format!(
                "expected policy version 1, got {value}"
            )))
        }
    }
}

/// The policy a stored document that cannot be read resolves to: a bare
/// `{version: 1}`, which grants nothing.
///
/// A row in `fuz_forge_api_token_policy` says its token is *scoped*, so a
/// document that fails to parse must not fall through to the unscoped
/// (`None`) case — that is the one outcome that would widen the token. Both
/// backends substitute this instead, so an unreadable policy denies every
/// resource-bound capability and lists nothing. Twin of the TS
/// `DENY_ALL_POLICY`.
pub const DENY_ALL_POLICY: FuzForgeTokenPolicy = FuzForgeTokenPolicy {
    version: PolicyVersion1,
    forge: None,
    files: None,
    rpc: None,
};

/// Scoped API token policy document.
///
/// Port of `fuz_forge_token_policy_schema.ts:FuzForgeTokenPolicy`. Strict shape;
/// rejects unknown fields per `deny_unknown_fields`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FuzForgeTokenPolicy {
    pub version: PolicyVersion1,

    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_rejecting_null"
    )]
    pub forge: Option<ForgeGrant>,

    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_rejecting_null"
    )]
    pub files: Option<FilesGrant>,

    /// The RPC methods the mint-time template granted.
    ///
    /// **Record, not gate** — the spine's `api_token.scope` enforces RPC (see
    /// the module docs). This field is the input
    /// `fuz_forge_token_create_scoped` derives that scope from, what
    /// `fuz_forge_token_policy_list` renders, and part of the stored document
    /// shared with the TS forge over the same JSONB column.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_rejecting_null"
    )]
    pub rpc: Option<ResourceMap>,
}
