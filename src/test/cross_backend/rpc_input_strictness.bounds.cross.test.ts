/**
 * Cross-process **RPC input bounds parity** — run against BOTH fuz_forge
 * backends (TS/Hono + Rust `fuz_forge_server`).
 *
 * The declared-bounds half of the input contract — string lengths, list
 * counts, and numeric ranges — where the strict-object and strict-grammar
 * half is the sibling `rpc_input_strictness.shape.cross.test.ts`. A *value
 * grammar* is a shape, not a bound, so the mint's `'*' | string[]` selector
 * is pinned over there beside the key-shape case on the same template arm. A
 * bound is the class where the wrong answer is not a refusal but a quieter
 * *success*: a backend that clamps an out-of-range `limit` into range, or
 * hands the query an unbounded cursor, answers a 200 page the twin never
 * would.
 *
 * Every forge action input declares its bounds in its schema
 * (`src/lib/action_specs.ts`) and the TS dispatcher enforces them before the
 * handler runs. The Rust backend has no schema layer: its bounds are the
 * `handlers::input_bounds` checks run right after `fuz_http::parse_strict_params`,
 * and the spine's hand-decoded families re-check theirs in the typed optional
 * readers. Nothing else asserts the two agree — the generic round-trip suite
 * only ever sends in-bounds inputs.
 *
 * The contract, asserted identically on both backends:
 *
 *   - `limit` outside `1..=200` → `-32602` (rejected, never clamped), with the
 *     `1` and `200` edges reaching the lookup
 *   - the mint's `name` / `rpc_subset` / `files_read` bounds → `-32602` past
 *     the edge, each with the in-bounds neighbor minting
 *   - `repo_create`'s string bounds on each of its three fields, refused past
 *     the edge and admitted at it — `slug` at both edges, `default_branch` at
 *     its ceiling, `seed_from`'s ceiling as a clone failure (below)
 *   - the spine's hand-decoded numeric bounds
 *     (`role_grant_offer_history.limit` / `.offset`,
 *     `audit_log_list.since_seq`) → `-32602` rather than a clamped or
 *     unbounded page, with the inclusive edges reaching the query
 *
 * A rejection is worth only what its accepting neighbor proves: without one, a
 * backend that refused *every* value of the field would pass the negatives.
 * Every bound here carries one — `repo_log`'s `1` / `200` edges, the mint's
 * 80-character name, its 1- and 64-entry method lists and its 256-entry
 * filename list, `repo_create`'s floor and ceiling slugs and its 255-character
 * `default_branch`, and the hand-decoded inclusive edges.
 *
 * Two of those neighbors cost more than an assertion. The `repo_create` ones
 * are real creates, so they leave bare repos under the backend's tmp root
 * until the suite tears down (the same cost the other create suites pay), and
 * `seed_from`'s 2048-character ceiling has no successful shape at all: it is
 * spelled as an unreachable loopback URL, so the length bound admitting it is
 * visible as the `-32603` clone failure rather than a create.
 *
 * Only the code is pinned on the refusals: TS answers `invalid params` with
 * dev-only validation issues, Rust names the offending field, the same latitude
 * `repo_id_grammar.cross.test.ts` takes. The one message asserted here is the
 * clone failure's, which is a fixed twin constant carrying no detail
 * (`REPO_CREATE_SEED_FAILED_MESSAGE`) rather than a rendered validation
 * complaint.
 *
 * Integral floats (`limit: 50.0`, which an `integer` schema accepts) are not
 * reachable from here — JSON's one number type means a JS client cannot spell
 * `50.0` differently from `50`. That parity is unit-pinned on the Rust side in
 * `handlers::input_bounds`.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';

import { ABSENT_ID, INVALID_PARAMS, INTERNAL_ERROR, NOT_FOUND } from './rpc_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);

/**
 * Assert each freshly minted token id stored the policy row its template
 * implies, in one `fuz_forge_token_policy_list` read.
 *
 * The mint's echoed `template` cannot do this job: both backends hand back the
 * request's own discriminant (`input.template.kind` in
 * `server/routes/fuz_forge_token.ts`, `kind_str()` read before the arm is even
 * built in `handlers/token.rs`), so asserting it only restates what was sent.
 * The `fuz_forge_api_token_policy` row is the half the caller cannot fake: it
 * exists only if the mint reached its policy insert and the transaction
 * committed, so an accepting edge is proof the mint ran to completion on the
 * named arm, not merely that the value was not refused. The row stores the
 * full policy document, but the list read does not return it (the list
 * surface projects only the token id and the template kind), so whether the
 * list is *consumed* is pinned elsewhere — `rpc_scoped_token.cross.test.ts`
 * fires the method gate against a minted `rpc_subset`.
 */
