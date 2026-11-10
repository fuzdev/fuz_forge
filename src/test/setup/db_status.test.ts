/**
 * Tests for `#lib/setup/db_status.ts`: the report for a reachable database
 * (an in-memory one), the stderr-only report and failure for an unreachable
 * one, and the refusal without a `DATABASE_URL`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { create_db, type CreateDbResult } from '@fuzdev/fuz_app/db/create_db.ts';
import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import { is_silent_error, is_task_error } from '@fuzdev/gro/task.ts';

import { run_db_status, type DbStatusDeps } from '#lib/setup/db_status.ts';
import { create_mock_runtime } from '../runtime_mock.ts';
import { capture_console } from '../capture_console.ts';

const runtime_with_url = (database_url: string) => {
	const runtime = create_mock_runtime();
	runtime.mock_fs.set('.env.development', `DATABASE_URL=${database_url}\n`);
	return runtime;
};

const run = async (
	deps: DbStatusDeps
): Promise<{ logs: Array<string>; errors: Array<string>; failure: unknown }> => {
	const { logs, errors, restore } = capture_console();
	let failure: unknown;
	try {
		await run_db_status(deps);
	} catch (error) {
		failure = error;
	} finally {
		restore();
	}
	return { logs, errors, failure };
};

describe('run_db_status', () => {
	test('reports a reachable database on stdout, closing it', async () => {
		let closed = false;
		const { logs, errors, failure } = await run({
			runtime: runtime_with_url('memory://'),
			connect: async (url) => {
				const result = await create_db(url);
				return {
					...result,
					close: async () => {
						closed = true;
						await result.close();
					}
				};
			}
		});
		assert.isUndefined(failure);
		assert.deepEqual(errors, []);
		assert.strictEqual(logs[0], 'database status');
		assert.match(logs[1] ?? '', /^ {2}url: /);
		assert.match(logs[2] ?? '', /^ {2}driver: /);
		assert.ok(closed);
	});

	test('reports an unreachable database on stderr alone and fails silently', async () => {
		let closed = false;
		const unreachable = {
			query: async () => {
				throw new Error('connect ECONNREFUSED 127.0.0.1:1');
			}
		} as unknown as Db;
		const { logs, errors, failure } = await run({
			runtime: runtime_with_url('postgres://user:secret@127.0.0.1:1/scratch_unreachable'),
			connect: async (): Promise<CreateDbResult> =>
				({
					db: unreachable,
					close: async () => {
						closed = true;
					},
					db_type: 'pg',
					db_name: 'scratch_unreachable'
				}) as unknown as CreateDbResult
		});
		assert.ok(is_silent_error(failure));
		assert.deepEqual(logs, []);
		assert.include(errors.join('\n'), 'ECONNREFUSED');
		assert.notInclude(errors.join('\n'), 'secret');
		assert.ok(closed);
	});

	test('refuses without a DATABASE_URL, connecting to nothing', async () => {
		let connected = false;
		const { failure } = await run({
			runtime: create_mock_runtime(),
			connect: async () => {
				connected = true;
				throw new Error('unreachable');
			}
		});
		assert.ok(is_task_error(failure));
		assert.include(failure.message, 'Could not read DATABASE_URL from .env.development');
		assert.isFalse(connected);
	});
});
