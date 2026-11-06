/**
 * Static frontend handlers per `(method, phase)`. The `receive` entries
 * for backend-initiated notifications delegate to the notification bus
 * passed in by `create_fuz_forge_app`, fanning each event out to current
 * subscribers. Pure `request_response` actions have no entries — call
 * sites use the typed `app.api.*` Proxy directly.
 *
 * @module
 */

import type { FrontendActionHandlers } from '../frontend_action_types.ts';
import type { FuzForgeNotificationDispatch } from './fuz_forge_notification_bus.ts';

export const create_fuz_forge_action_handlers = (
	dispatch: FuzForgeNotificationDispatch
): FrontendActionHandlers => ({
	fuz_forge_repo_updated: {
		receive: ({ data: { input } }) => dispatch('fuz_forge_repo_updated', input)
	}
});
