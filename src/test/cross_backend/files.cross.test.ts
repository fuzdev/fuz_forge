/**
 * Cross-process integration suite for the file store's **CRUD contract** — run
 * against BOTH fuz_forge backends (the Deno/Hono server and the Rust
 * `fuz_forge_server`, Axum) via the shared `cross_backend_*` mechanism.
 *
 * The two existing file suites cover the authority axes
 * (`files_scoped_token.cross.test.ts`) and the streaming/budget edges
 * (`files_disk_budget.cross.test.ts`). This one covers what a client actually
 * does with the store, and the shapes both backends must answer with:
 *
 * - **the upload status matrix** — a new key, an identical re-upload of the
 *   same bytes to the same key, the same bytes under a *different* key, and
 *   different bytes under an existing key. All four answer `200` with the full
 *   upload body; only `status` moves (`created` / `unchanged` / `created` /
 *   `updated`). There is no `201` anywhere on either backend — the cell write
 *   is not the resource identity, the content hash is.
 * - **the `?meta` projection** — exactly `filename`, `blake3_hash`,
 *   `size_bytes`, `content_type`, `uploaded_at`, no more,
 *   with the canonical second-precision `uploaded_at`.
 * - **delete** — `200 {deleted: true, filename}`, after which a read is the
 *   shared `404 {error: 'file_not_found', message: 'File not found'}`; a
 *   delete of an absent key is that same 404.
 * - **the content-type table** — `infer_content_type` is hand-written twice
 *   (`routes/files.ts` ↔ `files/content_type.rs`), so the whole extension map
 *   is pinned literally, including the unlisted extensions that must fall to
 *   `application/octet-stream` rather than growing a new mapping on one side.
 * - **an unbounded list** — a Rust list read through `query_cell_list` with
 *   `limit: CELL_LIST_LIMIT_MAX` silently truncates a store past 200 files
 *   where TS is complete, so the case uploads past that bound and counts every
 *   file back.
 * - **the `acting` phase order on a roleless account** — the actor selector
 *   resolves *before* the role gate on both backends, so a foreign `acting`
 *   UUID is the 400 even for a caller the role gate would refuse, with the
 *   same account's no-`acting` 403 as the control. The same describe pins the
 *   *accept* half of `z.strictObject({acting})`: a duplicated `acting` key
 *   collapses to its first value rather than failing the parse — and the two
 *   grammar edges, a JSON-quoted and a hyphenless UUID, both of which the
 *   bare `Uuid.optional()` (`z.uuid()`) parse refuses on both sides.
 * - **the file cell's fact address** — a file cell whose `blake3` is off the
 *   strict fact-address grammar (uppercase hex, a `sha256:` hash, an SRI
 *   token) is a missing file on both backends: `?meta` and the download 404
 *   and the list skips it. The cells are written through the spine's generic
 *   `cell_create`, the only way a hand-written file cell reaches the store.
 * - **an external row bound to another fact's file** — a file cell whose
 *   `blake3` names a row whose `external_url` is a real stored file of another
 *   fact downloads as the shared 404 on both backends, not that fact's bytes:
 *   each fact store refuses a `file:` URL that is not its own hash's address.
 * - **`?meta` query leniency** — presence, not value, selects the metadata
 *   branch; unknown keys are ignored; and the query is read *after* auth, so
 *   an anonymous caller gets the generic 401 rather than a query-shaped 400.
 *
 * Every request carries the keeper's bearer with NO `Origin`/`Referer` (bearer
 * credentials are discarded by the auth middleware when a browser-context
 * header is present), matching the sibling file suites.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';

import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { cross_put_fact } from '@fuzdev/fuz_app/testing/cross_backend/fact_serving.ts';
import { FACT_EMBEDDED_THRESHOLD_DEFAULT } from '@fuzdev/fuz_app/db/fact_store.ts';
import { hash_blake3 } from '@fuzdev/fuz_util/hash_blake3.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';
import { assert_iso8601_seconds } from '@fuzdev/fuz_app/testing/cross_backend/wire_shapes.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);

const { base_url } = handle.config;

type Fixture = Awaited<ReturnType<typeof setup_test>>;

/**
 * Extract a raw bearer token from a fixture's (or a minted account's) bearer
 * headers regardless of header casing, with the `Bearer ` scheme stripped, so
 * requests can send it with no `Origin`/`Referer`.
 */
