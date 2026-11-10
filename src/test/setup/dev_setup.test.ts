/**
 * Tests for `#lib/setup/dev_setup.ts` over the mock runtime and mock
 * `createdb` / `dropdb`: what the setup and reset create, run, and keep, and
 * their refusals.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { to_createdb_args, to_dropdb_args } from '@fuzdev/fuz_app/db/postgres_url.ts';
import {
	create_mock_program,
	create_mock_program_factory,
	mock_program_exit,
	type MockProgramFactory
} from '@fuzdev/fuz_app/runtime/mock.ts';
import type { Spawn, SpawnProgramOptions } from '@fuzdev/gro/spawn.ts';
import { is_task_error } from '@fuzdev/gro/task.ts';

import {
	run_dev_reset,
	run_dev_setup,
	to_dev_fuz_forge_home,
	to_postgres_programs,
	type DevSetupDeps
} from '#lib/setup/dev_setup.ts';
import { create_mock_runtime, type MockFuzForgeRuntime } from '../runtime_mock.ts';
import { capture_console } from '../capture_console.ts';

const HOME = '/scratch/project/.fuz_forge';
const TOKEN_PATH = `${HOME}/secret_bootstrap_token`;
const DEV_URL = 'postgres://localhost/fuz_forge_dev';
const EXAMPLE = `PORT=4041\nDATABASE_URL=${DEV_URL}\nSECRET_FUZ_COOKIE_KEYS=\n`;
const KEY = 'SECRET_FUZ_COOKIE_KEYS=' + 'a'.repeat(64) + '\n';
const OLD_TOKEN = 'b'.repeat(64) + '\n';

interface TestDeps extends DevSetupDeps {
	runtime: MockFuzForgeRuntime;
	postgres: { createdb: MockProgramFactory; dropdb: MockProgramFactory };
}

/**
 * A mock runtime with `HOME` set, which fuz_app's token helpers require even
 * with `state_dir` given, and `createdb` / `dropdb` that succeed unless given
 * other fakes.
 */
const create_deps = (postgres: Partial<TestDeps['postgres']> = {}): TestDeps => {
	const runtime = create_mock_runtime();
	runtime.mock_env.set('HOME', '/scratch/home');
	return {
		runtime,
		postgres: {
			createdb: postgres.createdb ?? create_mock_program_factory(),
			dropdb: postgres.dropdb ?? create_mock_program_factory()
		}
	};
};

/** The arguments of every call each Postgres program got, `null` for one not installed. */
const calls_of = (deps: TestDeps) => ({
	createdb: deps.postgres.createdb.program?.calls ?? null,
	dropdb: deps.postgres.dropdb.program?.calls ?? null
});

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

/** Run `fn` expecting a `TaskError`, returning its message and the console output before it. */
const task_error_logs = async (
	fn: () => Promise<void>
): Promise<{ logs: Array<string>; errors: Array<string>; message: string }> => {
	const { logs, errors, restore } = capture_console();
	try {
		await fn();
	} catch (error) {
		assert.ok(is_task_error(error), `expected a TaskError, got ${error}`);
		return { logs, errors, message: error.message };
	} finally {
		restore();
	}
	assert.fail('expected a TaskError');
};

const task_error_message = async (fn: () => Promise<void>): Promise<string> =>
	(await task_error_logs(fn)).message;

describe('to_dev_fuz_forge_home', () => {
	test("is the project's .fuz_forge", () => {
		assert.strictEqual(to_dev_fuz_forge_home('/scratch/project'), HOME);
	});
});

describe('to_postgres_programs', () => {
	test('finds each program with the libpq variables and the env it is asked for', () => {
		const finds: Array<[string, SpawnProgramOptions | undefined]> = [];
		const spawn = {
			find: (name: string, options?: SpawnProgramOptions) => {
				finds.push([name, options]);
				return null;
			}
		} as unknown as Spawn;
		const programs = to_postgres_programs(spawn);
		assert.isNull(programs.createdb({ PGPASSWORD: 'pw' }));
		assert.isNull(programs.dropdb({}));
		assert.deepEqual(finds, [
			['createdb', { pass_env: ['PG*'], env: { PGPASSWORD: 'pw' } }],
			['dropdb', { pass_env: ['PG*'], env: {} }]
		]);
	});
});

