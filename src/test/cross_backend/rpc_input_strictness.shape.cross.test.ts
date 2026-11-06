/**
 * Cross-process **RPC input shape parity** — run against BOTH fuz_forge
 * backends (Deno/Hono + Rust `fuz_forge_server`).
 *
 * The strict-object and strict-grammar half of the input contract: which keys
 * an input admits, which values a declared field's grammar admits, and what a
 * `null` means on an optional one — so the mint's `filenames` selector is
 * pinned here beside the key-shape case on the same template arm, its
 * `'*' | string[]` union being a grammar rather than a length. The *declared
 * bounds* — lengths, list counts, numeric ranges — are the sibling
 * `rpc_input_strictness.bounds.cross.test.ts`; the envelope's own `params`
 * contract and the `GET /api/rpc` transport contract are in
 * `protocol_actions_http.cross.test.ts`; and the serde-typed spine UUID
 * *fields* (`cell_get.id`, `cell_list.ids[]`) sit with the forge's own id
 * grammar in `repo_id_grammar.cross.test.ts`.
 *
 * Every forge action input is a `z.strictObject` (`src/lib/action_specs.ts`),
 * and the TS dispatcher enforces the whole schema before the handler runs. The
 * Rust backend has no schema layer: its inputs are serde structs, so the same
 * contract is carried by `#[serde(deny_unknown_fields)]` plus the
 * `handlers::input_bounds` checks — the selector one right after
 * `fuz_http::parse_strict_params`, whose `null` walk runs before its decode. Nothing else
 * asserts the two agree — the generic round-trip suite only ever sends
 * well-formed inputs, so a backend that silently drops an unrecognized key,
 * reads a `null` filter as "no filter", or answers a malformed selector with a
 * 404 would stay green.
 *
 * The contract, asserted identically on both backends:
 *
 *   - an unknown key on any input, top-level or nested in the mint's template
 *     arm (the `admin` arm included, which declares no field of its own) →
 *     `-32602` (invalid params)
 *   - the **value** grammar on that same template arm — the mint's
 *     `filenames` selector is `z.union([z.literal('*'), z.array(...)])`, so a
 *     bare string that isn't `'*'` is the `-32602`/400 of a dispatch failure
 *     and never the `-32005`/422 a handler-side `validation_error` would
 *     give, with `'*'` itself as the control that keeps the wildcard reachable
 *   - `id` and `slug` both set, or neither → `-32602`, not `-32003`
 *   - a `null` on an optional key → `-32602`; no forge input is `.nullable()`,
 *     so `.optional()` admits an absent key and nothing else
 *   - the spine's hand-decoded **`Uuid` param** (`admin_session_revoke_all`'s
 *     `account_id`) and the dispatcher's own **`acting` selector**, on any
 *     spec, held to the `z.uuid()` grammar — with the two orderings that go
 *     with the selector: a grammar-valid foreign one is the actor denial
 *     rather than the grammar one, and the authority gates answer before
 *     either
 *   - the spine's two **branded id grammars** on the account family —
 *     `account_token_revoke.token_id` (`ApiTokenId`) and
 *     `account_session_revoke.session_id` (`SessionId`) — → `-32602`, with a
 *     grammar-valid-but-absent id reaching the lookup as the honest
 *     `{ok: true, revoked: false}`. These are mutations, so an ungated
 *     backend answers a **success envelope** for input the twin refuses,
 *     which is the one shape a client can't tell from a real no-op
 *   - a `null` on a spine optional key — the same `.optional()`-refuses-null
 *     divergence the forge's own inputs carry, closed for both by
 *     `fuz_http::parse_strict_params`
 *   - a **`z.void()`-input** method (`account_session_list`) refusing a
 *     declared key, while an absent `params` and a `{}` are both the call
 *   - `peer/ping` refusing an **undeclared `acting` key**: the dispatcher's
 *     `acting` gate judges the value, so only the input's own strictness
 *     refuses a well-formed selector on a spec that declares no such field
 *   - the `fuz_auth` **hand-decoded** families (`admin_*` / `role_grant_*` /
 *     `account_*`), whose `params.get` chains ignore a key nothing looks for
 *     and read a present wrong-typed optional as absent, plus the one mounted
 *     key whose twin is `.optional()` rather than `.nullish()`
 *   - the spine's three **`acting`-only admin reads** (`admin_session_list` and
 *     its two siblings) — `z.strictObject({acting}).default({})` on the twin,
 *     so an unknown key and a `null` selector are `-32602` while `{}` and an
 *     absent `params` are the call
 *   - the one **flat-REST** row, `POST /api/account/password` with an unknown
 *     body key → `400 invalid_request_body`: the same strict-object contract
 *     one transport over, mirroring fuz_app's own signup row
 *   - the spine's **fact-hash grammar** on `cell_list.ref` (`FactHashSchema`,
 *     `^blake3:[0-9a-f]{64}$`) → `-32602`, with a grammar-valid address
 *     reaching the query as an empty page. A read, so the divergence is
 *     quieter than the mutations above — an ungated backend runs the filter
 *     and answers an honest-looking empty list for an address the twin
 *     refuses
 *
 * Only the code is pinned: TS answers `invalid params` with dev-only zod
 * issues, Rust names the offending field, the same latitude
 * `repo_id_grammar.cross.test.ts` takes.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { JSONRPC_VERSION } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';
import { create_test_request_headers } from '@fuzdev/fuz_app/testing/test_origin.ts';

import {
	ABSENT_ID,
	HYPHENLESS_UUID,
	INVALID_PARAMS,
	INVALID_REQUEST,
	BAD_REQUEST,
	NOT_FOUND,
	FORBIDDEN,
	post_rpc_session
} from './rpc_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);

/** Grammar-valid v4 that is an actor on no account under test. */
const FOREIGN_ACTOR_UUID = '11111111-1111-4111-8111-111111111111';

