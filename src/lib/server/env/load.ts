/**
 * Environment loader for backend server.
 *
 * Runtime-agnostic: uses `RuntimeDeps` for environment access.
 * Validates against the shared schema and fails fast on invalid configuration.
 *
 * Lazy loading: env is only validated when first accessed via `load_env`, so
 * the module can be imported without triggering validation.
 *
 * The validated env is cached in a module-level singleton with no reset
 * hatch, deliberately: a process reads its environment once at boot and the
 * server has no reload path, so a second `load_env` returning something other
 * than the first would be a bug rather than a feature.
 *
 * @module
 */

import {
	load_env as load_env_generic,
	EnvValidationError,
	log_env_validation_error
} from '@fuzdev/fuz_app/env/load.ts';
import type { RuntimeDeps } from '@fuzdev/fuz_app/runtime/deps.ts';

import { ServerEnv } from './schema.ts';

let cached_env: ServerEnv | null = null;

/**
 * Load and validate environment variables.
 *
 * Results are cached after first call. Throws on validation failure.
 *
 * @param runtime - runtime with env_get capability
 * @returns validated environment configuration
 */
export const load_env = (runtime: Pick<RuntimeDeps, 'env_get'>): ServerEnv => {
	if (cached_env) return cached_env;

	try {
		cached_env = load_env_generic(ServerEnv, (key) => runtime.env_get(key));
		return cached_env;
	} catch (e) {
		if (e instanceof EnvValidationError) {
			if (e.all_undefined) {
				console.error('[server] No environment configured.');
				console.error('');
				console.error('Options:');
				console.error('  npm run dev:server                Load .env.development');
				console.error('  server_main.ts --env_file <path>  Load from an env file');
				console.error('  Export vars directly              NODE_ENV=... FUZ_ALLOWED_ORIGINS=...');
				console.error('');
				console.error('Required variables:');
				console.error('  NODE_ENV             development | production');
				console.error('  FUZ_ALLOWED_ORIGINS  e.g., http://localhost:5173');
			} else {
				log_env_validation_error(e, 'fuz_forge daemon');
			}
		}
		throw e;
	}
};
