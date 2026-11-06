/**
 * Handler tests for `fuz_forge_token_create_scoped`.
 *
 * Exercises the mint-token + insert-policy transactional pair end-to-end
 * via JSON-RPC:
 *
 *   - admin template → no policy row written
 *   - forge_push template → policy row with the right shape
 *   - files_read wildcard → policy row with `read: '*'`
 *   - rpc_subset → policy row with method allowlist
 *   - issued token is usable (raw token resolves via api_token table)
 *   - oversize policy → validation_error
 *   - every template stamps the spine `api_token.scope` it implies
 *
 * That last one covers the *other* axis. The mint writes two records from one
 * template — the forge policy row and the spine scope — and the forge's rule for
 * which of them governs a surface (`server/fuz_forge_token_surfaces.ts`) is
 * argued entirely from what the scope half comes out as. Twin: the Rust
 * `token_scope_for_template` unit tests.
 *
 * Authz invariants (admin-only, session-only credential) are covered by
 * the standard auth attack surface snapshot — this file targets the
 * handler-specific behaviors.
 *
 * @module
 */

import { assert, test, beforeAll, beforeEach } from 'vitest';
import { ROLE_ADMIN, ROLE_KEEPER } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import type { TestApp, TestAccount } from '@fuzdev/fuz_app/testing/app_server.ts';
import { parse_stored_token_scope, type TokenScope } from '@fuzdev/fuz_app/auth/token_scope.ts';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import { FuzForgeTokenCreateScopedOutput } from '#lib/action_specs.ts';

import { describe_db } from '../../db_fixture.ts';
import { create_fuz_forge_admin_test_app } from './fuz_forge_test_helpers.ts';

interface PolicyRow {
	api_token_id: string;
	policy: unknown;
	template: string;
}

const get_policy_row = async (db: Db, api_token_id: string): Promise<PolicyRow | null> => {
	return (
		(await db.query_one<PolicyRow>(
			`SELECT api_token_id, policy, template FROM fuz_forge_api_token_policy WHERE api_token_id = $1`,
			[api_token_id]
		)) ?? null
	);
};

/**
 * Repo cell ids for the forge templates.
 *
 * Real UUIDs, because that is the only form the git gate can ever match — it
 * checks `forge.push:<repo cell id>`. These fixtures used slugs, which modelled
 * a token that mints cleanly and then silently authorizes nothing.
 */
const REPO_ID_A = '3f8a1c2e-1234-4abc-9def-0123456789ab';
const REPO_ID_B = '7c2b4d1a-5678-4ef0-8abc-fedcba987654';

/** The spine scope the mint stamped on the `api_token` row. */
const get_token_scope = async (db: Db, api_token_id: string): Promise<TokenScope> => {
	const row = await db.query_one<{ scope: unknown }>(`SELECT scope FROM api_token WHERE id = $1`, [
		api_token_id
	]);
	if (!row) throw new Error(`no api_token ${api_token_id}`);
	const scope = parse_stored_token_scope(row.scope);
	if (scope === null) throw new Error(`unreadable scope on ${api_token_id}`);
	return scope;
};

