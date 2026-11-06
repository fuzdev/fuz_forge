/**
 * The full unified-cell action bundle — CRUD + grant ACL + field/item
 * relations + per-cell audit — assembled once so the HTTP-RPC mount
 * and the WS mount (`build_rpc_endpoint_specs` and `build_ws_endpoint_specs`
 * in `routes/fuz_forge_route_specs.ts`) can't silently diverge. The grant verbs
 * carry the forge's `fuz_forge_roles`.
 *
 * Delegates to fuz_app's `create_all_cell_actions` so the forge can't drift
 * from the upstream cell surface (a new cell verb lands here automatically);
 * this wrapper role-binds the bundle to `fuz_forge_roles` and mounts
 * `reserved_kind_create_authorize`, which keeps the `repo` and `file` kinds the
 * global admin's to create (`fuz_forge_cell_create_authorize.ts`). Twin:
 * `router/action_registry.rs`.
 *
 * @module
 */

import type { RpcAction } from '@fuzdev/fuz_app/actions/action_types.ts';
import { create_all_cell_actions } from '@fuzdev/fuz_app/auth/all_cell_actions.ts';

import { fuz_forge_roles } from './fuz_forge_roles.ts';
import { reserved_kind_create_authorize } from './fuz_forge_cell_create_authorize.ts';

/**
 * Assemble the unified-cell action bundle for `deps` (the `{log, audit}` set),
 * role-bound to the forge, with the forge's create authorizer mounted.
 */
export const create_cell_bundle_actions = (
	deps: Parameters<typeof create_all_cell_actions>[0]
): Array<RpcAction> =>
	create_all_cell_actions(
		{ ...deps, authorize_create: reserved_kind_create_authorize },
		{ roles: fuz_forge_roles }
	);
