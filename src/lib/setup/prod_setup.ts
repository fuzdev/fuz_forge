/**
 * Production operator setup: creates the forge target's `.env.production` from
 * its example with generated secrets, and reports the values that need manual
 * input. Idempotent, so re-running validates and shows what's still needed.
 *
 * `.env.production` is the operator deploy env: `zap` resolves the config's
 * `zap.env('NAME')` references from it. The host's runtime env is rendered on
 * the host by `zap`, not copied from this file.
 *
 * @module
 */

import { read_env_var } from '@fuzdev/fuz_app/dev/setup.ts';
import type { FsReadDeps, FsWriteDeps } from '@fuzdev/fuz_app/runtime/deps.ts';

import { ensure_env_file, PROD_ENV_PATH } from './env_file.ts';
import type { SetupFlowLogger } from './setup_flow_logger.ts';

/** Required values that must be set manually. */
const REQUIRED_MANUAL: ReadonlyArray<{ key: string; description: string }> = [
	{ key: 'DEPLOY_HOST', description: 'Server IP or hostname' },
	{ key: 'DEPLOY_USER', description: 'SSH deploy user (e.g. fuz_forge)' },
	{ key: 'DEPLOY_DOMAIN', description: "The forge's public hostname" },
	{ key: 'DEPLOY_CERTBOT_EMAIL', description: "Email for Let's Encrypt certificates" }
];

/** The `RuntimeDeps` slice fuz_app's setup helpers take for this flow. */
export type ProdSetupRuntimeDeps = FsReadDeps & FsWriteDeps;

/** Capabilities for the production setup flow. */
export interface ProdSetupDeps {
	/** fuz_app's file capabilities, which create and read `.env.production`. */
	runtime: ProdSetupRuntimeDeps;
	/** Takes the flow's output, fuz_app's helpers' status lines included. */
	log: SetupFlowLogger;
}

/**
 * Print each required manual value's state.
 *
 * @returns how many are still unset
 */
const validate_required = async ({ runtime, log }: ProdSetupDeps): Promise<number> => {
	log.print('Required values:');
	let missing = 0;
	for (const { key, description } of REQUIRED_MANUAL) {
		const value = await read_env_var(runtime, PROD_ENV_PATH, key);
		if (value) {
			log.ok(`${key} = ${value}`);
		} else {
			log.print(`  [todo] ${key} — ${description}`);
			missing++;
		}
	}
	return missing;
};

/**
 * Create and validate `.env.production`, printing what's still needed.
 *
 * @param deps - fuz_app's setup helpers' capabilities and the output sink
 * @throws `TaskError` - when `.env.production` and its example are both missing
 * @mutates filesystem - writes `.env.production`
 */
export const run_prod_setup = async (deps: ProdSetupDeps): Promise<void> => {
	const { runtime, log } = deps;

	log.print('fuz_forge production setup');
	log.print('');

	log.print('Environment file:');
	await ensure_env_file(runtime, PROD_ENV_PATH, log);
	log.print('');

	const missing = await validate_required(deps);
	log.print('');

	if (missing > 0) {
		log.print(`${missing} value${missing > 1 ? 's' : ''} still needed in ${PROD_ENV_PATH}.`);
		log.print('Edit the file, then re-run to verify: npm run prod:setup');
	} else {
		log.print('Ready to deploy — each script is a dry run until you pass --wetrun,');
		log.print('and a wetrun runs only the plan its dry run previewed:');
		log.print('  npm run apply                # preview the host convergence');
		log.print('  npm run apply -- --wetrun    # converge the host first');
		log.print('  npm run deploy               # preview the release');
		log.print('  npm run deploy -- --wetrun   # deploy refuses to run against a drifted host');
	}
};
