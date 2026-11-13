//! Content-type inference + the file-store cell shape.
//!
//! Co-locates the filename→MIME inference ([`infer_content_type`]) with the
//! `cell.data` shape it describes ([`FileCellData`]) and the `files/<filename>`
//! cell-path helpers ([`file_cell_path`] / [`filename_from_cell_path`]). The
//! response bodies these feed are `fuz_forge_wire::output` types, shared with
//! the `fuzf` client; the inference table is hand-written twice and mirrors the
//! TS `files.ts` handler for cross-backend parity.

use fuz_forge_wire::output::FileMetaOutput;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use fuz_crypto::ContentHash;

use super::FILE_PATH_PREFIX;

/// `cell.data` shape for a file-store cell. The cell-kind discriminator
/// (`"file"`) lives on the top-level `cell.kind` column, not in `data`, so
/// file cells are selected by `cell.kind = 'file'` at query time. `blake3` is
/// the file's fact address (`blake3:<hex>`), which the cell layer's
/// `extract_refs` lifts into `cell.refs`; it is the file's only digest.
///
/// `blake3` reads through `fuz_crypto::fact_hash`, the strict fact-address
/// grammar (`blake3:` plus 64 lowercase hex), the same one the TS twin's
/// `narrow_file_cell_data` holds the cell to (`is_fact_hash`). A cell carrying
/// any other spelling (an uppercase digest, a `sha256:` hash, an SRI token)
/// fails to narrow on both backends, so neither serves it.
#[derive(Debug, Serialize, Deserialize)]
pub struct FileCellData {
    pub content_type: String,
    pub size: i64,
    #[serde(with = "fuz_crypto::fact_hash")]
    pub blake3: ContentHash,
}

impl FileCellData {
    /// Parse a cell's `data` into the file shape, or `None` on mismatch
    /// (a missing field, or a `blake3` off the fact-address grammar).
    pub fn from_cell_data(data: &Value) -> Option<Self> {
        serde_json::from_value(data.clone()).ok()
    }

    /// Bare hex of the `blake3` fact hash for the wire `blake3_hash` field.
    pub fn blake3_hex(&self) -> String {
        self.blake3.to_hex()
    }

    /// Project the cell into the file-metadata wire shape — served by the
    /// `?meta` branch of [`super::handlers::handle_get`] and as each
    /// [`super::handlers::handle_list`] entry, so the two never drift.
    ///
    /// [`FileMetaOutput`] is the shared definition: this server constructs it
    /// and the `fuzf` client deserializes the same type. The TS twin's
    /// `file_meta_view` (`src/lib/server/routes/files.ts`) hand-writes the same
    /// shape, and the cross-backend file suite holds the two to it.
    /// `uploaded_at` is the resolved `cell.updated_at.unwrap_or(cell.created_at)`.
    pub fn to_meta_output(&self, filename: &str, uploaded_at: &str) -> FileMetaOutput {
        FileMetaOutput {
            filename: filename.to_owned(),
            blake3_hash: self.blake3_hex(),
            size_bytes: self.size,
            content_type: self.content_type.clone(),
            uploaded_at: uploaded_at.to_owned(),
        }
    }
}

pub fn file_cell_path(filename: &str) -> String {
    format!("{FILE_PATH_PREFIX}{filename}")
}

pub fn filename_from_cell_path(path: &str) -> &str {
    path.strip_prefix(FILE_PATH_PREFIX).unwrap_or(path)
}

