/**
 * The `seed_from` URL grammar + host policy, and their parity with the Rust
 * twin.
 *
 * Every table here is asserted against `src/test/fixtures/parity/seed_from_url.json`
 * and `…/seed_from_host_policy.json`, which the `seed_from` test module
 * (`crates/fuz_forge_server/src/handlers/seed_from/tests.rs`) reads too. Both
 * sides parse with a WHATWG URL parser and run the same range checks, so every
 * spelling is a shared assertion: a divergence in either parser or either
 * implementation shows up as a failure on one side only.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	seed_from_host_is_private,
	seed_from_url_canonical,
	SEED_FROM_URL_MESSAGE
} from '#lib/fuz_forge/repo/seed_from.ts';
import { FuzForgeRepoCreateInput } from '#lib/action_specs.ts';
import {
	load_parity_fixture,
	parity_bool,
	parity_rows,
	parity_string
} from '../../fixtures/parity/load.ts';

const url_fixture = load_parity_fixture('seed_from_url');
const host_fixture = load_parity_fixture('seed_from_host_policy');

/** The grammar table — loopback and the private ranges are grammatical, and the host-policy tables are what decide them. */
const urls = parity_rows(url_fixture, 'urls');
/** Input → the serialization both WHATWG parsers produce. */
const canonicalized = parity_rows(url_fixture, 'canonicalized');

describe('seed_from_url_canonical', () => {
	for (const row of urls) {
		const url = parity_string(row, 'input');
		const accepted = parity_bool(row, 'accepted');
		test(`${accepted ? 'accepts' : 'rejects'}: ${JSON.stringify(url)}`, () => {
			assert.strictEqual(seed_from_url_canonical(url) !== null, accepted);
		});
	}

	/**
	 * The table the authority-confusion fix rests on — the backslash spellings
	 * parse with host `example.invalid` / `93.184.216.34`, but git treats `\` as
	 * an ordinary character and would dial the host *after* it with the text
	 * before it as credentials. Storing and cloning the canonical form
	 * (backslash resolved to a path separator) is what makes the host this
	 * module validated the host git contacts.
	 */
	for (const row of canonicalized) {
		const raw = parity_string(row, 'input');
		test(`canonicalizes: ${JSON.stringify(raw)}`, () => {
			assert.strictEqual(seed_from_url_canonical(raw), parity_string(row, 'expected'));
		});
	}
});

describe('FuzForgeRepoCreateInput seed_from', () => {
	test('an absent seed_from is the unseeded create', () => {
		const parsed = FuzForgeRepoCreateInput.safeParse({ slug: 'org/repo' });
		assert.isTrue(parsed.success, JSON.stringify(parsed));
		assert.isUndefined(parsed.data?.seed_from);
	});

	// The refine is on the schema rather than in the handler so the dispatcher's
	// `safeParse` refuses an off-grammar seed as `-32602` before any disk or DB
	// work — matching the Rust `require_seed_from_url` call site. The refine only
	// admits; it deliberately does not transform. A `.transform()` on this field
	// would make it unrepresentable in JSON Schema and blank the whole input
	// schema out of the generated attack surface, so the *handler* canonicalizes
	// right after parse (`fuz_forge_repo_create` in
	// `server/routes/fuz_forge_repo_write.ts`)
	// — which is what the cell records and what `git clone --bare` receives.
	for (const row of urls) {
		const seed_from = parity_string(row, 'input');
		const accepted = parity_bool(row, 'accepted');
		test(`the schema ${accepted ? 'admits' : 'refuses'}: ${JSON.stringify(seed_from)}`, () => {
			const parsed = FuzForgeRepoCreateInput.safeParse({ slug: 'org/repo', seed_from });
			assert.strictEqual(parsed.success, accepted);
			if (accepted) {
				assert.strictEqual(parsed.data?.seed_from, seed_from, 'admitted unnormalized');
			} else {
				assert.ok(
					parsed.error?.issues.some((issue) => issue.message === SEED_FROM_URL_MESSAGE),
					`must fail with the shared message, got ${JSON.stringify(parsed.error?.issues)}`
				);
			}
		});
	}

	// Guards the seam the admit-without-transform leaves open: every
	// non-canonical spelling still parses, and `seed_from_url_canonical` — the
	// call the handler makes on `parsed.data.seed_from` — is what rewrites it.
	for (const row of canonicalized) {
		const raw = parity_string(row, 'input');
		test(`the handler stores the canonical form of: ${JSON.stringify(raw)}`, () => {
			const parsed = FuzForgeRepoCreateInput.safeParse({ slug: 'org/repo', seed_from: raw });
			assert.isTrue(parsed.success, `${raw} must pass the input schema`);
			assert.strictEqual(
				seed_from_url_canonical(parsed.data?.seed_from ?? ''),
				parity_string(row, 'expected')
			);
		});
	}
});

describe('seed_from_host_is_private', () => {
	for (const row of parity_rows(host_fixture, 'hosts')) {
		const host = parity_string(row, 'input');
		const admitted = parity_bool(row, 'accepted');
		test(`${admitted ? 'admits' : 'refuses'}: ${JSON.stringify(host)}`, () => {
			assert.strictEqual(seed_from_host_is_private(host), !admitted);
		});
	}

	/**
	 * The policy runs on the canonical host, so the address it judges is the
	 * address git dials — which is what closes the alternate IPv4 spellings the
	 * parser folds (`2130706433`, `0177.0.0.1`) and the dotted IPv4-mapped IPv6
	 * form. The handler applies this exact chain after the grammar refine, and
	 * `FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS` is what skips it.
	 */
	for (const row of parity_rows(host_fixture, 'private_urls')) {
		const raw = parity_string(row, 'input');
		const admitted = parity_bool(row, 'accepted');
		test(`${admitted ? 'admits' : 'refuses'} once canonicalized: ${JSON.stringify(raw)}`, () => {
			const canonical = seed_from_url_canonical(raw);
			assert.isNotNull(canonical, `${raw} must pass the grammar`);
			assert.strictEqual(seed_from_host_is_private(new URL(canonical).hostname), !admitted);
		});
	}

	/**
	 * The grammar answers before the host policy, so an off-grammar value with
	 * a private host never reaches this predicate — the same order the Rust
	 * `require_seed_from_url` runs its three gates in.
	 */
	test('the grammar answers before the host policy', () => {
		assert.isNull(seed_from_url_canonical('ssh://git@127.0.0.1/x.git'));
	});
});
