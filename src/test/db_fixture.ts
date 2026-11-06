/**
 * Database test fixtures.
 *
 * `describe_db` runs every suite against real **PostgreSQL** — the engine the
 * production Rust backend uses (native `tokio-postgres`), so every in-process
 * suite tests on the same engine as production rather than an in-memory WASM
 * Postgres. No in-memory engine is reached from here; the cross-backend TS
 * spawn's default database is fuz_app's in-memory `memory://` (see
 * `cross_backend/fuz_forge_backend_config.ts`). The DB is `TEST_DATABASE_URL`
 * (default `postgres://localhost/fuz_forge_test`); create it once with
 * `createdb fuz_forge_test`.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import {
	create_pg_factory,
	create_describe_db,
	auth_integration_truncate_tables,
	log_db_factory_status,
	type DbFactory
} from '@fuzdev/fuz_app/testing/db.ts';
import { load_env_file } from '@fuzdev/fuz_app/env/dotenv.ts';

import {
	init_fuz_forge_schema,
	fuz_forge_domain_truncate_tables
} from '#lib/server/db/fuz_forge_schema.ts';

// Load .env.development for test configuration
const env_file = await load_env_file(
	{ read_text_file: (path) => readFile(path, 'utf-8') },
	'.env.development'
);
if (env_file) {
	for (const [key, value] of Object.entries(env_file)) {
		process.env[key] ??= value;
	}
}

/**
 * Postgres test DB — the engine production uses. Defaults to a conventional
 * local DB; override via `TEST_DATABASE_URL`. Create it once with
 * `createdb fuz_forge_test`.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost/fuz_forge_test';

/**
 * All tables to truncate between tests (order: children first for FK safety).
 *
 * Uses `auth_integration_truncate_tables` (includes `audit_log`, `role_grant_offer`,
 * `invite`) so audit/role-grant-offer rows don't leak between tests in the
 * `describe_db('fuz_forge-specific routes', ...)` block — `create_account` writes
 * audit events on bootstrap.
 */
export const TRUNCATE_TABLES = [
	// fuz_forge domain tables (cells + facts + file store), children first —
	// shared source of truth with the cross-process `_testing_reset`.
	...fuz_forge_domain_truncate_tables,
	// Auth namespace (includes `audit_log`, `role_grant_offer`, `invite`) so
	// audit/offer rows don't leak between tests — `create_account` writes
	// audit events on bootstrap.
	...auth_integration_truncate_tables
];

// `create_pg_factory` resets the `public` schema per `create()`, so each suite's
// `beforeAll` (e.g. `create_test_app`'s keeper bootstrap) starts against an empty
// database — the per-test `TRUNCATE` runs only after `beforeAll`
const pg_factory = create_pg_factory(init_fuz_forge_schema, TEST_DATABASE_URL);

/**
 * Database factories iterated by driver-agnostic suites (e.g. rate limiting).
 * One engine: these suites run on Postgres.
 */
export const db_factories: Array<DbFactory> = [pg_factory];

log_db_factory_status(db_factories);

/**
 * Helper for database tests on Postgres.
 *
 * Every suite shares one Postgres DB (`TEST_DATABASE_URL`) with automatic
 * `beforeEach` `TRUNCATE` of all tables. The `db` vitest project runs serially
 * (`isolate: false`, `fileParallelism: false`), so a single shared DB + per-test
 * truncation gives clean isolation without per-worker databases.
 *
 * @example
 * ```ts
 * import {describe_db} from '../../db_fixture.ts'; // adjust depth to match subdir
 * import {query_token_policies_by_account} from '#lib/server/db/fuz_forge_api_token_policy_queries.ts';
 *
 * describe_db('fuz_forge_api_token_policy_queries', (get_db) => {
 *   test('lists token policies by account', async () => {
 *     const deps = {db: get_db()};
 *     const policies = await query_token_policies_by_account(deps, account_id);
 *     // ...
 *   });
 * });
 * ```
 */
export const describe_db = create_describe_db([pg_factory], TRUNCATE_TABLES);
