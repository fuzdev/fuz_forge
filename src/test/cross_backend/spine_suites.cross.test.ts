/**
 * Every shipped `@fuzdev/fuz_app` cross suite the forge's capabilities admit,
 * in one `describe_spine_cross_suites` call, against both forge backends
 * (TS/Hono + Rust `fuz_forge_server`). A suite added upstream runs here
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

import { FUZ_FORGE_SESSION_COOKIE_NAME } from '#lib/server/routes/account.ts';
import { fuz_forge_roles } from '#lib/server/fuz_forge_roles.ts';
import { create_fuz_forge_app_surface_spec } from '../server/routes/auth_attack_surface_helpers.ts';
import { fuz_forge_param_values } from '../server/routes/fuz_forge_test_helpers.ts';
import { fuz_forge_rpc_endpoints } from './fuz_forge_rpc_mount.ts';

const handle = inject_backend_handle();

// The git advertisement and the internal callbacks answer git protocol bytes /
// raw payloads (not JSON-with-an-output-schema), so the generic round-trip
// validator can't drive them — skip by `'METHOD /path'` key. The `raw_body`
// routes (the pack POSTs, the file upload) the validator skips itself.
const GIT_SLUG = '/:slug_with_git{.+\\.git}';
const round_trip_skip_routes = [
	`GET ${GIT_SLUG}/info/refs`,
	'GET /internal/repo-config/:id',
	'POST /internal/repo-receive-callback',
	// The file delete: an `actor: 'required'` admin route with no acting-actor
	// input path for the generic validator to supply, so authorization answers
	// `actor_required` rather than a declared response. Driven by fuz_forge's
	// own file route tests.
	'DELETE /api/fuz_forge/files/:filename{.+}'
];

const exclude: SpineCrossSuitesOptions['exclude'] = {
	actor_lookup: 'the forge mounts no actor_lookup resolver'
};

const overrides: SuiteOverrides = {
	standard: { round_trip_skip_routes, param_values: fuz_forge_param_values }
};

// the gated skips both backends owe, each by what the forge lacks — a skip
// nobody listed here fails the run (`check_declared_skips`)
const NO_GATED_CREATE =
	"the forge's create authorizer reserves its own kinds, not the suite's gated-create test policy (cell_gated_create)";
const NO_ROOMS = 'the forge mounts no room verbs (rooms)';
const NO_ROLE_GATED_WS =
	'the forge mounts no second, role-gated WS endpoint beside its admin-gated /api/ws (ws_role_gated)';
const CONFERRAL_IS_ADMIN =
	"the forge's registry holds only the builtins, so the conferral role is admin: global-only (no scoped case) and the audit stream's own gate (no other role to revoke)";

/** `paths`, each declared skipped for `reason`. */
const declare_skips = (reason: string, paths: Array<string>): Record<string, string> =>
	Object.fromEntries(paths.map((path) => [path, reason]));

