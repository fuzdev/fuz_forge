/**
 * Pure tests for `narrow_repo_cell_data`.
 *
 * Locks down the cell-data narrowing in isolation so regressions
 * surface without spinning up a database.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { narrow_repo_cell_data } from '#lib/fuz_forge/repo/plan_repo.ts';

describe('narrow_repo_cell_data', () => {
	test('a minted stamp is a wire timestamp or absent, else the cell is skipped', () => {
		const base = {
			slug: 'fuzdev/fuz_app',
			name: 'fuz_app',
			default_branch: 'main',
			hook_secret_hash: 'secret'
		};
		for (const key of ['seed_completed_at', 'last_pushed_at']) {
			assert.isNotNull(narrow_repo_cell_data({ ...base, [key]: '2026-01-01T00:00:00Z' }), key);
			assert.isNotNull(narrow_repo_cell_data({ ...base, [key]: null }), key);
			for (const bad of ['yesterday', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00.123Z']) {
				assert.isNull(narrow_repo_cell_data({ ...base, [key]: bad }), `${key} ${bad}`);
			}
		}
	});

	test('parses a well-shaped cell data object', () => {
		const data = narrow_repo_cell_data({
			slug: 'fuzdev/fuz_app',
			name: 'fuz_app',
			default_branch: 'main',
			seed_from: null,
			seed_completed_at: null,
			hook_secret_hash: 'secret'
		});
		assert.isNotNull(data);
		assert.strictEqual(data.slug, 'fuzdev/fuz_app');
		assert.strictEqual(data.name, 'fuz_app');
		assert.strictEqual(data.default_branch, 'main');
		assert.isNull(data.seed_from);
		assert.isNull(data.seed_completed_at);
		assert.strictEqual(data.hook_secret_hash, 'secret');
		// Push-derived fields default to null on a freshly-created cell.
		assert.isNull(data.head_sha);
		assert.isNull(data.last_pushed_at);
		assert.isNull(data.last_pushed_by);
		assert.isNull(data.last_push_username);
	});

	test('parses cell data with push-derived fields populated', () => {
		const data = narrow_repo_cell_data({
			slug: 'fuzdev/fuz_app',
			name: 'fuz_app',
			default_branch: 'main',
			seed_from: null,
			seed_completed_at: null,
			hook_secret_hash: 'secret',
			head_sha: 'abc123',
			last_pushed_at: '2026-05-13T12:00:00Z',
			last_pushed_by: '00000000-0000-0000-0000-000000000001',
			last_push_username: 'ryan'
		});
		assert.isNotNull(data);
		assert.strictEqual(data.head_sha, 'abc123');
		assert.strictEqual(data.last_pushed_at, '2026-05-13T12:00:00Z');
		assert.strictEqual(data.last_pushed_by, '00000000-0000-0000-0000-000000000001');
		assert.strictEqual(data.last_push_username, 'ryan');
	});

	test('returns null for non-object input', () => {
		assert.isNull(narrow_repo_cell_data(null));
		assert.isNull(narrow_repo_cell_data('string'));
		assert.isNull(narrow_repo_cell_data(123));
		assert.isNull(narrow_repo_cell_data([1, 2, 3]));
	});

	test('returns null when slug is missing or wrong type', () => {
		assert.isNull(narrow_repo_cell_data({ default_branch: 'main', hook_secret_hash: 's' }));
		assert.isNull(
			narrow_repo_cell_data({ slug: 42, default_branch: 'main', hook_secret_hash: 's' })
		);
	});

	test('returns null when name is missing or wrong type', () => {
		assert.isNull(
			narrow_repo_cell_data({ slug: 'org/x', default_branch: 'main', hook_secret_hash: 's' })
		);
		assert.isNull(
			narrow_repo_cell_data({
				slug: 'org/x',
				name: 42,
				default_branch: 'main',
				hook_secret_hash: 's'
			})
		);
	});

	test('returns null when hook_secret_hash is missing', () => {
		assert.isNull(narrow_repo_cell_data({ slug: 's', name: 'x', default_branch: 'main' }));
		// A plaintext `hook_secret` in its place does not stand in for the digest.
		assert.isNull(
			narrow_repo_cell_data({ slug: 's', name: 'x', default_branch: 'main', hook_secret: 's' })
		);
	});

	test('returns null when default_branch is missing', () => {
		assert.isNull(narrow_repo_cell_data({ slug: 's', name: 'x', hook_secret_hash: 'secret' }));
	});

	test('accepts an absent or null optional field as null', () => {
		const data = narrow_repo_cell_data({
			slug: 'org/x',
			name: 'x',
			default_branch: 'main',
			seed_from: null,
			hook_secret_hash: 's'
		});
		assert.isNotNull(data);
		assert.isNull(data.seed_from);
		assert.isNull(data.seed_completed_at);
		assert.isNull(data.head_sha);
	});

	test('returns null for a wrong-typed optional field', () => {
		// Not coerced to null — a type-corrupt cell is a malformed cell, the
		// same verdict the Rust `RepoCellData`'s `Option<String>` fields give
		// (serde rejects `{"head_sha": 5}`). Coercing here made such a cell a
		// live repo on this backend and a missing one on the other.
		for (const [key, bad] of [
			['seed_from', 42],
			['seed_completed_at', { bogus: true }],
			['head_sha', 5],
			['last_pushed_at', true],
			['last_pushed_by', ['a']],
			['last_push_username', 0]
		] as const) {
			assert.isNull(
				narrow_repo_cell_data({
					slug: 'org/x',
					name: 'x',
					default_branch: 'main',
					hook_secret_hash: 's',
					[key]: bad
				}),
				`wrong-typed ${key} must fail the narrow`
			);
		}
	});

	test('drops keys the shape does not name without failing the narrow', () => {
		// Unknown keys are not an error (the Rust twin has no
		// `deny_unknown_fields` either) — they simply aren't on the narrow.
		// Every write-back path spreads the raw cell object, so they survive.
		const data = narrow_repo_cell_data({
			slug: 'org/x',
			name: 'x',
			default_branch: 'main',
			hook_secret_hash: 's',
			x_extra: 1
		});
		assert.isNotNull(data);
		assert.isUndefined((data as Record<string, unknown>).x_extra);
	});
});
