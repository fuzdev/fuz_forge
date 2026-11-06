/**
 * `repo_ref_paths` — the `[...rest]` grammar of the tree/blob browse routes.
 *
 * `ref_path_rest` is the inverse of `split_ref_path`, and the pair has to
 * round-trip: every link the browse components build is re-parsed by the page
 * it lands on. The separator is the first `:` exactly so a slash-bearing
 * branch name survives that trip — `feature/foo` and `release/1.x` are valid
 * to `git check-ref-format`, which refuses a `:` outright, so the first colon
 * is unambiguously the boundary and any later one belongs to the path.
 *
 * The rest of the teeth are in the malformed input — SvelteKit fills
 * `params.rest` from the pathname as typed, so a pasted trailing slash reaches
 * the components intact, and `resolve` *throws* on a rest param that starts or
 * ends with a slash. These cases call the real `resolve` rather than asserting
 * a string shape, so the pin is on SvelteKit's rule, not on a restatement of it.
 *
 * Two tests pin what the grammar *depends* on rather than what it does: that a
 * colon-bearing ref — the only input that breaks the round-trip — is refused by
 * `is_safe_ref_name`, and that a dot segment, which the colon carries past the
 * URL parser, is refused by `is_safe_path`. Both import the real
 * backend validators, so those pins move with the rule and not with a copy of
 * it.
 *
 * @module
 */

import { resolve } from '$app/paths';
import { assert, describe, test } from 'vitest';

import { is_safe_path, is_safe_ref_name } from '#lib/server/git/parse.ts';
import { ref_path_rest, ref_short_name, split_ref_path } from '#lib/ui/repo_ref_paths.ts';

const resolve_tree = (id: string, rest: string): string =>
	resolve('/admin/repos/[id]/tree/[...rest]', { id, rest });

describe('ref_short_name', () => {
	test('strips the branch and tag prefixes, passes anything else through', () => {
		assert.strictEqual(ref_short_name('refs/heads/main'), 'main');
		assert.strictEqual(ref_short_name('refs/tags/v1.0.0'), 'v1.0.0');
		assert.strictEqual(ref_short_name('refs/heads/feat/nested'), 'feat/nested');
		assert.strictEqual(ref_short_name('main'), 'main');
		assert.strictEqual(ref_short_name('refs/remotes/origin/main'), 'refs/remotes/origin/main');
	});
});

describe('split_ref_path', () => {
	test('splits at the colon — ref before, path after', () => {
		assert.deepStrictEqual(split_ref_path(''), { ref: '', path: '' });
		assert.deepStrictEqual(split_ref_path('main'), { ref: 'main', path: '' });
		assert.deepStrictEqual(split_ref_path('main:src'), { ref: 'main', path: 'src' });
		assert.deepStrictEqual(split_ref_path('main:src/lib/a.ts'), {
			ref: 'main',
			path: 'src/lib/a.ts'
		});
	});

	test('a slash-bearing ref stays whole', () => {
		// The reason the separator isn't `/`: these are all ordinary branch
		// names that `git check-ref-format` accepts.
		assert.deepStrictEqual(split_ref_path('feature/foo'), { ref: 'feature/foo', path: '' });
		assert.deepStrictEqual(split_ref_path('a/b/c/d'), { ref: 'a/b/c/d', path: '' });
		assert.deepStrictEqual(split_ref_path('feature/foo:src/lib'), {
			ref: 'feature/foo',
			path: 'src/lib'
		});
		assert.deepStrictEqual(split_ref_path('release/1.x:a/b'), { ref: 'release/1.x', path: 'a/b' });
	});

	test('only the first colon separates — a later one is path', () => {
		// git forbids `:` in a ref name but allows it in a tracked path, so the
		// split is on the first colon, never the last.
		assert.deepStrictEqual(split_ref_path('main:src/a:b.ts'), {
			ref: 'main',
			path: 'src/a:b.ts'
		});
		assert.deepStrictEqual(split_ref_path('main:a:b:c'), { ref: 'main', path: 'a:b:c' });
	});

	test('drops the empty segments a hand-edited URL leaves behind', () => {
		assert.deepStrictEqual(split_ref_path('main:'), { ref: 'main', path: '' });
		assert.deepStrictEqual(split_ref_path('main:src/'), { ref: 'main', path: 'src' });
		assert.deepStrictEqual(split_ref_path('main:src//'), { ref: 'main', path: 'src' });
		assert.deepStrictEqual(split_ref_path('main://src'), { ref: 'main', path: 'src' });
		assert.deepStrictEqual(split_ref_path('/main:src'), { ref: 'main', path: 'src' });
		assert.deepStrictEqual(split_ref_path('/feature//foo/:src'), {
			ref: 'feature/foo',
			path: 'src'
		});
		assert.deepStrictEqual(split_ref_path('/'), { ref: '', path: '' });
		// No ref at all — the route reports "missing ref" rather than rendering.
		assert.deepStrictEqual(split_ref_path(':src'), { ref: '', path: 'src' });
		// The colon-less branch takes the same treatment. Every `…/tree/<ref>`
		// root link and every hand-typed URL lands here, and the whole splat is
		// ref — slashes and all.
		assert.deepStrictEqual(split_ref_path('main/'), { ref: 'main', path: '' });
		assert.deepStrictEqual(split_ref_path('main//src'), { ref: 'main/src', path: '' });
		assert.deepStrictEqual(split_ref_path('main/src/'), { ref: 'main/src', path: '' });
		assert.deepStrictEqual(split_ref_path('/main/src'), { ref: 'main/src', path: '' });
	});

	test('a dot segment reaches the path verbatim', () => {
		// Nothing here rewrites `.` or `..`: the documented boundary is the
		// backends' `is_safe_path`, which refuses a dot segment outright, so the
		// path is passed through rather than quietly collapsed into a different
		// one.
		assert.deepStrictEqual(split_ref_path('main:../etc'), { ref: 'main', path: '../etc' });
		assert.deepStrictEqual(split_ref_path('main:a/../../etc'), {
			ref: 'main',
			path: 'a/../../etc'
		});
		assert.deepStrictEqual(split_ref_path('main:./etc'), { ref: 'main', path: './etc' });
		assert.isFalse(is_safe_path('../etc'));
		assert.isFalse(is_safe_path('a/../../etc'));
		assert.isFalse(is_safe_path('./etc'));
	});
});

