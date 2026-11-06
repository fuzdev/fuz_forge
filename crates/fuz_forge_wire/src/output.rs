//! Typed output DTOs for the forge's JSON-RPC and file-store responses.
//!
//! These are the single source of truth for the success-body wire shape of the
//! `fuz_forge_repo_*` and `fuz_forge_token_*` RPCs and of the file-store REST
//! routes under `/api/fuz_forge/files`. The `fuzfd` server constructs and
//! serializes them; the `fuzf` client deserializes the subset it reads (there
//! is no tree/blob/token command, and `delete_file` discards its body).
//! Holding both sides to one definition is the parity guard — a renamed field,
//! a dropped `null`, or a wrong type would be a wire regression caught by the
//! strict TS Zod schemas in `src/lib/action_specs.ts` for the RPC bodies, and
//! by `src/test/cross_backend/files.cross.test.ts` for the file-store bodies:
//! `Object.keys(body).sort()` field-set assertions on the upload and `?meta`
//! bodies, a whole-body `deepStrictEqual` on the delete body. No assertion pins
//! the *field set* of a list entry; what covers that is structural — one
//! projection backs both `?meta` and each list entry on either backend
//! ([`FileMetaOutput`] via `FileCellData::to_meta_output` on the Rust side,
//! `file_meta_view` in `src/lib/server/routes/files.ts` on the TS side), so a
//! shape regression fails the `?meta` assertion too. An entry's *values* are
//! asserted: `src/test/cross_backend/files_scoped_token.cross.test.ts` requires
//! a list entry's `uploaded_at` to equal the one the `?meta` read returns. The
//! file-store *route specs* in `src/lib/server/routes/files.ts` are not that
//! guard: each is a deliberately loose one-field `z.looseObject`, which a
//! renamed or dropped sibling field passes.
//!
//! # Serialization invariants
//!
//! Every shape carries the same keys and the same values as the JSON the TS
//! twin emits (key *order* is a separate matter — see below):
//!
//! - **No `skip_serializing_if`.** Each `Option` is TS `.nullable()`, so a
//!   `None` must emit the key with a JSON `null`. Dropping the key fails the
//!   strict cross-test.
//! - **No `deny_unknown_fields`.** Deserialization stays tolerant of unknown
//!   *fields* (the client reads more than it renders; a future server field
//!   must not break an older client). Variant sets are closed, though — no
//!   `#[serde(other)]` anywhere in this module — so a new [`UploadStatus`]
//!   value breaks an older `fuzf` at deserialize. That is the only closed set
//!   the client reaches, inside [`FileUploadOutput`]; [`BlobBody`] is
//!   server-constructed only (the CLI has no blob command), so what its
//!   closedness binds is the admin dashboard — `FuzForgeRepoBlobBody` in
//!   `src/lib/action_specs.ts` is a strict `z.discriminatedUnion('kind', …)`,
//!   and `src/lib/ui/RepoBlob.svelte` branches over exactly the three kinds, so
//!   a fourth renders nothing there.
//! - **Field order is declaration order on the struct, not always on the
//!   wire.** serde emits these fields in the order declared below, and that
//!   order matches the key order of the TS twin's object literal. It survives
//!   to the wire only for the file-store bodies, which axum's `Json<T>`
//!   serializes straight from the struct. Every JSON-RPC DTO passes through
//!   `serde_json::to_value` first (the handlers' `to_value_out`), and this
//!   workspace builds `serde_json` without `preserve_order`, so its `Map` is a
//!   `BTreeMap`: the RPC wire emits keys in **byte order** (`_` is `0x5F`,
//!   below every lowercase letter, so `last_push_username` lands before
//!   `last_pushed_at` on [`RepoOutput`] where dictionary order would put it
//!   after), while the TS twin's `c.json({...})` emits insertion order. No
//!   consumer may depend on key order.
//! - **Numeric width follows the emitting side.** A field's Rust type is the
//!   one the server already holds, so serialization is a pass-through and
//!   cannot narrow: the file store's `size_bytes` is `i64` (the fact-store
//!   outcome and the `size` in a file cell's `data`), while the git-derived
//!   blob sizes are `u64` (what the object read yields). Any conversion belongs
//!   at a rendering site, never between the server and the wire.
//! - **`snake_case` is serde's default** for these identifiers — only the two
//!   Rust keywords (`ref`, `type`) carry a `#[serde(rename)]`, and the two
//!   enums (`BlobBody`'s tag and `UploadStatus`) carry
//!   `rename_all = "snake_case"`.