const raw_bearer = (create_bearer_headers: () => Record<string, string>): string => {
	const headers = create_bearer_headers();
	const value = headers.Authorization ?? headers.authorization;
	assert.ok(value, 'expected a bearer Authorization header');
	return value.replace(/^Bearer /, '');
};

const keeper_bearer = (fixture: Fixture): string => raw_bearer(fixture.create_bearer_headers);

const upload = async (bearer: string, filename: string, bytes: Uint8Array): Promise<Response> =>
	fetch(`${base_url}/api/fuz_forge/files/${filename}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${bearer}`,
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(bytes.length)
		},
		body: bytes as unknown as BodyInit
	});

const get_file = async (bearer: string, path_and_query: string): Promise<Response> =>
	fetch(`${base_url}/api/fuz_forge/files/${path_and_query}`, {
		headers: { Authorization: `Bearer ${bearer}` }
	});

const list_files = async (bearer: string): Promise<Response> =>
	fetch(`${base_url}/api/fuz_forge/files`, {
		headers: { Authorization: `Bearer ${bearer}` }
	});

const delete_file = async (bearer: string, filename: string): Promise<Response> =>
	fetch(`${base_url}/api/fuz_forge/files/${filename}`, {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${bearer}` }
	});

/** The upload response body both backends answer with, on every status. */
interface UploadBody {
	filename: string;
	blake3_hash: string;
	size_bytes: number;
	content_type: string;
	status: string;
}

const assert_upload_body = (
	body: UploadBody,
	expected: { filename: string; size_bytes: number; content_type: string; status: string },
	label: string
): void => {
	assert.deepStrictEqual(
		Object.keys(body).sort(),
		['blake3_hash', 'content_type', 'filename', 'size_bytes', 'status'],
		`${label}: upload body field set`
	);
	assert.strictEqual(body.filename, expected.filename, `${label}: filename`);
	assert.strictEqual(body.size_bytes, expected.size_bytes, `${label}: size_bytes`);
	assert.strictEqual(body.content_type, expected.content_type, `${label}: content_type`);
	assert.strictEqual(body.status, expected.status, `${label}: status`);
	assert.match(body.blake3_hash, /^[0-9a-f]{64}$/, `${label}: blake3_hash is bare hex`);
};

describe('file store CRUD (cross-process, both backends)', () => {
	test('upload status matrix: created / unchanged / created / updated, all 200', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const other_bytes = new Uint8Array([9, 9, 9]);

		// A new key → created.
		const created = await upload(bearer, 'matrix_a.bin', bytes);
		assert.strictEqual(created.status, 200, 'new key must be 200 (never 201)');
		const created_body = (await created.json()) as UploadBody;
		assert_upload_body(
			created_body,
			{
				filename: 'matrix_a.bin',
				size_bytes: bytes.length,
				content_type: 'application/octet-stream',
				status: 'created'
			},
			'new key'
		);

		// The same bytes to the same key → unchanged (the cell write is skipped).
		const unchanged = await upload(bearer, 'matrix_a.bin', bytes);
		assert.strictEqual(unchanged.status, 200);
		const unchanged_body = (await unchanged.json()) as UploadBody;
		assert_upload_body(
			unchanged_body,
			{
				filename: 'matrix_a.bin',
				size_bytes: bytes.length,
				content_type: 'application/octet-stream',
				status: 'unchanged'
			},
			'identical re-upload'
		);
		assert.strictEqual(
			unchanged_body.blake3_hash,
			created_body.blake3_hash,
			'dedup must report the same hash'
		);

		// The same bytes under a different key → created (the fact dedups, the
		// cell does not).
		const dedup_new_key = await upload(bearer, 'matrix_b.bin', bytes);
		assert.strictEqual(dedup_new_key.status, 200);
		const dedup_body = (await dedup_new_key.json()) as UploadBody;
		assert_upload_body(
			dedup_body,
			{
				filename: 'matrix_b.bin',
				size_bytes: bytes.length,
				content_type: 'application/octet-stream',
				status: 'created'
			},
			'same bytes, new key'
		);
		assert.strictEqual(dedup_body.blake3_hash, created_body.blake3_hash);

		// Different bytes to an existing key → updated.
		const updated = await upload(bearer, 'matrix_a.bin', other_bytes);
		assert.strictEqual(updated.status, 200);
		const updated_body = (await updated.json()) as UploadBody;
		assert_upload_body(
			updated_body,
			{
				filename: 'matrix_a.bin',
				size_bytes: other_bytes.length,
				content_type: 'application/octet-stream',
				status: 'updated'
			},
			'new bytes, existing key'
		);
		assert.notStrictEqual(updated_body.blake3_hash, created_body.blake3_hash);
	});

	test('?meta carries exactly the metadata fields', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const bytes = new Uint8Array([5, 6, 7]);

		const up = await upload(bearer, 'meta_fields.json', bytes);
		assert.strictEqual(up.status, 200);
		const up_body = (await up.json()) as UploadBody;

		const meta = await get_file(bearer, 'meta_fields.json?meta');
		assert.strictEqual(meta.status, 200);
		const meta_body = (await meta.json()) as Record<string, unknown>;
		assert.deepStrictEqual(
			Object.keys(meta_body).sort(),
			['blake3_hash', 'content_type', 'filename', 'size_bytes', 'uploaded_at'],
			'?meta field set'
		);
		assert.strictEqual(meta_body.filename, 'meta_fields.json');
		assert.strictEqual(meta_body.blake3_hash, up_body.blake3_hash);
		assert.strictEqual(meta_body.size_bytes, bytes.length);
		assert.strictEqual(meta_body.content_type, 'application/json');
		assert_iso8601_seconds(meta_body.uploaded_at, '?meta uploaded_at');
	});

	test("an overwritten file lists the overwrite's uploaded_at, as ?meta does", async () => {
		// `uploaded_at` is the cell's `updated_at`, else its `created_at`, on the
		// list and on `?meta` alike. Second precision, so the overwrite waits out
		// the first upload's second: without the wait both timestamps could agree
		// whichever column the list read.
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const first = await upload(bearer, 'overwrite_at.bin', new Uint8Array([1, 2]));
		assert.strictEqual(first.status, 200);
		const first_meta = (await (await get_file(bearer, 'overwrite_at.bin?meta')).json()) as {
			uploaded_at: string;
		};
		await new Promise((resolve) => setTimeout(resolve, 1100));
		const second = await upload(bearer, 'overwrite_at.bin', new Uint8Array([3, 4]));
		assert.strictEqual(second.status, 200);
		const meta = (await (await get_file(bearer, 'overwrite_at.bin?meta')).json()) as {
			uploaded_at: string;
		};
		assert.notStrictEqual(meta.uploaded_at, first_meta.uploaded_at, 'the overwrite moved it');
		const listed = await list_files(bearer);
		assert.strictEqual(listed.status, 200);
		const entry = (
			(await listed.json()) as { files: Array<{ filename: string; uploaded_at: string }> }
		).files.find((f) => f.filename === 'overwrite_at.bin');
		assert.ok(entry, 'listed');
		assert.strictEqual(entry.uploaded_at, meta.uploaded_at, 'list and ?meta agree');
	});

	test('delete → 200, then read → 404; deleting an absent key is the same 404', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);

		await upload(bearer, 'delete_me.bin', new Uint8Array([1]));

		const deleted = await delete_file(bearer, 'delete_me.bin');
		assert.strictEqual(deleted.status, 200, 'delete must be 200 (never 204)');
		assert.deepStrictEqual(await deleted.json(), { deleted: true, filename: 'delete_me.bin' });

		const gone = await get_file(bearer, 'delete_me.bin');
		assert.strictEqual(gone.status, 404);
		assert.deepStrictEqual(await gone.json(), {
			error: 'file_not_found',
			message: 'File not found'
		});

		const gone_meta = await get_file(bearer, 'delete_me.bin?meta');
		assert.strictEqual(gone_meta.status, 404);
		assert.deepStrictEqual(await gone_meta.json(), {
			error: 'file_not_found',
			message: 'File not found'
		});

		// a delete is a soft delete of the cell, and the list reads only live ones
		const listed = await list_files(bearer);
		assert.strictEqual(listed.status, 200);
		const names = ((await listed.json()) as { files: Array<{ filename: string }> }).files.map(
			(f) => f.filename
		);
		assert.notInclude(names, 'delete_me.bin', 'a deleted file is no list entry');

		const delete_absent = await delete_file(bearer, 'never_existed.bin');
		assert.strictEqual(delete_absent.status, 404);
		assert.deepStrictEqual(await delete_absent.json(), {
			error: 'file_not_found',
			message: 'File not found'
		});
	});

	test('content-type inference maps the same extensions to the same types', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		// The whole table, byte-for-byte, plus the extensions that must NOT be
		// mapped — an entry added on one backend only would fail here.
		const cases: Array<[string, string]> = [
			['ct.tar.xz', 'application/x-xz'],
			['ct.tar.gz', 'application/gzip'],
			['ct.tgz', 'application/gzip'],
			['ct.zip', 'application/zip'],
			['ct.png', 'image/png'],
			['ct.ts', 'text/typescript'],
			['ct.json', 'application/json'],
			['ct.txt', 'application/octet-stream'],
			['ct.wasm', 'application/octet-stream'],
			['ct.TAR.GZ', 'application/octet-stream'],
			['ct_noext', 'application/octet-stream']
		];
		for (const [filename, expected] of cases) {
			const up = await upload(bearer, filename, new Uint8Array([1]));
			assert.strictEqual(up.status, 200, `upload ${filename}`);
			const body = (await up.json()) as UploadBody;
			assert.strictEqual(body.content_type, expected, `upload content_type for ${filename}`);

			// The download serves the same inferred type back as its
			// `Content-Type`, so the table is pinned on both surfaces.
			const dl = await get_file(bearer, filename);
			assert.strictEqual(dl.status, 200);
			assert.strictEqual(
				dl.headers.get('content-type'),
				expected,
				`download Content-Type for ${filename}`
			);
			await dl.arrayBuffer();
		}
	});
});

describe('file cell fact address (cross-process, both backends)', () => {
	/** Write a file cell by hand through the spine's admin-gated `cell_create`. */
	const create_file_cell = async (fixture: Fixture, filename: string, blake3: string) => {
		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'cell_create',
			params: {
				path: `files/${filename}`,
				kind: 'file',
				data: { content_type: 'application/octet-stream', size: 3, blake3 }
			},
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `cell_create ${filename}: ${JSON.stringify(created)}`);
	};

	test('a blake3 off the fact-address grammar is a missing file', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const bytes = new Uint8Array([4, 2, 7]);
		const up = await upload(bearer, 'fact_address_real.bin', bytes);
		assert.strictEqual(up.status, 200);
		const hex = hash_blake3(bytes);

		// Positive control through the same hand-written path: the canonical
		// address of a stored fact serves.
		await create_file_cell(fixture, 'fact_address_ok.bin', `blake3:${hex}`);
		const ok = await get_file(bearer, 'fact_address_ok.bin?meta');
		assert.strictEqual(ok.status, 200, 'a canonical fact address serves');

		const spellings: Array<[string, string]> = [
			['upper', `blake3:${hex.toUpperCase()}`],
			['sha256', `sha256:${hex}`],
			['sri', `blake3-${Buffer.from(hex, 'hex').toString('base64')}`]
		];
		for (const [label, blake3] of spellings) {
			const filename = `fact_address_${label}.bin`;
			await create_file_cell(fixture, filename, blake3);
			for (const path of [`${filename}?meta`, filename]) {
				const res = await get_file(bearer, path);
				assert.strictEqual(res.status, 404, `${label} ${path}`);
				assert.deepStrictEqual(
					await res.json(),
					{ error: 'file_not_found', message: 'File not found' },
					`${label} ${path}`
				);
			}
		}

		const listed = await list_files(bearer);
		assert.strictEqual(listed.status, 200);
		const names = ((await listed.json()) as { files: Array<{ filename: string }> }).files.map(
			(f) => f.filename
		);
		assert.include(names, 'fact_address_ok.bin');
		for (const [label] of spellings) {
			assert.notInclude(names, `fact_address_${label}.bin`, `${label} is skipped by the list`);
		}
	});

	test('a pathless file cell is no list entry', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const bytes = new Uint8Array([9, 9, 4]);
		const up = await upload(bearer, 'pathless_control.bin', bytes);
		assert.strictEqual(up.status, 200);

		// A file is addressed by its `files/<key>` path, so a `file` cell with
		// none names no entry; both lists filter it in the scan's SQL.
		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'cell_create',
			params: {
				kind: 'file',
				data: {
					content_type: 'application/octet-stream',
					size: 3,
					blake3: `blake3:${hash_blake3(bytes)}`
				}
			},
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `cell_create: ${JSON.stringify(created)}`);

		const listed = await list_files(bearer);
		assert.strictEqual(listed.status, 200);
		const names = ((await listed.json()) as { files: Array<{ filename: string }> }).files.map(
			(f) => f.filename
		);
		assert.include(names, 'pathless_control.bin');
		assert.isTrue(
			names.every((name) => name.length > 0),
			'no entry without a name'
		);
	});

	test("an external row naming another fact's file downloads as a missing file", async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);

		// fact A: one byte past the embedded threshold, so its bytes are a real
		// file under `facts_dir` at A's own `file:<shard>/<rest>` address
		const bytes = new Uint8Array(FACT_EMBEDDED_THRESHOLD_DEFAULT + 1).fill(7);
		const up = await upload(bearer, 'external_owner.bin', bytes);
		assert.strictEqual(up.status, 200);
		const a_hex = ((await up.json()) as UploadBody).blake3_hash;

		// row B, written past the store: its `external_url` names A's file, so a
		// store that skipped the URL-to-hash binding would serve A's bytes for B
		const b_hash = await cross_put_fact(fixture, SPINE_RPC_PATH, {
			content: 'external-row-naming-another-file',
			external_url: `file:${a_hex.slice(0, 2)}/${a_hex.slice(2)}`
		});
		await create_file_cell(fixture, 'external_foreign.bin', b_hash);

		// positive control: A itself still downloads
		const own = await get_file(bearer, 'external_owner.bin');
		assert.strictEqual(own.status, 200);
		assert.strictEqual((await own.arrayBuffer()).byteLength, bytes.length);

		const res = await get_file(bearer, 'external_foreign.bin');
		assert.strictEqual(res.status, 404, 'a foreign file: URL is a missing file');
		assert.deepStrictEqual(await res.json(), {
			error: 'file_not_found',
			message: 'File not found'
		});
	});
});

describe('file list is unbounded (cross-process, both backends)', () => {
	// A Rust list read through `query_cell_list` carries `limit:
	// CELL_LIST_LIMIT_MAX` (200) where the TS by-kind scan has no limit, so
	// that bound is where the production backend can silently truncate while
	// the reference one stays complete. `BULK_COUNT` sits just
	// past it: enough to catch the truncation, small enough that the slower
	// Deno/in-memory probe stays well inside the timeout.
	const BULK_COUNT = 201;
	/** Concurrent uploads in flight while seeding. */
	const BULK_CONCURRENCY = 8;

	test(`a store of ${BULK_COUNT} files lists all of them`, { timeout: 120_000 }, async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);

		const names = Array.from(
			{ length: BULK_COUNT },
			(_, i) => `bulk_${String(i).padStart(3, '0')}.bin`
		);
		const body = new Uint8Array([1]);
		let next = 0;
		const started = Date.now();
		await Promise.all(
			Array.from({ length: BULK_CONCURRENCY }, async () => {
				for (let i = next++; i < names.length; i = next++) {
					const name = names[i]!;
					const res = await upload(bearer, name, body);
					assert.strictEqual(res.status, 200, `seed ${name}`);
					await res.json();
				}
			})
		);
		const seed_ms = Date.now() - started;

		const res = await list_files(bearer);
		assert.strictEqual(res.status, 200);
		const listed = (await res.json()) as { files: Array<{ filename: string }> };
		const bulk = listed.files.map((f) => f.filename).filter((f) => f.startsWith('bulk_'));
		assert.strictEqual(bulk.length, BULK_COUNT, `list must not truncate (seeded in ${seed_ms}ms)`);
		// Same rule on both backends: byte order over the filename, applied
		// after the full set is read — a truncating read would also change
		// which names survive.
		assert.deepStrictEqual(bulk, [...names]);
	});
});

