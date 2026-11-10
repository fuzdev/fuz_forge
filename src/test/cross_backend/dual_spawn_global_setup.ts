/**
 * Vitest `globalSetup` for the fuz_forge cross-backend **parity** project.
 * Spawns + bootstraps BOTH backends (TS on Node + Rust) in one run and provides
 * both serialized handles, so a parity gate can drive both and compare.
 *
 * One project uses it — `cross_backend_parity`, one spawn pair serving every
 * gate that compares the two backends: schema parity (the live DB schema, via
 * `_testing_schema_snapshot`), action-manifest parity (the live RPC registry,
 * via `_testing_action_manifest`), and the differential (every generated
 * conformance row sent to both, the normalized answers diffed). The gates
 * share the spawns safely: the differential's per-case `_testing_reset`
 * touches data only, never the schema or the registry the other two read.
 *
 * **Both legs run on Postgres.** The schema snapshot compares index
 * definitions as the engine renders them (`pg_indexes.indexdef`), and the
 * in-memory engine behind the TS backend's `memory://` default renders an
 * index without its per-key sort direction, `NULLS` placement, operator
 * classes or `NULLS NOT DISTINCT`. On one engine, a diff can only be DDL
 * drift. So this project alone gives the TS leg a `postgres://` URL:
 * `TS_PARITY_DATABASE` on the server the Rust leg's URL names, which keeps
 * the two legs on one server version.
 *
 * The Rust test binary wipes its own database at startup. The TS one does
 * not, and bootstrap refuses a database that already holds an account, so the
 * TS leg's database is created when missing — on the server its URL names,
 * not the one the libpq environment does — and its `public` schema dropped
 * and recreated here on every run. A server that cannot be reached, a role
 * that cannot connect, or a database that cannot be created or emptied fails
 * the project with what to check — the gates never skip. The Rust leg's
 * database is created when missing too, and its binary built before the spawn
 * (`prepare_cargo_binary`), as the single-backend setup does.
 *
 * The single-backend `global_setup.ts` derives one backend from the
 * project name; these gates need both alive at once.
 *
 * @module
 */

import type { TestProject } from 'vitest/node';
import { prepare_cargo_binary } from '@fuzdev/fuz_app/testing/cross_backend/cargo_binary.ts';
import { create_dual_spawn_global_setup } from '@fuzdev/fuz_app/testing/cross_backend/create_dual_spawn_global_setup.ts';
import {
	empty_owned_database,
	ensure_database_for_url,
	with_database_name
} from '@fuzdev/fuz_app/testing/cross_backend/postgres_database.ts';

import {
	FORGE_CARGO_BINARY,
	RUST_DATABASE_URL,
	node_backend_config,
	rust_backend_config
} from './fuz_forge_backend_config.ts';

/**
 * The Postgres database the TS leg migrates — beside the Rust leg's
 * `fuz_forge_test_rust`, and used by nothing else: every run empties it.
 */
const TS_PARITY_DATABASE = 'fuz_forge_test_ts_parity';

const setup = async (project: TestProject): Promise<() => Promise<void>> => {
	// the TS leg's database on the Rust leg's server, so neither can be
	// pointed at the other's database
	const ts_database_url = with_database_name(RUST_DATABASE_URL, TS_PARITY_DATABASE);
	ensure_database_for_url(RUST_DATABASE_URL);
	// on the server the URL names — the wipe below connects through the URL
	ensure_database_for_url(ts_database_url);
	await empty_owned_database(ts_database_url, {
		owned_name: TS_PARITY_DATABASE,
		label: 'parity setup'
	});
	prepare_cargo_binary(FORGE_CARGO_BINARY);
	const dual_spawn = create_dual_spawn_global_setup({
		configs: {
			a: () => node_backend_config({ database_url: ts_database_url }),
			b: rust_backend_config
		}
	});
	return dual_spawn(project);
};

export default setup;
