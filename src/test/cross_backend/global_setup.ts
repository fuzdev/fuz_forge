/**
 * Vitest `globalSetup` for fuz_forge cross-backend integration suites.
 *
 * Collapsed onto fuz_app's `create_cross_backend_global_setup`: it derives
 * the backend name from the vitest project name (`cross_backend_ts_node` →
 * `node`), spawns + bootstraps the matching `BackendConfig`, and `provide`s
 * the serializable handle that `*.cross.test.ts` files `inject`. The Rust
 * leg's test binary is built first, with its output shown, and its database
 * created when it's missing.
 *
 * @module
 */

import { prepare_cargo_binary } from '@fuzdev/fuz_app/testing/cross_backend/cargo_binary.ts';
import { create_cross_backend_global_setup } from '@fuzdev/fuz_app/testing/cross_backend/create_cross_backend_global_setup.ts';

import {
	FORGE_CARGO_BINARY,
	node_backend_config,
	rust_backend_config
} from './fuz_forge_backend_config.ts';

export default create_cross_backend_global_setup({
	configs: { node: node_backend_config, rust: rust_backend_config },
	// `createdb` for the Rust leg's Postgres database when it's missing
	ensure_databases: true,
	before_spawn: { rust: () => prepare_cargo_binary(FORGE_CARGO_BINARY) }
});
