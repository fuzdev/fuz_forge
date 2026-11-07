/**
 * Unit tests for the scoped-token policy core:
 *
 * - `policy_check` — the single source of truth every gate consults.
 *   Wrong answer here is silent privilege escalation; this suite is
 *   the load-bearing safety net.
 * - `capability_string` — the format that goes into 403
 *   `{required: ...}` bodies; CLIs parse it.
 * - `policy_from_template` — pure builder over the seven v1 templates.
 * - `policy_from_stored` — the fail-closed read of a stored policy document.
 *
 * No DB. Pure logic only. The actual check-site wiring (forge,
 * file store, RPC, WS) is exercised by the per-route db.test.ts
 * files.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { parse, parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';

import {
	capability_string,
	policy_check,
	policy_from_stored,
	policy_from_template,
	type FuzForgeCapability
} from '#lib/server/fuz_forge_token_policy.ts';
import type { FuzForgeTokenTemplateInput } from '#lib/action_specs.ts';
import { DENY_ALL_POLICY, FuzForgeTokenPolicy } from '#lib/server/fuz_forge_token_policy_schema.ts';
import { load_parity_fixture, parity_bool, parity_rows } from '../fixtures/parity/load.ts';

const schema_fixture = load_parity_fixture('token_policy_schema');
const stored_fixture = load_parity_fixture('policy_from_stored');

describe('policy_check — unscoped tokens', () => {
	test('null policy allows every capability kind', () => {
		const caps: Array<FuzForgeCapability> = [
			{ kind: 'forge.push', repo_id: 'any' },
			{ kind: 'forge.pull', repo_id: 'any' },
			{ kind: 'files.read', filename: 'any.bin' },
			{ kind: 'files.write', filename: 'any.bin' },
			{ kind: 'files.delete', filename: 'any.bin' }
		];
		for (const cap of caps) {
			assert.strictEqual(policy_check(null, cap), true, capability_string(cap));
		}
	});
});

describe('policy_check — empty policy denies everything', () => {
	const empty: FuzForgeTokenPolicy = { version: 1 };
	test('forge denied', () => {
		assert.strictEqual(policy_check(empty, { kind: 'forge.push', repo_id: 'r' }), false);
		assert.strictEqual(policy_check(empty, { kind: 'forge.pull', repo_id: 'r' }), false);
	});
	test('files denied', () => {
		assert.strictEqual(policy_check(empty, { kind: 'files.read', filename: 'f' }), false);
		assert.strictEqual(policy_check(empty, { kind: 'files.write', filename: 'f' }), false);
		assert.strictEqual(policy_check(empty, { kind: 'files.delete', filename: 'f' }), false);
	});
});

describe('policy_check — wildcard via literal "*"', () => {
	test('forge.push: "*" allows any repo', () => {
		const p: FuzForgeTokenPolicy = { version: 1, forge: { push: '*' } };
		assert.strictEqual(policy_check(p, { kind: 'forge.push', repo_id: 'alpha' }), true);
		assert.strictEqual(policy_check(p, { kind: 'forge.push', repo_id: 'beta' }), true);
		// Doesn't bleed into pull.
		assert.strictEqual(policy_check(p, { kind: 'forge.pull', repo_id: 'alpha' }), false);
	});
	test('files.read: "*" allows any filename', () => {
		const p: FuzForgeTokenPolicy = { version: 1, files: { read: '*' } };
		assert.strictEqual(policy_check(p, { kind: 'files.read', filename: 'a.bin' }), true);
		assert.strictEqual(policy_check(p, { kind: 'files.read', filename: 'b.bin' }), true);
		// Doesn't bleed into write or delete.
		assert.strictEqual(policy_check(p, { kind: 'files.write', filename: 'a.bin' }), false);
		assert.strictEqual(policy_check(p, { kind: 'files.delete', filename: 'a.bin' }), false);
	});
});

describe('policy_check — explicit allowlists', () => {
	test('forge.push: {alpha: true} allows alpha only', () => {
		const p: FuzForgeTokenPolicy = { version: 1, forge: { push: { alpha: true } } };
		assert.strictEqual(policy_check(p, { kind: 'forge.push', repo_id: 'alpha' }), true);
		assert.strictEqual(policy_check(p, { kind: 'forge.push', repo_id: 'beta' }), false);
	});
	test('per-key empty qualifier object is semantically true', () => {
		const p: FuzForgeTokenPolicy = { version: 1, forge: { push: { alpha: {} } } };
		assert.strictEqual(policy_check(p, { kind: 'forge.push', repo_id: 'alpha' }), true);
	});
	test('files.read + files.write independent', () => {
		const p: FuzForgeTokenPolicy = {
			version: 1,
			files: { read: '*', write: { 'pinned.bin': true } }
		};
		assert.strictEqual(policy_check(p, { kind: 'files.read', filename: 'any' }), true);
		assert.strictEqual(policy_check(p, { kind: 'files.write', filename: 'pinned.bin' }), true);
		assert.strictEqual(policy_check(p, { kind: 'files.write', filename: 'other.bin' }), false);
	});
});

describe('policy_check — prototype-key safety', () => {
	test('inherited Object prototype keys do not register as allowed', () => {
		const p: FuzForgeTokenPolicy = { version: 1, forge: { push: { alpha: true } } };
		// `toString` is on Object.prototype; without hasOwnProperty guard
		// it could falsely satisfy the check.
		assert.strictEqual(policy_check(p, { kind: 'forge.push', repo_id: 'toString' }), false);
		assert.strictEqual(policy_check(p, { kind: 'forge.push', repo_id: 'hasOwnProperty' }), false);
		assert.strictEqual(policy_check(p, { kind: 'forge.push', repo_id: '__proto__' }), false);
	});
});

describe('capability_string', () => {
	test('formats each capability kind with the expected shape', () => {
		assert.strictEqual(
			capability_string({ kind: 'forge.push', repo_id: 'fuz_app' }),
			'forge.push:fuz_app'
		);
		assert.strictEqual(
			capability_string({ kind: 'forge.pull', repo_id: 'fuz_app' }),
			'forge.pull:fuz_app'
		);
		assert.strictEqual(
			capability_string({ kind: 'files.read', filename: 'zig.tar.xz' }),
			'files.read:zig.tar.xz'
		);
		assert.strictEqual(
			capability_string({ kind: 'files.write', filename: 'zig.tar.xz' }),
			'files.write:zig.tar.xz'
		);
		assert.strictEqual(
			capability_string({ kind: 'files.delete', filename: 'zig.tar.xz' }),
			'files.delete:zig.tar.xz'
		);
	});
});

describe('FuzForgeTokenPolicy schema', () => {
	test('accepts a minimal policy ({version: 1})', () => {
		const parsed = parse_or_throw(FuzForgeTokenPolicy, { version: 1 });
		assert.deepStrictEqual(parsed, { version: 1 });
	});
	test('accepts the canonical forge_push template output', () => {
		parse_or_throw(FuzForgeTokenPolicy, {
			version: 1,
			forge: { push: { alpha: true, beta: true } }
		});
		parse_or_throw(FuzForgeTokenPolicy, { version: 1, forge: { push: '*' } });
	});
	test('rejects unknown top-level keys (strict)', () => {
		const r = parse(FuzForgeTokenPolicy, { version: 1, unknown: 'field' });
		assert.strictEqual(r.ok, false);
	});
	// The `version` accept/reject table is asserted against
	// `src/test/fixtures/parity/token_policy_schema.json`, which the Rust twin's
	// `schema_matches_the_shared_tables` reads too: exactly `1`, present, numeric. A
	// stored `{version: 2}` must fail on both backends rather than being enforced
	// under v1 rules by one of them.
	//
	// `1.0` is on the accept row (a tautology here — JS has no distinct `1.0`
	// literal, so this half of the row can only pin the JS number `1`) because
	// the two backends reach this grammar through different channels: the driver
	// hands this side the jsonb column pre-parsed, so a stored `1.0` is already
	// the JS number `1` by the time `literal(1)` sees it, while Rust parses
	// `policy::text` itself and gets a float. Rust widens to accept the
	// integral-float spelling so the same row reads the same way on both.
	//
	// The `grant_values` rows pin that a value outside `true | {}` fails the whole
	// document rather than being read as a grant on one backend and refused on the
	// other. The `optional_null` rows pin `.optional()`: absence and a value are
	// admitted, `null` never is — the Rust `#[serde(default)] Option<T>` reads
	// `null` as absence without a reject-null wrapper on every optional grant
	// field, so a `{files: null, forge: {push: '*'}}` row would grant push there
	// and deny everything here.
	//
	// A row is indexed in its test name because `JSON.stringify` collapses the
	// two `version` accept rows onto the same text — JS has no distinct `1.0`
	// literal — and two vitest cases with one name are one case.
	//
	// An accepted row asserts the parse *result*, not just that it parsed: a
	// schema that admitted `{version: 1}` and dropped its grants would pass an
	// `is_ok()` loop while silently unscoping (or over-scoping) a token.
	for (const table of ['version', 'grant_values', 'optional_null']) {
		for (const [index, row] of parity_rows(schema_fixture, table).entries()) {
			const accepted = parity_bool(row, 'accepted');
			const name = `${table}[${index}] ${accepted ? 'accepts' : 'refuses'}: ${JSON.stringify(row.document)}`;
			test(name, () => {
				const parsed = parse(FuzForgeTokenPolicy, row.document);
				assert.strictEqual(parsed.ok, accepted);
				if (!parsed.ok) return;
				const policy = parsed.value;
				const reads_f = policy_check(policy, { kind: 'files.read', filename: 'f' });
				if (table === 'version') {
					// Every accepted `version` row is the bare grant-less document.
					assert.deepStrictEqual(policy, DENY_ALL_POLICY);
				} else if (table === 'grant_values') {
					// Both accepted spellings — `true` and `{}` — grant `files.read` on `f`.
					assert.isTrue(reads_f);
				} else {
					// Absent-or-empty sections parse and grant nothing.
					assert.isFalse(reads_f);
				}
			});
		}
	}
	/**
	 * Both grant spellings round-trip unchanged — `{}` is not rewritten to
	 * `true`, so a document written by either backend re-serializes to the
	 * bytes it was stored as (the Rust twin is `grant_spellings_round_trip`).
	 */
	test('both grant spellings round-trip', () => {
		const doc: FuzForgeTokenPolicy = { version: 1, files: { read: { a: true, b: {} } } };
		assert.deepStrictEqual(parse_or_throw(FuzForgeTokenPolicy, doc), doc);
	});
	test('rejects unknown forge sub-keys (strict)', () => {
		const r = parse(FuzForgeTokenPolicy, { version: 1, forge: { fetch: '*' } });
		assert.strictEqual(r.ok, false);
	});
});

