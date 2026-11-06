/**
 * Tests for the internal callback routes.
 *
 * Covers the loopback gate, secret check, Origin/Referer rejection,
 * happy-path cell update + broadcast emission, and head_sha derivation
 * (default-branch update, non-default ref no-op, branch deletion).
 *
 * The hook callbacks address a repo by its cell-id UUID (the value the
 * hook scripts embed), not the slug or the `repos/<slug>` cell path.
 *
 * The actual git protocol (push receive) is tested in
 * `repo_git.integration.db.test.ts`.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { create_test_app, type TestApp } from '@fuzdev/fuz_app/testing/app_server.ts';
import type { AppServerContext } from '@fuzdev/fuz_app/server/app_server_context.ts';
import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import type { JsonObject } from '@fuzdev/fuz_util/json.ts';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { fuz_forge_session_config } from '#lib/server/routes/account.ts';
import { FUZ_FORGE_ORIGIN_CARVE_OUTS } from '#lib/server/app_assembly.ts';
import { create_fuz_forge_app_route_specs } from '#lib/server/routes/fuz_forge_route_specs.ts';
import { repo_cell_path, type RepoCellData } from '#lib/fuz_forge/repo/plan_repo.ts';
import { hash_hook_secret } from '#lib/server/routes/fuz_forge_repo_cell.ts';
import { query_cell_create, query_cell_get_by_path } from '@fuzdev/fuz_app/db/cell_queries.ts';

import { describe_db } from '../../db_fixture.ts';
import {
	test_audit_sse_deps,
	test_file_route_deps,
	test_facts_dir
} from './fuz_forge_test_helpers.ts';

interface BroadcastCall {
	method: string;
	input: unknown;
}

/**
 * Tracking broadcast stub. Records every `fuz_forge_repo_updated` call so
 * tests can assert the payload without needing a real WS transport.
 */
const make_broadcast_stub = () => {
	const calls: Array<BroadcastCall> = [];
	const api = {
		fuz_forge_run_created: async () => undefined,
		fuz_forge_run_updated: async () => undefined,
		fuz_forge_repo_updated: async (input: unknown) => {
			calls.push({ method: 'fuz_forge_repo_updated', input });
		}
	};
	return { api, calls };
};

/**
 * Build the test app. `connection_ip` defaults to `'127.0.0.1'` so the
 * happy-path tests pass the loopback gate; pass a different value to
 * exercise the non-loopback rejection branch (the gate now reads the
 * raw connection IP, not the proxy-resolved `client_ip`, so XFF is
 * no longer a way to fake the source).
 */
const build_test_app = async (get_db: () => Db, options: { connection_ip?: string } = {}) => {
	const log = new Logger('test-repo-internal', { level: 'off' });
	const broadcast = make_broadcast_stub();
	const connection_ip = options.connection_ip ?? '127.0.0.1';
	const create_route_specs = (ctx: AppServerContext) => {
		const query_deps: QueryDeps = { db: ctx.deps.db };
		return create_fuz_forge_app_route_specs(ctx, {
			audit_sse: test_audit_sse_deps(),
			fuz_forge: {
				runtime: undefined as never,
				query_deps,
				seed_from_allow_private_hosts: false,
				log
			},
			files: test_file_route_deps({
				query_deps,
				max_upload_bytes: 1024,
				fact_store: undefined as never
			}),
			repo_git: {
				runtime: undefined as never,
				query_deps,
				spawn_streaming: undefined,
				log
			},
			repo_internal: {
				query_deps,
				broadcast: broadcast.api,
				log,
				get_connection_ip: () => connection_ip
			},
			version: '0.0.0-test',
			get_uptime_ms: () => 0,
			facts_dir: test_facts_dir()
		});
	};
	const test_app = await create_test_app({
		session_options: fuz_forge_session_config,
		create_route_specs,
		db: get_db(),
		roles: [ROLE_ADMIN],
		// production's `/internal/*` carve-out, so the in-handler fences answer
		app_options: { origin_carve_outs: [...FUZ_FORGE_ORIGIN_CARVE_OUTS] }
	});
	return { test_app, broadcast };
};

