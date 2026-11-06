/**
 * Schema-readiness fixture + drift-check test (fuz_forge).
 *
 * Bootstraps the full fuz_forge migration chain (auth + api-token policy +
 * facts + cells) on Postgres and asserts the committed
 * `expected_schema.json` — served by the `/ready` deploy gate — matches the
 * live column map. Regenerate after an intentional schema change with
 * `UPDATE_SCHEMA_READY=1` (the helper writes raw `JSON.stringify`, one array
 * element per line). The assertion fails if the fixture drifts from a fresh
 * bootstrap, so the runtime expectation can't silently fall behind the DDLs.
 *
 * The Rust `fuz_forge_server` embeds the same committed fixture via the twin
 * `fuz_http::ready_router` — column-presence is engine-portable, so one fixture
 * is the cross-impl contract, and the schema-parity gate (`cross_backend_parity`) proves
 * the two backends' schemas converge. The drift mechanism ships in the fuz_app
 * spine (`@fuzdev/fuz_app/db/schema_ready.ts` + `testing/schema_ready_fixture.ts`).
 *
 * @module
 */

import { test, assert } from 'vitest';
import { query_public_columns, check_schema_drift } from '@fuzdev/fuz_app/db/schema_ready.ts';
import { sync_expected_schema_fixture } from '@fuzdev/fuz_app/testing/schema_ready_fixture.ts';

import { describe_db } from '../db_fixture.ts';

const FIXTURE_URL = new URL('../../lib/server/expected_schema.json', import.meta.url);

describe_db('schema_ready', (get_db) => {
	test('committed expected_schema.json matches a fresh bootstrap', async () => {
		const { live, committed } = await sync_expected_schema_fixture({
			db: get_db(),
			fixture_url: FIXTURE_URL,
			update: process.env.UPDATE_SCHEMA_READY === '1'
		});
		assert.deepEqual(live, committed);
	});

	test('check_schema_drift passes against the live schema', async () => {
		const db = get_db();
		const live = await query_public_columns(db);
		const drift = await check_schema_drift(db, live);
		assert.ok(drift.ok);
		assert.deepEqual(drift.missing_tables, []);
		assert.deepEqual(drift.missing_columns, []);
	});

	test('check_schema_drift flags a missing column', async () => {
		const drift = await check_schema_drift(get_db(), {
			account: ['id', 'deleted_at', 'nonexistent_col']
		});
		assert.ok(!drift.ok);
		assert.deepEqual(drift.missing_columns, [{ table: 'account', columns: ['nonexistent_col'] }]);
		assert.deepEqual(drift.missing_tables, []);
	});

	test('check_schema_drift flags a missing table', async () => {
		const drift = await check_schema_drift(get_db(), { nonexistent_table: ['id'] });
		assert.ok(!drift.ok);
		assert.deepEqual(drift.missing_tables, ['nonexistent_table']);
	});
});
