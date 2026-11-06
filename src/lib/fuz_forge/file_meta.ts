/**
 * The file store's metadata wire shape, declared once for both sides of it.
 *
 * `GET /api/fuz_forge/files/<filename>?meta` answers one of these and
 * `GET /api/fuz_forge/files` answers an array of them — the same projection
 * either way. The server builds it in `server/routes/files.ts`'s
 * `file_meta_view`; the admin dashboard reads it in `ui/files_state.svelte.ts`.
 *
 * This is a *declaration*, not a validator: the frontend takes the response
 * body at its word, exactly as it did when it hand-wrote the same fields.
 * What holds the two backends to the shape is
 * `src/test/cross_backend/files.cross.test.ts`, which asserts the `?meta`
 * key set against both. The Rust twin of this type is `FileMetaOutput` in the
 * `fuz_forge_wire` crate.
 *
 * Note the upload response is a *different* shape — it carries `status` and no
 * `uploaded_at` — so it doesn't belong to this type.
 *
 * @module
 */

/**
 * Metadata for one file in the store.
 */
export interface FileMetaOutput {
	filename: string;
	/** Bare hex, no `blake3:` prefix — the file's only digest. */
	blake3_hash: string;
	size_bytes: number;
	content_type: string;
	/** Second-precision UTC ISO 8601, the wire shape both backends emit. */
	uploaded_at: string;
}
