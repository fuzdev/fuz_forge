/**
 * Cross-process integration suite for the **git smart-HTTP clone-URL grammar**
 * — run against BOTH fuz_forge backends (TS/Hono + Rust `fuz_forge_server`,
 * Axum) via the `cross_backend_*` mechanism. It pins the one URL shape either
 * backend serves and, more importantly, that every *other* shape is refused
 * before `git http-backend` sees it.
 *
 * **The grammar** (`docs/forge.md` § Clone-URL grammar): a clone URL is
 * `<base>/<org>/<repo>.git/<endpoint>` — exactly two `RepoSlug` segments, the
 * `.git` suffix mandatory. The gate on both backends is the `RepoSlug` grammar
 * itself, run before the credential check, so nothing outside that shape — in
 * segment count *or* charset — can name a repo that exists.
 *
 * **Why this is a parity probe.** Each backend served a clone-URL spelling the
 * other refused:
 *
 * - The Rust twin captures `{org}/{repo}` and used to strip `.git` with a
 *   no-op fallback (`strip_suffix(…).unwrap_or(…)`), so
 *   `GET /<org>/<repo>/info/refs` — no suffix at all — resolved the same cell
 *   and *served the repo*. The TS route regex (`.+\.git`) never matched it.
 * - The TS side had only a segment-*count* gate, no charset gate, and the cell
 *   lookup lowercases the slug — so `<org>/<repo>K.git` with U+212A KELVIN
 *   SIGN folded onto `k` and served `<org>/<repo>k`. Rust's
 *   `is_valid_repo_segment` is ASCII-only, so it 401'd. A percent-decoded
 *   `%00` rode the same hole.
 * - `%2F` split the other way. Hono hands the handler a *decoded* param, so
 *   `/<org>%2F<repo>.git/…` arrived as a two-segment slug and served on TS
 *   while axum — routing on the raw path — never matched it; and
 *   `/<org>/<a>%2F<b>.git/…` reassembled into a three-segment slug that
 *   reached Rust's `bare_slug_from_segments` before anything rejected it.
 *
 * Each is a second, undocumented clone-URL spelling live on one backend only:
 * anything keyed to the documented URL (an nginx rule, an audit grep, an
 * operator's mental model) sees a different surface than the one being served.
 * `repo_git_auth.cross` sweeps the *credential* failure matrix on the canonical
 * URL; nothing pinned the URL space itself.
 *
 * **What is asserted, and what deliberately is not.** The assertion is that an
 * off-grammar URL never reaches the git backend — no `application/x-git-*`
 * content type, no `# service=git-…` advertisement — proven against a
 * same-credentials positive control on the canonical URL, which does return
 * the advertisement on both. The refusal's *status and body* are NOT pinned,
 * because the two servers deliberately route the git URL space differently:
 * the TS reference's route regex is wider than the grammar, while the Rust
 * `fuzfd` answers its router 404. Pinning a status here would pin that
 * structural difference, not the contract. The observed answers today: Rust
 * returns its 404 for every off-grammar spelling; TS returns its generic 401
 * wherever its wider route regex still matches (the one-segment `foo.git`, and
 * every charset case) and its fallback where it doesn't (the suffix-less and
 * three-segment URLs) — a 404 under the test spawn, which serves no static, and
 * the SPA where a TS server serves the build. Keeping the TS regex wider than the
 * grammar, with the grammar check in-handler, is deliberate: narrowing it would
 * hand `foo.git` to the SPA too, a worse answer than a 401.
 *
 * The charset cases each create the repo the off-grammar spelling *would*
 * resolve, so a refusal can only be the grammar — not a missing repo.
 *
 * The suite also pins the `?service=` refusal, which sits just past the
 * grammar gate: a missing, empty, unsupported, or duplicated `service` is
 * `400 Bad Request\n` on both backends, judged *after* auth (an anonymous
 * caller still gets the generic 401) and after the URL grammar. Rust answered
 * `missing service` / `unsupported service`, and rejected a duplicate key from
 * an axum query extractor — pre-auth, pre-grammar, and naming an internal
 * field to anonymous callers. Both sides read the raw query with WHATWG
 * `application/x-www-form-urlencoded` semantics, so a percent-encoded spelling
 * of the key is the same key and first-pair-wins applies across the two
 * spellings.
 *
 * Requires `git` + `python3` on the host — `fuz_forge_repo_create` inits a bare
 * repo with python3 hooks, and the positive control runs `git http-backend`.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';

import { keeper_token } from './git_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url } = handle.config;

/** Content type `git http-backend` sets on a clone/fetch advertisement. */
const ADVERTISEMENT_CONTENT_TYPE = 'application/x-git-upload-pack-advertisement';
/** First pkt-line of an upload-pack advertisement body. */
const ADVERTISEMENT_PREAMBLE = '# service=git-upload-pack';