use serde::{Deserialize, Serialize};

// =============================================================================
//  repo_list / repo_get / repo_create
// =============================================================================

/// One forge-hosted repo row. The body of `fuz_forge_repo_get` /
/// `fuz_forge_repo_create` (wrapped in [`RepoEnvelope`]) and each element of
/// `fuz_forge_repo_list`'s array ([`RepoListOutput`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoOutput {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub default_branch: String,
    pub seed_from: Option<String>,
    pub seed_completed_at: Option<String>,
    pub head_sha: Option<String>,
    pub last_pushed_at: Option<String>,
    pub last_pushed_by: Option<String>,
    pub last_push_username: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `fuz_forge_repo_list` output: `{repos: [...]}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoListOutput {
    pub repos: Vec<RepoOutput>,
}

/// `fuz_forge_repo_get` / `fuz_forge_repo_create` envelope: `{repo: {...}}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoEnvelope {
    pub repo: RepoOutput,
}

// =============================================================================
//  repo_log
// =============================================================================

/// One commit summary in a `fuz_forge_repo_log` page.
///
/// All seven fields ship on the wire; the client deserializes the whole struct
/// and renders the subset it needs (`short_sha`, `subject`, `author_name`,
/// `author_date`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitSummary {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub parents: Vec<String>,
}

/// `fuz_forge_repo_log` output. `ref` is a Rust keyword, renamed on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoLogOutput {
    pub commits: Vec<CommitSummary>,
    pub next_cursor: Option<String>,
    #[serde(rename = "ref")]
    pub ref_name: String,
}

// =============================================================================
//  repo_commit
// =============================================================================

/// Single-commit detail from `fuz_forge_repo_commit` — eleven fields including
/// the committer trio and the raw `body`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitDetail {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_date: String,
    pub parents: Vec<String>,
    pub body: String,
}

/// The unified-diff body of a `fuz_forge_repo_commit` response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitDiff {
    pub text: String,
    pub truncated: bool,
}

/// `fuz_forge_repo_commit` output: `{commit, diff}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoCommitOutput {
    pub commit: CommitDetail,
    pub diff: CommitDiff,
}

// =============================================================================
//  repo_refs
// =============================================================================

/// One ref entry from `fuz_forge_repo_refs` — five fields including
/// `object_type` and the dereferenced `target_sha` (the tag's pointee).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefEntry {
    pub name: String,
    pub object_type: String,
    pub sha: String,
    pub target_sha: String,
    pub committer_date: String,
}

/// `fuz_forge_repo_refs` output: `{refs, default_branch}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoRefsOutput {
    pub refs: Vec<RefEntry>,
    pub default_branch: String,
}

// =============================================================================
//  repo_tree
// =============================================================================

/// One `fuz_forge_repo_tree` entry. `size` is a string on the wire (`"-"` for a
/// tree/sub-directory, the byte count for a blob — `git ls-tree -l`'s column).
/// `type` is a Rust keyword, renamed on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeEntry {
    pub mode: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub sha: String,
    pub size: String,
    pub name: String,
}

/// `fuz_forge_repo_tree` output: `{entries, resolved_sha}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoTreeOutput {
    pub entries: Vec<TreeEntry>,
    pub resolved_sha: String,
}

// =============================================================================
//  repo_blob
// =============================================================================

