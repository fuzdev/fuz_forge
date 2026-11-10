/**
 * Cross-impl latency benchmark for the **fuz_forge domain** — the TS
 * (Hono) reference backend, run under two JS runtimes (Node V8 / Bun JSC),
 * vs the Rust (`fuz_forge_server`, Axum) backend, driven over real
 * HTTP through fuz_app's cross-impl bench engine
 * (`@fuzdev/fuz_app/testing/cross_backend/bench`).
 *
 * fuz_app's own `cross_impl.bench` measures the shared spine surface
 * (`account_verify`, `account_session_list`, `audit_log_list`) via the
 * domain-free `testing_spine_stub`. This bench is the missing **real-app**
 * measurement: it seeds a repo + a file-store artifact on each backend, then
 * times the forge-domain read paths a deployment actually serves — repo
 * metadata reads and the content-addressed artifact serve the `fuz` installer
 * pulls. The shared spine scenarios are spread in first so the forge numbers
 * sit next to a comparable baseline.
 *
 * **Axes.** Two are isolated: the JS-runtime axis (Node / Bun, the identical
 * TS app over the same DB driver — apples-to-apples with each other) and the
 * cross-language axis (either TS runtime vs Rust). The backends run in order
 * `[node, bun, rust]`.
 *
 * **TS is the reference impl; full parity is the goal.** The reference column
 * is `node` and the report's verdict reads as each backend `vs node` per
 * scenario. The Rust backend is benched by default (parity is the standing
 * goal); set `FUZ_FORGE_BENCH_TS_ONLY=1` for a zero-Postgres, TS-only quick run.
 *
 * Out-of-process for every impl by construction (that's the whole point of a
 * cross-impl bench); the correctness suites keep the fast in-process path.
 *
 * Run: `gro run src/benchmarks/cross_impl.bench.ts`.
 *
 * **Bun is optional.** The Bun backend is included only when `bun` is on
 * `PATH` (the bench probes `bun --version`); otherwise it is skipped with a
 * note so the Node (+ Rust) run still completes.
 *
 * **DB-layer caveat.** By default the TS backends run fuz_app's in-memory
 * `memory://` database while the Rust backend runs real Postgres
 * (`tokio-postgres` can't reach an in-process database) — so the TS-vs-`rust` columns are NOT apples-to-apples at the DB
 * layer (the TS runtimes still are, with each other). The numbers compare
 * whole-backend wall-clock for each path, not the storage engine in isolation.
 * Same caveat fuz_app's and zzz's `cross_impl.bench` carry. The Rust backend
 * needs its Postgres DB created once (idempotent):
 *
 * ```bash
 * createdb fuz_forge_test_rust 2>/dev/null || true
 * ```
 *
 * (the Rust test binary self-wipes the schema on boot via
 * `FUZ_TESTING_RESET_DB_ON_STARTUP=true`).
 *
 * **Fair-DB option (`FUZ_FORGE_BENCH_PG=1`).** Points the TS backends at
 * real Postgres too — per-runtime DBs `fuz_forge_bench_node` /
 * `fuz_forge_bench_bun` — so the whole-backend numbers
 * compare apples-to-apples at the DB layer against Rust. Requires Postgres +
 * `dropdb` / `createdb` on `PATH`. Unlike the Rust test binary, the TS testing
 * server does NOT self-wipe its DB, and bootstrap expects an empty DB, so the
 * bench drops + recreates each TS Postgres DB before spawning. The Postgres
 * host/auth come from the standard libpq env (`PGHOST` / `PGUSER` / …) and
 * `dropdb`/`createdb` defaults — the bench builds the URLs as
 * `postgres://localhost/<db>`. Without the flag, the TS backends stay in-memory
 * (the zero-infra default).
 *
 * `git` + `python3` must be on PATH for every run — `fuz_forge_repo_create`
 * materializes an on-disk bare repo with python3 hooks.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import {
	compare_cross_impl,
	format_cross_impl_comparison,
	format_cross_impl_json,
	format_cross_impl_markdown
} from '@fuzdev/fuz_app/testing/cross_backend/bench/bench_report.ts';
import { run_cross_impl_bench } from '@fuzdev/fuz_app/testing/cross_backend/bench/run_cross_impl_bench.ts';
import {
	default_bench_scenarios,
	type BenchScenario
} from '@fuzdev/fuz_app/testing/cross_backend/bench/scenario.ts';
import { bootstrap_backend } from '@fuzdev/fuz_app/testing/cross_backend/bootstrap_backend.ts';
import type { BackendConfig } from '@fuzdev/fuz_app/testing/cross_backend/backend_config.ts';
import type { BootstrappedBackendHandle } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { prepare_cargo_binary } from '@fuzdev/fuz_app/testing/cross_backend/cargo_binary.ts';

import {
	bun_backend_config,
	FORGE_CARGO_BINARY,
	node_backend_config,
	rust_backend_config
} from '../test/cross_backend/fuz_forge_backend_config.ts';

const ARTIFACT_PATH = 'src/benchmarks/cross_impl.latest.json';

/** TS is the reference impl; the report reads as each backend `vs node` per scenario. */
const REFERENCE_BACKEND = 'node';