describe_db('fuz_forge_token_create_scoped handler', (get_db) => {
	let test_app: TestApp;
	let admin: TestAccount;

	beforeAll(async () => {
		test_app = await create_fuz_forge_admin_test_app(get_db, {
			roles: [ROLE_KEEPER, ROLE_ADMIN]
		});
	});

	beforeEach(async () => {
		admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
	});

	test('admin template mints an unscoped token (no policy row)', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_token_create_scoped',
			params: { name: 'CI deploy key', template: { kind: 'admin' }, lifetime: { kind: 'eternal' } },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		assert(parse(FuzForgeTokenCreateScopedOutput, res.result).ok);
		const out = res.result as FuzForgeTokenCreateScopedOutput;
		assert.strictEqual(out.template, 'admin');
		assert.ok(out.token);
		assert.ok(out.id.startsWith('tok_'));

		const policy_row = await get_policy_row(get_db(), out.id);
		assert.isNull(policy_row);
	});

	test('forge_push template writes a policy row with the right shape', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'fuz_app ci push',
				template: { kind: 'forge_push', repo_ids: [REPO_ID_A, REPO_ID_B] },
				lifetime: { kind: 'eternal' }
			},
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		assert(parse(FuzForgeTokenCreateScopedOutput, res.result).ok);
		const out = res.result as FuzForgeTokenCreateScopedOutput;
		assert.strictEqual(out.template, 'forge_push');

		const policy_row = await get_policy_row(get_db(), out.id);
		assert.isNotNull(policy_row);
		assert.deepStrictEqual(policy_row.policy, {
			version: 1,
			forge: { push: { [REPO_ID_A]: true, [REPO_ID_B]: true } }
		});
		assert.strictEqual(policy_row.template, 'forge_push');
	});

	test('files_read wildcard writes "*"', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'deploy read',
				template: { kind: 'files_read', filenames: '*' },
				lifetime: { kind: 'eternal' }
			},
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		assert(parse(FuzForgeTokenCreateScopedOutput, res.result).ok);
		const out = res.result as FuzForgeTokenCreateScopedOutput;
		const policy_row = await get_policy_row(get_db(), out.id);
		assert.deepStrictEqual(policy_row!.policy, { version: 1, files: { read: '*' } });
	});

	test('files_write explicit list', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'pinned bin writer',
				template: { kind: 'files_write', filenames: ['zig.tar.xz'] },
				lifetime: { kind: 'eternal' }
			},
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		assert(parse(FuzForgeTokenCreateScopedOutput, res.result).ok);
		const out = res.result as FuzForgeTokenCreateScopedOutput;
		const policy_row = await get_policy_row(get_db(), out.id);
		assert.deepStrictEqual(policy_row!.policy, {
			version: 1,
			files: { write: { 'zig.tar.xz': true } }
		});
	});

	test('rpc_subset writes the method allowlist', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'log reader',
				template: { kind: 'rpc_subset', methods: ['fuz_forge_repo_log'] },
				lifetime: { kind: 'eternal' }
			},
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		assert(parse(FuzForgeTokenCreateScopedOutput, res.result).ok);
		const out = res.result as FuzForgeTokenCreateScopedOutput;
		const policy_row = await get_policy_row(get_db(), out.id);
		assert.deepStrictEqual(policy_row!.policy, { version: 1, rpc: { fuz_forge_repo_log: true } });
	});

	test('issued token is usable — resolves in api_token table', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_token_create_scoped',
			params: { name: 'sanity', template: { kind: 'admin' }, lifetime: { kind: 'eternal' } },
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		assert(parse(FuzForgeTokenCreateScopedOutput, res.result).ok);
		const out = res.result as FuzForgeTokenCreateScopedOutput;

		const row = await get_db().query_one<{ id: string; account_id: string; name: string }>(
			`SELECT id, account_id, name FROM api_token WHERE id = $1`,
			[out.id]
		);
		assert.isDefined(row);
		assert.strictEqual(row.account_id, admin.account.id);
		assert.strictEqual(row.name, 'sanity');
	});

	/**
	 * A slug where a repo cell id belongs is refused at mint.
	 *
	 * The git gate matches `forge.push:<repo cell id>`, so a slug mints a policy
	 * that can never match — and git's generic-401 posture means the operator
	 * never learns why. Mint is the last point the mistake can be reported.
	 * Twin: the Rust `forge_templates_reject_a_slug_where_a_repo_id_belongs`.
	 */
	test('rejects a slug where a repo cell id belongs', async () => {
		for (const repo_ids of [['fuzdev/fuz_app'], ['fuz_app'], [REPO_ID_A, 'fuz_app']]) {
			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_token_create_scoped',
				params: {
					name: 'slug attempt',
					template: { kind: 'forge_push', repo_ids },
					lifetime: { kind: 'eternal' }
				},
				headers: admin.create_session_headers()
			});
			assert.isFalse(res.ok, `${JSON.stringify(repo_ids)} must be refused`);
			assert.strictEqual(res.error.code, -32602);
		}
	});

	/**
	 * An uppercase repo id is stored as its lowercase form.
	 *
	 * The git gate compares the policy's `repo_ids` keys against the cell id as
	 * Postgres renders it — lowercase — so a key kept in the caller's case mints a
	 * token that silently authorizes nothing. Dispatched through the RPC endpoint
	 * so the `RepoId` parse is what does the lowercasing.
	 * Twin: the Rust `forge_templates_lowercase_repo_ids`.
	 */
	test('stores an uppercase repo id as its lowercase policy key', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'uppercase pull',
				template: { kind: 'forge_pull', repo_ids: [REPO_ID_A.toUpperCase()] },
				lifetime: { kind: 'eternal' }
			},
			headers: admin.create_session_headers()
		});
		assert.isTrue(res.ok);
		assert(parse(FuzForgeTokenCreateScopedOutput, res.result).ok);
		const out = res.result as FuzForgeTokenCreateScopedOutput;
		const policy_row = await get_policy_row(get_db(), out.id);
		assert.deepStrictEqual(policy_row!.policy, {
			version: 1,
			forge: { pull: { [REPO_ID_A]: true } }
		});
	});

	test('rejects an empty repo_ids array (its min_length(1))', async () => {
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'bad',
				template: { kind: 'forge_push', repo_ids: [] },
				lifetime: { kind: 'eternal' }
			},
			headers: admin.create_session_headers()
		});
		assert.isFalse(res.ok);
		// Invalid params (validation error before handler runs).
		assert.strictEqual(res.error.code, -32602);
	});

	test('non-admin issuer is rejected by auth gate', async () => {
		// Account WITHOUT admin role. The action spec declares `roles: ['admin']`
		// so the per-action authorization phase 403s before the handler runs.
		const ordinary = await test_app.create_account({ roles: [] });
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_token_create_scoped',
			params: { name: 'attempt', template: { kind: 'admin' }, lifetime: { kind: 'eternal' } },
			headers: ordinary.create_session_headers()
		});
		assert.isFalse(res.ok);
		assert.strictEqual(res.error.code, -32002); // forbidden
	});

	test("bearer credential is rejected — credential_types: ['session'] only", async () => {
		// Even an admin bearer is rejected — credential-channel gate.
		const res = await rpc_call({
			app: test_app.app,
			path: '/api/rpc',
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'bearer attempt',
				template: { kind: 'admin' },
				lifetime: { kind: 'eternal' }
			},
			headers: admin.create_bearer_headers(),
			suppress_default_origin: true
		});
		assert.isFalse(res.ok);
		assert.strictEqual(res.error.code, -32002); // forbidden (credential_type_required)
	});

	/**
	 * The spine scope each template stamps on `api_token.scope`.
	 *
	 * The premise the forge's whole two-axis rule rests on, and until now the one
	 * thing nothing asserted. `token_scope_admits_forge_surface` lets a token with
	 * a policy row past the scope gate *because* these tokens carry `methods: []`
	 * and a whole-surface refusal would refuse every one of them; and rule 3 keeps
	 * them out of the db-admin browser, the audit stream, and the WS upgrade for
	 * the same reason. Both arguments read identically if a template silently
	 * started minting `full`, and nothing would have failed — the policy would
	 * still gate the file store, so the regression would only show up as a scoped
	 * token reaching `account.password_hash`.
	 *
	 * Twin: the Rust `handlers/token.rs` match, which must map the same way.
	 */
	test('the mint stamps the spine scope each template implies', async () => {
		const mint = async (
			template: Record<string, unknown>
		): Promise<FuzForgeTokenCreateScopedOutput> => {
			const res = await rpc_call({
				app: test_app.app,
				path: '/api/rpc',
				method: 'fuz_forge_token_create_scoped',
				params: {
					name: `scope probe ${template.kind as string}`,
					template,
					lifetime: { kind: 'eternal' }
				},
				headers: admin.create_session_headers()
			});
			assert.isTrue(res.ok, `mint ${template.kind as string} failed: ${JSON.stringify(res)}`);
			assert(parse(FuzForgeTokenCreateScopedOutput, res.result).ok);
			return res.result as FuzForgeTokenCreateScopedOutput;
		};

		// `admin` is the one template that means full authority — it writes no
		// policy row, so the scope is the only thing governing it.
		const admin_token = await mint({ kind: 'admin' });
		assert.deepStrictEqual(await get_token_scope(get_db(), admin_token.id), {
			version: 1,
			kind: 'full'
		});

		// `rpc_subset` is the one template that grants RPC, so it is the one whose
		// method list is non-empty.
		const rpc_token = await mint({ kind: 'rpc_subset', methods: ['fuz_forge_repo_list'] });
		assert.deepStrictEqual(await get_token_scope(get_db(), rpc_token.id), {
			version: 1,
			kind: 'methods',
			methods: ['fuz_forge_repo_list']
		});

		// The file / forge templates grant no RPC at all, so `methods: []` is the
		// honest encoding — and it is what makes them RPC-inert while their policy
		// row keeps them working on the surfaces they were minted for.
		const resource_templates = [
			{ kind: 'forge_push', repo_ids: [REPO_ID_A] },
			{ kind: 'forge_pull', repo_ids: [REPO_ID_A] },
			{ kind: 'files_read', filenames: '*' },
			{ kind: 'files_write', filenames: '*' },
			{ kind: 'files_read_write', filenames: '*' }
		];
		for (const template of resource_templates) {
			const token = await mint(template);
			assert.deepStrictEqual(
				await get_token_scope(get_db(), token.id),
				{ version: 1, kind: 'methods', methods: [] },
				`${template.kind} must mint an RPC-inert scope`
			);
		}
	});
});
