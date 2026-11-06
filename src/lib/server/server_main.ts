/**
 * `start` entry for the TS reference server.
 *
 * Nothing compiles this module — it is run directly, via `deno task dev:start`.
 * Production runs the Rust `fuzfd` binary, which parses no `start` flags and
 * reads its env from the process environment rather than an `--env_file`.
 *
 * Boots the server in the foreground (no self-managed background) so the
 * supervisor owns the process lifecycle. Parses a single `start` subcommand
 * plus optional `--port` / `--host` / `--env_file` flags, loads the env file
 * (same mechanism the client uses), then hands off to `start_server_deno`.
 *
 * For Node.js, run `server/server_node.ts` directly.
 *
 * @module
 */

import { argv_parse } from '@fuzdev/fuz_util/args.ts';
import { load_env_file } from '@fuzdev/fuz_app/env/dotenv.ts';
import { create_deno_runtime } from '@fuzdev/fuz_app/runtime/deno.ts';

import { start_server_deno } from './server_deno.ts';

const main = async (): Promise<void> => {
	const runtime = create_deno_runtime(Deno.args);
	const raw = argv_parse([...runtime.args]);

	const command = raw._[0];
	if (command !== undefined && command !== 'start') {
		console.error(`[server] Unknown command: ${command}`);
		console.error('Usage: server_main.ts start [--port <n>] [--host <h>] [--env_file <path>]');
		runtime.exit(1);
		return;
	}

	const env_file = typeof raw.env_file === 'string' ? raw.env_file : undefined;
	if (env_file) {
		const env_vars = await load_env_file(runtime, env_file);
		if (env_vars === null) {
			console.error(`[server] Cannot read env file: ${env_file}`);
			runtime.exit(1);
			return;
		}
		// Don't override existing process env.
		for (const [key, value] of Object.entries(env_vars)) {
			if (runtime.env_get(key) === undefined) {
				runtime.env_set(key, value);
			}
		}
	}

	// CLI flags take precedence over env values.
	if (raw.port !== undefined) runtime.env_set('PORT', String(raw.port));
	if (typeof raw.host === 'string') runtime.env_set('HOST', raw.host);

	await start_server_deno();
};

await main();
