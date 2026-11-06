/**
 * Cross-process integration suite for the **loopback-gated internal callback
 * 401 negatives** (`POST /internal/repo-receive-callback`) — run against BOTH
 * fuz_forge backends (Deno/Hono + Rust `fuz_forge_server`, Axum) via the
 * `cross_backend_*` mechanism. It pins the anti-enumeration failure posture of
 * the post-receive hook callback: every reachable rejection is the *same* bare
 * 401 — same status, same plain-text body, NO `WWW-Authenticate`, no JSON
 * envelope and no Zod/serde issue list that would leak the schema shape.
 *
 * **Why this is a parity probe (not duplicated coverage).** `repo_push.cross`
 * drives the *success* callback (default-branch push → `head_sha` update); it
 * never exercises the callback's auth-failure surface. This endpoint is a
 * defense-in-depth seam — it accepts no account credential, only a same-host
 * connection + a per-repo shared secret — so its failure shape is the whole
 * security contract, and it must be byte-identical across backends. A divergence
 * (one backend 400ing a malformed body with serde/Zod issues while the other
 * 401s) would let an attacker who reached the endpoint enumerate the body schema
 * against the leakier backend. Both render the rejection from one helper — TS
 * `unauthorized` (`repo_internal.ts` → `inhandler_auth.ts`), Rust `unauthorized`
 * (`internal_routes.rs`).
 *
 * **The malformed-body case is the load-bearing assertion.** Both backends set
 * the route's pre-handler input schema to "none" and validate the body *inside*
 * the handler, *after* the loopback + secret-header gate (TS `input: z.null()`
 * → in-handler `RepoReceiveCallbackBody.safeParse`; Rust `serde_json::from_slice`
 * after `pre_auth_ok`). So a malformed JSON body returns the bare 401 — NOT a
 * 400 with a validation-issue list — closing the schema-enumeration window.
 *
 * **Loopback note.** This test process connects over `127.0.0.1` (the backends
 * bind loopback; the file routes already reach them this way), so the
 * connection IS loopback for every request here. The *non-loopback* reject
 * branch of `pre_auth_ok` therefore can't be exercised from this process —
 * there's no second host to originate from — so it stays covered by each
 * backend's own unit tests. Every negative below is a header/secret-driven
 * branch that IS reachable past the loopback gate.
 *
 * Requires no git/python3 — the callback is hit directly by `fetch`, never via
 * a hook subprocess. `fuz_forge_repo_create` (to get a real `repo_id` whose
 * secret is unknown to this process) is the only backend machinery touched.
 *
 * **The body-strictness case needs a known secret.** Body validation runs
 * *before* the secret compare on both backends, so a malformed body sent with
 * a wrong secret 401s either way and proves nothing. The cell holds only the
 * secret's digest (`hook_secret_hash`) and the plaintext lives in the hook
 * scripts on the daemon's disk, so that case *sets* a secret of its own: it
 * writes that secret's digest onto the cell through `cell_update` (the same
 * move the id-spelling probe makes) and pairs each rejection with a
 * known-secret positive control that returns `{ok: true}` — so the 401 can only
 * be the body schema. It pins the `z.strictObject` /
 * `#[serde(deny_unknown_fields)]` twin (an unknown key at either level), the
 * `.nullable()`-is-not-`.optional()` twin (an absent `pushed_by` /
 * `push_username`), and the full-sha grammar on an update's `new` (the TS
 * `is_full_sha` refinement, the Rust `updates_are_valid`). The same move gives
 * a cell the empty string's digest, to pin that an empty secret header is read
 * as absent rather than compared.
 *
 * **The body cap rides here too.** `/internal/*` is loopback-gated, so this is
 * the one suite that can drive it: an over-cap POST answers the canonical
 * `413 {error: "payload_too_large"}` before the handler's secret compare, on
 * both backends. Rust nested `/internal` under `body_limit_layer` from the
 * start; the TS generic cap covered `/api/*` only, so an oversized callback ran
 * the whole handler and fell out as the bare 401 — the cap now spans every
 * path but the file store and git (`generic_body_cap_middleware` in
 * `server/app_assembly.ts`).
 *
 * One case steps outside the callback: the id-spelling probe drives the
 * sibling `GET /internal/repo-config/{id}` (read-only, so a correct-secret
 * positive control mutates nothing) to pin that a non-canonical UUID
 * spelling of a real repo id is refused by the shared id gate
 * (`is_valid_repo_id` / `RepoId`) even when the secret is right — the one
 * internal-route behavior a wrong-secret negative can never distinguish.
 *
 * **Only a served repo cell names a secret.** The cell layer stores any `data`
 * a caller sends, so a cell can carry a complete repo-shaped `data` with a
 * digest its writer chose. Two fences keep that from reaching the callback:
 * the create authorizer refuses the `repo` and `file` kinds to non-admins
 * (the spine's 403 `cell_create_forbidden`, with an unreserved-kind control),
 * and the lookup admits only `kind = 'repo'` at a `repos/<slug>` path — pinned
 * with the correct secret on cells only the keeper can write (another kind at
 * a repo path, a pathless repo cell, a repo cell outside `repos/`), against a
 * served-repo control.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { ERROR_PAYLOAD_TOO_LARGE } from '@fuzdev/fuz_app/http/error_schemas.ts';
import { hash_blake3 } from '@fuzdev/fuz_util/hash_blake3.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';
import { raw_http_send_head } from '@fuzdev/fuz_app/testing/transports/raw_http.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url } = handle.config;

const CALLBACK_PATH = '/internal/repo-receive-callback';
const SECRET_HEADER = 'X-FuzForge-Repo-Secret';

/** The exact 401 body both backends emit (`inhandler_auth.ts` / `internal_routes.rs`). */
const EXPECTED_BODY = 'Unauthorized\n';