/**
 * Grammar-valid `ApiTokenId` (`^tok_[A-Za-z0-9_-]{12}$`) naming no token —
 * the positive control that isolates the grammar gate from the lookup.
 */
const ABSENT_TOKEN_ID = 'tok_abC0_d-3xyzA';

/**
 * Grammar-valid `SessionId` (64 lowercase hex) naming no session. Not a real
 * digest, so revoking it can't cut the fixture's own session out from under
 * the rest of the suite.
 */
const ABSENT_SESSION_ID = 'a'.repeat(64);

/**
 * Grammar-valid `FactHashSchema` address (`blake3:` + 64 lowercase hex) that
 * no cell references — the positive control isolating the grammar gate from
 * the query.
 */
const ABSENT_FACT_HASH = `blake3:${'b'.repeat(64)}`;

/**
 * The `error.data` the **role** gate emits, byte-identical on both backends —
 * distinct from the credential (`credential_type_required`) and scope
 * (`token_scope_required`) denials that share the code.
 */
const ROLE_DENIAL_DATA = { reason: 'insufficient_permissions', required_roles: ['admin'] };

describe('rpc input strictness (cross-process, both backends)', () => {
	test('an unknown key is rejected on every input shape', async () => {
		const fixture = await setup_test();
		// One probe per input *shape*: the no-required-field default
		// (`repo_list`), the xor selector (`repo_get`), the id-keyed read
		// (`repo_log`), the create body, and the mint.
		const cases: Array<[string, Record<string, unknown>]> = [
			['fuz_forge_repo_list', { unknown_key: 'x' }],
			['fuz_forge_repo_get', { id: ABSENT_ID, unknown_key: 'x' }],
			['fuz_forge_repo_log', { id: ABSENT_ID, unknown_key: 'x' }],
			['fuz_forge_repo_create', { slug: 'ttt/strict', unknown_key: 'x' }],
			[
				'fuz_forge_token_create_scoped',
				{
					name: 'strictness probe',
					template: { kind: 'admin' },
					lifetime: { kind: 'eternal' },
					unknown_key: 'x'
				}
			]
		];
		for (const [method, params] of cases) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method,
				params,
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `${method} must reject an unknown key`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`${method} unknown key must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}
	});

	test('an unknown key nested in the mint template is rejected', async () => {
		// The template is a discriminated union of strict objects, so the
		// strictness has to reach inside the arm, not just the top level. The
		// `admin` arm is the load-bearing one: it declares no field of its own,
		// so a backend whose strictness doesn't reach a fieldless arm would
		// accept this body and mint a FULL-ADMIN token from it.
		const fixture = await setup_test();
		const templates: Array<Record<string, unknown>> = [
			{ kind: 'admin', filenames: ['a.txt'] },
			{ kind: 'admin', unknown_key: 'x' },
			{ kind: 'rpc_subset', methods: ['fuz_forge_repo_list'], unknown_key: 'x' },
			{ kind: 'files_read', filenames: '*', unknown_key: 'x' }
		];
		for (const template of templates) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_token_create_scoped',
				params: {
					name: 'nested probe',
					template,
					lifetime: { kind: 'eternal' }
				},
				headers: fixture.create_session_headers()
			});
			assert.isFalse(
				res.ok,
				`mint must reject ${JSON.stringify(template)} — an unknown key inside the template arm`
			);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`${JSON.stringify(template)} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}
	});

	test('a malformed filenames selector is invalid params, not a validation error', async () => {
		// `z.union([z.literal('*'), z.array(...)])` lives inside the input
		// schema, so a bare string that isn't `'*'` fails at dispatch — the
		// `-32602`/400 envelope, never the `-32005`/422 a handler-side
		// `validation_error` would give. The value-shape half of the case
		// above: same template arm, judged on what its `filenames` field
		// *says* rather than on which keys the arm carries.
		const fixture = await setup_test();
		for (const filenames of ['all', '', '**']) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_token_create_scoped',
				params: {
					name: 'selector probe',
					template: { kind: 'files_read', filenames },
					lifetime: { kind: 'eternal' }
				},
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `mint must reject filenames=${JSON.stringify(filenames)}`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`filenames=${JSON.stringify(filenames)} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}

		// The control the grammar needs: `'*'` is the one bare string the union
		// admits, and it mints. Without it a backend that refused every string
		// `filenames` — leaving the wildcard unreachable and every file token
		// list-only — would pass the three refusals above.
		const wildcard = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_token_create_scoped',
			params: {
				name: 'wildcard selector probe',
				template: { kind: 'files_read', filenames: '*' },
				lifetime: { kind: 'eternal' }
			},
			headers: fixture.create_session_headers()
		});
		assert.isTrue(wildcard.ok, `filenames='*' must mint: ${JSON.stringify(wildcard)}`);
		assert.strictEqual(
			(wildcard.result as { template: string }).template,
			'files_read',
			"filenames='*' must mint the files_read template"
		);
	});

	test('a null on an optional key is rejected, not read as absent', async () => {
		// No forge input field is `.nullable()`, so zod's `.optional()` refuses
		// `null` outright. Serde's `Option<T>` would map it to `None`, making
		// `{ref: null}` read as "no ref" on Rust and answer 200 where TS 400s.
		const fixture = await setup_test();
		const cases: Array<[string, Record<string, unknown>]> = [
			['fuz_forge_repo_log', { id: ABSENT_ID, ref: null }],
			['fuz_forge_repo_log', { id: ABSENT_ID, limit: null }],
			['fuz_forge_repo_get', { id: null, slug: 'ttt/absent' }],
			['fuz_forge_repo_list', { acting: null }],
			['fuz_forge_repo_list', { slug_prefix: null }],
			['fuz_forge_repo_create', { slug: 'ttt/nullprobe', seed_from: null }]
		];
		for (const [method, params] of cases) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method,
				params,
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `${method} must reject ${JSON.stringify(params)}`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`${method} ${JSON.stringify(params)} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}
	});

	test('the id/slug selector takes exactly one — both or neither is -32602', async () => {
		const fixture = await setup_test();
		const malformed: Array<Record<string, unknown>> = [{ id: ABSENT_ID, slug: 'ttt/absent' }, {}];
		// `repo_get` and the two mutations share one selector schema
		// (`FuzForgeRepoMutationInput`), so all three must answer alike.
		for (const method of [
			'fuz_forge_repo_get',
			'fuz_forge_repo_resync',
			'fuz_forge_repo_rotate_secret'
		]) {
			for (const params of malformed) {
				const res = await rpc_call({
					app: fixture.transport,
					path: SPINE_RPC_PATH,
					method,
					params,
					headers: fixture.create_session_headers()
				});
				assert.isFalse(res.ok, `${method} must reject ${JSON.stringify(params)}`);
				assert.strictEqual(
					res.error.code,
					INVALID_PARAMS,
					`${method} ${JSON.stringify(params)} must be invalid params, got ${res.error.code} (${res.error.message})`
				);
			}
		}
	});

	test('a spine UUID param takes only the z.uuid() grammar', async () => {
		// The spine's own decoders, one layer below the forge's inputs. TS
		// declares `account_id: Uuid` (`z.uuid()`); Rust reads it through
		// `fuz_http::parse_uuid_param`, which gates on the grammar twin
		// `fuz_http::is_valid_uuid` before handing the string to
		// `Uuid::parse_str`. Without that gate the permissive Rust parser took
		// the hyphenless, braced and URN spellings and a bad version/variant
		// nibble, so the same body was `-32602` on TS and a lookup (a `-32003`
		// miss, or worse a hit) on Rust.
		//
		// `admin_session_revoke_all` is the probe: mounted on both backends,
		// admin-gated over the keeper session, and its only param is a `Uuid`.
		const fixture = await setup_test();
		for (const account_id of [
			HYPHENLESS_UUID,
			`{${ABSENT_ID}}`,
			`urn:uuid:${ABSENT_ID}`,
			// Variant nibble `1` — the all-ones id fixtures reach for is not a
			// `z.uuid()`, unlike the v4-shaped `FOREIGN_ACTOR_UUID`.
			'11111111-1111-1111-1111-111111111111'
		]) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'admin_session_revoke_all',
				params: { account_id },
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `must reject account_id=${account_id}`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`account_id=${account_id} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}

		// The control the negatives need: a grammar-valid id gets past the
		// param decode and lands on the account lookup, so the rejections
		// above are the grammar's doing and not a blanket refusal.
		const control = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'admin_session_revoke_all',
			params: { account_id: ABSENT_ID },
			headers: fixture.create_session_headers()
		});
		assert.isFalse(control.ok, 'the control id names no account');
		// The whole envelope, which is byte-identical on both backends here —
		// so the control pins the not-found shape as well as the phase.
		assert.strictEqual(
			control.error.code,
			NOT_FOUND,
			`a well-formed absent id must reach the lookup, got ${control.error.code} (${control.error.message})`
		);
		assert.strictEqual(control.error.message, 'account not found');
		assert.deepStrictEqual(control.error.data, { reason: 'account_not_found' });
	});

	test('the acting selector takes only the z.uuid() grammar, on any spec', async () => {
		// `acting` is the one input the *dispatcher* owns, and the two spines
		// reach the same refusal by different routes: TS reads a malformed
		// selector as omitted and then its typed input schema (`ActingActor` =
		// `Uuid.optional()`) refuses the value, while the Rust dispatcher — which
		// has no schema layer — validates a present `acting` against the grammar
		// twin `fuz_http::is_valid_uuid` before the authorization phase.
		//
		// Reading it as omitted without the second step is *worse* than a
		// permissive parse: on an actor-axis spec the resolver would fall back to
		// the caller's sole actor and the call would succeed. So the read is
		// pinned on both a read and a **mutation**, and the mutation case checks
		// the repo count too — a 200 here would have created a repo.
		const fixture = await setup_test();
		const before = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_list',
			params: {},
			headers: fixture.create_session_headers()
		});
		assert.isTrue(before.ok, 'baseline list');
		const before_count = (before.result as { repos: Array<unknown> }).repos.length;

		for (const [method, params] of [
			['fuz_forge_repo_list', { acting: HYPHENLESS_UUID }],
			['fuz_forge_repo_create', { slug: 'acting/grammar', acting: HYPHENLESS_UUID }]
		] as Array<[string, Record<string, unknown>]>) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method,
				params,
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `${method} must reject a hyphenless acting`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`${method} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}

		const after = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_list',
			params: {},
			headers: fixture.create_session_headers()
		});
		assert.isTrue(after.ok, 'list after the refused create');
		assert.strictEqual(
			(after.result as { repos: Array<unknown> }).repos.length,
			before_count,
			'a refused create must not have landed'
		);
	});

	test('a grammar-valid foreign acting is the actor denial, not the grammar one', async () => {
		// The control the case above needs: past the grammar, the selector
		// reaches the resolver and gets the spine's actor denial — same code,
		// different body — so the rejections above are the grammar's doing.
		// Message and `data` are byte-identical on both backends here.
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_list',
			params: { acting: FOREIGN_ACTOR_UUID },
			headers: fixture.create_session_headers()
		});
		assert.isFalse(res.ok, 'a foreign actor must be refused');
		assert.strictEqual(res.error.code, INVALID_PARAMS);
		assert.strictEqual(res.error.message, 'actor_not_on_account');
		assert.deepStrictEqual(res.error.data, { reason: 'actor_not_on_account' });
	});

	test('the authority gates answer before the acting grammar does', async () => {
		// Ordering, not grammar. The dispatcher validates `acting` **after** the
		// credential / scope / role gates on both backends, so a caller the role
		// gate refuses gets the 403 and never learns the input's shape — a 400
		// describing a field to someone who may not call the method at all would
		// confirm the method exists and hint at its schema.
		//
		// The Rust port originally validated before the gates, which answered
		// `-32602` here where the twin answers `-32002`; this case is that
		// regression's tripwire, and it is why `read_acting` reads a malformed
		// selector as omitted rather than refusing it outright.
		//
		// The principal is minted the way production mints one —
		// `create_account()` with the default `roles: []`, through invite →
		// signup → login — so the role gate is the only thing that can refuse it.
		const fixture = await setup_test();
		const account = await fixture.create_account();

		const with_bad_acting = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_list',
			params: { acting: HYPHENLESS_UUID },
			headers: account.create_session_headers()
		});
		assert.isFalse(with_bad_acting.ok, 'a roleless caller is refused');
		assert.strictEqual(
			with_bad_acting.error.code,
			FORBIDDEN,
			`the role gate must answer first, got ${with_bad_acting.error.code} (${with_bad_acting.error.message})`
		);
		// `data` names which authority gate answered, and is byte-identical on
		// both backends — so a credential-type or token-scope 403 (same code,
		// different `reason`) cannot masquerade as the role gate here.
		// TODO: once forge's fuz_app has the role gate's `forbidden` message (it
		// says `requires role: admin` before that change), assert the message too.
		assert.deepStrictEqual(with_bad_acting.error.data, ROLE_DENIAL_DATA);

		// The control: the same account with nothing for the grammar to judge
		// gets the same 403, so the answer above is the role gate's and not some
		// other refusal the malformed selector happened to trigger.
		const clean = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_list',
			params: {},
			headers: account.create_session_headers()
		});
		assert.isFalse(clean.ok, 'a roleless caller is refused with a clean input too');
		assert.strictEqual(clean.error.code, FORBIDDEN);
		assert.deepStrictEqual(clean.error.data, ROLE_DENIAL_DATA);
	});
});

