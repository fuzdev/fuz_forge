/**
 * FuzForgeApp — top-level application context for the fuz_forge frontend.
 *
 * Bundles the typed RPC client, WebSocket client, and shared state. Provided
 * via Svelte context in the admin layout.
 *
 * Transport strategy (`create_frontend_rpc_client`'s `ws` lane):
 * - WebSocket — every `request_response` action, and receiving backend
 *   broadcasts (`fuz_forge_repo_updated`).
 * - HTTP RPC — the fallback while the socket is down; reads go as `GET`s.
 *   Login, signup, bootstrap, and the file store are REST routes outside it.
 *
 * Backend notifications dispatch through
 * `environment.lookup_action_handler(method, 'receive')` into the static
 * handlers in `ui/fuz_forge_action_handlers.ts`, which fan out to the notification
 * bus that backs `on_notification`.
 *
 * @module
 */

import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';
import { FrontendWebsocketClient } from '@fuzdev/fuz_app/actions/socket.svelte.ts';
import { to_same_origin_ws_url } from '@fuzdev/fuz_app/actions/transports_ws.ts';
import { create_frontend_rpc_client } from '@fuzdev/fuz_app/actions/frontend_rpc_client.ts';
import type { ThrowingApi } from '@fuzdev/fuz_app/actions/rpc_client.ts';

import { action_specs } from '../action_collections.ts';
import type { FrontendActionsApi } from '../action_metatypes.ts';
import type { FrontendActionHandlers } from '../frontend_action_types.ts';
import { Capabilities } from './capabilities.svelte.ts';
import { create_fuz_forge_action_handlers } from './fuz_forge_action_handlers.ts';
import {
	create_fuz_forge_notification_bus,
	type FuzForgeNotificationHandler,
	type FuzForgeNotificationMethod
} from './fuz_forge_notification_bus.ts';

export const fuz_forge_app_context = create_context<FuzForgeApp>();

export interface FuzForgeApp {
	/**
	 * Typed throwing Proxy — `await api.foo(input)` returns the unwrapped value
	 * or throws an `Error` carrying the JSON-RPC `{code, data}` shape. Default
	 * for hot-path call sites.
	 */
	api: ThrowingApi<FrontendActionsApi>;
	/**
	 * Typed Result-shaped Proxy — `await api_result.foo(input)` returns
	 * `Result<{value}, {error}>`. Use when call sites inspect
	 * `error.data.reason` without try/catch.
	 */
	api_result: FrontendActionsApi;
	capabilities: Capabilities;
	/** Underlying WebSocket client — exposed for UI status indicators. */
	socket: FrontendWebsocketClient;
	/**
	 * Subscribe to a backend-initiated notification. Handlers fire for every
	 * matching notification dispatched through the peer. Returns an unsubscribe.
	 */
	on_notification: <M extends FuzForgeNotificationMethod>(
		method: M,
		handler: FuzForgeNotificationHandler<M>
	) => () => void;
}

export const create_fuz_forge_app = (): FuzForgeApp => {
	const notification_bus = create_fuz_forge_notification_bus();
	const action_handlers: FrontendActionHandlers = create_fuz_forge_action_handlers(
		notification_bus.dispatch
	);
	const handlers_by_method = action_handlers as Record<
		string,
		Record<string, ((event: any) => any) | undefined> | undefined
	>;

	// the backend's WebSocket sits on the page's origin like `/api/rpc` (nginx in
	// production, the Vite dev proxy in dev). The caller connects inside `onMount`
	// (or after a `BROWSER` gate) — `connect()` throws on non-browser runtimes, so
	// this module stays SSR-safe.
	const socket = new FrontendWebsocketClient(to_same_origin_ws_url('/api/ws'));

	// `action_specs` (from `action_collections.gen.ts`) is the SAME source that
	// drives `FrontendActionsApi` in `action_metatypes.gen.ts`, so the runtime
	// dispatcher and the typed surface cannot drift — an unknown method surfaces
	// as `rpc method not found` from the throwing-api wrapper.
	const { api, api_result } = create_frontend_rpc_client<FrontendActionsApi>({
		specs: action_specs,
		ws: { client: socket },
		lookup_action_handler: (method, phase) => handlers_by_method[method]?.[phase]
	});

	return {
		api,
		api_result,
		capabilities: new Capabilities(),
		socket,
		on_notification: notification_bus.on
	};
};
