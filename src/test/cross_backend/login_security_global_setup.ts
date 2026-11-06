/**
 * Vitest `globalSetup` for the **login-security** cross-backend projects.
 *
 * Same shape as `global_setup.ts` — fuz_app's
 * `create_cross_backend_global_setup` derives the backend name from the vitest
 * project name, spawns + bootstraps it, and `provide`s the handle — but over
 * the limiter-enabled `BackendConfig` pair. A separate setup rather than more
 * entries in the standard map because the project names carry the
 * `login_security` discriminator (`cross_backend_login_security_ts_deno` →
 * `deno`), and because these spawns must never be reachable from the standard
 * projects: their limiters are live, and the standard suites' login volume
 * would trip them.
 *
 * @module
 */

import { prepare_cargo_binary } from '@fuzdev/fuz_app/testing/cross_backend/cargo_binary.ts';
import { create_cross_backend_global_setup } from '@fuzdev/fuz_app/testing/cross_backend/create_cross_backend_global_setup.ts';

import {
	FORGE_CARGO_BINARY,
	deno_login_security_backend_config,
	rust_login_security_backend_config
} from './fuz_forge_backend_config.ts';

export default create_cross_backend_global_setup({
	configs: {
		deno: deno_login_security_backend_config,
		rust: rust_login_security_backend_config
	},
	ensure_databases: true,
	before_spawn: { rust: () => prepare_cargo_binary(FORGE_CARGO_BINARY) },
	derive_name: (project_name) => project_name.replace(/^cross_backend_login_security_(?:ts_)?/, '')
});