const HOOK_SECRET = 'secret-1234';
const SLUG = 'fuzdev/fuz_app';
/** A well-formed UUID that no seeded cell uses — exercises the lookup-miss path. */
const ABSENT_UUID = '99999999-9999-4999-8999-999999999999';

/**
 * Seed a repo cell directly so we don't need to apply a full config.
 * Returns the cell-id UUID — the hook callbacks (`repo_id`) key on it,
 * not on the slug or the `repos/<slug>` cell path.
 */
const seed_repo_cell = async (
	db: Db,
	overrides: Partial<RepoCellData> = {}
): Promise<{ cell_id: string }> => {
	const deps: QueryDeps = { db };
	const data: RepoCellData = {
		slug: SLUG,
		name: 'fuz_app',
		default_branch: 'main',
		seed_from: null,
		seed_completed_at: null,
		hook_secret_hash: hash_hook_secret(HOOK_SECRET),
		head_sha: null,
		last_pushed_at: null,
		last_pushed_by: null,
		last_push_username: null,
		...overrides
	};
	const cell = await query_cell_create(deps, { path: repo_cell_path(SLUG), data, kind: 'repo' });
	return { cell_id: cell.id };
};

/** A required repo-cell field `seed_partial_repo_cell` can drop. */
type RequiredRepoCellField = 'slug' | 'name' | 'default_branch' | 'hook_secret_hash';

/** An optional repo-cell field `seed_corrupt_repo_cell` can wrong-type. */
type OptionalRepoCellField = 'seed_from' | 'head_sha' | 'last_pushed_at' | 'last_push_username';

/**
 * Seed a repo cell whose `data` is missing one required field, to exercise
 * `narrow_repo_cell_data`'s null-on-missing through the route. `seed_repo_cell`
 * can't express this — its overrides can only replace values, not delete keys.
 * Each cell takes its own slug so several can coexist under the globally
 * unique `cell.path` index.
 */
const seed_partial_repo_cell = async (
	db: Db,
	drop: RequiredRepoCellField
): Promise<{ cell_id: string }> => {
	const deps: QueryDeps = { db };
	const slug = `fuzdev/partial_${drop}`;
	const data: JsonObject = {
		slug,
		name: `partial_${drop}`,
		default_branch: 'main',
		hook_secret_hash: hash_hook_secret(HOOK_SECRET)
	};
	delete data[drop];
	const cell = await query_cell_create(deps, { path: repo_cell_path(slug), data, kind: 'repo' });
	return { cell_id: cell.id };
};

/**
 * Seed a repo cell whose `data` has every required field but a **wrong-typed**
 * optional one. The narrow rejects rather than coercing to `null`, so the cell
 * reads as missing — the twin of serde failing on the Rust `Option<String>`.
 */
const seed_corrupt_repo_cell = async (
	db: Db,
	field: OptionalRepoCellField,
	value: unknown
): Promise<{ cell_id: string }> => {
	const deps: QueryDeps = { db };
	const slug = `fuzdev/corrupt_${field}`;
	const data = {
		slug,
		name: `corrupt_${field}`,
		default_branch: 'main',
		hook_secret_hash: hash_hook_secret(HOOK_SECRET),
		[field]: value
	} as JsonObject;
	const cell = await query_cell_create(deps, { path: repo_cell_path(slug), data, kind: 'repo' });
	return { cell_id: cell.id };
};

const post_callback = async (
	test_app: TestApp,
	body: unknown,
	extra_headers: Record<string, string> = {}
): Promise<Response> =>
	await test_app.app.request('/internal/repo-receive-callback', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-FuzForge-Repo-Secret': HOOK_SECRET,
			...extra_headers
		},
		body: JSON.stringify(body)
	});

const get_config = async (
	test_app: TestApp,
	id: string,
	extra_headers: Record<string, string> = {}
): Promise<Response> =>
	await test_app.app.request(`/internal/repo-config/${id}`, {
		method: 'GET',
		headers: {
			'X-FuzForge-Repo-Secret': HOOK_SECRET,
			...extra_headers
		}
	});

