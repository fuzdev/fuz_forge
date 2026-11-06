/**
 * Tests for the forge's create authorizer — the reserved-kind predicate and its
 * wiring over the caller's global `admin` grant.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import type { RequestActorContext } from '@fuzdev/fuz_app/auth/request_context.ts';
import type { CellCreateAuthorizeInput } from '@fuzdev/fuz_app/auth/cell_actions.ts';
import type { ActionContext } from '@fuzdev/fuz_app/actions/action_types.ts';

import {
	cell_create_admits,
	RESERVED_CELL_KINDS,
	reserved_kind_create_authorize
} from '#lib/server/fuz_forge_cell_create_authorize.ts';
import {
	load_parity_fixture,
	parity_bool,
	parity_rows,
	parity_string
} from '../fixtures/parity/load.ts';

const FIXTURE = load_parity_fixture('cell_create_reserved_kinds');

describe('cell_create_admits', () => {
	// Asserted against `src/test/fixtures/parity/cell_create_reserved_kinds.json`,
	// which the Rust twin's `cell_create_authorize` tests read too.
	for (const row of parity_rows(FIXTURE, 'cases')) {
		const [kind, is_admin] = row.args as [string | null, boolean];
		const accepted = parity_bool(row, 'accepted');
		test(`${accepted ? 'admits' : 'refuses'}: kind ${JSON.stringify(kind)}, admin ${is_admin}`, () => {
			assert.strictEqual(cell_create_admits(kind, is_admin), accepted);
		});
	}

	test('the reserved kinds are the constants table', () => {
		assert.deepStrictEqual(
			parity_rows(FIXTURE, 'reserved').map((row) => parity_string(row, 'name')),
			[...RESERVED_CELL_KINDS]
		);
	});
});

describe('reserved_kind_create_authorize', () => {
	/** A context holding `grants`; the authorizer reads `role_grants` alone. */
	const context = (
		grants: Array<{ role: string; scope_id: string | null; revoked_at?: string }>
	): RequestActorContext =>
		({
			role_grants: grants.map((g) => ({ expires_at: null, revoked_at: null, ...g }))
		}) as unknown as RequestActorContext;

	const input = (kind: string | null): CellCreateAuthorizeInput => ({
		kind,
		data: {},
		parent_id: null,
		parent_kind: null,
		root_id: null,
		root_policy: null
	});

	const ctx = {} as ActionContext;

	test('a global admin creates a reserved kind', async () => {
		const auth = context([{ role: 'admin', scope_id: null }]);
		assert.deepStrictEqual(
			await reserved_kind_create_authorize.authorize(auth, input('repo'), ctx),
			{
				allow: true,
				moderation_required: false
			}
		);
	});

	test('a scoped or revoked admin grant is no admin here', async () => {
		for (const grant of [
			{ role: 'admin', scope_id: '00000000-0000-4000-8000-000000000001' },
			{ role: 'admin', scope_id: null, revoked_at: '2026-01-01T00:00:00Z' }
		]) {
			const verdict = await reserved_kind_create_authorize.authorize(
				context([grant]),
				input('file'),
				ctx
			);
			assert.deepStrictEqual(verdict, { allow: false }, JSON.stringify(grant));
		}
	});

	test('a roleless caller creates any other kind, unmoderated', async () => {
		assert.deepStrictEqual(
			await reserved_kind_create_authorize.authorize(context([]), input('note'), ctx),
			{ allow: true, moderation_required: false }
		);
		assert.deepStrictEqual(
			await reserved_kind_create_authorize.authorize(context([]), input('repo'), ctx),
			{ allow: false }
		);
	});
});
