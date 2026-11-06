/**
 * Unit tests for `token_scope_admits_forge_surface` — the rule deciding which
 * of the forge's two per-token authority axes governs a request.
 *
 * Three lines of code, and the one whose wrong answer is silent privilege
 * escalation: it is what stands between a token minted narrow through the
 * spine's `account_token_create` and the file store, the git remote, and every
 * byte either serves. `policy_check` has its own suite next door; this one
 * covers the axis *selection*, which is the part that was missing and let a
 * narrowed token through.
 *
 * The case that matters most is the one that reads like a tautology —
 * `(null, methods) === false`. Without this rule the answer is `true`, arrived
 * at by never asking: `policy_check(null, …)` returns `true` for a token that
 * has no policy row, and nothing would distinguish *that axis abstaining* from
 * *the request being granted*.
 *
 * An absent scope is the anonymous caller, who holds no credential to narrow,
 * and it passes — matching the spine's own `token_scope_denial`, whose docs call
 * out that hand-rolling this branch per surface is one `&&` from either refusing
 * every anonymous read or admitting an authenticated caller whose middleware
 * forgot to set the key. The surrounding role gate is what refuses an anonymous
 * caller here; this rule is not it.
 *
 * No DB, no HTTP. The wiring at the call sites is exercised by
 * `routes/files.scoped_token.db.test.ts` and the cross-backend
 * `consumer_surface_scoped_token.cross.test.ts`.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import {
	token_scope_full,
	token_scope_methods,
	type TokenScope
} from '@fuzdev/fuz_app/auth/token_scope.ts';

import { token_scope_admits_forge_surface } from '#lib/server/fuz_forge_token_surfaces.ts';
import { policy_from_template } from '#lib/server/fuz_forge_token_policy.ts';
import type { FuzForgeTokenTemplateInput } from '#lib/action_specs.ts';
import type { FuzForgeTokenPolicy } from '#lib/server/fuz_forge_token_policy_schema.ts';
import { load_parity_fixture, parity_bool, parity_rows } from '../fixtures/parity/load.ts';

/**
 * The policy row a template mints, refusing the `admin` template's `null`.
 *
 * Built from a real template rather than hand-rolled, so these cases break if
 * the templates stop producing a policy at all — which is the input this rule
 * keys off. `admin` is the one template that returns `null`, and a token minted
 * from it is the *no policy row* case the fixture spells as a `null` policy.
 */
const template_policy = (template: FuzForgeTokenTemplateInput): FuzForgeTokenPolicy => {
	const policy = policy_from_template(template);
	if (policy === null) throw new Error(`template ${template.kind} mints no policy row`);
	return policy;
};

/** The fixture's `policy` field, resolved to the value the rule takes. */
const policy_of = (name: string | null): FuzForgeTokenPolicy | null => {
	if (name === null) return null;
	if (name === 'files_read') {
		return template_policy({ kind: 'files_read', filenames: ['tools/fuz.tar.gz'] });
	}
	throw new Error(`unknown parity policy ${name}`);
};

/** The fixture's `scope` field, resolved to the value the rule takes. */
const scope_of = (scope: Record<string, unknown>): TokenScope | null => {
	switch (scope.kind) {
		case 'absent':
			return null;
		case 'full':
			return token_scope_full();
		case 'full_grandfathered':
			// The migration's backfill. `grandfathered` is a fact about the row that
			// the enforcement path must never branch on — if it did, "grandfathered"
			// would become a third authority level. The Rust `TokenScope` carries no
			// such flag, which is why this row is `ts_only`.
			return { ...token_scope_full(), grandfathered: true };
		case 'methods':
			return token_scope_methods(scope.methods as Array<string>);
		default:
			throw new Error(`unknown parity scope ${JSON.stringify(scope)}`);
	}
};

describe('token_scope_admits_forge_surface', () => {
	// Asserted against `src/test/fixtures/parity/token_surfaces.json`, which the
	// Rust twin (`crates/fuz_forge_server/src/token_surfaces.rs`) reads too. Its
	// `ts_only` rows are the two an absent credential produces and the
	// grandfathered full scope — neither is representable in the Rust
	// `TokenScope`, which is an enum with no flag and no absent variant here.
	for (const row of parity_rows(load_parity_fixture('token_surfaces'), 'cases')) {
		const policy_name = (row.policy ?? null) as string | null;
		const scope = row.scope as Record<string, unknown>;
		const accepted = parity_bool(row, 'accepted');
		const label = `${policy_name ?? 'no policy row'} + ${String(scope.kind)}${
			scope.kind === 'methods' ? ` ${JSON.stringify(scope.methods)}` : ''
		}`;
		test(`${accepted ? 'admits' : 'refuses'}: ${label}`, () => {
			assert.strictEqual(
				token_scope_admits_forge_surface(policy_of(policy_name), scope_of(scope)),
				accepted
			);
		});
	}
});
