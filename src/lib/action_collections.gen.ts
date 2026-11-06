import type { Gen } from '@fuzdev/gro/gen.ts';
import {
	ImportBuilder,
	compose_gen_file,
	create_namespace_qualifier,
	generate_action_event_datas,
	generate_action_inputs_outputs,
	generate_action_specs_record
} from '@fuzdev/fuz_app/actions/action_codegen.ts';
import { all_admin_action_specs } from '@fuzdev/fuz_app/auth/admin_action_specs.ts';
import { all_role_grant_offer_action_specs } from '@fuzdev/fuz_app/auth/role_grant_offer_action_specs.ts';
import { all_account_action_specs } from '@fuzdev/fuz_app/auth/account_action_specs.ts';

import { all_fuz_forge_action_specs } from './action_specs.ts';

/**
 * Generated action collection types from fuz_forge + standard action specs.
 *
 * Multi-source consumer: `create_namespace_qualifier` registers `* as ns`
 * imports for each source on the shared `ImportBuilder` and threads a
 * per-spec `qualify_spec` callback through the helpers so emitted
 * identifiers like `admin_specs.account_list_action_spec` resolve to the
 * right module.
 *
 * `include_protocol_actions: true` keeps `heartbeat` / `cancel` in the
 * runtime arrays + typed maps so the registry built from `action_specs`
 * covers every dispatchable method and `ActionInputs[method]` resolves
 * uniformly. The narrow handler-side enums in `action_metatypes.ts`
 * exclude protocols separately (see comment there).
 *
 * Mirrors the server's `rpc_endpoints` factory in
 * `server/routes/fuz_forge_route_specs.ts` (fuz_forge-specific + standard surface bundled
 * by `create_standard_rpc_actions`). Add a row when wiring a new spec group.
 *
 * @nodocs
 */
export const gen: Gen = ({ origin_path }) => {
	const imports = new ImportBuilder();
	const { qualify_spec, all_specs } = create_namespace_qualifier(
		[
			{ ns: 'fuz_forge_specs', module: './action_specs.ts', specs: all_fuz_forge_action_specs },
			{
				ns: 'admin_specs',
				module: '@fuzdev/fuz_app/auth/admin_action_specs.ts',
				specs: all_admin_action_specs
			},
			{
				ns: 'role_grant_offer_specs',
				module: '@fuzdev/fuz_app/auth/role_grant_offer_action_specs.ts',
				specs: all_role_grant_offer_action_specs
			},
			{
				ns: 'account_specs',
				module: '@fuzdev/fuz_app/auth/account_action_specs.ts',
				specs: all_account_action_specs
			}
		],
		imports
	);
	const options = { qualify_spec, include_protocol_actions: true };
	return compose_gen_file({
		origin_path,
		imports,
		blocks: [
			generate_action_specs_record(all_specs, imports, options),
			generate_action_inputs_outputs(all_specs, imports, options),
			generate_action_event_datas(all_specs, imports, options)
		]
	});
};
