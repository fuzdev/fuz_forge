/**
 * Tests for `#lib/setup/prod_setup.ts` over the mock runtime: the env file it
 * creates or keeps, the values it reports unset, and its refusal.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import {
	create_recording_setup_flow_logger,
	setup_flow_log_messages
} from '@fuzdev/fuz_app/testing/setup_logger_helpers.ts';
import { is_task_error } from '@fuzdev/gro/task_error.ts';

import { run_prod_setup } from '#lib/setup/prod_setup.ts';
import { create_mock_runtime } from '../runtime_mock.ts';

const EXAMPLE =
	'DEPLOY_HOST=\nDEPLOY_USER=fuz_forge\nDEPLOY_DOMAIN=\nDEPLOY_CERTBOT_EMAIL=\nSECRET_FUZ_COOKIE_KEYS=\n';

const FILLED =
	'DEPLOY_HOST=203.0.113.7\nDEPLOY_USER=fuz_forge\nDEPLOY_DOMAIN=forge.example.test\nDEPLOY_CERTBOT_EMAIL=ops@example.test\nSECRET_FUZ_COOKIE_KEYS=' +
	'c'.repeat(64) +
	'\n';

/** Run the flow over `runtime`, returning its recorded output. */
const run = async (runtime: ReturnType<typeof create_mock_runtime>) => {
	const log = create_recording_setup_flow_logger();
	await run_prod_setup({ runtime, log });
	return log;
};

describe('run_prod_setup', () => {
	test('creates .env.production with a generated key and lists the unset values', async () => {
		const runtime = create_mock_runtime();
		runtime.mock_fs.set('.env.production.example', EXAMPLE);
		const log = await run(runtime);
		assert.match(
			runtime.mock_fs.get('.env.production') ?? '',
			/^SECRET_FUZ_COOKIE_KEYS=[0-9a-f]{64}$/m
		);
		assert.deepEqual(log.entries, [
			['print', 'fuz_forge production setup'],
			['print', ''],
			['print', 'Environment file:'],
			['ok', 'Created .env.production with generated secrets'],
			['print', ''],
			['print', 'Required values:'],
			['print', '  [todo] DEPLOY_HOST — Server IP or hostname'],
			['ok', 'DEPLOY_USER = fuz_forge'],
			['print', "  [todo] DEPLOY_DOMAIN — The forge's public hostname"],
			['print', "  [todo] DEPLOY_CERTBOT_EMAIL — Email for Let's Encrypt certificates"],
			['print', ''],
			['print', '3 values still needed in .env.production.'],
			['print', 'Edit the file, then re-run to verify: npm run prod:setup']
		]);
	});

	test('keeps a filled file as it is and prints the deploy steps with -- before --wetrun', async () => {
		const runtime = create_mock_runtime();
		runtime.mock_fs.set('.env.production', FILLED);
		const log = await run(runtime);
		assert.strictEqual(runtime.mock_fs.get('.env.production'), FILLED);
		assert.deepEqual(setup_flow_log_messages(log, 'ok'), [
			'DEPLOY_HOST = 203.0.113.7',
			'DEPLOY_USER = fuz_forge',
			'DEPLOY_DOMAIN = forge.example.test',
			'DEPLOY_CERTBOT_EMAIL = ops@example.test'
		]);
		assert.deepEqual(setup_flow_log_messages(log, 'print').slice(-6), [
			'Ready to deploy — each script is a dry run until you pass --wetrun,',
			'and a wetrun runs only the plan its dry run previewed:',
			'  npm run apply                # preview the host convergence',
			'  npm run apply -- --wetrun    # converge the host first',
			'  npm run deploy               # preview the release',
			'  npm run deploy -- --wetrun   # deploy refuses to run against a drifted host'
		]);
		assert.notInclude(setup_flow_log_messages(log, 'print').join('\n'), '[todo]');
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
