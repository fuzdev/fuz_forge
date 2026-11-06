/**
 * The shared conformance table over the forge's whole live RPC mount, against
 * each forge backend — the generated per-method auth rows
 * (`generate_rpc_auth_conformance_cases`), fired at the spawned binary's real
 * gates.
 *
 * Every method's declared `RouteAuth` becomes rows: anonymous → 401 on each
 * account- or actor-bound method (one equivalence group, so the refusal can't
 * tell methods apart), each credential channel a gate refuses → 403
 * `credential_type_required`, and a roleless account → 403
 * `insufficient_permissions` on each role-gated method that admits a session.
 * The rows cover the forge's own methods, the spine's, and the `_testing_*`
 * seams both binaries mount (`fuz_forge_live_rpc_endpoints`), so a gate a
 * backend hand-implements differently from its declared spec fails here on
 * that backend. fuz_app's hand-written rows are its own spine's, so none run
 * here.
 *
 * Four legs: HTTP; the same rows over `/api/ws`, each frame meeting the
 * per-message gates on an admitted socket; and both again on a keeper holding
 * a second actor, where every credential row binds `acting` to its
 * principal's actor. **The WS legs drop the `fresh_non_admin` rows**: the
 * forge's `/api/ws` upgrade is admin-gated (`ws_role_gate.cross.test.ts`), so
 * a roleless account never holds a socket to send them on. The upgrade
 * refusal it hits instead is pinned there, and the rows themselves run on the
 * HTTP legs.
 *
 * The TS↔Rust comparison of the same rows — every body, not just the status
 * and error the table asserts — is `differential.cross.test.ts`.
 *
 * @module
 */

import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { describe_conformance_table_tests } from '@fuzdev/fuz_app/testing/cross_backend/conformance_table.ts';
import { generate_rpc_auth_conformance_cases } from '@fuzdev/fuz_app/testing/cross_backend/conformance_rpc_auth.ts';
import { resolve_rpc_endpoints_for_setup } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';

import { fuz_forge_session_config } from '#lib/server/routes/account.ts';
import { create_fuz_forge_app_surface_spec } from '../server/routes/auth_attack_surface_helpers.ts';
import { fuz_forge_live_rpc_endpoints, fuz_forge_rpc_endpoints } from './fuz_forge_rpc_mount.ts';

/** The keeper's second actor on the multi-actor leg. */
const SECOND_ACTOR_NAME = 'conformance_second_actor';

const handle = inject_backend_handle();
const { capabilities, base_url, ws_path } = handle.config;

const surface_source = create_fuz_forge_app_surface_spec();
const cases = generate_rpc_auth_conformance_cases({
	surface_source,
	live_rpc_endpoints: resolve_rpc_endpoints_for_setup(
		fuz_forge_live_rpc_endpoints,
		fuz_forge_session_config
	)
});
const table_options = {
	surface_source,
	capabilities,
	rpc_endpoints: fuz_forge_rpc_endpoints,
	live_rpc_endpoints: fuz_forge_live_rpc_endpoints,
	session_options: fuz_forge_session_config
};
// the reset's keeper already holds admin, which the WS upgrade needs
const setup_test = default_cross_process_setup(handle);
const multi_actor_setup_test = default_cross_process_setup(handle, {
	extra_actors: [SECOND_ACTOR_NAME]
});
// `/api/ws` mounts the same actions as `/api/rpc` on both backends
// (`ws_account_actions`); a roleless account can't open it (module doc)
const ws = capabilities.ws && capabilities.ws_account_actions ? { base_url, ws_path } : undefined;
const ws_cases = cases.filter((c) => c.request.as !== 'fresh_non_admin');

describe_conformance_table_tests({
	...table_options,
	cases,
	setup_test,
	suite_name: 'conformance table (cross-process)'
});

if (ws) {
	describe_conformance_table_tests({
		...table_options,
		cases: ws_cases,
		setup_test,
		ws,
		suite_name: 'conformance table (cross-process, WS)'
	});
}

describe_conformance_table_tests({
	...table_options,
	cases,
	setup_test: multi_actor_setup_test,
	suite_name: 'conformance table (cross-process, multi-actor keeper)'
});

if (ws) {
	describe_conformance_table_tests({
		...table_options,
		cases: ws_cases,
		setup_test: multi_actor_setup_test,
		ws,
		suite_name: 'conformance table (cross-process, WS, multi-actor keeper)'
	});
}
