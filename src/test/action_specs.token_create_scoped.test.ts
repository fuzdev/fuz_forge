/**
 * `FuzForgeTokenCreateScopedInput`, the `@fuzdev/fuz_schema` input of
 * `fuz_forge_token_create_scoped`, against the answers of its former Zod form.
 *
 * Every input in the table carries the verdict the Zod form gave it, frozen:
 * the output where it differs from the input, and the `error.data.reason` where
 * it refused (`resolve_issues_invalid_reason`, what the dispatcher answers
 * with). The Rust twin, `TokenTemplateInput::into_template`, was written
 * against those answers, so a verdict that moves here moves away from it.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { parse } from '@fuzdev/fuz_schema/schema.ts';
import { ERROR_TOKEN_LIFETIME_INVALID } from '@fuzdev/fuz_app/auth/account_action_specs.ts';
import { TOKEN_TTL_DAYS_MAX } from '@fuzdev/fuz_app/auth/token_lifetime.ts';
import { resolve_issues_invalid_reason } from '@fuzdev/fuz_app/schema_meta.ts';

import {
	FuzForgeTokenCreateScopedInput,
	FuzForgeTokenCreateScopedOutput
} from '#lib/action_specs.ts';

const ID = '3f8a1c2e-1234-4abc-9def-0123456789ab';
const ID_UPPER = ID.toUpperCase();
const NIL = '00000000-0000-0000-0000-000000000000';
const MAX_UPPER = 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF';
const ETERNAL = { kind: 'eternal' };

const ids = (n: number): Array<string> =>
	Array.from(
		{ length: n },
		(_, i) => `3f8a1c2e-1234-4abc-9def-${i.toString(16).padStart(12, '0')}`
	);
const strings = (n: number): Array<string> => Array.from({ length: n }, (_, i) => `f${i}`);

const base = { name: 'n', template: { kind: 'admin' }, lifetime: ETERNAL };
const with_template = (template: unknown): unknown => ({ ...base, template });
const with_lifetime = (lifetime: unknown): unknown => ({ ...base, lifetime });

/**
 * What the zod form answered, frozen: the same input accepted as given, accepted with
 * another output, refused with no `invalid_reason`, or refused with the lifetime's.
 */
type Expected = 'accepted' | { output: unknown } | 'refused' | 'refused_lifetime';

