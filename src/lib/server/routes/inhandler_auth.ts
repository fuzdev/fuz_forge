/**
 * Shared in-handler auth primitives for the forge routes.
 *
 * Both `repo_git` (HTTP Basic + admin role) and `repo_internal`
 * (loopback IP + per-repo secret) live at app root, outside the
 * `/api/*` middleware chain. They each implement their own auth
 * checks inline, but the underlying primitives are identical:
 *
 * - A constant-time UTF-8 string comparator for an attacker-supplied
 *   credential compared in-process — today `repo_internal`'s per-repo hook
 *   secret. (`repo_git` hands its Basic password to
 *   `query_validate_api_token` instead, and ignores the Basic username.)
 * - A generic 401 response builder that returns the same body
 *   regardless of failure cause.
 *
 * Centralizing them removes the "two near-identical helpers; if one
 * gets fixed the other drifts" risk and makes future security
 * adjustments (timing tweaks, response shape changes) a one-edit
 * change.
 *
 * @module
 */

import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';

/**
 * Constant-time UTF-8 string equality.
 *
 * Mismatched byte-lengths short-circuit to `false` (the lengths
 * themselves are not secret — anything an attacker can encode in a
 * Basic auth header, X-header, or path param has a length they
 * already know). Equal-length comparisons run through
 * `timingSafeEqual` so the per-byte compare doesn't leak a prefix
 * match length.
 */
export const strings_equal_constant_time = (a: string, b: string): boolean => {
	const enc = new TextEncoder();
	const a_buf = enc.encode(a);
	const b_buf = enc.encode(b);
	if (a_buf.length !== b_buf.length) return false;
	return timingSafeEqual(a_buf, b_buf);
};

/** Options for the generic 401 response. */
export interface UnauthorizedOptions {
	/**
	 * Extra response headers — used by `repo_git` to attach the
	 * `WWW-Authenticate: Basic realm=...` header so a git client knows
	 * to prompt for credentials. Internal callback routes omit this.
	 */
	headers?: Record<string, string>;
}

/**
 * Build the generic 401 response.
 *
 * The body is the plain text `"Unauthorized\n"` and the content type
 * is fixed at `text/plain; charset=utf-8` — no enumeration via body
 * shape, no JSON envelope that could be mistaken for a validation
 * error. Pass `headers` to attach `WWW-Authenticate` on routes that
 * want a credential prompt.
 */
export const unauthorized = (c: Context, options: UnauthorizedOptions = {}): Response =>
	c.text('Unauthorized\n', 401, {
		'Content-Type': 'text/plain; charset=utf-8',
		...options.headers
	});
