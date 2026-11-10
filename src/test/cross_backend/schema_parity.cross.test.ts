/**
 * Cross-backend schema-parity gate for fuz_forge.
 *
 * fuz_forge is the ecosystem's permanent dual-impl consumer, so its TS
 * (Hono) and Rust (`fuz_forge_server`) backends must converge on the
 * same database schema. This gate spawns both (via the dual-spawn
 * `dual_spawn_global_setup`), captures each backend's live schema over
 * the `_testing_schema_snapshot` RPC (TS introspects via
 * `query_schema_snapshot`, Rust via `fuz_db::query_schema_snapshot`), and
 * asserts **full** structural equality — failing loud with the specific
 * drift.
 *
 * There are no excluded tables: the two backends are converged on the same
 * schema (auth + cell + fact substrate incl. `memo`), and
 * both are cell-primary for file storage (files are cells, bytes are facts —
 * no legacy `fuz_forge_file` table on either side).
 *
 * @module
 */

import { describe, test } from 'vitest';
import { inject_parity_handles } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { capture_schema_snapshot } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { assert_schema_snapshots_equal } from '@fuzdev/fuz_app/testing/schema_parity.ts';

describe('cross-backend schema parity', () => {
	test('TS and Rust forge schemas match', async () => {
		const ts = inject_parity_handles().a;
		const rust = inject_parity_handles().b;
		const [ts_snapshot, rust_snapshot] = await Promise.all([
			capture_schema_snapshot(ts),
			capture_schema_snapshot(rust)
		]);
		assert_schema_snapshots_equal(ts_snapshot, rust_snapshot, { a: 'ts', b: 'rust' });
	});
});
