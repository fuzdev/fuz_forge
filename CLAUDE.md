# fuz_forge

> a personal-scale forge for self-hosting git repos, signed releases, and files

The forge has a web dashboard and delegates its own provisioning and deployment
to the standalone `zap` CLI.

See the [fuz-stack skill](https://docs.fuz.dev/skills/fuz-stack) for shared @fuzdev coding conventions (snake_case,
schemas, testing, Gro). This file covers fuz_forge-specific context only.
The app's own schemas (action specs, route specs, the token policy, `RepoId`,
`RepoSlug`) are `@fuzdev/fuz_schema`; no zod import remains in the forge.

## Overview

- **Package**: `@fuzdev/fuz_forge` — pre-alpha, not ready to be used.
- **Frontend**: a prerendered SvelteKit SPA (adapter-static) served by nginx;
  no SSR, no `hooks.server.ts`.
- **Backends**: two, held to wire parity by the cross-backend test harness
  and the shared parity fixtures (documented divergences aside). **Production
  runs the Rust `fuzfd`** (crate `fuz_forge_server`, Axum on the spine
  crates). The **TS Hono server is the reference twin** — run directly on
  Node for tests, benchmarks, and local dev; never compiled or shipped.
- **Client**: the Rust `fuzf` CLI (crate `fuz_forge`) — a forge client, not a
  parity twin.
- **Provisioning and deploy**: the standalone `zap` CLI, driven by `zap.ts` /
  `zap.forge2.ts`. The forge carries no convergence engine.
- **Hosts**: no hosted instance; a forge is self-hosted at an
  operator-configured `<forge-host>`. Its own binaries are to ship via GitHub
  Releases (none yet); see ./docs/distribution.md.

## Scope

Three use cases (./docs/forge.md § Initial focus) — hold the UX to these:
(1) **mirroring** git repos behind auth (push-primary, no anonymous read),
(2) **reviewing** commits and diffs as a reader (no PR/comment workflow),
(3) **moving files** to/from the server and self-hosting Fuz's first-party
signed tool registry.

## Layout

- ./zap.ts — forge (Debian/systemd) provisioning + deploy config; ./zap.forge2.ts — forge2 (Alpine/OpenRC)
- ./gro.config.ts — Gro config: the dev-server plugin (`gro_plugin_server`) and the cargo plugin that builds `fuzf` + `fuzfd`
- ./package.json — the operator scripts (`npm run <name>`); ./Cargo.toml — Rust workspace
- ./src/lib/action_specs.ts — action specs; the `*.gen.ts` beside it generate the action types
- ./src/lib/fuz_forge/ — forge-domain helpers shared by server and UI: `repo/` (repo id + slug grammar, the repo-cell narrow `plan_repo`, storage, `seed_from`, the `repo list --since` grammar), `file_meta.ts`, `build_info.ts`
- ./src/lib/server/ — the TS reference server: `server.ts` + `app_assembly.ts` (composition), `server_main.ts` (entry), `subprocess.ts` (the `git` / `chmod` subprocess primitives), `env/`, `db/` (migrations, token-policy schema + queries), `git/` (parse + read), `routes/` (RPC handlers, file store, git smart-HTTP, internal hook callbacks)
- ./src/lib/ui/ — Svelte state classes and the RPC/WS app wiring (`fuz_forge_app.svelte.ts`, `fuz_forge_notification_bus.ts`)
- ./src/lib/runtime/ — platform-boundary helpers for the TS entries (tilde expansion, byte concat)
- ./src/lib/nginx_locations.ts — the nginx `location` blocks both deploy configs share
- ./src/routes/ — the landing, about, signup and `docs/` pages, and the `/admin/*` dashboard
- ./src/test/ — tests, see ./src/test/CLAUDE.md; `fixtures/parity/` holds the TS↔Rust case tables both backends assert against
- ./src/tasks/ — the Gro tasks behind the operator scripts (`dev_setup`, `dev_reset`, `prod_setup`, `db_status`, `release`), thin roots over ./src/lib/setup/ (the env files, the dev and prod setup flows, the dev-DB status) and ./src/lib/release.ts; outside `src/lib/` so their `task` and `Args` exports stay out of the docs' flat namespace
- ./docs/ — `forge.md` (repo hosting), `distribution.md` (artifacts + file store), `auth_walkthrough.md` (auth checklist), `deploy.md` (server env + fleet)
- ./crates/fuz_forge_server/ — the Rust backend + `fuzfd` binary
- ./crates/testing_fuz_forge_server/ — the `testing_fuzfd` binary for cross-process tests (fast hasher + the `fuz_testing` seams)
- ./crates/fuz_forge/ — the `fuzf` client
- ./crates/fuz_forge_wire/ — wire validators (slug / repo-id grammar) and the typed output DTOs shared by `fuzf` and `fuzfd`; its `output` module doc states the serialization invariants
- ./crates/xtask/ — `cargo xtask check-release`
- `dist_artifacts/` — `gro build` output: `fuzf`, `fuzfd`, each with a `.sha512` (gitignored)