describe('policy_from_stored', () => {
	const silent_log = { error: () => {} };

	// The fail-closed read table is asserted against
	// `src/test/fixtures/parity/policy_from_stored.json`, which the Rust twin's
	// `policy_from_stored_fails_closed` reads too. Every unreadable spelling
	// lands on the deny-all document rather than on the unscoped case, which is
	// what a `null` would mean to `policy_check`. The fixture's `rust_only` row
	// is unparseable bytes: Rust reads `policy::text` and does its own parse,
	// while the TS driver hands the schema an already-parsed jsonb value.
	for (const row of parity_rows(stored_fixture, 'stored')) {
		const readable = parity_bool(row, 'accepted');
		test(`${readable ? 'parses through' : 'denies everything'}: ${JSON.stringify(row.document)}`, () => {
			const policy = policy_from_stored(row.document, 'tok_1', silent_log);
			const filename = typeof row.filename === 'string' ? row.filename : 'a.bin';
			assert.strictEqual(policy_check(policy, { kind: 'files.read', filename }), readable);
			if (!readable) assert.deepStrictEqual(policy, DENY_ALL_POLICY);
		});
	}

	test('an own __proto__ grant survives the read, as on the Rust twin', () => {
		const stored = JSON.parse('{"version":1,"files":{"read":{"__proto__":true}}}');
		const policy = policy_from_stored(stored, 'tok_1', silent_log);
		assert.strictEqual(policy, stored);
		assert.isTrue(policy_check(policy, { kind: 'files.read', filename: '__proto__' }));
		assert.isFalse(policy_check(policy, { kind: 'files.read', filename: 'a.bin' }));
	});

	test('the failure is reported to the log with the token id', () => {
		const messages: Array<unknown> = [];
		const policy = policy_from_stored({ version: 2 }, 'tok_loud', {
			error: (...args: Array<unknown>) => messages.push(args[0])
		});
		assert.deepStrictEqual(policy, DENY_ALL_POLICY);
		assert.strictEqual(messages.length, 1);
		assert.include(String(messages[0]), 'tok_loud');
	});
});

