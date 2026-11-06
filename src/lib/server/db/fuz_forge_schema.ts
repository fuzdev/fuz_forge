/**
 * Database schema for fuz_forge: auth, scoped-token policies, the fact
 * substrate (facts + refs + memos), and cells. The file store is
 * cell-primary — file metadata is a cell, file bytes are facts — so there
 * is no separate file table.
 *
 * @module
 */

import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import { run_migrations } from '@fuzdev/fuz_app/db/migrate.ts';
import { AUTH_MIGRATION_NS } from '@fuzdev/fuz_app/auth/migrations.ts';
import { CELL_MIGRATION_NS } from '@fuzdev/fuz_app/db/cell_ddl.ts';

import { FACT_MIGRATION_NS } from '@fuzdev/fuz_app/db/fact_ddl.ts';
import { init_auth_schema } from './session_schema.ts';
import { init_fuz_forge_api_token_policy_schema } from './fuz_forge_api_token_policy_schema.ts';

/**
 * fuz_forge domain tables a between-test reset clears, **beyond** the
 * auth-namespace wipe. Children first (FK-safe). Single source of truth for
 * both the cross-process `_testing_reset` `reset_state` (`server/testing_server_build.ts`)
 * and the in-process `describe_db` truncation (`src/test/db_fixture.ts`, which
 * appends `auth_integration_truncate_tables`).
 */
export const fuz_forge_domain_truncate_tables = [
	// Unified `fuz_cell` tables (children first; no hub).
	'cell_field',
	'cell_item',
	'cell_grant',
	'cell',
	// Fact substrate. The file store is cell-primary — file bytes are facts,
	// file metadata is cells, so there's no separate file table to truncate.
	'memo',
	'fact_ref',
	'fact'
] as const;

/**
 * fuz_forge's own migration namespaces beyond the built-in auth namespace, in
 * FK-dependency order: facts (no FKs) → cell (FK `actor`). Run by
 * `init_fuz_forge_schema` after auth + the api-token-policy DDL.
 */
export const fuz_forge_own_migration_namespaces = [FACT_MIGRATION_NS, CELL_MIGRATION_NS];

/**
 * Every migration namespace fuz_forge records in `schema_version`, in canonical
 * order (auth first). The single source the `db:status` reader
 * (`scripts/db_status.ts`) shares with the migration chain so the two never
 * drift — the TS twin of the Rust `run_db_status_cli` consumers' shared
 * `*_migration_namespaces()`. The `fuz_forge_api_token_policy` table is
 * direct-DDL, not a tracked namespace, so it's absent here.
 */
export const fuz_forge_migration_namespaces = [
	AUTH_MIGRATION_NS,
	...fuz_forge_own_migration_namespaces
];

/**
 * Initialize the fuz_forge database schema.
 *
 * Includes auth migrations (idempotent — safe to call even when
 * `init_backend` has already run them).
 *
 * @param db - database instance
 */
export const init_fuz_forge_schema = async (db: Db): Promise<void> => {
	await init_auth_schema(db);
	// fuz_forge_api_token_policy must run after auth — FK references `api_token`,
	// which is created by `AUTH_MIGRATION_NS`.
	await init_fuz_forge_api_token_policy_schema(db);
	// Facts + cells run after auth: the unified `fuz_cell` schema's
	// `cell.created_by` references `actor(id)`, created by `AUTH_MIGRATION_NS`.
	// Order within this call: facts (no FKs), then the cell layer (FK on
	// actor). The cell layer is the shared
	// `@fuzdev/fuz_app` surface (no hub; `path` is globally unique).
	await run_migrations(db, fuz_forge_own_migration_namespaces);
};
