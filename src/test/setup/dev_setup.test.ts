/**
 * Tests for `#lib/setup/dev_setup.ts` over the mock runtime: what the setup
 * and reset create, run, and keep, and their refusals.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { is_task_error } from '@fuzdev/gro/task.ts';

import { run_dev_reset, run_dev_setup, to_dev_fuz_forge_home } from '#lib/setup/dev_setup.ts';
import { create_mock_runtime } from '../runtime_mock.ts';
import { capture_console } from '../capture_console.ts';

const HOME = '/scratch/project/.fuz_forge';
const TOKEN_PATH = `${HOME}/secret_bootstrap_token`;
const EXAMPLE =
	'PORT=4041\nDATABASE_URL=postgres://localhost/fuz_forge_dev\nSECRET_FUZ_COOKIE_KEYS=\n';

/**
 * A mock runtime with `HOME` set, which fuz_app's token helpers require even
 * with `state_dir` given.
 */
const create_runtime = () => {
	const runtime = create_mock_runtime();
	runtime.mock_env.set('HOME', '/scratch/home');
	return runtime;
};

/** Run `fn` with its console output collected, rethrowing what it throws. */
const quietly = async (fn: () => Promise<void>): Promise<{ logs: Array<string> }> => {
	const { logs, restore } = capture_console();
	try {
		await fn();
	} finally {
		restore();
	}
	return { logs };
};

const task_error_message = async (fn: () => Promise<void>): Promise<string> => {
	try {
		await quietly(fn);
	} catch (error) {
		assert.ok(is_task_error(error), `expected a TaskError, got ${error}`);
		return error.message;
	}
	assert.fail('expected a TaskError');
};

describe('to_dev_fuz_forge_home', () => {
	test("is the project's .fuz_forge", () => {
		assert.strictEqual(to_dev_fuz_forge_home('/scratch/project'), HOME);
	});
});

describe('run_dev_setup', () => {
	test('creates the env file with a generated key, the token, and the database', async () => {
		const runtime = create_runtime();
		runtime.mock_fs.set('.env.development.example', EXAMPLE);
		const { logs } = await quietly(() => run_dev_setup(runtime, { fuz_forge_home: HOME }));

		const env = runtime.mock_fs.get('.env.development');
		assert.ok(env);
		assert.include(env, 'PORT=4041\nDATABASE_URL=postgres://localhost/fuz_forge_dev\n');
		assert.match(env, /^SECRET_FUZ_COOKIE_KEYS=[0-9a-f]{64}$/m);
		assert.match(runtime.mock_fs.get(TOKEN_PATH) ?? '', /^[0-9a-f]{64}\n$/);
		assert.deepEqual(
			runtime.command_calls.map(({ cmd, args }) => [cmd, ...args]),
			[
				['which', 'createdb'],
				['createdb', 'fuz_forge_dev']
			]
		);
		assert.include(logs, `Home: ${HOME}`);
		assert.include(logs, `  2. Enter the bootstrap token: cat ${TOKEN_PATH}`);
	});

	test('keeps an existing env file and token as they are', async () => {
		const runtime = create_runtime();
		runtime.mock_fs.set('.env.development.example', EXAMPLE);
		const existing =
			'DATABASE_URL=postgres://localhost/mine\nSECRET_FUZ_COOKIE_KEYS=' + 'a'.repeat(64) + '\n';
		runtime.mock_fs.set('.env.development', existing);
		runtime.mock_fs.set(TOKEN_PATH, 'b'.repeat(64) + '\n');
		await quietly(() => run_dev_setup(runtime, { fuz_forge_home: HOME }));
		assert.strictEqual(runtime.mock_fs.get('.env.development'), existing);
		assert.strictEqual(runtime.mock_fs.get(TOKEN_PATH), 'b'.repeat(64) + '\n');
	});

	test("backfills an existing env file's empty key, keeping its other lines", async () => {
		const runtime = create_runtime();
		runtime.mock_fs.set(
			'.env.development',
			'DATABASE_URL=postgres://localhost/mine\nSECRET_FUZ_COOKIE_KEYS=\n'
		);
		await quietly(() => run_dev_setup(runtime, { fuz_forge_home: HOME }));
		const env = runtime.mock_fs.get('.env.development') ?? '';
		assert.include(env, 'DATABASE_URL=postgres://localhost/mine\n');
		assert.match(env, /^SECRET_FUZ_COOKIE_KEYS=[0-9a-f]{64}$/m);
	});

	test('an existing env file needs no example', async () => {
		const runtime = create_runtime();
		const existing = 'SECRET_FUZ_COOKIE_KEYS=' + 'a'.repeat(64) + '\n';
		runtime.mock_fs.set('.env.development', existing);
		await quietly(() => run_dev_setup(runtime, { fuz_forge_home: HOME }));
		assert.strictEqual(runtime.mock_fs.get('.env.development'), existing);
	});

	test('refuses with neither the env file nor its example, changing nothing', async () => {
		const runtime = create_runtime();
		const message = await task_error_message(() =>
			run_dev_setup(runtime, { fuz_forge_home: HOME })
		);
		assert.include(message, '.env.development.example');
		assert.isFalse(runtime.mock_fs.has('.env.development'));
		assert.isFalse(runtime.mock_fs.has(TOKEN_PATH));
		assert.deepEqual(runtime.command_calls, []);
	});

	test('skips the database without createdb', async () => {
		const runtime = create_runtime();
		runtime.mock_fs.set('.env.development.example', EXAMPLE);
		runtime.mock_command_results.set('which createdb', {
			success: false,
			code: 1,
			stdout: '',
			stderr: ''
		});
		await quietly(() => run_dev_setup(runtime, { fuz_forge_home: HOME }));
		assert.deepEqual(
			runtime.command_calls.map(({ cmd }) => cmd),
			['which']
		);
	});
});