describe('policy_from_template', () => {
	test('admin returns null (no policy row)', () => {
		assert.strictEqual(policy_from_template({ kind: 'admin' }), null);
	});
	test('forge_push with explicit repos', () => {
		const p = policy_from_template({ kind: 'forge_push', repo_ids: ['alpha', 'beta'] });
		assert.deepStrictEqual(p, { version: 1, forge: { push: { alpha: true, beta: true } } });
	});
	test('forge_push de-dups duplicate repo ids', () => {
		const p = policy_from_template({ kind: 'forge_push', repo_ids: ['alpha', 'alpha'] });
		assert.deepStrictEqual(p, { version: 1, forge: { push: { alpha: true } } });
	});
	test('forge_pull mirrors forge_push under the pull key', () => {
		const p = policy_from_template({ kind: 'forge_pull', repo_ids: ['alpha'] });
		assert.deepStrictEqual(p, { version: 1, forge: { pull: { alpha: true } } });
	});
	test('files_read with "*" passes through', () => {
		const p = policy_from_template({ kind: 'files_read', filenames: '*' });
		assert.deepStrictEqual(p, { version: 1, files: { read: '*' } });
	});
	test('files_read with explicit filenames', () => {
		const p = policy_from_template({ kind: 'files_read', filenames: ['a.bin', 'b.bin'] });
		assert.deepStrictEqual(p, { version: 1, files: { read: { 'a.bin': true, 'b.bin': true } } });
	});
	test('files_write same shape, write key', () => {
		const p = policy_from_template({ kind: 'files_write', filenames: ['pinned.bin'] });
		assert.deepStrictEqual(p, { version: 1, files: { write: { 'pinned.bin': true } } });
	});
	test('rpc_subset', () => {
		const p = policy_from_template({ kind: 'rpc_subset', methods: ['fuz_forge_repo_log'] });
		assert.deepStrictEqual(p, { version: 1, rpc: { fuz_forge_repo_log: true } });
	});
	test('every policy-bearing template output parses cleanly with the schema', () => {
		// The seventh template, `admin`, is absent on purpose: it builds no policy
		// document at all (`policy_from_template` returns `null`, pinned by its own
		// case above), so there is nothing here for the schema to parse.
		const cases: Array<FuzForgeTokenTemplateInput> = [
			{ kind: 'forge_push', repo_ids: ['alpha'] },
			{ kind: 'forge_pull', repo_ids: ['alpha'] },
			{ kind: 'files_read', filenames: '*' },
			{ kind: 'files_read', filenames: ['a.bin'] },
			{ kind: 'files_write', filenames: ['pinned.bin'] },
			{ kind: 'files_read_write', filenames: '*' },
			{ kind: 'files_read_write', filenames: ['shared.bin'] },
			{ kind: 'rpc_subset', methods: ['fuz_forge_repo_log'] }
		];
		for (const t of cases) {
			const p = policy_from_template(t);
			assert.ok(p !== null);
			parse_or_throw(FuzForgeTokenPolicy, p); // throws on schema mismatch
		}
	});
});