describe('spine branded wire grammars (cross-process, both backends)', () => {
	// The account family's two revoke mutations take branded string ids —
	// `ApiTokenId` and `SessionId` on the twin — and neither is a UUID, so the
	// dispatcher's `acting` grammar and the forge's own `is_valid_repo_id` both
	// miss them. Their lookups are parameterized and account-scoped, so an
	// off-grammar id is a guaranteed miss either way; what is not harmless is
	// the *envelope*, since a miss is reported as `{ok: true, revoked: false}`
	// — a success shape for a request that was never well-formed, which a
	// client cannot tell from a real no-op. Both backends gate the grammar
	// first so the refusal is `-32602` on either.

	test('account_token_revoke takes only the ApiTokenId grammar', async () => {
		const fixture = await setup_test();
		const refused = [
			'', // empty
			'abC0_d-3xyzA', // no prefix
			'TOK_abC0_d-3xyzA', // wrong-case prefix
			'tok_abC0_d-3xyz', // one char short
			'tok_abC0_d-3xyzAB', // one char long
			'tok_abC0+d-3xyzA', // base64, not base64url
			ABSENT_ID, // a UUID — the id shape a confused client reaches for
			"' OR 1=1--"
		];
		for (const token_id of refused) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'account_token_revoke',
				params: { token_id },
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `token_id ${JSON.stringify(token_id)} must be refused`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`token_id ${JSON.stringify(token_id)} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}

		// The control: a grammar-valid id naming no token reaches the lookup and
		// answers the honest no-op, so the refusals above are the grammar's and
		// not a blanket rejection of the method.
		const control = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'account_token_revoke',
			params: { token_id: ABSENT_TOKEN_ID },
			headers: fixture.create_session_headers()
		});
		assert.ok(control.ok, `a grammar-valid id must reach the lookup: ${JSON.stringify(control)}`);
		assert.deepStrictEqual(control.result, { ok: true, revoked: false });
	});

	test('account_session_revoke takes only the SessionId grammar', async () => {
		const fixture = await setup_test();
		const refused = [
			'',
			'a'.repeat(63),
			'a'.repeat(65),
			'A'.repeat(64), // uppercase hex — the twin's regex has no `i` flag
			'g'.repeat(64), // right length, outside hex
			ABSENT_ID,
			"' OR 1=1--"
		];
		for (const session_id of refused) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'account_session_revoke',
				params: { session_id },
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `session_id ${JSON.stringify(session_id)} must be refused`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`session_id ${JSON.stringify(session_id)} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}

		const control = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'account_session_revoke',
			params: { session_id: ABSENT_SESSION_ID },
			headers: fixture.create_session_headers()
		});
		assert.ok(control.ok, `a grammar-valid id must reach the lookup: ${JSON.stringify(control)}`);
		assert.deepStrictEqual(control.result, { ok: true, revoked: false });
	});

	test('cell_list ref takes only the FactHashSchema grammar', async () => {
		const fixture = await setup_test();
		const refused = [
			'', // empty
			'a'.repeat(64), // bare hex, no algorithm prefix
			`blake3:${'A'.repeat(64)}`, // uppercase hex — the twin's regex has no `i` flag
			`sha256:${'a'.repeat(64)}`, // a different algorithm token
			`blake3:${'a'.repeat(63)}`, // one short
			`blake3:${'a'.repeat(65)}`, // one long
			ABSENT_ID, // a UUID — a cell id, not a fact address
			"' OR 1=1--"
		];
		for (const ref of refused) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'cell_list',
				params: { ref },
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `ref ${JSON.stringify(ref)} must be refused`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`ref ${JSON.stringify(ref)} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}

		// The control: a grammar-valid address referencing nothing reaches the
		// query and answers an empty page, so the refusals above are the
		// grammar's and not a blanket rejection of the filter.
		const control = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'cell_list',
			params: { ref: ABSENT_FACT_HASH },
			headers: fixture.create_session_headers()
		});
		assert.ok(control.ok, `a grammar-valid ref must reach the query: ${JSON.stringify(control)}`);
		assert.deepStrictEqual(control.result, { cells: [] });
	});
});

describe('spine input strictness (cross-process, both backends)', () => {
	// The forge's own inputs are covered above; these are the *spine's*,
	// mounted here because fuz_forge is the ecosystem's cross-backend consumer
	// and the spine has no dual-backend harness of its own. Each row is a
	// place serde is structurally more permissive than the TS schema unless
	// the field says otherwise — not a grammar the handlers reimplement, but
	// one the decode gives away for free.

	test('a null on a spine optional key is rejected, not read as absent', async () => {
		// Zod's `.optional()` admits an absent key and nothing else; serde maps
		// `null` onto `None`, so without the walk each of these reads as "no
		// filter" on Rust and answers a 200 page for a request the twin
		// refuses.
		const fixture = await setup_test();
		for (const params of [
			{ ids: null },
			{ limit: null },
			{ created_by: null },
			{ kind: null },
			{ acting: null }
		]) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'cell_list',
				params,
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `cell_list ${JSON.stringify(params)} must be refused`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`cell_list ${JSON.stringify(params)} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}

		// The control: the same keys absent is the unfiltered call.
		const control = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'cell_list',
			params: {},
			headers: fixture.create_session_headers()
		});
		assert.ok(control.ok, `an empty filter must reach the query: ${JSON.stringify(control)}`);
	});

	test('a void-input method reads absent and {} params as the call and refuses a declared key', async () => {
		// `account_session_list`'s input is `z.void()`. An absent `params` and
		// a `{}` both carry no parameters — JSON-RPC 2.0 lets `params` be
		// omitted, and fuz_app's socket client sends `{}` for a parameterless
		// request — so both spines read either as the no-arg call. Rust's
		// dispatcher holds a void method to the twin through its spec's
		// `InputShape::Void` check, refusing a declared key before the handler
		// runs. Sent as hand-built envelopes so the `params` shape on the wire is
		// exact.
		const fixture = await setup_test();
		const refused = await post_rpc_session(fixture, {
			jsonrpc: JSONRPC_VERSION,
			id: 'test',
			method: 'account_session_list',
			params: { nope: 1 }
		});
		assert.isUndefined(
			refused.body.result,
			'a void input must refuse a declared key, got a result'
		);
		assert.strictEqual(
			refused.body.error?.code,
			INVALID_PARAMS,
			`a void input must refuse a declared key with -32602, got ${refused.body.error?.code} (${refused.body.error?.message})`
		);
		assert.strictEqual(refused.status, BAD_REQUEST, 'a declared key must answer HTTP 400');

		for (const params of [undefined, {}]) {
			const label = params ? '{}' : 'an absent params';
			const { status, body } = await post_rpc_session(fixture, {
				jsonrpc: JSONRPC_VERSION,
				id: 'test',
				method: 'account_session_list',
				...(params && { params })
			});
			assert.isUndefined(
				body.error,
				`${label} must be the call, got ${body.error?.code} (${body.error?.message})`
			);
			assert.strictEqual(status, 200, `${label} must answer HTTP 200, got ${status}`);
			assert.isArray(
				(body.result as { sessions?: unknown } | undefined)?.sessions,
				`${label} must answer the session list, got ${JSON.stringify(body.result)}`
			);
		}
	});

	test('peer/ping refuses an undeclared acting key', async () => {
		// `PingActionInput` is `z.strictObject({nonce?, timeout_ms?})` — no
		// `acting`, because the spec is `auth: public` and has no actor axis.
		// The dispatcher's `acting` gate judges only the *value*, so a
		// well-formed v4 passes it and only the input's own strictness refuses
		// the key. Over HTTP a well-formed ping is the `-32600
		// peer_no_transport` refusal, which is the control: a different code,
		// so the `-32602` below is the key's and not the transport's.
		const fixture = await setup_test();
		const refused = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'peer/ping',
			params: { nonce: 1, acting: FOREIGN_ACTOR_UUID },
			headers: fixture.create_session_headers()
		});
		assert.isFalse(refused.ok, 'peer/ping must refuse an undeclared acting key');
		assert.strictEqual(
			refused.error.code,
			INVALID_PARAMS,
			`peer/ping acting must be invalid params, got ${refused.error.code} (${refused.error.message})`
		);

		const control = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'peer/ping',
			params: { nonce: 1 },
			headers: fixture.create_session_headers()
		});
		assert.isFalse(control.ok, 'peer/ping over HTTP has no return transport');
		assert.strictEqual(
			control.error.code,
			INVALID_REQUEST,
			`a declared-key ping must reach the handler, got ${control.error.code} (${control.error.message})`
		);
	});
});

