# Auth Walkthrough Checklist

Expected behavior when testing the auth system end-to-end.

## Bootstrap (first-time)

- [ ] `GET /api/account/status` returns 401 with `{error: "authentication_required", bootstrap_available: true}`
- [ ] `/admin` auto-shows `BootstrapForm` (no manual toggle needed)
- [ ] Submitting with wrong token returns error, token file still exists
- [ ] Submitting with correct token + username + password creates the account with `keeper` and `admin` role grants
- [ ] SPA loads authenticated dashboard, cookie is set (no server redirect — SPA checks status)
- [ ] Bootstrap token file is deleted from disk
- [ ] `GET /api/account/status` 401 response no longer includes `bootstrap_available` (omitted when false)
- [ ] `/admin` shows `LoginForm` (bootstrap form gone)
- [ ] Re-submitting bootstrap returns error (precondition: no accounts)

## Login

- [ ] Wrong username returns 401 (with timing-safe dummy verify)
- [ ] Wrong password returns 401
- [ ] Correct credentials set `fuz_forge_session` cookie, return `{ok: true}` (account info comes from `/api/account/status`)
- [ ] `GET /api/account/status` returns `{account: {...}}` with session cookie (frontend uses this)
- [ ] `GET /api/account/verify` (TS reference only; the Rust backend has none, and the forge's nginx config doesn't use it) returns an empty-body 200 with a session cookie
- [ ] A narrowed token gets 403 `{error: 'token_scope_required', required_scope: 'surface:account_verify'}` there; the `account_verify` RPC is the typed account read
- [ ] Second login creates a separate session (both valid)

## Session management

