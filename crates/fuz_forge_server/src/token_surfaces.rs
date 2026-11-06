//! fuz_forge's own non-RPC surface names — the consumer half of token
//! scoping's RPC-only rule.
//!
//! A narrowed api token (`TokenScope::Methods`) may call the RPC methods it
//! names and **reach no non-RPC surface at all**. The spine enforces that over
//! the surfaces the spine mounts ([`fuz_auth::TokenSurface`]); it cannot see a
//! consumer's. So every bearer-reachable surface `fuz_forge` authors names
//! itself here, and the crate's `tests/token_surface_census.rs` asserts the set
//! is exactly these.
//!
//! **Declared constants, not an enum, and that is the spine's own call.**
//! [`fuz_auth::token_scope_surface_denied_response`] takes a
//! [`fuz_auth::SurfaceCapability`] precisely so a consumer crate can emit the
//! canonical flat denial for a surface `TokenSurface` has no variant for — and
//! the newtype holds every one of them to the `surface:<name>` grammar. The
//! name decides nothing — the rule is all-or-nothing, so a capability string
//! only labels *which* surface refused, in the `required_scope` the denial
//! reports.
//!
//! Twin of the TS `src/lib/server/fuz_forge_token_surfaces.ts`, name for name.
//!
//! ## Which axis governs, and why it depends on the token
//!
//! Two per-token controls sit on the same requests:
//!
//! - **The forge policy** ([`crate::token_policy::policy_check`]) — *which
//!   repos, which filenames?* Resource-bound, the vocabulary the spine
//!   deliberately has none for, written by `fuz_forge_token_create_scoped`.
//! - **Token scope** (spine, `api_token.scope`) — all-or-nothing over non-RPC
//!   surfaces, `NOT NULL`, so a bearer credential always has an answer.
//!
//! They are not layers to stack. **A token has exactly one of them as its
//! authority over a forge surface**, and which one depends on how it was
//! minted:
//!
//! - Minted by `fuz_forge_token_create_scoped` → it has a policy row, and the
//!   policy governs. Its spine scope is `Methods` by construction (the file /
//!   forge templates derive `Methods(∅)`, since they grant no RPC), so
//!   consulting the scope here would refuse every token the forge's own
//!   scoped-mint feature exists to issue.
//! - Minted by the spine's `account_token_create` → **no policy row**, and the
//!   scope governs. `policy_check(None, …)` returns `true`, which is that axis
//!   abstaining rather than granting; without the scope consulted, a token
//!   narrowed to a couple of RPC methods reached the file store and git with
//!   full resource authority.
//!
//! [`token_scope_admits_forge_surface`] is that rule, and every forge surface
//! gate goes through it.
//!
//! ## Why these are not spine-style whole-surface refusals
//!
//! Rule 3 is blunt precisely because its surfaces have **no identity a token
//! can name**: nothing mints a token *for* the db-admin browser, which is why
//! the TS backend declares `surface:db_admin` on its re-authed db routes and is
//! right to. The file store and git smart-HTTP are the opposite shape — the
//! forge's policy vocabulary names them (`files.read:<filename>`,
//! `forge.push:<repo_id>`) and its templates mint tokens for them — so a
//! blanket refusal would refuse what the minter deliberately allowed.

use fuz_auth::SurfaceCapability;
use fuz_auth::token_scope::TokenScope;

use crate::token_policy::FuzForgeTokenPolicy;

/// The db-admin table browser (`/api/db/*`).
///
/// Declared by the spine's own `fuz_db_admin` router, which the Rust backend
/// mounts unchanged — so this constant exists for the census to name, not for a
/// call site here.
///
/// *Derived from* [`fuz_auth::TokenSurface::DbAdmin`] rather than spelled
/// alongside it: one surface, one label, whichever backend refused. The two are
/// the same surface, so a literal here would be a second place for its name to
/// live — and the census that reads this constant would go on agreeing with
/// itself while disagreeing with the router that actually denies.
///
/// (The TS backend re-auths the same routes and must declare it itself.)
pub const SURFACE_DB_ADMIN: SurfaceCapability = fuz_auth::TokenSurface::DbAdmin.capability();

/// The file store (`/api/fuz_forge/files/*`) — upload, list, download, delete
/// over the cell + fact substrate.
pub const SURFACE_FILE_STORE: SurfaceCapability = SurfaceCapability::new("surface:file_store");

/// Git smart-HTTP (`/<slug>.git/*`), authenticating an api token as the HTTP
/// Basic password.
///
/// Unlike the two above this name never reaches the wire: the locked-down git
/// posture answers every failure with one generic 401, so nothing enumerates
/// via a distinct denial shape. It labels the refusal in the server log.
pub const SURFACE_GIT_HTTP: SurfaceCapability = SurfaceCapability::new("surface:git_http");

/// Every non-RPC surface `fuz_forge` exposes to a bearer credential.
///
/// The census reconciles this against the live gate sites, so adding a surface
/// without a decision fails the suite rather than shipping ungated.
pub const FUZ_FORGE_TOKEN_SURFACES: &[SurfaceCapability] =
    &[SURFACE_DB_ADMIN, SURFACE_FILE_STORE, SURFACE_GIT_HTTP];

