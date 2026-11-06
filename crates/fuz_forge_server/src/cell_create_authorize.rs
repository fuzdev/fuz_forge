//! The forge's [`fuz_cell_actions::CellCreateAuthorize`]: the cell kinds the
//! forge's own routes trust are the global admin's to create.
//!
//! Twin of `src/lib/server/fuz_forge_cell_create_authorize.ts`.
//!
//! The forge mounts the spine's generic cell layer beside its own surfaces, and
//! two of those surfaces read cells by `kind`: a `repo` cell carries the hook
//! secret digest the `/internal/*` callbacks compare against, and a `file` cell
//! is a file-store entry. The cell layer reserves no kinds, so without this
//! authorizer any account could `cell_create` (or `cell_clone`) a cell of
//! either kind carrying data of its choosing. [`RESERVED_CELL_KINDS`] are
//! refused to everyone but a global admin, with the spine's 403
//! `cell_create_forbidden`; every other kind is admitted.
//!
//! The forge's own writers — `fuz_forge_repo_create` and the file-store upload
//! — write their cells directly, not through `cell_create`, so this gates only
//! the generic verbs. `cell_clone` asks the authorizer as a parentless create
//! of the source's kind, so it is no side door.
//!
//! Mounting an authorizer moves one other answer: a contribution (a create
//! under a parent) is born `moderation = 'approved'`, not the `null` of the
//! spine's open create, since [`Verdict::Allow`] always carries a moderation
//! outcome. The trait's default `validate_policy` keeps every root
//! `policy` write refused `cell_policy_unsupported`, as with no authorizer.

use futures::future::BoxFuture;
use fuz_auth::{ROLE_ADMIN, RequestActorContext};
use fuz_cell_actions::{CellCreateAuthorize, CellCreateAuthorizeInput, Verdict};
use fuz_db::ActionDb;
use fuz_http::JsonrpcError;

/// The cell kinds only a global admin may create through the generic verbs.
///
/// `repo` is a hosted repo, whose `data` holds the hook secret digest; `file`
/// is a file-store entry. Twin of the TS `RESERVED_CELL_KINDS`.
pub const RESERVED_CELL_KINDS: [&str; 2] = ["repo", "file"];

/// Whether a create of `kind` is admitted: always for a global admin, and for
/// anyone else unless `kind` is one of [`RESERVED_CELL_KINDS`]. A typeless
/// cell (`None`) is never reserved.
///
/// Asserted against `src/test/fixtures/parity/cell_create_reserved_kinds.json`,
/// which the TS twin's `cell_create_admits` reads too.
#[must_use]
pub fn cell_create_admits(kind: Option<&str>, is_admin: bool) -> bool {
    is_admin || kind.is_none_or(|kind| !RESERVED_CELL_KINDS.contains(&kind))
}

/// The forge's create authorizer — [`cell_create_admits`] over the caller's
/// global `admin` grant. Pure: it reads nothing but its input.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReservedKindCreateAuthorize;

impl ReservedKindCreateAuthorize {
    /// The verdict for `auth` creating a cell of `kind`: [`cell_create_admits`]
    /// over a **global** `admin` grant (a scoped one confers nothing), and an
    /// admitted create is never moderated, so a contribution under a parent is
    /// born `moderation = 'approved'`.
    #[must_use]
    pub fn verdict(auth: &RequestActorContext, kind: Option<&str>) -> Verdict {
        if cell_create_admits(kind, auth.has_scoped_role(ROLE_ADMIN, None)) {
            Verdict::Allow {
                moderation_required: false,
            }
        } else {
            Verdict::Deny
        }
    }
}

impl CellCreateAuthorize for ReservedKindCreateAuthorize {
    fn authorize<'a>(
        &'a self,
        auth: &'a RequestActorContext,
        input: &'a CellCreateAuthorizeInput,
        _db: &'a ActionDb<'a>,
    ) -> BoxFuture<'a, Result<Verdict, JsonrpcError>> {
        let verdict = Self::verdict(auth, input.kind.as_deref());
        Box::pin(async move { Ok(verdict) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parity::parity_rows;

    const FIXTURE: &str =
        include_str!("../../../src/test/fixtures/parity/cell_create_reserved_kinds.json");

    #[test]
    fn admits_per_the_shared_table() {
        for row in parity_rows(FIXTURE, "cases") {
            let args = row["args"].as_array().expect("args");
            let kind = args[0].as_str();
            let is_admin = args[1].as_bool().expect("a bool");
            let accepted = row["accepted"].as_bool().expect("a bool");
            assert_eq!(
                cell_create_admits(kind, is_admin),
                accepted,
                "kind {kind:?}, admin {is_admin}"
            );
        }
    }

    /// A context holding one grant of `role` per entry, at `scope`.
    fn context(grants: &[(&str, Option<uuid::Uuid>)]) -> RequestActorContext {
        RequestActorContext {
            account: fuz_auth::AccountRow {
                id: uuid::Uuid::nil(),
                username: "u".to_owned(),
            },
            actor: fuz_auth::ActorRow {
                id: uuid::Uuid::nil(),
                account_id: uuid::Uuid::nil(),
                name: "a".to_owned(),
            },
            role_grants: grants
                .iter()
                .map(|(role, scope_id)| fuz_auth::RoleGrantRow {
                    id: uuid::Uuid::nil(),
                    actor_id: uuid::Uuid::nil(),
                    role: (*role).to_owned(),
                    scope_id: *scope_id,
                })
                .collect(),
        }
    }

    /// The wiring over the predicate: only a global `admin` grant admits a
    /// reserved kind, and an admitted create carries no moderation — the
    /// `moderation = 'approved'` a contribution is born with. Twin of the TS
    /// `reserved_kind_create_authorize` cases.
    #[test]
    fn the_verdict_reads_a_global_admin_grant_and_never_moderates() {
        let admitted = Verdict::Allow {
            moderation_required: false,
        };
        let global = context(&[(ROLE_ADMIN, None)]);
        let scoped = context(&[(ROLE_ADMIN, Some(uuid::Uuid::from_u128(1)))]);
        let roleless = context(&[]);
        for kind in RESERVED_CELL_KINDS {
            assert_eq!(
                ReservedKindCreateAuthorize::verdict(&global, Some(kind)),
                admitted,
                "{kind}: global admin"
            );
            assert_eq!(
                ReservedKindCreateAuthorize::verdict(&scoped, Some(kind)),
                Verdict::Deny,
                "{kind}: a scoped admin grant is no admin"
            );
            assert_eq!(
                ReservedKindCreateAuthorize::verdict(&roleless, Some(kind)),
                Verdict::Deny,
                "{kind}: roleless"
            );
        }
        assert_eq!(
            ReservedKindCreateAuthorize::verdict(&roleless, Some("note")),
            admitted
        );
        assert_eq!(
            ReservedKindCreateAuthorize::verdict(&roleless, None),
            admitted
        );
    }

    #[test]
    fn the_reserved_kinds_are_the_constants_table() {
        let fixture: serde_json::Value = serde_json::from_str(FIXTURE).expect("parses");
        let names: Vec<&str> = fixture["tables"]["reserved"]
            .as_array()
            .expect("a reserved table")
            .iter()
            .map(|row| row["name"].as_str().expect("a name"))
            .collect();
        assert_eq!(names, RESERVED_CELL_KINDS);
    }
}
