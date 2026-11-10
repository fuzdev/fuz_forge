/**
 * Tests for `server/env/load.ts` — the remediation the TS reference server
 * prints when it boots with no environment at all.
 *
 * That server is not `fuzfd` and `fuzfd` takes no `--env_file`, so the help
 * must name the TS entry's own commands.
 *
 * @module
 */

import { afterEach, assert, describe, test, vi } from 'vitest';

import { load_env } from '#lib/server/env/load.ts';

describe('load_env with no environment', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('throws and points at the TS server entry, not fuzfd', () => {
		const lines: Array<string> = [];
		vi.spyOn(console, 'error').mockImplementation((...args: Array<unknown>) => {
			lines.push(args.map(String).join(' '));
		});
		assert.throws(() => load_env({ env_get: () => undefined }));
		const output = lines.join('\n');
		assert.include(output, 'No environment configured');
		assert.include(output, 'npm run dev:server');
		assert.include(output, 'server_main.ts --env_file <path>');
		assert.notInclude(output, 'fuzfd');
	});
});