/** Inputs of every shape the dispatcher can hand the schema, valid and not. */
const INPUTS: Array<[label: string, input: unknown, expected: Expected]> = [
	// the root
	['the base', base, 'accepted'],
	['undefined', undefined, 'refused'],
	['null', null, 'refused'],
	['an array', [], 'refused'],
	['a string', 'x', 'refused'],
	['{}', {}, 'refused'],
	['an unknown root key', { ...base, extra: 1 }, 'refused'],
	['an unknown root key and a bad lifetime', { ...base, lifetime: null, extra: 1 }, 'refused'],
	// name
	['no name', { template: base.template, lifetime: ETERNAL }, 'refused'],
	['an empty name', { ...base, name: '' }, 'refused'],
	['an 80-char name', { ...base, name: 'a'.repeat(80) }, 'accepted'],
	['an 81-char name', { ...base, name: 'a'.repeat(81) }, 'refused'],
	['a numeric name', { ...base, name: 1 }, 'refused'],
	['a bad name and a bad lifetime', { ...base, name: '', lifetime: null }, 'refused'],
	// acting
	['an acting actor', { ...base, acting: ID }, 'accepted'],
	[
		'an uppercase acting actor',
		{ ...base, acting: ID_UPPER },
		{
			output: {
				name: 'n',
				template: { kind: 'admin' },
				lifetime: { kind: 'eternal' },
				acting: '3f8a1c2e-1234-4abc-9def-0123456789ab'
			}
		}
	],
	['a bad acting actor', { ...base, acting: 'nope' }, 'refused'],
	['a null acting actor', { ...base, acting: null }, 'refused'],
	['a present acting key of undefined', { ...base, acting: undefined }, 'accepted'],
	// template
	['no template', { name: 'n', lifetime: ETERNAL }, 'refused'],
	['a null template', with_template(null), 'refused'],
	['an array template', with_template([]), 'refused'],
	['a template without a kind', with_template({}), 'refused'],
	['an unknown kind', with_template({ kind: 'bogus' }), 'refused'],
	['a numeric kind', with_template({ kind: 1 }), 'refused'],
	['a kind named for a prototype key', with_template({ kind: 'constructor' }), 'refused'],
	["a kind whose value is '__proto__'", with_template({ kind: '__proto__' }), 'refused'],
	['admin with an extra key', with_template({ kind: 'admin', repo_ids: [ID] }), 'refused'],
	['forge_push', with_template({ kind: 'forge_push', repo_ids: [ID] }), 'accepted'],
	['forge_pull', with_template({ kind: 'forge_pull', repo_ids: [ID, ID] }), 'accepted'],
	[
		'uppercase repo ids',
		with_template({ kind: 'forge_pull', repo_ids: [ID_UPPER, MAX_UPPER] }),
		{
			output: {
				name: 'n',
				template: {
					kind: 'forge_pull',
					repo_ids: ['3f8a1c2e-1234-4abc-9def-0123456789ab', 'ffffffff-ffff-ffff-ffff-ffffffffffff']
				},
				lifetime: { kind: 'eternal' }
			}
		}
	],
	['the nil repo id', with_template({ kind: 'forge_push', repo_ids: [NIL] }), 'accepted'],
	[
		'a slug repo id',
		with_template({ kind: 'forge_push', repo_ids: ['fuzdev/fuz_app'] }),
		'refused'
	],
	[
		'a bare name repo id',
		with_template({ kind: 'forge_push', repo_ids: [ID, 'fuz_app'] }),
		'refused'
	],
	[
		'a hyphenless repo id',
		with_template({ kind: 'forge_push', repo_ids: [ID.replaceAll('-', '')] }),
		'refused'
	],
	['a numeric repo id', with_template({ kind: 'forge_push', repo_ids: [1] }), 'refused'],
	['empty repo ids', with_template({ kind: 'forge_push', repo_ids: [] }), 'refused'],
	['64 repo ids', with_template({ kind: 'forge_push', repo_ids: ids(64) }), 'accepted'],
	['65 repo ids', with_template({ kind: 'forge_push', repo_ids: ids(65) }), 'refused'],
	['repo ids as a string', with_template({ kind: 'forge_push', repo_ids: ID }), 'refused'],
	['no repo ids', with_template({ kind: 'forge_push' }), 'refused'],
	[
		'repo ids with an extra key',
		with_template({ kind: 'forge_push', repo_ids: [ID], x: 1 }),
		'refused'
	],
	['files_read *', with_template({ kind: 'files_read', filenames: '*' }), 'accepted'],
	['files_write a list', with_template({ kind: 'files_write', filenames: ['a', 'b'] }), 'accepted'],
	[
		'files_read_write a list',
		with_template({ kind: 'files_read_write', filenames: ['*'] }),
		'accepted'
	],
	['filenames another string', with_template({ kind: 'files_read', filenames: 'a' }), 'refused'],
	['filenames empty', with_template({ kind: 'files_read', filenames: [] }), 'refused'],
	[
		'filenames with an empty name',
		with_template({ kind: 'files_read', filenames: [''] }),
		'refused'
	],
	['256 filenames', with_template({ kind: 'files_read', filenames: strings(256) }), 'accepted'],
	['257 filenames', with_template({ kind: 'files_read', filenames: strings(257) }), 'refused'],
	['filenames null', with_template({ kind: 'files_read', filenames: null }), 'refused'],
	[
		'rpc_subset',
		with_template({ kind: 'rpc_subset', methods: ['fuz_forge_repo_list'] }),
		'accepted'
	],
	['methods empty', with_template({ kind: 'rpc_subset', methods: [] }), 'refused'],
	['methods with an empty name', with_template({ kind: 'rpc_subset', methods: [''] }), 'refused'],
	['64 methods', with_template({ kind: 'rpc_subset', methods: strings(64) }), 'accepted'],
	['65 methods', with_template({ kind: 'rpc_subset', methods: strings(65) }), 'refused'],
	[
		'an own constructor key in the template',
		JSON.parse(
			'{"name":"n","template":{"kind":"admin","constructor":1},"lifetime":{"kind":"eternal"}}'
		),
		'refused'
	],
	[
		'repo ids on a files template',
		with_template({ kind: 'files_read', repo_ids: [ID] }),
		'refused'
	],
	// lifetime
	['no lifetime', { name: 'n', template: base.template }, 'refused_lifetime'],
	['a null lifetime', with_lifetime(null), 'refused_lifetime'],
	['a string lifetime', with_lifetime('eternal'), 'refused_lifetime'],
	['a lifetime without a kind', with_lifetime({}), 'refused_lifetime'],
	['an unknown lifetime kind', with_lifetime({ kind: 'forever' }), 'refused_lifetime'],
	['eternal with an extra key', with_lifetime({ kind: 'eternal', days: 1 }), 'refused_lifetime'],
	['ttl 1', with_lifetime({ kind: 'ttl', days: 1 }), 'accepted'],
	['ttl max', with_lifetime({ kind: 'ttl', days: TOKEN_TTL_DAYS_MAX }), 'accepted'],
	[
		'ttl past max',
		with_lifetime({ kind: 'ttl', days: TOKEN_TTL_DAYS_MAX + 1 }),
		'refused_lifetime'
	],
	['ttl 0', with_lifetime({ kind: 'ttl', days: 0 }), 'refused_lifetime'],
	['ttl fractional', with_lifetime({ kind: 'ttl', days: 1.5 }), 'refused_lifetime'],
	['ttl a string', with_lifetime({ kind: 'ttl', days: '5' }), 'refused_lifetime'],
	['ttl without days', with_lifetime({ kind: 'ttl' }), 'refused_lifetime'],
	['a bad template and a bad lifetime', { ...base, template: {}, lifetime: null }, 'refused']
];

