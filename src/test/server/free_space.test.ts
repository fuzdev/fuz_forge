/**
 * Tests for `free_space` — the best-effort disk-budget probe + its pure
 * decision predicate. The TS twin of the Rust `has_sufficient_free_space` /
 * `check_disk_budget` tests in `crates/fuz_forge_server/src/files/disk_budget.rs`
 * — the probe itself is a spine call there (`fuz_sys::fs::free_space_bytes`),
 * so it has no in-repo Rust twin test.
 *
 * The probe path (`free_space_bytes`) is exercised against a real existing dir
 * (succeeds, positive) and a nonexistent path (fails open → `null`); its exact
 * byte total isn't asserted (it's the live host's free space). The reject /
 * accept arithmetic lives in the pure `has_sufficient_free_space` predicate, so
 * that's where the boundary cases are pinned — no live volume needed.
 *
 * @module
 */

import { tmpdir } from 'node:os';

import { assert, test, describe } from 'vitest';

import { free_space_bytes, has_sufficient_free_space } from '#lib/server/free_space.ts';
import { load_parity_fixture, parity_bool, parity_rows } from '../fixtures/parity/load.ts';

describe('has_sufficient_free_space', () => {
	// Asserted against `src/test/fixtures/parity/free_space.json`, which the Rust
	// twin's `free_space_preflight_predicate` reads too. Its `rust_only` row is
	// the `u64` saturation edge: the declared bytes come off a `u64`
	// Content-Length there, and a JS number cannot carry those values exactly.
	for (const row of parity_rows(load_parity_fixture('free_space'), 'cases')) {
		const [free, declared, margin] = row.args as [number, number, number];
		const accepted = parity_bool(row, 'accepted');
		test(`${accepted ? 'accepts' : 'rejects'}: free ${free}, declared ${declared}, margin ${margin}`, () => {
			assert.strictEqual(has_sufficient_free_space(free, declared, margin), accepted);
		});
	}
});

describe('free_space_bytes', () => {
	test('returns a positive byte count for a real existing dir', async () => {
		const free = await free_space_bytes(tmpdir());
		assert.isNotNull(free);
		assert.isAbove(free, 0);
	});

	test('fails open (null) for an unprobeable path', async () => {
		// A nonexistent path can't be probed — the function must fail open so a
		// valid upload isn't rejected because statfs couldn't run.
		const free = await free_space_bytes('/nonexistent-fuz-forge-free-space-probe');
		assert.isNull(free);
	});
});
