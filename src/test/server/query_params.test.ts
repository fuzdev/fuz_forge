/**
 * Unit tests for the shared one-key query read.
 *
 * The `first_query_param` table is asserted against
 * `src/test/fixtures/parity/query_param.json`, which the Rust twin
 * (`crates/fuz_forge_server/src/query_params.rs`) reads too — both backends
 * must read a query the same way, refusing the same undecodable escapes, since
 * a route that reads it through its framework's helper answers differently on
 * each. Each row's raw query goes through the spine's `read_query_pairs`, as
 * the route context's `query_pairs` does.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { read_query_pairs } from '@fuzdev/fuz_app/http/request_target.ts';

import { first_query_param } from '#lib/server/query_params.ts';
import { load_parity_fixture, parity_rows, parity_string } from '../fixtures/parity/load.ts';

describe('first_query_param', () => {
	for (const row of parity_rows(load_parity_fixture('query_param'), 'queries')) {
		const raw_query = row.input as string | null;
		const key = parity_string(row, 'key');
		const refused = row.refused as string | undefined;
		const expected = row.expected as string | null;
		test(`${JSON.stringify(raw_query)} -> ${JSON.stringify(refused ?? expected)}`, () => {
			const read = first_query_param(read_query_pairs(raw_query), key);
			if (refused === undefined) {
				assert.ok(read.ok, 'the query reads');
				assert.strictEqual(read.value, expected ?? undefined);
			} else {
				assert.ok(!read.ok, 'the query is refused');
				assert.strictEqual(read.error, refused);
			}
		});
	}
});
