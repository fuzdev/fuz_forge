/**
 * **The parity-fixture census (TS)** — every fixture in this directory is
 * consumed by at least one TS suite, and every name a suite loads exists.
 *
 * ## Why this test exists
 *
 * A shared fixture is only anti-drift while both sides read it. The failure
 * this catches is not "someone changed a row" — the row tables fail loudly on
 * their own — it is **"someone stopped reading the file."** A suite refactored
 * back onto a hand-written table leaves the fixture in place, still correct,
 * still asserted by the *other* backend, and silently no longer a shared
 * contract. Orphaning is invisible without a census, so the set of consumed
 * fixtures is an assertion.
 *
 * The Rust half is `crates/fuz_forge_server/tests/parity_fixture_census.rs`,
 * which asks the same question of the `include_str!` callsites under `crates/`.
 * Both must pass for a fixture to be doing its job.
 *
 * It also loads every fixture, so the loader's own guards — `tables` present,
 * every table non-empty and object-rowed, `counts` agreeing with `tables` —
 * run over the whole directory rather than only the ones a suite happens to
 * touch, and asserts the envelope's descriptive half: a `function`, and a
 * `source_ts` / `source_rust` naming **paths that resolve on disk**. Either
 * source field may be a list where a fixture has more than one home on that
 * side. A source path is the only pointer from a fixture back to the code it
 * pins, so a stale one — a module split, renamed, or merged away — reads as a
 * live reference to a file that no longer exists; the existence check is what
 * keeps it honest, on both sides at once (the Rust census can't check the TS
 * paths any more usefully than this one checks the Rust ones, so this one
 * checks both).
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assert, describe, test } from 'vitest';

import { load_parity_fixture } from './load.ts';

const parity_dir = fileURLToPath(new URL('.', import.meta.url));
const test_root = fileURLToPath(new URL('../..', import.meta.url));
const repo_root = fileURLToPath(new URL('../../../..', import.meta.url));

/** A fixture's `source_ts` / `source_rust`, normalized to a list of paths. */
const source_paths = (value: string | Array<string>): Array<string> =>
	typeof value === 'string' ? [value] : value;

/** Every fixture basename in this directory, sorted. */
const fixture_names = (): Array<string> =>
	readdirSync(parity_dir)
		.filter((file) => file.endsWith('.json'))
		.map((file) => file.slice(0, -'.json'.length))
		.sort();

/**
 * Every `.ts` file under `src/test/`, recursively.
 *
 * Not just `*.test.ts`: a fixture read from a shared helper is consumed as
 * surely as one read from a suite, and the Rust census makes no such
 * distinction — it walks **every** `.rs` under `crates/`. Scanning every
 * module on this side is what lets the two censuses ask one question of one
 * corpus. The name match is safe to widen because it is anchored to a *call
 * with a quoted literal* (`load_parity_fixture('<name>')`), which the
 * definition in `fixtures/parity/load.ts` — whose parameter is a bare
 * `name: string` — cannot satisfy.
 */
const test_side_modules = (dir: string): Array<string> => {
	const found: Array<string> = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			found.push(...test_side_modules(path));
		} else if (entry.endsWith('.ts')) {
			found.push(path);
		}
	}
	return found;
};

/** The fixture names loaded anywhere in the test corpus, sorted. */
const loaded_names = (): Array<string> => {
	const found = new Set<string>();
	for (const file of test_side_modules(test_root)) {
		const source = readFileSync(file, 'utf-8');
		for (const match of source.matchAll(/load_parity_fixture\('([a-z0-9_]+)'\)/g)) {
			found.add(match[1]!);
		}
	}
	return [...found].sort();
};

describe('parity fixtures', () => {
	test('the directory is not empty', () => {
		assert.isAbove(fixture_names().length, 0, 'no parity fixtures found');
	});

	test('every fixture is read by at least one suite', () => {
		const loaded = new Set(loaded_names());
		const orphaned = fixture_names().filter((name) => !loaded.has(name));
		assert.deepStrictEqual(orphaned, [], 'orphaned parity fixtures');
	});

	test('every loaded name names a fixture', () => {
		const present = new Set(fixture_names());
		const missing = loaded_names().filter((name) => !present.has(name));
		assert.deepStrictEqual(missing, [], 'suites load fixtures that do not exist');
	});

	for (const name of fixture_names()) {
		test(`${name} satisfies the envelope guards`, () => {
			const fixture = load_parity_fixture(name);
			assert.isString(fixture.function, `${name} names no function`);
			for (const field of ['source_ts', 'source_rust'] as const) {
				const value = fixture[field];
				const paths = source_paths(value);
				assert.isTrue(
					typeof value === 'string' ||
						(Array.isArray(value) && paths.every((path) => typeof path === 'string')),
					`${name} names no ${field}`
				);
				assert.isAbove(paths.length, 0, `${name} names an empty ${field}`);
				for (const path of paths) {
					const resolved = join(repo_root, path);
					assert.isTrue(
						existsSync(resolved) && statSync(resolved).isFile(),
						`${name} ${field} names a path that is not a file: ${path}`
					);
				}
			}
		});
	}
});