const assert_stored_templates = async (
	fixture: Awaited<ReturnType<typeof setup_test>>,
	expected: Array<[string, string]>
): Promise<void> => {
	const listed = await rpc_call({
		app: fixture.transport,
		path: SPINE_RPC_PATH,
		method: 'fuz_forge_token_policy_list',
		params: {},
		headers: fixture.create_session_headers()
	});
	assert.isTrue(listed.ok, `policy list failed: ${JSON.stringify(listed)}`);
	const rows = (listed.result as { policies: Array<{ api_token_id: string; template: string }> })
		.policies;
	const stored = new Map(rows.map((row) => [row.api_token_id, row.template]));
	for (const [token_id, template] of expected) {
		assert.strictEqual(
			stored.get(token_id),
			template,
			`token ${token_id} must have stored a ${template} policy row, got ${stored.get(token_id)}`
		);
	}
};

describe('rpc input bounds (cross-process, both backends)', () => {
	test('repo_log rejects an out-of-range limit rather than clamping it', async () => {
		const fixture = await setup_test();
		for (const limit of [0, 201]) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_log',
				params: { id: ABSENT_ID, limit },
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `repo_log must reject limit=${limit}`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`repo_log limit=${limit} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}
	});

	test('repo_log accepts the limit ceiling — the bound is not over-tight', async () => {
		// A `limit` of exactly 200 is in bounds, so the request reaches the
		// lookup and fails on the absent repo instead. Without this the
		// rejection case above would still pass if a backend refused every
		// `limit`.
		const fixture = await setup_test();
		for (const limit of [1, 200]) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_log',
				params: { id: ABSENT_ID, limit },
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `repo_log on an absent repo must fail`);
			assert.strictEqual(
				res.error.code,
				NOT_FOUND,
				`repo_log limit=${limit} must reach the lookup, got ${res.error.code} (${res.error.message})`
			);
		}
	});

	test('the mint bounds its token name at 80 characters', async () => {
		const fixture = await setup_test();
		const too_long = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'n'.repeat(81),
				template: { kind: 'admin' },
				lifetime: { kind: 'eternal' }
			},
			headers: fixture.create_session_headers()
		});
		assert.isFalse(too_long.ok, 'an 81-character name must be refused');
		assert.strictEqual(too_long.error.code, INVALID_PARAMS);

		const at_ceiling = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'n'.repeat(80),
				template: { kind: 'admin' },
				lifetime: { kind: 'eternal' }
			},
			headers: fixture.create_session_headers()
		});
		assert.isTrue(at_ceiling.ok, `an 80-character name must mint: ${JSON.stringify(at_ceiling)}`);
	});

	test('the mint bounds the rpc_subset method list', async () => {
		const fixture = await setup_test();
		// `array(pipe(string, min_length(1)))` capped at 1..=64 — an empty list would
		// mint a token that grants nothing while reading as scoped. The 65-entry
		// row repeats one method on purpose: neither backend dedupes before it
		// counts (the policy doc's `new Set` and the spine scope's `BTreeSet`
		// both collapse the list *after* the bound), so a backend that
		// deduplicated first would mint this one. Same shape as
		// `repo_id_grammar.cross.test.ts`'s 65-entry `repo_ids` row.
		for (const methods of [[], [''], Array.from({ length: 65 }, () => 'fuz_forge_repo_list')]) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_token_create_scoped',
				params: {
					name: 'rpc_subset probe',
					template: { kind: 'rpc_subset', methods },
					lifetime: { kind: 'eternal' }
				},
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `mint must reject a ${methods.length}-entry method list`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`methods length ${methods.length} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}

		// The accepting neighbors, one per bound: a single method is the
		// `min(1)` floor and 64 is the `max(64)` ceiling, and both mint. Without
		// them a backend that refused *every* method list would pass the three
		// refusals above.
		const minted: Array<[string, string]> = [];
		for (const methods of [
			['fuz_forge_repo_list'],
			Array.from({ length: 64 }, () => 'fuz_forge_repo_list')
		]) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_token_create_scoped',
				params: {
					name: `rpc_subset ${methods.length} probe`,
					template: { kind: 'rpc_subset', methods },
					lifetime: { kind: 'eternal' }
				},
				headers: fixture.create_session_headers()
			});
			assert.isTrue(
				res.ok,
				`a ${methods.length}-entry method list must mint: ${JSON.stringify(res)}`
			);
			minted.push([(res.result as { id: string }).id, 'rpc_subset']);
		}
		// The stored policy rows, not the echoed discriminant — see
		// `assert_stored_templates`.
		await assert_stored_templates(fixture, minted);
	});

	test('the mint bounds the files_read filename list', async () => {
		const fixture = await setup_test();
		// `'*' | array(pipe(string, min_length(1)))` capped at 1..=256 — the wildcard is
		// unbounded, an explicit list is not.
		for (const filenames of [[], [''], Array.from({ length: 257 }, () => 'a.txt')]) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_token_create_scoped',
				params: {
					name: 'files_read probe',
					template: { kind: 'files_read', filenames },
					lifetime: { kind: 'eternal' }
				},
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `mint must reject a ${filenames.length}-entry filename list`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`filenames length ${filenames.length} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}

		// The accepting neighbor: 256 entries mint, so the 257 above is the
		// ceiling's doing and not a blanket refusal of every explicit list. The
		// entries repeat for the same reason the 257 row's do — the policy doc
		// dedupes only after the bound has counted the raw list.
		const at_ceiling = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'files_read ceiling probe',
				template: { kind: 'files_read', filenames: Array.from({ length: 256 }, () => 'a.txt') },
				lifetime: { kind: 'eternal' }
			},
			headers: fixture.create_session_headers()
		});
		assert.isTrue(
			at_ceiling.ok,
			`a 256-entry filename list must mint: ${JSON.stringify(at_ceiling)}`
		);
		await assert_stored_templates(fixture, [
			[(at_ceiling.result as { id: string }).id, 'files_read']
		]);
	});

	test('repo_create bounds its string fields', async () => {
		const fixture = await setup_test();
		// One character past the ceiling and otherwise *valid* — same loopback
		// shape as the accepting edge below, so the `-32602` can only be the
		// length bound. A string of filler (`'s'.repeat(2049)`) would be
		// refused by the URL grammar too, leaving the ceiling pinned from one
		// side only.
		const seed_over_ceiling = `https://127.0.0.1:1/${'x'.repeat(2029)}`;
		assert.strictEqual(seed_over_ceiling.length, 2049, 'the seed probe is one past the ceiling');
		const cases: Array<[string, Record<string, unknown>]> = [
			['slug under the 3-character floor', { slug: 'ab' }],
			['slug over the 129-character ceiling', { slug: `${'a'.repeat(65)}/${'b'.repeat(65)}` }],
			['empty default_branch', { slug: 'ttt/bounds', default_branch: '' }],
			[
				'default_branch over 255 characters',
				{ slug: 'ttt/bounds', default_branch: 'b'.repeat(256) }
			],
			['empty seed_from', { slug: 'ttt/bounds', seed_from: '' }],
			[
				'grammar-valid seed_from one character over the 2048 ceiling',
				{ slug: 'ttt/bounds', seed_from: seed_over_ceiling }
			]
		];
		for (const [label, params] of cases) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_create',
				params,
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `create must reject ${label}`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`${label} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}

		// The accepting edges. Each is a REAL create, so it leaves a bare repo
		// under the backend's tmp root until the suite tears down — the same
		// cost the other create suites pay, and the only way to prove a bound
		// admits its edge rather than refusing the whole field. Distinct slugs
		// per row, since a create that lands holds its `repos/<slug>` path.
		const accepted: Array<[string, Record<string, unknown>]> = [
			['slug at the 3-character floor', { slug: 'a/b' }],
			['slug at the 129-character ceiling', { slug: `${'a'.repeat(64)}/${'b'.repeat(64)}` }],
			[
				'default_branch at 255 characters',
				{ slug: 'ttt/branch-ceiling', default_branch: 'b'.repeat(255) }
			]
		];
		for (const [label, params] of accepted) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_create',
				params,
				headers: fixture.create_session_headers()
			});
			assert.isTrue(res.ok, `create must accept ${label}: ${JSON.stringify(res)}`);
		}

		// `seed_from`'s ceiling is the one edge no successful create can carry:
		// a 2048-character URL passes the length bound, the grammar and the
		// host gate (both cross spawns set
		// `FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS`), and then fails at
		// `git clone --bare` on the refused loopback connection — the
		// unreachable-seed technique of `repo_create_seed_from.cross.test.ts`.
		// The `-32603` is exactly what proves the bound admitted the value: a
		// backend whose bound was one character tighter answers `-32602` here
		// and never reaches git.
		const seed_at_ceiling = `https://127.0.0.1:1/${'x'.repeat(2028)}`;
		assert.strictEqual(seed_at_ceiling.length, 2048, 'the seed probe is at the ceiling');
		const seeded = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug: 'ttt/seed-ceiling', seed_from: seed_at_ceiling },
			headers: fixture.create_session_headers()
		});
		assert.isFalse(seeded.ok, `an unreachable seed must fail: ${JSON.stringify(seeded)}`);
		assert.strictEqual(
			seeded.error.code,
			INTERNAL_ERROR,
			`a 2048-character seed_from must reach the clone, got ${seeded.error.code} (${seeded.error.message})`
		);
		assert.strictEqual(
			seeded.error.message,
			'repo create failed: seed clone failed',
			'the failure must be the clone, not the bound'
		);
	});
});

