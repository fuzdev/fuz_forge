/**
 * Cross-process integration suite for the **git smart-HTTP auth 401 negatives**
 * (anti-enumeration) — run against BOTH fuz_forge backends (TS/Hono + Rust
 * `fuz_forge_server`, Axum) via the `cross_backend_*` mechanism. It pins the
 * locked-down failure posture of the forge's `info/refs` gate: every rejection
 * is the *same* generic 401 — same status, same plain-text body, same
 * `WWW-Authenticate` challenge — regardless of cause.
 *
 * **Why this is a parity probe (not duplicated coverage).** `repo_push.cross`
 * drives the *success* write path (and the one positive→negative service-order
 * case); it never sweeps the auth-failure surface. The forge git gate is a
 * deliberate anti-enumeration design: a git client can't render a structured
 * 403, so every distinguishable cause — no header, bad header, browser replay,
 * wrong password, a *valid non-admin* token, an *unknown repo* — must collapse
 * to one indistinguishable 401. If the two backends diverged on even one cause
 * (e.g. one leaked a 404 for an unknown slug, or a 400 for a malformed header),
 * an attacker could enumerate repo existence or probe the auth shape against
 * whichever backend leaks. This asserts the byte-identical 401 on each, across
 * the full cause matrix. Both render it from one helper — TS
 * `git_unauthorized` (`repo_git_auth.ts` → `inhandler_auth.ts` `unauthorized`),
 * Rust `unauthorized_response` (`forge_git/auth.rs`).
 *
 * **The unknown-slug case is the load-bearing anti-enumeration assertion.** An
 * unknown repo must return the *same* 401 as an auth failure against an
 * existing repo — never a 404 that would confirm "this slug does not exist."
 * Both backends run the auth gate (Origin check → Basic parse → token validate
 * → admin role) *before* the cell lookup, so a missing repo is indistinguishable
 * from a missing/invalid credential. This case asserts the unknown-slug 401 is
 * identical to the wrong-password 401 on a real repo.
 *
 * **URL shape.** Both backends serve the canonical `<org>/<repo>.git/...`
 * smart-HTTP layout (the Rust route captures `{org}/{repo}` with `{repo}`
 * carrying the `.git` suffix it strips internally; the TS route is a Hono regex
 * matching the same), so the `.git` info/refs URL built here reaches the gate
 * on both — the same construction `repo_push.cross` uses for its service-order
 * case. The request is a raw `fetch` (not git itself) so the response can be
 * inspected directly; `info/refs?service=git-receive-pack` is the push
 * advertisement, which exercises the `forge.push` gate.
 *
 * Requires no git/python3 — the probes never reach the subprocess (they're
 * rejected at the auth gate). Only `fuz_forge_repo_create` (to get a real slug)
 * touches the backend's repo machinery.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';

import { keeper_token } from './git_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url } = handle.config;

/** The exact 401 body both backends emit (`inhandler_auth.ts` / `auth.rs`). */
const EXPECTED_BODY = 'Unauthorized\n';
/** The exact challenge header both backends emit. */
const EXPECTED_WWW_AUTHENTICATE = 'Basic realm="fuz_forge forge", charset="UTF-8"';

/** Build the push advertisement `info/refs` URL for `<slug>.git` (both backends). */
const info_refs_url = (slug: string): string =>
	`${base_url}/${slug}.git/info/refs?service=git-receive-pack`;