TS ↔ Rust twins pair file for file, for example `server/routes/fuz_forge_repo_{read,write,cell}.ts` + `fuz_forge_token.ts` ↔ `handlers/{repo_read,repo_write,repo_cell,token}.rs`; `repo_git.ts` / `repo_git_auth.ts` / `git_cgi.ts` ↔ `forge_git/{mod,auth,cgi}.rs`; `fuz_forge_token_surfaces.ts` ↔ `token_surfaces.rs`; `subprocess.ts`, `query_params.ts` ↔ the same names in `.rs`.

`testing_fuzfd` never ships: the build and the release name their binaries by
an exact allowlist (`gro.config.ts`, `src/lib/release.ts`), and
`cargo xtask check-release` audits the release dep graph (no production binary
links `fuz_testing` / `fuz_audit`, plus layering and test-only features).

## Architecture

- **SPA auth** — the client fetches `GET /api/account/status` on load and
  renders bootstrap / login / dashboard from it.
- **One RPC endpoint + one WebSocket** — `/api/rpc` (JSON-RPC 2.0, GET + POST)
  and `/api/ws`, both built in `src/lib/server/routes/fuz_forge_route_specs.ts`
  and mounted by fuz_app. The WS serves the RPC endpoint's action set and is
  admin-gated at upgrade. The frontend `FuzForgeApp` is one
  `create_frontend_rpc_client` call with a `ws` lane: spec actions go over the
  WS, HTTP RPC is the fallback (reads as `GET`s), and login, bootstrap, and the
  file store are REST routes.
- **Facts + cells** — immutable blake3-addressed facts plus mutable JSONB cells,
  in PostgreSQL (dev included). Repos and stored files are cells; file bytes
  are facts. The substrate comes from `@fuzdev/fuz_app` (TS) and the spine
  crates (Rust).
- **Explicit subscriptions** — the `fuz_forge_repo_updated` broadcast reaches
  clients that subscribe via `fuz_forge_app.on_notification(method, handler)`.

## Development

### First-time setup

```bash
npm i
npm run dev:setup                      # copies .env, generates secrets, creates the DB
createdb fuz_forge_test                # required to run the tests
npm run dev:fuzf -- init --server http://localhost:4041   # writes the project-local .fuz_forge/config.json
gro dev                                # Vite + the TS server on 127.0.0.1:4041 (`npm run dev:server` for the server alone)
```

Then bootstrap the keeper account at `/admin` with the token in
`.fuz_forge/secret_bootstrap_token` (`dev:setup` prints the command to read it), mint an API token at
`/admin/account`, and write it to `.fuz_forge/api_token` so `dev:fuzf` can
reach the server.

### Commands

