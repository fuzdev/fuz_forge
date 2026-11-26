/**
 * Shared helpers for scoped-token integration tests: inserting a
 * `fuz_forge_api_token_policy` row for a token id (a given policy, the
 * deny-all `{version: 1}` shape, or a raw document that would not survive the
 * schema), keeping the policy row's shape (column names, JSON serialization)
 * in one place.
 *
 * A token has **two** per-token authority axes and they are reached
 * differently on purpose: `attach_policy` writes the forge's resource-bound
 * row, and fuz_app's `create_account({api_token_scope})` mints the spine's
 * `api_token.scope`. The token id comes from the account (`api_token_id`).
 * Which axis governs a forge surface depends on which of them a token carries
 * — see `server/fuz_forge_token_surfaces.ts` — so a test that wants to
 * isolate one must not write the other.
 *
 * @module
 */

import type { Db } from '@fuzdev/fuz_app/db/db.ts';

import {
	DENY_ALL_POLICY,
	type FuzForgeTokenPolicy
} from '#lib/server/fuz_forge_token_policy_schema.ts';

/**
 * Insert a `fuz_forge_api_token_policy` row for `api_token_id` with the
 * given policy + template label.
 *
 * `template` defaults to `'test'` for tests where the template name
 * doesn't matter — the policy-list handler test (which asserts on
 * `template`) passes an explicit name.
 */
export const attach_policy = async (
	db: Db,
	api_token_id: string,
	policy: FuzForgeTokenPolicy,
	template = 'test'
): Promise<void> => {
	await db.query(
		`INSERT INTO fuz_forge_api_token_policy (api_token_id, policy, policy_version, template)
		 VALUES ($1, $2::jsonb, $3, $4)`,
		[api_token_id, JSON.stringify(policy), policy.version, template]
	);
};

/**
 * Convenience: attach a deny-all policy (`{version: 1}` with no
 * `forge`/`files`/`rpc` keys). Allow-only `policy_check` denies every
 * surface; the synthetic deny-all is the standard scoped-token probe.
 */
export const attach_deny_all_policy = async (db: Db, api_token_id: string): Promise<void> =>
	attach_policy(db, api_token_id, DENY_ALL_POLICY, 'deny_all');

/**
 * Insert a policy row whose document is **not** validated against
 * `FuzForgeTokenPolicy` — the shape a hand-edited row or a future grammar
 * would leave behind.
 *
 * The mint refuses to write one, so this is the only way to reach
 * `policy_from_stored`'s failure branch from a route test; `attach_policy`
 * takes a typed document on purpose and can't express it.
 *
 * @param policy - the raw document, serialized as-is into the `jsonb` column
 * @param policy_version - the `policy_version` column, which the row's own
 *   `version` need not agree with
 */
export const attach_raw_policy = async (
	db: Db,
	api_token_id: string,
	policy: unknown,
	policy_version: number,
	template: string
): Promise<void> => {
	await db.query(
		`INSERT INTO fuz_forge_api_token_policy (api_token_id, policy, policy_version, template)
		 VALUES ($1, $2::jsonb, $3, $4)`,
		[api_token_id, JSON.stringify(policy), policy_version, template]
	);
};
