/**
 * Shared fuz_forge route spec factory used by production server, integration tests,
 * and attack surface helpers.
 *
 * @module
 */

import type { AppServerContext } from '@fuzdev/fuz_app/server/app_server_context.ts';
import { prefix_route_specs, type RouteSpec } from '@fuzdev/fuz_app/http/route_spec.ts';
import type { RpcEndpointSpec } from '@fuzdev/fuz_app/http/surface.ts';
import type { RpcAction } from '@fuzdev/fuz_app/actions/action_types.ts';
import type { WsEndpointSpec } from '@fuzdev/fuz_app/actions/ws_endpoint_spec.ts';
import type { ConnectionRegistry } from '@fuzdev/fuz_app/actions/connection_registry.ts';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import {
	create_health_route_spec,
	create_ready_route_spec,
	create_server_status_route_spec,
	load_expected_schema
} from '@fuzdev/fuz_app/http/common_routes.ts';
import {
	create_serve_cell_fact_route_spec,
	create_serve_fact_route_spec
} from '@fuzdev/fuz_app/server/serve_fact_route.ts';
import { create_account_route_specs } from '@fuzdev/fuz_app/auth/account_routes.ts';
import { create_signup_route_specs } from '@fuzdev/fuz_app/auth/signup_routes.ts';
import { create_standard_rpc_actions } from '@fuzdev/fuz_app/auth/standard_rpc_actions.ts';
import { peer_ping_action } from '@fuzdev/fuz_app/actions/peer_ping.ts';
import type { NotificationSender } from '@fuzdev/fuz_app/auth/role_grant_offer_notifications.ts';
import { create_cell_bundle_actions } from '../cell_bundle.ts';
import type { FinalRpcActionsFactory } from '../app_assembly.ts';
import {
	create_audit_log_route_specs,
	type AuditLogRouteOptions
} from '@fuzdev/fuz_app/auth/audit_log_routes.ts';

import { create_fuz_forge_repo_read_rpc_actions } from './fuz_forge_repo_read.ts';
import { create_fuz_forge_repo_write_rpc_actions } from './fuz_forge_repo_write.ts';
import { create_fuz_forge_token_rpc_actions } from './fuz_forge_token.ts';
import type { FuzForgeRoutesDeps } from './fuz_forge_repo_cell.ts';
import { create_file_route_specs, type FileRoutesDeps } from './files.ts';
import { create_db_route_specs } from './db.ts';
import { create_repo_git_route_specs, type RepoGitRoutesDeps } from './repo_git.ts';
import { create_repo_internal_route_specs, type RepoInternalRoutesDeps } from './repo_internal.ts';

/** fuz_forge-specific deps not available in AppServerContext. */
export interface FuzForgeAppRouteDeps {
	fuz_forge: FuzForgeRoutesDeps;
	files: FileRoutesDeps;
	/** Forge smart-HTTP routes. */
	repo_git: RepoGitRoutesDeps;
	/** Forge internal hook callback routes. */
	repo_internal: RepoInternalRoutesDeps;
	version: string;
	get_uptime_ms: () => number;
	/**
	 * Absolute path of the fact-store disk root the two fact-serving routes
	 * stream external (`file:<shard>/<rest>`) facts from — the same directory
	 * the file store's `PgFactStore` writes into.
	 *
	 * Required rather than optional for the reason `audit_sse` is: omitting it
	 * would silently drop two routes from the generated surface instead of
	 * failing, and the attack-surface snapshot plus the token-surface census
	 * both reconcile against what this factory builds.
	 */
	facts_dir: string;
	/**
	 * Audit log SSE stream wiring — mounts `GET /api/admin/audit/stream`.
	 *
	 * **Required, though upstream's `stream` is optional**, because omitting it
	 * silently drops a route rather than failing: the attack-surface snapshot and
	 * the token surface census both reconcile against what this factory builds,
	 * and a caller that left this off produced a surface missing the one admin
	 * route whose gate is a declared `required_scope` — invisible in both. A
	 * non-serving caller passes an inert stub (`test_audit_sse_deps`) and says so.
	 */
	audit_sse: NonNullable<AuditLogRouteOptions['stream']>;
}

/**
 * Build all fuz_forge route specs.
 *
 * Used by production server, integration tests, and attack surface helpers.
 * Does NOT include bootstrap routes (those are factory-managed by `create_app_server`).
 *
 * Does NOT include the `/api/rpc` or `/api/ws` endpoints — `create_app_server`
 * auto-mounts every `RpcEndpointSpec` passed via `rpc_endpoints` and every
 * `WsEndpointSpec` passed via `ws_endpoints`. Consumers supply those specs
 * through `build_rpc_endpoint_specs` and `build_ws_endpoint_specs` below.
 */
