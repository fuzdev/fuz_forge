/**
 * Cross-process integration suite for the file-store **scoped-token
 * capability** gate and the **`acting` actor selector** — run against BOTH
 * fuz_forge backends (the TS/Hono server and the Rust `fuz_forge_server`,
 * Axum) via the shared `cross_backend_*` project mechanism. This is the
 * live-HTTP parity probe for the two branches the in-process
 * `server/routes/files.scoped_token.db.test.ts` covers in-process: it asserts
 * the *same* contract over real HTTP against each spawned binary's real
 * policy-hydration + acting-actor middleware (the in-process test wires
 * `extend_middleware_for_fuz_forge` by hand; the spawned binaries wire it for
 * real).
 *
 * **Why mint scoped tokens via RPC, not direct DB.** The in-process test
 * inserts `fuz_forge_api_token_policy` rows directly via `get_db()`.
 * Cross-process that's impossible for the TS backend (its DB is in-memory,
 * unreachable from this process). So the scoped token is minted
 * through the `fuz_forge_token_create_scoped` RPC — it derives the policy from
 * the template grammar (`policy_from_template`), creates the `api_token` +
 * policy row atomically, and returns the raw token string. Both backends honor
 * the same grammar (`FuzForgeTokenTemplateInput`: `filenames` for file
 * templates, `repo_ids` for forge, `methods` for `rpc_subset`), so each
 * backend's real RPC handler + policy hydration is exercised end-to-end. The
 * minted raw token is then sent as `Authorization: Bearer <token>` against the
 * file routes via a plain `fetch` carrying NO `Origin`/`Referer` (bearer
 * credentials are silently discarded by the auth middleware when an
 * `Origin`/`Referer` is present, so bearer probes must look like non-browser
 * callers). The keeper (the fresh-per-test bootstrapped admin) seeds files +
 * mints the scoped token; the scoped bearer then exercises the per-file gate.
 *
 * The **`acting` actor selector** cases run on the keeper's *unscoped* bearer.
 * Both backends agree on the contract: Rust resolves `acting` via
 * `route_auth::resolve_acting_actor` (foreign id → 400 `actor_not_on_account`,
 * malformed id → 400 `invalid_query_params` via `parse_acting_query`); TS
 * resolves it in the spine's `apply_authorization_phase` over `query: {acting:
 * ActingActor}` + `actor: 'required'`.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { assert_iso8601_seconds } from '@fuzdev/fuz_app/testing/cross_backend/wire_shapes.ts';

import { mint_scoped_token } from './scoped_token_mint.ts';

const handle = inject_backend_handle();
// Keeper holds `[ROLE_KEEPER, ROLE_ADMIN]` by default; `admin` is what
// `fuz_forge_token_create_scoped` requires, so no extra roles needed.
const setup_test = default_cross_process_setup(handle);

const { base_url } = handle.config;

type ScopedFixture = Awaited<ReturnType<typeof setup_test>>;

/**
 * Extract the raw token from a fixture's bearer headers regardless of header
 * key casing (`Authorization` / `authorization`) and strip the `Bearer `
 * scheme prefix.
 */
const keeper_bearer = (fixture: ScopedFixture): string => {
	const headers = fixture.create_bearer_headers();
	const value = headers.Authorization ?? headers.authorization;
	assert.ok(value, 'expected a bearer Authorization header');
	return value.replace(/^Bearer /, '');
};

// --- raw HTTP helpers against the spawned binary (no cookie jar) ----------
// Bearer credentials are discarded by the auth middleware when an Origin /
// Referer is present, so these requests carry neither header.

const upload_with_bearer = async (
	bearer: string,
	filename: string,
	bytes: Uint8Array
): Promise<Response> =>
	fetch(`${base_url}/api/fuz_forge/files/${filename}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${bearer}`,
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(bytes.length)
		},
		body: bytes as unknown as BodyInit
	});

