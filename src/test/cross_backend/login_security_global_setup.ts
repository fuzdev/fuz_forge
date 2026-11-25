/**
 * Vitest `globalSetup` for the **login-security** cross-backend projects.
 *
 * Same shape as `global_setup.ts` — fuz_app's
 * `create_cross_backend_global_setup` derives the backend name from the vitest
 * project name, provisions the Rust backend's database, spawns + bootstraps
 * it, and `provide`s the handle — but over the limiter-enabled
 * `BackendConfig` pair. A separate setup rather than more entries in the
 * standard map because these spawns must never be reachable from the
 * standard projects: their limiters are live, and the standard suites' login
 * volume would trip them. The derived names are the configs' own
 * (`cross_backend_login_security_ts_node` → `login_security_node`), which
 * also names the Rust backend's database apart from the standard project's.
 *
 * @module
 */

import { prepare_cargo_binary } from '@fuzdev/fuz_app/testing/cross_backend/cargo_binary.ts';
import { create_cross_backend_global_setup } from '@fuzdev/fuz_app/testing/cross_backend/create_cross_backend_global_setup.ts';

import {
	FORGE_CARGO_BINARY,
	FORGE_PGLET_SERVER,
	node_login_security_backend_config,
	rust_login_security_backend_config
} from './fuz_forge_backend_config.ts';

export default create_cross_backend_global_setup({
	configs: {
		login_security_node: () => node_login_security_backend_config(),
		login_security_rust: rust_login_security_backend_config
	},
	databases: { login_security_rust: FORGE_PGLET_SERVER },
	before_spawn: { login_security_rust: () => prepare_cargo_binary(FORGE_CARGO_BINARY) },
	derive_name: (project_name) => project_name.replace(/^cross_backend_/, '').replace('_ts_', '_')
});
