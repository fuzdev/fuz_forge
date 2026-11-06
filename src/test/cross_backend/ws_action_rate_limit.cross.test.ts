/**
 * Action rate limiting over a real WebSocket, and its budget shared with HTTP
 * RPC — fuz_app's `describe_ws_action_rate_limit_cross_tests`, against each
 * forge backend.
 *
 * Runs on the limiter-enabled `cross_backend_login_security_*` spawn pair,
 * whose action limiters are on and capped at
 * `LOGIN_SECURITY_ACTION_RATE_LIMIT_MAX_ATTEMPTS` (the test binaries alone
 * read that cap; production keeps the spine defaults). It proves an action's
 * throttle reaches `/api/ws`, keys the per-IP axis on the forwarded client IP,
 * and spends one budget per axis across both transports — at each backend's
 * dispatcher, which charges every classed spec, the spine's auth families
 * included.
 *
 * Every case runs on the fresh keeper `_testing_reset` seeds, which holds
 * admin, so it can open the forge's admin-gated socket.
 *
 * @module
 */

import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { describe_ws_action_rate_limit_cross_tests } from '@fuzdev/fuz_app/testing/cross_backend/ws_action_rate_limit.ts';

import { LOGIN_SECURITY_ACTION_RATE_LIMIT_MAX_ATTEMPTS } from './fuz_forge_backend_config.ts';

const handle = inject_backend_handle();

describe_ws_action_rate_limit_cross_tests({
	setup_test: default_cross_process_setup(handle),
	base_url: handle.config.base_url,
	ws_path: handle.config.ws_path,
	rpc_path: handle.config.rpc_path,
	max_attempts: LOGIN_SECURITY_ACTION_RATE_LIMIT_MAX_ATTEMPTS
});
