/**
 * Vitest `globalSetup` for fuz_forge cross-backend integration suites.
 *
 * Collapsed onto fuz_app's `create_cross_backend_global_setup`: it derives
 * the backend name from the vitest project name (`cross_backend_ts_node` →
 * `node`), spawns + bootstraps the matching `BackendConfig`, and `provide`s
 * the serializable handle that `*.cross.test.ts` files `inject`. The Rust
 * leg's test binary is built first, with its output shown, and its database
 * created when it's missing. Both spawns allow the errors forge's own suites
 * provoke on purpose (`REPO_CREATE_SEED_FROM_BACKEND_ERRORS`,
 * `FOREIGN_FACT_FILE_BACKEND_ERRORS`); an allowance covers the whole spawn,
 * every suite of the project, since they share the one backend.
 *
 * @module
 */

import { prepare_cargo_binary } from '@fuzdev/fuz_app/testing/cross_backend/cargo_binary.ts';
import { create_cross_backend_global_setup } from '@fuzdev/fuz_app/testing/cross_backend/create_cross_backend_global_setup.ts';
import {
	with_backend_log_allowances,
	type BackendLogAllowance
} from '@fuzdev/fuz_app/testing/cross_backend/backend_log.ts';

import {
	FORGE_CARGO_BINARY,
	node_backend_config,
	rust_backend_config
} from './fuz_forge_backend_config.ts';

/**
 * The seeded creates whose clone fails on purpose, each with its suite and
 * why: each backend logs the failed create, naming the slug and git's stderr,
 * before answering the fixed `-32603`. The 500 itself is no error line — the
 * Rust request log reports a 5xx at `WARN`. Pinned to slug and cause, so any
 * other failed create still fails teardown, and a renamed slug fails loudly.
 */
const FAILED_SEED_SLUGS: ReadonlyArray<readonly [slug: string, reason: string]> = [
	['sfg/unreachable', '`repo_create_seed_from`: an unreachable seed fails the clone'],
	['sfg/redirected', '`repo_create_seed_from`: a redirecting seed fails the clone'],
	[
		'ttt/seed-ceiling',
		'`rpc_input_strictness.bounds`: an unreachable seed at the `seed_from` ceiling fails the clone'
	]
];

const REPO_CREATE_SEED_FROM_BACKEND_ERRORS: ReadonlyArray<BackendLogAllowance> =
	FAILED_SEED_SLUGS.flatMap(([slug, reason]) => [
		// TS backend (`fuz_forge_repo_write.ts`)
		{ pattern: `[fuz_forge_repo_create] failed for slug=${slug}: git clone --bare failed`, reason },
		// Rust backend (`handlers::repo_write`)
		{ pattern: `fuz_forge_repo_create failed slug=${slug} error=git clone --bare failed`, reason }
	]);

/**
 * What `files.cross.test.ts`'s "an external row naming another fact's file
 * downloads as a missing file" case makes a backend log: the fact store reads
 * the foreign `file:` row as injection or corruption, logs it, and answers
 * not-found. An allowance is a substring and the TS line carries the hash
 * mid-sentence, so its pattern is the line's fixed tail (which the Rust line
 * shares). Neither pattern matches the `serve_fact` lines the spine list
 * allows, which end `answering 404` or read `rejecting an external_url`.
 */
const FOREIGN_FACT_FILE_BACKEND_ERRORS: ReadonlyArray<BackendLogAllowance> = [
	{
		// TS spine (`PgFactStore.get`): `PgFactStore.get external_url for <hash> addresses …`
		pattern: " addresses another fact's file; treating as not-found",
		reason: "`files`: an external row naming another fact's file downloads as a missing file"
	},
	{
		// Rust spine (`fuz_fact::fact_store`)
		pattern:
			"fuz_fact::fact_store: external_url addresses another fact's file; treating as not-found",
		reason: "`files`: an external row naming another fact's file downloads as a missing file"
	}
];

/** The errors forge's own suites provoke on purpose, for the two standard spawns. */
const FORGE_SUITE_BACKEND_ERRORS: ReadonlyArray<BackendLogAllowance> = [
	...REPO_CREATE_SEED_FROM_BACKEND_ERRORS,
	...FOREIGN_FACT_FILE_BACKEND_ERRORS
];

export default create_cross_backend_global_setup({
	configs: {
		node: () => with_backend_log_allowances(node_backend_config(), FORGE_SUITE_BACKEND_ERRORS),
		rust: () => with_backend_log_allowances(rust_backend_config(), FORGE_SUITE_BACKEND_ERRORS)
	},
	// `createdb` for the Rust leg's Postgres database when it's missing
	ensure_databases: true,
	before_spawn: { rust: () => prepare_cargo_binary(FORGE_CARGO_BINARY) }
});