/** Build a `Basic <base64(user:pass)>` header value. */
const basic_header = (username: string, password: string): string =>
	`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

/**
 * Assert a response is the generic, anti-enumeration 401: status 401, body
 * exactly `Unauthorized\n`, `text/plain; charset=utf-8`, and the fixed
 * `WWW-Authenticate: Basic realm="fuz_forge forge"` challenge. Every git-auth
 * negative on both backends must satisfy this — that uniformity is the point.
 */
const assert_generic_401 = async (res: Response, label: string): Promise<void> => {
	assert.strictEqual(res.status, 401, `${label}: expected 401`);
	assert.strictEqual(
		res.headers.get('content-type'),
		'text/plain; charset=utf-8',
		`${label}: content-type`
	);
	assert.strictEqual(
		res.headers.get('www-authenticate'),
		EXPECTED_WWW_AUTHENTICATE,
		`${label}: WWW-Authenticate challenge`
	);
	const body = await res.text();
	assert.strictEqual(body, EXPECTED_BODY, `${label}: body`);
};

/** Create a forge-hosted repo over the keeper session and return its slug. */
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

describe('git smart-HTTP auth 401 negatives (cross-process, both backends)', () => {
	test('missing Authorization header → generic 401', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/git_auth_missing';
		await create_repo(fixture, slug);

		const res = await fetch(info_refs_url(slug));
		await assert_generic_401(res, 'missing Authorization');
	});

	test('malformed Authorization headers → generic 401', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/git_auth_malformed';
		await create_repo(fixture, slug);

		// Each is a distinct shape violation the parser rejects before any token
		// lookup; all must collapse to the same 401.
		const cases: Array<{ header: string; why: string }> = [
			{ header: 'Basic !!!not-base64!!!', why: 'invalid base64' },
			{ header: `Basic ${Buffer.from('no-colon-here').toString('base64')}`, why: 'no colon' },
			{ header: `Bearer ${Buffer.from('user:pass').toString('base64')}`, why: 'wrong scheme' },
			{ header: 'Basic ', why: 'empty credentials' }
		];
		for (const { header, why } of cases) {
			const res = await fetch(info_refs_url(slug), { headers: { Authorization: header } });
			await assert_generic_401(res, `malformed Authorization (${why})`);
		}
	});

	test('Origin header present (browser-replay defense) → generic 401, even with valid creds', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/git_auth_origin';
		await create_repo(fixture, slug);

		// Valid admin Basic creds, but an Origin header marks this as a browser
		// context — git never sends one, so the gate rejects it before token
		// validation (cross-context replay defense).
		const token = keeper_token(fixture.create_bearer_headers());
		const res = await fetch(info_refs_url(slug), {
			headers: {
				Authorization: basic_header(fixture.account.username, token),
				Origin: base_url
			}
		});
		await assert_generic_401(res, 'Origin present with valid creds');
	});

	test('valid username + wrong password (garbage token) → generic 401', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/git_auth_badpass';
		await create_repo(fixture, slug);

		// A real username paired with a token that validates against no account.
		const res = await fetch(info_refs_url(slug), {
			headers: {
				Authorization: basic_header(fixture.account.username, 'not-a-real-token-xxxxxxxxxxxx')
			}
		});
		await assert_generic_401(res, 'wrong password');
	});

	test('valid non-admin account token → generic 401 (admin-only gate)', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/git_auth_nonadmin';
		await create_repo(fixture, slug);

		// A freshly-minted account with default (non-admin) roles. Its api_token
		// validates fine, but the gate requires the global `admin` role, so the
		// push advertisement is refused with the same generic 401 — no signal that
		// the token was valid-but-underprivileged.
		const non_admin = await fixture.create_account({ username: 'git_auth_non_admin' });
		const token = keeper_token(non_admin.create_bearer_headers());
		const res = await fetch(info_refs_url(slug), {
			headers: { Authorization: basic_header(non_admin.account.username, token) }
		});
		await assert_generic_401(res, 'valid non-admin token');
	});

	test("a deleted admin's api_token → generic 401", async () => {
		const fixture = await setup_test();
		const slug = 'ttt/git_auth_deleted';
		await create_repo(fixture, slug);

		// A second admin, minted through the production offer/accept flow, so
		// the keeper stays available to delete it (the keeper itself is
		// non-removable, and the last-admin guard needs a second one to exist).
		const admin = await fixture.create_account({
			username: 'git_auth_deleted_admin',
			roles: [ROLE_ADMIN]
		});
		const token = keeper_token(admin.create_bearer_headers());

		// Control: the credential reaches the advertisement while the account is
		// live, so the 401 below is the deletion and not the slug or the token
		// shape.
		const live = await fetch(info_refs_url(slug), {
			headers: { Authorization: basic_header(admin.account.username, token) }
		});
		assert.strictEqual(live.status, 200, 'a live admin gets the advertisement');

		const deleted = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'account_delete',
			params: { account_id: admin.account.id },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(deleted.ok, `account_delete failed: ${JSON.stringify(deleted)}`);

		// This pins the end-to-end property — a soft-deleted admin can no longer
		// push — and not the git gate's role query in isolation: `account_delete`
		// revokes every api_token on the account, so the refusal lands at token
		// validation on both backends before the role gate is consulted. The
		// state that isolates the role query (a live token whose granting actor
		// is tombstoned) has no wire spelling; it is pinned in-process on TS by
		// `server/routes/repo_git.auth.db.test.ts`.
		const res = await fetch(info_refs_url(slug), {
			headers: { Authorization: basic_header(admin.account.username, token) }
		});
		await assert_generic_401(res, "deleted admin's api_token");
	});

	test('unknown slug → generic 401 identical to an existing-repo auth failure (no existence leak)', async () => {
		const fixture = await setup_test();
		const existing = 'ttt/git_auth_exists';
		await create_repo(fixture, existing);
		// `ttt/git_auth_ghost` is a valid two-segment slug for a repo that was
		// never created.
		const unknown = 'ttt/git_auth_ghost';

		// A valid admin credential against BOTH: the existing repo (cell lookup
		// would pass, but no scoped-token policy is involved → success path is
		// reachable) and the unknown repo (cell lookup misses). To keep both on the
		// auth-failure side and prove non-enumeration, use a wrong password against
		// each — the existing repo's auth fails at token validation, the unknown
		// repo's would fail there too even before the cell lookup. The two 401s must
		// be byte-identical: an unknown repo must not surface a 404 or a different
		// shape.
		const existing_res = await fetch(info_refs_url(existing), {
			headers: { Authorization: basic_header(fixture.account.username, 'wrong-token-aaaa') }
		});
		const unknown_res = await fetch(info_refs_url(unknown), {
			headers: { Authorization: basic_header(fixture.account.username, 'wrong-token-aaaa') }
		});

		await assert_generic_401(existing_res, 'existing repo + wrong password');
		await assert_generic_401(unknown_res, 'unknown slug + wrong password');

		// Also prove the unknown-slug rejection is identical even with a VALID
		// admin credential — the cell lookup miss must not distinguish itself from
		// an auth failure (it returns the same generic 401, not a 404).
		const token = keeper_token(fixture.create_bearer_headers());
		const unknown_valid_creds = await fetch(info_refs_url(unknown), {
			headers: { Authorization: basic_header(fixture.account.username, token) }
		});
		await assert_generic_401(unknown_valid_creds, 'unknown slug + valid admin creds');
	});

	test("a scoped forge_push token reaches its own repo's push advertisement, no other", async () => {
		// The per-token policy row is what narrows a scoped token on git: a
		// backend that read no policy here would fall to the token's spine scope
		// and refuse its own repo too, so the 200 is the policy read's pin.
		const fixture = await setup_test();
		const repo_id = async (slug: string): Promise<string> => {
			const created = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_create',
				params: { slug, default_branch: 'main' },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(created.ok, `create ${slug}: ${JSON.stringify(created)}`);
			return (created.result as { repo: { id: string } }).repo.id;
		};
		const own = await repo_id('ttt/scoped_own');
		await repo_id('ttt/scoped_other');
		const minted = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'git push scope',
				template: { kind: 'forge_push', repo_ids: [own] },
				lifetime: { kind: 'eternal' }
			},
			headers: fixture.create_session_headers()
		});
		assert.isTrue(minted.ok, `mint: ${JSON.stringify(minted)}`);
		const token = (minted.result as { token: string }).token;
		const authorization = basic_header(fixture.account.username, token);

		const allowed = await fetch(info_refs_url('ttt/scoped_own'), {
			headers: { Authorization: authorization }
		});
		assert.strictEqual(allowed.status, 200, 'its own repo');
		await allowed.body?.cancel();
		await assert_generic_401(
			await fetch(info_refs_url('ttt/scoped_other'), { headers: { Authorization: authorization } }),
			'another repo'
		);
	});

	test('a cell of another kind at a repo path → generic 401 with valid admin creds', async () => {
		const fixture = await setup_test();
		// An admin can `cell_create` any kind at any path, so a `repos/<slug>` path
		// alone doesn't make a hosted repo: the lookup also requires `kind =
		// 'repo'` on both backends.
		const slug = 'ttt/git_auth_note';
		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'cell_create',
			params: { kind: 'note', path: `repos/${slug}`, data: {} },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `cell_create: ${JSON.stringify(created)}`);
		const token = keeper_token(fixture.create_bearer_headers());
		const res = await fetch(info_refs_url(slug), {
			headers: { Authorization: basic_header(fixture.account.username, token) }
		});
		await assert_generic_401(res, 'a note cell at repos/<slug>');
	});
});