/// The blob body of a `fuz_forge_repo_blob` response.
///
/// A discriminated union keyed by `kind` (`text` / `binary` / `truncated`):
/// `Text` carries the decoded content; `Binary` carries nothing
/// (`{"kind":"binary"}`); `Truncated` carries the real `size` (the bytes exceed
/// the read cap, so they weren't read). Matches the TS reference backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BlobBody {
    Text { text: String },
    Binary,
    Truncated { size: u64 },
}

/// `fuz_forge_repo_blob` output: `{sha, size, body}`. `size` is a number (the
/// blob's byte length); `body` is the tagged [`BlobBody`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoBlobOutput {
    pub sha: String,
    pub size: u64,
    pub body: BlobBody,
}

// =============================================================================
//  repo_resync
// =============================================================================

/// `fuz_forge_repo_resync` output: the head SHA before and after the re-read
/// (both `null` for a never-pushed / now-empty repo).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoResyncOutput {
    pub previous_head_sha: Option<String>,
    pub head_sha: Option<String>,
}

// =============================================================================
//  rotate_secret / token_create_scoped / token_policy_list
// =============================================================================

/// A bare `{ok: true}` acknowledgement (`fuz_forge_repo_rotate_secret`).
/// Construct with `ok: true`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OkResponse {
    pub ok: bool,
}

/// `fuz_forge_token_create_scoped` output. Fields `ok, token, id, name,
/// template`; `id` is the `tok_…` token id as a string (not a UUID). `Debug`
/// redacts the raw token.
#[derive(Clone, Serialize, Deserialize)]
pub struct TokenCreateScopedOutput {
    pub ok: bool,
    pub token: String,
    pub id: String,
    pub name: String,
    pub template: String,
}

impl std::fmt::Debug for TokenCreateScopedOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenCreateScopedOutput")
            .field("ok", &self.ok)
            .field("token", &"<redacted>")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("template", &self.template)
            .finish()
    }
}

/// One scoped-token policy row from `fuz_forge_token_policy_list` — exactly the
/// token id and its template kind.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPolicyEntry {
    pub api_token_id: String,
    pub template: String,
}

/// `fuz_forge_token_policy_list` output: `{policies: [...]}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPolicyListOutput {
    pub policies: Vec<TokenPolicyEntry>,
}

// =============================================================================
//  file store (REST) — /api/fuz_forge/files
// =============================================================================

/// File metadata: the body of `GET /api/fuz_forge/files/<filename>?meta` and
/// each element of [`FileListOutput`].
///
/// `blake3_hash` is bare hex (no `blake3:` prefix) and is the file's only
/// digest; `uploaded_at` is the resolved `cell.updated_at.unwrap_or(cell.created_at)`
/// in the canonical second-precision UTC form. Distinct from
/// [`FileUploadOutput`]: the upload body carries `status` and no `uploaded_at`,
/// so the two are separate shapes rather than one type with optional fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetaOutput {
    pub filename: String,
    pub blake3_hash: String,
    pub size_bytes: i64,
    pub content_type: String,
    pub uploaded_at: String,
}

/// `GET /api/fuz_forge/files` output: `{files: [...]}`, sorted by `filename` in
/// byte order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileListOutput {
    pub files: Vec<FileMetaOutput>,
}

/// Upload outcome — the `status` field of [`FileUploadOutput`].
///
/// `Unchanged` is the idempotent case (identical bytes at the same key, no cell
/// write); `Updated` replaced an existing key's bytes; `Created` is a new key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadStatus {
    Created,
    Updated,
    Unchanged,
}

/// `POST /api/fuz_forge/files/<filename>` output.
///
/// The upload answers with what it stored plus the [`UploadStatus`]; it does
/// **not** carry `uploaded_at`, which only the metadata read resolves. Reading
/// this body as [`FileMetaOutput`] fails to deserialize on every upload — the
/// hazard that makes the two shapes worth naming separately.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileUploadOutput {
    pub filename: String,
    pub blake3_hash: String,
    pub size_bytes: i64,
    pub content_type: String,
    pub status: UploadStatus,
}

