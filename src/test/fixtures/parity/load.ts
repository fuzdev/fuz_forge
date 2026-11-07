/**
 * Loader for the shared TS↔Rust parity fixtures.
 *
 * Each fixture under `src/test/fixtures/parity/` is one pure function's (or one
 * closely-bound family's) accepted / rejected / expected case tables, read by
 * **both** backends' unit suites — this loader on the TS side, `include_str!` +
 * `serde_json` on the Rust side. The tables are the assertion; a one-sided edit
 * to either implementation now fails on one side against a table neither side
 * owns.
 *
 * The envelope is `{function, source_ts, source_rust, counts, tables}`:
 *
 * - `function` — the pure function (or family) the tables pin.
 * - `source_ts` / `source_rust` — the implementations under test, as
 *   repo-root-relative paths. Either is a **list** where a fixture has more
 *   than one home on that side (`git_read_bounds` splits its byte caps and its
 *   log page limits across two Rust modules). Both censuses assert the paths
 *   resolve on disk.
 * - `counts` — `<table> -> row count`, asserted by both loaders. A row added on
 *   one side and not the other fails the count on both.
 * - `tables` — `<table> -> rows`. Row shapes by kind: predicate
 *   `{input, accepted, note?}`; multi-predicate `{stderr, ref_miss, path_miss,
 *   bad_pattern, note?}`; transform `{input, expected}` (plus `key` where the
 *   call takes one); json-document `{document, accepted}` (plus `filename` where the
 *   document is read for a named file); argument-list
 *   `{args, accepted}`; constants `{name, value}` (or a name-only `{name}`);
 *   generated `{unit, repeat, accepted}`; stream `{stream, expected}`.
 *
 * A row a side cannot express carries `rust_only: true` / `ts_only: true` and
 * that side's loader skips it; the marker is always accompanied by a `note`
 * saying which language construct is missing.
 *
 * Deliberately **no zod**. The Rust loader validates with `serde` and its own
 * count assertion; a zod schema here would make the TS side's guard the richer
 * of the two and hide a malformed fixture from Rust until it deserialized.
 * Both loaders assert the same three things: `tables` is present, every table
 * is a non-empty array of objects, and `counts[table]` equals its length.
 *
 * @module
 */

import { readFileSync } from 'node:fs';

/** One row of any fixture table — read by shape at the callsite. */
export type ParityRow = Record<string, unknown>;

/** A loaded fixture: the envelope, with `tables` guarded. */
export interface ParityFixture {
	function: string;
	source_ts: string | Array<string>;
	source_rust: string | Array<string>;
	counts: Record<string, number>;
	tables: Record<string, Array<ParityRow>>;
}

/**
 * Read one parity fixture by name (the file's basename, no `.json`).
 *
 * @param name - the fixture basename, e.g. `git_stderr_classification`
 * @returns the parsed envelope
 * @throws when the file is missing, malformed, or its `counts` disagree with
 *   its `tables`
 */
export const load_parity_fixture = (name: string): ParityFixture => {
	const url = new URL(`./${name}.json`, import.meta.url);
	const parsed: unknown = JSON.parse(readFileSync(url, 'utf-8'));
	if (typeof parsed !== 'object' || parsed === null) {
		throw new Error(`parity fixture ${name} is not an object`);
	}
	const fixture = parsed as ParityFixture;
	if (typeof fixture.tables !== 'object' || fixture.tables === null) {
		throw new Error(`parity fixture ${name} has no tables`);
	}
	if (typeof fixture.counts !== 'object' || fixture.counts === null) {
		throw new Error(`parity fixture ${name} has no counts`);
	}
	for (const [table, rows] of Object.entries(fixture.tables)) {
		if (!Array.isArray(rows) || rows.length === 0) {
			throw new Error(`parity fixture ${name} table ${table} is empty`);
		}
		for (const row of rows) {
			if (typeof row !== 'object' || row === null || Array.isArray(row)) {
				throw new Error(`parity fixture ${name} table ${table} has a non-object row`);
			}
		}
		if (fixture.counts[table] !== rows.length) {
			throw new Error(
				`parity fixture ${name} table ${table} declares ${fixture.counts[table]} rows, has ${rows.length}`
			);
		}
	}
	for (const table of Object.keys(fixture.counts)) {
		if (!(table in fixture.tables)) {
			throw new Error(`parity fixture ${name} counts name an absent table ${table}`);
		}
	}
	return fixture;
};

/**
 * The rows of `table`, dropping the ones this side cannot express.
 *
 * @param fixture - a loaded fixture
 * @param table - the table name
 * @returns every row without `rust_only`
 */
export const parity_rows = (fixture: ParityFixture, table: string): Array<ParityRow> => {
	const rows = fixture.tables[table];
	if (rows === undefined) throw new Error(`parity fixture has no table ${table}`);
	return rows.filter((row) => row.rust_only !== true);
};

/** A row's `input` as a string. */
export const parity_string = (row: ParityRow, key: string): string => {
	const value = row[key];
	if (typeof value !== 'string') {
		throw new Error(`parity row ${JSON.stringify(row)} has no string ${key}`);
	}
	return value;
};

/** A row's boolean field. */
export const parity_bool = (row: ParityRow, key: string): boolean => {
	const value = row[key];
	if (typeof value !== 'boolean') {
		throw new Error(`parity row ${JSON.stringify(row)} has no boolean ${key}`);
	}
	return value;
};
