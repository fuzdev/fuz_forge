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
import { read_env_var, type SetupFlowLogger } from '@fuzdev/fuz_app/dev/setup.ts';
import type { FsReadDeps } from '@fuzdev/fuz_app/runtime/deps.ts';
import { ReportedError, TaskError } from '@fuzdev/gro/task_error.ts';

import { fuz_forge_migration_namespaces } from '../server/db/fuz_forge_schema.ts';
import { DEV_ENV_PATH } from './env_file.ts';

/** Capabilities for `run_db_status`. */
export interface DbStatusDeps {
	/** Reads the env file. */
	runtime: Pick<FsReadDeps, 'read_text_file'>;
	/** Opens the database a URL names, fuz_app's `create_db` outside tests. */
	connect: (database_url: string) => Promise<CreateDbResult>;
	/** Takes the report: stdout when connected, stderr when not. */
	log: Pick<SetupFlowLogger, 'print' | 'print_error'>;
}

/**
 * Report the status of the database `.env.development`'s `DATABASE_URL` names. Read-only.
 *
 * @param deps - the env-file read, the connection, and the output sink
 * @throws `TaskError` - when `.env.development` has no `DATABASE_URL`
 * @throws `ReportedError` - when the database can't be reached, after reporting why on stderr
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
		// the report ends in a newline, which a printed line would double
		const report = format_db_status(status).trimEnd();
		if (connected) {
			deps.log.print('database status');
			deps.log.print(`  url: ${display_db_url(database_url)}`);
			deps.log.print(`  driver: ${db_type}`);
			deps.log.print(report);
		} else {
			deps.log.print_error(report);
		}
	} finally {
		await close();
	}
	if (!connected) throw new ReportedError();
};
