/**
 * First-time development environment setup.
 *
 * Idempotent — safe to re-run. Skips steps that are already done.
 *
 * Usage: deno task dev:setup
 *
 * @module
 */

import {
	setup_env_file,
	setup_bootstrap_token,
	create_database
} from '@fuzdev/fuz_app/dev/setup.ts';

import { runtime } from './setup_helpers.ts';

// Dev state is project-local: FUZ_FORGE_HOME ($PWD/.fuz_forge, set by the dev
// tasks) keeps the dev forge from colliding with a prod-pointed ~/.fuz_forge/.
// Fall back to $CWD/.fuz_forge so a direct `deno run` of this script (no task)
// still stays project-local rather than touching the global home.
const fuz_forge_home = Deno.env.get('FUZ_FORGE_HOME') ?? `${Deno.cwd()}/.fuz_forge`;

console.log('fuz_forge dev setup');
console.log(`Home: ${fuz_forge_home}`);
console.log();

console.log('Environment file:');
await setup_env_file(runtime, '.env.development', '.env.development.example');
console.log();

console.log('Bootstrap token:');
await setup_bootstrap_token(runtime, 'fuz_forge', { state_dir: fuz_forge_home });
console.log();

console.log('Database:');
await create_database(runtime, 'fuz_forge_dev');
console.log();

console.log('Done. Next: gro dev');
console.log();
console.log('After starting the server, bootstrap your keeper account:');
console.log('  1. Open the web UI');
console.log(`  2. Enter the bootstrap token: cat ${fuz_forge_home}/secret_bootstrap_token`);
console.log('  3. Choose a username and password');
