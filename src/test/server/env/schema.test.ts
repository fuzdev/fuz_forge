/**
 * Env-contract tests for the forge's `ServerEnv` schema.
 *
 * The twin of the Rust `env::tests` (`crates/fuz_forge_server/src/env.rs`):
 * the canonical spine variable names are read, the retired `FUZ_FORGE_`-prefixed
 * spellings are not, and the forge's own `FUZ_FORGE_*` fields carry the
 * defaults and grammars the Rust `FuzForgeEnv::from_vars` applies. Env handling
 * is hand-written on both backends, so actively rejecting the retired names is
 * the anti-drift guard. One asymmetry is the contract, not a gap: the TS schema
 * is a strict fuz_schema `object`, so a retired name FAILS the parse here where the Rust
 * loader silently ignores it — both refuse to honor it, which is what the
 * cross-backend env contract requires.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { get_meta } from '@fuzdev/fuz_schema/meta.ts';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import { ServerEnv } from '#lib/server/env/schema.ts';
import { load_parity_fixture, parity_rows, parity_string } from '../../fixtures/parity/load.ts';

/** The smallest record `ServerEnv` accepts; tests spread their field on top. */
const BASE_ENV = {
	NODE_ENV: 'development',
	DATABASE_URL: 'postgres://localhost/fuz_forge_test',
	SECRET_FUZ_COOKIE_KEYS: 'x'.repeat(32),
	FUZ_ALLOWED_ORIGINS: 'http://localhost'
} as const;

const parse_env = (extra: Record<string, string>) => parse(ServerEnv, { ...BASE_ENV, ...extra });

