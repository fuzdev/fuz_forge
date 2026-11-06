/**
 * Cell-primary integration tests for `/api/fuz_forge/files/*`.
 *
 * File bytes live in the content-addressed `FactStore`; file metadata lives
 * in a `cell` at the globally unique `files/<filename>` path with the
 * top-level `cell.kind = 'file'`. The cell and the fact are the
 * only two records a file has. These tests pin:
 *
 * - happy-path consistency across `fact` and `cell`
 * - POST idempotency on bytes-and-filename, and the hash-flip case
 * - oversize POST takes the disk-backed `external_url` fact path
 * - DELETE soft-deletes the cell and leaves the fact in place
 * - file cells land at the globally unique `files/<filename>` path
 * - cell path reuse after a soft-delete (partial unique index)
 *
 * A per-suite tmp dir backs the fact-store disk root (large facts spill to
 * disk; see `src/test/CLAUDE.md` "Filesystem Testing"). The DB is truncated
 * per-test by `describe_db`.
 *
 * @module
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, test, describe, beforeAll, afterAll } from 'vitest';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import {
	create_test_app,
	type TestApp,
	type TestAccount
} from '@fuzdev/fuz_app/testing/app_server.ts';
import { create_node_runtime } from '@fuzdev/fuz_app/runtime/node.ts';
import type { AppServerContext } from '@fuzdev/fuz_app/server/app_server_context.ts';
import { Db } from '@fuzdev/fuz_app/db/db.ts';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { fuz_forge_session_config } from '#lib/server/routes/account.ts';
import { create_fuz_forge_app_route_specs } from '#lib/server/routes/fuz_forge_route_specs.ts';
import { PgFactStore } from '@fuzdev/fuz_app/db/fact_store.ts';
import { fact_hash_bytes } from '@fuzdev/fuz_util/fact_hash.ts';
import { fact_disk_path } from '@fuzdev/fuz_app/db/file_fact_url.ts';
import {
	query_cell_get_by_path,
	query_cell_list_by_kind
} from '@fuzdev/fuz_app/db/cell_queries.ts';

import { describe_db } from '../../db_fixture.ts';
import { test_file_route_deps, test_audit_sse_deps } from './fuz_forge_test_helpers.ts';

/** Canonical `cell.path` for a file-store cell — mirrors `files.ts`. */
const file_cell_path = (filename: string): string => `files/${filename}`;

/** Suite-wide fact-store disk root — created once, removed once. */
let disk_root: string;

beforeAll(async () => {
	const tag = randomBytes(16).toString('hex');
	disk_root = join(tmpdir(), `fuz_forge-files-route-facts-${tag}`);
	await mkdir(disk_root, { recursive: true });
});

afterAll(async () => {
	if (disk_root) await rm(disk_root, { recursive: true, force: true });
});

const runtime = create_node_runtime([]);
const log = new Logger('test-files', { level: 'off' });

/** Build a fresh test app with the canonical cell-primary files wiring. */
const build_test_app = async (
	get_db: () => Db,
	options?: {
		embedded_threshold?: number;
		/** Set, the route runs the free-space preflight over the suite's disk root with this margin. */
		free_space_margin_bytes?: number;
	}
): Promise<TestApp> => {
	const create_route_specs = (ctx: AppServerContext) => {
		const query_deps: QueryDeps = { db: ctx.deps.db };
		const fact_store = new PgFactStore({
			deps: query_deps,
			disk_root,
			fs: runtime,
			embedded_threshold: options?.embedded_threshold,
			log
		});
		return create_fuz_forge_app_route_specs(ctx, {
			audit_sse: test_audit_sse_deps(),
			fuz_forge: {
				runtime,
				query_deps,
				seed_from_allow_private_hosts: false,
				log
			},
			files: test_file_route_deps({
				query_deps,
				max_upload_bytes: 16 * 1024 * 1024,
				fact_store,
				...(options?.free_space_margin_bytes === undefined
					? null
					: { disk_root, free_space_margin_bytes: options.free_space_margin_bytes })
			}),
			repo_git: { runtime, query_deps, spawn_streaming: undefined, log },
			repo_internal: {
				query_deps,
				broadcast: {
					fuz_forge_run_created: async () => undefined,
					fuz_forge_run_updated: async () => undefined,
					fuz_forge_repo_updated: async () => undefined
				} as never,
				log,
				get_connection_ip: () => '127.0.0.1'
			},
			version: '0.0.0-test',
			get_uptime_ms: () => 0,
			// The suite's real fact-store root, so an external fact seeded through
			// the file store is streamable through the fact-serving routes too.
			facts_dir: disk_root
		});
	};

	return create_test_app({
		session_options: fuz_forge_session_config,
		create_route_specs,
		db: get_db()
	});
};

