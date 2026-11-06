/**
 * Guards on the forge's `FUZ_FORGE_BROWSABLE_TABLES` declaration — the
 * in-process (always-on) half of the coverage. TS↔Rust identity of the set
 * is pinned by the cross-backend `db_admin_parity` suite; these catch the
 * local footguns that need no spawned backend.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { NON_BROWSABLE_TABLES } from '@fuzdev/fuz_app/http/db_routes.ts';

import { FUZ_FORGE_BROWSABLE_TABLES } from '#lib/server/routes/db.ts';

describe('FUZ_FORGE_BROWSABLE_TABLES', () => {
	test('names no credential-floor table', () => {
		// fuz_app silently subtracts `NON_BROWSABLE_TABLES` even when named,
		// so a floor entry here would be dead weight that reads as if the
		// table were browsable — refuse the drift at the declaration.
		for (const floored of NON_BROWSABLE_TABLES) {
			assert.notInclude(
				FUZ_FORGE_BROWSABLE_TABLES,
				floored,
				`${floored} is on the credential floor and must not be declared browsable`
			);
		}
	});

	test('has no duplicates and is non-empty', () => {
		assert.isAbove(FUZ_FORGE_BROWSABLE_TABLES.length, 0);
		assert.strictEqual(
			new Set(FUZ_FORGE_BROWSABLE_TABLES).size,
			FUZ_FORGE_BROWSABLE_TABLES.length,
			'duplicate table names in the allowlist'
		);
	});
});
