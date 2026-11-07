/**
 * Schema tests for `RepoId` (the cell-id UUID handle), its fuz_schema twin,
 * and `RepoSlug`.
 *
 * Both grammars are asserted against `src/test/fixtures/parity/repo_id.json`
 * and `…/repo_slug.json`, the union of what the two backends' suites carried.
 * The Rust twins read the same rows (`fuz_forge_server`'s
 * `handlers/repo_id.rs` and `forge_git/auth.rs`, and the `fuzf` client's
 * `repo_id.rs`), so a zod upgrade that shifts `z.uuid()` semantics — or a
 * one-sided edit to the segment grammar — fails loudly instead of silently
 * forking the grammar.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { z } from 'zod';
import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';
import { parse } from '@fuzdev/fuz_schema/schema.ts';
import { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { ZodUuid } from '@fuzdev/fuz_app/zod_schemas.ts';

import { RepoId, RepoSlug, REPO_SEGMENT_LENGTH_MAX } from '#lib/fuz_forge/repo/repo_id.ts';
import { RepoId as RepoIdFuz } from '#lib/fuz_forge/repo/repo_id_fuz.ts';
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
			const parsed = RepoId.safeParse(id);
			assert.strictEqual(parsed.success, accepted);
			if (accepted) {
				// Ids are case-insensitive; the schema canonicalizes to lowercase.
				assert.strictEqual(parsed.data, id.toLowerCase());
			}
		});
	}

	test("renders the same pattern as fuz_app's Uuid", () => {
		// `RepoId` mirrors the grammar fuz_app keeps private, so the rendered
		// JSON Schemas pin the two regexes equal: a fuz_app upgrade that moves
		// its UUID grammar fails here rather than forking the repo-id grammar.
		const repo_id = z.toJSONSchema(RepoId);
		const uuid = z.toJSONSchema(ZodUuid);
		assert.isString(repo_id.pattern);
		assert.strictEqual(repo_id.pattern, uuid.pattern);
		assert.strictEqual(repo_id.format, uuid.format);
	});
});

describe('RepoId fuz_schema twin', () => {
	for (const row of parity_rows(load_parity_fixture('repo_id'), 'ids')) {
		const id = parity_string(row, 'input');
		const accepted = parity_bool(row, 'accepted');
		test(`${accepted ? 'accepts' : 'rejects'}: ${JSON.stringify(id)}`, () => {
			const parsed = parse(RepoIdFuz, id);
			assert.strictEqual(parsed.ok, accepted);
			if (parsed.ok) assert.strictEqual(parsed.value, id.toLowerCase());
		});
	}

	test("gives the Zod twin's verdict and output on every fixture row and on non-strings", () => {
		const inputs: Array<unknown> = [
			...parity_rows(load_parity_fixture('repo_id'), 'ids').map((row) =>
				parity_string(row, 'input')
			),
			undefined,
			null,
			42,
			['3f8a1c2e-1234-4abc-9def-0123456789ab'],
			{}
		];
		for (const input of inputs) {
			const zod = RepoId.safeParse(input);
			const fuz = parse(RepoIdFuz, input);
			assert.strictEqual(fuz.ok, zod.success, JSON.stringify(input));
			if (fuz.ok && zod.success) assert.strictEqual(fuz.value, zod.data);
		}
	});

	test("renders the same pattern as the Zod twin and fuz_app's fuz_schema Uuid", () => {
		// the fuz_schema `uuid` grammar is fuz_app's, which the Zod `RepoId`
		// mirrors, so the three rendered patterns are one
		const fuz = to_json_schema(RepoIdFuz);
		const zod = z.toJSONSchema(RepoId);
		const fuz_uuid = to_json_schema(Uuid);
		assert.isString(fuz.pattern);
		assert.strictEqual(fuz.pattern, zod.pattern);
		assert.strictEqual(fuz.pattern, fuz_uuid.pattern);
		assert.strictEqual(fuz.format, zod.format);
	});
});

describe('RepoSlug schema', () => {
	const fixture = load_parity_fixture('repo_slug');

	for (const row of parity_rows(fixture, 'slugs')) {
		const slug = parity_string(row, 'input');
		const accepted = parity_bool(row, 'accepted');
		test(`${accepted ? 'accepts' : 'rejects'}: ${JSON.stringify(slug)}`, () => {
			const parsed = RepoSlug.safeParse(slug);
			assert.strictEqual(parsed.success, accepted);
			if (accepted) {
				// Slugs are case-insensitive; the schema canonicalizes to lowercase.
				assert.strictEqual(parsed.data, parity_string(row, 'canonical'));
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
		// The whole-slug `.max()` alone would admit a 65-char segment paired with
		// a short one, so the per-segment `.refine` tightens it. Generated rather
		// than listed, the same way the Rust twin generates it.
		const seg_max = 'a'.repeat(REPO_SEGMENT_LENGTH_MAX);
		const seg_over = 'a'.repeat(REPO_SEGMENT_LENGTH_MAX + 1);
		assert.strictEqual(RepoSlug.parse(`${seg_max}/ok`), `${seg_max}/ok`);
		assert.throws(() => RepoSlug.parse(`${seg_over}/ok`));
		assert.throws(() => RepoSlug.parse(`ok/${seg_over}`));
	});
});