/** The generic 1 MiB cap both backends apply to `/api/*` **and** `/internal/*`. */
const GENERIC_BODY_CAP_BYTES = 1024 * 1024;

/**
 * Assert a response is the bare, anti-enumeration 401: status 401, body exactly
 * `Unauthorized\n`, `text/plain; charset=utf-8`, and — unlike the git gate — NO
 * `WWW-Authenticate` header (this endpoint takes no Basic credential, so it must
 * not advertise one). Every reachable internal-callback negative on both
 * backends satisfies this.
 */
const assert_bare_401 = async (res: Response, label: string): Promise<void> => {
	assert.strictEqual(res.status, 401, `${label}: expected 401`);
	assert.strictEqual(
		res.headers.get('content-type'),
		'text/plain; charset=utf-8',
		`${label}: content-type`
	);
	assert.strictEqual(
		res.headers.get('www-authenticate'),
		null,
		`${label}: internal callback must NOT send a WWW-Authenticate challenge`
	);
	const body = await res.text();
	assert.strictEqual(body, EXPECTED_BODY, `${label}: body`);
};

/** Create a forge-hosted repo over the keeper session and return its cell-id. */
const create_repo = async (
	fixture: Awaited<ReturnType<typeof setup_test>>,
	slug: string
): Promise<string> => {
	const created = await rpc_call({
		app: fixture.transport,
		path: SPINE_RPC_PATH,
		method: 'fuz_forge_repo_create',
		params: { slug, default_branch: 'main' },
		headers: fixture.create_session_headers()
	});
	assert.isTrue(created.ok, `create ${slug} failed: ${JSON.stringify(created)}`);
	return (created.result as { repo: { id: string } }).repo.id;
};

/** A well-formed callback body for a given repo (used in the wrong-secret case). */
const well_formed_body = (repo_id: string): string =>
	JSON.stringify({
		repo_id,
		updates: [{ old: '0'.repeat(40), new: 'a'.repeat(40), ref: 'refs/heads/main' }],
		pushed_by: null,
		push_username: null
	});

