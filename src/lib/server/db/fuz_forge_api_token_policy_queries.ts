/**
 * Database queries for the fuz_forge-local API token policy table.
 *
 * Three operations:
 *
 * - `query_token_policy_by_id` — hot path; called on every
 *   request that hydrates `FUZ_FORGE_TOKEN_POLICY_KEY` from a bearer token.
 *   Returns `null` when the token is unscoped (no row).
 * - `query_token_policy_insert` — invoked by
 *   `fuz_forge_token_create_scoped` after the underlying `api_token` row
 *   has been created in the same transaction.
 * - `query_token_policies_by_account` — the admin/UI listing; deliberately
 *   narrows the row to the two columns the join needs.
 *
 * There is no delete query: a policy row's lifetime is the token's, and
 * `ON DELETE CASCADE` on the FK removes it when the token is revoked.
 *
 * @module
 */

import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import {
	columns_sql,
	iso8601_timestamp_expr,
	omit_columns,
	qualify_columns
} from '@fuzdev/fuz_app/db/sql_columns.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { policy_from_stored } from '../fuz_forge_token_policy.ts';
import type { FuzForgeTokenPolicy } from '../fuz_forge_token_policy_schema.ts';

/** Row stored in the `fuz_forge_api_token_policy` table. */
export interface FuzForgeApiTokenPolicyRow {
	api_token_id: string;
	policy: FuzForgeTokenPolicy;
	policy_version: number;
	template: string;
	created_at: string;
}

/**
 * The `fuz_forge_api_token_policy` table's columns — every read projects
 * through this (fuz_app's named-projection idiom, see its
 * `db/sql_columns.ts`), narrowing reads via `omit_columns` rather than
 * spelling a second list, so a dropped column fails loud at the read and the
 * `.db.test.ts` guard (`assert_columns_match_live`) catches one added to the
 * DDL but not here. Twin of `fuz_forge_server`'s
 * `FUZ_FORGE_API_TOKEN_POLICY_COLUMNS`.
 */
export const FUZ_FORGE_API_TOKEN_POLICY_COLUMNS = [
	'api_token_id',
	'policy',
	'policy_version',
	'template',
	'created_at'
] as const satisfies ReadonlyArray<keyof FuzForgeApiTokenPolicyRow>;

/**
 * The table's timestamp override — `created_at` is a `timestamptz`, so the bare
 * column arrives as a `Date` while `FuzForgeApiTokenPolicyRow` types it as a
 * `string`. Projecting it through the spine's canonical second-precision UTC
 * ISO-8601 `to_char(...)` makes the row match its type and makes the bytes
 * identical to the Rust twin's, which reads the same shape through
 * `fuz_db::iso8601_timestamp_column`.
 *
 * Takes the row qualifier — the empty string for the bare-table read below.
 */
const token_policy_expr = iso8601_timestamp_expr(FUZ_FORGE_API_TOKEN_POLICY_COLUMNS, [
	'created_at'
]);

/**
 * Look up the policy for a token by `api_token.id`.
 *
 * Returns `null` when the token is unscoped (no row). The `policy` column is
 * `jsonb` so the driver returns it pre-parsed, but pre-parsed is not
 * validated, so the document goes through `policy_from_stored` here — the one
 * read path both forge gates share, matching where the Rust twin
 * (`FuzForgeTokenRouteState::lookup`) validates.
 *
 * A document that fails the schema resolves to the deny-all policy, not to
 * `null`: the row exists, so the token *is* scoped, and returning `null` would
 * widen it to unscoped. The column should be otherwise readonly (rows are
 * written by `query_token_policy_insert` from a validated template), so this is
 * defense-in-depth against a hand-edited row or a grammar bump — the version
 * literal is what makes a future v2 document fail here rather than being
 * enforced under v1 rules.
 */
export const query_token_policy_by_id = async (
	deps: QueryDeps & { log: Pick<Logger, 'error'> },
	api_token_id: string
): Promise<FuzForgeApiTokenPolicyRow | null> => {
	const row = await deps.db.query_one<FuzForgeApiTokenPolicyRow>(
		`SELECT ${columns_sql(FUZ_FORGE_API_TOKEN_POLICY_COLUMNS, token_policy_expr(''))}
		 FROM fuz_forge_api_token_policy
		 WHERE api_token_id = $1`,
		[api_token_id]
	);
	if (!row) return null;
	return { ...row, policy: policy_from_stored(row.policy, api_token_id, deps.log) };
};

/**
 * Insert a policy row for an existing token.
 *
 * Caller is responsible for ensuring the `api_token_id` exists — the
 * FK enforces it, but failing here means the surrounding transaction
 * must roll back.
 */
export const query_token_policy_insert = async (
	deps: QueryDeps,
	input: {
		api_token_id: string;
		policy: FuzForgeTokenPolicy;
		template: string;
	}
): Promise<void> => {
	await deps.db.query(
		`INSERT INTO fuz_forge_api_token_policy (api_token_id, policy, policy_version, template)
		 VALUES ($1, $2::jsonb, $3, $4)`,
		[input.api_token_id, JSON.stringify(input.policy), input.policy.version, input.template]
	);
};

/**
 * The listing projection — the identity plus the template name, which is all
 * the UI join needs. `policy` is a `jsonb` document per row and
 * `policy_version` / `created_at` are carried inside it or by the joined
 * token, so pulling them for every token of an account would be dead weight.
 * Derived from the table const rather than spelled a second time, so the
 * drift guard covers this read too.
 */
const TOKEN_POLICY_LIST_COLUMNS = omit_columns(
	FUZ_FORGE_API_TOKEN_POLICY_COLUMNS,
	'policy',
	'policy_version',
	'created_at'
);

/**
 * List policy rows for every `api_token` owned by the given account.
 *
 * Returns one narrowed row per scoped token; unscoped tokens are absent. The
 * `JOIN` confines the result to tokens that still exist — revoking a
 * token deletes the row, and `ON DELETE CASCADE` removes any policy
 * row with it. Sorted by `api_token.created_at` so the UI's join
 * against `account_token_list` is stable.
 */
export const query_token_policies_by_account = async (
	deps: QueryDeps,
	account_id: string
): Promise<Array<{ api_token_id: string; template: string }>> => {
	return await deps.db.query<{ api_token_id: string; template: string }>(
		`SELECT ${qualify_columns(TOKEN_POLICY_LIST_COLUMNS, 'p')}
		 FROM fuz_forge_api_token_policy p
		 JOIN api_token t ON t.id = p.api_token_id
		 WHERE t.account_id = $1
		 ORDER BY t.created_at`,
		[account_id]
	);
};