describe('run_dev_setup', () => {
	test('creates the env file with a generated key, the token, and the database', async () => {
		const deps = create_deps();
		deps.runtime.mock_fs.set('.env.development.example', EXAMPLE);
		const { logs } = await quietly(() => run_dev_setup(deps, { fuz_forge_home: HOME }));

		const env = deps.runtime.mock_fs.get('.env.development');
		assert.ok(env);
		assert.include(env, `PORT=4041\nDATABASE_URL=${DEV_URL}\n`);
		assert.match(env, /^SECRET_FUZ_COOKIE_KEYS=[0-9a-f]{64}$/m);
		assert.match(deps.runtime.mock_fs.get(TOKEN_PATH) ?? '', /^[0-9a-f]{64}\n$/);
		assert.deepEqual(calls_of(deps), {
			createdb: [to_createdb_args('fuz_forge_dev', DEV_URL)],
			dropdb: []
		});
		assert.include(logs, `Home: ${HOME}`);
		assert.include(logs, 'Done. Next: gro dev');
		assert.include(logs, `  2. Enter the bootstrap token: cat ${TOKEN_PATH}`);
	});

	test('keeps an existing env file and token as they are, creating the database it names', async () => {
		const deps = create_deps();
		deps.runtime.mock_fs.set('.env.development.example', EXAMPLE);
		const existing = 'DATABASE_URL=postgres://localhost/mine\n' + KEY;
		deps.runtime.mock_fs.set('.env.development', existing);
		deps.runtime.mock_fs.set(TOKEN_PATH, OLD_TOKEN);
		await quietly(() => run_dev_setup(deps, { fuz_forge_home: HOME }));
		assert.strictEqual(deps.runtime.mock_fs.get('.env.development'), existing);
		assert.strictEqual(deps.runtime.mock_fs.get(TOKEN_PATH), OLD_TOKEN);
		assert.deepEqual(calls_of(deps).createdb, [
			to_createdb_args('mine', 'postgres://localhost/mine')
		]);
	});

	test("backfills an existing env file's empty key, keeping its other lines", async () => {
		const deps = create_deps();
		deps.runtime.mock_fs.set(
			'.env.development',
			'DATABASE_URL=postgres://localhost/mine\nSECRET_FUZ_COOKIE_KEYS=\n'
		);
		await quietly(() => run_dev_setup(deps, { fuz_forge_home: HOME }));
		const env = deps.runtime.mock_fs.get('.env.development') ?? '';
		assert.include(env, 'DATABASE_URL=postgres://localhost/mine\n');
		assert.match(env, /^SECRET_FUZ_COOKIE_KEYS=[0-9a-f]{64}$/m);
	});

	test('an existing env file needs no example', async () => {
		const deps = create_deps();
		const existing = `DATABASE_URL=${DEV_URL}\n` + KEY;
		deps.runtime.mock_fs.set('.env.development', existing);
		await quietly(() => run_dev_setup(deps, { fuz_forge_home: HOME }));
		assert.strictEqual(deps.runtime.mock_fs.get('.env.development'), existing);
	});

	test('reads an existing database as done', async () => {
		const deps = create_deps({
			createdb: create_mock_program_factory(
				create_mock_program(() =>
					mock_program_exit(
						1,
						'createdb: error: database creation failed: ERROR:  database "fuz_forge_dev" already exists'
					)
				)
			)
		});
		deps.runtime.mock_fs.set('.env.development.example', EXAMPLE);
		const { logs } = await quietly(() => run_dev_setup(deps, { fuz_forge_home: HOME }));
		assert.include(logs, 'Done. Next: gro dev');
	});

	test('an in-memory database needs no createdb', async () => {
		const deps = create_deps();
		deps.runtime.mock_fs.set('.env.development', 'DATABASE_URL=memory://\n' + KEY);
		const { logs } = await quietly(() => run_dev_setup(deps, { fuz_forge_home: HOME }));
		assert.deepEqual(calls_of(deps), { createdb: [], dropdb: [] });
		assert.include(logs, 'Done. Next: gro dev');
	});

	test('refuses with neither the env file nor its example, changing nothing', async () => {
		const deps = create_deps();
		const message = await task_error_message(() => run_dev_setup(deps, { fuz_forge_home: HOME }));
		assert.include(message, '.env.development.example');
		assert.isFalse(deps.runtime.mock_fs.has('.env.development'));
		assert.isFalse(deps.runtime.mock_fs.has(TOKEN_PATH));
		assert.deepEqual(calls_of(deps), { createdb: [], dropdb: [] });
	});

	test('refuses an env file with no DATABASE_URL, before the token', async () => {
		const deps = create_deps();
		deps.runtime.mock_fs.set('.env.development', KEY);
		const message = await task_error_message(() => run_dev_setup(deps, { fuz_forge_home: HOME }));
		assert.include(message, '.env.development has no DATABASE_URL');
		assert.isFalse(deps.runtime.mock_fs.has(TOKEN_PATH));
		assert.deepEqual(calls_of(deps), { createdb: [], dropdb: [] });
	});

	test('fails without createdb, after the env file and the token', async () => {
		const deps = create_deps({ createdb: create_mock_program_factory(null) });
		deps.runtime.mock_fs.set('.env.development.example', EXAMPLE);
		const { logs, message } = await task_error_logs(() =>
			run_dev_setup(deps, { fuz_forge_home: HOME })
		);
		assert.include(message, "createdb isn't installed");
		assert.include(logs.join('\n'), 'createdb not found');
		assert.notInclude(logs, 'Done. Next: gro dev');
		assert.deepEqual(deps.postgres.createdb.envs, [{}], 'asked for createdb once');
		assert.isTrue(deps.runtime.mock_fs.has('.env.development'));
		assert.isTrue(deps.runtime.mock_fs.has(TOKEN_PATH));
	});

	test('fails when createdb fails', async () => {
		const deps = create_deps({
			createdb: create_mock_program_factory(
				create_mock_program(() =>
					mock_program_exit(2, 'createdb: error: connection to server failed: Connection refused')
				)
			)
		});
		deps.runtime.mock_fs.set('.env.development.example', EXAMPLE);
		const { logs, errors, message } = await task_error_logs(() =>
			run_dev_setup(deps, { fuz_forge_home: HOME })
		);
		assert.include(message, 'was not created');
		assert.include(errors.join('\n'), 'Connection refused');
		assert.notInclude(logs, 'Done. Next: gro dev');
	});

	for (const url of ['file:///scratch/pglite', 'mysql://localhost/x']) {
		test(`refuses ${url.split(':')[0]}://, which names no Postgres database`, async () => {
			const deps = create_deps();
			deps.runtime.mock_fs.set('.env.development', `DATABASE_URL=${url}\n` + KEY);
			const { logs, message } = await task_error_logs(() =>
				run_dev_setup(deps, { fuz_forge_home: HOME })
			);
			assert.include(message, 'names no Postgres database');
			assert.notInclude(logs, 'Done. Next: gro dev');
			assert.deepEqual(calls_of(deps), { createdb: [], dropdb: [] });
		});
	}
});