export const create_fuz_forge_app_route_specs = (
	ctx: AppServerContext,
	fuz_forge_deps: FuzForgeAppRouteDeps
): Array<RouteSpec> => [
	create_health_route_spec(),
	// Public readiness check — verifies the live DB schema matches the committed
	// expected column map (`server/expected_schema.json`, the full forge
	// migration-chain bootstrap). zap's post-deploy poll targets this so schema
	// drift (or an unreachable DB) fails the gate and auto-rolls-back. The Rust
	// `fuz_forge_server` mounts the twin `ready_router` over the same fixture.
	create_ready_route_spec({
		expected: load_expected_schema(new URL('../expected_schema.json', import.meta.url)),
		log: ctx.deps.log
	}),
	...prefix_route_specs('/api/account', [
		...create_account_route_specs(ctx.deps, {
			session_options: ctx.session_options,
			login_ip_rate_limiter: ctx.login_ip_rate_limiter,
			login_account_rate_limiter: ctx.login_account_rate_limiter,
			// `/status` is bundled into the account routes upstream (relative
			// `/status`, prefixed here to `/api/account/status`).
			bootstrap_status: ctx.bootstrap_status
		}),
		// `/signup` (invite-gated; `open_signup` defaults false) mirrors the
		// Rust backend so cross-process tests can mint per-test accounts
		// through the production RPC surface against either backend.
		...create_signup_route_specs(ctx.deps, {
			session_options: ctx.session_options,
			signup_ip_rate_limiter: ctx.signup_ip_rate_limiter,
			signup_account_rate_limiter: ctx.signup_account_rate_limiter
		})
	]),
	create_server_status_route_spec({
		version: fuz_forge_deps.version,
		get_uptime_ms: fuz_forge_deps.get_uptime_ms
	}),
	...prefix_route_specs('/api/fuz_forge/files', create_file_route_specs(fuz_forge_deps.files)),
	// Content-addressed fact serving, the generic form of the path-keyed file
	// store above: `GET /api/cells/:cell_id/facts/:hash` serves any viewable
	// cell's referenced bytes (per-reference, authz on the cell→fact edge), and
	// the admin-only `GET /api/facts/:hash` serves them by bare hash. Twin of the
	// Rust forge's `fuz_fact_serving::fact_routers`. Both carry their full
	// `/api/...` paths, so they mount unprefixed.
	//
	// X-Accel offload is off (the disk-stream path). Enabling it in production
	// means building a validated `XAccelConfig` whose nginx facts `location` is
	// `internal;` and passing it as `x_accel` — the same fail-loud boot check the
	// Rust twin makes structural.
	create_serve_cell_fact_route_spec({
		facts_dir: fuz_forge_deps.facts_dir,
		log: ctx.deps.log
	}),
	create_serve_fact_route_spec({
		facts_dir: fuz_forge_deps.facts_dir,
		log: ctx.deps.log
	}),
	// Forge smart-HTTP endpoints — mounted at app root (`/<slug>.git/...`),
	// NOT under `/api/*`. The default cookie / bearer auth middleware
	// only fires on `/api/*` so these routes are exclusively in-handler
	// HTTP Basic + admin role gated. See `repo_git.ts`.
	...create_repo_git_route_specs(fuz_forge_deps.repo_git),
	// Forge internal hook callbacks — loopback-only + per-repo secret;
	// also outside `/api/*`. See `repo_internal.ts`.
	...create_repo_internal_route_specs(fuz_forge_deps.repo_internal),
	// Admin SSE stream (the remaining admin REST — reads + mutations moved to RPC)
	...prefix_route_specs(
		'/api/admin',
		create_audit_log_route_specs({ stream: fuz_forge_deps.audit_sse })
	),
	...prefix_route_specs(
		'/api/db',
		// `ctx.deps` is the audit slice for the row-`DELETE` trail; the
		// browsable-tables allowlist is baked into the forge wrapper.
		create_db_route_specs(ctx.deps, {
			db_type: ctx.backend.db_type,
			db_name: ctx.backend.db_name
		})
	)
];

/** Options for `build_rpc_endpoint_specs` — the same options-object shape as the Rust `BuildRouterOptions`. */
export interface BuildRpcEndpointSpecsOptions {
	/**
	 * Forge RPC handler deps, closed over by the repo read + write action
	 * factories.
	 */
	fuz_forge_deps: FuzForgeRoutesDeps;
	/**
	 * Extra actions folded in after the standard set — the testing server passes
	 * the `_testing_*` bundle here. Production passes `[]`.
	 */
	extra_actions: ReadonlyArray<RpcAction>;
	/**
	 * WS connection registry the role-grant-offer actions fan notifications out through,
	 * or `null` when the caller mounts no socket.
	 */
	notification_sender: NotificationSender | null;
	/**
	 * Builds actions from the assembled list, appended last — for the one action
	 * that has to enumerate the mount it lives on (`_testing_action_manifest`).
	 * Production passes `null`.
	 */
	final_actions_factory: FinalRpcActionsFactory | null;
}

