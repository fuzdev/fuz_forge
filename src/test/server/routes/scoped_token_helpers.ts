/**
 * Shared helpers for scoped-token integration tests.
 *
 * Four test files import from here: `repo_git.scoped_token.db.test.ts` (git
 * smart-HTTP), `files.scoped_token.db.test.ts` (file store),
 * `scoped_token_deny_all_coverage.db.test.ts` (the deny-all coverage
 * assertion), and `fuz_forge_token_policy_list_rpc.db.test.ts` (the
 * policy-list read). Between them they need three kinds of operation,
 * exported in six forms:
 *
 * - Look up the `api_token.id` for a freshly-bootstrapped account
 *   (`TestAccount` exposes the raw token string but not the row id —
 *   we look it up by `account_id`, taking the most-recent token).
 * - Insert a `fuz_forge_api_token_policy` row for that token id: a given
 *   policy, the deny-all `{version: 1}` shape, or a raw document that would
 *   not survive the schema.
 * - Write the spine's `api_token.scope`: narrowed to a method list, or a
 *   whole `TokenScope` document set outright.
 *
 * Centralizing them removes ~50 lines of duplicated boilerplate and
 * keeps the policy shape (column names, JSON serialization) in one
 * place — schema changes touch one file.
 *
 * A token has **two** per-token authority axes and they are reached by
 * different helpers on purpose: `attach_policy` writes the forge's
 * resource-bound row, `narrow_token_scope` writes the spine's
 * `api_token.scope`. Which axis governs a forge surface depends on which of
 * them a token carries — see `server/fuz_forge_token_surfaces.ts` — so a test
 * that wants to isolate one must not write the other.
 *
 * @module
 */

import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import {
	serialize_token_scope,
	token_scope_methods,
	type TokenScope
} from '@fuzdev/fuz_app/auth/token_scope.ts';

import {
	DENY_ALL_POLICY,
	type FuzForgeTokenPolicy
} from '#lib/server/fuz_forge_token_policy_schema.ts';

/**
 * Return the `api_token.id` of the most-recently created token for
 * `account_id`. Test bootstrap creates one token per `create_account`
 * call, so "most recent" is the one the test cares about.
 *
 * Throws when no token exists — callers should have bootstrapped an
 * account before calling, so absence is a programmer error.
 */
export const get_api_token_id_for_account = async (db: Db, account_id: string): Promise<string> => {
	const row = await db.query_one<{ id: string }>(
		`SELECT id FROM api_token WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`,
		[account_id]
	);
	if (!row) throw new Error(`no api_token for account ${account_id}`);
	return row.id;
};

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

/**
 * Rewrite `api_token.scope` to a narrowed `methods` document.
 *
 * The **other** per-token axis, and the one a test must reach for deliberately:
 * `attach_policy` above writes what `fuz_forge_token_create_scoped` writes,
 * while this writes what the spine's `account_token_create` writes. A token
 * narrowed this way has *no* policy row, so `policy_check` allows everything —
 * only `token_scope_admits_forge_surface` refuses it. Combining the two would
 * make a denial ambiguous about which axis produced it.
 *
 * @param db - the test database
 * @param api_token_id - the token row to narrow
 * @param methods - the RPC methods the token may call; everything else denied
 */
export const narrow_token_scope = async (
	db: Db,
	api_token_id: string,
	methods: ReadonlyArray<string>
): Promise<void> => set_token_scope(db, api_token_id, token_scope_methods([...methods]));

/**
 * Write a `TokenScope` document onto an existing `api_token` row.
 *
 * The general form behind `narrow_token_scope`, exported for the
 * positive controls — a `full` scope written through the same path proves a
 * denial came from the scope's *content* rather than from having been rewritten.
 */
export const set_token_scope = async (
	db: Db,
	api_token_id: string,
	scope: TokenScope
): Promise<void> => {
	await db.query(`UPDATE api_token SET scope = $2::jsonb WHERE id = $1`, [
		api_token_id,
		serialize_token_scope(scope)
	]);
};