/// `DELETE /api/fuz_forge/files/<filename>` output: `{deleted: true, filename}`.
///
/// `deleted` is a real `bool` that is always `true` on the success path — the
/// failure cases are HTTP status codes with an `error` body, never
/// `{deleted: false}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDeleteOutput {
    pub deleted: bool,
    pub filename: String,
}

#[cfg(test)]
mod tests {
    //! Parity guards for the wire shape. These unit tests are the standing
    //! proof — the cross-backend suites are opt-in
    //! (`FUZ_TEST_CROSS_BACKEND=1`, each project spawning a real backend
    //! binary, the Rust one over a live Postgres), while these run in every
    //! `cargo test`.
    //!
    //! Four forms, by what each one claims:
    //!
    //! - **Whole shape** — `to_value` against a `json!` literal, the default:
    //!   it pins the key set and every value at once.
    //! - **Distinguishing keys** — a wrapper whose inner type has its own
    //!   whole-shape test asserts only what the wrapping adds
    //!   (`repo_envelope_wraps_repo`, `repo_commit_output_shape`).
    //! - **Emitted order** — a raw serialized string
    //!   (`file_meta_output_serializes_in_declaration_order`), the only form
    //!   that pins order at all.
    //! - **Decode direction** — the upload/metadata pair, each body asserted to
    //!   deserialize into its own type and to *fail* into the other's.
    //!
    //! The caveat driving that third form: `serde_json::Value` compares objects
    //! as maps, so a `to_value` assertion pins the key *set* and the values,
    //! not the emitted order. Where declaration order itself is the claim,
    //! assert on `to_string`.
    use super::*;
    use serde_json::json;

    #[test]
    fn repo_output_emits_all_keys_with_nulls() {
        // The all-`None` repo (a fresh/never-pushed repo) must still emit every
        // optional key as JSON `null` — the #1 regression risk.
        let repo = RepoOutput {
            id: "11111111-1111-4111-8111-111111111111".into(),
            slug: "org/repo".into(),
            name: "repo".into(),
            default_branch: "main".into(),
            seed_from: None,
            seed_completed_at: None,
            head_sha: None,
            last_pushed_at: None,
            last_pushed_by: None,
            last_push_username: None,
            created_at: "2026-06-21T00:00:00Z".into(),
            updated_at: "2026-06-21T00:00:00Z".into(),
        };
        assert_eq!(
            serde_json::to_value(&repo).unwrap(),
            json!({
                "id": "11111111-1111-4111-8111-111111111111",
                "slug": "org/repo",
                "name": "repo",
                "default_branch": "main",
                "seed_from": null,
                "seed_completed_at": null,
                "head_sha": null,
                "last_pushed_at": null,
                "last_pushed_by": null,
                "last_push_username": null,
                "created_at": "2026-06-21T00:00:00Z",
                "updated_at": "2026-06-21T00:00:00Z",
            }),
        );
    }

    #[test]
    fn repo_output_emits_populated_options() {
        let repo = RepoOutput {
            id: "id".into(),
            slug: "org/repo".into(),
            name: "repo".into(),
            default_branch: "main".into(),
            seed_from: Some("https://x/y.git".into()),
            seed_completed_at: Some("2026-06-21T00:00:00Z".into()),
            head_sha: Some("deadbeef".into()),
            last_pushed_at: Some("2026-06-21T00:00:01Z".into()),
            last_pushed_by: Some("actor-id".into()),
            last_push_username: Some("alice".into()),
            created_at: "2026-06-21T00:00:00Z".into(),
            updated_at: "2026-06-21T00:00:02Z".into(),
        };
        assert_eq!(
            serde_json::to_value(&repo).unwrap(),
            json!({
                "id": "id",
                "slug": "org/repo",
                "name": "repo",
                "default_branch": "main",
                "seed_from": "https://x/y.git",
                "seed_completed_at": "2026-06-21T00:00:00Z",
                "head_sha": "deadbeef",
                "last_pushed_at": "2026-06-21T00:00:01Z",
                "last_pushed_by": "actor-id",
                "last_push_username": "alice",
                "created_at": "2026-06-21T00:00:00Z",
                "updated_at": "2026-06-21T00:00:02Z",
            }),
        );
    }