describe('ref_path_rest', () => {
	test('the empty path yields the bare ref, never a dangling separator', () => {
		assert.strictEqual(ref_path_rest('main', ''), 'main');
		assert.strictEqual(ref_path_rest('feature/foo', ''), 'feature/foo');
		assert.isFalse(ref_path_rest('main', '').endsWith(':'));
		assert.isFalse(ref_path_rest('main', '').endsWith('/'));
	});

	test('a non-empty path joins with one colon', () => {
		assert.strictEqual(ref_path_rest('main', 'src'), 'main:src');
		assert.strictEqual(ref_path_rest('main', 'src/lib'), 'main:src/lib');
		assert.strictEqual(ref_path_rest('feature/foo', 'src/lib'), 'feature/foo:src/lib');
	});

	test('a malformed half loses its empty segments', () => {
		assert.strictEqual(ref_path_rest('main', 'src/'), 'main:src');
		assert.strictEqual(ref_path_rest('main', '/src'), 'main:src');
		assert.strictEqual(ref_path_rest('main', 'src//lib'), 'main:src/lib');
		assert.strictEqual(ref_path_rest('main', '//'), 'main');
		assert.strictEqual(ref_path_rest('main', '/'), 'main');
		assert.strictEqual(ref_path_rest('/main/', 'src'), 'main:src');
	});

	test('round-trips through split_ref_path', () => {
		const cases: Array<{ ref: string; path: string }> = [
			{ ref: 'main', path: '' },
			{ ref: 'main', path: 'src' },
			{ ref: 'main', path: 'src/lib/a.ts' },
			{ ref: 'v1.0.0', path: 'README.md' },
			{ ref: 'feature/foo', path: '' },
			{ ref: 'feature/foo', path: 'src/lib' },
			{ ref: 'release/1.x', path: 'a/b' },
			{ ref: 'main', path: 'src/a:b.ts' }
		];
		for (const c of cases) {
			assert.deepStrictEqual(split_ref_path(ref_path_rest(c.ref, c.path)), c);
		}
	});

	test('the round-trip rests on `:` being illegal in a ref name', () => {
		// The one input that breaks the pair: a colon in the *ref* half. The cut
		// is on the first colon, and a colon in the ref puts an earlier one
		// there, so the halves come back shifted.
		assert.strictEqual(ref_path_rest('ma:in', 'src'), 'ma:in:src');
		assert.deepStrictEqual(split_ref_path('ma:in:src'), { ref: 'ma', path: 'in:src' });
		// It is unreachable, and that is the invariant URL correctness rests
		// on: a colon-bearing ref is refused before it can be stored or read
		// back. `is_safe_ref_name` is the TS half of that gate; the shared
		// parity fixture `src/test/fixtures/parity/git_ref_name.json` carries
		// the `with:colon` row both backends assert against, so the Rust twin
		// refuses it identically. Upstream of both, `git check-ref-format`
		// refuses to mint such a ref at all.
		assert.isFalse(is_safe_ref_name('ma:in'));
		// Every ref shape the backends do accept survives the trip, at every
		// path shape — including a path that carries its own colons.
		for (const ref of [
			'main',
			'feature/foo',
			'release/1.x',
			'v1.0.0',
			'feat@2',
			'a.b-c_d',
			'refs/heads/main'
		]) {
			assert.isTrue(is_safe_ref_name(ref), `is_safe_ref_name(${JSON.stringify(ref)})`);
			for (const path of ['', 'src', 'src/lib/a.ts', 'src/a:b.ts']) {
				assert.deepStrictEqual(split_ref_path(ref_path_rest(ref, path)), { ref, path });
			}
		}
	});
});