/// Infer a content type from the filename extension (mirrors the TS
/// `infer_content_type`).
#[expect(
    clippy::case_sensitive_file_extension_comparisons,
    reason = "matches the TS handler's case-sensitive endsWith checks for wire parity"
)]
pub fn infer_content_type(filename: &str) -> &'static str {
    if filename.ends_with(".tar.xz") {
        "application/x-xz"
    } else if filename.ends_with(".tar.gz") || filename.ends_with(".tgz") {
        "application/gzip"
    } else if filename.ends_with(".zip") {
        "application/zip"
    } else if filename.ends_with(".png") {
        "image/png"
    } else if filename.ends_with(".ts") {
        "text/typescript"
    } else if filename.ends_with(".json") {
        "application/json"
    } else {
        "application/octet-stream"
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn content_type_inference_matches_ts_extensions() {
        assert_eq!(infer_content_type("x.tar.xz"), "application/x-xz");
        assert_eq!(infer_content_type("x.tar.gz"), "application/gzip");
        assert_eq!(infer_content_type("x.tgz"), "application/gzip");
        assert_eq!(infer_content_type("x.zip"), "application/zip");
        assert_eq!(infer_content_type("x.png"), "image/png");
        assert_eq!(infer_content_type("x.ts"), "text/typescript");
        assert_eq!(infer_content_type("x.json"), "application/json");
        assert_eq!(infer_content_type("noext"), "application/octet-stream");
    }

    #[test]
    fn cell_path_round_trips_filename() {
        let path = file_cell_path("release.tar.gz");
        assert_eq!(path, "files/release.tar.gz");
        assert_eq!(filename_from_cell_path(&path), "release.tar.gz");
    }

    #[test]
    fn file_cell_data_parses_valid_shape() {
        // `blake3` reads through the strict fact-address grammar, so use a
        // real digest, not a stub string.
        let hash = ContentHash::blake3(b"hello world");
        let data = json!({
            "content_type": "application/json",
            "size": 42,
            "blake3": hash.to_prefixed(),
        });
        let parsed = FileCellData::from_cell_data(&data).unwrap();
        assert_eq!(parsed.content_type, "application/json");
        assert_eq!(parsed.size, 42);
        assert_eq!(parsed.blake3_hex(), hash.to_hex());
    }

    #[test]
    fn to_meta_output_projects_the_cell_onto_the_wire_shape() {
        // The bare-hex hash, the `i64` size passed through unconverted, and
        // the caller-supplied filename + `uploaded_at` — the projection the
        // `?meta` branch and each list entry share.
        let hash = ContentHash::blake3(b"hello world");
        let data = FileCellData {
            content_type: "application/gzip".to_owned(),
            size: 4096,
            blake3: hash.clone(),
        };
        let meta = data.to_meta_output("tools/zap/0.1.0/zap.tar.gz", "2026-06-21T00:00:00Z");
        assert_eq!(meta.filename, "tools/zap/0.1.0/zap.tar.gz");
        // Bare hex, no `blake3:` prefix — the prefix is a cell-data detail.
        assert_eq!(meta.blake3_hash, hash.to_hex());
        assert!(!meta.blake3_hash.contains(':'));
        assert_eq!(meta.size_bytes, 4096);
        assert_eq!(meta.content_type, "application/gzip");
        assert_eq!(meta.uploaded_at, "2026-06-21T00:00:00Z");
    }

    #[test]
    fn file_cell_data_rejects_missing_and_unprefixed() {
        let missing = json!({"content_type": "x", "size": 1});
        assert!(FileCellData::from_cell_data(&missing).is_none());
        let unprefixed = json!({
            "content_type": "x", "size": 1, "blake3": "abc",
        });
        assert!(FileCellData::from_cell_data(&unprefixed).is_none());
    }

    #[test]
    fn file_cell_data_rejects_every_spelling_but_the_fact_address() {
        // The spellings `ContentHash`'s own lenient `Deserialize` admits (or
        // admitted): an uppercase digest, another algorithm's prefixed hex,
        // and the SRI form. Each must fail to narrow, as on the TS twin.
        let hash = ContentHash::blake3(b"hello world");
        let sha256 = ContentHash::sha256(b"hello world");
        for spelling in [
            format!("blake3:{}", hash.to_hex().to_uppercase()),
            sha256.to_prefixed(),
            hash.to_sri(),
            format!(" {}", hash.to_prefixed()),
        ] {
            let data = json!({"content_type": "x", "size": 1, "blake3": spelling});
            assert!(
                FileCellData::from_cell_data(&data).is_none(),
                "{spelling:?} must not narrow",
            );
        }
        let ok = json!({"content_type": "x", "size": 1, "blake3": hash.to_prefixed()});
        assert!(FileCellData::from_cell_data(&ok).is_some());
    }
}
