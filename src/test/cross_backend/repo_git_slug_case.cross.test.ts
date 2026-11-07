/**
 * Cross-process **case-insensitive repo-slug lookup** suite — run against BOTH
 * fuz_forge backends (Deno/Hono + Rust `fuz_forge_server`, Axum) via the
 * `cross_backend_*` mechanism. It pins the operator-approved contract that repo
 * slugs are **case-insensitive** (canonical lowercase): a repo created at a
 * lowercase slug resolves identically when addressed in any case.
 *
 * **Why this is a parity probe.** Creation already folds the slug to lowercase
 * (the TS `RepoSlug` `to_lower_case` and the Rust `validate_repo_slug`), so the
 * cell is always stored at the lowercase `repos/<slug>` path. The fix this guards
 * is the *lookup* side: every cell-path read must lowercase its input slug so a
 * mixed-case address matches the lowercase-stored cell. Two surfaces carry a
 * by-slug lookup on each backend — the git smart-HTTP auth gate
 * (`repo_git_auth.ts` / `forge_git/auth.rs`) and the `fuz_forge_repo_get` RPC
 * (`fuz_forge_repo_read.ts` / `handlers/repo_read.rs`). serde does not fold like the TS
 * `.transform`, so without the Rust-side `to_lowercase` the two backends would
 * diverge on mixed-case input; this asserts both fold identically.
 *
 * (a) the git `info/refs` gate resolves a MIXED-CASE `.git` URL to the
 *     lowercase-stored repo (it does NOT 401-as-unknown — it reaches the
 *     subprocess and advertises like the lowercase form), and
 * (b) `fuz_forge_repo_get {slug: <mixed-case>}` returns the SAME cell `id` as
 *     the lowercase form.
 *
 * The git probe needs a valid admin credential (the gate folds the slug only
 * after the Origin → Basic → token → admin checks pass) — the bootstrapped
 * keeper holds the global `admin` role, so its api_token is the Basic password.
 * Requires `git` + `python3` on the host (a successful `info/refs` reaches the
 * `git http-backend` subprocess); both are present wherever the cross suites
 * run.
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

/** Build the push advertisement `info/refs` URL for `<slug>.git` (both backends). */
const info_refs_url = (slug: string): string =>
	`${base_url}/${slug}.git/info/refs?service=git-receive-pack`;

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

describe('case-insensitive repo-slug lookup (cross-process, both backends)', () => {
	test('git info/refs resolves a mixed-case URL slug to the lowercase repo (not 401-as-unknown)', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/slug_case_git';
		await create_repo(fixture, slug);

		const token = keeper_token(fixture.create_bearer_headers());
		const auth = { Authorization: basic_header(fixture.account.username, token) };

		// Sanity: the lowercase form with valid admin creds advertises (200) —
		// it reaches the subprocess past the auth gate + cell lookup.
		const lower = await fetch(info_refs_url(slug), { headers: auth });
		assert.strictEqual(lower.status, 200, 'lowercase slug should advertise refs (200)');

		// The mixed-case form of the SAME slug must resolve identically: the
		// lookup folds it to lowercase, so it matches the stored cell and reaches
		// the subprocess (200) — NOT a 401-as-unknown-slug. Without the lookup
		// fold this would miss the cell and return the generic 401.
		const mixed = await fetch(info_refs_url('TTT/Slug_Case_Git'), { headers: auth });
		assert.notStrictEqual(mixed.status, 401, 'mixed-case slug must not 401-as-unknown');
		assert.strictEqual(
			mixed.status,
			lower.status,
			'mixed-case slug should match the lowercase form'
		);
	});

	test('fuz_forge_repo_get with a mixed-case slug resolves the same cell id as the lowercase form', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/slug_case_rpc';
		await create_repo(fixture, slug);

		const get_by_slug = async (s: string): Promise<{ ok: boolean; id?: string }> => {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_get',
				params: { slug: s },
				headers: fixture.create_session_headers()
			});
			if (!res.ok) return { ok: false };
			return { ok: true, id: (res.result as { repo: { id: string } }).repo.id };
		};

		const lower = await get_by_slug(slug);
		assert.isTrue(lower.ok, 'lowercase slug should resolve');

		// The mixed-case slug folds to lowercase at lookup and resolves the SAME
		// cell — same `id`. On the Rust backend this is the `to_lowercase` in
		// `query_repo_cell_by_slug`; on TS it's the `RepoSlug` `.transform`.
		const mixed = await get_by_slug('TTT/Slug_Case_Rpc');
		assert.isTrue(mixed.ok, 'mixed-case slug should resolve to the lowercase cell');
		assert.strictEqual(mixed.id, lower.id, 'mixed-case slug must resolve the same cell id');
	});
});