`gro check` validates the TS side; `gro build` builds the site and both
binaries. `rust-toolchain.toml` pins the Rust toolchain. CI
(`.github/workflows/check.yml`) runs `gro check --build` (the site only: the
cargo step skips without `fuz`) and the Rust commands below
plus the `#[ignore]` Postgres suites, with `fuz` and `zap` checked out beside
the repo.

```bash
cargo build --workspace
cargo fmt -p fuz_forge -p fuz_forge_server -p fuz_forge_wire -p testing_fuz_forge_server -p xtask --check
cargo clippy --workspace --all-targets -- -D warnings   # workspace lints in Cargo.toml
cargo test --workspace
cargo xtask check-release        # release dep-graph audit

# Rustdoc — the only command that enforces the doc-link gate
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --workspace --document-private-items
```

`cargo fmt` names every workspace package rather than taking `--all`:
rustfmt follows path dependencies, so `--all` would format the sibling spine
checkout too. Clippy takes `--all-targets` so test code is linted.

Run the rustdoc command when a doc comment's links move. Keep
`--document-private-items` — without it, links in private items go unchecked.
It passes at zero warnings; `private_intra_doc_links` is allowed in
`Cargo.toml`, since module headers point at private members on purpose.

### package.json scripts

Run each with `npm run <name>`. Arguments go after `--`
(`npm run deploy -- --wetrun`): npm reads a flag before it as its own, so
`npm run deploy --wetrun` runs the dry run.

| script | does |
| --- | --- |
| `dev:setup` / `dev:reset` | first-time dev setup / drop and recreate the dev DB and re-mint the bootstrap token; both use the project's `.fuz_forge/` as the forge home, and run `createdb` / `dropdb` against the server `.env.development`'s `DATABASE_URL` names (libpq `PG*` variables fill what the URL leaves out), failing unless that Postgres database ends up created or reset (`memory://` needs neither) |
| `dev:server` | run the TS reference server alone, with `.env.development` and the project-local home (sets `NODE_ENV=development`) |
| `dev:fuzf` | run `fuzf` against the project-local home (`FUZ_FORGE_HOME=$PWD/.fuz_forge`) |
| `prod:setup` | create forge's operator `.env.production` from its example |
| `db:status` | dev-DB connectivity, tables, and migration state from `.env.development` (exits 1 when the URL is missing or unreachable) |
| `apply` / `apply:bootstrap` / `deploy` | provision / first-provision / deploy **forge** via `zap` |
| `apply:forge2` / `apply:forge2:bootstrap` / `deploy:forge2` | the same for **forge2** |
| `install:fuzf` | build `fuzf` and copy it to `~/.local/bin/` |
| `release` | check the version, the build env, the tree, and `gh`, then `gro build` and a GitHub release |

The setup, status, and release scripts are Gro tasks in ./src/tasks/, so
`gro task src/tasks/<name>.task.ts` runs one directly and `--help` describes
it; each takes no arguments and refuses any. `apply*` / `deploy*` need `zap`
on `PATH` and `ZAP_FGRO` naming the fgro build the configs' locks pin, and are
dry runs until `--wetrun`; see ./docs/deploy.md.

## CLI

`fuzf` talks to a running forge; it never provisions machines. `fuzf --help`
is the full surface:

- `init` — write the server URL to `<home>/config.json`
- `file put|get|list|delete` — the content-addressed file store
- `repo list|create|view|clone|log|show|refs|resync` — forge repos over JSON-RPC
- `tool publish` — sign and upload a first-party tool artifact (./docs/distribution.md)
- `version`

`fuzf` exits `2` when the caller must change something local (arguments,
config, credentials) and `1` otherwise — the contract is in the crate doc
(`crates/fuz_forge/src/main.rs`).

`fuzfd` takes one of two commands: `fuzfd start` runs the server in the
foreground (the service units pass it), and `fuzfd db-status` reports
migration status for the `DATABASE_URL` in its process env (the same report as
`npm run db:status`, which reads `.env.development`). `--help` prints usage;
anything else prints usage and exits 2.

### Client state

