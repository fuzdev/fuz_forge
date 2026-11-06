/**
 * Production environment setup.
 *
 * Creates .env.production from the example file, auto-generates secrets,
 * and prints instructions for values that require manual input.
 *
 * `.env.production` is the operator deploy env — `zap` resolves the config's
 * `zap.env('NAME')` references from it.
 * The host's runtime env is generated on the host by `zap`, not from this file.
 *
 * Idempotent — safe to re-run. Re-running validates and shows what's still needed.
 *
 * Usage: deno task prod:setup
 *
 * @module
 */

import {
	setup_env_file,
	default_setup_logger,
	read_env_var
} from '@fuzdev/fuz_app/dev/setup.ts';

import { runtime } from './setup_helpers.ts';

const ENV_PATH = '.env.production';

/** Required values that must be set manually. */
const REQUIRED_MANUAL: Array<{ key: string; description: string }> = [
	{ key: 'DEPLOY_HOST', description: 'Server IP or hostname' },
	{ key: 'DEPLOY_USER', description: 'SSH deploy user (e.g. fuz_forge)' },
	{ key: 'DEPLOY_DOMAIN', description: "The forge's public hostname" },
	{ key: 'DEPLOY_CERTBOT_EMAIL', description: "Email for Let's Encrypt certificates" }
];

const validate_required = async (): Promise<number> => {
	console.log('Required values:');
	let missing = 0;

	for (const { key, description } of REQUIRED_MANUAL) {
		const value = await read_env_var(runtime, ENV_PATH, key);
		if (value) {
			default_setup_logger.ok(`${key} = ${value}`);
		} else {
			console.log(`  [todo] ${key} — ${description}`);
			missing++;
		}
	}

	return missing;
};

console.log('fuz_forge production setup');
console.log();

console.log('Environment file:');
await setup_env_file(runtime, ENV_PATH, '.env.production.example');
console.log();

const missing = await validate_required();
console.log();

if (missing > 0) {
	console.log(`${missing} value${missing > 1 ? 's' : ''} still needed in .env.production.`);
	console.log('Edit the file, then re-run to verify: deno task prod:setup');
} else {
	console.log('Ready to deploy — each task is a dry run until you pass --wetrun,');
	console.log('and a wetrun runs only the plan its dry run previewed:');
	console.log('  deno task apply             # preview the host convergence');
	console.log('  deno task apply --wetrun    # converge the host first');
	console.log('  deno task deploy            # preview the release');
	console.log('  deno task deploy --wetrun   # deploy refuses to run against a drifted host');
}
