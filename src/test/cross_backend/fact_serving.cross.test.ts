/**
 * Forge-local **fact-serving** cases, run against BOTH forge backends
 * (TS/Hono + Rust `fuz_forge_server`). The shared `@fuzdev/fuz_app` suite,
 * its multi-actor case and its scope-narrowed bearer included, runs in the one
 * call (`spine_suites.cross.test.ts`); both backends mount the pair it drives —
 * TS through `create_serve_cell_fact_route_spec` /
 * `create_serve_fact_route_spec`, Rust through `fuz_fact_serving::fact_routers`.
 *
 * These cases cover what the shared suite structurally
 * cannot: `_testing_put_fact` writes no bytes to disk (an embedded row, or an
 * external row with no file behind it), so nothing upstream drives the
 * disk-CAS read out of `facts_dir`. The file store is the forge's producer of
 * external facts, so an over-threshold upload through it is what puts a real
 * `file:<shard>/<rest>` row in front of the route. With that real file in
 * place, a second row whose `external_url` names it pins the URL-to-hash
 * binding: the upstream case names a file that doesn't exist, so a backend
 * without the binding also 404s there, where here it would serve the other
 * fact's bytes.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { cross_put_fact } from '@fuzdev/fuz_app/testing/cross_backend/fact_serving.ts';
import { FACT_EMBEDDED_THRESHOLD_DEFAULT } from '@fuzdev/fuz_app/db/fact_store.ts';
import {
	cell_create_action_spec,
	cell_list_action_spec
} from '@fuzdev/fuz_app/auth/cell_action_specs.ts';
import { JSONRPC_VERSION } from '@fuzdev/fuz_app/http/jsonrpc.ts';

import { post_rpc_session } from './rpc_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { rpc_path, base_url } = handle.config;

// --- forge-local: the disk-CAS branch ---

/** Deterministic filler so a mismatch reads as an offset, not as noise. */
const filled_bytes = (size: number): Uint8Array => {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = i % 251;
	return bytes;
};

