/**
 * Best-effort free-space probe for the file-store disk-budget preflight.
 *
 * The TS twin of `fuz_sys::fs::free_space_bytes` (the Rust statvfs probe).
 * The upload handler probes free space on the fact-store volume and rejects an
 * upload with `507 storage_full` when `free < declared_content_length + margin`
 * — keeping headroom for the DB, logs, and in-flight temps rather than letting
 * the file store fill the volume to zero.
 *
 * `node:fs`'s `statfs` (Node 18.15+, and Bun) is the single probe path. The
 * probe is **best-effort** and **fails open** — any error (no `statfs`, an
 * unprobeable path, a permission issue) returns `null` so the caller proceeds
 * (the mid-stream `ENOSPC` backstop is the real disk-full guarantee). Mirroring
 * the Rust handler's fail-open posture.
 *
 * @module
 */

import { statfs } from 'node:fs/promises';

/**
 * Probe free bytes available to an unprivileged process on the volume
 * containing `path`. Returns `null` on any probe failure (fail-open) — the
 * caller treats `null` as "couldn't measure, proceed" and relies on the
 * mid-stream `ENOSPC` backstop.
 *
 * Uses `bavail` (blocks available to a non-root caller), not `bfree` (which
 * includes root-reserved blocks), matching `statvfs` semantics.
 */
export const free_space_bytes = async (path: string): Promise<number | null> => {
	try {
		const stats = await statfs(path);
		// `bsize` is the fundamental block size; `bavail` is blocks available to
		// an unprivileged caller. `statfs` (no `bigint` option) returns plain
		// `number` fields.
		const bsize = stats.bsize;
		const bavail = stats.bavail;
		if (!Number.isFinite(bsize) || !Number.isFinite(bavail)) return null;
		return bsize * bavail;
	} catch {
		// No `statfs` (older runtime), unprobeable path, permission error — fail
		// open. The ENOSPC backstop still catches a real disk-full.
		return null;
	}
};

/**
 * Whether `free` bytes can hold a `declared`-byte upload while keeping `margin`
 * bytes of headroom — the free-space preflight's pure decision, factored out so
 * the arithmetic is unit-testable without a live volume. The TS twin of the
 * Rust `has_sufficient_free_space`.
 */
export const has_sufficient_free_space = (
	free: number,
	declared: number,
	margin: number
): boolean => free >= declared + margin;
