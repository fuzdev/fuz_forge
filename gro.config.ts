import type { CreateGroConfig } from '@fuzdev/gro/gro_config.ts';
import { gro_plugin_deno_server } from '@fuzdev/gro/gro_plugin_deno_server.ts';
import { spawn_result_is_ok, to_spawn_result_message } from '@fuzdev/gro/cli.ts';
import { spawn } from '@fuzdev/gro/spawn.ts';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const config: CreateGroConfig = (cfg) => {
	const base_plugins = cfg.plugins;
	cfg.plugins = async (ctx) => {
		const plugins = await base_plugins(ctx);

		// Dev: run Deno server alongside Vite, with the same project-local home
		// and bootstrap token as `deno task dev:start` (an env file can't
		// expand the cwd, so they're set here)
		const fuz_forge_home = join(process.cwd(), '.fuz_forge');
		plugins.push(
			gro_plugin_deno_server({
				entry: 'src/lib/server/server_deno.ts',
				port: 4041,
				// IPv4 loopback, where the repo hooks call back (the plugin's
				// `localhost` default binds `::1` alone on some hosts)
				host: '127.0.0.1',
				permissions: [
					'--allow-net',
					'--allow-read',
					'--allow-write',
					'--allow-env',
					'--allow-sys',
					'--allow-ffi',
					// the server spawns git (repo reads, smart-HTTP, repo creation) and
					// chmod (repo permissions)
					'--allow-run=git,chmod'
				],
				env: {
					FUZ_FORGE_HOME: fuz_forge_home,
					FUZ_BOOTSTRAP_TOKEN_PATH: join(fuz_forge_home, 'secret_bootstrap_token')
				}
			})
		);

		// Build: compile the `fuzf` client + `fuzfd` server binaries from the
		// Rust workspace — `fuzf` is the forge client, `fuzfd` is the production
		// server (held to cross-backend parity with the TS reference impl, which
		// is not compiled or shipped — it is a run-directly twin via `deno run`
		// for the cross-backend tests + benchmarks). `cargo build --release`
		// emits `target/release/<bin>`; we copy each to `dist_artifacts/<bin>`
		// (+ a sha512sum-format hash), which is where the zap deploy
		// (`artifacts: ['dist_artifacts/']`, systemd `ExecStart=.../fuzfd start`) and
		// `src/lib/release.ts` (which ships both) read them.
		//
		// `FUZ_FORGE_BUILD_SKIP_SERVER=1` builds `fuzf` only (skips `fuzfd`), for
		// callers that want the client without paying the (slow, release-mode)
		// server build or being blocked by a broken/in-progress server. Nothing in
		// the repo sets it — `npm run install:fuzf` sidesteps this plugin
		// entirely by running `cargo build --release --bin fuzf` directly — so it
		// is an opt-in for ad-hoc `gro build` runs. `release` / `deploy` never set
		// it, so they always build + ship both.
		//
		// Guarded on the sibling `../fuz` spine workspace: both crates
		// path-dep it, so when it's absent (a checkout without the spine) the
		// cargo build can't resolve its deps and the step skips with a warning
		// rather than failing. The deploy/release machine has the spine checked
		// out (per Cargo.toml), so it always builds there; a missing binary is
		// caught downstream (`release.ts` aborts on a missing artifact; the
		// deploy's `ExecStart`/`/ready` gate fails if it's not there). `gro
		// build` cleans `dist_artifacts` first, so a skipped build never leaves
		// a stale binary to ship.
		plugins.push({
			name: 'gro_plugin_cargo_compile',
			adapt: async ({ log }) => {
				const output_dir = 'dist_artifacts';
				if (!existsSync('../fuz')) {
					log.warn(
						'[cargo] sibling ../fuz spine workspace not found — skipping the Rust' +
							' fuzf/fuzfd builds (no dist_artifacts binaries produced)'
					);
					return;
				}
				const skip_server = process.env.FUZ_FORGE_BUILD_SKIP_SERVER === '1';
				const bins = skip_server ? ['fuzf'] : ['fuzf', 'fuzfd'];
				if (skip_server) {
					log.info('[cargo] FUZ_FORGE_BUILD_SKIP_SERVER=1 — building fuzf only (skipping fuzfd)');
				}

				// Cross-compile target (`FUZ_FORGE_BUILD_TARGET`, e.g.
				// `x86_64-unknown-linux-musl`): a statically-linked musl build via
				// `cargo-zigbuild`, so the binaries run on an Alpine/musl host (the forge2
				// deploy sets it). Unset = a host `cargo build --release` (glibc — the Debian
				// forge, unchanged). Mirrors zap's `xtask build-musl`: zig as the C cross-linker
				// (`cargo install cargo-zigbuild`), the rustup musl std added on demand. The
				// binaries land at `target/<triple>/release/` instead of `target/release/`.
				const target = process.env.FUZ_FORGE_BUILD_TARGET;
				const release_dir = target ? join('target', target, 'release') : join('target', 'release');

				await mkdir(output_dir, { recursive: true });
				if (target) {
					log.info(`[cargo] cross-building for ${target} via cargo-zigbuild (static musl)`);
					// Best-effort: ensure the target's std is present (a no-op once installed).
					try {
						await spawn.find('rustup', { pass_env: 'all' })?.run(['target', 'add', target]);
					} catch {
						// best-effort, and a real problem shows up in the build below
					}
				}
				const args = target
					? ['zigbuild', '--release', '--target', target, ...bins.flatMap((bin) => ['--bin', bin])]
					: ['build', '--release', ...bins.flatMap((bin) => ['--bin', bin])];
				log.info(`[cargo] cargo ${args.join(' ')}`);
				// `pass_env: 'all'` because a build reads the user's toolchain and linker setup
				// (`CARGO_*`, `RUSTUP_*`, `RUSTFLAGS`, `CC`, zig for `zigbuild`), not a closed set
				const cargo = spawn.program('cargo', { pass_env: 'all' });
				const result = await cargo.run(args);
				if (!spawn_result_is_ok(result)) {
					throw new Error(`cargo ${args.join(' ')} failed (${to_spawn_result_message(result)})`);
				}
				for (const name of bins) {
					const output_path = join(output_dir, name);
					await copyFile(join(release_dir, name), output_path);
					// sha512sum format ("<hash>  <filename>"). SHA-512 is the
					// ecosystem's bootstrap-edge digest: a fuz-less verifier has
					// `sha512sum` / `shasum -a 512` as reliably as their 256
					// counterparts, and everything past bootstrap is blake3.
					const binary = await readFile(output_path);
					const hash = createHash('sha512').update(binary).digest('hex');
					await writeFile(`${output_path}.sha512`, `${hash}  ${name}\n`);
					log.info(`[cargo] ${name} → ${output_path} (+ .sha512)`);
				}
			}
		});

		return plugins;
	};

	return cfg;
};

export default config;
