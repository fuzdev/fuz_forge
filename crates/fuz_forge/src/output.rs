//! Deserialization DTOs for the forge's JSON-RPC + file-store responses.
//!
//! The JSON-RPC repo/commit/ref/resync shapes and the file-store REST shapes
//! are both single-sourced in [`fuz_forge_wire::output`] (the server constructs
//! the same types), so this module re-exports them rather than re-declaring
//! duck-typed subsets. What stays here is the account status read — a spine
//! surface, not a forge wire shape, and the only field the CLI needs off it is
//! the username. Field names match the wire (`snake_case`).

use serde::Deserialize;

// The JSON-RPC output shapes are shared verbatim with the server. The client
// deserializes the full structs (the inner commit/ref types reach the renderer
// as fields of these wrappers) and renders the subset it needs.
pub use fuz_forge_wire::output::{
    RepoCommitOutput, RepoEnvelope, RepoListOutput, RepoLogOutput, RepoRefsOutput, RepoResyncOutput,
};

// The file-store REST shapes, likewise shared with the server. The upload body
// and the `?meta` body are deliberately distinct types: only the metadata read
// resolves `uploaded_at`, and only the upload answers with a status.
pub use fuz_forge_wire::output::{FileListOutput, FileMetaOutput, FileUploadOutput};

/// `GET /api/account/status` (the slice `repo clone --with-auth` needs).
#[derive(Debug, Deserialize)]
pub struct AccountStatus {
    pub account: Option<AccountInfo>,
}

#[derive(Debug, Deserialize)]
pub struct AccountInfo {
    pub username: Option<String>,
}
