/**
 * The byte-buffer helper the chunk-draining paths share.
 *
 * Reading a stream to memory always arrives at the same last step — a list of
 * chunks that has to become one buffer — so the loop lives here once instead of
 * at each drain.
 *
 * @module
 */

/**
 * Concatenate `chunks` into a single `Uint8Array`, in order.
 *
 * Returns an empty `Uint8Array` for an empty input; zero-length chunks
 * contribute nothing. Each chunk contributes exactly its own view bounds —
 * `byteOffset` and `length`, never the backing `ArrayBuffer` — so a chunk that
 * is a window into a larger buffer, as a stream reader's chunks can be, carries
 * only its own bytes.
 */
export const concat_uint8 = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
};
