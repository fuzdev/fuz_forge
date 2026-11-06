/**
 * Drift guard for `FUZ_FORGE_API_TOKEN_POLICY_COLUMNS` — the named projection
 * every `fuz_forge_api_token_policy` row read goes through. A dropped column
 * already fails loud at the read; this catches the other direction, a column
 * added to the DDL but not to the const, which would otherwise silently
 * vanish from every row. The Rust `fuz_forge_server` pins its twin const with
 * the same check in its `tests/columns.rs`.
 *
 * @module
 */

import { test } from 'vitest';
import { assert_columns_match_live } from '@fuzdev/fuz_app/testing/db.ts';

import { FUZ_FORGE_API_TOKEN_POLICY_COLUMNS } from '#lib/server/db/fuz_forge_api_token_policy_queries.ts';

import { describe_db } from '../db_fixture.ts';

describe_db('fuz_forge_api_token_policy_queries', (get_db) => {
	test('FUZ_FORGE_API_TOKEN_POLICY_COLUMNS names every live column', async () => {
		await assert_columns_match_live(
			get_db(),
			'fuz_forge_api_token_policy',
			FUZ_FORGE_API_TOKEN_POLICY_COLUMNS
		);
	});
});
