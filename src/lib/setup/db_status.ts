/**
 * The development database's status: connectivity, tables, and migration versions.
 *
 * Prints the same `database status` / `url:` header as `fuzfd db-status` (plus
 * the TS-only `driver:` line), then `format_db_status`'s report. The URL
 * prints without its password or query. When the database can't be reached,
 * the report goes to stderr alone, as with `fuzfd db-status`.
 *
 * @module
 */

import type { CreateDbResult } from '@fuzdev/fuz_app/db/create_db.ts';
import { display_db_url, format_db_status, query_db_status } from '@fuzdev/fuz_app/db/status.ts';
import { read_env_var } from '@fuzdev/fuz_app/dev/setup.ts';
import type { FsReadDeps } from '@fuzdev/fuz_app/runtime/deps.ts';
import { SilentError, TaskError } from '@fuzdev/gro/task.ts';

import { fuz_forge_migration_namespaces } from '../server/db/fuz_forge_schema.ts';
import { DEV_ENV_PATH } from './env_file.ts';

/** Capabilities for `run_db_status`. */
export interface DbStatusDeps {
	/** Reads the env file. */
	runtime: Pick<FsReadDeps, 'read_text_file'>;
	/** Opens the database a URL names, fuz_app's `create_db` outside tests. */
	connect: (database_url: string) => Promise<CreateDbResult>;
}

/**
 * Report the status of the database `.env.development`'s `DATABASE_URL` names. Read-only.
 *
 * @param deps - the env-file read and the connection
 * @throws `TaskError` - when `.env.development` has no `DATABASE_URL`
 * @throws `SilentError` - when the database can't be reached, after reporting why on stderr
 */
export const run_db_status = async (deps: DbStatusDeps): Promise<void> => {
	const database_url = await read_env_var(deps.runtime, DEV_ENV_PATH, 'DATABASE_URL');
	if (!database_url) {
		throw new TaskError(
			`Could not read DATABASE_URL from ${DEV_ENV_PATH}. Run \`npm run dev:setup\` first.`
		);
	}

	const { db, close, db_type } = await deps.connect(database_url);
	let connected: boolean;
	try {
		const status = await query_db_status(db, fuz_forge_migration_namespaces);
		connected = status.connected;
		// the report ends in a newline, which `console.log` would double
		const report = format_db_status(status).trimEnd();
		if (connected) {
			console.log('database status');
			console.log(`  url: ${display_db_url(database_url)}`);
			console.log(`  driver: ${db_type}`);
			console.log(report);
		} else {
			console.error(report);
		}
	} finally {
		await close();
	}
	if (!connected) throw new SilentError();
};