/**
 * Give a repo a hook secret this process knows: write its digest onto the
 * repo cell's `hook_secret_hash` over the keeper session, keeping every other
 * key. The digest is the bare-hex BLAKE3 both backends compare against
 * (`hash_hook_secret`); the hooks on disk keep their own secret and stop
 * matching, which no case here exercises.
 *
 * That the generic `cell_get` / `cell_update` reach the repo cell is a
 * **fixture affordance, not a leak**: they are the spine cell bundle's
 * admin-gated raw-cell surfaces, and the caller here is the bootstrap keeper.
 * The forge's own repo read DTO withholds `hook_secret_hash`
 * (`fuz_forge_repo_get` / `fuz_forge_repo_list` project a narrowed shape; the
 * Rust `RepoCellData` carrying it is capped at the crate boundary).
 */
const set_hook_secret = async (
	fixture: Awaited<ReturnType<typeof setup_test>>,
	repo_id: string,
	secret: string
): Promise<void> => {
	const got = await rpc_call({
		app: fixture.transport,
		path: SPINE_RPC_PATH,
		method: 'cell_get',
		params: { id: repo_id },
		headers: fixture.create_session_headers()
	});
	assert.isTrue(got.ok, `cell_get failed: ${JSON.stringify(got)}`);
	const data = (got.result as { cell: { data: Record<string, unknown> } }).cell.data;
	assert.match(String(data.hook_secret_hash), /^[0-9a-f]{64}$/, 'the cell holds a digest');
	assert.notProperty(data, 'hook_secret', 'the cell holds no plaintext secret');
	const updated = await rpc_call({
		app: fixture.transport,
		path: SPINE_RPC_PATH,
		method: 'cell_update',
		params: { cell_id: repo_id, data: { ...data, hook_secret_hash: hash_blake3(secret) } },
		headers: fixture.create_session_headers()
	});
	assert.isTrue(updated.ok, `cell_update failed: ${JSON.stringify(updated)}`);
};