```
<home>/                    # FUZ_FORGE_HOME (tilde-expanded, must be absolute) if set, else ~/.fuz_forge
├── config.json            # server URL, written by fuzf init
└── api_token              # bearer token for the CLI
```

The server URL resolves from `FUZ_FORGE_BASE_URL` (blank = unset) →
`config.json` (`tool publish` also takes `--server` first); the token from
`FUZ_FORGE_TOKEN` → `api_token`. The URL must be `https://`, or `http://` to
`localhost` / `127.0.0.1` / `[::1]`, and carry no userinfo, query, or
fragment: the policy **is** `fuz_storage::base_url`, the one `forge://`
storage applies, validated once per command. The client is
`fuz_storage::forge_client_builder`'s with redirects refused, so the `file`
and `repo` commands follow no redirect; a refused URL is worded by
`forge_base_url_refusal_message`. `fuz`'s `forge://` storage shares the home,
token, and `FUZ_FORGE_BASE_URL` resolver (not `config.json`). Response bodies
are bounded (downloads by `MAX_TRANSFER_SIZE`, listings by
`MAX_FORGE_LIST_SIZE`, RPC answers by `MAX_RPC_RESPONSE_SIZE`), and server
text in an error is escaped. The client never touches the database. On a server host
the same home also holds the fact store (`facts/`), the repo store (`repos/`),
and — where `FUZ_BOOTSTRAP_TOKEN_PATH` points there, as the dev tasks and Zap
deploys do — `secret_bootstrap_token`.

## Server env

The env table, and how each backend loads it, is ./docs/deploy.md § Server env.

## Build

`gro build` compiles `fuzf` and `fuzfd` with `cargo build --release` into
`dist_artifacts/`. Knobs: `FUZ_FORGE_BUILD_TARGET=x86_64-unknown-linux-musl`
builds static musl binaries via `cargo zigbuild` (needs `cargo-zigbuild` + `zig`)
— a musl build publishes as a tool with `--target x86_64-unknown-linux-musl`,
since a static binary is refused under a glibc publisher's default target;
`FUZ_FORGE_BUILD_SKIP_SERVER=1` builds `fuzf` only. Every crate but
`fuz_forge_wire` path-deps the sibling `fuz/` checkout (paths in
`Cargo.toml`); when it is absent the cargo step skips with a warning. Both
variables and the checkout's presence are in the build cache key
(`build_cache_config`), so a build under one setting is never reused for
another at the same commit; changes inside `../fuz` aren't, so rebuild with
`gro build --force_build` after the spine checkout changes.

## Deploy

Two targets: **forge** (Debian/glibc, `zap.ts`) and **forge2** (Alpine/musl,
`zap.forge2.ts`). Both serve the SPA via nginx with `fuzfd` behind it. See
./docs/deploy.md.

## Auth & access

Auth via the fuz_app account + role-grant system: cookie sessions (browser) and
API tokens (CLI; the account's full authority unless narrowed by
`fuz_forge_token_create_scoped`; scoped tokens are HTTP-only). See
./docs/forge.md § Authentication and ./docs/auth_walkthrough.md § Scoped API
tokens.

## Code conventions

- **State classes** compose `AsyncSlot`s from
  `@fuzdev/fuz_app/ui/async_slot.svelte.ts`, one per async operation, instead of
  `loading_*` / `error_*` scalars; `KeyedAsyncSlot` for per-row in-flight state.
  Use `$state` / `$derived`, avoid `$effect`; expose `dispose()` when cleanup
  is needed.
- **API design** — no optional parameters, an options object for 3+ params,
  no silent defaults.
- A schema change goes with any feature that changes a shape.

## Type checking & testing

- TS (`gro check`) — the TS server, runtime helpers, `src/lib/fuz_forge/`,
  SvelteKit, tests, Svelte components, the operator tasks, root `*.ts` configs
- Rust (`cargo clippy --workspace --all-targets`) — the crates

See ./src/test/CLAUDE.md for testing patterns.
