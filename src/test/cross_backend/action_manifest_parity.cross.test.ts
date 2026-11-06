/**
 * Cross-backend **action-manifest** parity gate for fuz_forge.
 *
 * The RPC-surface sibling of `schema_parity.cross.test.ts`: where that diffs
 * the two backends' live database schemas, this diffs their live RPC
 * registries. It spawns both (via the dual-spawn `dual_spawn_global_setup`),
 * captures each backend's `_testing_action_manifest` dump — one entry per
 * mounted method carrying `{side_effects, rate_limit, account, actor, roles,
 * credential_types}` — and asserts full equality via
 * `assert_action_manifests_equal`, failing loud with the specific drift.
 *
 * This is the *mechanical* tie the hand-written spec metadata lacks. The Rust
 * side's declared truth is the `crates/fuz_forge_server/src/actions.rs` table
 * and the TS side's is `action_specs.ts`; each has its own in-repo pin, but
 * nothing compared the two mount sets method-for-method until this gate. A
 * method mounted on one backend and forgotten on the other — or mounted with a
 * different auth gate — now fails here rather than in whatever suite happens
 * to drive it.
 *
 * Both manifests exclude protocol actions (`heartbeat` / `peer/ping`) by
 * construction: the two impls organize them differently (the TS forge's HTTP
 * mount never carries them; the Rust registry serves both transports from one
 * list), so including them would be a spurious diff. See the upstream
 * `action_manifest.ts` §Scope.
 *
 * The `rate_limit` column is what ties the per-spec rate-limit **class** across
 * the two mounts — the four forge specs declaring `account` would otherwise be
 * pinned only by the Rust `crates/fuz_forge_server/src/actions.rs` table and
 * the TS `action_specs.ts`, each in-repo and never compared. The *bounds* those
 * classes spend are a separate pin
 * (`src/test/fixtures/parity/rate_limits.json`); this gate is the class.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { inject_parity_handles } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { capture_action_manifest } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { assert_action_manifests_equal } from '@fuzdev/fuz_app/testing/cross_backend/action_manifest_parity.ts';

/**
 * Minimum method count either manifest must carry — the anti-vacuity floor for
 * the equality assertion below. Set just under the live surface (the spine's
 * admin / role-grant-offer / account verbs, the cell verbs, the `fuz_forge_*`
 * RPCs, and the `_testing_*` seams), so it survives ordinary additions but
 * fails loud if a whole family vanishes.
 */
const ACTION_MANIFEST_METHOD_FLOOR = 60;

describe('cross-backend action-manifest parity', () => {
	test('TS (deno) and Rust forge RPC method sets match', async () => {
		const deno = inject_parity_handles().a;
		const rust = inject_parity_handles().b;
		const [deno_manifest, rust_manifest] = await Promise.all([
			capture_action_manifest(deno),
			capture_action_manifest(rust)
		]);
		// Loud floor first: two *empty* manifests are trivially equal, so a
		// backend that lost its mount (or a manifest built before the registry
		// was assembled) would pass the diff silently. The live surface is 67
		// methods; the floor sits just under it.
		assert.ok(
			deno_manifest.methods.length >= ACTION_MANIFEST_METHOD_FLOOR,
			`deno manifest has ${deno_manifest.methods.length} methods, expected at least ${ACTION_MANIFEST_METHOD_FLOOR}`
		);
		assert_action_manifests_equal(deno_manifest, rust_manifest, { a: 'deno', b: 'rust' });
	});
});
