/**
 * Cross-process repo-id **grammar rejection parity** — run against BOTH
 * fuz_forge backends (Deno/Hono + Rust `fuz_forge_server`).
 *
 * The forge has exactly one repo-id wire grammar: the TS `RepoId` schema
 * (fuz_app's `Uuid` grammar — RFC 9562 version 1-8 + variant nibbles, plus
 * nil and max, the max in any case) with the Rust twin
 * `fuz_forge_wire::is_valid_repo_id` enforced at every server id ingress.
 * This suite exists because the split grammar sat undetected for exactly as
 * long as no test asserted agreement on *rejection*: the other suites only
 * exercise valid ids and nil-id error
 * envelopes, and every real repo cell id is a Postgres `gen_random_uuid()`
 * v4 that passes any grammar. The probes here are the synthetic strings the
 * old grammars disagreed on — a version-0 near-nil id (Rust's
 * `Uuid::parse_str` accepted it, the schema 400'd) and the
 * non-hyphenated/braced/URN spellings `parse_str` admits.
 *
 * The contract, asserted identically on both backends:
 *
 *   - grammar-invalid `id` → `-32602` (invalid params) — TS enforces it at
 *     dispatch via the action spec, Rust at the handler's id ingress
 *   - grammar-valid but absent `id` (including nil/max) → `-32003`
 *     (not found)
 *   - the scoped-token mint's `repo_ids` follows the same grammar plus the
 *     `min(1)` bound (`FuzForgeTokenTemplateRepoIds` / the Rust
 *     `validate_repo_ids` twin) → `-32602`
 *
 * The second describe holds the **spine's** serde-typed UUID fields to the
 * same UUID grammar — `cell_get.id` and every element of
 * `cell_list.ids` — which is the identical class one layer down: a Rust input
 * struct declaring a `uuid::Uuid` decodes through the permissive
 * `Uuid::parse_str` unless the field says otherwise, so an off-grammar id
 * reaches the lookup and answers `-32003` on an ungated backend where the
 * twin answers `-32602`. They are mounted here rather than with the input
 * strictness suites because the grammar, not the input shape, is what they
 * pin. Their grammar is the repo id's: fuz_app's `Uuid`, the UUID grammar but for
 * the max UUID, which it takes in any case, as the spine's grammar and the
 * fuz_schema twin do.
 *
 * Messages are per-backend at this layer (TS says `invalid params` with
 * dev-only validation issues, Rust names the offending id — the same latitude
 * `parse_params` already takes), so parity is pinned on the code.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';

import { ABSENT_ID, HYPHENLESS_UUID, INVALID_PARAMS, NOT_FOUND } from './rpc_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);

/**
 * Strings the one grammar rejects. Every entry must come back `-32602`
 * from both backends. Kept in lockstep with the unit vectors in
 * `src/test/fuz_forge/repo/types.test.ts` and the Rust
 * `fuz_forge_wire::is_valid_repo_id` tests.
 */
const REJECTED_IDS = [
	// version-0 near-nil — the probe that exposed the split
	'00000000-0000-0000-0000-000000000001',
	// version nibble 9 (only 1-8 exist), variant nibble c (not [89abAB])
	'3f8a1c2e-1234-9abc-9def-0123456789ab',
	'3f8a1c2e-1234-4abc-cdef-0123456789ab',
	// spellings Uuid::parse_str/Postgres accept but the wire grammar doesn't
	HYPHENLESS_UUID,
	'{3f8a1c2e-1234-4abc-9def-0123456789ab}',
	'urn:uuid:3f8a1c2e-1234-4abc-9def-0123456789ab',
	// one digit off the max: a versioned UUID with version nibble F
	'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFE',
	// plain junk and a slug where an id belongs
	'not-a-uuid',
	'fuzdev/fuz_app'
];

/**
 * Strings the grammar accepts that name no repo. Every entry must come back
 * `-32003` from both backends — rejection parity is only meaningful if the
 * acceptance side agrees too.
 */
const ABSENT_IDS = [
	'00000000-0000-0000-0000-000000000000',
	'ffffffff-ffff-ffff-ffff-ffffffffffff',
	// the max in any case, where a bare lowercase-only UUID grammar would refuse an uppercase one
	'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
	'ffffffff-FFFF-ffff-FFFF-ffffffffffff',
	ABSENT_ID,
	'3F8A1C2E-1234-4ABC-9DEF-0123456789AB'
];

