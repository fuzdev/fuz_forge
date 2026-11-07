/**
 * The `fuz_forge_repo_list` `since` grammar, and its parity with the Rust twin.
 *
 * The accept / reject tables are asserted against
 * `src/test/fixtures/parity/repo_list_since.json`, which the `repo_list_since` test
 * module (`crates/fuz_forge_server/src/handlers/repo_list_since/tests.rs`) reads
 * too. The grammar here is the forge-local `RepoListSince` on the input
 * schema — a datetime regex (seconds optional) under a
 * `max_length` and a year floor `check`; there it is the hand-written `is_iso8601_datetime`
 * behind `require_iso8601_datetime`. Every spelling in the fixture is a shared
 * assertion.
 *
 * **Why the field has a grammar at all.** The filter is resolved by each
 * backend's own date parser — `Date.parse` on TS, a `timestamptz` cast on Rust
 * — and the two disagree in *both* directions.
 *
 * Postgres accepts its special words (`yesterday`, `today`, `now`, `epoch`,
 * `infinity`) and `Date.parse` returns `NaN` for every one, degrading the TS
 * filter to a no-op: `{since: 'yesterday'}` used to filter on the Rust backend
 * and list *everything* on the TS one, and `{since: 'infinity'}` answered zero
 * repos there and every repo here. Those five head the reject table.
 *
 * The other direction is why the schema carries a length cap and a year floor on
 * top of the datetime regex: year `0000` and an unbounded fractional part both
 * pass its shape and are refused by the Postgres cast, so they answered
 * `-32603` on Rust against a `200` here. Those three close the reject table.
 *
 * `fuz_forge_repo_log`'s `since` is deliberately a different grammar — git's
 * approxidate, handed to `git log --since=` verbatim on both backends — and so
 * is not covered here.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import { FuzForgeRepoListInput } from '#lib/action_specs.ts';
import { SINCE_MAX_LENGTH } from '#lib/fuz_forge/repo/repo_list_since.ts';
import {
	load_parity_fixture,
	parity_bool,
	parity_rows,
	parity_string
} from '../../fixtures/parity/load.ts';

const fixture = load_parity_fixture('repo_list_since');

describe('FuzForgeRepoListInput since', () => {
	test('an absent since is the unfiltered list', () => {
		const parsed = parse(FuzForgeRepoListInput, {});
		assert.isTrue(parsed.ok, JSON.stringify(parsed));
		assert.isUndefined(parsed.ok ? parsed.value.since : undefined);
	});

	for (const row of parity_rows(fixture, 'since')) {
		const since = parity_string(row, 'input');
		const accepted = parity_bool(row, 'accepted');
		test(`${accepted ? 'accepts' : 'rejects'}: ${JSON.stringify(since)}`, () => {
			const parsed = parse(FuzForgeRepoListInput, { since });
			assert.strictEqual(parsed.ok, accepted);
			if (parsed.ok) {
				// The schema admits without normalizing, so the handler filters on
				// the caller's own bytes — the same string the Rust twin binds.
				assert.strictEqual(parsed.value.since, since);
				// The property the grammar buys: past the schema, `Date.parse` cannot
				// answer `NaN`, so the handler's filter always runs. That is what
				// makes the TS reading of a value equal to the Rust one — without the
				// grammar, a `NaN` here means "no filter" where the Postgres cast
				// there means "filter".
				assert.isFalse(Number.isNaN(Date.parse(since)), 'must parse to an instant');
			}
		});
	}

	for (const row of parity_rows(fixture, 'constants')) {
		test(`the shared constant ${parity_string(row, 'name')}`, () => {
			// The name is asserted as well as the value, like the Rust twin: a
			// row renamed on one side would otherwise still pass here.
			assert.strictEqual(parity_string(row, 'name'), 'SINCE_MAX_LENGTH');
			assert.strictEqual(SINCE_MAX_LENGTH, row.value);
		});
	}

	/**
	 * The cap is a real bound, not decoration: it is what keeps the shape's
	 * unbounded `\.\d+` fraction inside what the Rust backend's `timestamptz`
	 * cast will parse. Pinned at the boundary from both sides so a widened cap
	 * fails here rather than as a `-32603` on the other backend.
	 */
	test('the length cap sits exactly at SINCE_MAX_LENGTH', () => {
		const at_cap = `2020-01-01T00:00:00.${'1'.repeat(SINCE_MAX_LENGTH - 21)}Z`;
		assert.strictEqual(at_cap.length, SINCE_MAX_LENGTH);
		assert.isTrue(
			parse(FuzForgeRepoListInput, { since: at_cap }).ok,
			'a value exactly at the cap is admitted'
		);
		const over_cap = `2020-01-01T00:00:00.${'1'.repeat(SINCE_MAX_LENGTH - 20)}Z`;
		assert.strictEqual(over_cap.length, SINCE_MAX_LENGTH + 1);
		assert.isFalse(
			parse(FuzForgeRepoListInput, { since: over_cap }).ok,
			'one character past the cap is refused'
		);
	});
});