describe('internal callback 401 negatives (cross-process, both backends)', () => {
	test('missing secret header → bare 401', async () => {
		const fixture = await setup_test();
		const repo_id = await create_repo(fixture, 'ttt/internal_missing');

		// No `X-FuzForge-Repo-Secret` → the loopback-phase gate fails on the
		// absent header before any body or cell work.
		const res = await fetch(`${base_url}${CALLBACK_PATH}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: well_formed_body(repo_id)
		});
		await assert_bare_401(res, 'missing secret header');
	});

	test('wrong secret → bare 401', async () => {
		const fixture = await setup_test();
		const repo_id = await create_repo(fixture, 'ttt/internal_wrongsecret');

		// The repo's real secret never crosses the wire (it's minted into the
		// hook scripts on the daemon's disk), so any value we send is wrong — the
		// constant-time digest compare in `verify_repo_secret` fails → 401. The
		// header is present, so this gets past the loopback phase to the
		// secret-mismatch branch.
		const res = await fetch(`${base_url}${CALLBACK_PATH}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: 'definitely-not-the-secret' },
			body: well_formed_body(repo_id)
		});
		await assert_bare_401(res, 'wrong secret');
	});

	test('empty secret header → bare 401 even when the cell holds the empty string’s digest', async () => {
		const fixture = await setup_test();
		const repo_id = await create_repo(fixture, 'ttt/internal_empty');
		// The one cell an empty header could match: an empty value is read as
		// absent on both backends (TS's falsy check, Rust's `secret_header`), so
		// it never reaches the digest compare.
		await set_hook_secret(fixture, repo_id, '');
		const headers = { 'Content-Type': 'application/json', [SECRET_HEADER]: '' };

		await assert_bare_401(
			await fetch(`${base_url}${CALLBACK_PATH}`, {
				method: 'POST',
				headers,
				body: well_formed_body(repo_id)
			}),
			'empty secret on the callback'
		);
		await assert_bare_401(
			await fetch(`${base_url}/internal/repo-config/${repo_id}`, { headers }),
			'empty secret on repo-config'
		);
	});

	test('malformed JSON body (from loopback) → bare 401, not 400 (no schema leak)', async () => {
		const fixture = await setup_test();
		await create_repo(fixture, 'ttt/internal_malformed');

		// Secret header present (passes the loopback phase) + a body that isn't
		// valid JSON. Both backends validate the body in-handler AFTER the gate, so
		// the parse failure returns the bare 401 — NOT a 400 with a serde/Zod issue
		// list. This is the schema-enumeration-closing assertion.
		const res = await fetch(`${base_url}${CALLBACK_PATH}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: 'any-value' },
			body: '{not valid json'
		});
		await assert_bare_401(res, 'malformed JSON body');
	});

	test('Origin header present → bare 401 (browser-replay defense)', async () => {
		const fixture = await setup_test();
		const repo_id = await create_repo(fixture, 'ttt/internal_origin');

		// Hooks never send Origin/Referer; browsers always do. The loopback-phase
		// gate rejects any request carrying one, closing the cross-context replay
		// window if a hook secret leaks — even with the secret header present.
		const res = await fetch(`${base_url}${CALLBACK_PATH}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				[SECRET_HEADER]: 'any-value',
				Origin: base_url
			},
			body: well_formed_body(repo_id)
		});
		await assert_bare_401(res, 'Origin present');
	});

	test('body strictness: extra or absent keys, or a bad sha → bare 401 even with the correct secret', async () => {
		const fixture = await setup_test();
		const repo_id = await create_repo(fixture, 'ttt/internal_strict');
		const secret = 'cross-strict-secret';
		await set_hook_secret(fixture, repo_id, secret);
		const headers = { 'Content-Type': 'application/json', [SECRET_HEADER]: secret };

		const post = (body: unknown): Promise<Response> =>
			fetch(`${base_url}${CALLBACK_PATH}`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body)
			});

		const well_formed = {
			repo_id,
			updates: [{ old: '0'.repeat(40), new: 'a'.repeat(40), ref: 'refs/heads/main' }],
			pushed_by: null,
			push_username: null
		};

		// Unknown key at the top level and inside an update — `z.strictObject`
		// on TS, `#[serde(deny_unknown_fields)]` on Rust.
		await assert_bare_401(await post({ ...well_formed, surprise: 1 }), 'extra top-level key');
		await assert_bare_401(
			await post({
				...well_formed,
				updates: [{ ...well_formed.updates[0], surprise: 1 }]
			}),
			'extra key inside an update'
		);

		// `.nullable()` is not `.optional()`: the hooks always send both push
		// attribution keys, `null` when the push carried no endpoint context.
		for (const key of ['pushed_by', 'push_username'] as const) {
			const body: Record<string, unknown> = { ...well_formed };
			delete body[key];
			await assert_bare_401(await post(body), `absent ${key}`);
		}

		// An update's `new` becomes `head_sha`: a full lowercase 40-hex sha, or
		// the all-zero id of a delete. Anything else is the same bare 401.
		for (const bad of ['abc123', 'A'.repeat(40), 'a'.repeat(64), '', `${'a'.repeat(40)} `]) {
			await assert_bare_401(
				await post({
					...well_formed,
					updates: [{ ...well_formed.updates[0], new: bad }]
				}),
				`new ${JSON.stringify(bad)}`
			);
		}

		// Positive controls on the SAME secret: without the schema violations the
		// callback succeeds, so every 401 above is the body schema and nothing else.
		const ok = await post(well_formed);
		assert.strictEqual(ok.status, 200, 'well-formed body + correct secret must be 200');
		assert.deepEqual(await ok.json(), { ok: true });
		const deleted = await post({
			...well_formed,
			updates: [{ old: 'a'.repeat(40), new: '0'.repeat(40), ref: 'refs/heads/main' }]
		});
		assert.strictEqual(deleted.status, 200, 'the zero sha of a delete is admitted');
	});

	test('over-cap callback body → 413 before the secret compare, on both backends', async () => {
		const fixture = await setup_test();
		await create_repo(fixture, 'ttt/internal_oversized');

		// `cap + 1` — the smallest declared length that trips it, sent as the
		// request head alone (`raw_http_send_head`). The cap refuses on
		// the declared Content-Length; the handler would need the body to reach
		// its own verdict, so with the body withheld a 413 can only be the cap.
		const res = await raw_http_send_head(base_url, {
			path: CALLBACK_PATH,
			headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: 'any-value' },
			content_length: GENERIC_BODY_CAP_BYTES + 1
		});
		assert.strictEqual(res.status, 413, 'the loopback callback is under the generic body cap');
		assert.deepStrictEqual(JSON.parse(res.body), { error: ERROR_PAYLOAD_TOO_LARGE });
	});

	test('non-canonical spelling of a real repo id → bare 401 even with the correct secret', async () => {
		const fixture = await setup_test();
		const repo_id = await create_repo(fixture, 'ttt/internal_spelling');

		const secret = 'cross-spelling-secret';
		await set_hook_secret(fixture, repo_id, secret);

		const config_url = (id: string): string =>
			`${base_url}/internal/repo-config/${encodeURIComponent(id)}`;

		// Positive control: canonical id + real secret → 200 {default_branch}.
		// Without it the 401s below would also pass under a wrong secret and
		// prove nothing about the id gate.
		const ok = await fetch(config_url(repo_id), { headers: { [SECRET_HEADER]: secret } });
		assert.strictEqual(ok.status, 200, 'canonical id + correct secret must be 200');
		const body = (await ok.json()) as { default_branch: string };
		assert.strictEqual(body.default_branch, 'main');

		// The spellings `Uuid::parse_str` (and Postgres) accept but the wire
		// grammar (`is_valid_repo_id` / `RepoId`) rejects. Pre-unification the
		// Rust backend resolved all three to the same row and answered 200 with
		// the correct secret; both backends must 401 them now.
		for (const spelling of [repo_id.replaceAll('-', ''), `{${repo_id}}`, `urn:uuid:${repo_id}`]) {
			const res = await fetch(config_url(spelling), { headers: { [SECRET_HEADER]: secret } });
			await assert_bare_401(res, `non-canonical spelling ${JSON.stringify(spelling)}`);
		}
	});
});