describe('external facts under facts_dir (cross-process, both backends)', () => {
	test('an over-threshold upload serves its bytes through the cell-scoped route', async () => {
		const fixture = await setup_test();
		const bearer_headers = fixture.create_bearer_headers();
		const authorization = bearer_headers.Authorization ?? bearer_headers.authorization;
		assert.ok(authorization, 'expected a bearer Authorization header');

		// One byte past `FACT_EMBEDDED_THRESHOLD_DEFAULT` is the whole point:
		// at or below it the row carries its bytes inline and the route never
		// touches the disk store, which is the shape `_testing_put_fact` already
		// covers upstream. Past it the row records a `file:<shard>/<rest>`
		// `external_url` and the read has to resolve it under `facts_dir`.
		const bytes = filled_bytes(FACT_EMBEDDED_THRESHOLD_DEFAULT + 1);
		const filename = 'external_fact_probe.bin';

		// The file store is the forge's producer of external facts: the upload
		// streams the bytes into the CAS and writes the `files/<filename>` cell
		// that references them.
		const upload = await fetch(`${base_url}/api/fuz_forge/files/${filename}`, {
			method: 'POST',
			headers: {
				Authorization: authorization,
				'Content-Type': 'application/octet-stream',
				'Content-Length': String(bytes.length)
			},
			body: bytes as unknown as BodyInit
		});
		const upload_body = await upload.text();
		assert.strictEqual(upload.status, 200, `upload: ${upload_body}`);
		const uploaded = JSON.parse(upload_body) as { blake3_hash: string; content_type: string };
		assert.match(uploaded.blake3_hash, /^[0-9a-f]{64}$/);
		const hash = `blake3:${uploaded.blake3_hash}`;

		// Recover the referencing cell by the fact it references — the same
		// reverse lookup `cell.refs` exists for, and independent of the file
		// store's `files/<filename>` path convention.
		const listed = await post_rpc_session(fixture, {
			jsonrpc: JSONRPC_VERSION,
			id: 1,
			method: cell_list_action_spec.method,
			params: { ref: hash }
		});
		assert.strictEqual(listed.status, 200, JSON.stringify(listed.body));
		const cells = (listed.body.result as { cells: Array<{ id: string; kind: string }> }).cells;
		assert.strictEqual(cells.length, 1, `expected one cell referencing ${hash}`);
		const cell = cells[0];
		assert.ok(cell);
		assert.strictEqual(cell.kind, 'file');

		// Session-credentialed, like every case in the shared suite: the route
		// resolves its own context from the session middleware's account id.
		const served = await fixture.transport(`/api/cells/${cell.id}/facts/${hash}`, {
			headers: fixture.create_session_headers()
		});
		const served_bytes = new Uint8Array(await served.arrayBuffer());
		assert.strictEqual(served.status, 200, `serve: ${served_bytes.byteLength} bytes`);
		assert.deepStrictEqual(
			{
				content_type: served.headers.get('content-type'),
				nosniff: served.headers.get('x-content-type-options'),
				csp: served.headers.get('content-security-policy'),
				cache_control: served.headers.get('cache-control')
			},
			{
				content_type: uploaded.content_type,
				// The disk-stream branch must carry the same hardening the
				// embedded branch does — a reader of a referencing cell is
				// serving bytes another account uploaded.
				nosniff: 'nosniff',
				csp: "default-src 'none'; sandbox",
				cache_control: 'private, max-age=300'
			}
		);
		assert.deepStrictEqual(served_bytes, bytes);
	});

	test("a row whose external_url names another fact's real file is a masked 404", async () => {
		const fixture = await setup_test();
		const bearer_headers = fixture.create_bearer_headers();
		const authorization = bearer_headers.Authorization ?? bearer_headers.authorization;
		assert.ok(authorization, 'expected a bearer Authorization header');

		// fact A, a real file under `facts_dir` (see the case above)
		const bytes = filled_bytes(FACT_EMBEDDED_THRESHOLD_DEFAULT + 1);
		const upload = await fetch(`${base_url}/api/fuz_forge/files/external_binding_probe.bin`, {
			method: 'POST',
			headers: {
				Authorization: authorization,
				'Content-Type': 'application/octet-stream',
				'Content-Length': String(bytes.length)
			},
			body: bytes as unknown as BodyInit
		});
		const upload_body = await upload.text();
		assert.strictEqual(upload.status, 200, `upload: ${upload_body}`);
		const a_hex = (JSON.parse(upload_body) as { blake3_hash: string }).blake3_hash;

		// row B, written past the store, naming A's file: without the binding
		// check both backends would serve A's bytes under B's hash
		const b_hash = await cross_put_fact(fixture, rpc_path, {
			content: 'external-row-naming-a-real-file',
			external_url: `file:${a_hex.slice(0, 2)}/${a_hex.slice(2)}`
		});
		const created = await post_rpc_session(fixture, {
			jsonrpc: JSONRPC_VERSION,
			id: 1,
			method: cell_create_action_spec.method,
			params: { kind: 'doc', data: { cover: b_hash }, visibility: 'public' }
		});
		assert.strictEqual(created.status, 200, JSON.stringify(created.body));
		const cell_id = (created.body.result as { cell: { id: string } }).cell.id;

		const anon = fixture.fresh_transport({ origin: null });
		const responses: Array<[string, Response]> = [
			['cell-scoped, anonymous', await anon(`/api/cells/${cell_id}/facts/${b_hash}`, {})],
			[
				'bare hash, as admin',
				await fixture.transport(`/api/facts/${b_hash}`, {
					headers: fixture.create_session_headers()
				})
			]
		];
		for (const [label, res] of responses) {
			assert.strictEqual(res.status, 404, `${label}: status`);
			assert.strictEqual(await res.text(), '', `${label}: a masked 404 has no body`);
		}
	});
});