describe('repo id grammar (cross-process, both backends)', () => {
	test('grammar-invalid ids → -32602 on repo_get and repo_log', async () => {
		const fixture = await setup_test();
		for (const id of REJECTED_IDS) {
			for (const method of ['fuz_forge_repo_get', 'fuz_forge_repo_log']) {
				const res = await rpc_call({
					app: fixture.transport,
					path: SPINE_RPC_PATH,
					method,
					params: { id },
					headers: fixture.create_session_headers()
				});
				assert.isFalse(res.ok, `${method} must reject ${JSON.stringify(id)}`);
				assert.strictEqual(
					res.error.code,
					INVALID_PARAMS,
					`${method} ${JSON.stringify(id)} must be invalid params, got ${res.error.code} (${res.error.message})`
				);
			}
		}
	});

	test('grammar-valid absent ids → -32003 on repo_get and repo_log', async () => {
		const fixture = await setup_test();
		for (const id of ABSENT_IDS) {
			for (const method of ['fuz_forge_repo_get', 'fuz_forge_repo_log']) {
				const res = await rpc_call({
					app: fixture.transport,
					path: SPINE_RPC_PATH,
					method,
					params: { id },
					headers: fixture.create_session_headers()
				});
				assert.isFalse(res.ok, `${method} must not find ${JSON.stringify(id)}`);
				assert.strictEqual(
					res.error.code,
					NOT_FOUND,
					`${method} ${JSON.stringify(id)} must be not found, got ${res.error.code} (${res.error.message})`
				);
			}
		}
	});

	test('repo_commit resolves the repo before it judges the sha', async () => {
		// Ordering, not just codes: `fuz_forge_repo_commit` takes both an `id`
		// and a `sha`, and the two backends have to agree on which one loses
		// first. Rust used to guard `is_full_sha` ahead of the repo lookup, so
		// a bad id + bad sha answered `commit not found` where TS — which
		// validates the whole input, resolves the repo, and only then reads the
		// sha — answered `-32602` / `repo not found`. Both are input-shape
		// refusals, so nothing about which repos exist leaks either way; the
		// point is that a client sees the same diagnosis from both.
		const fixture = await setup_test();

		// The same two tables the grammar cases use, so the ordering pin can't
		// drift from the grammar pin.
		for (const id of REJECTED_IDS) {
			const invalid_id = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_commit',
				params: { id, sha: 'zzz' },
				headers: fixture.create_session_headers()
			});
			assert.isFalse(invalid_id.ok, `must reject ${JSON.stringify(id)}`);
			assert.strictEqual(
				invalid_id.error.code,
				INVALID_PARAMS,
				`a grammar-invalid id wins over a bad sha for ${JSON.stringify(id)}, got ${invalid_id.error.code} (${invalid_id.error.message})`
			);
		}

		for (const id of ABSENT_IDS) {
			const absent_repo = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_commit',
				params: { id, sha: 'zzz' },
				headers: fixture.create_session_headers()
			});
			assert.isFalse(absent_repo.ok, `must not find ${JSON.stringify(id)}`);
			assert.strictEqual(absent_repo.error.code, NOT_FOUND, JSON.stringify(id));
			assert.strictEqual(
				absent_repo.error.message,
				'repo not found',
				`an absent repo wins over a bad sha for ${JSON.stringify(id)}, got ${absent_repo.error.message}`
			);
		}
	});

	test('mint repo_ids follows the same grammar → -32602', async () => {
		const fixture = await setup_test();
		for (const id of REJECTED_IDS) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_token_create_scoped',
				params: {
					name: 'grammar probe',
					template: { kind: 'forge_push', repo_ids: [id] },
					lifetime: { kind: 'eternal' }
				},
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `mint must reject repo_ids [${JSON.stringify(id)}]`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`mint repo_ids ${JSON.stringify(id)} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}
	});

	test('mint rejects an empty repo_ids list → -32602 (min(1) bound)', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'empty probe',
				template: { kind: 'forge_push', repo_ids: [] },
				lifetime: { kind: 'eternal' }
			},
			headers: fixture.create_session_headers()
		});
		assert.isFalse(res.ok, 'mint must reject an empty repo_ids list');
		assert.strictEqual(res.error.code, INVALID_PARAMS);
	});

	test('mint rejects a 65-entry repo_ids list → -32602 (max(64) bound)', async () => {
		// Pins the upper bound behaviorally on both backends — the `64` is a
		// literal in the TS schema and the Rust `validate_repo_ids` twin, so
		// this is what keeps them from drifting apart.
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'oversize probe',
				template: {
					kind: 'forge_push',
					repo_ids: Array.from({ length: 65 }, () => ABSENT_ID)
				},
				lifetime: { kind: 'eternal' }
			},
			headers: fixture.create_session_headers()
		});
		assert.isFalse(res.ok, 'mint must reject a 65-entry repo_ids list');
		assert.strictEqual(res.error.code, INVALID_PARAMS);
	});

	test('mint accepts a grammar-valid id without checking existence', async () => {
		// The mint validates grammar, not existence — a nil-id policy mints
		// cleanly (and simply never matches a repo). Pinned so the two
		// backends agree on the acceptance side of the mint too.
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'nil-id token',
				template: { kind: 'forge_push', repo_ids: ['00000000-0000-0000-0000-000000000000'] },
				lifetime: { kind: 'eternal' }
			},
			headers: fixture.create_session_headers()
		});
		assert.isTrue(res.ok, `mint of a nil-id policy must succeed: ${JSON.stringify(res)}`);
	});
});

describe('spine UUID id fields (cross-process, both backends)', () => {
	// The same grammar one layer down, on the spine's own id fields rather than
	// the forge's. A Rust input struct declaring a `uuid::Uuid` decodes through
	// serde, i.e. `Uuid::parse_str`, which also takes the hyphenless / braced /
	// `urn:uuid:` spellings and any version+variant nibbles — so each field
	// carries `#[serde(deserialize_with = "fuz_http::deserialize_wire_uuid")]`
	// to hold it to the twin's grammar: the UUID grammar, but the max UUID in any
	// case, on both backends. The rejected spellings
	// overlap `REJECTED_IDS` above without being the same table: these rows are
	// the spine's, and they add the injection string the repo-id table has no
	// need for.

	test('a spine UUID input field takes only the UUID grammar, but the max UUID in any case', async () => {
		// `cell_get.id` is `optional(Uuid)` on the twin. On Rust it decodes
		// through `uuid::Uuid`'s own `Deserialize`, i.e. `Uuid::parse_str`,
		// which also takes the hyphenless / braced / `urn:uuid:` spellings and
		// any version+variant nibbles — so without a grammar in front of it
		// each of these reaches the lookup and answers `-32003` where the twin
		// answers `-32602`.
		const fixture = await setup_test();
		const refused = [
			HYPHENLESS_UUID,
			`{${ABSENT_ID}}`,
			`urn:uuid:${ABSENT_ID}`,
			'3f8a1c2e-1234-9abc-9def-0123456789ab', // version nibble outside 1..=8
			'3f8a1c2e-1234-4abc-1def-0123456789ab', // variant nibble outside [89ab]
			"' OR 1=1--"
		];
		for (const id of refused) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'cell_get',
				params: { id },
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `cell_get id ${JSON.stringify(id)} must be refused`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`cell_get id ${JSON.stringify(id)} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}

		// The controls: a grammar-valid id naming no cell reaches the lookup and
		// answers the 404, so the refusals above are the grammar's and not a
		// blanket rejection of the method. The uppercase and mixed-case max
		// are grammar-valid here, where a bare lowercase-only UUID grammar refuses them.
		const absent = [
			ABSENT_ID,
			'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
			'ffffffff-FFFF-ffff-FFFF-ffffffffffff'
		];
		for (const id of absent) {
			const control = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'cell_get',
				params: { id },
				headers: fixture.create_session_headers()
			});
			assert.isFalse(control.ok, `grammar-valid id ${JSON.stringify(id)} must reach the lookup`);
			assert.strictEqual(
				control.error.code,
				NOT_FOUND,
				`grammar-valid id ${JSON.stringify(id)} must answer the lookup 404, got ${control.error.code} (${control.error.message})`
			);
		}
	});

	test('every element of a spine UUID list is held to the same grammar', async () => {
		// `cell_list.ids` is `array(Uuid)` — the list shape, where a single
		// off-grammar element among valid ones is the interesting case: the
		// twin refuses the whole call, and a per-element-permissive backend
		// would answer an honest-looking page for the rest.
		const fixture = await setup_test();
		for (const ids of [[HYPHENLESS_UUID], [ABSENT_ID, HYPHENLESS_UUID], [1], [null]]) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'cell_list',
				params: { ids },
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `cell_list ids ${JSON.stringify(ids)} must be refused`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`cell_list ids ${JSON.stringify(ids)} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}

		const control = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'cell_list',
			params: { ids: [ABSENT_ID] },
			headers: fixture.create_session_headers()
		});
		assert.ok(
			control.ok,
			`a grammar-valid id list must reach the query: ${JSON.stringify(control)}`
		);
		assert.deepStrictEqual(control.result, { cells: [] });
	});
});