const download_with_bearer = async (bearer: string, filename: string): Promise<Response> =>
	fetch(`${base_url}/api/fuz_forge/files/${filename}`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${bearer}` }
	});

const list_with_bearer = async (bearer: string): Promise<Response> =>
	fetch(`${base_url}/api/fuz_forge/files`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${bearer}` }
	});

const delete_with_bearer = async (bearer: string, filename: string): Promise<Response> =>
	fetch(`${base_url}/api/fuz_forge/files/${filename}`, {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${bearer}` }
	});

/** Seed a file with the keeper's unscoped bearer (full file-store surface). */
const seed = async (fixture: ScopedFixture, filename: string, bytes: Uint8Array): Promise<void> => {
	const res = await fetch(`${base_url}/api/fuz_forge/files/${filename}`, {
		method: 'POST',
		headers: {
			...fixture.create_bearer_headers(),
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(bytes.length)
		},
		body: bytes as unknown as BodyInit
	});
	assert.strictEqual(res.status, 200, `seed of ${filename} failed: ${res.status}`);
};

describe('files scoped-token gating (cross-process, both backends)', () => {
	describe('files_read scoped token', () => {
		test('read allowed for permitted filename, denied for others; write + delete denied', async () => {
			const fixture = await setup_test();

			await seed(fixture, 'read_allowed.bin', new Uint8Array([1, 2, 3]));
			await seed(fixture, 'read_denied.bin', new Uint8Array([4, 5, 6]));

			const { token } = await mint_scoped_token(
				fixture,
				{ kind: 'files_read', filenames: ['read_allowed.bin'] },
				'read allowed only'
			);

			// Read permitted file → 200.
			const allowed = await download_with_bearer(token, 'read_allowed.bin');
			assert.strictEqual(allowed.status, 200);

			// Read other file → 403 with the exact required-capability body.
			const denied = await download_with_bearer(token, 'read_denied.bin');
			assert.strictEqual(denied.status, 403);
			const denied_body = (await denied.json()) as { error: string; required: string };
			assert.strictEqual(denied_body.error, 'forbidden');
			assert.strictEqual(denied_body.required, 'files.read:read_denied.bin');

			// Write denied (files_read doesn't grant write).
			const write_denied = await upload_with_bearer(token, 'read_allowed.bin', new Uint8Array([9]));
			assert.strictEqual(write_denied.status, 403);
			const write_body = (await write_denied.json()) as { error: string; required: string };
			assert.strictEqual(write_body.required, 'files.write:read_allowed.bin');

			// Delete denied.
			const delete_denied = await delete_with_bearer(token, 'read_allowed.bin');
			assert.strictEqual(delete_denied.status, 403);
			const delete_body = (await delete_denied.json()) as { error: string; required: string };
			assert.strictEqual(delete_body.required, 'files.delete:read_allowed.bin');
		});

		test('list filters to readable entries only', async () => {
			const fixture = await setup_test();

			await seed(fixture, 'list_visible.bin', new Uint8Array([1]));
			await seed(fixture, 'list_hidden_a.bin', new Uint8Array([2]));
			await seed(fixture, 'list_hidden_b.bin', new Uint8Array([3]));

			const { token } = await mint_scoped_token(
				fixture,
				{ kind: 'files_read', filenames: ['list_visible.bin'] },
				'read one for list'
			);

			const res = await list_with_bearer(token);
			assert.strictEqual(res.status, 200);
			const body = (await res.json()) as { files: Array<{ filename: string }> };
			assert.deepStrictEqual(
				body.files.map((f) => f.filename),
				['list_visible.bin']
			);
		});

		test('wildcard read lists everything', async () => {
			const fixture = await setup_test();

			await seed(fixture, 'wild_a.bin', new Uint8Array([1]));
			await seed(fixture, 'wild_b.bin', new Uint8Array([2]));

			const { token } = await mint_scoped_token(
				fixture,
				{ kind: 'files_read', filenames: '*' },
				'wildcard read'
			);

			const res = await list_with_bearer(token);
			assert.strictEqual(res.status, 200);
			const body = (await res.json()) as { files: Array<{ filename: string }> };
			assert.deepStrictEqual(body.files.map((f) => f.filename).sort(), [
				'wild_a.bin',
				'wild_b.bin'
			]);
		});
	});

	describe('files_write scoped token', () => {
		test('upload allowed for permitted filename, denied for others', async () => {
			const fixture = await setup_test();

			const { token } = await mint_scoped_token(
				fixture,
				{ kind: 'files_write', filenames: ['can_write.bin'] },
				'write one'
			);

			const ok = await upload_with_bearer(token, 'can_write.bin', new Uint8Array([1, 2, 3]));
			assert.strictEqual(ok.status, 200);

			const bad = await upload_with_bearer(token, 'cannot_write.bin', new Uint8Array([1, 2, 3]));
			assert.strictEqual(bad.status, 403);
			const bad_body = (await bad.json()) as { error: string; required: string };
			assert.strictEqual(bad_body.required, 'files.write:cannot_write.bin');
		});

		test("write doesn't grant read", async () => {
			const fixture = await setup_test();

			// Seed via the keeper so the file exists.
			await seed(fixture, 'write_no_read.bin', new Uint8Array([1, 2, 3]));

			const { token } = await mint_scoped_token(
				fixture,
				{ kind: 'files_write', filenames: '*' },
				'write wildcard'
			);

			const res = await download_with_bearer(token, 'write_no_read.bin');
			assert.strictEqual(res.status, 403);
			const body = (await res.json()) as { error: string; required: string };
			assert.strictEqual(body.required, 'files.read:write_no_read.bin');
		});
	});

	describe('rpc_subset (deny-all for files) policy', () => {
		// `rpc_subset` grants only the listed RPC methods and no file
		// capabilities — so it's a deny-all from the file routes' view: every
		// file op is refused except `list`, which filters to the (empty)
		// readable set rather than 403ing.
		test('upload/download/delete denied; list returns empty', async () => {
			const fixture = await setup_test();

			await seed(fixture, 'denyall_seed.bin', new Uint8Array([1]));

			const { token } = await mint_scoped_token(
				fixture,
				{ kind: 'rpc_subset', methods: ['fuz_forge_repo_log'] },
				'rpc only'
			);

			const up = await upload_with_bearer(token, 'denyall_new.bin', new Uint8Array([1]));
			const dl = await download_with_bearer(token, 'denyall_seed.bin');
			const ls = await list_with_bearer(token);
			const del = await delete_with_bearer(token, 'denyall_seed.bin');

			assert.strictEqual(up.status, 403);
			assert.strictEqual(dl.status, 403);
			assert.strictEqual(ls.status, 200); // list is filter-not-403
			const ls_body = (await ls.json()) as { files: Array<unknown> };
			assert.strictEqual(ls_body.files.length, 0);
			assert.strictEqual(del.status, 403);
		});
	});

	describe('unscoped token regression', () => {
		// Guard: the keeper's own bearer carries no policy row, so the policy
		// gate must fall through to role-gate-only (full surface). This path
		// doesn't go through the mint RPC, so it runs on both backends. Largely
		// covered by the standard cross suite; kept here as a co-located guard.
		test('keeper bearer with no policy row sees full surface', async () => {
			const fixture = await setup_test();
			const bearer = keeper_bearer(fixture);

			const up = await upload_with_bearer(bearer, 'unscoped_free.bin', new Uint8Array([1, 2, 3]));
			assert.strictEqual(up.status, 200);

			const dl = await download_with_bearer(bearer, 'unscoped_free.bin');
			assert.strictEqual(dl.status, 200);

			const del = await delete_with_bearer(bearer, 'unscoped_free.bin');
			assert.strictEqual(del.status, 200);
		});
	});
});

describe('path-structured keys (cross-process, both backends)', () => {
	// The file store accepts native `/`-bearing keys (the rustup-style release
	// layout, `tools/<name>/<version>/...`) on both backends — the `ForgeStorage`
	// producer no longer `~`-encodes them. These run on the keeper's unscoped
	// bearer (full file-store surface).

	test('upload → download → ?meta round-trips a tools/<name>/... key', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const filename = 'tools/zap/0.1.0/zap-0.1.0-x86_64-unknown-linux-gnu.tar.gz';
		const bytes = new Uint8Array([7, 8, 9, 10]);

		const up = await upload_with_bearer(bearer, filename, bytes);
		assert.strictEqual(up.status, 200, `upload failed: ${up.status}`);
		const up_body = (await up.json()) as { filename: string };
		assert.strictEqual(up_body.filename, filename);

		const dl = await download_with_bearer(bearer, filename);
		assert.strictEqual(dl.status, 200);
		const got = new Uint8Array(await dl.arrayBuffer());
		assert.deepStrictEqual(Array.from(got), Array.from(bytes));

		// `?meta` on the same catch-all path returns metadata JSON, not bytes.
		const meta = await fetch(`${base_url}/api/fuz_forge/files/${filename}?meta`, {
			headers: { Authorization: `Bearer ${bearer}` }
		});
		assert.strictEqual(meta.status, 200);
		const meta_body = (await meta.json()) as {
			filename: string;
			blake3_hash: string;
			uploaded_at: string;
		};
		assert.strictEqual(meta_body.filename, filename);
		assert_iso8601_seconds(meta_body.uploaded_at, 'file ?meta uploaded_at');
	});

	// Validation-parity table — both backends must accept/reject the SAME keys.
	// The Rust forge reuses `fuz_storage::validate_forge_key`; the TS forge
	// hand-mirrors it (`is_valid_file_key`), so this is the guard against the two
	// drifting apart on the wire-reachable branches.
	//
	// Limited to keys a spec-compliant URL can carry to the handler: literal `..`/
	// `.` dot-segments (and percent-encoded `%2e`) are normalized away by the URL
	// layer before reaching either server, so those branches are unreachable here
	// and are covered instead by the producer-side `fuz_storage` unit tests (which
	// validate the raw key string before it ever becomes a URL).
	test('both backends accept/reject the same keys', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const cases: Array<{ key: string; valid: boolean; why: string }> = [
			{ key: 'parity_flat.json', valid: true, why: 'flat key' },
			{
				key: 'parity/tools/zap/0.1.0/zap.tar.gz',
				valid: true,
				why: 'path-structured (interior /)'
			},
			{ key: 'parity.mix-of_chars.bin', valid: true, why: 'charset: dot dash underscore' },
			// Forge charset allows uppercase (broader than object storage's lowercase-only key rule).
			{ key: 'Parity.UPPER.json', valid: true, why: 'uppercase allowed' },
			{ key: 'a'.repeat(512), valid: true, why: 'exactly 512 chars (length boundary)' },
			{ key: 'parity/.hidden', valid: false, why: 'leading-dot segment' },
			{ key: 'parity space.bin', valid: false, why: 'out-of-charset (space)' },
			{ key: 'parity*star.bin', valid: false, why: 'out-of-charset (star)' },
			// `~` is the retired `/`->`~` bridge sentinel — confirm it's now an invalid key char.
			{
				key: 'parity~tilde.bin',
				valid: false,
				why: 'out-of-charset (tilde, retired bridge sentinel)'
			},
			{ key: 'a'.repeat(513), valid: false, why: 'exceeds 512 chars (length boundary)' }
		];
		for (const { key, valid, why } of cases) {
			const res = await upload_with_bearer(bearer, key, new Uint8Array([1]));
			const label = `${why}: ${key.slice(0, 40)}`;
			if (valid) {
				assert.strictEqual(res.status, 200, `expected accepted — ${label} (got ${res.status})`);
			} else {
				assert.strictEqual(res.status, 400, `expected rejected — ${label} (got ${res.status})`);
				const body = (await res.json()) as { error: string };
				assert.strictEqual(body.error, 'invalid_route_params', label);
			}
		}
	});
});

describe('acting actor selector (cross-process, both backends)', () => {
	// The file mutation routes (POST upload, DELETE) accept the spine's
	// optional `acting` query param (a bare optional UUID). Over HTTP, with a
	// single-actor keeper, two negative branches are in scope:
	//
	//   - a supplied UUID foreign to the account → 400 actor_not_on_account
	//   - a malformed (non-UUID) `acting` value  → 400 invalid_query_params
	//
	// These run on the keeper's *unscoped* bearer. Both backends agree on the
	// contract: Rust resolves `acting` via `route_auth::resolve_acting_actor`
	// (foreign id → 400 `actor_not_on_account`, malformed id → 400
	// `invalid_query_params` via `parse_acting_query`); TS resolves it in the
	// spine's `apply_authorization_phase` over `query: {acting: ActingActor}` +
	// `actor: 'required'`.
	//
	// The multi-actor `actor_required` branch (omitted `acting` + >1 actor on
	// the account ⇒ 400 with the `available: [...]` list) is NOT testable over
	// HTTP — no multi-actor mint RPC exists to drive an account into a 2-actor
	// state through the wire — and the forge does not cover it: the unit tests
	// in `crates/fuz_forge_server/src/route_auth.rs` cover `parse_acting_query`
	// only. Two-actor exercise of `fuz_auth::resolve_acting_actor` lives
	// upstream, in the spine's `fuz_auth` `account_delete` integration tests.

	// A random v4-shaped UUID that is not an actor on the keeper account.
	const FOREIGN_ACTOR_UUID = '11111111-1111-4111-8111-111111111111';

	const run_acting_upload = async (filename: string, acting: string): Promise<Response> => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const bytes = new Uint8Array([1, 2, 3]);
		return fetch(`${base_url}/api/fuz_forge/files/${filename}?acting=${acting}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${bearer}`,
				'Content-Type': 'application/octet-stream',
				'Content-Length': String(bytes.length)
			},
			body: bytes as unknown as BodyInit
		});
	};

	test('foreign acting UUID on upload → 400 actor_not_on_account', async () => {
		const res = await run_acting_upload('acting_foreign.bin', FOREIGN_ACTOR_UUID);
		assert.strictEqual(res.status, 400);
		const body = (await res.json()) as { error: string };
		assert.strictEqual(body.error, 'actor_not_on_account');
	});

	test('malformed acting value on upload → 400 invalid_query_params', async () => {
		const res = await run_acting_upload('acting_malformed.bin', 'not-a-uuid');
		assert.strictEqual(res.status, 400);
		const body = (await res.json()) as { error: string };
		assert.strictEqual(body.error, 'invalid_query_params');
	});
});

describe('file list sort order (cross-process, both backends)', () => {
	// `GET /api/fuz_forge/files` sorts by filename in byte/codepoint order on
	// BOTH backends (Rust `str::cmp`, TS plain `<`/`>` — not `localeCompare`).
	// The case-mixed set discriminates the two: byte order groups by case
	// (`A`=0x41 < `B`=0x42 < `a`=0x61 < `b`=0x62) where locale collation would
	// interleave (`a, A, b, B`). Keys are ASCII (`FILE_KEY_CHARSET`), so byte
	// order is identical across the two runtimes.
	test('list is byte-sorted, not locale-collated', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		// Upload out of order; the server is responsible for ordering.
		for (const name of ['sort_b.bin', 'sort_A.bin', 'sort_a.bin', 'sort_B.bin']) {
			const up = await upload_with_bearer(bearer, name, new Uint8Array([1]));
			assert.strictEqual(up.status, 200, `upload ${name}`);
		}
		const res = await list_with_bearer(bearer);
		assert.strictEqual(res.status, 200);
		const body = (await res.json()) as { files: Array<{ filename: string }> };
		const ordered = body.files.map((f) => f.filename).filter((f) => f.startsWith('sort_'));
		assert.deepStrictEqual(ordered, ['sort_A.bin', 'sort_B.bin', 'sort_a.bin', 'sort_b.bin']);
	});
});

describe('file metadata wire shape (cross-process, both backends)', () => {
	// `uploaded_at` is the one timestamp the file store puts on the wire, and
	// both of its emitters must render the forge's canonical second-precision
	// UTC form: Rust reads the column through `iso8601_timestamp_column`, TS
	// renders the driver's `Date` through `to_iso8601_seconds`. The `?meta`
	// branch and each list entry share one projection per backend
	// (`file_meta_view` / `FileCellData::to_meta_output`), so both are asserted
	// here — a regression in either would put a millisecond string on one
	// backend.

	test('?meta and the list entry agree on the canonical uploaded_at shape', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const filename = 'meta_shape.bin';

		const up = await upload_with_bearer(bearer, filename, new Uint8Array([4, 5, 6]));
		assert.strictEqual(up.status, 200);

		const meta = await fetch(`${base_url}/api/fuz_forge/files/${filename}?meta`, {
			headers: { Authorization: `Bearer ${bearer}` }
		});
		assert.strictEqual(meta.status, 200);
		const meta_body = (await meta.json()) as { uploaded_at: string };
		assert_iso8601_seconds(meta_body.uploaded_at, 'file ?meta uploaded_at');

		const list = await list_with_bearer(bearer);
		assert.strictEqual(list.status, 200);
		const list_body = (await list.json()) as {
			files: Array<{ filename: string; uploaded_at: string }>;
		};
		const entry = list_body.files.find((f) => f.filename === filename);
		assert.ok(entry, 'uploaded file missing from the list');
		assert_iso8601_seconds(entry.uploaded_at, 'file list uploaded_at');
		// The two surfaces project the same cell through the same helper.
		assert.strictEqual(entry.uploaded_at, meta_body.uploaded_at);
	});
});

describe('strict query params on file mutations (cross-process, both backends)', () => {
	// The POST/DELETE file routes declare a strict `{acting}` query in
	// TS; the Rust twins read the same rule off the raw query
	// (`parse_acting_strict_query` over `has_unknown_query_key`). An
	// unrecognized query key is a 400 `invalid_query_params` on BOTH backends,
	// rejected ahead of auth (the framework validates `query` before the auth
	// gate, and the Rust handler reads the query as its first step). Sent with
	// a valid admin bearer so only the unknown key is at issue. The *accept*
	// half of the same schema — a duplicated `acting` collapsing to its first
	// value — is pinned in `files.cross.test.ts`.

	test('unknown query key on upload → 400 invalid_query_params', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const bytes = new Uint8Array([1, 2, 3]);
		const res = await fetch(`${base_url}/api/fuz_forge/files/strict_upload.bin?bogus=1`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${bearer}`,
				'Content-Type': 'application/octet-stream',
				'Content-Length': String(bytes.length)
			},
			body: bytes as unknown as BodyInit
		});
		assert.strictEqual(res.status, 400);
		const body = (await res.json()) as { error: string };
		assert.strictEqual(body.error, 'invalid_query_params');
	});

	test('unknown query key on delete → 400 invalid_query_params', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const res = await fetch(`${base_url}/api/fuz_forge/files/strict_delete.bin?bogus=1`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${bearer}` }
		});
		assert.strictEqual(res.status, 400);
		const body = (await res.json()) as { error: string };
		assert.strictEqual(body.error, 'invalid_query_params');
	});
});
