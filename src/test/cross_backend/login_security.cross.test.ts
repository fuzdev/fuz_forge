/**
 * Cross-process **login rate limiting + trusted-proxy (X-Forwarded-For)**
 * parity suite — a thin invocation of `@fuzdev/fuz_app`'s
 * `describe_login_security_cross_tests` against BOTH forge backends.
 *
 * Unlike every other file in this directory it does **not** run in the
 * `cross_backend_ts_node` / `cross_backend_rust` projects: it needs a backend
 * spawned with the login limiters **enabled** and loopback trusted as a proxy,
 * while those two disable every limiter by design (the standard suites fire
 * hundreds of logins from one host, far past the 5-per-15-min per-IP budget,
 * which successful logins deliberately don't refund). It runs instead in the
 * dedicated `cross_backend_login_security_ts_node` /
 * `cross_backend_login_security_rust` projects, whose `globalSetup`
 * (`login_security_global_setup.ts`) spawns the limiter-enabled config pair on
 * their own ports.
 *
 * The env contract is upstream's, so no new name is minted:
 * `FUZ_LOGIN_RATE_LIMIT_ENABLED` (fuz_app's `LOGIN_RATE_LIMIT_ENABLED_ENV`)
 * selects `RateLimiterMode::Enforced` on the Rust test binary
 * (`crates/testing_fuz_forge_server/src/main.rs`) and keeps
 * `create_app_server`'s default limiters on the TS one
 * (`src/lib/server/app_assembly.ts`'s `create_testing_wiring`). The proxy half
 * needs no per-backend remap either — the TS forge hardcodes loopback as
 * trusted (`server.ts`) and the Rust forge defaults `FUZ_FORGE_TRUSTED_PROXIES`
 * to loopback (`crates/fuz_forge_server/src/env.rs`), which the Rust config
 * restates explicitly so the suite doesn't lean on the default.
 *
 * The same spawns also carry the action limiters, capped small
 * (`FUZ_ACTION_RATE_LIMIT_ENABLED` + `FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS`), for
 * `ws_action_rate_limit.cross.test.ts` and `action_throttle_order.cross.test.ts`;
 * the login and action limiters keep separate buckets, so this suite's cases
 * spend nothing those read.
 *
 * @module
 */

import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { describe_login_security_cross_tests } from '@fuzdev/fuz_app/testing/cross_backend/login_security.ts';

const handle = inject_backend_handle();

describe_login_security_cross_tests({ setup_test: default_cross_process_setup(handle) });
