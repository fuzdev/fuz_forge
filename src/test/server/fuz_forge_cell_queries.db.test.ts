/**
 * Tests for `query_addressed_cells_by_kind` — the by-kind scan the repo list
 * and the file-store list read, restricted in its SQL to cells at a path.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { query_cell_create } from '@fuzdev/fuz_app/db/cell_queries.ts';

import { query_addressed_cells_by_kind } from '#lib/server/db/fuz_forge_cell_queries.ts';

import { describe_db } from '../db_fixture.ts';

describe_db('query_addressed_cells_by_kind', (get_db) => {
	test('returns the live cells of the kind at a path, newest first, and no other', async () => {
		const deps = { db: get_db() };
		const older = await query_cell_create(deps, { kind: 'file', path: 'files/a', data: {} });
		const newer = await query_cell_create(deps, { kind: 'file', path: 'files/b', data: {} });
		await query_cell_create(deps, { kind: 'file', path: null, data: {} });
		await query_cell_create(deps, { kind: 'repo', path: 'repos/x/y', data: {} });
		const deleted = await query_cell_create(deps, { kind: 'file', path: 'files/c', data: {} });
		await get_db().query(`UPDATE cell SET deleted_at = NOW() WHERE id = $1`, [deleted.id]);
		// `created_at` is the order key; spread the two kept rows apart
		await get_db().query(`UPDATE cell SET created_at = NOW() - interval '1 hour' WHERE id = $1`, [
			older.id
		]);

		const cells = await query_addressed_cells_by_kind(deps, 'file');
		assert.deepStrictEqual(
			cells.map((cell) => cell.id),
			[newer.id, older.id]
		);
	});
});