const upload = async (
	test_app: TestApp,
	admin: TestAccount,
	filename: string,
	bytes: Uint8Array
): Promise<Response> =>
	test_app.app.request(`/api/fuz_forge/files/${filename}`, {
		method: 'POST',
		headers: admin.create_session_headers({
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(bytes.length)
		}),
		body: bytes as unknown as BodyInit
	});

const delete_file = async (
	test_app: TestApp,
	admin: TestAccount,
	filename: string
): Promise<Response> =>
	test_app.app.request(`/api/fuz_forge/files/${filename}`, {
		method: 'DELETE',
		headers: admin.create_session_headers()
	});

describe_db('files routes (cell-primary)', (get_db) => {
	describe('POST /:filename', () => {
		test('free space short of the declared size plus the margin → 507 storage_full, nothing stored', async () => {
			// a margin no volume satisfies, so the preflight refuses whatever the
			// host has free — the route-level twin of the Rust
			// `check_disk_budget_rejects_over_budget_with_507`
			const test_app = await build_test_app(get_db, {
				free_space_margin_bytes: Number.MAX_SAFE_INTEGER
			});
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			const filename = 'no-room.txt';
			const bytes = new TextEncoder().encode('more than the margin leaves');
			const res = await upload(test_app, admin, filename, bytes);
			assert.strictEqual(res.status, 507);
			assert.deepStrictEqual(await res.json(), { error: 'storage_full' });

			assert.isNull(
				await query_cell_get_by_path({ db: get_db() }, file_cell_path(filename)),
				'a refused upload writes no cell'
			);
			const fact_row = await get_db().query_one(`SELECT hash FROM fact WHERE hash = $1`, [
				fact_hash_bytes(bytes)
			]);
			assert.isUndefined(fact_row, 'a refused upload stores no fact');
		});

		test('the free-space preflight with no margin admits an upload the volume holds', async () => {
			// the control for the case above: the preflight runs over the same disk
			// root and passes, so that refusal is the margin's
			const test_app = await build_test_app(get_db, { free_space_margin_bytes: 0 });
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const bytes = new TextEncoder().encode('fits');
			const res = await upload(test_app, admin, 'room.txt', bytes);
			assert.strictEqual(res.status, 200);
		});

		test('happy path: fact + cell rows are consistent', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			const filename = 'happy-path.txt';
			const bytes = new TextEncoder().encode('hello fact store');
			const res = await upload(test_app, admin, filename, bytes);
			assert.strictEqual(res.status, 200);
			const body = (await res.json()) as Record<string, unknown>;
			assert.strictEqual(body.filename, filename);
			assert.strictEqual(body.status, 'created');

			const expected_hash = fact_hash_bytes(bytes);
			assert.strictEqual(body.blake3_hash, expected_hash.slice('blake3:'.length));
			assert.strictEqual(body.size_bytes, bytes.length);
			assert.strictEqual(body.content_type, 'application/octet-stream');

			const fact_row = await get_db().query_one<{
				bytes: Uint8Array | null;
				external_url: string | null;
				size: number | string;
				content_type: string | null;
			}>(`SELECT bytes, external_url, size, content_type FROM fact WHERE hash = $1`, [
				expected_hash
			]);
			assert.ok(fact_row);
			assert.isNotNull(fact_row.bytes); // tiny payload, embedded
			assert.isNull(fact_row.external_url);
			assert.strictEqual(Number(fact_row.size), bytes.length);
			assert.strictEqual(fact_row.content_type, 'application/octet-stream');

			const cell = await query_cell_get_by_path({ db: get_db() }, file_cell_path(filename));
			assert.ok(cell);
			// `kind` is the top-level `cell.kind` column, no longer inside `data`.
			assert.strictEqual(cell.kind, 'file');
			assert.deepStrictEqual(cell.data, {
				content_type: 'application/octet-stream',
				size: bytes.length,
				blake3: expected_hash
			});
			assert.deepStrictEqual(cell.refs, [expected_hash]);
			assert.strictEqual(cell.created_by, admin.actor.id);
			assert.isNull(cell.updated_by);
			assert.isNull(cell.deleted_at);
		});

		test('an upload records the acting admin as the fact holder, a dedup re-upload too', async () => {
			// the possession record cell ref admission reads — twin of the Rust
			// `handle_upload` `PutOptions { holder: Some(actor_id), .. }`
			const test_app = await build_test_app(get_db);
			const first_admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const second_admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			const filename = 'held.txt';
			const bytes = new TextEncoder().encode('held bytes');
			const hash = fact_hash_bytes(bytes);
			const query_holders = async (): Promise<Array<string>> =>
				(
					await get_db().query<{ actor_id: string }>(
						`SELECT actor_id FROM fact_holder WHERE hash = $1 ORDER BY actor_id`,
						[hash]
					)
				).map((row) => row.actor_id);

			const first = await upload(test_app, first_admin, filename, bytes);
			assert.strictEqual(first.status, 200);
			assert.deepStrictEqual(await query_holders(), [first_admin.actor.id]);

			// identical bytes from another admin: the fact dedups and the cell write
			// is skipped (`unchanged`), but the second uploader still holds them
			const second = await upload(test_app, second_admin, filename, bytes);
			assert.strictEqual(second.status, 200);
			assert.strictEqual(((await second.json()) as Record<string, unknown>).status, 'unchanged');
			assert.deepStrictEqual(
				await query_holders(),
				[first_admin.actor.id, second_admin.actor.id].sort()
			);
		});

		test('POST same bytes + filename: idempotent (status unchanged, one fact)', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			const filename = 'same-bytes.txt';
			const bytes = new TextEncoder().encode('idempotent payload');
			const first = await upload(test_app, admin, filename, bytes);
			assert.strictEqual(first.status, 200);
			assert.strictEqual(((await first.json()) as Record<string, unknown>).status, 'created');

			const second = await upload(test_app, admin, filename, bytes);
			assert.strictEqual(second.status, 200);
			assert.strictEqual(((await second.json()) as Record<string, unknown>).status, 'unchanged');

			const fact_count = await get_db().query_one<{ count: string | number }>(
				`SELECT COUNT(*)::int AS count FROM fact`
			);
			assert.strictEqual(Number(fact_count?.count), 1);

			const cell = await query_cell_get_by_path({ db: get_db() }, file_cell_path(filename));
			assert.ok(cell);
			assert.deepStrictEqual(cell.refs, [fact_hash_bytes(bytes)]);
		});

		test('POST same filename, different bytes: hash flips, old fact stays', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			const filename = 'changing.txt';
			const first_bytes = new TextEncoder().encode('version one');
			const second_bytes = new TextEncoder().encode('version two — different');

			await upload(test_app, admin, filename, first_bytes);
			const first_hash = fact_hash_bytes(first_bytes);

			const second = await upload(test_app, admin, filename, second_bytes);
			assert.strictEqual(second.status, 200);
			assert.strictEqual(((await second.json()) as Record<string, unknown>).status, 'updated');

			const second_hash = fact_hash_bytes(second_bytes);
			assert.notStrictEqual(first_hash, second_hash);

			// Cell points at the new fact.
			const cell = await query_cell_get_by_path({ db: get_db() }, file_cell_path(filename));
			assert.ok(cell);
			assert.deepStrictEqual(cell.refs, [second_hash]);
			assert.strictEqual(cell.updated_by, admin.actor.id);

			// Both facts present — an overwrite leaves the old fact in the store.
			const old_fact = await get_db().query_one(`SELECT 1 AS present FROM fact WHERE hash = $1`, [
				first_hash
			]);
			assert.ok(old_fact);
			const new_fact = await get_db().query_one(`SELECT 1 AS present FROM fact WHERE hash = $1`, [
				second_hash
			]);
			assert.ok(new_fact);
		});

		test('oversize POST takes the disk-backed external_url fact path', async () => {
			// Tiny threshold so a small payload still routes to disk.
			const test_app = await build_test_app(get_db, { embedded_threshold: 8 });
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			const filename = 'oversize.bin';
			const bytes = new TextEncoder().encode('this is well over eight bytes');
			const res = await upload(test_app, admin, filename, bytes);
			assert.strictEqual(res.status, 200);

			const expected_hash = fact_hash_bytes(bytes);
			const fact_row = await get_db().query_one<{
				bytes: Uint8Array | null;
				external_url: string | null;
			}>(`SELECT bytes, external_url FROM fact WHERE hash = $1`, [expected_hash]);
			assert.ok(fact_row);
			assert.isNull(fact_row.bytes);
			const { shard, rest } = fact_disk_path(expected_hash);
			assert.strictEqual(fact_row.external_url, `file:${shard}/${rest}`);

			// Disk file contains the original bytes.
			const on_disk = await readFile(join(disk_root, shard, rest));
			assert.deepStrictEqual(Array.from(on_disk), Array.from(bytes));
		});
	});

	describe('GET /:filename', () => {
		test('download serves bytes + hash header from the cell/fact', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			const filename = 'download.txt';
			const bytes = new TextEncoder().encode('download me');
			await upload(test_app, admin, filename, bytes);

			const res = await test_app.app.request(`/api/fuz_forge/files/${filename}`, {
				method: 'GET',
				headers: admin.create_session_headers()
			});
			assert.strictEqual(res.status, 200);
			assert.strictEqual(
				res.headers.get('X-Blake3-Hash'),
				fact_hash_bytes(bytes).slice('blake3:'.length)
			);
			const got = new Uint8Array(await res.arrayBuffer());
			assert.deepStrictEqual(Array.from(got), Array.from(bytes));
		});

		test('missing file → 404', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const res = await test_app.app.request('/api/fuz_forge/files/nope.txt', {
				method: 'GET',
				headers: admin.create_session_headers()
			});
			assert.strictEqual(res.status, 404);
		});

		test('meta serves the bare-hex blake3 as the only digest', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const filename = 'tool.tar.xz';
			const bytes = new TextEncoder().encode('tool bytes');
			await upload(test_app, admin, filename, bytes);

			const res = await test_app.app.request(`/api/fuz_forge/files/${filename}?meta`, {
				method: 'GET',
				headers: admin.create_session_headers()
			});
			assert.strictEqual(res.status, 200);
			const body = (await res.json()) as Record<string, unknown>;
			assert.strictEqual(body.blake3_hash, fact_hash_bytes(bytes).slice('blake3:'.length));
			assert.isUndefined(body.sha256_hash);
		});
	});

	describe('DELETE /:filename', () => {
		test('cell soft-deleted, fact untouched', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			const filename = 'to-delete.txt';
			const bytes = new TextEncoder().encode('byte payload destined for deletion');
			await upload(test_app, admin, filename, bytes);

			const res = await delete_file(test_app, admin, filename);
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual((await res.json()) as Record<string, unknown>, {
				deleted: true,
				filename
			});

			// Cell soft-deleted (deleted_at set).
			const tombstone_row = await get_db().query_one<{
				deleted_at: Date | null;
				updated_by: string | null;
			}>(`SELECT deleted_at, updated_by FROM cell WHERE path = $1`, [file_cell_path(filename)]);
			assert.ok(tombstone_row);
			assert.isNotNull(tombstone_row.deleted_at);
			assert.strictEqual(tombstone_row.updated_by, admin.actor.id);

			// Fact row intact — GC is deferred.
			const fact_row = await get_db().query_one(`SELECT 1 AS present FROM fact WHERE hash = $1`, [
				fact_hash_bytes(bytes)
			]);
			assert.ok(fact_row);
		});

		test('re-upload after DELETE creates a new cell at the same path (partial unique index)', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			const filename = 'reuploaded.txt';
			const bytes_a = new TextEncoder().encode('round one');
			await upload(test_app, admin, filename, bytes_a);
			await delete_file(test_app, admin, filename);

			const bytes_b = new TextEncoder().encode('round two — fresh start');
			const res = await upload(test_app, admin, filename, bytes_b);
			assert.strictEqual(res.status, 200);
			assert.strictEqual(((await res.json()) as Record<string, unknown>).status, 'created');

			// Active cell exists with the new hash; tombstone still around.
			const active = await query_cell_get_by_path({ db: get_db() }, file_cell_path(filename));
			assert.ok(active);
			assert.isNull(active.deleted_at);
			assert.deepStrictEqual(active.refs, [fact_hash_bytes(bytes_b)]);

			const total_rows = await get_db().query<{ count: string | number }>(
				`SELECT COUNT(*)::int AS count FROM cell WHERE path = $1`,
				[file_cell_path(filename)]
			);
			assert.strictEqual(Number(total_rows[0]?.count), 2);
		});
	});

	describe('file cells at files/<filename>', () => {
		test('each POST lands a cell at its files/<filename> path', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			// Pre-condition: no file cells yet.
			assert.deepStrictEqual(await query_cell_list_by_kind({ db: get_db() }, 'file'), []);

			await upload(test_app, admin, 'first.txt', new TextEncoder().encode('first'));
			const first_cell = await query_cell_get_by_path(
				{ db: get_db() },
				file_cell_path('first.txt')
			);
			assert.ok(first_cell);

			await upload(test_app, admin, 'second.txt', new TextEncoder().encode('second'));
			const second_cell = await query_cell_get_by_path(
				{ db: get_db() },
				file_cell_path('second.txt')
			);
			assert.ok(second_cell);

			// Distinct cells at distinct globally-unique paths.
			assert.notStrictEqual(first_cell.id, second_cell.id);

			// Both file cells are listable by the top-level `cell.kind`.
			const cells = await query_cell_list_by_kind({ db: get_db() }, 'file');
			assert.strictEqual(cells.length, 2);
		});
	});

	describe('path-structured keys (interior /)', () => {
		test('upload → download → ?meta round-trips a tools/<name>/... key', async () => {
			const test_app = await build_test_app(get_db);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });

			// The release layout uses path-structured keys with interior `/`.
			const filename = 'tools/zap/0.1.0/zap-0.1.0-x86_64-unknown-linux-gnu.tar.gz';
			const bytes = new TextEncoder().encode('zap release tarball bytes');

			const up = await upload(test_app, admin, filename, bytes);
			assert.strictEqual(up.status, 200);
			assert.strictEqual(((await up.json()) as Record<string, unknown>).filename, filename);

			// The cell lands at the honest, slash-bearing path (no `~` encoding).
			const cell = await query_cell_get_by_path({ db: get_db() }, file_cell_path(filename));
			assert.ok(cell);
			assert.strictEqual(cell.path, `files/${filename}`);

			// Download serves the bytes back through the catch-all route.
			const dl = await test_app.app.request(`/api/fuz_forge/files/${filename}`, {
				method: 'GET',
				headers: admin.create_session_headers()
			});
			assert.strictEqual(dl.status, 200);
			const got = new Uint8Array(await dl.arrayBuffer());
			assert.deepStrictEqual(Array.from(got), Array.from(bytes));

			// `?meta` on the same catch-all path returns metadata, not bytes.
			const meta = await test_app.app.request(`/api/fuz_forge/files/${filename}?meta`, {
				method: 'GET',
				headers: admin.create_session_headers()
			});
			assert.strictEqual(meta.status, 200);
			const meta_body = (await meta.json()) as Record<string, unknown>;
			assert.strictEqual(meta_body.filename, filename);
			assert.strictEqual(meta_body.blake3_hash, fact_hash_bytes(bytes).slice('blake3:'.length));
		});
	});

	describe('traversal-safe validation', () => {
		// Filenames are DB cell-path keys, not filesystem paths (bytes are
		// content-addressed by blake3), but the route still rejects malformed /
		// traversal-shaped keys with 400 — mirroring `validate_forge_key` and the
		// Rust twin so both backends reject the same set.
		//
		// NB: `..`/`.` dot-segments — literal AND percent-encoded (`%2e%2e`) — are
		// normalized away by the URL layer before reaching the server, so they're
		// unreachable via any spec-compliant client. The `..`/`.` rejection in
		// `validate_forge_key` is defense-in-depth; it's exercised directly by the
		// producer (`fuz_storage` validates the raw key string before building a
		// URL) and the Rust `validate_file_key` unit test. The cases below are the
		// ones a URL *can* carry to the handler.
		const bad_keys = [
			'tools/.hidden', // leading-dot segment (`.hidden` ≠ a dot-segment, not normalized)
			'a//b.json', // empty segment (`//` is preserved by the URL parser)
			'has space.json' // out-of-charset (space → %20 → decodes to space)
		];

		for (const bad of bad_keys) {
			test(`POST ${JSON.stringify(bad)} → 400 invalid_route_params`, async () => {
				const test_app = await build_test_app(get_db);
				const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
				const res = await upload(test_app, admin, bad, new TextEncoder().encode('x'));
				assert.strictEqual(res.status, 400, `expected 400 for ${bad}`);
				assert.strictEqual(
					((await res.json()) as Record<string, unknown>).error,
					'invalid_route_params'
				);
			});
		}
	});
});
