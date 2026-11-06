/**
 * URL/ref path helpers shared by the forge browse components.
 *
 * `ref_short_name` strips `refs/heads/` / `refs/tags/` prefixes for display.
 * `split_ref_path` parses the `[...rest]` route param into a `{ref, path}`
 * pair, and `ref_path_rest` is its inverse — the one place the browse
 * components build a `[...rest]` param from a ref and a path.
 *
 * The two halves are separated by the **first `:`**, mirroring git's own
 * `<rev>:<path>` spelling — which is what the server already hands to
 * `git rev-parse` (`server/git/read.ts`). The colon earns the job twice
 * over: git's ref grammar forbids `:` in a ref name but allows `/`, so
 * `feature/foo` and `release/1.x` are ordinary branch names while the first
 * colon in a rest param is always the separator; and `:` is legal unescaped
 * in a URL path segment, so a link reaches the address bar verbatim. A later
 * `:` belongs to the path, which git does allow to contain one.
 *
 * With no path the rest param is the bare ref (`…/tree/main`) rather than a
 * dangling `main:` — the tree root is at `<ref>`.
 *
 * Both ends drop empty path segments, because `[...rest]` is raw
 * address-bar text: SvelteKit fills the route params from the pathname as
 * typed, before it normalizes the trailing slash away, so a pasted
 * `…/tree/main:src/` arrives as `rest: 'main:src/'`.
 *
 * Dot segments are *not* dropped, and the colon is what lets them arrive at
 * all: a URL parser collapses `…/tree/main/../etc` to `…/tree/etc` before the
 * request goes out, but `main:..` is a single segment, so `…/tree/main:../etc`
 * survives intact and splits to `path: '../etc'`. That is deliberate — the
 * boundary for `.` and `..` is the backends' `is_safe_path`, which refuses a
 * dot segment on both, so the path is passed through verbatim rather than
 * quietly rewritten here.
 *
 * @module
 */

/**
 * Join the non-empty segments of a path, dropping the leading, trailing,
 * and doubled slashes a hand-edited URL leaves behind: `/a//b/` becomes
 * `a/b`.
 */
const join_path_segments = (path: string): string =>
	path
		.split('/')
		.filter((segment) => segment !== '')
		.join('/');

export const ref_short_name = (full: string): string => {
	if (full.startsWith('refs/heads/')) return full.slice('refs/heads/'.length);
	if (full.startsWith('refs/tags/')) return full.slice('refs/tags/'.length);
	return full;
};

/**
 * Parse the `[...rest]` param of the `tree` / `blob` routes into its ref and
 * its in-tree path, splitting at the first `:`. A param with no `:` is all
 * ref: under `/tree/` that addresses the tree root, while `/blob/` has no
 * root object to name and falls to its "missing ref or path in URL" guard.
 *
 * Empty segments are dropped from both halves, so the path handed to the
 * components (and on to `git ls-tree <sha>:<path>`) never carries the slash
 * artifacts of the URL it came from. Normalizing the ref half is not what
 * keeps `resolve` from throwing — every link builder re-normalizes through
 * `ref_path_rest` — it is what makes a hand-mangled URL land somewhere
 * sensible: `…/tree//main` browses `main` rather than failing the backends'
 * `is_safe_ref_name` on a leading slash, and a bare `…/tree//` reports
 * "missing ref in URL" rather than rendering a tree at `ref="/"`.
 */
export const split_ref_path = (rest: string): { ref: string; path: string } => {
	const colon = rest.indexOf(':');
	if (colon === -1) return { ref: join_path_segments(rest), path: '' };
	return {
		ref: join_path_segments(rest.slice(0, colon)),
		path: join_path_segments(rest.slice(colon + 1))
	};
};

/**
 * Build the `[...rest]` param of the `tree` / `blob` routes from a ref and an
 * in-tree path, joined by a `:`. Neither half starts with, ends with, or
 * doubles a slash: SvelteKit's `resolve` throws outright on a rest param that
 * starts or ends with one, and a doubled one it passes through untouched — on
 * into the address bar and back out of `params.rest`, where `split_ref_path`
 * drops it a second time. The backends refuse it regardless — `is_safe_path`
 * rejects an empty segment before the `<sha>:<path>` rev is built — so
 * `src//lib` never reaches `git ls-tree`, which would refuse it as an invalid
 * object name. An empty path yields the bare ref with no trailing separator:
 * the tree root is at `<ref>`.
 */
export const ref_path_rest = (ref: string, path: string): string => {
	const ref_part = join_path_segments(ref);
	const path_part = join_path_segments(path);
	return path_part === '' ? ref_part : `${ref_part}:${path_part}`;
};
