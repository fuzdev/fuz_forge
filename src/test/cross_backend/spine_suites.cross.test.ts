/**
 * Every shipped `@fuzdev/fuz_app` cross suite the forge's capabilities admit,
 * in one `describe_spine_cross_suites` call, against both forge backends
 * (Deno/Hono + Rust `fuz_forge_server`). A suite added upstream runs here
 * without a file of its own; one the forge can't run is excluded below with
 * its reason, and each forge difference from the spine defaults is an
 * override.
 *
 * **Surface source — inline TS, not the on-disk snapshot.** Built via the
 * same `create_fuz_forge_app_surface_spec` builder the in-process attack-
 * surface tests use; the cross-process-ness lives in the transport and the
 * per-test fixture, not the schema source.
 *
 * @module
 */

import { ROLE_ADMIN, ROLE_KEEPER } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import {
	describe_spine_cross_suites,
	type SpineCrossSuitesOptions,
	type SuiteOverrides
} from '@fuzdev/fuz_app/testing/cross_backend/spine_suites.ts';

import { fuz_forge_session_config } from '#lib/server/routes/account.ts';
import { fuz_forge_roles } from '#lib/server/fuz_forge_roles.ts';
import { create_fuz_forge_app_surface_spec } from '../server/routes/auth_attack_surface_helpers.ts';
import { fuz_forge_param_values } from '../server/routes/fuz_forge_test_helpers.ts';
import { fuz_forge_rpc_endpoints } from './fuz_forge_rpc_mount.ts';

const handle = inject_backend_handle();

// Forge smart-HTTP + internal callback routes stream git protocol bytes /
// raw payloads (not JSON-with-an-output-schema), so the generic round-trip
// validator can't drive them — skip by `'METHOD /path'` key.
const GIT_SLUG = '/:slug_with_git{.+\\.git}';
const round_trip_skip_routes = [
	`GET ${GIT_SLUG}/info/refs`,
	`POST ${GIT_SLUG}/git-upload-pack`,
	`POST ${GIT_SLUG}/git-receive-pack`,
	'GET /internal/repo-config/:id',
	'POST /internal/repo-receive-callback',
	// File store upload/delete: `actor: 'required'` + raw-bytes (`input:
	// z.null()`) admin routes — no acting-actor input path for the generic
	// validator to supply, so authorization yields `actor_required` rather
	// than a declared response. Driven by fuz_forge's own file route tests.
	'POST /api/fuz_forge/files/:filename{.+}',
	'DELETE /api/fuz_forge/files/:filename{.+}'
];

const exclude: SpineCrossSuitesOptions['exclude'] = {
	actor_lookup: 'the forge mounts no actor_lookup resolver'
};

const overrides: SuiteOverrides = {
	standard: { round_trip_skip_routes, param_values: fuz_forge_param_values }
};

describe_spine_cross_suites(handle, {
	surface_source: create_fuz_forge_app_surface_spec(),
	session_options: fuz_forge_session_config,
	rpc_endpoints: fuz_forge_rpc_endpoints,
	roles: fuz_forge_roles,
	// the forge's `/api/ws` upgrade is admin-gated (`ws_role_gate`: roleless →
	// 403): the suites' socket accounts hold admin, and revoking it closes the
	// socket rather than delivering the frame
	ws_required_roles: [ROLE_ADMIN],
	// the forge's registry holds only the builtins: keeper for the role-shaped
	// cell grants (keeper reach is not admin reach), admin for the conferral
	suite_roles: { cell_grant: ROLE_KEEPER, conferral: ROLE_ADMIN },
	exclude,
	overrides
});