describe('run_dev_reset', () => {
	const SCRATCH_URL = 'postgres://localhost/scratch_dev';

	test('drops and recreates the database the env file names and re-mints the token', async () => {
		const deps = create_deps();
		const existing = `DATABASE_URL=${SCRATCH_URL}\n` + KEY;
		deps.runtime.mock_fs.set('.env.development', existing);
		deps.runtime.mock_fs.set(TOKEN_PATH, OLD_TOKEN);
		await quietly(() => run_dev_reset(deps, { fuz_forge_home: HOME }));
		assert.deepEqual(calls_of(deps), {
			dropdb: [to_dropdb_args('scratch_dev', SCRATCH_URL)],
			createdb: [to_createdb_args('scratch_dev', SCRATCH_URL)]
		});
		const token = deps.runtime.mock_fs.get(TOKEN_PATH);
		assert.match(token ?? '', /^[0-9a-f]{64}\n$/);
		assert.notStrictEqual(token, OLD_TOKEN);
		assert.strictEqual(deps.runtime.mock_fs.get('.env.development'), existing, 'secrets kept');
	});

	test("passes the URL's password in the environment, never argv", async () => {
		const deps = create_deps();
		const url = 'postgres://dev:hunter2@localhost/scratch_dev';
		deps.runtime.mock_fs.set('.env.development', `DATABASE_URL=${url}\n` + KEY);
		await quietly(() => run_dev_reset(deps, { fuz_forge_home: HOME }));
		assert.deepEqual(deps.postgres.dropdb.envs, [{ PGPASSWORD: 'hunter2' }]);
		assert.deepEqual(deps.postgres.createdb.envs, [{ PGPASSWORD: 'hunter2' }]);
		assert.notInclude(JSON.stringify(calls_of(deps)), 'hunter2');
	});

	test('refuses when the database is not dropped, before touching the token', async () => {
		const deps = create_deps({
			dropdb: create_mock_program_factory(
				create_mock_program(() =>
					mock_program_exit(1, 'dropdb: error: database is being accessed by other users')
				)
			)
		});
		deps.runtime.mock_fs.set('.env.development', `DATABASE_URL=${SCRATCH_URL}\n`);
		deps.runtime.mock_fs.set(TOKEN_PATH, OLD_TOKEN);
		const message = await task_error_message(() => run_dev_reset(deps, { fuz_forge_home: HOME }));
		assert.include(message, 'The database scratch_dev was not dropped and recreated.');
		assert.deepEqual(calls_of(deps), {
			dropdb: [to_dropdb_args('scratch_dev', SCRATCH_URL)],
			createdb: []
		});
		assert.strictEqual(deps.runtime.mock_fs.get(TOKEN_PATH), OLD_TOKEN);
	});

	test('refuses without dropdb, before touching the token', async () => {
		const deps = create_deps({ dropdb: create_mock_program_factory(null) });
		deps.runtime.mock_fs.set('.env.development', `DATABASE_URL=${SCRATCH_URL}\n`);
		deps.runtime.mock_fs.set(TOKEN_PATH, OLD_TOKEN);
		const message = await task_error_message(() => run_dev_reset(deps, { fuz_forge_home: HOME }));
		assert.include(message, 'The database scratch_dev was not dropped and recreated.');
		assert.deepEqual(calls_of(deps), { dropdb: null, createdb: [] });
		assert.strictEqual(deps.runtime.mock_fs.get(TOKEN_PATH), OLD_TOKEN);
	});

	test('refuses a Postgres URL naming no database, before touching the token', async () => {
		const deps = create_deps();
		deps.runtime.mock_fs.set('.env.development', 'DATABASE_URL=postgres://localhost\n');
		deps.runtime.mock_fs.set(TOKEN_PATH, OLD_TOKEN);
		assert.include(
			await task_error_message(() => run_dev_reset(deps, { fuz_forge_home: HOME })),
			'The DATABASE_URL in .env.development names no database.'
		);
		assert.deepEqual(calls_of(deps), { createdb: [], dropdb: [] });
		assert.strictEqual(deps.runtime.mock_fs.get(TOKEN_PATH), OLD_TOKEN);
	});

	for (const url of ['file:///scratch/pglite', 'mysql://localhost/x']) {
		test(`refuses ${url.split(':')[0]}://, which names no Postgres database, before touching the token`, async () => {
			const deps = create_deps();
			deps.runtime.mock_fs.set('.env.development', `DATABASE_URL=${url}\n`);
			deps.runtime.mock_fs.set(TOKEN_PATH, OLD_TOKEN);
			assert.include(
				await task_error_message(() => run_dev_reset(deps, { fuz_forge_home: HOME })),
				'names no Postgres database'
			);
			assert.deepEqual(calls_of(deps), { createdb: [], dropdb: [] });
			assert.strictEqual(deps.runtime.mock_fs.get(TOKEN_PATH), OLD_TOKEN);
		});
	}

	test('an in-memory database has nothing to reset, and the token is re-minted', async () => {
		const deps = create_deps();
		deps.runtime.mock_fs.set('.env.development', 'DATABASE_URL=memory://\n' + KEY);
		deps.runtime.mock_fs.set(TOKEN_PATH, OLD_TOKEN);
		await quietly(() => run_dev_reset(deps, { fuz_forge_home: HOME }));
		assert.deepEqual(calls_of(deps), { createdb: [], dropdb: [] });
		assert.notStrictEqual(deps.runtime.mock_fs.get(TOKEN_PATH), OLD_TOKEN);
	});

	test('refuses without a DATABASE_URL, before touching the database or the token', async () => {
		const deps = create_deps();
		deps.runtime.mock_fs.set(TOKEN_PATH, OLD_TOKEN);
		const message = await task_error_message(() => run_dev_reset(deps, { fuz_forge_home: HOME }));
		assert.include(message, 'Could not read DATABASE_URL from .env.development');
		assert.include(message, 'npm run dev:setup');
		assert.deepEqual(calls_of(deps), { createdb: [], dropdb: [] });
		assert.strictEqual(deps.runtime.mock_fs.get(TOKEN_PATH), OLD_TOKEN);
	});
});
