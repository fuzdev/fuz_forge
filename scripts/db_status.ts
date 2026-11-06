/**
 * Show database status: connectivity, tables, migration versions.
 *
 * Prints the same `database status` / `url:` header as `fuzfd db-status` (plus
 * the TS-only `driver:` line), then `format_db_status`'s report. The URL
 * prints without its password or query. When the database can't be reached,
 * prints the failure to stderr alone and exits 1.
 *
 * Usage: deno task db:status
 *
 * @module
 */

import { create_db } from '@fuzdev/fuz_app/db/create_db.ts';
import {
	query_db_status,
	format_db_status,
	display_db_url
} from '@fuzdev/fuz_app/db/status.ts';
import { read_env_var } from '@fuzdev/fuz_app/dev/setup.ts';

import { fuz_forge_migration_namespaces } from '../src/lib/server/db/fuz_forge_schema.ts';
import { runtime } from './setup_helpers.ts';

const database_url = await read_env_var(runtime, '.env.development', 'DATABASE_URL');
if (!database_url) {
	console.error('Could not read DATABASE_URL from .env.development');
	console.error('Run `deno task dev:setup` first.');
	Deno.exit(1);
}

const { db, close, db_type } = await create_db(database_url);

let connected = false;
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
		// failure output is stderr-only, as with `fuzfd db-status`
		console.error(report);
	}
} finally {
	await close();
}

if (!connected) Deno.exit(1);
