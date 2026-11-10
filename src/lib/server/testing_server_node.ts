/**
 * Node spawn entry for the fuz_forge cross-process test binary.
 *
 * Thin wiring of fuz_app's `create_node_testing_adapter` + `start_testing_server`
 * onto `build_fuz_forge_testing_app` — the Node twin of `server/testing_server_deno.ts`,
 * differing only in which runtime adapter + Hono middleware it binds. Spawned by
 * the cross-impl bench (`src/benchmarks/cross_impl.bench.ts`) so the TS reference
 * backend can be timed under Node V8 alongside Deno V8 + Bun JSC.
 *
 * `/api/ws` mounts through `@hono/node-ws`: the adapter's `prepare_websocket`
 * builds the upgrade helper from the assembled app and caps its frames at
 * twice the endpoint's message limit, and the core injects it into the server
 * after `serve`.
 *
 * Run with:
 *   gro run src/lib/server/testing_server_node.ts
 *
 * **Never ships in a release** — reaches into fuz_app's `testing/cross_backend/`
 * modules which throw on production load.
 *
 * @module
 */

import process from 'node:process';
import { serveStatic } from '@hono/node-server/serve-static';
import { start_testing_server } from '@fuzdev/fuz_app/testing/cross_backend/testing_server_core.ts';
import { create_node_testing_adapter } from '@fuzdev/fuz_app/testing/cross_backend/testing_server_node.ts';

import {
	build_fuz_forge_testing_app,
	resolve_fuz_forge_testing_config
} from './testing_server_build.ts';
import { spawn_collect, spawn_streaming } from './subprocess.ts';

const DAEMON_NAME = 'fuz_forge_ts_node';

const start = async (): Promise<void> => {
	const adapter = create_node_testing_adapter();
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
				spawn_streaming,
				spawn_collect,
				// mounts `/api/ws`, as the Deno and Bun binaries do
				create_upgrade_websocket: context.prepare_websocket()
			})
	});
};

start().catch((error: unknown) => {
	console.error('[testing_server] Failed to start:', error);
	process.exit(1);
});
