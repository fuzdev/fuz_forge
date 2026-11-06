/**
 * fuz_forge db route specs — delegates to fuz_app's generic db routes.
 *
 * fuz_app's `create_db_route_specs` ships a restrictive default gate
 * (`roles: ['keeper'], credential_types: ['daemon_token']`). fuz_forge's admin
 * dashboard drives this surface over the operator's session cookie, so each
 * returned spec's `auth` is rewritten to admin + session-only before
 * registration. The handlers, schemas, and SQL identifier checks stay
 * untouched.
 *
 * **Session-only is the load-bearing channel gate.** The dashboard is the
 * sole consumer of `/api/db`, and the browsable set still includes tables
 * with server-only row data (per-repo `hook_secret_hash`es in `cell.data`), so no
 * bearer `api_token` — narrowed or Full — reaches the browser at all. The
 * `surface:db_admin` scope gate (`required_scope`) stays declared behind it
 * as the dormant second fence: if the channel gate is ever re-widened,
 * token scoping's RPC-only rule 3 again refuses narrowed tokens. The Rust
 * twin declares the same `CredentialGate::SESSION_ONLY` + scope gate in
 * `fuz_db_admin`'s `route_auth`.
 *
 * @module
 */

import type { DbType } from '@fuzdev/fuz_app/db/db.ts';
import type { RouteSpec } from '@fuzdev/fuz_app/http/route_spec.ts';
import {
	create_db_route_specs as create_db_route_specs_base,
	type DbRouteDeps
} from '@fuzdev/fuz_app/http/db_routes.ts';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';

import { SURFACE_DB_ADMIN } from '../fuz_forge_token_surfaces.ts';

/**
 * The tables the db-admin browser exposes — the TS twin of the Rust
 * `FUZ_FORGE_BROWSABLE_TABLES` in `crates/fuz_forge_server/src/router.rs`;
 * the two declarations must stay identical (pinned by the cross-backend
 * db-admin parity suite).
 *
 * Everything in the forge DB except the credential tables (`account`,
 * `auth_session`, `api_token`, `bootstrap_lock`), which fuz_app's
 * `NON_BROWSABLE_TABLES` floor refuses regardless. An explicit enumeration,
 * so a future secret-bearing migration stays unlisted until someone names it
 * here. Note the listed set is not free of server-only state: `cell` rows
 * carry each repo's `hook_secret_hash` in `cell.data`, which is part of why
 * the mount is session-only.
 */
export const FUZ_FORGE_BROWSABLE_TABLES: ReadonlyArray<string> = [
	// auth domain (non-credential)
	'actor',
	'role_grant',
	'role_grant_offer',
	'invite',
	'audit_log',
	'app_settings',
	'schema_version',
	// cell substrate
	'cell',
	'cell_grant',
	'cell_field',
	'cell_item',
	// fact substrate
	'fact',
	'fact_ref',
	'memo',
	// forge domain
	'fuz_forge_api_token_policy'
];

/**
 * Configuration for db routes.
 */
export interface DbRoutesOptions {
	db_type: DbType;
	db_name: string;
}

/**
 * Create the db API route specs.
 *
 * @param deps - the audit slice (`ctx.deps` satisfies it) for the row-`DELETE` trail
 * @param config - route configuration (db_type, db_name)
 * @returns route specs for database administration
 */
export const create_db_route_specs = (
	deps: DbRouteDeps,
	config: DbRoutesOptions
): Array<RouteSpec> => {
	const specs = create_db_route_specs_base(deps, {
		...config,
		browsable_tables: FUZ_FORGE_BROWSABLE_TABLES
	});
	return specs.map((spec) => ({
		...spec,
		auth: {
			account: 'required',
			actor: 'required',
			roles: [ROLE_ADMIN],
			credential_types: ['session'],
			required_scope: SURFACE_DB_ADMIN
		}
	}));
};
