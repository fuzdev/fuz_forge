/**
 * Database schema for the fuz_forge-local API token policy table.
 *
 * Tokens with a row here are **scoped** — their permitted actions are
 * narrowed to whatever the JSONB `policy` document allows. Tokens
 * absent from this table are unscoped (today's max-admin behavior).
 *
 * Schema is intentionally fuz_forge-local: it FKs to fuz_app's `api_token`
 * table but lives outside fuz_app's schema. Scoping is a fuz_forge-specific
 * concept and the policy grammar references fuz_forge-specific surfaces
 * (forge repos, file store paths, RPC methods); other fuz_app
 * consumers don't need this column.
 *
 * Cascade-delete on `api_token_id` ties policy lifetime to token
 * lifetime — revoking the underlying token automatically removes the
 * policy.
 *
 * @module
 */

import type { Db } from '@fuzdev/fuz_app/db/db.ts';

/**
 * SQL for creating the fuz_forge_api_token_policy table.
 *
 * - `api_token_id` is both PK and FK — one policy per token.
 * - `policy` is a strict JSONB document validated by the token policy schema on write
 *   (see `FuzForgeTokenPolicy`); the column stores the canonical
 *   shape.
 * - `policy_version` is a forward-compat hook — the doc carries its
 *   own `version` field too, this column lets us index/migrate
 *   without parsing the jsonb.
 * - `template` is an audit trail of which create-template minted this
 *   policy (e.g. `'forge_push'`, `'files_read'`). The token-list UI
 *   surfaces this so operators can see at a glance what a token does
 *   without rendering the raw policy.
 */
export const FUZ_FORGE_API_TOKEN_POLICY_SCHEMA = `
CREATE TABLE IF NOT EXISTS fuz_forge_api_token_policy (
  api_token_id   TEXT        PRIMARY KEY REFERENCES api_token(id) ON DELETE CASCADE,
  policy         JSONB       NOT NULL,
  policy_version INTEGER     NOT NULL DEFAULT 1,
  template       TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

/**
 * Initialize the fuz_forge API token policy schema.
 *
 * Must run after `init_auth_schema` (which creates `api_token`), since
 * the FK references it.
 *
 * @param db - database instance
 */
export const init_fuz_forge_api_token_policy_schema = async (db: Db): Promise<void> => {
	await db.query(FUZ_FORGE_API_TOKEN_POLICY_SCHEMA);
};
