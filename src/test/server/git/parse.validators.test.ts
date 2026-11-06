/**
 * Unit tests for the argv-safety and sha validators the git read layer runs
 * before it hands anything to a subprocess — `is_safe_ref_name`,
 * `is_full_sha`, and `is_safe_path`.
 *
 * These are the gates between a client string and a `git` argv, so a widened
 * predicate is a command-injection surface and a narrowed one is a 400 for a
 * ref that exists. Each table below is asserted against a shared parity
 * fixture under `src/test/fixtures/parity/` — the Rust twin
 * (`crates/fuz_forge_server/src/forge_git/parse/tests.rs`) reads the same
 * bytes, so a one-sided edit fails on one side against a table neither side
 * owns.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { is_safe_ref_name, is_safe_path, is_full_sha } from '#lib/server/git/parse.ts';
import {
	load_parity_fixture,
	parity_bool,
	parity_rows,
	parity_string
} from '../../fixtures/parity/load.ts';

describe('is_safe_ref_name', () => {
	const fixture = load_parity_fixture('git_ref_name');
	for (const row of parity_rows(fixture, 'refs')) {
		const ref = parity_string(row, 'input');
		const accepted = parity_bool(row, 'accepted');
		test(`${accepted ? 'accepts' : 'rejects'}: ${JSON.stringify(ref)}`, () => {
			assert.strictEqual(is_safe_ref_name(ref), accepted);
		});
	}
	for (const row of parity_rows(fixture, 'generated')) {
		const unit = parity_string(row, 'unit');
		const repeat = row.repeat as number;
		const accepted = parity_bool(row, 'accepted');
		test(`${accepted ? 'accepts' : 'rejects'}: ${JSON.stringify(unit)} x ${repeat}`, () => {
			assert.strictEqual(is_safe_ref_name(unit.repeat(repeat)), accepted);
		});
	}
});

describe('is_full_sha', () => {
	// The uppercase pair is the load-bearing one: git resolves an uppercase sha
	// happily, so a backend that admitted it would page a `fuz_forge_repo_log`
	// cursor the other backend answers with the empty page (the cross suite
	// asserts that shape end-to-end).
	for (const row of parity_rows(load_parity_fixture('git_full_sha'), 'shas')) {
		const sha = parity_string(row, 'input');
		const accepted = parity_bool(row, 'accepted');
		test(`${accepted ? 'accepts' : 'rejects'}: ${JSON.stringify(sha)}`, () => {
			assert.strictEqual(is_full_sha(sha), accepted);
		});
	}
});

describe('is_safe_path', () => {
	// Accepts the root, normal paths, and a `..` *substring* within a segment;
	// rejects whole-segment `.`/`..`, empty segments, and the leading `-`/`/`
	// argv guards.
	const fixture = load_parity_fixture('git_safe_path');
	for (const row of parity_rows(fixture, 'paths')) {
		const path = parity_string(row, 'input');
		const accepted = parity_bool(row, 'accepted');
		test(`${accepted ? 'accepts' : 'rejects'}: ${JSON.stringify(path)}`, () => {
			assert.strictEqual(is_safe_path(path), accepted);
		});
	}

	// The 4096 cap counts UTF-16 code units on both backends; each generated
	// case is a byte-vs-unit boundary a byte measure would answer differently.
	for (const row of parity_rows(fixture, 'generated')) {
		const unit = parity_string(row, 'unit');
		const repeat = row.repeat as number;
		const accepted = parity_bool(row, 'accepted');
		test(`${accepted ? 'accepts' : 'rejects'}: ${JSON.stringify(unit)} x ${repeat}`, () => {
			assert.strictEqual(is_safe_path(unit.repeat(repeat)), accepted);
		});
	}
});
