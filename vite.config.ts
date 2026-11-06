import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import adapter from '@sveltejs/adapter-static';
import { execSync } from 'node:child_process';
import { svelte_preprocess_mdz } from '@fuzdev/mdz/svelte_preprocess_mdz.ts';
import { svelte_preprocess_fuz_code } from '@fuzdev/fuz_code/svelte_preprocess_fuz_code.ts';
import { create_csp_directives } from '@fuzdev/fuz_ui/csp.ts';
import { csp_directives_of_fuzdev } from '@fuzdev/fuz_ui/csp_of_fuzdev.ts';
import { vite_plugin_fuz_css } from '@fuzdev/fuz_css/vite_plugin_fuz_css.ts';
import svelte_docinfo from 'svelte-docinfo/vite.js';
import { git_info_get } from '@fuzdev/fuz_util/git.ts';
import { vite_plugin_pkg_json } from '@fuzdev/fuz_ui/vite_plugin_pkg_json.ts';
import { make_cross_backend_project } from '@fuzdev/fuz_app/testing/cross_backend/make_cross_backend_project.ts';

// Cap vitest worker threads to half the cores: the unit project's files are
// small, and the cross-backend projects spawn real backends beside the workers.
const max_workers = Math.max(1, Math.ceil(availableParallelism() / 2));

const git = await git_info_get();

// The `cross_backend_*` projects spawn real backend binaries via `globalSetup`
// (and the Rust ones need a Postgres DB). Gate them behind
// `FUZ_TEST_CROSS_BACKEND=1` so a bare `gro test` stays in-process; an explicit
// `FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_deno` runs.
const GLOBAL_SETUP = './src/test/cross_backend/global_setup.ts';
// The parity project spawns BOTH backends in one run (a shared dual-spawn
// globalSetup) and serves every gate that compares the two: schema parity
// (live DDL), action-manifest parity (live RPC registry), and the differential
// (every generated conformance row sent to both, the answers compared). Its
// files are excluded from the single-backend projects' default glob, and it
// runs in its own later groupOrder — it reuses their ports.
const DUAL_SPAWN_GLOBAL_SETUP = './src/test/cross_backend/dual_spawn_global_setup.ts';
const DUAL_SPAWN_TESTS = [
	'src/test/cross_backend/schema_parity.cross.test.ts',
	'src/test/cross_backend/action_manifest_parity.cross.test.ts',
	'src/test/cross_backend/differential.cross.test.ts'
];
// The login-security project needs a backend spawned with the login and action
// rate limiters ENABLED (the action pair capped small), which the standard
// projects disable by design (their suites fire hundreds of logins and actions
// from one host). It therefore gets its own globalSetup + spawn pair on its own
// ports, and is excluded from the standard projects' glob — the same shape as
// the dual-spawn parity project. Login security, the action rate limit over WS
// and the forge's throttle-order pin share it: each case runs on its own fresh
// keeper or dedicated account, and the login and action limiters keep separate
// buckets.
const LOGIN_SECURITY_GLOBAL_SETUP = './src/test/cross_backend/login_security_global_setup.ts';
const LOGIN_SECURITY_TESTS = [
	'src/test/cross_backend/login_security.cross.test.ts',
	'src/test/cross_backend/ws_action_rate_limit.cross.test.ts',
	'src/test/cross_backend/action_throttle_order.cross.test.ts'
];
const NON_STANDARD_CROSS_TESTS = [...DUAL_SPAWN_TESTS, ...LOGIN_SECURITY_TESTS];
const cross_backend_projects = process.env.FUZ_TEST_CROSS_BACKEND
	? [
			make_cross_backend_project({
				name: 'cross_backend_ts_deno',
				global_setup: GLOBAL_SETUP,
				exclude: NON_STANDARD_CROSS_TESTS
			}),
			make_cross_backend_project({
				name: 'cross_backend_rust',
				global_setup: GLOBAL_SETUP,
				exclude: NON_STANDARD_CROSS_TESTS
			}),
			make_cross_backend_project({
				name: 'cross_backend_parity',
				global_setup: DUAL_SPAWN_GLOBAL_SETUP,
				include: DUAL_SPAWN_TESTS,
				group_order: 4
			}),
			make_cross_backend_project({
				name: 'cross_backend_login_security_ts_deno',
				global_setup: LOGIN_SECURITY_GLOBAL_SETUP,
				include: LOGIN_SECURITY_TESTS,
				group_order: 5
			}),
			make_cross_backend_project({
				name: 'cross_backend_login_security_rust',
				global_setup: LOGIN_SECURITY_GLOBAL_SETUP,
				include: LOGIN_SECURITY_TESTS,
				group_order: 5
			})
		]
	: [];

export default defineConfig(({ mode }) => ({
	plugins: [
		sveltekit({
			preprocess: [svelte_preprocess_mdz(), svelte_preprocess_fuz_code(), vitePreprocess()],
			compilerOptions: { runes: true },
			inspector: true,
			adapter: adapter({
				// fallback page for the prerendered SPA — nginx serves it for any path
				// without a prerendered file (`spa_try_files: '$uri /200.html'` in `zap.ts`),
				// and the client routes from there
				fallback: '200.html'
			}),
			paths: { relative: false }, // use root-absolute paths for SSR path comparison: https://svelte.dev/docs/kit/configuration#paths
			csp: {
				directives: create_csp_directives({
					extend: [csp_directives_of_fuzdev]
				})
			},
			version: { name: execSync('git rev-parse HEAD').toString().trim() }
		}),
		svelte_docinfo({ onDuplicates: 'throw' }),
		vite_plugin_fuz_css(),
		vite_plugin_pkg_json()
	],
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					include: ['src/test/**/*.test.ts'],
					exclude: ['src/test/**/*.db.test.ts', 'src/test/**/*.cross.test.ts'],
					maxWorkers: max_workers,
					sequence: { groupOrder: 1 }
				}
			},
			{
				extends: true,
				test: {
					name: 'db',
					include: ['src/test/**/*.db.test.ts'],
					isolate: false,
					fileParallelism: false,
					sequence: { groupOrder: 2 }
				}
			},
			...cross_backend_projects
		]
	},
	define: {
		__GIT_COMMIT__: JSON.stringify(git.commit ?? 'unknown'),
		__GIT_BRANCH__: JSON.stringify(git.branch ?? 'unknown'),
		__BUILD_TIMESTAMP__: JSON.stringify(new Date().toISOString())
	},
	server: {
		// Vite watches the whole root, an inotify watch per file, and the Rust `target/`
		// alone can exhaust the user's `max_user_watches` budget
		watch: { ignored: ['**/target/**', '**/.gro/**'] },
		proxy: {
			'/api': { target: 'http://127.0.0.1:4041', ws: true },
			'/health': 'http://127.0.0.1:4041'
		}
	},
	// In test mode, use browser conditions so Svelte runes work correctly
	resolve: mode === 'test' ? { conditions: ['browser'] } : undefined,
	optimizeDeps: { exclude: ['@fuzdev/blake3-wasm'] }
}));
