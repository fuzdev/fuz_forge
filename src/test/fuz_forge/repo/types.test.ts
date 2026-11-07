/**
 * Schema tests for `RepoId` (the cell-id UUID handle) and `RepoSlug`.
 *
 * Both grammars are asserted against `src/test/fixtures/parity/repo_id.json`
 * and `…/repo_slug.json`, the union of what the two backends' suites carried.
 * The Rust twins read the same rows (`fuz_forge_server`'s
 * `handlers/repo_id.rs` and `forge_git/auth.rs`, and the `fuzf` client's
 * `repo_id.rs`), so an upgrade that shifts the UUID grammar — or a
 * one-sided edit to the segment grammar — fails loudly instead of silently
 * forking the grammar.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';
import { parse, parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import {
	FuzForgeRepoCreateInput,
	FuzForgeRepoGetInput,
	FuzForgeRepoListInput,
	FuzForgeRepoLogInput,
	FuzForgeRepoMutationInput
} from '#lib/action_specs.ts';
import { RepoId, RepoSlug, REPO_SEGMENT_LENGTH_MAX } from '#lib/fuz_forge/repo/repo_id.ts';
import {
	load_parity_fixture,
	parity_bool,
	parity_rows,
	parity_string
} from '../../fixtures/parity/load.ts';

describe('RepoId schema', () => {
	for (const row of parity_rows(load_parity_fixture('repo_id'), 'ids')) {
		const id = parity_string(row, 'input');
		const accepted = parity_bool(row, 'accepted');
		test(`${accepted ? 'accepts' : 'rejects'}: ${JSON.stringify(id)}`, () => {
			const parsed = parse(RepoId, id);
			assert.strictEqual(parsed.ok, accepted);
			if (parsed.ok) {
				// Ids are case-insensitive; the schema canonicalizes to lowercase.
				assert.strictEqual(parsed.value, id.toLowerCase());
			}
		});
	}

	test('refuses non-strings', () => {
		for (const input of [undefined, null, 42, ['3f8a1c2e-1234-4abc-9def-0123456789ab'], {}]) {
			assert.isFalse(parse(RepoId, input).ok, JSON.stringify(input));
		}
	});

	test("renders the same pattern as fuz_app's Uuid", () => {
		// both are fuz_schema's `uuid`, so the rendered JSON Schemas pin the
		// grammar equal: a fuz_app upgrade that moves its UUID grammar fails here
		// rather than forking the repo-id grammar
		const repo_id = to_json_schema(RepoId);
		const uuid = to_json_schema(Uuid);
		assert.isString(repo_id.pattern);
		assert.strictEqual(repo_id.pattern, uuid.pattern);
		assert.strictEqual(repo_id.format, uuid.format);
	});
});

describe('RepoSlug schema', () => {
	const fixture = load_parity_fixture('repo_slug');

	for (const row of parity_rows(fixture, 'slugs')) {
		const slug = parity_string(row, 'input');
		const accepted = parity_bool(row, 'accepted');
		test(`${accepted ? 'accepts' : 'rejects'}: ${JSON.stringify(slug)}`, () => {
			const parsed = parse(RepoSlug, slug);
			assert.strictEqual(parsed.ok, accepted);
			if (parsed.ok) {
				// Slugs are case-insensitive; the schema canonicalizes to lowercase.
				assert.strictEqual(parsed.value, parity_string(row, 'canonical'));
			}
		});
	}

	for (const row of parity_rows(fixture, 'constants')) {
		test(`the shared constant ${parity_string(row, 'name')}`, () => {
			// The name is asserted as well as the value, like the Rust twin: a
			// row renamed on one side would otherwise still pass here.
			assert.strictEqual(parity_string(row, 'name'), 'REPO_SEGMENT_LENGTH_MAX');
			assert.strictEqual(REPO_SEGMENT_LENGTH_MAX, row.value);
		});
	}

	test('accepts a segment at the max length but rejects one over it', () => {
		// The whole-slug `max_length` alone would admit a 65-char segment paired
		// with a short one, so the per-segment check tightens it. Generated rather
		// than listed, the same way the Rust twin generates it.
		const seg_max = 'a'.repeat(REPO_SEGMENT_LENGTH_MAX);
		const seg_over = 'a'.repeat(REPO_SEGMENT_LENGTH_MAX + 1);
		assert.strictEqual(parse_or_throw(RepoSlug, `${seg_max}/ok`), `${seg_max}/ok`);
		assert.throws(() => parse_or_throw(RepoSlug, `${seg_over}/ok`));
		assert.throws(() => parse_or_throw(RepoSlug, `ok/${seg_over}`));
	});
});

describe('string bounds count UTF-16 units', () => {
	// The Rust backend counts UTF-16 units (`handlers/input_bounds.rs`), as
	// fuz_schema's `max_length` does, so an astral character (two units) spends
	// two of the bound on both backends. `slug_prefix` is capped at 255.
	const slug_prefix = (value: string): boolean =>
		parse(FuzForgeRepoListInput, { slug_prefix: value }).ok;

	test('an astral string is measured in units, not code points', () => {
		assert.isTrue(slug_prefix('😀'.repeat(127)), '254 units');
		assert.isFalse(slug_prefix('😀'.repeat(128)), '256 units, 128 code points');
		assert.isTrue(slug_prefix('a'.repeat(255)));
		assert.isFalse(slug_prefix('a'.repeat(256)));
	});

	test('a slug of astral characters is refused as off-grammar', () => {
		for (const slug of ['😀😀', '😀a', 'a😀']) assert.isFalse(parse(RepoSlug, slug).ok, slug);
	});
});

describe('action input bounds', () => {
	const ID = '3f8a1c2e-1234-4abc-9def-0123456789ab';

	test('the log limit is an integer in 1..=200, as the Rust twin requires', () => {
		const ok = (limit: unknown): boolean => parse(FuzForgeRepoLogInput, { id: ID, limit }).ok;
		for (const limit of [1, 200, 50.0]) assert.isTrue(ok(limit), String(limit));
		for (const limit of [0, -1, 201, 1.5, '5']) assert.isFalse(ok(limit), String(limit));
	});

	test('the create slug is 3..=129 units before the handler parses it', () => {
		const ok = (slug: string): boolean => parse(FuzForgeRepoCreateInput, { slug }).ok;
		assert.isTrue(ok('a/b'));
		assert.isTrue(ok('a'.repeat(129)));
		assert.isFalse(ok('ab'));
		assert.isFalse(ok('a'.repeat(130)));
	});

	test('get and mutation inputs take exactly one of id or slug', () => {
		for (const schema of [FuzForgeRepoGetInput, FuzForgeRepoMutationInput]) {
			assert.isTrue(parse(schema, { id: ID }).ok);
			assert.isTrue(parse(schema, { slug: 'o/r' }).ok);
			assert.isFalse(parse(schema, { id: ID, slug: 'o/r' }).ok);
			assert.isFalse(parse(schema, {}).ok);
		}
	});
});