describe('spine hand-decoded input strictness (cross-process, both backends)', () => {
	// The `fuz_auth` action families (`admin_*`, `role_grant_*`, `account_*`)
	// decode their params by hand — `params.get(..)` chains that surface a
	// per-field `data.reason` a serde struct could not carry. The chain is
	// blind in two ways the twin's `z.strictObject` is not: a key nothing
	// looks for is ignored, and a present-but-wrong-typed optional reads as
	// absent. `fuz_http::reject_unknown_keys` + the typed optional readers
	// close both, so these rows answer `-32602` on each backend where an
	// ungated one answers a 200 page or an honest-looking success envelope.

	test('a hand-decoded spine input refuses an undeclared key', async () => {
		const fixture = await setup_test();
		// One probe per family, each with the control its negative needs — the
		// same params minus the stray key, which must still reach the handler.
		const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
			// admin, id-keyed mutation: without the gate the stray key is
			// ignored and the request reaches the account lookup (-32003).
			['admin_session_revoke_all', { account_id: ABSENT_ID, nope: 'x' }, { account_id: ABSENT_ID }],
			// admin, filtered read: without the gate it answers a 200 page.
			['audit_log_list', { nope: 'x' }, {}],
			// role_grant_offer, defaulted read: same shape.
			['role_grant_offer_list', { nope: 'x' }, {}],
			// account, branded-id mutation: without the gate it answers the
			// `{ok: true, revoked: false}` success envelope.
			[
				'account_token_revoke',
				{ token_id: ABSENT_TOKEN_ID, nope: 'x' },
				{ token_id: ABSENT_TOKEN_ID }
			]
		];
		for (const [method, refused, control] of cases) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method,
				params: refused,
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `${method} must refuse an undeclared key`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`${method} unknown key must be -32602, got ${res.error.code} (${res.error.message})`
			);

			const reached = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method,
				params: control,
				headers: fixture.create_session_headers()
			});
			assert.notStrictEqual(
				reached.ok ? undefined : reached.error.code,
				INVALID_PARAMS,
				`${method} must reach the handler without the stray key, got ${JSON.stringify(reached)}`
			);
		}
	});

	test('a hand-decoded spine input refuses an acting key it does not declare', async () => {
		// The biconditional: the account family is `actor: 'none'` on both
		// spines, so its twin inputs declare no `acting` and a well-formed
		// selector is an unrecognized key. The dispatcher's own selector gate
		// judges only the *value*, so a grammar-valid uuid passes it and only
		// the input's strictness refuses the key — which is why the control
		// below is a success envelope rather than a different error.
		const fixture = await setup_test();
		const cases: Array<[string, Record<string, unknown>]> = [
			['account_token_revoke', { token_id: ABSENT_TOKEN_ID }],
			['account_session_revoke', { session_id: ABSENT_SESSION_ID }]
		];
		for (const [method, params] of cases) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method,
				params: { ...params, acting: FOREIGN_ACTOR_UUID },
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `${method} must refuse an undeclared acting key`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`${method} acting must be -32602, got ${res.error.code} (${res.error.message})`
			);

			const control = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method,
				params,
				headers: fixture.create_session_headers()
			});
			assert.ok(control.ok, `${method} without acting must reach the lookup`);
			assert.deepStrictEqual(
				control.result,
				{ ok: true, revoked: false },
				`${method} must answer the honest no-op, got ${JSON.stringify(control.result)}`
			);
		}
	});

	test('a wrong-typed optional on a hand-decoded input is refused, not read as absent', async () => {
		// `and_then(Value::as_str)` / `as_bool` / `as_i64` return `None` for a
		// present wrong type exactly as they do for a missing key, so an
		// ungated backend answers a 200 page with the filter silently dropped
		// where the twin's `z.string()` / `z.boolean()` / `z.number().int()`
		// answers `-32602`. Reads only, so a passing row can't leave state
		// behind.
		const fixture = await setup_test();
		const cases: Array<[string, Record<string, unknown>]> = [
			// `.nullish()` string filter read through `as_str`.
			['audit_log_list', { event_type: 42 }],
			// `.nullish()` boolean flag read through `as_bool`.
			['admin_account_list', { include_deleted: 'yes' }],
			// `.nullish()` integer read through `as_i64`.
			['role_grant_offer_history', { limit: 'ten' }]
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

		// The controls: the same fields in their declared shapes all reach the
		// query. `limit: 1` doubles as that bound's inclusive floor, which the
		// sibling bounds suite pins in its own right.
		for (const [method, params] of [
			['audit_log_list', { event_type: 'login' }],
			['admin_account_list', { include_deleted: true }],
			['role_grant_offer_history', { limit: 1 }],
			['audit_log_list', { since_seq: null }]
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

	test('a null on a hand-decoded key the twin declares .optional() is refused', async () => {
		// `account_token_create.name` is `z.string().default('CLI token')`, and
		// a default fills an **absent** key only — so an explicit `null` is
		// `-32602` on the twin where an ungated backend mints a token under the
		// default name. The mint is the control, so the case also proves the
		// refusal is the `null` and not the shape.
		const fixture = await setup_test();
		const mint = { scope: { kind: 'full' }, lifetime: { kind: 'eternal' } };
		const refused = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'account_token_create',
			params: { ...mint, name: null },
			headers: fixture.create_session_headers()
		});
		assert.isFalse(refused.ok, 'a null name must be refused');
		assert.strictEqual(
			refused.error.code,
			INVALID_PARAMS,
			`a null name must be -32602, got ${refused.error.code} (${refused.error.message})`
		);

		const control = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'account_token_create',
			params: mint,
			headers: fixture.create_session_headers()
		});
		assert.ok(control.ok, `an absent name must mint: ${JSON.stringify(control)}`);
		assert.strictEqual(
			(control.result as { name?: unknown }).name,
			'CLI token',
			'the absent key is what the default fills'
		);
	});
});

