/**
 * Cross-process integration suite for the **forge's own non-RPC surfaces** —
 * run against BOTH backends (the Deno/Hono server and the Rust
 * `fuz_forge_server`) via the shared `cross_backend_*` mechanism.
 *
 * ## What this covers that nothing else did
 *
 * Token scoping's RPC-only rule says a narrowed api token reaches **no** non-RPC
 * surface. The spine enforces that over the surfaces the spine mounts, and is
 * structurally blind to a consumer's — a gap fuz_app's own docs name and hand
 * to each consumer.
 *
 * The forge mounts two of its own: the **file store**
 * (`/api/fuz_forge/files/*`) and **git smart-HTTP** (`/<slug>.git/*`). Neither
 * consulted the scope until now. The sibling `db_admin_session_only` suite
 * covers the third, a spine route the TS backend re-auths (now channel-gated
 * to sessions, so no bearer reaches it at all); `rpc_scoped_token` /
 * `ws_scoped_token` cover the spine's own arms. None of them fires at these two.
 *
 * ## Why the token is minted through the *spine's* `account_token_create`
 *
 * Because that is the token shape that was actually reaching these routes. The
 * forge's own `fuz_forge_token_create_scoped` writes a spine scope **and** a
 * `fuz_forge_api_token_policy` row, so a denial under that token could come
 * from either layer. `account_token_create` — which the forge mounts, by way of
 * `create_standard_rpc_actions` — writes the scope and **no policy row**, and
 * `policy_check(null, …)` allows. So every resource-bound gate on these
 * surfaces passes it, and only the scope gate refuses it.
 *
 * That makes the probe an isolation of the scope gate rather than a
 * re-assertion of the policy gate beneath it, and it is not vacuous: strip the
 * scope gate and the file-store reads answer **200** and the git fetch **200**,
 * not 403/401.
 *
 * The positive control is a **full** token minted the same way — same channel,
 * same absent policy row — so a backend that simply refused every policy-less
 * bearer could not pass the denials vacuously.
 *
 * Probes carry NO `Origin`/`Referer`: the auth middleware discards bearer
 * credentials when one is present, so a scoped token must look like a
 * non-browser caller for the gate to see a scope at all.
 *
 * ## Why the two surfaces assert different things
 *
 * The file store is a route spec on both backends, so it answers the spine's
 * one flat surface-denial body (`{error, required_scope}` at 403) and the body
 * is asserted exactly. Git smart-HTTP is locked down: every failure — bad
 * token, wrong role, unknown repo, refused scope — returns the **same generic
 * 401**, deliberately, so a prober learns nothing from the shape and a git
 * client is never handed JSON it cannot render. So the git case asserts the
 * refusal and the *indistinguishability*, which is that surface's actual
 * contract.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { mint_narrowed_api_token } from '@fuzdev/fuz_app/testing/cross_backend/narrowed_api_token.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';

import { mint_spine_full_token, scoped_token_surface_denial_body } from './scoped_token_mint.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url, rpc_path } = handle.config;

/**
 * A method the narrowed token *does* name.
 *
 * Load-bearing: it proves the refusals below are the surface gate rather than a
 * backend rejecting the token outright. `fuz_forge_repo_list` is mounted on
 * both backends and needs no fixture.
 */
const ADMITTED_METHOD = 'fuz_forge_repo_list';

/** Every file-store route, read and write alike. */
const FILE_STORE_PROBES = [
	{ name: 'GET /api/fuz_forge/files', path: '/api/fuz_forge/files', method: 'GET' },
	{
		name: 'GET /api/fuz_forge/files/:filename',
		path: '/api/fuz_forge/files/tools/probe.txt',
		method: 'GET'
	},
	{
		name: 'POST /api/fuz_forge/files/:filename',
		path: '/api/fuz_forge/files/tools/probe.txt',
		method: 'POST'
	},
	{
		name: 'DELETE /api/fuz_forge/files/:filename',
		path: '/api/fuz_forge/files/tools/probe.txt',
		method: 'DELETE'
	}
] as const;

const EXPECTED_FILE_STORE_BODY = scoped_token_surface_denial_body('surface:file_store');

const request_with_bearer = async (
	bearer: string,
	path: string,
	method: string
): Promise<{ status: number; body: unknown }> => {
	// the upload is a `raw_body` POST, refused 415 untyped ahead of the token gate
	const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
	if (method === 'POST') headers['Content-Type'] = 'application/octet-stream';
	const res = await fetch(`${base_url}${path}`, { method, headers });
	const text = await res.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, body };
};

/**
 * Git smart-HTTP authenticates over HTTP Basic with the api token as the
 * password; the username is ignored (GitHub/GitLab PAT semantics).
 */