/**
 * The action list both mounts serve, in mount order: the forge's repo read,
 * repo write, and token families, the bundled standard actions (admin +
 * role-grant-offer + account), the generic cell bundle, then the caller's
 * extras. The `/api/rpc` endpoint serves it, and `/api/ws` serves the same
 * set (`build_ws_endpoint_specs`), so the two mounts can't drift — the
 * generated auth attack surface derives its method order from this array.
 *
 * @param ctx - the server context whose `deps` the standard and cell actions close over
 * @param fuz_forge_deps - forge RPC handler deps for the repo read + write families
 * @param notification_sender - where role-grant-offer notifications fan out (the WS connection registry, or `null` where a test mounts RPC alone)
 * @param extra_actions - appended after the shared families
 */
const create_fuz_forge_mount_actions = (
	ctx: AppServerContext,
	fuz_forge_deps: FuzForgeRoutesDeps,
	notification_sender: NotificationSender | null,
	extra_actions: ReadonlyArray<RpcAction>
): Array<RpcAction> => [
	...create_fuz_forge_repo_read_rpc_actions(fuz_forge_deps),
	...create_fuz_forge_repo_write_rpc_actions(fuz_forge_deps),
	...create_fuz_forge_token_rpc_actions(),
	// `notification_sender` is the WS connection registry in production, so an offer
	// created over either transport fans out to the recipient's live sockets. The
	// revoking actions among these queue their closes through
	// `ctx.deps.connection_closer`, which holds that registry, so a revocation
	// closes its sockets (and the audit streams) once the transaction commits.
	...create_standard_rpc_actions({ ...ctx.deps, notification_sender }),
	// Full unified cell surface (CRUD + grant ACL + field/item relations
	// + per-cell audit). The forge's repos/files read the de-hubbed cell
	// table directly; these generic verbs round out the consumer.
	...create_cell_bundle_actions(ctx.deps),
	...extra_actions
];

/**
 * Build the `/api/rpc` endpoint spec(s) for `create_app_server`.
 *
 * Pass to `rpc_endpoints` as a factory — closes over `ctx.deps` for the
 * admin + role-grant-offer action set. Single source of truth for both
 * surface generation and live dispatch; `create_app_server` auto-mounts
 * each entry via `create_rpc_endpoint`.
 */
export const build_rpc_endpoint_specs = (
	ctx: AppServerContext,
	options: BuildRpcEndpointSpecsOptions
): Array<RpcEndpointSpec> => {
	const { fuz_forge_deps, extra_actions, notification_sender, final_actions_factory } = options;
	const actions = [
		...create_fuz_forge_mount_actions(ctx, fuz_forge_deps, notification_sender, extra_actions),
		// The one protocol action that belongs on HTTP as well as WS: an HTTP
		// invocation must reach the handler and refuse `peer_no_transport`
		// rather than `method_not_found`, since the caller asked for a
		// server-initiated round-trip on a transport that has no return socket.
		// `heartbeat` and `cancel` stay WS-only — the WS mount serves this list
		// through `to_ws_actions`, which puts all three protocol actions first
		// and drops this one from the list, so nothing double-registers.
		peer_ping_action
	];
	return [
		{
			path: '/api/rpc',
			actions: final_actions_factory ? [...actions, ...final_actions_factory(actions)] : actions
		}
	];
};

/**
 * Build the `/api/ws` endpoint spec(s) for `create_app_server`.
 *
 * The spec omits `actions`, so `create_app_server` serves the `/api/rpc`
 * endpoint's action set over the socket (`to_ws_actions`: `protocol_actions`
 * first, then the RPC list less its `peer_ping_action`) — one set of handler
 * closures on both transports, so the dashboard can dispatch `account_token_*`,
 * `account_session_*`, admin, role-grant-offer, and cell methods over the live
 * socket, and the testing server's `_testing_*` bundle reaches both, matching
 * the Rust backend's single registry. `create_app_server` auto-mounts the entry
 * through `register_action_ws` with the server's own action rate limiters (one
 * budget per caller across both transports), the server's `allowed_origins`,
 * and the auth middleware ahead of the upgrade.
 *
 * The upgrade is gated on `ROLE_ADMIN`, symmetric with per-action enforcement
 * (every forge action requires `admin`); per-action auth still runs on each
 * message. Because of that gate, broadcast fan-out
 * (`fuz_forge_repo_updated`) is admin-only without a `should_deliver`
 * predicate.
 *
 * @param registry - the endpoint's connection registry, created ahead of assembly because
 *   the broadcast API and the role-grant-offer notification sender of the RPC
 *   action set hold the same instance; `create_app_server` adds it to
 *   `AppDeps.connection_closer`, which the revocation guard closes through
 */
export const build_ws_endpoint_specs = (registry: ConnectionRegistry): Array<WsEndpointSpec> => [
	{ path: '/api/ws', required_roles: [ROLE_ADMIN], registry }
];
