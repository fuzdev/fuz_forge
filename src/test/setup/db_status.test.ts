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
import { is_reported_error, is_task_error } from '@fuzdev/gro/task_error.ts';

import { run_db_status, type DbStatusDeps } from '#lib/setup/db_status.ts';
import { create_mock_runtime } from '../runtime_mock.ts';
import {
	create_recording_setup_flow_logger,
	messages_of,
	type RecordingSetupFlowLogger
} from './setup_flow_logger_recorder.ts';

const runtime_with_url = (database_url: string) => {
	const runtime = create_mock_runtime();
	runtime.mock_fs.set('.env.development', `DATABASE_URL=${database_url}\n`);
	return runtime;
};

/** Run the status over `deps` and a recording logger, returning its output and what it threw. */
const run = async (
	deps: Omit<DbStatusDeps, 'log'>
): Promise<{ log: RecordingSetupFlowLogger; failure: unknown }> => {
	const log = create_recording_setup_flow_logger();
	let failure: unknown;
	try {
		await run_db_status({ ...deps, log });
	} catch (error) {
		failure = error;
	}
	return { log, failure };
};

describe('run_db_status', () => {
	test('reports a reachable database on stdout, closing it', async () => {
		let closed = false;
		const { log, failure } = await run({
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
		assert.deepEqual(messages_of(log, 'print_error'), []);
		const lines = messages_of(log, 'print');
		assert.deepEqual(lines.slice(0, 3), [
			'database status',
			'  url: memory://',
			'  driver: pglet-memory'
		]);
		assert.lengthOf(lines, 4, 'the header, then the report as one block');
		assert.notMatch(lines[3] ?? '', /\n$/, 'the report without its trailing newline');
		assert.ok(closed);
	});

	test('reports an unreachable database on stderr alone and fails silently', async () => {
		let closed = false;
		const unreachable = {
			query: async () => {
				throw new Error('connect ECONNREFUSED 127.0.0.1:1');
			}
		} as unknown as Db;
		const { log, failure } = await run({
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
		assert.ok(is_reported_error(failure));
		assert.deepEqual(log.entries, [
			['print_error', '  connection: FAILED (connect ECONNREFUSED 127.0.0.1:1)']
		]);
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
