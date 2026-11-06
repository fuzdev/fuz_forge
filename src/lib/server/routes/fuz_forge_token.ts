/**
 * Scoped-token RPC handlers.
 *
 * `fuz_forge_token_create_scoped` / `fuz_forge_token_policy_list`. The create
 * maps the wire `template` discriminated union onto a policy doc via the shared
 * `policy_from_template` and writes the `api_token` +
 * `fuz_forge_api_token_policy` rows in one transaction; the list reads the
 * calling account's policy rows back.
 *
 * Both mount at the single JSON-RPC 2.0 endpoint (`/rpc`, composed under
 * `/api` to become `/api/rpc`); the same handler closures are reused by the
 * WebSocket dispatcher. Action spec definitions live in `action_specs.ts`
 * (shared with the frontend typed client) — this module provides the
 * server-side handlers.
 *
 * Unlike the repo factories this one takes no deps: both handlers reach
 * everything they need through `ctx` — the dispatcher transaction's `db` and
 * the authenticated account.
 *
 * Twin of `crates/fuz_forge_server/src/handlers/token.rs`.
 *
 * @module
 */

import { rpc_action, type RpcAction } from '@fuzdev/fuz_app/actions/action_types.ts';
import { jsonrpc_errors } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import { generate_api_token } from '@fuzdev/fuz_app/auth/api_token.ts';
import { query_create_api_token } from '@fuzdev/fuz_app/auth/api_token_queries.ts';
import { token_lifetime_to_expires_at } from '@fuzdev/fuz_app/auth/token_lifetime.ts';
import {
	token_scope_full,
	token_scope_methods,
	type TokenScope
} from '@fuzdev/fuz_app/auth/token_scope.ts';

import {
	query_token_policy_insert,
	query_token_policies_by_account
} from '../db/fuz_forge_api_token_policy_queries.ts';
import { policy_from_template } from '../fuz_forge_token_policy.ts';
import { MAX_POLICY_BYTES } from '../fuz_forge_token_policy_schema.ts';
import {
	fuz_forge_token_create_scoped_action_spec,
	fuz_forge_token_policy_list_action_spec,
	type FuzForgeTokenCreateScopedOutput,
	type FuzForgeTokenPolicyListOutput
} from '../../action_specs.ts';

/**
 * Scoped-token RPC actions.
 *
 * Handler logic is transport-agnostic: receives validated input and a
 * minimum `ctx` with `notify`/`signal` (plus extra fields when invoked via
 * HTTP RPC that the handler can ignore).
 */
export const create_fuz_forge_token_rpc_actions = (): Array<RpcAction> => {
	return [
		rpc_action(
			fuz_forge_token_create_scoped_action_spec,
			async (input, ctx): Promise<FuzForgeTokenCreateScopedOutput> => {
				// Build the policy doc from the template. Pure function over
				// the validated `FuzForgeTokenTemplateInput`.
				const policy = policy_from_template(input.template);

				// Cap policy size at the column-level limit. Templates produce
				// tiny documents in practice; this is a defensive guard against
				// a future template variant or qualifier expansion blowing the
				// jsonb column up.
				if (policy !== null) {
					const serialized_bytes = new TextEncoder().encode(JSON.stringify(policy)).length;
					if (serialized_bytes > MAX_POLICY_BYTES) {
						throw jsonrpc_errors.validation_error(
							`policy too large: ${serialized_bytes} bytes exceeds ${MAX_POLICY_BYTES}`
						);
					}
				}

				// The spine-level scope for this token, derived from the same
				// template. Two layers govern a forge token and they are not
				// redundant: `api_token.scope` covers RPC methods and the non-RPC
				// *spine* surfaces (db-admin, bare-fact, audit stream, WS), while
				// the `fuz_forge_api_token_policy` row below covers forge's own
				// resource-bound REST surfaces (`files.read:<filename>`,
				// `forge.push:<repo_id>`) which the spine has no vocabulary for.
				//
				// The mapping is mechanical, and the file/forge templates land on an
				// *empty* method set on purpose: those tokens grant no RPC, and this
				// empty set is the *only* thing that denies it. The policy row does
				// not — its `rpc` grant is a mint-time record with no checker, so a
				// file token whose scope came back `full` would call every method on
				// the server with nothing else in the way. It also keeps them out of
				// the db-admin browser, which an unscoped `api_token` row would not.
				// Mirrors the Rust twin in `crates/fuz_forge_server/src/handlers/token.rs`.
				const token_scope: TokenScope =
					input.template.kind === 'admin'
						? token_scope_full()
						: input.template.kind === 'rpc_subset'
							? token_scope_methods(input.template.methods)
							: token_scope_methods([]);

				// Same transaction for both writes (`side_effects: true` wraps the
				// handler in db.transaction). Token creation MUST roll back if
				// the policy insert fails — otherwise an "admin token" leaks.
				const { token, id: token_id, token_hash } = generate_api_token();
				const tx_deps: QueryDeps = { db: ctx.db };
				// `lifetime` is required — an omitted lifetime is a 400 upstream,
				// never an eternal token. Mirrors the spine's `account_token_create`.
				const expires_at = token_lifetime_to_expires_at(input.lifetime);
				await query_create_api_token(
					tx_deps,
					token_id,
					ctx.auth.account.id,
					input.name,
					token_hash,
					token_scope,
					expires_at
				);

				if (policy !== null) {
					await query_token_policy_insert(tx_deps, {
						api_token_id: token_id,
						policy,
						template: input.template.kind
					});
				}

				return {
					ok: true,
					token,
					id: token_id,
					name: input.name,
					template: input.template.kind
				};
			}
		),
		rpc_action(
			fuz_forge_token_policy_list_action_spec,
			async (_input, ctx): Promise<FuzForgeTokenPolicyListOutput> => {
				const rows = await query_token_policies_by_account({ db: ctx.db }, ctx.auth.account.id);
				return { policies: rows };
			}
		)
	];
};
