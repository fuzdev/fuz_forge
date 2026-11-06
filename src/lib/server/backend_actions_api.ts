/**
 * Backend-initiated broadcast notifications for fuz_forge.
 *
 * `fuz_forge_repo_updated` fans out to every WS connection when a push lands
 * on a forge-hosted repo.
 *
 * Mirrors zzz's `server/backend_actions_api.ts` pattern and rides on fuz_app's
 * `create_broadcast_api`. The typed `BackendActionsApi` interface and
 * `broadcast_action_specs` array come from `server/backend_action_types.gen.ts`
 * via `generate_backend_actions_api`.
 *
 * There is no per-connection ACL here: the WS upgrade runs
 * `require_role(ROLE_ADMIN)` before admitting a connection (see
 * `server/server.ts`), so broadcast fan-out is inherently admin-only. Every
 * fuz_forge RPC action already requires `admin`, so the upgrade
 * gate is symmetric with per-action enforcement.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';
import {
	create_broadcast_api,
	type BroadcastTarget
} from '@fuzdev/fuz_app/actions/broadcast_api.ts';

import { broadcast_action_specs, type BackendActionsApi } from './backend_action_types.ts';

export interface CreateBackendActionsApiOptions {
	/** The `/api/ws` endpoint's connection registry — every broadcast goes out on it. */
	registry: BroadcastTarget;
	log?: Logger | null;
}

export const create_backend_actions_api = (
	options: CreateBackendActionsApiOptions
): BackendActionsApi =>
	create_broadcast_api<BackendActionsApi>({
		registry: options.registry,
		specs: broadcast_action_specs,
		log: options.log
	});
