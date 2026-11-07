/**
 * `FuzForgeTokenCreateScopedInput`, the `@fuzdev/fuz_schema` input of
 * `fuz_forge_token_create_scoped`, against the Zod form, its oracle.
 *
 * The Zod form lives here only, as the oracle: every input in the table gets
 * the same verdict from both, the same output where it matches, and the same
 * `error.data.reason` where it doesn't (`resolve_issues_invalid_reason`, what
 * the dispatcher answers with). The Rust twin, `TokenTemplateInput::into_template`,
 * was written against the Zod form, so a verdict that moves here moves away
 * from it.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { z } from 'zod';
import { parse } from '@fuzdev/fuz_schema/schema.ts';
import { ZodActingActor } from '@fuzdev/fuz_app/zod_schemas.ts';
import { ERROR_TOKEN_LIFETIME_INVALID } from '@fuzdev/fuz_app/auth/account_action_specs.ts';
import { TOKEN_TTL_DAYS_MAX } from '@fuzdev/fuz_app/auth/token_lifetime.ts';
import { resolve_issues_invalid_reason } from '@fuzdev/fuz_app/schema_meta.ts';

import {
	FuzForgeTokenCreateScopedInput,
	FuzForgeTokenCreateScopedOutput
} from '#lib/action_specs.ts';
import { RepoId } from '#lib/fuz_forge/repo/repo_id.ts';

// the Zod form of the input, the oracle
const ZodRepoIds = z.array(RepoId).min(1).max(64);
const ZodFilenames = z.union([z.literal('*'), z.array(z.string().min(1)).min(1).max(256)]);
const ZodTokenLifetimeInput = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('eternal') }),
	z.strictObject({
		kind: z.literal('ttl'),
		days: z.number().int().min(1).max(TOKEN_TTL_DAYS_MAX)
	})
]);
const ZodInput = z.strictObject({
	name: z.string().min(1).max(80),
	template: z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('admin') }),
		z.strictObject({ kind: z.literal('forge_push'), repo_ids: ZodRepoIds }),
		z.strictObject({ kind: z.literal('forge_pull'), repo_ids: ZodRepoIds }),
		z.strictObject({ kind: z.literal('files_read'), filenames: ZodFilenames }),
		z.strictObject({ kind: z.literal('files_write'), filenames: ZodFilenames }),
		z.strictObject({ kind: z.literal('files_read_write'), filenames: ZodFilenames }),
		z.strictObject({
			kind: z.literal('rpc_subset'),
			methods: z.array(z.string().min(1)).min(1).max(64)
		})
	]),
	lifetime: ZodTokenLifetimeInput.meta({ invalid_reason: ERROR_TOKEN_LIFETIME_INVALID }),
	acting: ZodActingActor
});

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

/** Inputs of every shape the dispatcher can hand the schema, valid and not. */
const INPUTS: Array<[label: string, input: unknown]> = [
	// the root
	['the base', base],
	['undefined', undefined],
	['null', null],
	['an array', []],
	['a string', 'x'],
	['{}', {}],
	['an unknown root key', { ...base, extra: 1 }],
	['an unknown root key and a bad lifetime', { ...base, lifetime: null, extra: 1 }],
	// name
	['no name', { template: base.template, lifetime: ETERNAL }],
	['an empty name', { ...base, name: '' }],
	['an 80-char name', { ...base, name: 'a'.repeat(80) }],
	['an 81-char name', { ...base, name: 'a'.repeat(81) }],
	['a numeric name', { ...base, name: 1 }],
	['a bad name and a bad lifetime', { ...base, name: '', lifetime: null }],
	// acting
	['an acting actor', { ...base, acting: ID }],
	['an uppercase acting actor', { ...base, acting: ID_UPPER }],
	['a bad acting actor', { ...base, acting: 'nope' }],
	['a null acting actor', { ...base, acting: null }],
	['a present acting key of undefined', { ...base, acting: undefined }],
	// template
	['no template', { name: 'n', lifetime: ETERNAL }],
	['a null template', with_template(null)],
	['an array template', with_template([])],
	['a template without a kind', with_template({})],
	['an unknown kind', with_template({ kind: 'bogus' })],
	['a numeric kind', with_template({ kind: 1 })],
	['a kind named for a prototype key', with_template({ kind: 'constructor' })],
	["a kind whose value is '__proto__'", with_template({ kind: '__proto__' })],
	['admin with an extra key', with_template({ kind: 'admin', repo_ids: [ID] })],
	['forge_push', with_template({ kind: 'forge_push', repo_ids: [ID] })],
	['forge_pull', with_template({ kind: 'forge_pull', repo_ids: [ID, ID] })],
	['uppercase repo ids', with_template({ kind: 'forge_pull', repo_ids: [ID_UPPER, MAX_UPPER] })],
	['the nil repo id', with_template({ kind: 'forge_push', repo_ids: [NIL] })],
	['a slug repo id', with_template({ kind: 'forge_push', repo_ids: ['fuzdev/fuz_app'] })],
	['a bare name repo id', with_template({ kind: 'forge_push', repo_ids: [ID, 'fuz_app'] })],
	[
		'a hyphenless repo id',
		with_template({ kind: 'forge_push', repo_ids: [ID.replaceAll('-', '')] })
	],
	['a numeric repo id', with_template({ kind: 'forge_push', repo_ids: [1] })],
	['empty repo ids', with_template({ kind: 'forge_push', repo_ids: [] })],
	['64 repo ids', with_template({ kind: 'forge_push', repo_ids: ids(64) })],
	['65 repo ids', with_template({ kind: 'forge_push', repo_ids: ids(65) })],
	['repo ids as a string', with_template({ kind: 'forge_push', repo_ids: ID })],
	['no repo ids', with_template({ kind: 'forge_push' })],
	['repo ids with an extra key', with_template({ kind: 'forge_push', repo_ids: [ID], x: 1 })],
	['files_read *', with_template({ kind: 'files_read', filenames: '*' })],
	['files_write a list', with_template({ kind: 'files_write', filenames: ['a', 'b'] })],
	['files_read_write a list', with_template({ kind: 'files_read_write', filenames: ['*'] })],
	['filenames another string', with_template({ kind: 'files_read', filenames: 'a' })],
	['filenames empty', with_template({ kind: 'files_read', filenames: [] })],
	['filenames with an empty name', with_template({ kind: 'files_read', filenames: [''] })],
	['256 filenames', with_template({ kind: 'files_read', filenames: strings(256) })],
	['257 filenames', with_template({ kind: 'files_read', filenames: strings(257) })],
	['filenames null', with_template({ kind: 'files_read', filenames: null })],
	['rpc_subset', with_template({ kind: 'rpc_subset', methods: ['fuz_forge_repo_list'] })],
	['methods empty', with_template({ kind: 'rpc_subset', methods: [] })],
	['methods with an empty name', with_template({ kind: 'rpc_subset', methods: [''] })],
	['64 methods', with_template({ kind: 'rpc_subset', methods: strings(64) })],
	['65 methods', with_template({ kind: 'rpc_subset', methods: strings(65) })],
	[
		'an own constructor key in the template',
		JSON.parse(
			'{"name":"n","template":{"kind":"admin","constructor":1},"lifetime":{"kind":"eternal"}}'
		)
	],
	['repo ids on a files template', with_template({ kind: 'files_read', repo_ids: [ID] })],
	// lifetime
	['no lifetime', { name: 'n', template: base.template }],
	['a null lifetime', with_lifetime(null)],
	['a string lifetime', with_lifetime('eternal')],
	['a lifetime without a kind', with_lifetime({})],
	['an unknown lifetime kind', with_lifetime({ kind: 'forever' })],
	['eternal with an extra key', with_lifetime({ kind: 'eternal', days: 1 })],
	['ttl 1', with_lifetime({ kind: 'ttl', days: 1 })],
	['ttl max', with_lifetime({ kind: 'ttl', days: TOKEN_TTL_DAYS_MAX })],
	['ttl past max', with_lifetime({ kind: 'ttl', days: TOKEN_TTL_DAYS_MAX + 1 })],
	['ttl 0', with_lifetime({ kind: 'ttl', days: 0 })],
	['ttl fractional', with_lifetime({ kind: 'ttl', days: 1.5 })],
	['ttl a string', with_lifetime({ kind: 'ttl', days: '5' })],
	['ttl without days', with_lifetime({ kind: 'ttl' })],
	['a bad template and a bad lifetime', { ...base, template: {}, lifetime: null }]
];

describe('FuzForgeTokenCreateScopedInput', () => {
	for (const [label, input] of INPUTS) {
		test(`agrees with the Zod form: ${label}`, () => {
			const zod = ZodInput.safeParse(input);
			const fuz = parse(FuzForgeTokenCreateScopedInput, input);
			assert.strictEqual(fuz.ok, zod.success, 'verdict');
			if (fuz.ok && zod.success) {
				assert.deepStrictEqual(fuz.value, zod.data, 'output');
			} else if (!fuz.ok && !zod.success) {
				assert.strictEqual(
					resolve_issues_invalid_reason(FuzForgeTokenCreateScopedInput, fuz.issues, input),
					resolve_issues_invalid_reason(ZodInput, zod.error.issues, input),
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
