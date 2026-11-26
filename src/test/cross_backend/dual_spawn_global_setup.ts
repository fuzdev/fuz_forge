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
 * **Both legs run on PostgreSQL, and only there.** The schema snapshot
 * compares index definitions as the engine renders them
 * (`pg_indexes.indexdef`), and pglet renders an index without its per-key
 * sort direction, `NULLS` placement, operator classes or
 * `NULLS NOT DISTINCT`. On one engine, a diff can only be DDL drift. So each
 * leg gets a PostgreSQL database of its own, fresh each run, on the server
 * `FUZ_TEST_POSTGRES_URL` names (fuz_app's `open_test_database`, with no
 * pglet server to fall back to), which keeps the two legs on one server
 * version. With the variable unset the setup fails naming it — the gates
 * never skip. The Rust test binary is built before the spawn
 * (`prepare_cargo_binary`; the dual-spawn setup takes no `cargo_binaries`).
 *
 * The single-backend `global_setup.ts` derives one backend from the
 * project name; these gates need both alive at once.
 *
 * @module
 */

import type { TestProject } from 'vitest/node';
import { prepare_cargo_binary } from '@fuzdev/fuz_app/testing/cross_backend/cargo_binary.ts';
import { create_dual_spawn_global_setup } from '@fuzdev/fuz_app/testing/cross_backend/create_dual_spawn_global_setup.ts';
import { FUZ_TEST_POSTGRES_URL_ENV } from '@fuzdev/fuz_app/testing/db.ts';

import {
	FORGE_CARGO_BINARY,
	node_backend_config,
	rust_backend_config
} from './fuz_forge_backend_config.ts';

const setup = (project: TestProject): Promise<() => Promise<void>> => {
	// fail before the cargo build: both sides run only on PostgreSQL
	if (!process.env[FUZ_TEST_POSTGRES_URL_ENV]) {
		throw new Error(
			`cross_backend_parity runs only on PostgreSQL: set ${FUZ_TEST_POSTGRES_URL_ENV} ` +
				'to a server and a role with CREATEDB (e.g. postgres://localhost/postgres)'
		);
	}
	prepare_cargo_binary(FORGE_CARGO_BINARY);
	const dual_spawn = create_dual_spawn_global_setup({
		configs: {
			a: (database_url) => node_backend_config({ database_url }),
			b: rust_backend_config
		},
		// PostgreSQL-only: no pglet server to fall back to
		databases: {
			a: { name: 'parity_node', pglet_server: null },
			b: { name: 'parity_rust', pglet_server: null }
		}
	});
	return dual_spawn(project);
};

export default setup;
