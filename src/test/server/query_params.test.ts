/**
 * Unit tests for the shared raw-query reads.
 *
 * The `first_query_param` table is asserted against
 * `src/test/fixtures/parity/query_param.json`, which the Rust twin
 * (`crates/fuz_forge_server/src/query_params.rs`) reads too — both backends
 * must read a query the same way, since a route that reads it through its
 * framework's helper answers differently on each.
 *
 * `raw_query_of` is TS-side plumbing with no Rust twin (axum hands a handler
 * the raw query directly), so its cases stay local.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { first_query_param, raw_query_of } from '#lib/server/query_params.ts';
import { load_parity_fixture, parity_rows, parity_string } from '../fixtures/parity/load.ts';

describe('first_query_param', () => {
	for (const row of parity_rows(load_parity_fixture('query_param'), 'queries')) {
		const raw_query = row.input as string | null;
		const key = parity_string(row, 'key');
		const expected = row.expected as string | null;
		test(`${JSON.stringify(raw_query)} -> ${JSON.stringify(expected)}`, () => {
			assert.strictEqual(first_query_param(raw_query ?? undefined, key), expected ?? undefined);
		});
	}
});

describe('raw_query_of', () => {
	test('splits the query off a request URL', () => {
		assert.strictEqual(raw_query_of('http://x/api/files/a.bin'), undefined);
		assert.strictEqual(raw_query_of('http://x/api/files/a.bin?'), '');
		assert.strictEqual(raw_query_of('http://x/api/files/a.bin?meta'), 'meta');
		assert.strictEqual(raw_query_of('http://x/api/files/a.bin?meta=1&other=2'), 'meta=1&other=2');
		// A `?` inside the query belongs to the query, not to a second split.
		assert.strictEqual(raw_query_of('http://x/p?a=1?2'), 'a=1?2');
	});
});
