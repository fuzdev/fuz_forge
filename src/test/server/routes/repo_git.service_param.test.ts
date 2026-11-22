/**
 * Unit tests for the git advertise endpoint's `?service=` reader.
 *
 * The table is asserted against `src/test/fixtures/parity/service_param.json`,
 * which the Rust twin's `service_param_reads_the_query_strictly`
 * (`crates/fuz_forge_server/src/forge_git/mod.rs`) reads too. Both sides read
 * the query through their spine's strict reader — here the route context's
 * `query_pairs`, which each row builds with `read_query_pairs`; Hono's
 * `c.req.query` disagrees when a percent-encoded spelling of the key precedes
 * a literal one, and keeps an escape that doesn't decode as text, which is why
 * neither side goes through its framework's helper.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { read_query_pairs } from '@fuzdev/fuz_app/http/request_target.ts';

import { first_service_param } from '#lib/server/routes/repo_git.ts';
import { load_parity_fixture, parity_rows } from '../../fixtures/parity/load.ts';

describe('first_service_param', () => {
	for (const row of parity_rows(load_parity_fixture('service_param'), 'queries')) {
		const raw_query = row.input as string | null;
		const refused = row.refused as string | undefined;
		const expected = row.expected as string | null;
		test(`${JSON.stringify(raw_query)} -> ${JSON.stringify(refused ?? expected)}`, () => {
			const read = first_service_param(read_query_pairs(raw_query));
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
