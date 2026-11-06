/**
 * Deno spawn entry for the fuz_forge cross-process test binary.
 *
 * Thin wiring of fuz_app's `create_deno_testing_adapter` + `start_testing_server`
 * onto `build_fuz_forge_testing_app`. The `cross_backend_ts_deno` vitest
 * project's `globalSetup` spawns this; it serves the real fuz_forge app over
 * HTTP with the test seams (fast hasher, daemon-token rotation, `_testing_reset`).
 *
 * Run with:
 *   deno run --allow-net --allow-read --allow-env --allow-write --allow-sys \
 *     --allow-ffi --allow-run src/lib/server/testing_server_deno.ts
 *
 * **Never ships in a release** — reaches into fuz_app's `testing/cross_backend/`
 * modules which throw on production load.
 *
 * @module
 */

import { serveStatic } from '@hono/deno';
import { start_testing_server } from '@fuzdev/fuz_app/testing/cross_backend/testing_server_core.ts';
import { create_deno_testing_adapter } from '@fuzdev/fuz_app/testing/cross_backend/testing_server_deno.ts';

import {
	build_fuz_forge_testing_app,
	resolve_fuz_forge_testing_config
} from './testing_server_build.ts';
import { spawn_collect_deno, spawn_streaming_deno } from './server_deno.ts';

const DAEMON_NAME = 'fuz_forge_ts_deno';

const start = async (): Promise<void> => {
	const adapter = create_deno_testing_adapter();
	const { host, port, daemon_token_path } = resolve_fuz_forge_testing_config(adapter.runtime);
	await start_testing_server({
		adapter,
		daemon_name: DAEMON_NAME,
		host,
		port,
		build_app: (context) =>
			build_fuz_forge_testing_app({
				runtime: adapter.runtime,
				serve_static: serveStatic,
				get_connection_ip: adapter.get_connection_ip,
				daemon_token_path,
				spawn_streaming: spawn_streaming_deno,
				spawn_collect: spawn_collect_deno,
				// mounts `/api/ws` for the cross-process WS suites
				create_upgrade_websocket: context.prepare_websocket()
			})
	});
};

start().catch((error: unknown) => {
	console.error('[testing_server] Failed to start:', error);
	Deno.exit(1);
});
