/**
 * Auth schema initialization — delegates to fuz_app's migration-based auth tables.
 *
 * @module
 */

import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import { run_migrations } from '@fuzdev/fuz_app/db/migrate.ts';
import { AUTH_MIGRATION_NS } from '@fuzdev/fuz_app/auth/migrations.ts';

/**
 * Initialize the auth schema.
 *
 * Runs fuz_app auth migrations (account, actor, role_grant, auth_session, api_token).
 * Migrations are idempotent — safe to call on every startup.
 *
 * @param db - database instance
 */
export const init_auth_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
};