const READ_BODY = async (res: Response): Promise<unknown> => {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};

/** Push-callback body for a repo addressed by its cell-id UUID. */
const sample_body = (repo_id: string) => ({
	repo_id,
	updates: [
		{
			old: '0000000000000000000000000000000000000000',
			new: 'abc1234567890abcdef1234567890abcdef12345',
			ref: 'refs/heads/main'
		}
	],
	pushed_by: '11111111-1111-1111-1111-111111111111',
	push_username: 'ryan'
});

describe_db('repo internal callback routes', (get_db) => {
	describe('POST /internal/repo-receive-callback', () => {
		test('happy path: updates cell head_sha + last_pushed_* and emits broadcast', async () => {
			const { test_app, broadcast } = await build_test_app(get_db);
			const { cell_id } = await seed_repo_cell(get_db());

			const res = await post_callback(test_app, sample_body(cell_id));
			assert.strictEqual(res.status, 200);
			assert.deepEqual(await READ_BODY(res), { ok: true });

			const cell = await query_cell_get_by_path({ db: get_db() }, repo_cell_path(SLUG));
			assert.ok(cell);
			const data = cell.data as RepoCellData;
			assert.strictEqual(data.head_sha, 'abc1234567890abcdef1234567890abcdef12345');
			assert.isNotNull(data.last_pushed_at);
			assert.strictEqual(data.last_pushed_by, '11111111-1111-1111-1111-111111111111');
			assert.strictEqual(data.last_push_username, 'ryan');

			assert.strictEqual(broadcast.calls.length, 1);
			const call = broadcast.calls[0]!;
			assert.strictEqual(call.method, 'fuz_forge_repo_updated');
			const payload = call.input as { repo_id: string; head_sha: string | null };
			assert.strictEqual(payload.repo_id, cell_id);
			assert.strictEqual(payload.head_sha, 'abc1234567890abcdef1234567890abcdef12345');
		});

		test('callback preserves cell keys outside the repo-cell shape', async () => {
			// The write-back spreads the cell's RAW `data` object, not the
			// narrow — spreading the narrow dropped every unnamed key (and
			// materialized `null`s for absent optional ones) where the Rust twin
			// kept them. A repo cell is server-owned state that other tooling may
			// annotate; the push path must not silently prune it.
			const { test_app } = await build_test_app(get_db);
			const deps: QueryDeps = { db: get_db() };
			const cell = await query_cell_create(deps, {
				path: repo_cell_path(SLUG),
				kind: 'repo',
				data: {
					slug: SLUG,
					name: 'fuz_app',
					default_branch: 'main',
					hook_secret_hash: hash_hook_secret(HOOK_SECRET),
					x_extra: 1
				}
			});

			const res = await post_callback(test_app, sample_body(cell.id));
			assert.strictEqual(res.status, 200);

			const after = await query_cell_get_by_path({ db: get_db() }, repo_cell_path(SLUG));
			assert.ok(after);
			const data = after.data as Record<string, unknown>;
			assert.strictEqual(data.x_extra, 1, 'unknown cell keys must survive the callback write');
			assert.strictEqual(data.head_sha, 'abc1234567890abcdef1234567890abcdef12345');
			// Optional keys the seed omitted stay omitted — the narrow's `null`s
			// are a read-side shape, not something the write invents.
			assert.isFalse('seed_from' in data, 'the write must not materialize absent optionals');
		});

		test('non-default-branch push leaves head_sha unchanged', async () => {
			const { test_app, broadcast } = await build_test_app(get_db);
			const { cell_id } = await seed_repo_cell(get_db(), { head_sha: 'previous_sha' });

			const res = await post_callback(test_app, {
				...sample_body(cell_id),
				updates: [
					{
						old: '0000000000000000000000000000000000000000',
						new: 'fea7bfea7bfea7bfea7bfea7bfea7bfea7bfea7b',
						ref: 'refs/heads/feature'
					}
				]
			});
			assert.strictEqual(res.status, 200);

			const cell = await query_cell_get_by_path({ db: get_db() }, repo_cell_path(SLUG));
			const data = cell!.data as RepoCellData;
			assert.strictEqual(data.head_sha, 'previous_sha');
			// Broadcast still fires (push happened) — head_sha echoed unchanged.
			const payload = broadcast.calls[0]!.input as { head_sha: string | null };
			assert.strictEqual(payload.head_sha, 'previous_sha');
		});

		test('an update whose new is not a full sha is rejected with 401', async () => {
			// `new` becomes `head_sha`, which the read RPCs hand to git, so the
			// body holds it to `is_full_sha` (the zero id of a delete included).
			// The Rust twin refuses the same set (`updates_are_valid`).
			const { test_app, broadcast } = await build_test_app(get_db);
			const { cell_id } = await seed_repo_cell(get_db(), { head_sha: 'previous_sha' });
			for (const bad of ['abc123', 'A'.repeat(40), 'a'.repeat(64), '', `${'a'.repeat(40)} `]) {
				const res = await post_callback(test_app, {
					...sample_body(cell_id),
					updates: [{ old: '0'.repeat(40), new: bad, ref: 'refs/heads/main' }]
				});
				assert.strictEqual(res.status, 401, `new ${JSON.stringify(bad)}`);
			}
			assert.strictEqual(broadcast.calls.length, 0);
			const cell = await query_cell_get_by_path({ db: get_db() }, repo_cell_path(SLUG));
			assert.strictEqual((cell!.data as RepoCellData).head_sha, 'previous_sha');
		});

		test('the cell stores the digest, never the plaintext secret', async () => {
			// A cell holding the plaintext as its `hook_secret_hash` refuses the
			// plaintext: the compare is digest against digest.
			const { test_app } = await build_test_app(get_db);
			const { cell_id } = await seed_repo_cell(get_db(), { hook_secret_hash: HOOK_SECRET });
			const res = await post_callback(test_app, sample_body(cell_id));
			assert.strictEqual(res.status, 401);
		});

		test('default-branch deletion sets head_sha to null', async () => {
			const { test_app } = await build_test_app(get_db);
			const { cell_id } = await seed_repo_cell(get_db(), { head_sha: 'previous_sha' });

			const res = await post_callback(test_app, {
				...sample_body(cell_id),
				updates: [
					{
						old: 'previous_sha',
						new: '0000000000000000000000000000000000000000',
						ref: 'refs/heads/main'
					}
				]
			});
			assert.strictEqual(res.status, 200);

			const cell = await query_cell_get_by_path({ db: get_db() }, repo_cell_path(SLUG));
			const data = cell!.data as RepoCellData;
			assert.isNull(data.head_sha);
		});

		test('non-loopback connection rejected with 401', async () => {
			// Connection-IP gate: with `get_connection_ip` returning a
			// non-loopback address, the request fails the cheap source
			// check before secret comparison or body parsing.
			const { test_app, broadcast } = await build_test_app(get_db, {
				connection_ip: '1.2.3.4'
			});
			const { cell_id } = await seed_repo_cell(get_db());

			const res = await post_callback(test_app, sample_body(cell_id));
			assert.strictEqual(res.status, 401);
			assert.strictEqual(broadcast.calls.length, 0);
		});

		test('XFF cannot fake loopback when connection is non-loopback', async () => {
			// Defense-in-depth: even an XFF chain composed entirely of trusted
			// proxy IPs (which `client_ip` resolution could collapse to
			// `127.0.0.1`) does NOT pass — the gate reads the raw connection
			// IP, which header rewrites can't reach.
			const { test_app, broadcast } = await build_test_app(get_db, {
				connection_ip: '203.0.113.5'
			});
			const { cell_id } = await seed_repo_cell(get_db());

			const res = await post_callback(test_app, sample_body(cell_id), {
				'X-Forwarded-For': '127.0.0.1'
			});
			assert.strictEqual(res.status, 401);
			assert.strictEqual(broadcast.calls.length, 0);
		});

		test('malformed JSON body from non-loopback returns 401, not 400', async () => {
			// Body validation must NOT run before the connection-IP gate.
			// Otherwise a non-loopback caller posting `{}` would receive a
			// 400 with Zod issues enumerating the schema shape — a leak
			// the locked-down posture forbids.
			const { test_app, broadcast } = await build_test_app(get_db, {
				connection_ip: '203.0.113.5'
			});
			await seed_repo_cell(get_db());

			const res = await post_callback(test_app, {});
			assert.strictEqual(res.status, 401);
			const body_text = await res.text();
			// 401 body is the plain "Unauthorized\n", not a JSON error envelope.
			assert.notInclude(body_text, 'invalid_request_body');
			assert.notInclude(body_text, 'issues');
			assert.strictEqual(broadcast.calls.length, 0);
		});

		test('malformed JSON body from loopback also returns 401 (no enumeration)', async () => {
			// Same generic 401 even when loopback-gated — body validation
			// runs in-handler post-auth-precheck, so its failure mode is
			// indistinguishable from "wrong secret" / "unknown repo".
			const { test_app, broadcast } = await build_test_app(get_db);
			await seed_repo_cell(get_db());

			const res = await post_callback(test_app, {});
			assert.strictEqual(res.status, 401);
			const body_text = await res.text();
			assert.notInclude(body_text, 'invalid_request_body');
			assert.notInclude(body_text, 'issues');
			assert.strictEqual(broadcast.calls.length, 0);
		});

		test('non-JSON body from loopback returns 401 (no JSON parse leak)', async () => {
			const { test_app, broadcast } = await build_test_app(get_db);
			await seed_repo_cell(get_db());

			const res = await test_app.app.request('/internal/repo-receive-callback', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-FuzForge-Repo-Secret': HOOK_SECRET
				},
				body: 'not-json-at-all'
			});
			assert.strictEqual(res.status, 401);
			assert.notInclude(await res.text(), 'invalid_json_body');
			assert.strictEqual(broadcast.calls.length, 0);
		});

		test('Origin header rejected with 401', async () => {
			const { test_app, broadcast } = await build_test_app(get_db);
			const { cell_id } = await seed_repo_cell(get_db());

			const res = await post_callback(test_app, sample_body(cell_id), {
				Origin: 'http://evil.example'
			});
			assert.strictEqual(res.status, 401);
			assert.strictEqual(broadcast.calls.length, 0);
		});

		test('Referer header rejected with 401', async () => {
			const { test_app } = await build_test_app(get_db);
			const { cell_id } = await seed_repo_cell(get_db());

			const res = await post_callback(test_app, sample_body(cell_id), {
				Referer: 'http://evil.example/page'
			});
			assert.strictEqual(res.status, 401);
		});

		test('missing X-FuzForge-Repo-Secret rejected with 401', async () => {
			const { test_app } = await build_test_app(get_db);
			const { cell_id } = await seed_repo_cell(get_db());

			const res = await test_app.app.request('/internal/repo-receive-callback', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(sample_body(cell_id))
			});
			assert.strictEqual(res.status, 401);
		});

		test('wrong secret rejected with 401', async () => {
			const { test_app, broadcast } = await build_test_app(get_db);
			const { cell_id } = await seed_repo_cell(get_db());

			const res = await post_callback(test_app, sample_body(cell_id), {
				'X-FuzForge-Repo-Secret': 'wrong-secret'
			});
			assert.strictEqual(res.status, 401);
			assert.strictEqual(broadcast.calls.length, 0);
		});

		test('extra key in the callback body rejected with 401 (strictObject)', async () => {
			// `RepoReceiveCallbackBody` is a `z.strictObject`, so an unknown key
			// is a parse failure → the bare 401, never a 400 that would confirm
			// the schema. Twin of the Rust `#[serde(deny_unknown_fields)]` on
			// `RepoReceiveCallbackBody` / `RefUpdate` (`internal_routes.rs`).
			const { test_app, broadcast } = await build_test_app(get_db);
			const { cell_id } = await seed_repo_cell(get_db());

			const top_level = await post_callback(test_app, {
				...sample_body(cell_id),
				surprise: 1
			});
			assert.strictEqual(top_level.status, 401);

			const body = sample_body(cell_id);
			const nested = await post_callback(test_app, {
				...body,
				updates: [{ ...body.updates[0], surprise: 1 }]
			});
			assert.strictEqual(nested.status, 401);
			assert.strictEqual(broadcast.calls.length, 0);
		});

		test('callback body missing a nullable push-attribution key rejected with 401', async () => {
			// `.nullable()` is not `.optional()`: the hooks always send both
			// keys (`null` when the push carried no endpoint context), so an
			// absent key is a malformed body. The Rust twin spells this with a
			// `RequiredNullable` newtype, since serde fills a missing `Option`
			// field with `None`.
			const { test_app, broadcast } = await build_test_app(get_db);
			const { cell_id } = await seed_repo_cell(get_db());

			for (const key of ['pushed_by', 'push_username'] as const) {
				const body: Record<string, unknown> = { ...sample_body(cell_id) };
				delete body[key];
				const res = await post_callback(test_app, body);
				assert.strictEqual(res.status, 401, `body missing ${key}`);
			}
			assert.strictEqual(broadcast.calls.length, 0);
		});

		test('cell missing a required field rejected with 401 (no invented default_branch)', async () => {
			// `narrow_repo_cell_data` requires slug + name + default_branch +
			// hook_secret_hash; a cell missing any of them behaves like a missing
			// cell. Pinned here rather than cross-process because the cross
			// harness has no way to write a corrupt cell. The Rust twin narrows
			// through `RepoCellData` in `verify_repo_secret` and is unit-covered
			// by `internal_routes::tests::cell_without_default_branch_does_not_narrow`.
			const { test_app, broadcast } = await build_test_app(get_db);
			for (const dropped of ['slug', 'name', 'default_branch', 'hook_secret_hash'] as const) {
				const { cell_id } = await seed_partial_repo_cell(get_db(), dropped);

				const res = await post_callback(test_app, sample_body(cell_id));
				assert.strictEqual(res.status, 401, `callback with cell missing ${dropped}`);
				assert.strictEqual(broadcast.calls.length, 0);

				const config = await get_config(test_app, cell_id);
				assert.strictEqual(config.status, 401, `repo-config with cell missing ${dropped}`);
			}
		});

		test('cell with a wrong-typed optional field rejected with 401 (no coercion)', async () => {
			// `narrow_repo_cell_data` used to coerce a non-string optional to
			// `null`, so a type-corrupt cell stayed a live repo here while the
			// Rust twin's serde rejected it and 401'd. Both now read it as a
			// missing cell. Unit twin:
			// `handlers::repo_write::tests::mutation_narrow_rejects_a_wrong_typed_optional`.
			const { test_app, broadcast } = await build_test_app(get_db);
			for (const [field, value] of [
				['seed_from', 42],
				['head_sha', 5],
				['last_pushed_at', true],
				['last_push_username', { bogus: true }]
			] as const) {
				const { cell_id } = await seed_corrupt_repo_cell(get_db(), field, value);

				const res = await post_callback(test_app, sample_body(cell_id));
				assert.strictEqual(res.status, 401, `callback with a wrong-typed ${field}`);
				assert.strictEqual(broadcast.calls.length, 0);

				const config = await get_config(test_app, cell_id);
				assert.strictEqual(config.status, 401, `repo-config with a wrong-typed ${field}`);
			}
		});

		test('unknown repo_id rejected with 401 (no enumeration distinction)', async () => {
			const { test_app, broadcast } = await build_test_app(get_db);
			await seed_repo_cell(get_db());

			const res = await post_callback(test_app, sample_body(ABSENT_UUID));
			assert.strictEqual(res.status, 401);
			assert.strictEqual(broadcast.calls.length, 0);
		});
	});

	describe('GET /internal/repo-config/:id', () => {
		test('happy path: returns {default_branch}', async () => {
			const { test_app } = await build_test_app(get_db);
			const { cell_id } = await seed_repo_cell(get_db(), { default_branch: 'trunk' });

			const res = await get_config(test_app, cell_id);
			assert.strictEqual(res.status, 200);
			assert.deepEqual(await READ_BODY(res), { default_branch: 'trunk' });
		});

		test('non-loopback connection rejected with 401', async () => {
			const { test_app } = await build_test_app(get_db, { connection_ip: '1.2.3.4' });
			const { cell_id } = await seed_repo_cell(get_db());

			const res = await get_config(test_app, cell_id);
			assert.strictEqual(res.status, 401);
		});

		test('XFF cannot fake loopback when connection is non-loopback', async () => {
			const { test_app } = await build_test_app(get_db, { connection_ip: '203.0.113.5' });
			const { cell_id } = await seed_repo_cell(get_db());

			const res = await get_config(test_app, cell_id, {
				'X-Forwarded-For': '127.0.0.1'
			});
			assert.strictEqual(res.status, 401);
		});

		test('missing secret rejected with 401', async () => {
			const { test_app } = await build_test_app(get_db);
			const { cell_id } = await seed_repo_cell(get_db());

			const res = await test_app.app.request(`/internal/repo-config/${cell_id}`, {
				method: 'GET'
			});
			assert.strictEqual(res.status, 401);
		});

		test('wrong secret rejected with 401', async () => {
			const { test_app } = await build_test_app(get_db);
			const { cell_id } = await seed_repo_cell(get_db());

			const res = await get_config(test_app, cell_id, {
				'X-FuzForge-Repo-Secret': 'wrong'
			});
			assert.strictEqual(res.status, 401);
		});

		test('unknown repo_id rejected with 401', async () => {
			const { test_app } = await build_test_app(get_db);
			await seed_repo_cell(get_db());

			const res = await get_config(test_app, ABSENT_UUID);
			assert.strictEqual(res.status, 401);
		});
	});

	describe('only a served repo cell names a hook secret', () => {
		/**
		 * Seed a cell carrying a complete repo-shaped `data` (secret digest
		 * included) at `path` with `kind` — the cell a caller could write through
		 * the generic cell layer, which stores any `data` it is sent.
		 */
		const seed_repo_shaped_cell = async (
			kind: string | null,
			path: string | null
		): Promise<string> => {
			const data: RepoCellData = {
				slug: SLUG,
				name: 'fuz_app',
				default_branch: 'main',
				seed_from: null,
				seed_completed_at: null,
				hook_secret_hash: hash_hook_secret(HOOK_SECRET),
				head_sha: null,
				last_pushed_at: null,
				last_pushed_by: null,
				last_push_username: null
			};
			const cell = await query_cell_create({ db: get_db() }, { path, data, kind });
			return cell.id;
		};

		test('the correct secret on a cell that is not a repo at repos/<slug> → 401 on both routes', async () => {
			const { test_app, broadcast } = await build_test_app(get_db);
			const cases: Array<[string, string | null, string | null]> = [
				['another kind at the repo path', 'note', repo_cell_path(SLUG)],
				['a typeless cell', null, null],
				['a pathless repo cell', 'repo', null],
				['a repo cell outside repos/', 'repo', 'notes/fuz_app']
			];
			for (const [label, kind, path] of cases) {
				const id = await seed_repo_shaped_cell(kind, path);
				assert.strictEqual((await get_config(test_app, id)).status, 401, `${label}: repo-config`);
				assert.strictEqual(
					(await post_callback(test_app, sample_body(id))).status,
					401,
					`${label}: callback`
				);
			}
			assert.strictEqual(broadcast.calls.length, 0, 'no refused callback broadcasts');

			// Positive control: the same data on a repo cell at its repo path
			// admits, so each 401 above is the cell's kind or path alone.
			const id = await seed_repo_shaped_cell('repo', repo_cell_path('fuzdev/served'));
			assert.strictEqual((await get_config(test_app, id)).status, 200);
		});
	});
});
