/**
 * Reset local development state to a clean slate.
 *
 * Drops and recreates the database and re-mints the bootstrap token; existing
 * secrets in `.env.development` are kept.
 * Useful when you forget your password or want a fresh start.
 *
 * Usage: deno task dev:reset
 *
 * @module
 */

import {
	read_env_var,
	reset_database,
	reset_bootstrap_token,
	setup_env_file
} from '@fuzdev/fuz_app/dev/setup.ts';

import { runtime } from './setup_helpers.ts';

// Mirror dev_setup's project-local home so the reset removes the right token.
const fuz_forge_home = Deno.env.get('FUZ_FORGE_HOME') ?? `${Deno.cwd()}/.fuz_forge`;

console.log('fuz_forge dev reset');
console.log(`Home: ${fuz_forge_home}`);
console.log();

const database_url = await read_env_var(runtime, '.env.development', 'DATABASE_URL');
if (!database_url) {
	console.error('Could not read DATABASE_URL from .env.development');
	console.error('Run `deno task dev:setup` first.');
	Deno.exit(1);
}

console.log('Database:');
await reset_database(runtime, database_url);
console.log();

console.log('Bootstrap token:');
await reset_bootstrap_token(runtime, 'fuz_forge', { state_dir: fuz_forge_home });
console.log();

console.log('Environment file:');
await setup_env_file(runtime, '.env.development', '.env.development.example');
console.log();

console.log('Done. Start the server and bootstrap a new account.');
