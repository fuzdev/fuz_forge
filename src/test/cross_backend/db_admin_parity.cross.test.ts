/**
 * Cross-process TS↔Rust parity suite for the **db-admin browser** — run
 * against BOTH fuz_forge backends (TS/Hono + Rust `fuz_forge_server`)
 * via the `cross_backend_*` mechanism.
 *
 * The browsable-tables allowlist is declared twice — TS
 * `FUZ_FORGE_BROWSABLE_TABLES` in `src/lib/server/routes/db.ts`, Rust
 * `FUZ_FORGE_BROWSABLE_TABLES` in `crates/fuz_forge_server/src/router.rs` —
 * and nothing structural forces the two declarations to agree. This suite is
 * the gate: the table set is pinned **literally** (not imported from either
 * source constant), so each backend is measured against the same fixed list
 * and a drifted declaration on either side fails its project's run. The same
 * transitivity covers the paging-400 spellings (the strict `[+-]?digits`
 * TS preprocess twinning Rust's raw-string `i64` parse), the query-shape
 * contract (strict keys, first-occurrence duplicates, `acting` validated on
 * every route, query-before-auth phase order), and the detail response
 * shape.
 *
 * The paging assertions pin `{status, error}` rather than the whole body:
 * the TS twin attaches an `issues` diagnostic array in DEV builds, so
 * byte-identity of the envelope is not part of the parity contract —
 * the error code and status are.
 *
 * The phase-order case walks the query gate across anonymous / roleless /
 * admin principals. It is here rather than beside the file store's because the
 * mount is the spine's own (`fuz_db_admin` on Rust, fuz_app's
 * `create_db_route_specs` on TS): the forge supplies only the browsable set and
 * the session-only credential gate, so the ordering under test is the spine's
 * and this suite is where a spine-level divergence would surface.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url } = handle.config;

/**
 * The forge's browsable set, pinned literally (sorted): the tables both
 * backend declarations must expose — everything except the credential
 * tables on fuz_app's unoverridable `NON_BROWSABLE_TABLES` floor.
 */
const EXPECTED_TABLES = [
	'actor',
	'app_settings',
	'audit_log',
	'cell',
	'cell_field',
	'cell_grant',
	'cell_item',
	'fact',
	'fact_ref',
	'fuz_forge_api_token_policy',
	'invite',
	'memo',
	'role_grant',
	'role_grant_offer',
	'schema_version'
] as const;

/** The credential floor — masked even though the tables exist in the schema. */
const FLOOR_TABLES = ['account', 'auth_session', 'api_token', 'bootstrap_lock'] as const;