describe('acting resolves before the role gate (cross-process, both backends)', () => {
	// The TS route runner orders the phases `query validation → pre-authorization
	// (401) → authorization (the `acting` 400s) → post-authorization (the role
	// 403)`, so an account the role gate would refuse still gets the actor
	// selector's 400 first. The Rust file handlers ran the role gate before
	// `resolve_acting_actor` and answered 403 for the same request.
	//
	// The principal is minted the way production mints one — `create_account()`
	// with the default `roles: []`, through invite → signup → login — so it is a
	// real unprivileged account with a full-scope token, leaving the role gate
	// as the only thing that can refuse it.

	/** A v4-shaped UUID that is not an actor on any account under test. */
	const FOREIGN_ACTOR_UUID = '11111111-1111-4111-8111-111111111111';

	test('roleless account + foreign acting UUID → 400 actor_not_on_account', async () => {
		const fixture = await setup_test();
		const account = await fixture.create_account();
		const bearer = raw_bearer(account.create_bearer_headers);
		const bytes = new Uint8Array([1, 2, 3]);

		const res = await fetch(
			`${base_url}/api/fuz_forge/files/roleless_acting.bin?acting=${FOREIGN_ACTOR_UUID}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${bearer}`,
					'Content-Type': 'application/octet-stream',
					'Content-Length': String(bytes.length)
				},
				body: bytes as unknown as BodyInit
			}
		);
		assert.strictEqual(res.status, 400, 'the actor selector is judged before the role gate');
		assert.deepStrictEqual(await res.json(), { error: 'actor_not_on_account' });
	});

	test('roleless account without acting → 403 insufficient_permissions', async () => {
		const fixture = await setup_test();
		const account = await fixture.create_account();
		const bearer = raw_bearer(account.create_bearer_headers);

		// The control the negative above needs: with nothing for the actor phase
		// to refuse, the same account reaches the role gate and is refused there.
		const res = await upload(bearer, 'roleless_plain.bin', new Uint8Array([1, 2, 3]));
		assert.strictEqual(res.status, 403);
		assert.deepStrictEqual(await res.json(), {
			error: 'insufficient_permissions',
			required_roles: ['admin']
		});
	});

	test('a duplicated acting key collapses to its first value', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const own = fixture.actor.id;
		const bytes = new Uint8Array([1, 2, 3]);

		// The other half of `z.strictObject({acting})`: an unknown key fails
		// the parse (pinned in `files_scoped_token.cross.test.ts`), while a
		// *known* key repeated collapses to its first value — that is the
		// record Hono's `c.req.query()` hands the schema. Rust read the query
		// through an axum `Query<T>` extractor, whose serde decode refused a
		// duplicate field outright with a 400.
		const twice = await fetch(
			`${base_url}/api/fuz_forge/files/acting_dup_same.bin?acting=${own}&acting=${own}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${bearer}`,
					'Content-Type': 'application/octet-stream',
					'Content-Length': String(bytes.length)
				},
				body: bytes as unknown as BodyInit
			}
		);
		assert.strictEqual(twice.status, 200, 'a repeated known key is not an unknown key');
		assert_upload_body(
			(await twice.json()) as UploadBody,
			{
				filename: 'acting_dup_same.bin',
				size_bytes: bytes.length,
				content_type: 'application/octet-stream',
				status: 'created'
			},
			'acting twice'
		);

		// First value wins, so the trailing foreign UUID — which alone would be
		// a 400 `actor_not_on_account` — is never read.
		const first_wins = await fetch(
			`${base_url}/api/fuz_forge/files/acting_dup_first.bin?acting=${own}&acting=${FOREIGN_ACTOR_UUID}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${bearer}`,
					'Content-Type': 'application/octet-stream',
					'Content-Length': String(bytes.length)
				},
				body: bytes as unknown as BodyInit
			}
		);
		assert.strictEqual(first_wins.status, 200, 'the first acting value is the one resolved');
		assert_upload_body(
			(await first_wins.json()) as UploadBody,
			{
				filename: 'acting_dup_first.bin',
				size_bytes: bytes.length,
				content_type: 'application/octet-stream',
				status: 'created'
			},
			'acting first wins'
		);
	});

	test('a JSON-quoted acting UUID → 400 invalid_query_params', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const own = fixture.actor.id;
		const bytes = new Uint8Array([1, 2, 3]);

		// `ActingActor` is `Uuid.optional()` read straight off the raw query
		// record, so the only accepted spelling is the bare UUID — which the
		// duplicated-key case above already drives to a 200. The spine's
		// `fuz_auth::acting::parse_acting_selector` used to JSON-parse the value
		// with a raw fallback, so `"<uuid>"` resolved the actor on Rust and
		// failed the Zod parse on TS, across every REST family that reads the
		// selector.
		const res = await fetch(
			`${base_url}/api/fuz_forge/files/acting_quoted.bin?acting=${encodeURIComponent(`"${own}"`)}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${bearer}`,
					'Content-Type': 'application/octet-stream',
					'Content-Length': String(bytes.length)
				},
				body: bytes as unknown as BodyInit
			}
		);
		assert.strictEqual(res.status, 400);
		// `error` only: the TS route runner attaches the Zod `issues` under DEV,
		// which the Rust body has no twin for.
		const body = (await res.json()) as { error: string };
		assert.strictEqual(body.error, 'invalid_query_params');
	});

	test('a hyphenless acting UUID → 400 invalid_query_params', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const bytes = new Uint8Array([1, 2, 3]);

		// The other half of the selector's grammar. `z.uuid()` accepts only the
		// hyphenated 8-4-4-4-12 form with an in-range version/variant nibble,
		// while Rust's `Uuid::parse_str` (and Postgres) also take the
		// hyphenless, braced and URN spellings — so the spine gates on
		// `fuz_http::is_valid_uuid`, the twin of the Zod grammar, before
		// parsing. Without it this spelling resolved an actor on Rust and
		// failed the Zod parse on TS.
		const res = await fetch(
			`${base_url}/api/fuz_forge/files/acting_hyphenless.bin?acting=3f8a1c2e12344abc9def0123456789ab`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${bearer}`,
					'Content-Type': 'application/octet-stream',
					'Content-Length': String(bytes.length)
				},
				body: bytes as unknown as BodyInit
			}
		);
		assert.strictEqual(res.status, 400);
		const body = (await res.json()) as { error: string };
		assert.strictEqual(body.error, 'invalid_query_params');
	});

	test('roleless account + foreign acting UUID on delete → 400 actor_not_on_account', async () => {
		const fixture = await setup_test();
		const account = await fixture.create_account();
		const bearer = raw_bearer(account.create_bearer_headers);

		const res = await fetch(
			`${base_url}/api/fuz_forge/files/roleless_delete.bin?acting=${FOREIGN_ACTOR_UUID}`,
			{ method: 'DELETE', headers: { Authorization: `Bearer ${bearer}` } }
		);
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), { error: 'actor_not_on_account' });
	});
});

describe('?meta query leniency (cross-process, both backends)', () => {
	// `meta` selects the metadata branch by *presence*, whatever its value and
	// however many times it appears; other keys are ignored. The Rust handler
	// took the query through an axum `Query<T>` extractor, which runs
	// before the auth gate and refused a duplicate key with its own pre-auth 400
	// naming the field — the same class the `?service=` convergence closed on the
	// git route. Both backends now read the raw query with WHATWG
	// `application/x-www-form-urlencoded` semantics, first value winning.

	const seed_meta_file = async (bearer: string, bytes: Uint8Array): Promise<void> => {
		const up = await upload(bearer, 'lenient.bin', bytes);
		assert.strictEqual(up.status, 200, 'seed');
		await up.json();
	};

	test('meta present with any value (or none, or twice) selects the metadata branch', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const bytes = new Uint8Array([1, 2, 3]);
		await seed_meta_file(bearer, bytes);

		for (const query of ['?meta', '?meta=', '?meta=1&meta=2', '?meta=0&other=x']) {
			const res = await get_file(bearer, `lenient.bin${query}`);
			assert.strictEqual(res.status, 200, `${query} status`);
			assert.match(
				res.headers.get('content-type') ?? '',
				/^application\/json/,
				`${query} must return metadata JSON`
			);
			const body = (await res.json()) as { filename: string; size_bytes: number };
			assert.strictEqual(body.filename, 'lenient.bin', `${query} body`);
			assert.strictEqual(body.size_bytes, bytes.length, `${query} body`);
		}
	});

	test('a query without meta downloads the bytes', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const bytes = new Uint8Array([1, 2, 3]);
		await seed_meta_file(bearer, bytes);

		const res = await get_file(bearer, 'lenient.bin?other=1');
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get('content-type'), 'application/octet-stream');
		assert.deepStrictEqual(Array.from(new Uint8Array(await res.arrayBuffer())), Array.from(bytes));
	});

	test('an anonymous duplicate-meta query is the generic 401, not a query 400', async () => {
		await setup_test();
		const res = await fetch(`${base_url}/api/fuz_forge/files/lenient.bin?meta=1&meta=2`);
		assert.strictEqual(res.status, 401, 'the query is read after auth');
		assert.deepStrictEqual(await res.json(), { error: 'authentication_required' });
	});
});
