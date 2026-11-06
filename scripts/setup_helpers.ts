/**
 * fuz_forge-specific setup helpers.
 *
 * Provides the Deno runtime and permissions callback for fuz_forge setup scripts.
 * Setup utilities are imported directly from `@fuzdev/fuz_app/dev/setup`.
 *
 * @module
 */

import { exists } from '@std/fs/exists';

import { create_deno_runtime } from '@fuzdev/fuz_app/runtime/deno.ts';

/** Deno runtime for fuz_forge setup scripts. */
export const runtime = create_deno_runtime([]);

/** Check if a file exists. */
export const file_exists = (path: string): Promise<boolean> => exists(path);

/** Log an OK message with a check prefix. */
export const log_ok = (message: string): void => {
	console.log(`  [ok] ${message}`);
};

/** Result of running a command. */
export interface RunResult {
	success: boolean;
	stdout: string;
	stderr: string;
}

/** Run a command and capture output. */
export const run = async (cmd: Array<string>): Promise<RunResult> => {
	const command = new Deno.Command(cmd[0]!, {
		args: cmd.slice(1),
		stdout: 'piped',
		stderr: 'piped'
	});
	const output = await command.output();
	const decoder = new TextDecoder();
	return {
		success: output.success,
		stdout: decoder.decode(output.stdout).trim(),
		stderr: decoder.decode(output.stderr).trim()
	};
};