- [ ] `account_session_list` (RPC) lists all sessions with `created_at` and `expires_at` (no activity signal — the session lifetime is a hard cap set at mint)
- [ ] Revoking a session deletes it — that cookie stops working
- [ ] Revoke-all invalidates all sessions including the current one (UI shows login)
- [ ] Expired sessions (30-day lifetime, `expires_at` fixed at mint) stop authenticating — the session lookup gates on `expires_at > NOW()`
- [ ] Both backends sweep expired sessions at startup and then once per interval: Rust `fuz_auth::spawn_auth_cleanup` (`DEFAULT_AUTH_CLEANUP_INTERVAL`), TS `create_app_server`'s `auth_cleanup` (fuz_app's `start_auth_cleanup`, `DEFAULT_AUTH_CLEANUP_INTERVAL_MS`)
- [ ] A sweep deletes expired session rows, closes the sockets and audit streams they opened, and audits each expired role-grant offer once — so an expired session drops out of `account_session_list` (which doesn't filter on expiry) and its live connections end within an interval
- [ ] An expired API token's row is not swept; its connections close at its `expires_at`
- [ ] Login while at session cap (default 5) evicts the oldest session and closes the connections it opened
- [ ] Bearer/api_token call to `account_session_revoke` or `account_session_revoke_all` returns 403 `credential_type_required` with `required_credential_types: ['session']` (credential-channel gate)

## Password change

- [ ] `POST /api/account/password` with correct `current_password` + `new_password` returns `{ok: true, sessions_revoked: N, tokens_revoked: N}`
- [ ] Response clears session cookie — client sees login form immediately
- [ ] Every session for the account is deleted, the calling one included, and every API token with them — a password change is a full credential reset, not a "revoke the others" sweep
- [ ] The reset reaches tooling: if `<home>/api_token` holds a token minted for that account, it stops working and `fuzf` needs a freshly minted one
- [ ] Wrong `current_password` returns 401, no mutations
- [ ] Password too short or too long returns 400
- [ ] Rate limited (shared IP limiter): too many failures return 429
- [ ] Bearer/api_token `POST /api/account/password` is rejected with 403 `credential_type_required` + `required_credential_types: ['session']` (credential-channel gate)
- [ ] Audit rows for `password_change` failures (wrong-password, concurrent-change) carry `metadata.credential_type: 'session'`

## Role enforcement

fuz_forge operations dispatch through `/api/rpc` (HTTP) and `/api/ws` (WebSocket). Role enforcement happens per-action inside the JSON-RPC dispatch, so the tests target action methods rather than HTTP paths. Every `fuz_forge_*` request/response action requires the `admin` role (the `fuz_forge_repo_updated` broadcast is gated by the WS upgrade).

- [ ] Authenticated user without `admin` gets 403 / `-32002` on the repo RPCs (`fuz_forge_repo_list`, `fuz_forge_repo_get`, `fuz_forge_repo_create`, `fuz_forge_repo_resync`, `fuz_forge_repo_log`, `fuz_forge_repo_commit`, `fuz_forge_repo_refs`, `fuz_forge_repo_tree`, `fuz_forge_repo_blob`) and the management RPCs (`fuz_forge_repo_rotate_secret`, `fuz_forge_token_create_scoped`, `fuz_forge_token_policy_list`)
- [ ] The `admin` role grants all of the above
- [ ] Session-only RPCs (`fuz_forge_repo_rotate_secret`, `fuz_forge_token_create_scoped`, `fuz_forge_token_policy_list`) reject bearer/api-token callers with 403 `credential_type_required` + `required_credential_types: ['session']`, even when the account has `admin`
- [ ] Unauthenticated requests get 401 on protected `/api/*` routes (public endpoints: `/health`, `/ready`, `/api/account/status`, `/api/account/login`, `/api/account/signup`, `/api/account/bootstrap`; on `/api/rpc`, the generic cell bundle's reads (`cell_get`, `cell_list`, …) and `peer/ping` also answer anonymous callers)
- [ ] A non-admin `cell_create` or `cell_clone` of a `repo` or `file` cell gets 403 `cell_create_forbidden` — those kinds are the forge's own (repos and file-store entries); every other kind stays open to any account; a child created under a root with the authorizer mounted is born `moderation: approved`, so the root's owner can reject it with `cell_moderate`
- [ ] `/api/ws` WebSocket upgrade requires authentication (cookie session or bearer token) and the `admin` role; per-action `admin` is still enforced on each dispatched message

## API tokens (bearer)

- [ ] Create token via `account_token_create` (RPC) — raw token (`secret_fuz_token_...`) returned once
- [ ] `curl -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"fuz_forge_repo_list","params":{}}' /api/rpc` works
- [ ] A token sent with `Referer`, or with an allowed `Origin`, is discarded (no token-specific 403), so a protected route answers 401; a foreign `Origin` gets the origin check's 403 first
- [ ] Revoked token returns 401
- [ ] `account_token_list` (RPC) lists tokens without hashes (shows `tok_`-prefixed public ID)
- [ ] API token **cannot** exercise session-only operations (`fuz_forge_token_create_scoped`, `fuz_forge_repo_rotate_secret`, `fuz_forge_token_policy_list` return 403 `credential_type_required` even when the account has `admin`)
- [ ] Creating tokens while at cap (default 10) evicts the oldest token and closes the connections it opened
- [ ] Bearer/api_token call to `account_token_create` or `account_token_revoke` returns 403 `credential_type_required` with `required_credential_types: ['session']` (credential-channel gate — self-service token mgmt is session-only; admin scripting uses `admin_token_revoke_all`)

## Scoped API tokens (per-token capability narrowing)

Two layers narrow a bearer, and they cover different surfaces.
`fuz_forge_token_create_scoped` writes both from one template:

- **The spine's `api_token.scope`** governs RPC methods and every non-RPC
  spine surface (db-admin, bare-fact reads, the audit stream, the WS
  upgrade, the `/verify` probe). `admin` → full authority; `rpc_subset` → the
  named method set; the file/forge templates → the empty method set (they
  grant no RPC). A narrowed scope is RPC-only, so any non-`admin` template is
  refused every non-RPC spine surface that reads account data or carries
  authority — the two routes that also answer anonymous callers,
  `/api/account/status` and the cell-scoped fact read, answer a narrowed token
  as the anonymous caller instead (`/api/server/status`, which discloses no
  account data, needs an account but no scope).
- **The forge-local `fuz_forge_api_token_policy` row** (sibling to
  `api_token`, FK CASCADE) governs forge's resource-bound REST surfaces —
  the file store and git — which the spine has no vocabulary for.

Issuing a token via `account_token_create` takes a `scope` directly and
writes no forge policy row.

- [ ] `fuz_forge_token_create_scoped` (session-only, admin-only) takes a
      required `lifetime` and mints `{ok, token, id, name, template}`, writes the derived `api_token.scope`,
      and writes a `fuz_forge_api_token_policy` row when
      `template.kind !== 'admin'`. `admin` template skips the policy
      insert — the token is intentionally unscoped
- [ ] `fuz_forge_token_policy_list` returns one row per scoped token owned by
      the calling account, suitable for joining against
      `account_token_list` in the UI. Unscoped tokens are absent
- [ ] Token list UI surfaces `admin` chip for unscoped vs the template
      name for scoped (`forge_push`, `forge_pull`, `files_read`,
      `files_write`, `files_read_write`, `rpc_subset`)
- [ ] Templates:
      - `admin` — no policy row written; behaves like
        `account_token_create`
      - `forge_push` / `forge_pull` — array of repo **cell-id UUIDs** (from
        `repo list` / `repo view`, not slugs — the git gate matches on the cell
        id, and a slug is refused at mint rather than minting a token that
        silently never authorizes anything)
      - `files_read` / `files_write` / `files_read_write` — `'*'` wildcard
        or explicit filename list. No template grants `files.delete`, so no
        scoped token can delete
      - `rpc_subset` — array of method names
- [ ] Denied forge REST operations return 403 with
      `{error: 'forbidden', required: '<capability>'}`. Capability strings:
      `forge.push:<repo>`, `forge.pull:<repo>`, `files.read:<filename>`,
      `files.write:<filename>`, `files.delete:<filename>`
- [ ] A denied RPC method returns the spine's JSON-RPC `forbidden` envelope
      (`-32002`, HTTP 403) with
      `data: {reason: 'token_scope_required', required_scope: 'rpc:<method>'}`
- [ ] Forge smart-HTTP (`/<slug>.git/*`) generic 401 — git clients
      can't render structured 403 bodies, so the locked-down posture
      stays. The policy check runs after authentication, against the
      operation (push or pull) derived from the request
- [ ] WebSocket upgrade (`/api/ws`) rejects scoped tokens with 403
      `{error: 'token_scope_required', required_scope: 'surface:ws_upgrade'}`.
      Broadcasts (e.g. `fuz_forge_repo_updated`) fan out without a
      per-recipient filter, so scoped tokens are HTTP-only. Session
      cookies and unscoped bearer tokens still upgrade
- [ ] Deny-all policy (`{version: 1}`, no `forge`/`files`/`rpc` keys)
      rejects every protected forge REST route. Covered by
      `src/test/server/routes/scoped_token_deny_all_coverage.db.test.ts`
      as a discipline guard against new check sites forgetting to
      consult the policy
- [ ] The stored document's grammar is exact on both backends: `version` is
      the literal `1` (a `{version: 2}` row is a future grammar, not a
      version-1 policy), and each per-id grant value is `true` or the empty
      object `{}` — `false`, a number, a string, `[]`, and `{branches: [...]}`
      are all outside the grammar
- [ ] A policy row that fails that grammar is read as the deny-all document,
      **not** as an absent row: the row says the token is scoped, and treating
      it as unscoped is the one outcome that would widen the token. The parse
      failure is logged; the token then reaches no forge resource

## File store download auth

The content-addressed file store at `/api/fuz_forge/files/<filename>`.

- [ ] `curl -H "Authorization: Bearer <token>" /api/fuz_forge/files/<filename>` streams the file bytes
- [ ] Unauthenticated `GET /api/fuz_forge/files/<filename>` returns 401
- [ ] Cookie-authenticated browser can download from `/api/fuz_forge/files/<filename>`
- [ ] Any authenticated caller with a session or an unscoped token can download
- [ ] A `files_read`-scoped token downloads only its allowlisted filenames; a non-matching filename returns 403 `{required: 'files.read:<filename>'}` (see § Scoped API tokens)
- [ ] A token minted through `account_token_create` with a **narrowed** scope has no forge policy row, so its `api_token.scope` answers instead: 403 `{error: 'token_scope_required', required_scope: 'surface:file_store'}` on every file route, and the generic 401 at git smart-HTTP
- [ ] `fuzf file get` sends the token from `FUZ_FORGE_TOKEN`, else `<home>/api_token`

## UI

- [ ] Account page shows active sessions with revoke controls
- [ ] Logging out clears cookie and revokes session
- [ ] Refreshing with invalid cookie shows login form (SPA auth, not redirect)
- [ ] Account page token form has a template picker (admin / forge_push
      / forge_pull / files_read / files_write / files_read_write /
      rpc_subset) with
      per-template param inputs (repo ids / filenames / methods).
      Submitting routes to `account_token_create` for the `admin`
      template and `fuz_forge_token_create_scoped` for every other template
- [ ] Each token row shows a scope chip — `admin` for unscoped, the
      template name otherwise