    #[test]
    fn repo_list_empty_is_empty_array() {
        // An empty `Vec` must serialize to `[]`, not be omitted.
        assert_eq!(
            serde_json::to_value(RepoListOutput { repos: vec![] }).unwrap(),
            json!({ "repos": [] }),
        );
    }

    #[test]
    fn repo_envelope_wraps_repo() {
        let repo = RepoOutput {
            id: "id".into(),
            slug: "org/repo".into(),
            name: "repo".into(),
            default_branch: "main".into(),
            seed_from: None,
            seed_completed_at: None,
            head_sha: None,
            last_pushed_at: None,
            last_pushed_by: None,
            last_push_username: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        };
        let value = serde_json::to_value(RepoEnvelope { repo }).unwrap();
        assert!(value.get("repo").is_some());
        assert_eq!(value["repo"]["slug"], json!("org/repo"));
    }

    #[test]
    fn commit_summary_all_seven_fields() {
        let c = CommitSummary {
            sha: "deadbeefcafef00d".into(),
            short_sha: "deadbee".into(),
            subject: "initial".into(),
            author_name: "Alice".into(),
            author_email: "alice@x.y".into(),
            author_date: "2026-06-21T00:00:00Z".into(),
            parents: vec!["p1".into(), "p2".into()],
        };
        assert_eq!(
            serde_json::to_value(&c).unwrap(),
            json!({
                "sha": "deadbeefcafef00d",
                "short_sha": "deadbee",
                "subject": "initial",
                "author_name": "Alice",
                "author_email": "alice@x.y",
                "author_date": "2026-06-21T00:00:00Z",
                "parents": ["p1", "p2"],
            }),
        );
    }

    #[test]
    fn repo_log_renames_ref_and_keeps_null_cursor() {
        let out = RepoLogOutput {
            commits: vec![],
            next_cursor: None,
            ref_name: "main".into(),
        };
        assert_eq!(
            serde_json::to_value(&out).unwrap(),
            json!({ "commits": [], "next_cursor": null, "ref": "main" }),
        );
    }

    #[test]
    fn commit_detail_eleven_fields_with_empty_parents() {
        let c = CommitDetail {
            sha: "sha1".into(),
            short_sha: "sha".into(),
            subject: "subj".into(),
            author_name: "An".into(),
            author_email: "ae@x".into(),
            author_date: "d1".into(),
            committer_name: "Cn".into(),
            committer_email: "ce@x".into(),
            committer_date: "d2".into(),
            parents: vec![],
            body: "body text".into(),
        };
        assert_eq!(
            serde_json::to_value(&c).unwrap(),
            json!({
                "sha": "sha1",
                "short_sha": "sha",
                "subject": "subj",
                "author_name": "An",
                "author_email": "ae@x",
                "author_date": "d1",
                "committer_name": "Cn",
                "committer_email": "ce@x",
                "committer_date": "d2",
                "parents": [],
                "body": "body text",
            }),
        );
    }

    #[test]
    fn repo_commit_output_shape() {
        let out = RepoCommitOutput {
            commit: CommitDetail {
                sha: "s".into(),
                short_sha: "s".into(),
                subject: "x".into(),
                author_name: "a".into(),
                author_email: "a@x".into(),
                author_date: "d".into(),
                committer_name: "c".into(),
                committer_email: "c@x".into(),
                committer_date: "d".into(),
                parents: vec![],
                body: String::new(),
            },
            diff: CommitDiff {
                text: "diff --git".into(),
                truncated: false,
            },
        };
        let value = serde_json::to_value(&out).unwrap();
        assert_eq!(
            value["diff"],
            json!({ "text": "diff --git", "truncated": false })
        );
        assert!(value.get("commit").is_some());
    }