describe('spine acting-only admin inputs (cross-process, both backends)', () => {
	// `admin_session_list` / `invite_list` / `app_settings_get` are
	// `z.strictObject({acting: ActingActor}).default({})` on the twin — a
	// declared shape with no field the handler reads. A Rust handler taking no
	// `params` at all answers 200 to anything at all, so the shape is declared
	// as a struct and decoded even though nothing reads it.

	test('an admin acting-only input refuses an unknown key and a null acting', async () => {
		const fixture = await setup_test();
		for (const params of [{ nope: 1 }, { acting: null }]) {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'admin_session_list',
				params,
				headers: fixture.create_session_headers()
			});
			assert.isFalse(res.ok, `admin_session_list ${JSON.stringify(params)} must be refused`);
			assert.strictEqual(
				res.error.code,
				INVALID_PARAMS,
				`admin_session_list ${JSON.stringify(params)} must be invalid params, got ${res.error.code} (${res.error.message})`
			);
		}
	});

	test('an admin acting-only input takes {} and an absent params', async () => {
		// The `.default({})` half — the shape every real caller sends.
		const fixture = await setup_test();
		const empty = await post_rpc_session(fixture, {
			jsonrpc: JSONRPC_VERSION,
			id: 'test',
			method: 'admin_session_list',
			params: {}
		});
		assert.isUndefined(
			empty.body.error,
			`{} must reach the handler, got ${JSON.stringify(empty.body)}`
		);
		assert.strictEqual(empty.status, 200, '{} must answer HTTP 200');

		const absent = await post_rpc_session(fixture, {
			jsonrpc: JSONRPC_VERSION,
			id: 'test',
			method: 'admin_session_list'
		});
		assert.isUndefined(
			absent.body.error,
			`an absent params must reach the handler, got ${JSON.stringify(absent.body)}`
		);
		assert.strictEqual(absent.status, 200, 'an absent params must answer HTTP 200');
	});
});

