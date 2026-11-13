//! Policy **enforcement** and the template builders — "does this token permit
//! this action", and what a minted template grants.
//!
//! Twin of `src/lib/server/fuz_forge_token_policy.ts`. Every gate on a
//! resource-bound surface ([`crate::files`], [`crate::forge_git`]'s auth chain) ends
//! up in [`policy_check`]; every mint ends up in [`policy_from_template`]. Both
//! are pure functions over the [`super::types`] grammar — the row read that
//! produces the document is [`super::hydrate`]'s.

use std::collections::BTreeMap;

use super::types::{
    DENY_ALL_POLICY, FilesGrant, ForgeGrant, FuzForgeTokenPolicy, ResourceGrant, ResourceMap,
    TrueLiteral, WildcardLiteral,
};

/// Built-in policy templates from `fuz_forge_token_policy.ts`.
///
/// Each non-`Admin` template carries the resource ids it grants (or
/// [`TemplateResources::All`] for the `'*'` wildcard), mirroring the TS
/// `policy_from_template` inputs (`repo_ids` / `filenames` / `methods`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FuzForgeTokenTemplate {
    /// `admin` template — `policy_from_template` returns `None`
    /// (unscoped, full admin powers).
    Admin,
    ForgePush(TemplateResources),
    ForgePull(TemplateResources),
    FilesRead(TemplateResources),
    FilesWrite(TemplateResources),
    /// `files_read_write` — read + write the same filename set.
    FilesReadWrite(TemplateResources),
    RpcSubset(TemplateResources),
}

/// Resource selector for a template: every id (`*`) or an explicit list.
/// Maps to a [`ResourceMap`] via [`TemplateResources::to_resource_map`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateResources {
    /// The `'*'` wildcard — any resource id.
    All,
    /// An explicit allowlist of resource ids.
    List(Vec<String>),
}

impl TemplateResources {
    /// Build the canonical [`ResourceMap`]: `'*'` for [`Self::All`], else
    /// a per-id map with `true` values (the canonical "no qualifiers"
    /// shape). Port of `build_resource_map` in `fuz_forge_token_policy.ts`.
    #[must_use]
    pub fn to_resource_map(&self) -> ResourceMap {
        match self {
            Self::All => ResourceMap::Wildcard(WildcardLiteral),
            Self::List(ids) => {
                let mut map = BTreeMap::new();
                for id in ids {
                    map.insert(id.clone(), ResourceGrant::Allowed(TrueLiteral));
                }
                ResourceMap::Map(map)
            }
        }
    }
}