describe('run_dev_reset', () => {
	test('drops and recreates the database the env file names and re-mints the token', async () => {
		const runtime = create_runtime();
		const existing =
			'DATABASE_URL=postgres://localhost/scratch_dev\nSECRET_FUZ_COOKIE_KEYS=' +
			'a'.repeat(64) +
			'\n';
		runtime.mock_fs.set('.env.development', existing);
		runtime.mock_fs.set(TOKEN_PATH, 'b'.repeat(64) + '\n');
		await quietly(() => run_dev_reset(runtime, { fuz_forge_home: HOME }));
		assert.deepEqual(
			runtime.command_calls.map(({ cmd, args }) => [cmd, ...args]),
			[
				['dropdb', '--if-exists', 'scratch_dev'],
				['createdb', 'scratch_dev']
			]
		);
		const token = runtime.mock_fs.get(TOKEN_PATH);
		assert.match(token ?? '', /^[0-9a-f]{64}\n$/);
		assert.notStrictEqual(token, 'b'.repeat(64) + '\n');
		assert.strictEqual(runtime.mock_fs.get('.env.development'), existing, 'secrets kept');
	});

	test('refuses when the database is not dropped, before touching the token', async () => {
		const runtime = create_runtime();
		runtime.mock_fs.set('.env.development', 'DATABASE_URL=postgres://localhost/scratch_dev\n');
		runtime.mock_fs.set(TOKEN_PATH, 'b'.repeat(64) + '\n');
		runtime.mock_command_results.set('dropdb --if-exists scratch_dev', {
			success: false,
			code: 1,
			stdout: '',
			stderr: 'dropdb: error: database is being accessed by other users'
		});
		const message = await task_error_message(() =>
			run_dev_reset(runtime, { fuz_forge_home: HOME })
		);
		assert.include(message, 'The database scratch_dev was not dropped and recreated.');
		assert.deepEqual(
			runtime.command_calls.map(({ cmd }) => cmd),
			['dropdb']
		);
		assert.strictEqual(runtime.mock_fs.get(TOKEN_PATH), 'b'.repeat(64) + '\n');
	});

	test('refuses a Postgres URL naming no database, before touching the token', async () => {
		const runtime = create_runtime();
		runtime.mock_fs.set('.env.development', 'DATABASE_URL=postgres://localhost\n');
		runtime.mock_fs.set(TOKEN_PATH, 'b'.repeat(64) + '\n');
		assert.include(
			await task_error_message(() => run_dev_reset(runtime, { fuz_forge_home: HOME })),
			'The DATABASE_URL in .env.development names no database.'
		);
		assert.deepEqual(runtime.command_calls, []);
		assert.strictEqual(runtime.mock_fs.get(TOKEN_PATH), 'b'.repeat(64) + '\n');
	});

	test('refuses without a DATABASE_URL, before touching the database or the token', async () => {
		const runtime = create_runtime();
		runtime.mock_fs.set(TOKEN_PATH, 'b'.repeat(64) + '\n');
		const message = await task_error_message(() =>
			run_dev_reset(runtime, { fuz_forge_home: HOME })
		);
		assert.include(message, 'Could not read DATABASE_URL from .env.development');
		assert.include(message, 'npm run dev:setup');
		assert.deepEqual(runtime.command_calls, []);
		assert.strictEqual(runtime.mock_fs.get(TOKEN_PATH), 'b'.repeat(64) + '\n');
	});
});