describe('the rest param SvelteKit accepts', () => {
	test('resolve throws on the raw slash artifacts the route params carry', () => {
		// The rule being pinned, straight from `resolve`: a rest param may not
		// start or end with a slash. These two are the raw shapes a pasted
		// `…/tree/main:src/` and `…/tree//main:src` leave in `params.rest`, so
		// handing one back to `resolve` unnormalized would throw at render
		// time. Nothing does — every link builder goes through `ref_path_rest`.
		// These two pin SvelteKit's rule; the chain test below pins that the
		// normalizer never produces one.
		assert.throws(() => resolve_tree('abc', 'main:src/'), /cannot start or end with a slash/);
		assert.throws(() => resolve_tree('abc', '/main:src'), /cannot start or end with a slash/);
		// A doubled slash doesn't throw — it survives into the URL and into
		// `params.rest`, where `split_ref_path` drops it.
		assert.strictEqual(resolve_tree('abc', 'main:src//lib'), '/admin/repos/abc/tree/main:src//lib');
	});

	test('the colon separator survives resolve untouched', () => {
		// Nothing in SvelteKit's URL construction escapes or splits on `:`, so a
		// slash-bearing ref and its path reach the address bar verbatim.
		assert.strictEqual(resolve_tree('abc', 'feature/foo'), '/admin/repos/abc/tree/feature/foo');
		assert.strictEqual(
			resolve_tree('abc', 'feature/foo:src/lib'),
			'/admin/repos/abc/tree/feature/foo:src/lib'
		);
		assert.strictEqual(
			resolve_tree('abc', 'release/1.x:a/b'),
			'/admin/repos/abc/tree/release/1.x:a/b'
		);
	});

	test('the colon shields a dot segment from the URL parser', () => {
		// The colon's one effect on what shapes can reach the app. Standing
		// alone, `..` is a segment the URL parser removes before the request
		// goes out; glued to the ref by the colon it is part of a longer
		// segment, so it survives into `params.rest` and out of
		// `split_ref_path` (asserted above). Harmless — `is_safe_path` refuses
		// it on both backends — but it is the one path shape the URL parser
		// normalizes elsewhere and not here.
		assert.strictEqual(
			new URL('/admin/repos/abc/tree/main/../etc', 'https://forge.example').pathname,
			'/admin/repos/abc/tree/etc'
		);
		assert.strictEqual(
			new URL('/admin/repos/abc/tree/main:../etc', 'https://forge.example').pathname,
			'/admin/repos/abc/tree/main:../etc'
		);
	});

	test('every rest param built from a malformed URL resolves', () => {
		// The full chain a browse link takes: route param -> `split_ref_path` ->
		// `ref_path_rest` -> `resolve`. Without the normalization on both halves,
		// the leading and trailing slashes here throw at render time and the
		// doubled ones build a path the backends' `is_safe_path` refuses.
		for (const rest of [
			'main:src/',
			'main:src//',
			'main://src',
			'/main:src',
			'main:',
			'feature/foo:src/',
			'/feature//foo/:src',
			// colon-less too — the `…/tree/<ref>` root form takes the same trip
			'main/',
			'main//src',
			'/main/src'
		]) {
			const split = split_ref_path(rest);
			const rebuilt = ref_path_rest(split.ref, split.path);
			assert.strictEqual(
				resolve_tree('abc', rebuilt),
				`/admin/repos/abc/tree/${rebuilt}`,
				`rest ${JSON.stringify(rest)} rebuilt as ${JSON.stringify(rebuilt)}`
			);
		}
	});
});
