/**
 * fuz_app's registry invariants over `action_specs`, the generated registry
 * the frontend client carries (forge's specs, the standard bundles and the
 * protocol actions): methods unique, the generated `ActionMethod` and
 * `ActionSpecs` holding exactly these specs, and every input accepting `{}` also accepting `undefined` — the
 * asymmetry codegen would type as a required input that a no-argument call
 * then trips at parse.
 *
 * @module
 */

import { describe_action_spec_invariants } from '@fuzdev/fuz_app/testing/action_spec_invariants.ts';

import { action_specs, ActionSpecs } from '#lib/action_collections.ts';
import { ActionMethod } from '#lib/action_metatypes.ts';

describe_action_spec_invariants({
	specs: action_specs,
	method_enum: ActionMethod,
	collections: ActionSpecs
});
