/**
 * Cross-process integration suite for the file-store **streaming + disk-budget**
 * contract — run against BOTH fuz_forge backends (the Deno/Hono server and the
 * Rust `fuz_forge_server`, Axum) via the shared `cross_backend_*` mechanism.
 *
 * This is the live-HTTP parity probe for the streaming upload path: the TS
 * backend converged to the Rust backend's already-shipped shape (a streaming
 * `put_stream` over `c.req.raw.body`, a `Content-Length` 413 pre-check, a
 * best-effort free-space preflight, a mid-stream `ENOSPC` 507 backstop, an
 * upload semaphore, and an orphan-temp sweep). Both backends now speak one wire
 * contract for the three cases here:
 *
 *   (a) a declared `Content-Length` over the cap → `413 {error: "File too
 *       large: <N> bytes exceeds <M> byte limit"}`;
 *   (b) an empty body → `400 {error: "Empty body"}`;
 *   (c) a normal multi-KB upload round-trips — `put` → `get` returns identical
 *       bytes, and the reported `blake3_hash` and the download's
 *       `x-blake3-hash` header match a local recompute.
 *
 * The cap is shrunk to `FILE_STORE_MAX_BYTES_TEST` (2 MiB) on both backends via
 * `fuz_forge_backend_config.ts`'s `extra_env`, so the 413 case sends ~2 MiB
 * rather than the production-default 10 GiB.
 *
 * **The `507 storage_full` path is not asserted here.** Triggering it
 * deterministically needs a real disk-full (the mid-stream `ENOSPC` backstop)
 * or a free-space margin larger than the host's free disk (the preflight) — the
 * latter would reject *every* upload in the other file cross-suites, so it
 * can't be a shared `extra_env` knob. Both spawns run with a zero margin
 * instead (`fuz_forge_backend_config.ts`), so no upload here depends on how
 * much the host's temp volume has free, and the path is covered in-process on
 * each backend: on TS the shared `has_sufficient_free_space` predicate rows
 * and the fail-open probe (`server/free_space.test.ts`) plus the route's 507
 * under an unsatisfiable margin (`server/routes/files.db.test.ts`); on Rust
 * the same predicate rows and `check_disk_budget`'s 507 and fail-open cases in
 * `crates/fuz_forge_server/src/files/disk_budget.rs`.
 *
 * TODO: pin the preflight's 507 over the wire. The Rust server does not create
 * the fact-store root at boot (the TS server does), so its probe fails open
 * until the first external fact is written and the two backends answer a fresh
 * instance's first uploads differently under a margin the volume can't meet.
 * Once the Rust server creates the root, a spawn pair that uploads nothing
 * else can run with an unsatisfiable margin and assert the 507 on both.
 *
 * Uploads use the keeper's bearer with NO `Origin`/`Referer` (bearer
 * credentials are discarded by the auth middleware when a browser-context
 * header is present), matching `files_scoped_token.cross.test.ts`.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { raw_http_send_head } from '@fuzdev/fuz_app/testing/transports/raw_http.ts';
import { hash_blake3 } from '@fuzdev/fuz_util/hash_blake3.ts';

import { FILE_STORE_MAX_BYTES_TEST } from './fuz_forge_backend_config.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);

const { base_url } = handle.config;

type Fixture = Awaited<ReturnType<typeof setup_test>>;

/**
 * Extract the keeper's raw bearer token (header-casing agnostic, scheme
 * stripped) so uploads can send it with no `Origin`/`Referer`.
 */
const keeper_bearer = (fixture: Fixture): string => {
	const headers = fixture.create_bearer_headers();
	const value = headers.Authorization ?? headers.authorization;
	assert.ok(value, 'expected a bearer Authorization header');
	return value.replace(/^Bearer /, '');
};

/**
 * POST bytes to the file store, whole. For the cases whose verdict the server
 * reaches by reading the body — the over-cap case withholds its body instead
 * (`raw_http_send_head`).
 */
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

const download = async (bearer: string, filename: string): Promise<Response> =>
	fetch(`${base_url}/api/fuz_forge/files/${filename}`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${bearer}` }
	});

describe('file-store streaming + disk budget (cross-process, both backends)', () => {
	test('declared Content-Length over the cap → 413 File too large', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		// ~3 MiB, over the 2 MiB test cap — declared, and not sent. The route's
		// pre-check refuses on the declared `Content-Length` before reading a
		// byte, so the head alone must draw the 413; a handler that read the
		// body first would wait out the probe's timeout instead.
		const declared_bytes = 3 * 1024 * 1024;

		const res = await raw_http_send_head(base_url, {
			path: '/api/fuz_forge/files/too_big.bin',
			headers: {
				Authorization: `Bearer ${bearer}`,
				'Content-Type': 'application/octet-stream'
			},
			content_length: declared_bytes
		});
		assert.strictEqual(res.status, 413, 'over-cap upload must 413');
		const body = JSON.parse(res.body) as { error: string };
		assert.strictEqual(
			body.error,
			`File too large: ${declared_bytes} bytes exceeds ${FILE_STORE_MAX_BYTES_TEST} byte limit`,
			'413 body must carry the canonical File-too-large message'
		);
	});

	test('empty body → 400 Empty body', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);

		const res = await upload(bearer, 'empty.bin', new Uint8Array(0));
		assert.strictEqual(res.status, 400, 'empty upload must 400');
		const body = (await res.json()) as { error: string };
		assert.strictEqual(body.error, 'Empty body');
	});

	test('multi-KB upload round-trips with a matching blake3', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		// A few KB of varied bytes — over a single small chunk, well under the cap.
		const bytes = new Uint8Array(8 * 1024);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;

		const expected_blake3 = hash_blake3(bytes);

		const up = await upload(bearer, 'round_trip.bin', bytes);
		assert.strictEqual(up.status, 200, `upload failed: ${up.status}`);
		const up_body = (await up.json()) as {
			filename: string;
			blake3_hash: string;
			size_bytes: number;
			status: string;
		};
		assert.strictEqual(up_body.filename, 'round_trip.bin');
		assert.strictEqual(up_body.size_bytes, bytes.length);
		assert.strictEqual(up_body.status, 'created');
		assert.strictEqual(up_body.blake3_hash, expected_blake3, 'reported blake3 must match local');

		// Download returns identical bytes.
		const dl = await download(bearer, 'round_trip.bin');
		assert.strictEqual(dl.status, 200);
		// The header is what a client checks the bytes against: the Rust
		// backend streams a disk fact without re-hashing it.
		assert.strictEqual(dl.headers.get('x-blake3-hash'), expected_blake3, 'x-blake3-hash');
		const got = new Uint8Array(await dl.arrayBuffer());
		assert.deepStrictEqual(Array.from(got), Array.from(bytes), 'downloaded bytes must round-trip');

		// Re-uploading identical bytes is idempotent → unchanged (CAS dedup).
		const again = await upload(bearer, 'round_trip.bin', bytes);
		assert.strictEqual(again.status, 200);
		const again_body = (await again.json()) as { status: string; blake3_hash: string };
		assert.strictEqual(again_body.status, 'unchanged', 'identical re-upload must be unchanged');
		assert.strictEqual(again_body.blake3_hash, expected_blake3);
	});
});