describe('spine hand-decoded input bounds (cross-process, both backends)', () => {
	// The bound half of the hand-decoded contract. `as_i64` hands back whatever
	// integer it read, so a backend that decodes the field without re-checking
	// the twin's declared range clamps an out-of-range page into one — or hands
	// the query a predicate every row satisfies — where the twin answers
	// `-32602`. Reads only, so a passing row can't leave state behind.

	test('a hand-decoded input holds its declared numeric bounds', async () => {
		const fixture = await setup_test();
		const cases: Array<[string, Record<string, unknown>]> = [
			// `role_grant_offer_history.limit` is `.min(1).max(500)`: an
			// out-of-range page is refused rather than clamped into one.
			['role_grant_offer_history', { limit: 9999 }],
			['role_grant_offer_history', { offset: -1 }],
			// `audit_log_list.since_seq` is an integer with a floor of 0, so a
			// negative cursor is `-32602` where an unbounded read hands the
			// query a predicate every row satisfies — a full page.
			['audit_log_list', { since_seq: -1 }]
		];
		for (const [method, params] of cases) {
			const label = `${method} ${JSON.stringify(params)}`;
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method,
				params,
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `${label} must be refused`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`${label} must be -32602, got ${res.error.code} (${res.error.message})`
			);
		}

		// The controls: the bounds' inclusive edges all reach the query, so the
		// refusals above are the bound's doing and not a blanket rejection.
		for (const [method, params] of [
			['role_grant_offer_history', { limit: 1, offset: 0 }],
			['role_grant_offer_history', { limit: 500 }],
			['audit_log_list', { since_seq: 0 }]
		] as Array<[string, Record<string, unknown>]>) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method,
				params,
				headers: fixture.create_session_headers()
			});
			assert.ok(
				res.ok,
				`${method} ${JSON.stringify(params)} must reach the query: ${JSON.stringify(res)}`
			);
		}
	});
});