/// May this credential reach a forge surface the resource policy says nothing
/// about?
///
/// The default-deny half of the rule in this module's docs. Returns `true` when
/// a policy row exists — the policy is that token's authority and
/// `policy_check` has already answered — and otherwise falls through to the
/// spine scope, where a narrowed token is refused.
///
/// Session and daemon-token credentials resolve to a `full` scope by
/// construction, so they pass unchanged; so does a grandfathered bearer token,
/// whose backfilled scope is `full`. What newly fails is the case that had no
/// gate at all: a bearer token minted through the spine's
/// `account_token_create` with a narrowed scope and no policy row.
#[must_use]
pub const fn token_scope_admits_forge_surface(
    policy: Option<&FuzForgeTokenPolicy>,
    scope: &TokenScope,
) -> bool {
    policy.is_some() || scope.admits_non_rpc_surface()
}

#[cfg(test)]
mod tests {
    //! Driven by the shared table
    //! `src/test/fixtures/parity/token_surfaces.json`, which the TS twin
    //! (`src/test/server/fuz_forge_token_surfaces.test.ts`) asserts too.

    use serde_json::{Map, Value};

    use super::{FuzForgeTokenPolicy, TokenScope, token_scope_admits_forge_surface};
    use crate::token_policy::{FuzForgeTokenTemplate, TemplateResources, policy_from_template};

    const TOKEN_SURFACES_FIXTURE: &str =
        include_str!("../../../src/test/fixtures/parity/token_surfaces.json");

    /// [`crate::parity::parity_rows`] with the `ts_only` rows this side cannot
    /// express dropped.
    fn parity_rows(raw: &str, table: &str) -> Vec<Map<String, Value>> {
        crate::parity::parity_rows(raw, table)
            .into_iter()
            .filter(|row| row.get("ts_only") != Some(&Value::Bool(true)))
            .collect()
    }

    /// The policy row a template mints, refusing the `admin` template's `None`.
    ///
    /// Built from a real template rather than hand-rolled, so these cases break
    /// if the templates stop producing a policy at all — which is the input this
    /// rule keys off. `admin` is the one template that yields `None`, and a
    /// token minted from it is the *no policy row* case the fixture spells as a
    /// `null` policy.
    fn files_read_policy() -> FuzForgeTokenPolicy {
        policy_from_template(&FuzForgeTokenTemplate::FilesRead(TemplateResources::List(
            vec!["tools/fuz.tar.gz".to_owned()],
        )))
        .expect("files_read mints a policy row")
    }

    /// The fixture's `scope` field, resolved to the value the rule takes.
    fn scope_of(scope: &Value) -> TokenScope {
        match scope["kind"].as_str() {
            Some("full") => TokenScope::Full,
            Some("methods") => TokenScope::Methods(
                scope["methods"]
                    .as_array()
                    .expect("methods is a list")
                    .iter()
                    .map(|m| m.as_str().expect("a method name").to_owned())
                    .collect(),
            ),
            other => panic!("unknown parity scope {other:?}"),
        }
    }

    /// The axis-selection rule, asserted against
    /// `src/test/fixtures/parity/token_surfaces.json` — the TS twin's
    /// `token_scope_admits_forge_surface` suite reads the same rows.
    ///
    /// The case that matters most is the one that reads like a tautology —
    /// `(None, Methods) == false`. Without this rule the answer is `true`,
    /// arrived at by never asking: `policy_check(None, …)` returns `true` for
    /// a token with no policy row, and nothing would distinguish *that axis
    /// abstaining* from *the request being granted*. The mirror case is the one a blanket
    /// whole-surface refusal got wrong: every token
    /// `fuz_forge_token_create_scoped` issues from the file / forge templates
    /// carries a `Methods(∅)` spine scope, so consulting the scope for such a
    /// token refuses the whole feature.
    ///
    /// The fixture's `ts_only` rows are the two an absent credential produces
    /// and the grandfathered full scope — neither is representable in this
    /// [`TokenScope`], which is an enum with no flag and no absent variant.
    #[test]
    fn token_scope_admits_forge_surface_matches_the_shared_table() {
        for row in parity_rows(TOKEN_SURFACES_FIXTURE, "cases") {
            let policy = match row["policy"].as_str() {
                None => None,
                Some("files_read") => Some(files_read_policy()),
                Some(other) => panic!("unknown parity policy {other}"),
            };
            let scope = scope_of(&row["scope"]);
            assert_eq!(
                token_scope_admits_forge_surface(policy.as_ref(), &scope),
                row["accepted"].as_bool().expect("a bool"),
                "policy {:?}, scope {:?}",
                row["policy"],
                row["scope"],
            );
        }
    }

    /// The rule is all-or-nothing on the scope axis, and the fixture's
    /// `surface:file_store` row is what pins it: the `methods` list is a
    /// *method* allowlist, so a token cannot talk its way onto a surface by
    /// naming it. Guards the upstream asymmetry between the spine's two
    /// accessors: [`TokenScope::admits_method`] consults the allowlist,
    /// [`TokenScope::admits_non_rpc_surface`] never does.
    #[test]
    fn the_surface_name_is_not_a_method_name() {
        assert!(
            parity_rows(TOKEN_SURFACES_FIXTURE, "cases")
                .iter()
                .any(|row| row["scope"]["methods"]
                    .as_array()
                    .is_some_and(|methods| methods
                        .iter()
                        .any(|m| m.as_str() == Some(super::SURFACE_FILE_STORE.as_str())))),
            "the shared table must carry the surface-name row",
        );
    }
}
