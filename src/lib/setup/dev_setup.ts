/**
 * The local development setup and reset flows.
 *
 * Dev state is project-local: the forge home is the project's `.fuz_forge/`,
 * the one `gro dev` and `npm run dev:server` run the server with, so the dev
 * forge never touches a `~/.fuz_forge/` pointed at a real server.
 *
 * @module
 */

import { parse_db_name } from '@fuzdev/fuz_app/db/postgres_url.ts';
import {
	create_database,
	read_env_var,
	reset_bootstrap_token,
	reset_database,
	setup_bootstrap_token,
	type PostgresProgramDeps
} from '@fuzdev/fuz_app/dev/setup.ts';
import type {
	EnvDeps,
	FsReadDeps,
	FsRemoveDeps,
	FsWriteDeps
} from '@fuzdev/fuz_app/runtime/deps.ts';
import type { Spawn } from '@fuzdev/gro/spawn.ts';
import { TaskError } from '@fuzdev/gro/task.ts';

import { DEV_ENV_PATH, ensure_env_file } from './env_file.ts';

/** The `RuntimeDeps` slice fuz_app's setup helpers take for these flows. */
export type DevSetupRuntimeDeps = FsReadDeps & FsWriteDeps & FsRemoveDeps & EnvDeps;

/** Capabilities for the development setup and reset flows. */
export interface DevSetupDeps {
	/** The env file, the bootstrap token, and the home's files. */
	runtime: DevSetupRuntimeDeps;
	/** `createdb` and `dropdb`, which create and reset the database `DATABASE_URL` names. */
	postgres: PostgresProgramDeps;
}

/**
 * The Postgres client programs, found on `PATH` through a task's spawn root.
 *
 * Each gets the libpq variables (`PG*`, so a host's `PGHOST` or `PGSSLMODE`
 * still applies where the URL is silent) plus the `env` fuz_app's helpers
 * pass, which carries the URL's password; spawn's base set passes `HOME`, for
 * `~/.pgpass`.
 *
 * @param spawn - the task's spawn root
 * @returns the factories, each making `null` when its program isn't installed
 */
export const to_postgres_programs = (spawn: Spawn): PostgresProgramDeps => ({
	createdb: (env) => spawn.find('createdb', { pass_env: ['PG*'], env }),
	dropdb: (env) => spawn.find('dropdb', { pass_env: ['PG*'], env })
});

/**
 * The dev forge home of the project at `project_dir`.
 *
 * @param project_dir - the project's absolute path
 * @returns its `.fuz_forge/`
 */
export const to_dev_fuz_forge_home = (project_dir: string): string => `${project_dir}/.fuz_forge`;

/** Options for the development setup and reset flows. */
export interface DevSetupOptions {
	/** The dev forge home, absolute, where the bootstrap token is written. */
	fuz_forge_home: string;
}

/**
 * First-time development environment setup: the env file, the bootstrap
 * token, and the database. Idempotent, skipping each step already done.
 *
 * The database is the one `.env.development`'s `DATABASE_URL` names, created
 * on the server it names when it's missing. An in-memory URL needs no
 * `createdb`; any other URL that doesn't end with a Postgres database
 * existing fails the setup.
 *
 * @param deps - fuz_app's setup helpers' capabilities and the Postgres programs
 * @param options - the dev forge home
 * @throws `TaskError` - when `.env.development` and its example are both missing
 * @throws `TaskError` - when `.env.development` has no `DATABASE_URL`, before the token
 * @throws `TaskError` - when its database isn't there at the end: `createdb` failed or isn't
 * installed, or the URL is no database the server opens
 * @mutates filesystem - writes `.env.development` and `<fuz_forge_home>/secret_bootstrap_token`
 * @mutates external database - creates the Postgres database `DATABASE_URL` names when it's missing
 */
