import type { Gen } from '@fuzdev/gro/gen.ts';
import {
	ImportBuilder,
	compose_gen_file,
	generate_backend_actions_api
} from '@fuzdev/fuz_app/actions/action_codegen.ts';

import { all_fuz_forge_action_specs } from '../action_specs.ts';

/**
 * Generates the backend's typed broadcast surface:
 * - `BackendActionsApi` — typed broadcast surface used by `create_broadcast_api`.
 * - `broadcast_action_specs` — the matching `ReadonlyArray<ActionSpecUnion>` bundle.
 *
 * The broadcast filter (`kind === 'remote_notification' && initiator !==
 * 'frontend'`, excluding `streams` targets) only matches fuz_forge-owned specs —
 * admin / role_grant_offer / account contribute zero broadcasts. This producer
 * stays single-source against `all_fuz_forge_action_specs` so the helper's
 * default `* as specs from specs_module` namespace import is the only
 * import emitted (no dead imports for the standard auth surfaces).
 *
 * fuz_forge does not emit `BackendActionHandlers` — `build_rpc_endpoint_specs`
 * registers handlers via `Array<RpcAction>` from the forge action factories,
 * not via a `Record<Method, Handler>` mapped type.
 */
/** @nodocs */
export const gen: Gen = ({ origin_path }) => {
	const imports = new ImportBuilder();
	return compose_gen_file({
		origin_path,
		imports,
		blocks: [
			generate_backend_actions_api(all_fuz_forge_action_specs, imports, {
				specs_module: '../action_specs.ts',
				collections_path: '../action_collections.ts'
			})
		]
	});
};