describe('only a served repo cell names a hook secret (cross-process, both backends)', () => {
	/** A complete repo-shaped `data` whose digest is that of `secret`. */
	const repo_shaped_data = (secret: string) => ({
		slug: 'ttt/spoof',
		name: 'spoof',
		default_branch: 'main',
		hook_secret_hash: hash_blake3(secret)
	});

	/** `cell_create` over `headers`; returns the raw RPC result. */
	const cell_create = (
		fixture: Awaited<ReturnType<typeof setup_test>>,
		headers: Record<string, string>,
		params: Record<string, unknown>
	) =>
		rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'cell_create',
			params,
			headers
		});

	test('a non-admin cannot create a repo or file cell; any other kind stays open', async () => {
		const fixture = await setup_test();
		const roleless = await fixture.create_account();
		const headers = roleless.create_session_headers();
		for (const kind of ['repo', 'file']) {
			const refused = await cell_create(fixture, headers, {
				kind,
				data: repo_shaped_data('spoof-secret')
			});
			assert.isFalse(refused.ok, `${kind}: refused`);
			if (refused.ok) continue;
			assert.strictEqual(refused.status, 403, `${kind}: status`);
			assert.strictEqual(refused.error.code, -32002, `${kind}: forbidden`);
			assert.deepStrictEqual(
				refused.error.data,
				{ reason: 'cell_create_forbidden' },
				`${kind}: the spine's create refusal`
			);
		}
		// Control: the same caller and data under an unreserved kind is admitted,
		// so the refusals are the kind alone.
		const admitted = await cell_create(fixture, headers, {
			kind: 'note',
			data: repo_shaped_data('spoof-secret')
		});
		assert.isTrue(admitted.ok, `note: ${JSON.stringify(admitted)}`);
		if (!admitted.ok) return;

		// Mounting an authorizer moves one answer: an admitted contribution (a
		// create under a parent) is born `moderation: 'approved'`, where the
		// spine's open create leaves it `null`. A root stays unmarked.
		const root = (admitted.result as { cell: { id: string; moderation: unknown } }).cell;
		assert.isNull(root.moderation, 'a root carries no moderation marker');
		const child = await cell_create(fixture, headers, {
			kind: 'note',
			parent_id: root.id,
			data: {}
		});
		assert.isTrue(child.ok, `child: ${JSON.stringify(child)}`);
		if (!child.ok) return;
		assert.strictEqual(
			(child.result as { cell: { moderation: unknown } }).cell.moderation,
			'approved',
			'a contribution under an authorizer is born approved'
		);
	});

	test('the correct secret on a cell that is not a repo at repos/<slug> → bare 401', async () => {
		const fixture = await setup_test();
		const keeper = fixture.create_session_headers();
		const secret = 'cross-spoof-secret';

		// Cells only the keeper can write (a path is admin-only), each holding
		// the repo-shaped data a hook lookup narrows, with a known secret.
		const cases: Array<[string, Record<string, unknown>]> = [
			['another kind at a repo path', { kind: 'note', path: 'repos/ttt/spoof_note' }],
			['a pathless repo cell', { kind: 'repo' }],
			['a repo cell outside repos/', { kind: 'repo', path: 'notes/ttt/spoof' }]
		];
		for (const [label, params] of cases) {
			const created = await cell_create(fixture, keeper, {
				...params,
				data: repo_shaped_data(secret)
			});
			assert.isTrue(created.ok, `${label}: ${JSON.stringify(created)}`);
			if (!created.ok) continue;
			const id = (created.result as { cell: { id: string } }).cell.id;
			await assert_bare_401(
				await fetch(`${base_url}/internal/repo-config/${id}`, {
					headers: { [SECRET_HEADER]: secret }
				}),
				`${label}: repo-config`
			);
			await assert_bare_401(
				await fetch(`${base_url}${CALLBACK_PATH}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: secret },
					body: well_formed_body(id)
				}),
				`${label}: callback`
			);
		}

		// A repo cell at a repo path whose `data` does not narrow is a missing
		// cell, not a fault: the bare 401, never the lookup's 500.
		const partial = await cell_create(fixture, keeper, {
			kind: 'repo',
			path: 'repos/ttt/spoof_partial',
			data: { hook_secret_hash: hash_blake3(secret) }
		});
		assert.isTrue(partial.ok, `partial: ${JSON.stringify(partial)}`);
		if (partial.ok) {
			const id = (partial.result as { cell: { id: string } }).cell.id;
			await assert_bare_401(
				await fetch(`${base_url}/internal/repo-config/${id}`, {
					headers: { [SECRET_HEADER]: secret }
				}),
				'partial data: repo-config'
			);
			await assert_bare_401(
				await fetch(`${base_url}${CALLBACK_PATH}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: secret },
					body: well_formed_body(id)
				}),
				'partial data: callback'
			);
		}

		// Positive control: a repo the store made, given the same secret, admits.
		const repo_id = await create_repo(fixture, 'ttt/spoof_control');
		await set_hook_secret(fixture, repo_id, secret);
		const ok = await fetch(`${base_url}/internal/repo-config/${repo_id}`, {
			headers: { [SECRET_HEADER]: secret }
		});
		assert.strictEqual(ok.status, 200, 'a served repo with the correct secret');
	});
});