/** Build a `Basic <base64(user:pass)>` header value. */
const basic_header = (username: string, password: string): string =>
	`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

/** Create a forge-hosted repo over the keeper session. */
const create_repo = async (
	fixture: Awaited<ReturnType<typeof setup_test>>,
	slug: string
): Promise<void> => {
	const created = await rpc_call({
		app: fixture.transport,
		path: SPINE_RPC_PATH,
		method: 'fuz_forge_repo_create',
		params: { slug, default_branch: 'main' },
		headers: fixture.create_session_headers()
	});
	assert.isTrue(created.ok, `create ${slug} failed: ${JSON.stringify(created)}`);
};

/**
 * `GET <base>/<path_prefix>/info/refs?service=git-upload-pack` with a valid
 * admin Basic credential. The credential is always valid so a refusal can only
 * come from the URL shape, never from auth.
 */
const fetch_info_refs = async (
	fixture: Awaited<ReturnType<typeof setup_test>>,
	path_prefix: string
): Promise<Response> => {
	const token = keeper_token(fixture.create_bearer_headers());
	return await fetch(`${base_url}/${path_prefix}/info/refs?service=git-upload-pack`, {
		headers: { Authorization: basic_header(fixture.account.username, token) }
	});
};

/**
 * `GET <base>/<path_prefix>/info/refs?<query>` with a valid admin Basic
 * credential — the `?service=` cases, which need to control the raw query
 * string (duplicate keys included) rather than take the canonical one.
 */
const fetch_info_refs_query = async (
	fixture: Awaited<ReturnType<typeof setup_test>>,
	path_prefix: string,
	query: string
): Promise<Response> => {
	const token = keeper_token(fixture.create_bearer_headers());
	const suffix = query.length === 0 ? '' : `?${query}`;
	return await fetch(`${base_url}/${path_prefix}/info/refs${suffix}`, {
		headers: { Authorization: basic_header(fixture.account.username, token) }
	});
};

/** Anonymous `GET`, for the pre-auth ordering cases. */
const fetch_info_refs_anon = async (path_prefix: string, query: string): Promise<Response> => {
	const suffix = query.length === 0 ? '' : `?${query}`;
	return await fetch(`${base_url}/${path_prefix}/info/refs${suffix}`);
};

/**
 * Assert a response did not come from `git http-backend`: no git content type
 * and no advertisement preamble in the body. Deliberately silent on status —
 * see the module doc.
 */
const assert_not_a_git_response = async (res: Response, label: string): Promise<void> => {
	const content_type = res.headers.get('content-type') ?? '';
	assert.isFalse(
		content_type.startsWith('application/x-git'),
		`${label}: must not carry a git content type (got ${JSON.stringify(content_type)})`
	);
	const body = await res.text();
	assert.isFalse(
		body.includes(ADVERTISEMENT_PREAMBLE),
		`${label}: must not carry a git advertisement body`
	);
};

describe('git smart-HTTP clone-URL grammar (cross-process, both backends)', () => {
	test('canonical <org>/<repo>.git URL serves the advertisement (positive control)', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/git_url_canonical';
		await create_repo(fixture, slug);

		// The control that gives every negative below its meaning: with these
		// exact credentials, the in-grammar URL DOES reach `git http-backend`.
		const res = await fetch_info_refs(fixture, `${slug}.git`);
		assert.strictEqual(res.status, 200, 'canonical clone URL must serve the advertisement');
		assert.strictEqual(res.headers.get('content-type'), ADVERTISEMENT_CONTENT_TYPE);
		assert.include(await res.text(), ADVERTISEMENT_PREAMBLE);
	});

	test('a missing, unsupported, or duplicated ?service= is the same 400 body on both', async () => {
		// Dumb HTTP isn't supported and the advertise endpoint answers exactly
		// one shape for every unusable `?service=`. The refusal is post-auth,
		// so a single generic body carries no enumeration risk — and the two
		// backends have no reason to spell it differently. Rust used to answer
		// `missing service` / `unsupported service`.
		const fixture = await setup_test();
		const slug = 'ttt/git_url_service';
		await create_repo(fixture, slug);

		for (const [label, query] of [
			['no service parameter', ''],
			['empty service value', 'service='],
			['unsupported service', 'service=bogus'],
			// Duplicate keys are first-value-wins on both — Hono reads the
			// first value, and the Rust handler now parses the raw query
			// instead of taking an axum `Query<T>` extractor, which used to
			// reject the duplicate before auth even ran.
			['duplicate service keys', 'service=bogus&service=git-upload-pack'],
			// A percent-encoded spelling of the key is the SAME key on both
			// backends — keys are decoded before matching — so first-wins
			// picks the unsupported value here. Hono's `c.req.query` scans the
			// un-decoded query for the literal key substring first and would
			// read `git-upload-pack`, which is why the TS handler reads the raw
			// query through `URLSearchParams` instead.
			['percent-encoded service key wins first', '%73ervice=bogus&service=git-upload-pack'],
			['unknown parameter only', 'nope=1']
		] as const) {
			const res = await fetch_info_refs_query(fixture, `${slug}.git`, query);
			assert.strictEqual(res.status, 400, `${label}: must be 400`);
			assert.strictEqual(await res.text(), 'Bad Request\n', `${label}: shared refusal body`);
		}

		// Control: the *first* value winning is what makes the duplicate case
		// meaningful — a supported service first still serves the repo.
		const first_wins = await fetch_info_refs_query(
			fixture,
			`${slug}.git`,
			'service=git-upload-pack&service=bogus'
		);
		assert.strictEqual(first_wins.status, 200, 'the first service value wins');
		assert.strictEqual(first_wins.headers.get('content-type'), ADVERTISEMENT_CONTENT_TYPE);

		// The same control for the percent-encoded key: decoded first, so a
		// supported value in the encoded pair still serves the repo.
		const encoded_first_wins = await fetch_info_refs_query(
			fixture,
			`${slug}.git`,
			'%73ervice=git-upload-pack&service=bogus'
		);
		assert.strictEqual(encoded_first_wins.status, 200, 'the decoded first key wins');
		assert.strictEqual(encoded_first_wins.headers.get('content-type'), ADVERTISEMENT_CONTENT_TYPE);
	});

	test('a duplicated ?service= is judged after auth and after the grammar', async () => {
		// The ordering invariant the query extractor broke on Rust: an
		// anonymous request never learns anything about request shape (it gets
		// the generic 401), and an off-grammar URL is refused as a URL before
		// either check. A pre-auth query rejection would answer both with a
		// 400 naming an internal field.
		const fixture = await setup_test();
		const slug = 'ttt/git_url_service_order';
		await create_repo(fixture, slug);

		const anon = await fetch_info_refs_anon(`${slug}.git`, 'service=x&service=y');
		assert.strictEqual(anon.status, 401, 'anonymous is the generic 401, not a query 400');
		await assert_not_a_git_response(anon, 'anon duplicate service');

		// No `.git` suffix: off the clone-URL grammar, so the query is never
		// reached. Status is deliberately unpinned (see the module doc) — the
		// assertion is only that it is not a git response and not the 400.
		const off_grammar = await fetch_info_refs_query(fixture, slug, 'service=x&service=y');
		assert.notStrictEqual(
			off_grammar.status,
			400,
			'an off-grammar URL is refused as a URL, not as a bad query'
		);
		await assert_not_a_git_response(off_grammar, 'off-grammar duplicate service');
	});

	test('same URL without the .git suffix does not reach the git backend', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/git_url_nosuffix';
		await create_repo(fixture, slug);

		// The divergence this suite exists for: a Rust `.git` strip with a no-op
		// fallback resolves this exact repo and serves it.
		const res = await fetch_info_refs(fixture, slug);
		await assert_not_a_git_response(res, 'no .git suffix');
	});

	test('one-segment slug does not reach the git backend', async () => {
		const fixture = await setup_test();
		await create_repo(fixture, 'ttt/git_url_onesegment');

		// A one-segment slug is ungrammatical, so it can name no repo. The TS
		// route regex does match it, so the handler refuses it in-handler with
		// the generic 401; Rust has no one-segment route to match.
		const res = await fetch_info_refs(fixture, 'ttt.git');
		await assert_not_a_git_response(res, 'one-segment slug');
	});

	test('three-segment slug does not reach the git backend', async () => {
		const fixture = await setup_test();
		await create_repo(fixture, 'ttt/git_url_threesegment');

		// Same on the other side of the grammar. Neither backend routes it —
		// Rust's `/{org}/{repo}/…` is two segments, and Hono's `.+\.git` stops
		// spanning at two once the app registers more than one route — so the
		// case guards against either router being widened later.
		const res = await fetch_info_refs(fixture, 'ttt/git_url_threesegment/extra.git');
		await assert_not_a_git_response(res, 'three-segment slug');
	});

	test('non-ASCII homoglyph in a segment does not reach the git backend', async () => {
		const fixture = await setup_test();
		// The real repo the off-grammar spelling would resolve. `toLowerCase()`
		// folds U+212A KELVIN SIGN onto `k`, so the TS cell lookup found
		// `ttt/git_url_kelvink` for a slug that repo does not have; the charset
		// gate now refuses it before the fold, matching Rust's ASCII-only
		// `is_valid_repo_segment`.
		await create_repo(fixture, 'ttt/git_url_kelvink');

		const res = await fetch_info_refs(fixture, 'ttt/git_url_kelvin\u212A.git');
		await assert_not_a_git_response(res, 'U+212A KELVIN SIGN in a segment');
	});

	test('percent-encoded control byte in a segment does not reach the git backend', async () => {
		const fixture = await setup_test();
		await create_repo(fixture, 'ttt/git_url_nul');

		// `%00` decodes to a NUL, which is outside the segment charset on both
		// sides — the same refusal as the homoglyph, via the same gate.
		const res = await fetch_info_refs(fixture, 'ttt/git_url_nul%00.git');
		await assert_not_a_git_response(res, 'percent-encoded NUL in a segment');
	});

	test('percent-encoded slash separating the two segments does not reach the git backend', async () => {
		const fixture = await setup_test();
		await create_repo(fixture, 'ttt/git_url_pct_slash');

		// Hono decodes the route param, so this arrived as the canonical
		// two-segment slug and served the repo; axum routes on the raw path,
		// where it is a single segment that matches no route. Refused on both.
		const res = await fetch_info_refs(fixture, 'ttt%2Fgit_url_pct_slash.git');
		await assert_not_a_git_response(res, 'percent-encoded slash between segments');
	});

	test('percent-encoded slash inside a segment does not reach the git backend', async () => {
		const fixture = await setup_test();
		await create_repo(fixture, 'ttt/git_url_pct_inner');

		// The mirror spelling: decoded, this is a three-segment slug. It used
		// to reach Rust's `bare_slug_from_segments` and get caught only by the
		// post-auth `is_valid_repo_slug`; the grammar now runs pre-auth there,
		// and TS refuses any `%2F` in the raw path.
		const res = await fetch_info_refs(fixture, 'ttt/git_url%2Fpct_inner.git');
		await assert_not_a_git_response(res, 'percent-encoded slash inside a segment');
	});
});