describe('FuzForgeTokenCreateScopedInput', () => {
	for (const [label, input, expected] of INPUTS) {
		test(`answers as the Zod form did: ${label}`, () => {
			const fuz = parse(FuzForgeTokenCreateScopedInput, input);
			if (expected === 'accepted' || typeof expected === 'object') {
				assert.isTrue(fuz.ok, 'verdict');
				assert.deepStrictEqual(
					fuz.value,
					expected === 'accepted' ? input : expected.output,
					'output'
				);
			} else {
				assert.isFalse(fuz.ok, 'verdict');
				assert.strictEqual(
					resolve_issues_invalid_reason(FuzForgeTokenCreateScopedInput, fuz.issues, input),
					expected === 'refused_lifetime' ? ERROR_TOKEN_LIFETIME_INVALID : undefined,
					'reason'
				);
			}
		});
	}

	test('refuses a slug where a repo id belongs, on both repo templates', () => {
		for (const kind of ['forge_push', 'forge_pull']) {
			const parsed = parse(
				FuzForgeTokenCreateScopedInput,
				with_template({ kind, repo_ids: ['fuzdev/fuz_app'] })
			);
			assert.isFalse(parsed.ok, kind);
		}
	});

	test('outputs repo ids in lowercase', () => {
		const parsed = parse(
			FuzForgeTokenCreateScopedInput,
			with_template({ kind: 'forge_pull', repo_ids: [ID_UPPER] })
		);
		assert.isTrue(parsed.ok);
		assert.strictEqual(parsed.value.template.kind, 'forge_pull');
		assert.deepEqual(
			parsed.value.template.kind === 'forge_pull' ? parsed.value.template.repo_ids : null,
			[ID]
		);
	});

	test('maps every refusal of the lifetime alone to its declared reason', () => {
		for (const lifetime of [
			undefined,
			null,
			{},
			{ kind: 'forever' },
			{ kind: 'eternal', days: 1 },
			{ kind: 'ttl' },
			{ kind: 'ttl', days: 0 },
			{ kind: 'ttl', days: 1.5 },
			{ kind: 'ttl', days: TOKEN_TTL_DAYS_MAX + 1 }
		]) {
			const input =
				lifetime === undefined ? { name: 'n', template: base.template } : with_lifetime(lifetime);
			const parsed = parse(FuzForgeTokenCreateScopedInput, input);
			assert.isFalse(parsed.ok, JSON.stringify(lifetime));
			assert.strictEqual(
				resolve_issues_invalid_reason(FuzForgeTokenCreateScopedInput, parsed.issues, input),
				ERROR_TOKEN_LIFETIME_INVALID,
				JSON.stringify(lifetime)
			);
		}
	});

	test('a refusal of the template carries no reason', () => {
		const input = with_template({ kind: 'forge_push', repo_ids: ['fuzdev/fuz_app'] });
		const parsed = parse(FuzForgeTokenCreateScopedInput, input);
		assert.isFalse(parsed.ok);
		assert.isUndefined(
			resolve_issues_invalid_reason(FuzForgeTokenCreateScopedInput, parsed.issues, input)
		);
		// `variant` reports an unknown kind at the discriminator, where a `union` would not
		const unknown_kind = with_template({ kind: 'bogus' });
		const refused = parse(FuzForgeTokenCreateScopedInput, unknown_kind);
		assert.isFalse(refused.ok);
		assert.deepStrictEqual(refused.issues[0]!.path, ['template', 'kind']);
		assert.isUndefined(
			resolve_issues_invalid_reason(FuzForgeTokenCreateScopedInput, refused.issues, unknown_kind)
		);
	});
});

describe('FuzForgeTokenCreateScopedOutput', () => {
	const output = {
		ok: true,
		token: 'secret',
		id: 'tok_abcdefghijkl',
		name: 'n',
		template: 'forge_push'
	};

	test('accepts the shape the handler returns, as given', () => {
		for (const template of ['admin', 'forge_push', 'files_read', 'rpc_subset']) {
			const value = { ...output, template };
			const parsed = parse(FuzForgeTokenCreateScopedOutput, value);
			assert.isTrue(parsed.ok, template);
			assert.strictEqual(parsed.value, value);
		}
	});

	test('refuses a wrong shape', () => {
		for (const value of [
			{ ...output, ok: false },
			{ ...output, template: 1 },
			{ ...output, token: null },
			{ ...output, extra: 1 },
			{ ok: true, token: 'secret', id: 'tok_abcdefghijkl', name: 'n' },
			null
		]) {
			assert.isFalse(parse(FuzForgeTokenCreateScopedOutput, value).ok, JSON.stringify(value));
		}
	});
});
