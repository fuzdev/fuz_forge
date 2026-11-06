/**
 * Unit tests for the git advertise endpoint's `?service=` reader.
 *
 * The table is asserted against `src/test/fixtures/parity/service_param.json`,
 * which the Rust twin's `service_param_reads_the_query_as_urlsearchparams_does`
 * (`crates/fuz_forge_server/src/forge_git/mod.rs`) reads too. Both sides read
 * the raw query with WHATWG `application/x-www-form-urlencoded` semantics;
 * Hono's `c.req.query` disagrees when a percent-encoded spelling of the key
 * precedes a literal one, which is why neither side goes through its
 * framework's helper.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { first_service_param } from '#lib/server/routes/repo_git.ts';
import { load_parity_fixture, parity_rows } from '../../fixtures/parity/load.ts';

describe('first_service_param', () => {
	for (const row of parity_rows(load_parity_fixture('service_param'), 'queries')) {
		const raw_query = row.input as string | null;
		const expected = row.expected as string | null;
		test(`${JSON.stringify(raw_query)} -> ${JSON.stringify(expected)}`, () => {
			assert.strictEqual(first_service_param(raw_query ?? undefined), expected ?? undefined);
		});
	}
});
