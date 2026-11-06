/**
 * Unit tests for the three git stderr classifiers — `is_no_such_ref_stderr`,
 * `is_no_such_path_stderr`, `is_invalid_pattern_stderr`.
 *
 * They decide the 404-vs-400-vs-503 split a failed `git` call lands on, so a
 * one-sided change makes the same repo answer differently on each backend.
 * The table is a shared parity fixture under `src/test/fixtures/parity/` —
 * the Rust twin (`crates/fuz_forge_server/src/forge_git/parse/tests.rs`)
 * reads the same bytes, so a one-sided edit fails on one side against a table
 * neither side owns.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import {
	is_no_such_ref_stderr,
	is_no_such_path_stderr,
	is_invalid_pattern_stderr
} from '#lib/server/git/parse.ts';
import {
	load_parity_fixture,
	parity_bool,
	parity_rows,
	parity_string
} from '../../fixtures/parity/load.ts';

describe('git stderr classifiers', () => {
	// These predicates gate the 404-vs-400-vs-503 split, so a one-sided change
	// makes the same repo answer differently on each backend. The strings are
	// real git 2.47 output captured from a bare repo.
	//
	// Every case pins **all three** predicates, so a predicate that widens into
	// another's territory fails here rather than silently moving a 404 to a 400.
	// Exclusivity is only *asserted*, never *guaranteed*, and the two halves have
	// different guarantees behind them. For the pattern family it comes from the
	// anchor plus the caller's ordering — the echoed pattern lands past
	// `fatal: header, '` so it cannot forge that predicate, and `read_log` asks
	// that predicate first so a forged sibling cannot win; the
	// `invalid_pattern_collisions` table carries the strings where a sibling
	// genuinely does also match. For the ref/path families it comes from the
	// curated lists alone: those predicates are substring tests over git's own
	// wording, so nothing structural keeps a future git message out of both — a
	// new case has to be added to the fixture to find out. Order belongs to the
	// caller, not the predicates, so it is pinned there (`read.test.ts`
	// § read_log stderr classification, the Rust
	// `read_log_refuses_an_uncompilable_author_pattern` against real git, and the
	// `repo_read_shapes` cross case over both wires).
	const fixture = load_parity_fixture('git_stderr_classification');

	/** Twin: `forge_git/parse/tests.rs`'s `assert_classified`. */
	const assert_classified = (
		stderr: string,
		ref_miss: boolean,
		path_miss: boolean,
		bad_pattern: boolean
	): void => {
		assert.strictEqual(is_no_such_ref_stderr(stderr), ref_miss, 'no_such_ref');
		assert.strictEqual(is_no_such_path_stderr(stderr), path_miss, 'no_such_path');
		assert.strictEqual(is_invalid_pattern_stderr(stderr), bad_pattern, 'invalid_pattern');
	};

	for (const table of [
		'no_such_ref',
		'no_such_path',
		'invalid_pattern',
		'invalid_pattern_collisions',
		'neither',
		'anchor'
	]) {
		for (const row of parity_rows(fixture, table)) {
			const stderr = parity_string(row, 'stderr');
			test(`${table}: ${JSON.stringify(stderr)}`, () => {
				assert_classified(
					stderr,
					parity_bool(row, 'ref_miss'),
					parity_bool(row, 'path_miss'),
					parity_bool(row, 'bad_pattern')
				);
			});
		}
	}
});