/// Capability kinds — values handed to [`policy_check`].
///
/// Each resource-bound variant carries the id the check keys on: `repo_id`
/// for forge ops, `filename` for file ops, `method` for RPC. Port of the
/// TS `FuzForgeCapability` discriminated union.
#[derive(Debug, Clone)]
pub enum FuzForgeCapability<'a> {
    /// `forge.push` on a repo id.
    ForgePush { repo_id: &'a str },
    /// `forge.pull` on a repo id.
    ForgePull { repo_id: &'a str },
    /// `files.read` on a filename.
    FilesRead { filename: &'a str },
    /// `files.write` on a filename.
    FilesWrite { filename: &'a str },
    /// `files.delete` on a filename.
    FilesDelete { filename: &'a str },
}

impl FuzForgeCapability<'_> {
    /// Stable `<section>.<op>:<resource_id>` string for `{required: ...}`
    /// response bodies and audit logs. Port of `capability_string` in
    /// `fuz_forge_token_policy.ts`. The spine emits the `rpc:<method>` form for
    /// its own per-method gate; nothing here does.
    #[must_use]
    pub fn as_string(&self) -> String {
        match self {
            Self::ForgePush { repo_id } => format!("forge.push:{repo_id}"),
            Self::ForgePull { repo_id } => format!("forge.pull:{repo_id}"),
            Self::FilesRead { filename } => format!("files.read:{filename}"),
            Self::FilesWrite { filename } => format!("files.write:{filename}"),
            Self::FilesDelete { filename } => format!("files.delete:{filename}"),
        }
    }
}

/// Pure function: does `policy` allow `capability`?
///
/// Port of `policy_check` in `fuz_forge_token_policy.ts`. `None` policy is
/// the unscoped (admin-equivalent) case and always returns `true`.
/// Otherwise the relevant grant's [`ResourceMap`] is consulted for the
/// capability's resource id — allow-only, anything not listed is denied.
#[must_use]
pub fn policy_check(
    policy: Option<&FuzForgeTokenPolicy>,
    capability: &FuzForgeCapability<'_>,
) -> bool {
    let Some(policy) = policy else {
        return true; // unscoped
    };
    let grant_allows = |grant: Option<&ResourceMap>, id: &str| grant.is_some_and(|g| g.allows(id));
    match capability {
        FuzForgeCapability::ForgePush { repo_id } => {
            grant_allows(policy.forge.as_ref().and_then(|f| f.push.as_ref()), repo_id)
        }
        FuzForgeCapability::ForgePull { repo_id } => {
            grant_allows(policy.forge.as_ref().and_then(|f| f.pull.as_ref()), repo_id)
        }
        FuzForgeCapability::FilesRead { filename } => grant_allows(
            policy.files.as_ref().and_then(|f| f.read.as_ref()),
            filename,
        ),
        FuzForgeCapability::FilesWrite { filename } => grant_allows(
            policy.files.as_ref().and_then(|f| f.write.as_ref()),
            filename,
        ),
        FuzForgeCapability::FilesDelete { filename } => grant_allows(
            policy.files.as_ref().and_then(|f| f.delete.as_ref()),
            filename,
        ),
    }
}

/// Read a stored `fuz_forge_api_token_policy.policy` document, failing closed.
///
/// The one place either backend turns stored JSON into a policy, so the
/// decision is made once: a document that fails [`FuzForgeTokenPolicy`]
/// resolves to [`DENY_ALL_POLICY`], never to `None`. The row exists, so the
/// token *is* scoped, and reading it as unscoped — which is what `None` means
/// to [`policy_check`] — is the one outcome that would widen it. Twin of the
/// TS `policy_from_stored` (`fuz_forge_token_policy.ts`).
#[must_use]
pub fn policy_from_stored(policy_text: &str, api_token_id: &str) -> FuzForgeTokenPolicy {
    serde_json::from_str(policy_text).unwrap_or_else(|e| {
        tracing::error!(
            api_token_id,
            error = %fuz_sys::cli::format_error_chain(&e),
            "fuz_forge_token_policy: stored policy is unreadable; denying every capability",
        );
        DENY_ALL_POLICY
    })
}

/// Materialize a template into a policy doc.
///
/// Port of `policy_from_template` in `fuz_forge_token_policy.ts`. `Admin`
/// returns `None` (unscoped); others build a per-resource-id grant from
/// the template's [`TemplateResources`].
#[must_use]
pub fn policy_from_template(template: &FuzForgeTokenTemplate) -> Option<FuzForgeTokenPolicy> {
    let base = || DENY_ALL_POLICY;
    match template {
        FuzForgeTokenTemplate::Admin => None,
        FuzForgeTokenTemplate::ForgePush(res) => Some(FuzForgeTokenPolicy {
            forge: Some(ForgeGrant {
                push: Some(res.to_resource_map()),
                pull: None,
            }),
            ..base()
        }),
        FuzForgeTokenTemplate::ForgePull(res) => Some(FuzForgeTokenPolicy {
            forge: Some(ForgeGrant {
                push: None,
                pull: Some(res.to_resource_map()),
            }),
            ..base()
        }),
        FuzForgeTokenTemplate::FilesRead(res) => Some(FuzForgeTokenPolicy {
            files: Some(FilesGrant {
                read: Some(res.to_resource_map()),
                write: None,
                delete: None,
            }),
            ..base()
        }),
        FuzForgeTokenTemplate::FilesWrite(res) => Some(FuzForgeTokenPolicy {
            files: Some(FilesGrant {
                read: None,
                write: Some(res.to_resource_map()),
                delete: None,
            }),
            ..base()
        }),
        FuzForgeTokenTemplate::FilesReadWrite(res) => {
            let map = res.to_resource_map();
            Some(FuzForgeTokenPolicy {
                files: Some(FilesGrant {
                    read: Some(map.clone()),
                    write: Some(map),
                    delete: None,
                }),
                ..base()
            })
        }
        FuzForgeTokenTemplate::RpcSubset(res) => Some(FuzForgeTokenPolicy {
            rpc: Some(res.to_resource_map()),
            ..base()
        }),
    }
}