describe_spine_cross_suites(handle, {
	surface_source: create_fuz_forge_app_surface_spec(),
	session_cookie_name: FUZ_FORGE_SESSION_COOKIE_NAME,
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
	overrides,
	expected_skips: {
		...declare_skips(NO_GATED_CREATE, [
			'cell_gated_create authorizer parity (directory model) > a non-admin is denied a `space` root (admin-only), admin succeeds',
			'cell_gated_create authorizer parity (directory model) > a contribution under a public space: unauthorized → 403, participant → allowed',
			'cell_gated_create authorizer parity (directory model) > moderation is set per `moderation_required` (post → pending+private, react → approved)',
			'cell_gated_create authorizer parity (directory model) > a contribution under a hidden (private) space is 404-masked (not 403)',
			'cell_gated_create authorizer parity (directory model) > a deep contribution (comment under a post) resolves policy from the governing root, not the parent',
			'cell_gated_create authorizer parity (directory model) > a contribution under a soft-deleted root is 404 cell_not_found (the missing-parent shape)',
			'cell_gated_create authorizer parity (directory model) > cell root policy parity > a root takes a policy at create and through cell_policy_set, audited old and new',
			'cell_gated_create authorizer parity (directory model) > cell root policy parity > a policy is root-only and must pass the authorizer',
			"cell_gated_create authorizer parity (directory model) > cell root policy parity > an editor-grant holder can't change a root's policy, through the verb or through data",
			"cell_grant_steward revoke parity > the scope's steward revokes, audited steward: true",
			"cell_grant_steward revoke parity > another scope's steward gets the 404 mask",
			'cell_grant_steward revoke parity > a scopeless role grant never reaches the hook',
			'cell_moderate verb parity (root-authority-gated) > a root manager (admin) approves a pending post → approved + public',
			'cell_moderate verb parity (root-authority-gated) > the author (non-manager) cannot moderate their own pending post → 403',
			'cell_moderate verb parity (root-authority-gated) > a non-viewer is 404-masked from moderating a pending post',
			'cell_moderate verb parity (root-authority-gated) > a root manager rejects a pending post → rejected, stays private',
			'cell_moderate verb parity (root-authority-gated) > moderating a cell with no governing root → 400 cell_not_a_contribution, after the view check',
			'cell_moderate verb parity (root-authority-gated) > a root owner shown a private approved contribution cannot publish it → 400 cell_not_pending',
			'cell_moderate verb parity (root-authority-gated) > approval needs a pending post, rejection a pending or approved one → else 400 cell_not_pending',
			'moderation gates reads (parity) > a pending post its author flips public stays hidden past the author and admins',
			'moderation gates reads (parity) > pending → rejected → public stays hidden past the author',
			'moderation gates reads (parity) > approved → rejected stays hidden, and a grant made while approved stops admitting',
			'moderation gates reads (parity) > approval leaves visibility to rejection: an approved-then-rejected post is still public, and hidden',
			'moderation gates reads (parity) > an editor grant made while approved admits no write once rejected; the author keeps the owner arm',
			'moderation gates reads (parity) > a pending post in a public collection is omitted from anon cell_item_list',
			'moderation gates reads (parity) > every relation list hides a pending end, and a rejected one from its grant holder',
			"moderation gates reads (parity) > a pending post's fact is 404 to anon, even flipped public; live once approved",
			'the steward arm: a root owner moderates (parity) > a non-admin root owner reads the pending queue and the post, and moderates it',
			'the steward arm: a root owner moderates (parity) > the steward arm stops at the moderator surfaces: clone and create-under are 404',
			'the steward arm: a root owner moderates (parity) > the steward arm keys on the governing root, not the parent: a rejected comment under an approved post',
			"the steward arm: a root owner moderates (parity) > the root owner fetches a pending post's fact; anon 404",
			'cell_grant_create refuses an unapproved contribution (parity) > a grant on a pending post → 403 cell_grant_unapproved; non-manager 404; lands after approval',
			'cell_clone runs the creation authorizer (parity) > a non-admin clone of a viewable `space` root → 403, admin clone succeeds'
		]),
		...declare_skips(CONFERRAL_IS_ADMIN, [
			'role_grant_offer WS notifications (cross-process) > a scoped revoke delivers its scope_kind and scope_id to the revokee WS',
			'role-gated participation conferral (success paths) > admin assigns a scoped admin grant that round-trips scope_kind',
			'cross-process sse > a revoke of a global grant of another role leaves the stream open'
		]),
		...declare_skips(NO_ROOMS, [
			'rooms over the socket (cross-process) > members join, relay, set state, and leave, in seq order',
			'rooms over the socket (cross-process) > a watch sees the members without a seat',
			'rooms over the socket (cross-process) > refusals answer their codes and reasons',
			'rooms over the socket (cross-process) > a room past its cap is full, and the admin rule reads the grant',
			'rooms over the socket (cross-process) > a connection watches at most its maximum of rooms',
			'rooms over the socket (cross-process) > over HTTP the room verbs answer method_not_found',
			'rooms over the socket (cross-process) > one seat per actor: the newest admitted join moves the other',
			"rooms over the socket (cross-process) > a closed socket's seats leave as disconnected",
			'rooms over the socket (cross-process) > an eviction ends seats and watches alike',
			'rooms over the socket (cross-process) > the room limiter charges escaped bytes per connection; a watch and a leave still answer past it'
		]),
		...declare_skips(NO_ROLE_GATED_WS, [
			'role-gated websocket (cross-process) > revoking a global grant of a gating role closes the gated socket with WS_CLOSE_PERMISSION_REVOKED',
			'role-gated websocket (cross-process) > a scoped revoke of a gating role closes nothing'
		])
	}
});
