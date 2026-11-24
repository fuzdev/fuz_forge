/**
 * Installs fuz_app's logged-error gate (`@fuzdev/fuz_app/testing/logged_errors.ts`)
 * in the `unit` and `db` projects: every error a test logs fails it unless the
 * test declares it with `expect_logged_error` or `allow_logged_error`.
 *
 * Wired as a `setupFiles` entry of both projects in `vite.config.ts`, which
 * vitest re-imports per test file, so each file starts with fresh state. The
 * cross-backend projects don't take it: their spawned backends' errors fail
 * teardown through `cross_backend/global_setup.ts`.
 *
 * @module
 */

import { install_logged_error_gate } from '@fuzdev/fuz_app/testing/logged_errors.ts';

install_logged_error_gate();