describe('flat-REST body strictness (cross-process, both backends)', () => {
	// The one non-RPC row in this suite: `POST /api/account/password` carries a
	// JSON body rather than a JSON-RPC envelope, but it is the same
	// strict-object contract one transport over — `z.strictObject` on TS,
	// `#[serde(deny_unknown_fields)]` on the Rust spine, and an unknown key is
	// a refusal on both rather than a silent drop. The mirror of fuz_app's own
	// signup row upstream.

	test('an unknown key on the password body is 400 invalid_request_body', async () => {
		const fixture = await setup_test();
		const response = await fixture.transport('/api/account/password', {
			method: 'POST',
			headers: create_test_request_headers({
				'Content-Type': 'application/json',
				...fixture.create_session_headers()
			}),
			body: JSON.stringify({
				current_password: 'not-the-real-password',
				new_password: 'a-valid-length-password',
				unexpected_field: 'x'
			})
		});
		const body = (await response.json()) as { error?: unknown };
		assert.strictEqual(
			response.status,
			BAD_REQUEST,
			`an unknown body key must be 400, got ${response.status} ${JSON.stringify(body)}`
		);
		assert.strictEqual(
			body.error,
			'invalid_request_body',
			`an unknown body key must name the body, got ${JSON.stringify(body)}`
		);
	});
});