/** Skip the Rust backend (no Postgres / cargo) for a quick TS-only run. */
const TS_ONLY = process.env.FUZ_FORGE_BENCH_TS_ONLY === '1';

/**
 * Fair-DB option — point the TS backends at real Postgres (per-runtime DBs)
 * instead of in-memory, so the TS-vs-Rust comparison is apples-to-apples at the
 * DB layer. See the module doc § Fair-DB option.
 */
const FAIR_PG = process.env.FUZ_FORGE_BENCH_PG === '1';

/** The TS JS runtimes benched (each runs the identical TS app). */
type TsRuntime = 'node' | 'bun';

/** Per-TS-runtime Postgres DB names used when `FUZ_FORGE_BENCH_PG=1`. */
const TS_PG_DBS: Readonly<Record<TsRuntime, string>> = {
	node: 'fuz_forge_bench_node',
	bun: 'fuz_forge_bench_bun'
};

/** `postgres://localhost/<db>` URL for a fair-DB TS backend. */
const ts_pg_url = (runtime: TsRuntime): string => `postgres://localhost/${TS_PG_DBS[runtime]}`;

/** True when `bun` is on `PATH` — the Bun backend is included only then. */
const bun_available = (): boolean => {
	try {
		execFileSync('bun', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};

/**
 * Drop + recreate a TS backend's Postgres DB so each fair-DB run starts from
 * the empty DB bootstrap expects (the TS testing server, unlike the Rust one,
 * does not self-wipe). Idempotent: `dropdb --if-exists` then `createdb`. Uses
 * `node:child_process` against the libpq CLI tools + the ambient `PG*` env.
 */
const reset_ts_pg_db = (db: string): void => {
	execFileSync('dropdb', ['--if-exists', db], { stdio: 'ignore' });
	execFileSync('createdb', [db], { stdio: 'ignore' });
};

/** Seeded once per backend before timing — referenced by the read scenarios. */
const SEED_SLUG = 'bench/forge-bench';
/** A `tools/<name>/<version>/...`-style key — the real artifact-serve layout. */
const SEED_FILE_KEY = 'bench/artifact.bin';
/** Modest artifact so `file_get` times a real byte transfer, not just dispatch. */
const SEED_FILE_BYTES = new Uint8Array(16 * 1024).fill(0x42);

// Fair-DB reset — when `FUZ_FORGE_BENCH_PG=1`, drop + recreate each TS
// backend's Postgres DB before spawning (the TS testing server doesn't
// self-wipe, and bootstrap expects an empty DB). Done up front so a failure
// here aborts before any backend boots.
const ts_database_url = (runtime: TsRuntime): string | undefined => {
	if (!FAIR_PG) return undefined;
	reset_ts_pg_db(TS_PG_DBS[runtime]);
	return ts_pg_url(runtime);
};

if (FAIR_PG) {
	console.log(
		'FUZ_FORGE_BENCH_PG=1 — TS backends on real Postgres (per-runtime DBs, reset before run)'
	);
} else {
	console.log('TS backends in-memory (set FUZ_FORGE_BENCH_PG=1 for fair-DB Postgres)');
}

// Order: [node, bun, rust] — node is the reference backend. Bun is included
// only when it's on PATH (the bench gracefully skips it otherwise).
const configs: Array<BackendConfig> = [
	node_backend_config({ database_url: ts_database_url('node') })
];
if (bun_available()) {
	configs.push(bun_backend_config({ database_url: ts_database_url('bun') }));
	console.log('including Bun backend (bun found on PATH)');
} else {
	console.log('skipping Bun backend (bun not on PATH) — install Bun to bench the JSC runtime');
}
if (TS_ONLY) {
	console.log('skipping Rust backend (FUZ_FORGE_BENCH_TS_ONLY=1) — TS-only run');
} else {
	// the config spawns the built binary, so build it first (the global setups do)
	prepare_cargo_binary(FORGE_CARGO_BINARY);
	configs.push(rust_backend_config());
	console.log('including Rust backend (set FUZ_FORGE_BENCH_TS_ONLY=1 to skip)');
}

/**
 * Seed the read fixtures on a freshly-bootstrapped backend using the keeper's
 * session transport (its cookie jar auto-carries the bootstrap session; the
 * transport adds the matching Origin, so these session-authed mutations pass).
 * Bench scenarios then hammer the seeded reads with no per-iteration reset.
 */
const seed_forge_fixtures = async (handle: BootstrappedBackendHandle): Promise<void> => {
	const created = await rpc_call({
		app: handle.keeper_transport,
		path: handle.config.rpc_path,
		method: 'fuz_forge_repo_create',
		params: { slug: SEED_SLUG, default_branch: 'main' }
	});
	if (!created.ok) {
		throw new Error(
			`[${handle.config.name}] seed repo_create failed: ${created.error.code} ${created.error.message}`
		);
	}

	const uploaded = await handle.keeper_transport(`/api/fuz_forge/files/${SEED_FILE_KEY}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(SEED_FILE_BYTES.length)
		},
		body: SEED_FILE_BYTES
	});
	if (uploaded.status !== 200) {
		throw new Error(
			`[${handle.config.name}] seed file upload failed: ${uploaded.status} ${await uploaded.text()}`
		);
	}
};

/**
 * Forge-domain read scenarios — layered after the shared spine floor so the
 * report shows forge paths beside a comparable baseline. All reads, all
 * idempotent (safe to repeat against one seeded backend with no reset).
 *
 * - `fuz_forge_repo_list` — the dashboard's repo index (cell list read).
 * - `fuz_forge_repo_get` — a single repo by slug (cell get + git tip resolve).
 * - `file_get` — the content-addressed artifact serve the `fuz` installer
 *   hits; raw GET (not RPC) through the same pre-authed transport, draining
 *   the body so the timing includes byte transfer.
 *
 * `repo_log` / `repo_commit` / `repo_refs` are intentionally omitted: they
 * need a repo with commit history, which requires seeding via a real `git
 * push` (see `repo_push.cross.test.ts`). Add them once the seed grows a push
 * step.
 */
const forge_scenarios: ReadonlyArray<BenchScenario> = [
	{
		name: 'fuz_forge_repo_list',
		run: async (ctx) => {
			const res = await rpc_call({
				app: ctx.transport,
				path: ctx.rpc_path,
				method: 'fuz_forge_repo_list'
			});
			if (!res.ok) throw new Error(`repo_list failed: ${res.error.code} ${res.error.message}`);
		}
	},
	{
		name: 'fuz_forge_repo_get',
		run: async (ctx) => {
			const res = await rpc_call({
				app: ctx.transport,
				path: ctx.rpc_path,
				method: 'fuz_forge_repo_get',
				params: { slug: SEED_SLUG }
			});
			if (!res.ok) throw new Error(`repo_get failed: ${res.error.code} ${res.error.message}`);
		}
	},
	{
		name: 'file_get',
		run: async (ctx) => {
			const res = await ctx.transport(`/api/fuz_forge/files/${SEED_FILE_KEY}`, { method: 'GET' });
			if (res.status !== 200) throw new Error(`file_get failed: ${res.status}`);
			await res.arrayBuffer(); // drain so timing includes byte transfer
		}
	}
];

const scenarios: ReadonlyArray<BenchScenario> = [...default_bench_scenarios, ...forge_scenarios];

const handles: Array<BootstrappedBackendHandle> = [];
try {
	// Spawn + bootstrap + seed sequentially — parallel spawns would contend
	// during boot, and each backend needs its own seed before timing.
	for (const config of configs) {
		const handle = await bootstrap_backend(config);
		handles.push(handle);
		await seed_forge_fixtures(handle);
	}

	const result = await run_cross_impl_bench({ handles, scenarios });

	console.log(`\n${format_cross_impl_markdown(result)}\n`);
	console.log(
		format_cross_impl_comparison(compare_cross_impl(result, { reference: REFERENCE_BACKEND }))
	);

	writeFileSync(ARTIFACT_PATH, `${format_cross_impl_json(result)}\n`);
	console.log(`\nwrote ${ARTIFACT_PATH}`);
} finally {
	await Promise.allSettled(handles.map((h) => h.teardown()));
}
