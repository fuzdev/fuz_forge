/**
 * Unit tests for the record parsers over **real captured git output** —
 * `parse_log_records`, `parse_ref_records`, `parse_tree_records` against
 * whole streams rather than hand-framed records.
 *
 * The hand-framed cases (`parse.records.test.ts`) say what the parsers do
 * with a shape the tests wrote; these say what they do with the bytes git
 * actually emits, which is the half a wrong assumption about the format
 * string survives. The streams are a shared parity fixture under
 * `src/test/fixtures/parity/` — the Rust twin
 * (`crates/fuz_forge_server/src/forge_git/parse/tests.rs`) reads the same
 * bytes.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { parse_log_records, parse_ref_records, parse_tree_records } from '#lib/server/git/parse.ts';
import { load_parity_fixture, parity_rows, parity_string } from '../../fixtures/parity/load.ts';
import { encode } from './parse_helpers.ts';

describe('real git streams', () => {
	// Captured verbatim from a scratch repo, not written by hand — see each
	// table's `note` in `src/test/fixtures/parity/git_real_streams.json` for the
	// command and the history that produced it. The Rust twin
	// (`forge_git/parse/tests.rs`) reads the same bytes.
	const fixture = load_parity_fixture('git_real_streams');

	for (const [table, parse] of [
		['log', (raw: string) => parse_log_records(encode(raw))],
		['refs', (raw: string) => parse_ref_records(encode(raw))],
		['tree', (raw: string) => parse_tree_records(encode(raw))]
	] as const) {
		for (const row of parity_rows(fixture, table)) {
			test(`${table}: the whole record set matches`, () => {
				assert.deepStrictEqual(parse(parity_string(row, 'stream')), row.expected);
			});
		}
	}
});
