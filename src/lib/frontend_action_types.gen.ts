import type { Gen } from '@fuzdev/gro/gen.ts';
import {
	ImportBuilder,
	compose_gen_file,
	generate_frontend_action_handlers,
	generate_typed_action_event_alias
} from '@fuzdev/fuz_app/actions/action_codegen.ts';

import { all_fuz_forge_action_specs } from './action_specs.ts';

/**
 * Generates frontend action handler types based on spec.initiator.
 * Uses `TypedActionEvent` to carry typed input/output from the generated `ActionEventDatas` map.
 *
 * `include_protocol_actions: true` keeps `heartbeat` / `cancel` slots in the
 * `FrontendActionHandlers` shape for symmetry with the open `ActionMethod`
 * union — runtime handlers for protocol actions are dispatcher-owned and
 * remain undefined.
 *
 * @nodocs
 */
export const gen: Gen = ({ origin_path }) => {
	const imports = new ImportBuilder();
	return compose_gen_file({
		origin_path,
		imports,
		blocks: [
			generate_typed_action_event_alias(imports),
			generate_frontend_action_handlers(all_fuz_forge_action_specs, imports, {
				include_protocol_actions: true
			})
		]
	});
};
