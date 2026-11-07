/**
 * Cross-registry property test for action spec input shapes.
 *
 * Mirrors the fuz_app test at
 * fuz_app's `src/test/auth/action_spec_input_invariants.test.ts`. The
 * asymmetry "schema accepts `{}` but rejects `undefined`" is a bug class:
 * `action_codegen.ts` probes both — when only `{}` parses, the typed
 * `FrontendActionsApi` method signature emits `input:` required, and
 * adapter authors who write `() => api.foo()` trip `ActionEvent.parse`
 * because parsing `undefined` (`parse(spec.input, undefined)`) fails before
 * the call reaches the wire.
 *
 * Two principled fixes; this test passes when either applies:
 *
 * - a default of `{}` at the schema root — when `{}` is a meaningful call
 *   (no-arg list/get). Parsing `undefined` then succeeds.
 * - a `check` to reject `{}` — when empty is meaningless and the
 *   caller must supply data. The typed surface correctly reports
 *   `input:` required.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { parse } from '@fuzdev/fuz_schema/schema.ts';

import { all_fuz_forge_action_specs } from '#lib/action_specs.ts';

describe('action spec input invariants', () => {
	test('every spec input that accepts {} also accepts undefined', () => {
		for (const spec of all_fuz_forge_action_specs) {
			const accepts_empty = parse(spec.input, {}).ok;
			if (!accepts_empty) continue;
			const accepts_undefined = parse(spec.input, undefined).ok;
			assert.ok(
				accepts_undefined,
				`${spec.method}: input accepts {} but rejects undefined — give the schema root a default of {} (or a check if {} should be rejected too)`
			);
		}
	});
});