    #[test]
    fn ref_entry_five_fields() {
        let r = RefEntry {
            name: "refs/heads/main".into(),
            object_type: "commit".into(),
            sha: "deadbeef".into(),
            target_sha: String::new(),
            committer_date: "2026-06-21T00:00:00Z".into(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({
                "name": "refs/heads/main",
                "object_type": "commit",
                "sha": "deadbeef",
                "target_sha": "",
                "committer_date": "2026-06-21T00:00:00Z",
            }),
        );
    }

    #[test]
    fn repo_refs_output_shape() {
        let out = RepoRefsOutput {
            refs: vec![],
            default_branch: "main".into(),
        };
        assert_eq!(
            serde_json::to_value(&out).unwrap(),
            json!({ "refs": [], "default_branch": "main" }),
        );
    }

    #[test]
    fn tree_entry_renames_type_and_size_is_string() {
        // `type` is renamed; `size` is a JSON string (`"-"` for a tree).
        let e = TreeEntry {
            mode: "040000".into(),
            entry_type: "tree".into(),
            sha: "abc123".into(),
            size: "-".into(),
            name: "src".into(),
        };
        let value = serde_json::to_value(&e).unwrap();
        assert_eq!(
            value,
            json!({
                "mode": "040000",
                "type": "tree",
                "sha": "abc123",
                "size": "-",
                "name": "src",
            }),
        );
        assert!(value["size"].is_string());
    }

    #[test]
    fn repo_tree_output_shape() {
        let out = RepoTreeOutput {
            entries: vec![],
            resolved_sha: "deadbeef".into(),
        };
        assert_eq!(
            serde_json::to_value(&out).unwrap(),
            json!({ "entries": [], "resolved_sha": "deadbeef" }),
        );
    }

    #[test]
    fn blob_body_text_variant() {
        assert_eq!(
            serde_json::to_value(BlobBody::Text { text: "hi".into() }).unwrap(),
            json!({ "kind": "text", "text": "hi" }),
        );
    }

    #[test]
    fn blob_body_binary_variant_has_only_kind() {
        // `Binary` is a unit variant → `{"kind":"binary"}` with no other key.
        let value = serde_json::to_value(BlobBody::Binary).unwrap();
        assert_eq!(value, json!({ "kind": "binary" }));
        assert_eq!(value.as_object().unwrap().len(), 1);
    }

    #[test]
    fn blob_body_truncated_variant() {
        assert_eq!(
            serde_json::to_value(BlobBody::Truncated { size: 99 }).unwrap(),
            json!({ "kind": "truncated", "size": 99 }),
        );
    }

    #[test]
    fn repo_blob_output_size_is_number() {
        let out = RepoBlobOutput {
            sha: "abc".into(),
            size: 1234,
            body: BlobBody::Binary,
        };
        let value = serde_json::to_value(&out).unwrap();
        assert_eq!(
            value,
            json!({ "sha": "abc", "size": 1234, "body": { "kind": "binary" } }),
        );
        assert!(value["size"].is_number());
    }

    #[test]
    fn repo_resync_emits_nulls() {
        assert_eq!(
            serde_json::to_value(RepoResyncOutput {
                previous_head_sha: None,
                head_sha: None,
            })
            .unwrap(),
            json!({ "previous_head_sha": null, "head_sha": null }),
        );
        assert_eq!(
            serde_json::to_value(RepoResyncOutput {
                previous_head_sha: Some("old".into()),
                head_sha: Some("new".into()),
            })
            .unwrap(),
            json!({ "previous_head_sha": "old", "head_sha": "new" }),
        );
    }

    #[test]
    fn ok_response_is_ok_true() {
        assert_eq!(
            serde_json::to_value(OkResponse { ok: true }).unwrap(),
            json!({ "ok": true }),
        );
    }

    #[test]
    fn token_create_scoped_shape_and_string_id() {
        let out = TokenCreateScopedOutput {
            ok: true,
            token: "tok_secret".into(),
            id: "tok_abc123".into(),
            name: "ci".into(),
            template: "rpc_subset".into(),
        };
        let value = serde_json::to_value(&out).unwrap();
        assert_eq!(
            value,
            json!({
                "ok": true,
                "token": "tok_secret",
                "id": "tok_abc123",
                "name": "ci",
                "template": "rpc_subset",
            }),
        );
        // `id` is a string (the `tok_…` id), not a number/uuid object.
        assert!(value["id"].is_string());
    }

    #[test]
    fn token_create_scoped_debug_redacts_the_token() {
        let out = TokenCreateScopedOutput {
            ok: true,
            token: "secret_fuz_token_scoped-Hn5rT2".into(),
            id: "tok_abc123".into(),
            name: "ci".into(),
            template: "rpc_subset".into(),
        };
        let rendered = format!("{out:?}");
        assert!(!rendered.contains("scoped-Hn5rT2"), "{rendered}");
        assert!(rendered.contains("<redacted>"), "{rendered}");
        assert!(rendered.contains("tok_abc123"), "{rendered}");
    }

    #[test]
    fn token_policy_entry_exactly_two_fields() {
        let e = TokenPolicyEntry {
            api_token_id: "tok_abc".into(),
            template: "admin".into(),
        };
        let value = serde_json::to_value(&e).unwrap();
        assert_eq!(
            value,
            json!({ "api_token_id": "tok_abc", "template": "admin" }),
        );
        assert_eq!(value.as_object().unwrap().len(), 2);
    }

    #[test]
    fn token_policy_list_empty_is_empty_array() {
        assert_eq!(
            serde_json::to_value(TokenPolicyListOutput { policies: vec![] }).unwrap(),
            json!({ "policies": [] }),
        );
    }

    /// The `?meta` / list-entry metadata body, key for key.
    #[test]
    fn file_meta_output_fields() {
        let meta = FileMetaOutput {
            filename: "tools/zap/0.1.0/zap.tar.gz".into(),
            blake3_hash: "ab".repeat(32),
            size_bytes: 4096,
            content_type: "application/gzip".into(),
            uploaded_at: "2026-06-21T00:00:00Z".into(),
        };
        let value = serde_json::to_value(&meta).unwrap();
        assert_eq!(
            value,
            json!({
                "filename": "tools/zap/0.1.0/zap.tar.gz",
                "blake3_hash": "ab".repeat(32),
                "size_bytes": 4096,
                "content_type": "application/gzip",
                "uploaded_at": "2026-06-21T00:00:00Z",
            }),
        );
        // Exactly the keys above — the projection is closed (the cross suite
        // asserts the same "no more" on both backends).
        assert_eq!(value.as_object().unwrap().len(), 5);
        assert!(value["size_bytes"].is_number());
    }

    /// The one place declaration order is asserted as *emitted* order rather
    /// than as a key set: `serde_json::Value` compares maps order-insensitively,
    /// so only the serialized string can pin the invariant the module doc
    /// states. This is also the order the TS twin's object literal emits.
    #[test]
    fn file_meta_output_serializes_in_declaration_order() {
        let meta = FileMetaOutput {
            filename: "x.json".into(),
            blake3_hash: "b3".into(),
            size_bytes: 7,
            content_type: "application/json".into(),
            uploaded_at: "2026-06-21T00:00:00Z".into(),
        };
        assert_eq!(
            serde_json::to_string(&meta).unwrap(),
            r#"{"filename":"x.json","blake3_hash":"b3","size_bytes":7,"content_type":"application/json","uploaded_at":"2026-06-21T00:00:00Z"}"#,
        );
    }

    #[test]
    fn file_list_empty_is_empty_array() {
        assert_eq!(
            serde_json::to_value(FileListOutput { files: vec![] }).unwrap(),
            json!({ "files": [] }),
        );
    }

    #[test]
    fn upload_status_serializes_snake_case() {
        assert_eq!(
            serde_json::to_value(UploadStatus::Created).unwrap(),
            json!("created")
        );
        assert_eq!(
            serde_json::to_value(UploadStatus::Updated).unwrap(),
            json!("updated")
        );
        assert_eq!(
            serde_json::to_value(UploadStatus::Unchanged).unwrap(),
            json!("unchanged")
        );
    }

    #[test]
    fn file_upload_output_fields_with_status() {
        let out = FileUploadOutput {
            filename: "release.tar.gz".into(),
            blake3_hash: "ab".repeat(32),
            size_bytes: 1024,
            content_type: "application/gzip".into(),
            status: UploadStatus::Updated,
        };
        let value = serde_json::to_value(&out).unwrap();
        assert_eq!(
            value,
            json!({
                "filename": "release.tar.gz",
                "blake3_hash": "ab".repeat(32),
                "size_bytes": 1024,
                "content_type": "application/gzip",
                "status": "updated",
            }),
        );
        assert_eq!(value.as_object().unwrap().len(), 5);
        // No `uploaded_at` on the upload body — the whole point of the split.
        assert!(value.get("uploaded_at").is_none());
    }

    /// The two file-store bodies are not interchangeable: the upload body must
    /// deserialize into [`FileUploadOutput`], and must NOT be readable as
    /// [`FileMetaOutput`]. The metadata shape requires `uploaded_at`, which the
    /// upload never sends, so a client that binds the wrong type there fails on
    /// the response decode of every upload that transferred bytes — after the
    /// server has already stored them. Merging the two behind an optional field
    /// would reopen that.
    #[test]
    fn upload_body_decodes_as_upload_output_and_not_as_metadata() {
        // Exactly the body both backends emit (`files/handlers.rs`'s
        // `upload_response` and `src/lib/server/routes/files.ts`).
        let body = json!({
            "filename": "tools/zap/0.1.0/zap.tar.gz",
            "blake3_hash": "ab".repeat(32),
            "size_bytes": 4096,
            "content_type": "application/gzip",
            "status": "created",
        });
        let decoded: FileUploadOutput = serde_json::from_value(body.clone()).unwrap();
        assert_eq!(decoded.filename, "tools/zap/0.1.0/zap.tar.gz");
        assert_eq!(decoded.size_bytes, 4096);
        assert_eq!(decoded.status, UploadStatus::Created);
        assert!(serde_json::from_value::<FileMetaOutput>(body).is_err());
    }

    /// The inverse of the guard above: the metadata body carries no `status`,
    /// so it is not readable as the upload shape either. Two bodies, two types.
    #[test]
    fn metadata_body_is_not_readable_as_upload_output() {
        let body = json!({
            "filename": "x.json",
            "blake3_hash": "b3",
            "size_bytes": 7,
            "content_type": "application/json",
            "uploaded_at": "2026-06-21T00:00:00Z",
        });
        assert!(serde_json::from_value::<FileMetaOutput>(body.clone()).is_ok());
        assert!(serde_json::from_value::<FileUploadOutput>(body).is_err());
    }

    #[test]
    fn file_delete_output_is_deleted_true_and_filename() {
        let value = serde_json::to_value(FileDeleteOutput {
            deleted: true,
            filename: "release.tar.gz".into(),
        })
        .unwrap();
        assert_eq!(
            value,
            json!({ "deleted": true, "filename": "release.tar.gz" }),
        );
        // A real `bool`, not the string "true".
        assert!(value["deleted"].is_boolean());
    }
}
