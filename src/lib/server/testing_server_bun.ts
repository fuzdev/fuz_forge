/**
 * Bun spawn entry for the fuz_forge cross-process test binary.
 *
 * Thin wiring of fuz_app's `create_bun_testing_adapter` + `start_testing_server`
 * onto `build_fuz_forge_testing_app` — the Bun twin of `server/testing_server_deno.ts` /
 * `server/testing_server_node.ts`, differing only in which runtime adapter + Hono
 * middleware it binds. Spawned by the cross-impl bench
 * (`src/benchmarks/cross_impl.bench.ts`) so the TS reference backend can be timed
 * under Bun JSC alongside Node V8 + Deno V8.
 *
 * Bun implements `node:child_process`, so the git-route subprocess primitives
 * are `server/subprocess.ts`'s own (`spawn_streaming` / `spawn_collect`) — no
 * Bun-specific spawn shim is needed. `Bun.serve` is
 * built in; the static middleware comes from the `@hono/bun` dev dep, the Bun
 * counterpart of Node's `@hono/node-server`.
 *
 * Run with:
 *   bun run src/lib/server/testing_server_bun.ts
 *
 * **Never ships in a release** — reaches into fuz_app's `testing/cross_backend/`
 * modules which throw on production load.
 *
 * @module
 */

import { serveStatic } from '@hono/bun';
import { start_testing_server } from '@fuzdev/fuz_app/testing/cross_backend/testing_server_core.ts';
import { create_bun_testing_adapter } from '@fuzdev/fuz_app/testing/cross_backend/testing_server_bun.ts';

import {
	build_fuz_forge_testing_app,
	resolve_fuz_forge_testing_config
} from './testing_server_build.ts';
import { spawn_collect, spawn_streaming } from './subprocess.ts';

const DAEMON_NAME = 'fuz_forge_ts_bun';

const start = async (): Promise<void> => {
	const adapter = create_bun_testing_adapter();
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
				// mounts `/api/ws`, as the Deno and Node binaries do, so the
				// spawned app is the same on every runtime
				create_upgrade_websocket: context.prepare_websocket()
			})
	});
};

start().catch((error: unknown) => {
	console.error('[testing_server] Failed to start:', error);
	process.exit(1);
});