describe('db-admin parity (cross-process, both backends)', () => {
	test('GET /api/db/tables lists exactly the pinned browsable set', async () => {
		const fixture = await setup_test();
		const res = await fetch(`${base_url}/api/db/tables`, {
			headers: fixture.create_session_headers()
		});
		assert.strictEqual(res.status, 200);
		const body = (await res.json()) as { tables: Array<{ name: string }> };
		const names = body.tables.map((t) => t.name).sort();
		assert.deepStrictEqual(
			names,
			[...EXPECTED_TABLES],
			'the browsable set must match the pinned 16-table list on both backends'
		);
		for (const floored of FLOOR_TABLES) {
			assert.notInclude(names, floored, `credential-floor table ${floored} must stay masked`);
		}
	});

	test('paging rejects the same spellings with the same 400 on both backends', async () => {
		const fixture = await setup_test();
		// limit=0 (below range), limit=1001 (above range), limit=1e2 (a
		// spelling `Number()` accepts but the strict digits contract refuses —
		// the exact divergence the `[+-]?digits` preprocess closed); offset=-1
		// (parses, out of range) and offset=abc (malformed) cover the other
		// param's two refusal shapes.
		for (const query of ['limit=0', 'limit=1001', 'limit=1e2', 'offset=-1', 'offset=abc']) {
			const res = await fetch(`${base_url}/api/db/tables/cell?${query}`, {
				headers: fixture.create_session_headers()
			});
			assert.strictEqual(res.status, 400, `${query} must be a 400`);
			const body = (await res.json()) as { error: string };
			assert.strictEqual(
				body.error,
				'invalid_query_params',
				`${query} must refuse with the shared error code`
			);
		}
	});

	test('duplicate and unknown query keys answer identically on both backends', async () => {
		const fixture = await setup_test();
		const headers = fixture.create_session_headers();
		// duplicate key: first occurrence wins on both (Hono's `c.req.query()`
		// keeps the first value; the Rust handlers read the raw pair list the
		// same way — the derived-serde extractor's plain-text "duplicate
		// field" 400 is gone)
		const dup = await fetch(`${base_url}/api/db/tables/cell?limit=1&limit=1001`, { headers });
		assert.strictEqual(dup.status, 200, 'duplicate limit takes the first occurrence');
		assert.strictEqual(((await dup.json()) as { limit: number }).limit, 1);
		// unknown key: the query contract is strict on both (TS
		// strict `object`, Rust `assert_known_query_keys`)
		const unknown = await fetch(`${base_url}/api/db/tables/cell?foo=1`, { headers });
		assert.strictEqual(unknown.status, 400, 'unknown query key is refused');
		assert.strictEqual(((await unknown.json()) as { error: string }).error, 'invalid_query_params');
		// the list route validates `acting` too (the TS spec declares it on
		// every db route; the Rust twin used to skip it on /tables)
		const acting = await fetch(`${base_url}/api/db/tables?acting=not-a-uuid`, { headers });
		assert.strictEqual(acting.status, 400, 'malformed acting on the list route is refused');
		assert.strictEqual(((await acting.json()) as { error: string }).error, 'invalid_query_params');
	});

	test('a foreign acting actor is refused identically on both backends', async () => {
		const fixture = await setup_test();
		// well-formed uuid, but not an actor on the session's account — the
		// authorization phase refuses with `actor_not_on_account` (the Rust
		// twin used to validate the shape and silently ignore ownership)
		const res = await fetch(
			`${base_url}/api/db/tables?acting=00000000-0000-4000-8000-00000000dead`,
			{ headers: fixture.create_session_headers() }
		);
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), { error: 'actor_not_on_account' });
	});

	test('a table on both floors masks as missing on both backends', async () => {
		const fixture = await setup_test();
		const headers = fixture.create_session_headers();
		// `bootstrap_lock` is non-browsable AND non-deletable — the browsable
		// mask must answer first, byte-identically to a table that doesn't
		// exist (a 400 `table_not_deletable` would confirm the credential
		// table's existence and special status)
		const missing = await fetch(`${base_url}/api/db/tables/no_such_table/rows/x`, {
			method: 'DELETE',
			headers
		});
		assert.strictEqual(missing.status, 404);
		const missing_body = (await missing.json()) as Record<string, unknown>;
		const double_floor = await fetch(`${base_url}/api/db/tables/bootstrap_lock/rows/x`, {
			method: 'DELETE',
			headers
		});
		assert.strictEqual(double_floor.status, 404);
		assert.deepStrictEqual(await double_floor.json(), missing_body);
	});

	test('query shape is validated before auth on both backends', async () => {
		// Phase order: params → query → 401/403, the TS pipeline's contract.
		// An anonymous caller with a malformed query hears the same masked
		// 400 as an authorized one — not a 401 that fingerprints the backend;
		// the anonymous control on a clean query stays 401.
		const bad = await fetch(`${base_url}/api/db/tables/cell?limit=0`);
		assert.strictEqual(bad.status, 400);
		assert.strictEqual(((await bad.json()) as { error: string }).error, 'invalid_query_params');
		const control = await fetch(`${base_url}/api/db/tables`);
		assert.strictEqual(control.status, 401, 'clean anonymous request still refused by auth');
	});

	test('the query gate precedes both credential rungs on both backends', async () => {
		// The db-admin mount is the spine's `fuz_db_admin` router (Rust) /
		// fuz_app's `create_db_route_specs` (TS), so its phase order is the
		// spine's, not `route_auth`'s — the forge only supplies the browsable
		// set and the session-only credential gate. The case above pins the
		// order for one anonymous shape (`?limit=0`); this walks the two
		// *selector* shapes across all three principals, since a query gate that
		// ran after auth would answer 401 (anon) or 403 (roleless) instead of the
		// 400, and the divergence would be invisible on the admin row alone.
		const fixture = await setup_test();
		const non_admin = await fixture.create_account();
		const principals: Array<[label: string, headers: Record<string, string> | undefined]> = [
			['anonymous', undefined],
			['roleless session', non_admin.create_session_headers()],
			['admin session', fixture.create_session_headers()]
		];
		const queries = ['?acting=not-a-uuid', '?foo=1'];
		for (const [label, headers] of principals) {
			for (const query of queries) {
				for (const path of ['/api/db/tables', '/api/db/tables/cell']) {
					const res = await fetch(`${base_url}${path}${query}`, headers ? { headers } : undefined);
					assert.strictEqual(res.status, 400, `${label} ${path}${query}: status`);
					assert.strictEqual(
						((await res.json()) as { error: string }).error,
						'invalid_query_params',
						`${label} ${path}${query}: error`
					);
				}
			}
		}
		// The controls each rung needs: with a clean query the same two
		// principals fall through to their own refusals.
		const anon = await fetch(`${base_url}/api/db/tables`);
		assert.strictEqual(anon.status, 401, 'clean anonymous request is refused by auth');
		const roleless = await fetch(`${base_url}/api/db/tables`, {
			headers: non_admin.create_session_headers()
		});
		assert.strictEqual(roleless.status, 403, 'clean roleless request is refused by the role gate');
		assert.deepStrictEqual(await roleless.json(), {
			error: 'insufficient_permissions',
			required_roles: ['admin']
		});
	});

	test('table detail answers with the same shape on both backends', async () => {
		const fixture = await setup_test();
		const res = await fetch(`${base_url}/api/db/tables/cell`, {
			headers: fixture.create_session_headers()
		});
		assert.strictEqual(res.status, 200);
		const body = (await res.json()) as Record<string, unknown>;
		assert.deepStrictEqual(
			Object.keys(body).sort(),
			['columns', 'deletable', 'limit', 'offset', 'primary_key', 'rows', 'total'],
			'detail response keys'
		);
		assert.ok(Array.isArray(body.columns), 'columns is an array');
		assert.ok(Array.isArray(body.rows), 'rows is an array');
		assert.strictEqual(typeof body.total, 'number');
		assert.strictEqual(body.primary_key, 'id', 'cell exposes its single-column PK');
		assert.strictEqual(body.deletable, true, 'cell is row-deletable');
	});

	test('a mistyped row id deletes nothing and masks as row_not_found on both backends', async () => {
		const fixture = await setup_test();
		// `cell.id` is uuid — the typed PK compare fails coercion (22P02) and
		// both backends answer with the same masked 404 as a typed miss.
		const res = await fetch(`${base_url}/api/db/tables/cell/rows/not-a-uuid`, {
			method: 'DELETE',
			headers: fixture.create_session_headers()
		});
		assert.strictEqual(res.status, 404);
		const body = (await res.json()) as { error: string };
		assert.strictEqual(body.error, 'row_not_found');
		// a NUL byte (22021, rejected by the server encoding before any
		// coercion) masks the same way — previously a 500 on both backends
		const nul = await fetch(`${base_url}/api/db/tables/cell/rows/%00abc`, {
			method: 'DELETE',
			headers: fixture.create_session_headers()
		});
		assert.strictEqual(nul.status, 404, 'NUL-byte id masks as a miss');
		assert.strictEqual(((await nul.json()) as { error: string }).error, 'row_not_found');
	});
});
