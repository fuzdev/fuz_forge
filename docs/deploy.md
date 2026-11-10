# Deploy

Server configuration and the fleet deploy. Provisioning and deployment run
through the standalone `zap` CLI (required on `PATH`); its resource types,
`zap.env('NAME')` deferred references, and config authoring are documented
with Zap.

The configs import their recipes from `@fuzdev/zap`, which `npm install` fetches
at the exact version `package.json` pins. The `zap` binary and `fgro` are built
from source ([install guide](https://zap.fuz.dev/docs/install)), and the
binary must be the same 0.x minor as the package.

Zap evaluates each config with `fgro`, Gro's runtime (Zap's `docs/install.md`
§ Getting fgro), and only with the build whose blake3 the config's committed
lock pins (`zap.lock` for `zap.ts`, `zap.forge2.lock` for `zap.forge2.ts`).
Set `ZAP_FGRO` to the absolute path of that build; unlike `zap`, it is never
looked up on `PATH`. After replacing that build, re-pin both configs and
commit the locks:

```bash
zap lock zap.ts
zap lock zap.forge2.ts
```

## Server env

The runtime env: the TS `ServerEnv` schema (`src/lib/server/env/schema.ts`,
over `@fuzdev/fuz_app`'s `BaseServerEnv`) and the Rust `FuzForgeEnv`
(`crates/fuz_forge_server/src/env.rs`). The rows below are read by both except
where a row names one backend. Beyond them, `fuzfd` reads `RUST_LOG`, and both
pass `PATH` to git.

`fuzfd start` reads only its process env; on a host the service unit injects
`shared/.env.production` (CLI contract: ../CLAUDE.md § CLI). The TS reference
server can load a file beneath its process env (`server_main.ts --env_file`);
`npm run dev:server` and `gro dev` use `.env.development` with the
project-local `.fuz_forge/`.

`fuzfd` exits 2 when a start fails on configuration — a variable below, or a
database whose `default_transaction_isolation` is not `read committed` (the
spine relies on it, so it refuses before migrating) — and 1 on any other
start failure, printing the error's cause chain and, where one applies, a hint.

| variable | default | what it does |
| --- | --- | --- |
| `NODE_ENV` | required (TS) | `development` / `production`; `fuzfd` ignores it |
| `HOST` / `PORT` | TS `localhost` / `4040`; Rust `127.0.0.1` / `4041` | bind address |
| `FUZ_ALLOWED_ORIGINS` | required | spine origin allowlist |
| `FUZ_ALLOW_ORIGIN_WILDCARDS` | unset (refuse) | exactly `true` lets a wildcard `FUZ_ALLOWED_ORIGINS` entry (a `:*` port, a `*` host label) boot, with a warning on every boot; unset or `false` refuses to boot with one, and any other value fails the env. List exact origins in production |
| `DATABASE_URL`, `SECRET_FUZ_COOKIE_KEYS` | required (TS); Rust boots probes-only (`/health`, `/`) without `DATABASE_URL` and needs the keys only with it | spine database and cookie signing keys |
| `FUZ_BOOTSTRAP_TOKEN_PATH` | unset (bootstrap off) | where the first-account bootstrap token is read |
| `FUZ_DB_CHECKOUT_TIMEOUT_MS` | 5000 | bound on the pool checkouts a request makes, `1`–`600000` ms; a failed checkout answers 503 `service_unavailable` (a failed query keeps its 500). Audit writes use the audit bound, the failed-login row a request waits on included. A checkout that waits and then connects can take about twice the bound. Postgres only |
| `FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS` | 30000 | bound on the checkout behind each audit pool write, so a saturated pool doesn't drop failure rows; a dropped row is logged in full. A failed login waits on its row, so up to this bound. Postgres only |
| `FUZ_FORGE_HOME` | `~/.fuz_forge` | tilde-expanded root the store defaults hang off |
| `FUZ_FORGE_FACT_STORE_PATH` / `FUZ_FORGE_REPO_STORE_PATH` | `<home>/facts` / `<home>/repos` | store overrides, tilde-expanded |
| `FUZ_FORGE_FILE_STORE_MAX_BYTES` | 10 GiB | per-upload cap on the file store; the deploy configs set it to nginx's `client_max_body_size` (`FORGE_FILE_STORE_MAX_BYTES` in `src/lib/nginx_locations.ts`) |
| `FUZ_FORGE_FILE_STORE_FREE_SPACE_MARGIN_BYTES` | 1 GiB | free-space headroom kept beyond a declared upload (`507 storage_full`) |
| `FUZ_FORGE_FILE_STORE_MAX_CONCURRENT_UPLOADS` | 4 | streaming-upload semaphore |
| `FUZ_FORGE_TRUSTED_PROXIES` | `127.0.0.1,::1` | proxies whose `X-Forwarded-For` is trusted for the client IP (Rust; TS hardcodes loopback). A value that parses empty (`,`) opts out of XFF trust only — the client-IP layer still mounts and keys on the TCP peer |
| `FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS` | `false` | admit loopback / link-local / private-range `seed_from` hosts (LAN mirrors) — a stringbool; see ./forge.md § seed_from host policy |

A numeric var is decimal digits after at most one leading `+`, surrounding
whitespace trimmed, on both backends (`5e3`, `0x10`, and a blank value fail
the env); a stringbool is
`true`/`1`/`yes`/`on`/`y`/`enabled` or `false`/`0`/`no`/`off`/`n`/`disabled`,
any case, untrimmed.

The `FUZ_*_RATE_LIMIT_*` vars affect only the test binaries
(../src/test/CLAUDE.md); production limiters are always on.

## Targets

| target | host | OS | Zap config | operator env (gitignored) | committed template | scripts |
| --- | --- | --- | --- | --- | --- | --- |
| forge | `<forge-host>` | Debian 13 / glibc, apt + systemd | `zap.ts` | `.env.production` | `.env.production.example` | `apply` / `deploy` |
| forge2 | `<forge2-host>` | Alpine / musl, apk + OpenRC, nftables, bubblewrap | `zap.forge2.ts` | `.env.production.forge2` | `.env.production.forge2.example` | `apply:forge2` / `deploy:forge2` |

Both serve the prerendered SPA via nginx and run `fuzfd` behind it. A new
target `forgeN` is `zap.forgeN.ts` + `.env.production.forgeN` (+ `.example`) +
`apply:forgeN` / `deploy:forgeN` scripts in `package.json`.

## Operator env files

Each `.env.production[.<target>]` is read by `zap` to resolve the
`zap.env('NAME')` references in that target's config: `DEPLOY_HOST`,
`DEPLOY_USER`, `DEPLOY_DOMAIN`, `DEPLOY_CERTBOT_EMAIL` (read by Zap's certbot
recipes), `SECRET_FUZ_COOKIE_KEYS`, and on Alpine `BOOTSTRAP_USER`. Copy the
committed `.example` and fill the blanks.

It is not the app's runtime env: the host's `shared/.env.production` is
rendered on the host by Zap from the config's `ENV_TEMPLATE` (`NODE_ENV`,
`HOST`, `PORT`, `DATABASE_URL`, the cookie keys, `FUZ_BOOTSTRAP_TOKEN_PATH`,
`FUZ_ALLOWED_ORIGINS`, `FUZ_FORGE_TRUSTED_PROXIES=127.0.0.1`, and
`FUZ_FORGE_FILE_STORE_MAX_BYTES`). Another
setting from the table above goes on a host by adding it to `ENV_TEMPLATE`.

The frontend reads no env: the SPA reaches the backend on its own origin
(`/api/rpc`, `/api/ws`), so one build serves every host.

Generate `SECRET_FUZ_COOKIE_KEYS` with `openssl rand -hex 32`; rotate by
joining keys with `__` (`new_key__old_key`). Re-applying with a changed key
restarts `fuzfd` under it, invalidating existing browser sessions.

## apply → deploy

Each `apply*` / `deploy*` script is a dry run that prints its plan; the same
script plus `--wetrun` executes only the plan that dry run showed (`npm run
deploy:forge2`, then `npm run deploy:forge2 -- --wetrun`). The `--` matters:
npm takes a flag before it as its own, so `npm run deploy:forge2 --wetrun` is
the dry run again.

1. **apply** — converge the host: packages, users, swap, firewall, fail2ban,
   SSH hardening, nginx, the systemd/OpenRC unit, PostgreSQL, TLS, the
   bootstrap token. A changed env file restarts the service.
2. **deploy** — `gro build` (static frontend, `fuzf`, `fuzfd`) → tarball →
   upload → atomic release-symlink swap → restart the service → poll `/ready`,
   the schema-drift gate over the committed `expected_schema.json`. A drifted or
   DB-unreachable release answers 503 and rolls back.

`deploy` refuses to run while the host's apply-managed state has drifted:
preview with `npm run apply[:forge2]`, converge with `-- --wetrun`, then deploy.

## forge2: musl binaries

forge2 needs static musl `fuzfd` / `fuzf`. `zap.forge2.ts`'s build command sets
`FUZ_FORGE_BUILD_TARGET=x86_64-unknown-linux-musl`, so the `gro build` cargo
plugin compiles with `cargo zigbuild --target <triple>`. The deploy machine
needs `cargo-zigbuild` and `zig` on `PATH`; the rustup musl std is added on
demand. The variable is part of the build cache key, so `deploy:forge2` and a
plain `gro build` (`deploy`, `release`) at the same commit each build their own
target rather than reusing the other's binaries.

## On the host

- **First account** — after the first deploy, read
  `/home/fuz_forge/.fuz_forge/secret_bootstrap_token` on the host and submit it
  at `https://<domain>/admin`.
- **Logs** — forge: `journalctl -u fuz_forge`; forge2:
  `/var/log/fuz_forge/server.log`.
- **Migration status** — `fuzfd db-status` with the env loaded: `set -a; .
  /home/fuz_forge/app/shared/.env.production;
  /home/fuz_forge/app/current/dist_artifacts/fuzfd db-status` (as `fuz_forge`).
- **Runtime dependencies** — git and `python3` (the repo hooks; a host without
  it refuses every push), both installed by `apply`.
- **Store overrides** — a `FUZ_FORGE_FACT_STORE_PATH` /
  `FUZ_FORGE_REPO_STORE_PATH` outside `/home/fuz_forge/.fuz_forge` must also be
  added to the config's `read_write_paths`, or the sandbox keeps it read-only.
- **Deploy machine** — the sibling `fuz/` checkout must be present (without
  it `gro build` skips the cargo step with a warning and ships no `fuzfd`), and
  `npm i` must have installed the `@fuzdev/zap` package.

## Fresh Alpine box

A never-provisioned Alpine host runs `npm run apply:forge2:bootstrap`, then
the same with `-- --wetrun`, once. `--bootstrap` connects as the stock
cloud-image login user (`BOOTSTRAP_USER`, `alpine` on the official image),
provisions and hardens, creates `fuz_forge`, and locks the bootstrap user out.
Every later `apply:forge2` / `deploy:forge2` connects as `fuz_forge`.

The Debian equivalent is `npm run apply:bootstrap`, which connects as `root`.
