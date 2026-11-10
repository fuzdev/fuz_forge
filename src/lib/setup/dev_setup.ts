/**
 * The local development setup and reset flows.
 *
 * Dev state is project-local: the forge home is the project's `.fuz_forge/`,
 * the one `gro dev` and `npm run dev:server` run the server with, so the dev
 * forge never touches a `~/.fuz_forge/` pointed at a real server.
 *
 * @module
 */

import {
	create_database,
	parse_db_name,
	read_env_var,
	reset_bootstrap_token,
	reset_database,
	setup_bootstrap_token
} from '@fuzdev/fuz_app/dev/setup.ts';
import type {
	CommandDeps,
	EnvDeps,
	FsReadDeps,
	FsRemoveDeps,
	FsWriteDeps
} from '@fuzdev/fuz_app/runtime/deps.ts';
import { TaskError } from '@fuzdev/gro/task.ts';

import { DEV_ENV_PATH, ensure_env_file } from './env_file.ts';

/** The database `npm run dev:setup` creates, the one the example's `DATABASE_URL` names. */
const DEV_DATABASE_NAME = 'fuz_forge_dev';

/** The `RuntimeDeps` slice fuz_app's setup helpers take for these flows. */
export type DevSetupRuntimeDeps = FsReadDeps & FsWriteDeps & FsRemoveDeps & EnvDeps & CommandDeps;

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
 * @param runtime - fuz_app's setup helpers' capabilities
 * @param options - the dev forge home
 * @throws `TaskError` - when `.env.development` and its example are both missing
 * @mutates filesystem - writes `.env.development` and `<fuz_forge_home>/secret_bootstrap_token`
 * @mutates external database - creates `fuz_forge_dev` when `createdb` is on `PATH`
 */
export const run_dev_setup = async (
	runtime: DevSetupRuntimeDeps,
	options: DevSetupOptions
): Promise<void> => {
	const { fuz_forge_home } = options;

	console.log('fuz_forge dev setup');
	console.log(`Home: ${fuz_forge_home}`);
	console.log();

	console.log('Environment file:');
	await ensure_env_file(runtime, DEV_ENV_PATH);
	console.log();

	console.log('Bootstrap token:');
	await setup_bootstrap_token(runtime, 'fuz_forge', { state_dir: fuz_forge_home });
	console.log();

	console.log('Database:');
	await create_database(runtime, DEV_DATABASE_NAME);
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
 * @param runtime - fuz_app's setup helpers' capabilities
 * @param options - the dev forge home
 * @throws `TaskError` - when `.env.development` has no `DATABASE_URL`, before changing anything
 * @throws `TaskError` - when its Postgres database can't be dropped and recreated, before the token
 * @mutates filesystem - replaces `<fuz_forge_home>/secret_bootstrap_token`
 * @mutates external database - drops and recreates the database `DATABASE_URL` names
 */
export const run_dev_reset = async (
	runtime: DevSetupRuntimeDeps,
	options: DevSetupOptions
): Promise<void> => {
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
	const reset = await reset_database(runtime, database_url);
	// a Postgres URL whose database wasn't dropped and recreated, which
	// `reset_database` has just logged why
	if (!reset.reset && reset.db_type === 'postgres') {
		const db_name = parse_db_name(database_url);
		throw new TaskError(
			db_name
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