describe('end-to-end: template → policy → check', () => {
	test('forge_push token allows push to listed repo only', () => {
		const policy = policy_from_template({ kind: 'forge_push', repo_ids: ['fuz_app'] });
		assert.strictEqual(policy_check(policy, { kind: 'forge.push', repo_id: 'fuz_app' }), true);
		assert.strictEqual(policy_check(policy, { kind: 'forge.push', repo_id: 'fuz_ui' }), false);
		// Doesn't grant pull or any other op.
		assert.strictEqual(policy_check(policy, { kind: 'forge.pull', repo_id: 'fuz_app' }), false);
	});
	/**
	 * A filename of exactly `__proto__` survives the template.
	 *
	 * `record['__proto__'] = true` invokes the `Object.prototype.__proto__`
	 * setter instead of defining an own property, and since `true` is not an
	 * object the setter silently no-ops — so keyed assignment dropped the grant
	 * and the token could not read the file it was minted for. `__proto__` passes
	 * `FILE_KEY_CHARSET`, so it was reachable, and Rust's `BTreeMap` stored it
	 * like any other key: a live TS↔Rust divergence rather than a hypothetical.
	 *
	 * Fails closed either way — the risk was a broken grant, not a leaked one —
	 * and the read side was never affected (`Object.hasOwn` doesn't walk the
	 * prototype). Pinned here because the fix is a build-shape detail
	 * (`Object.fromEntries`) that a later refactor could undo without noticing.
	 */
	test('a `__proto__` filename round-trips through the template', () => {
		const policy = policy_from_template({ kind: 'files_read', filenames: ['__proto__', 'a.bin'] });
		assert.ok(policy);
		// A **computed** key — `{__proto__: true}` in object-literal syntax sets
		// the prototype instead of defining an own property, the same trap the
		// builder had. `['__proto__']` defines it.
		assert.deepStrictEqual(policy, {
			version: 1,
			files: { read: { ['__proto__']: true, 'a.bin': true } }
		});
		assert.strictEqual(policy_check(policy, { kind: 'files.read', filename: '__proto__' }), true);
		// …and it grants only itself — the prototype is untouched, so an
		// unrelated filename is still denied.
		assert.strictEqual(policy_check(policy, { kind: 'files.read', filename: 'other' }), false);
	});

	test('files_read "*" token: every read passes, every write denied', () => {
		const policy = policy_from_template({ kind: 'files_read', filenames: '*' });
		assert.strictEqual(policy_check(policy, { kind: 'files.read', filename: 'a.bin' }), true);
		assert.strictEqual(policy_check(policy, { kind: 'files.write', filename: 'a.bin' }), false);
		assert.strictEqual(policy_check(policy, { kind: 'files.delete', filename: 'a.bin' }), false);
	});
});
