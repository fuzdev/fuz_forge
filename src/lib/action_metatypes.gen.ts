import type { Gen } from '@fuzdev/gro/gen.ts';
import {
	type ActionMethodEnumKind,
	ImportBuilder,
	compose_gen_file,
	generate_action_method_enums,
	generate_frontend_actions_api
} from '@fuzdev/fuz_app/actions/action_codegen.ts';
import { all_standard_action_specs } from '@fuzdev/fuz_app/auth/standard_action_specs.ts';

import { all_fuz_forge_action_specs } from './action_specs.ts';

/**
 * Generated action metatypes — method enums + typed `FrontendActionsApi`.
 *
 * Sources mirror the server's `rpc_endpoints` factory in
 * `server/routes/fuz_forge_route_specs.ts`: fuz_forge-specific specs plus the standard
 * surface (admin + role_grant_offer + account) bundled by
 * `create_standard_rpc_actions`. Keep the two in sync when adding a spec
 * group — the typed `FrontendActionsApi` must reflect every method the
 * server actually serves so `ThrowingApi<FrontendActionsApi>` satisfies
 * `AdminRpcApi` at the admin layout.
 *
 * Method-enum kinds split by intent:
 * - **Open unions** (`ActionMethod`, `RequestResponseActionMethod`,
 *   `RemoteNotificationActionMethod`, `LocalCallActionMethod`,
 *   `FrontendActionMethod`, `BackendActionMethod`) include protocol actions
 *   (`heartbeat`, `cancel`) — they enumerate every dispatchable method.
 * - **Narrow handler-driving enums** (`FrontendRequestResponseMethod`,
 *   `BackendRequestResponseMethod`, `BroadcastActionMethod`) exclude protocol
 *   actions — they drive typed handler maps where protocol handlers don't
 *   belong (they ship dispatcher-owned via `protocol_actions`).
 *
 * `FrontendActionsApi` keeps protocol actions as callable methods so consumers
 * can invoke `app.api.heartbeat()` for explicit dispatches.
 *
 * `generate_action_method_enums` and `generate_frontend_actions_api` operate
 * on the spec list directly (no per-spec identifier emission), so this
 * producer doesn't need `create_namespace_qualifier`.
 */
const OPEN_UNION_KINDS: ReadonlySet<ActionMethodEnumKind> = new Set([
	'all',
	'request_response',
	'remote_notification',
	'local_call',
	'frontend',
	'backend'
]);
const HANDLER_NARROW_KINDS: ReadonlySet<ActionMethodEnumKind> = new Set([
	'frontend_handled',
	'backend_handled',
	'broadcast'
]);

/** @nodocs */
export const gen: Gen = ({ origin_path }) => {
	const all_specs = [...all_fuz_forge_action_specs, ...all_standard_action_specs];
	const imports = new ImportBuilder();
	return compose_gen_file({
		origin_path,
		imports,
		blocks: [
			generate_action_method_enums(all_specs, imports, {
				emit: OPEN_UNION_KINDS,
				include_protocol_actions: true
			}),
			generate_action_method_enums(all_specs, imports, {
				emit: HANDLER_NARROW_KINDS
			}),
			generate_frontend_actions_api(all_specs, imports, {
				include_protocol_actions: true
			})
		]
	});
};
