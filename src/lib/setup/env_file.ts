/**
 * The env files the operator tasks create and read.
 *
 * @module
 */

import { setup_env_file, type SetupEnvResult } from '@fuzdev/fuz_app/dev/setup.ts';
import type { FsReadDeps, FsWriteDeps } from '@fuzdev/fuz_app/runtime/deps.ts';
import { TaskError } from '@fuzdev/gro/task.ts';

/** The development env file, created from its example by `npm run dev:setup`. */
export const DEV_ENV_PATH = '.env.development';

/** The forge target's operator deploy env, created from its example by `npm run prod:setup`. */
export const PROD_ENV_PATH = '.env.production';

/**
 * The committed template of an env file.
 *
 * @param env_path - the env file
 * @returns its `.example` beside it
 */
export const to_env_example_path = (env_path: string): string => `${env_path}.example`;

/**
 * Create `env_path` from its example with generated secrets, or backfill the
 * empty generated values of an existing one, which is never overwritten.
 *
 * @param runtime - fuz_app's file capabilities
 * @param env_path - the env file, whose example is read only when it's absent
 * @returns what `setup_env_file` did
 * @throws `TaskError` - when neither file exists
 * @mutates filesystem - writes `env_path` at mode `0o600`
 */
export const ensure_env_file = async (
	runtime: FsReadDeps & FsWriteDeps,
	env_path: string
): Promise<SetupEnvResult> => {
	const example_path = to_env_example_path(env_path);
	if (!(await runtime.stat(env_path))?.is_file && !(await runtime.stat(example_path))?.is_file) {
		throw new TaskError(
			`Neither ${env_path} nor its template ${example_path} exists; restore the template from git.`
		);
	}
	return setup_env_file(runtime, env_path, example_path);
};
