/**
 * Tests for `#lib/setup/prod_setup.ts` over the mock runtime: the env file it
 * creates or keeps, the values it reports unset, and its refusal.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { is_task_error } from '@fuzdev/gro/task.ts';

import { run_prod_setup } from '#lib/setup/prod_setup.ts';
import { create_mock_runtime } from '../runtime_mock.ts';
import { capture_console } from '../capture_console.ts';

const EXAMPLE =
	'DEPLOY_HOST=\nDEPLOY_USER=fuz_forge\nDEPLOY_DOMAIN=\nDEPLOY_CERTBOT_EMAIL=\nSECRET_FUZ_COOKIE_KEYS=\n';

const FILLED =
	'DEPLOY_HOST=203.0.113.7\nDEPLOY_USER=fuz_forge\nDEPLOY_DOMAIN=forge.example.test\nDEPLOY_CERTBOT_EMAIL=ops@example.test\nSECRET_FUZ_COOKIE_KEYS=' +
	'c'.repeat(64) +
	'\n';

const run = async (runtime: ReturnType<typeof create_mock_runtime>): Promise<Array<string>> => {
	const { logs, restore } = capture_console();
	try {
		await run_prod_setup(runtime);
	} finally {
		restore();
	}
	return logs;
};

describe('run_prod_setup', () => {
	test('creates .env.production with a generated key and lists the unset values', async () => {
		const runtime = create_mock_runtime();
		runtime.mock_fs.set('.env.production.example', EXAMPLE);
		const logs = await run(runtime);
		assert.match(
			runtime.mock_fs.get('.env.production') ?? '',
			/^SECRET_FUZ_COOKIE_KEYS=[0-9a-f]{64}$/m
		);
		assert.include(logs, '  [todo] DEPLOY_HOST — Server IP or hostname');
		assert.notInclude(logs.join('\n'), '[todo] DEPLOY_USER');
		assert.include(logs, '3 values still needed in .env.production.');
		assert.include(logs, 'Edit the file, then re-run to verify: npm run prod:setup');
	});

	test('keeps a filled file as it is and prints the deploy steps with -- before --wetrun', async () => {
		const runtime = create_mock_runtime();
		runtime.mock_fs.set('.env.production', FILLED);
		const logs = await run(runtime);
		assert.strictEqual(runtime.mock_fs.get('.env.production'), FILLED);
		const text = logs.join('\n');
		assert.include(text, 'npm run apply -- --wetrun');
		assert.include(text, 'npm run deploy -- --wetrun');
		assert.notInclude(text, '[todo]');
	});

	test('refuses with neither .env.production nor its example', async () => {
		const runtime = create_mock_runtime();
		let failure: unknown;
		try {
			await run(runtime);
		} catch (error) {
			failure = error;
		}
		assert.ok(is_task_error(failure));
		assert.include(failure.message, '.env.production.example');
		assert.isFalse(runtime.mock_fs.has('.env.production'));
	});
});