describe('ServerEnv', () => {
	test('reads the canonical spine var names', () => {
		const result = parse_env({
			HOST: '127.0.0.1',
			PORT: '14141',
			FUZ_ALLOWED_ORIGINS: 'http://a.example, http://b.example',
			FUZ_BOOTSTRAP_TOKEN_PATH: '/tmp/bt',
			FUZ_FORGE_REPO_STORE_PATH: '/tmp/repos'
		});
		assert(result.ok, JSON.stringify(!result.ok && result.issues));
		assert.strictEqual(result.value.HOST, '127.0.0.1');
		assert.strictEqual(result.value.PORT, 14141);
		assert.strictEqual(result.value.FUZ_ALLOWED_ORIGINS, 'http://a.example, http://b.example');
		assert.strictEqual(result.value.FUZ_BOOTSTRAP_TOKEN_PATH, '/tmp/bt');
		assert.strictEqual(result.value.FUZ_FORGE_REPO_STORE_PATH, '/tmp/repos');
	});

	// The retired names are asserted against
	// `src/test/fixtures/parity/env_retired.json`, which the Rust twin's
	// `ignores_retired_prefixed_var_names` reads too: the pre-convergence
	// `FUZ_FORGE_`-prefixed spine names plus the `host:port`
	// `FUZ_FORGE_BIND_ADDR`. The assertions differ by side and that asymmetry is
	// the contract, not a gap — the Rust loader silently ignores each name while
	// this strict schema refuses the whole record, which is the stronger form of
	// the same guarantee.
	for (const row of parity_rows(load_parity_fixture('env_retired'), 'retired')) {
		const name = parity_string(row, 'name');
		test(`refuses the retired ${name}`, () => {
			const result = parse_env({ [name]: parity_string(row, 'value') });
			assert(!result.ok, `${name} is retired and must not parse`);
			// one `unknown_key` issue per unknown key, its path the key
			assert(
				result.issues.some(
					(issue) =>
						issue.kind === 'unknown_key' && issue.path.length === 1 && issue.path[0] === name
				),
				JSON.stringify(result.issues)
			);
		});
	}

	test('an absent or empty FUZ_ALLOWED_ORIGINS fails', () => {
		const { FUZ_ALLOWED_ORIGINS: _omitted, ...without } = BASE_ENV;
		assert(!parse(ServerEnv, without).ok);
		assert(!parse_env({ FUZ_ALLOWED_ORIGINS: '' }).ok);
	});

	test('FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS is a stringbool defaulting to off', () => {
		const absent = parse_env({});
		assert(absent.ok);
		assert.strictEqual(absent.value.FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS, false);
		for (const truthy of ['true', 'TRUE', '1', 'yes', 'on', 'y', 'enabled', 'Enabled']) {
			const result = parse_env({ FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS: truthy });
			assert(result.ok, truthy);
			assert.strictEqual(result.value.FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS, true, truthy);
		}
		for (const falsy of ['false', 'FALSE', '0', 'no', 'off', 'n', 'disabled', 'Disabled']) {
			const result = parse_env({ FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS: falsy });
			assert(result.ok, falsy);
			assert.strictEqual(result.value.FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS, false, falsy);
		}
		// The closed set is the twin of `fuz_sys::env::parse_stringbool`: an
		// unrecognized word is a hard failure, not a silent false.
		for (const malformed of ['maybe', ' true', '']) {
			assert(!parse_env({ FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS: malformed }).ok, malformed);
		}
	});

	test('the file-store knobs carry their defaults and bounds', () => {
		const defaults = parse_env({});
		assert(defaults.ok);
		assert.strictEqual(defaults.value.FUZ_FORGE_FILE_STORE_MAX_BYTES, 10 * 1024 * 1024 * 1024);
		assert.strictEqual(
			defaults.value.FUZ_FORGE_FILE_STORE_FREE_SPACE_MARGIN_BYTES,
			1024 * 1024 * 1024
		);
		assert.strictEqual(defaults.value.FUZ_FORGE_FILE_STORE_MAX_CONCURRENT_UPLOADS, 4);
		assert(!parse_env({ FUZ_FORGE_FILE_STORE_MAX_CONCURRENT_UPLOADS: '0' }).ok);
		// the Rust twin parses both as `u64` and refuses a zero cap
		assert(!parse_env({ FUZ_FORGE_FILE_STORE_MAX_BYTES: '0' }).ok);
		assert(!parse_env({ FUZ_FORGE_FILE_STORE_MAX_BYTES: '1.5' }).ok);
		assert(!parse_env({ FUZ_FORGE_FILE_STORE_FREE_SPACE_MARGIN_BYTES: '-1' }).ok);
		assert(parse_env({ FUZ_FORGE_FILE_STORE_FREE_SPACE_MARGIN_BYTES: '0' }).ok);
		assert(!parse_env({ FUZ_FORGE_FILE_STORE_MAX_CONCURRENT_UPLOADS: '1.5' }).ok);
		// decimal digits after a trim, as the Rust `trim().parse::<u64>()`: a
		// blank value and an exponent are refused, padding, one leading `+` and
		// leading zeros read
		for (const name of [
			'FUZ_FORGE_FILE_STORE_MAX_BYTES',
			'FUZ_FORGE_FILE_STORE_FREE_SPACE_MARGIN_BYTES',
			'FUZ_FORGE_FILE_STORE_MAX_CONCURRENT_UPLOADS'
		] as const) {
			for (const malformed of ['', ' ', '5e3', '0x10']) {
				assert(!parse_env({ [name]: malformed }).ok, `${name}=${JSON.stringify(malformed)}`);
			}
			for (const spelled of [' 0042 ', '+42']) {
				const padded = parse_env({ [name]: spelled });
				assert(padded.ok, `${name}=${JSON.stringify(spelled)}`);
				assert.strictEqual(padded.value[name], 42, name);
			}
		}
	});

	test('the store-path overrides are optional strings', () => {
		const absent = parse_env({});
		assert(absent.ok);
		assert.strictEqual(absent.value.FUZ_FORGE_FACT_STORE_PATH, undefined);
		assert.strictEqual(absent.value.FUZ_FORGE_REPO_STORE_PATH, undefined);
		const set = parse_env({ FUZ_FORGE_FACT_STORE_PATH: '~/facts' });
		assert(set.ok);
		assert.strictEqual(set.value.FUZ_FORGE_FACT_STORE_PATH, '~/facts');
	});

	test('every forge field has a description', () => {
		for (const [name, field_schema] of Object.entries(ServerEnv.def)) {
			assert.ok(get_meta(field_schema)?.description, name);
		}
	});
});