export const run_dev_setup = async (
	deps: DevSetupDeps,
	options: DevSetupOptions
): Promise<void> => {
	const { runtime, postgres } = deps;
	const { fuz_forge_home } = options;

	console.log('fuz_forge dev setup');
	console.log(`Home: ${fuz_forge_home}`);
	console.log();

	console.log('Environment file:');
	await ensure_env_file(runtime, DEV_ENV_PATH);
	const database_url = await read_env_var(runtime, DEV_ENV_PATH, 'DATABASE_URL');
	if (!database_url) {
		throw new TaskError(
			`${DEV_ENV_PATH} has no DATABASE_URL. Set one, as its example does, and re-run \`npm run dev:setup\`.`
		);
	}
	console.log();

	console.log('Bootstrap token:');
	await setup_bootstrap_token(runtime, 'fuz_forge', { state_dir: fuz_forge_home });
	console.log();

	console.log('Database:');
	const created = await create_database(postgres, database_url);
	// `create_database` has just logged why; fuz_forge opens no PGlite
	// `file://` database, so only `memory://` needs no Postgres one
	if (
		created.kind === 'skipped' &&
		created.db_type !== 'postgres' &&
		created.db_type !== 'memory'
	) {
		throw new TaskError(
			`The DATABASE_URL in ${DEV_ENV_PATH} names no Postgres database, the only kind dev:setup creates (fuz_forge opens no file:// PGlite database; use postgres:// or memory://).`
		);
	}
	if (created.kind === 'skipped' && created.db_type === 'postgres') {
		throw new TaskError(
			`createdb isn't installed. Install PostgreSQL, or set the DATABASE_URL in ${DEV_ENV_PATH} to memory:// (fuz_forge opens no file:// PGlite database), and re-run \`npm run dev:setup\`.`
		);
	}
	if (created.kind === 'failed') {
		throw new TaskError(
			`The database the DATABASE_URL in ${DEV_ENV_PATH} names was not created. Fix that and re-run \`npm run dev:setup\`.`
		);
	}
	console.log();

	console.log('Done. Next: gro dev');
	console.log();
	console.log('After starting the server, bootstrap your keeper account:');
	console.log('  1. Open the web UI');
	console.log(`  2. Enter the bootstrap token: cat ${fuz_forge_home}/secret_bootstrap_token`);
	console.log('  3. Choose a username and password');
};

/**
 * Reset local development state to a clean slate: drop and recreate the
 * database `.env.development` names and re-mint the bootstrap token, keeping
 * the env file's existing secrets. For a forgotten password or a fresh start.
 *
 * Only a Postgres database is reset, on the server `DATABASE_URL` names; an
 * in-memory URL has nothing to reset, and any other URL refuses.
 *
 * @param deps - fuz_app's setup helpers' capabilities and the Postgres programs
 * @param options - the dev forge home
 * @throws `TaskError` - when `.env.development` has no `DATABASE_URL`, before changing anything
 * @throws `TaskError` - when its database isn't dropped and recreated, before the token
 * @mutates filesystem - replaces `<fuz_forge_home>/secret_bootstrap_token`
 * @mutates external database - drops and recreates the database `DATABASE_URL` names
 */
export const run_dev_reset = async (
	deps: DevSetupDeps,
	options: DevSetupOptions
): Promise<void> => {
	const { runtime, postgres } = deps;
	const { fuz_forge_home } = options;

	console.log('fuz_forge dev reset');
	console.log(`Home: ${fuz_forge_home}`);
	console.log();

	const database_url = await read_env_var(runtime, DEV_ENV_PATH, 'DATABASE_URL');
	if (!database_url) {
		throw new TaskError(
			`Could not read DATABASE_URL from ${DEV_ENV_PATH}. Run \`npm run dev:setup\` first.`
		);
	}

	console.log('Database:');
	const reset = await reset_database({ ...runtime, ...postgres }, database_url);
	// a database that wasn't dropped and recreated, which `reset_database` has
	// just logged why; fuz_forge names no PGlite directory, so a `file://` URL
	// is skipped and refused here too
	if (!reset.reset && reset.db_type !== 'memory') {
		const db_name = parse_db_name(database_url);
		throw new TaskError(
			reset.db_type !== 'postgres'
				? `The DATABASE_URL in ${DEV_ENV_PATH} names no Postgres database, the only kind dev:reset resets.`
				: db_name
					? `The database ${db_name} was not dropped and recreated.`
					: `The DATABASE_URL in ${DEV_ENV_PATH} names no database.`
		);
	}
	console.log();

	console.log('Bootstrap token:');
	await reset_bootstrap_token(runtime, 'fuz_forge', { state_dir: fuz_forge_home });
	console.log();

	console.log('Environment file:');
	await ensure_env_file(runtime, DEV_ENV_PATH);
	console.log();

	console.log('Done. Start the server and bootstrap a new account.');
};
