/**
 * The forge's RPC mount as the cross suites resolve it — the **declared**
 * endpoints (`fuz_forge_rpc_endpoints`, no `_testing_*` seams, the surface the
 * spec-derived suites enumerate) and the **live** ones
 * (`fuz_forge_live_rpc_endpoints`, the same build plus the seams both test
 * binaries mount).
 *
 * The live list takes the seams from `create_fuz_forge_testing_rpc_actions` and
 * `create_fuz_forge_testing_final_rpc_actions`, the functions the TS test
 * binary mounts, so a seam added there resolves here with no second list. The
 * action-manifest parity gate holds the Rust binary to the same method set.
 *
 * Both are built on stub deps for method resolution only — the requests go to
 * the spawned backend, which runs its own handlers.
 *
 * @module
 */

import type { DaemonTokenState } from '@fuzdev/fuz_app/auth/daemon_token.ts';
import type { RpcEndpointSpec } from '@fuzdev/fuz_app/http/surface.ts';
import type { AppServerContext } from '@fuzdev/fuz_app/server/app_server_context.ts';
import { stub } from '@fuzdev/fuz_app/testing/stubs.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { build_rpc_endpoint_specs } from '#lib/server/routes/fuz_forge_route_specs.ts';
import {
	create_fuz_forge_testing_final_rpc_actions,
	create_fuz_forge_testing_rpc_actions
} from '#lib/server/testing_rpc_actions.ts';

// Setup-time stub deps: the suites resolve `path` + `spec.method` names
// against a stub ctx; live dispatch happens in the spawned binary, which
// wires its own `build_rpc_endpoint_specs` against the real deps.
const fuz_forge_stub_deps = {
	runtime: stub,
	query_deps: stub,
	seed_from_allow_private_hosts: false,
	log: new Logger('test')
};

/**
 * Daemon-token state for building the seams only to read them — the
 * `_testing_reset` handler that would write it never runs.
 */
const RESOLUTION_ONLY_DAEMON_TOKEN_STATE: DaemonTokenState = {
	current_token: 'resolution_only',
	previous_token: null,
	rotated_at: new Date(0),
	keeper_account_id: null
};

/** The declared RPC endpoints: the production mount, no `_testing_*` seams. */
export const fuz_forge_rpc_endpoints = (ctx: AppServerContext): Array<RpcEndpointSpec> =>
	build_rpc_endpoint_specs(ctx, {
		fuz_forge_deps: fuz_forge_stub_deps,
		extra_actions: [],
		notification_sender: null,
		final_actions_factory: null
	});

/**
 * The RPC endpoints both test binaries live-mount: the declared ones plus the
 * `_testing_*` seams, `_testing_action_manifest` last. What a suite resolving
 * off-surface methods takes as its `live_rpc_endpoints`.
 */
export const fuz_forge_live_rpc_endpoints = (ctx: AppServerContext): Array<RpcEndpointSpec> =>
	build_rpc_endpoint_specs(ctx, {
		fuz_forge_deps: fuz_forge_stub_deps,
		extra_actions: create_fuz_forge_testing_rpc_actions(ctx.deps, {
			daemon_token_state: RESOLUTION_ONLY_DAEMON_TOKEN_STATE,
			session_options: ctx.session_options
		}),
		notification_sender: null,
		final_actions_factory: create_fuz_forge_testing_final_rpc_actions
	});