const request_git_with_token = async (
	token: string,
	url: string
): Promise<{ status: number; body: string }> => {
	const res = await fetch(url, {
		headers: { Authorization: `Basic ${btoa(`git:${token}`)}` }
	});
	return { status: res.status, body: await res.text() };
};

/** The fetch advertisement for `<slug>.git`, served by both backends. */
const info_refs_url = (slug: string): string =>
	`${base_url}/${slug}.git/info/refs?service=git-upload-pack`;

/** Create a forge-hosted repo over the keeper session. */
const create_repo = async (
	fixture: Awaited<ReturnType<typeof setup_test>>,
	slug: string
): Promise<void> => {
	const created = await rpc_call({
		app: fixture.transport,
		path: rpc_path,
		method: 'fuz_forge_repo_create',
		params: { slug, default_branch: 'main' },
		headers: fixture.create_session_headers()
	});
	assert.isTrue(created.ok, `create ${slug} failed: ${JSON.stringify(created)}`);
};

describe('consumer non-RPC surfaces refuse a narrowed token (cross-process, both backends)', () => {
	test('a narrowed token is refused at every file-store route', async () => {
		const fixture = await setup_test();
		const token = await mint_narrowed_api_token({
			app: fixture.transport,
			rpc_path,
			session_headers: fixture.create_session_headers(),
			methods: [ADMITTED_METHOD],
			name: 'file store reject probe'
		});

		for (const probe of FILE_STORE_PROBES) {
			const res = await request_with_bearer(token, probe.path, probe.method);
			assert.strictEqual(res.status, 403, `${probe.name} must refuse a narrowed token`);
			assert.deepStrictEqual(res.body, EXPECTED_FILE_STORE_BODY, `${probe.name} denial body`);
		}
	});

	test('a narrowed token is refused at git smart-HTTP', async () => {
		const fixture = await setup_test();
		// A **real** repo, and it is load-bearing. Against a slug that doesn't
		// exist the gate 401s at the cell lookup whatever the scope says, so the
		// refusal would pass with the scope check deleted — which is exactly what
		// the first draft of this case did.
		const slug = 'scope-probe-org/scope-probe-repo';
		await create_repo(fixture, slug);

		const token = await mint_narrowed_api_token({
			app: fixture.transport,
			rpc_path,
			session_headers: fixture.create_session_headers(),
			methods: [ADMITTED_METHOD],
			name: 'git http reject probe'
		});
		const refused = await request_git_with_token(token, info_refs_url(slug));
		assert.strictEqual(refused.status, 401, 'a narrowed token must not reach git smart-HTTP');

		// The positive control that makes the refusal mean something: a full token
		// minted the same way, on the same repo, reaches the advertisement. So the
		// 401 above is the scope gate and not the repo, the role, or the channel.
		const { token: full } = await mint_spine_full_token(fixture, 'git http positive control');
		const admitted = await request_git_with_token(full, info_refs_url(slug));
		assert.strictEqual(
			admitted.status,
			200,
			`a full token should reach git smart-HTTP, got ${admitted.status} ${admitted.body}`
		);

		// The locked-down posture: the scope refusal is byte-identical to every
		// other failure on this route, so a prober cannot tell "your token is
		// narrowed" from "no such repo". Asserting the sameness is the contract —
		// asserting a distinct shape would assert the leak.
		const unauthenticated = await request_git_with_token('not-a-real-token', info_refs_url(slug));
		assert.strictEqual(refused.status, unauthenticated.status);
		assert.strictEqual(refused.body, unauthenticated.body);
	});

	test('the narrowed token still reaches the RPC method it names', async () => {
		const fixture = await setup_test();
		const token = await mint_narrowed_api_token({
			app: fixture.transport,
			rpc_path,
			session_headers: fixture.create_session_headers(),
			methods: [ADMITTED_METHOD],
			name: 'narrowed non-vacuity control'
		});

		const res = await fetch(`${base_url}${rpc_path}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: ADMITTED_METHOD,
				params: {}
			})
		});
		const body = (await res.json()) as { error?: unknown };
		assert.strictEqual(res.status, 200, `${ADMITTED_METHOD} should be admitted by the scope`);
		assert.isUndefined(
			body.error,
			`${ADMITTED_METHOD} is named by the scope and must not be refused: ${JSON.stringify(body)}`
		);
	});

	test('a full token minted the same way still reaches the file store', async () => {
		const fixture = await setup_test();
		// Same channel, same absent forge policy row — only the scope differs. So a
		// backend that refused every policy-less bearer would fail here, and the
		// denials above could not pass vacuously.
		const { token } = await mint_spine_full_token(fixture, 'file store positive control');

		const res = await request_with_bearer(token, '/api/fuz_forge/files', 'GET');
		assert.strictEqual(
			res.status,
			200,
			`a full token should reach the file store, got ${JSON.stringify(res)}`
		);
	});
});
