# Test Infrastructure

> Tests run in vitest (Node.js), not Deno

The TS reference server runs in **Deno**; its tests run in **vitest**
(Node.js), with `RuntimeDeps` (from `@fuzdev/fuz_app`) mocked by
`runtime_mock.ts`. The `fuzf` client is Rust, tested in `crates/fuz_forge/`.

Tests mirror `src/lib/` (per the [fuz-stack skill](https://docs.fuz.dev/skills/fuz-stack)); vitest auto-discovers new
files. A shared fixture or helper sits where what it *is* belongs, not where
its readers are (§ Route / RPC Integration Tests).

## Layout

```
src/test/
├── CLAUDE.md                           # this file
├── runtime_mock.ts                     # RuntimeDeps mock
├── db_fixture.ts                       # describe_db + db_factories (Postgres)
├── git_upstream_server.ts              # loopback dumb-HTTP git origin for `seed_from` clones
├── action_spec_input_invariants.test.ts
├── nginx_locations.test.ts
├── fixtures/parity/                    # shared TS↔Rust case tables + the TS loader (§ Parity fixtures)
├── cross_backend/                      # *.cross.test.ts — a spawned backend over HTTP
├── runtime/                            # path/tilde expansion, byte-chunk concatenation
├── server/routes/                      # route/RPC integration, attack surface, files, repo_git, scoped tokens
├── server/git/                         # git parse + read (stderr classification chain)
├── server/env/                         # the `ServerEnv` contract (canonical vs. retired names)
├── server/                             # free_space, token policy, query params, timestamp, token surfaces + census, schema-ready
├── fuz_forge/repo/                     # plan_repo, storage, repo_id (types), seed_from, repo_list_since
└── ui/                                 # UI state classes, browse URL grammar
```

Rust-side suites:

- `crates/fuz_forge_server/tests/` — the parity-fixture census, the forge's
  surface census, and the git admin-gate twin (each the Rust half of a row in
  § In-process parity suites); `signed_tool_install.rs` (its counterpart is
  `fuz_sign`'s own `FileStorage` loop, not a TS twin); `columns.rs`, the
  column-drift guard; `upkeep.rs`, which pins that `run_app` schedules its
  upkeep tasks (`runtime::upkeep_options`; the sweeps themselves are tested in
  `fuz_auth` and `fuz_fact`); `fuzfd_args.rs`, `fuzfd`'s command parsing and
  exit codes.
- `crates/fuz_forge/tests/` — the real `fuzf` binary, offline: home
  resolution, `tool publish`'s key loading, `repo clone`'s flag rules.
- `crates/testing_fuz_forge_server/tests/` — `testing_fuzfd_args.rs`, the test
  binary's command line.

`fuzfd_args.rs`, `testing_fuzfd_args.rs` and the `fuzf` suites need no
database and run in `cargo test --workspace`; the `#[ignore]`d ones are in
§ Running.

## Running

```bash
npm test              # gro test → vitest
gro check             # full check
deno task check       # Deno type-check (TS server/backend, excludes src/test/)

# the cross-backend projects are gated, so a bare `gro test` stays in-process:
export FUZ_TEST_CROSS_BACKEND=1
# the `_rust` projects' `fuz_forge_test_rust` is created by their setup when missing
# the parity project also uses `fuz_forge_test_ts_parity`, which its setup creates and empties
npx vitest run --project cross_backend_ts_deno                 # TS (Deno), in-memory pglet
npx vitest run --project cross_backend_rust                    # Rust (testing_fuzfd, Axum)
npx vitest run --project cross_backend_parity                  # dual-spawn, both on Postgres: schemas, registries, differential
npx vitest run --project cross_backend_login_security_ts_deno  # own pair, limiters ENABLED
npx vitest run --project cross_backend_login_security_rust
```

Run those **one at a time**. `groupOrder` orders projects only inside one
run, so concurrent cross runs — or a cross run overlapping a `.db.test.ts`
run — collide on the fixed ports *and* on the local Postgres that the `db`
project and the Rust cross projects share.

The Rust suites `#[ignore]`d behind a real Postgres
(`FUZ_FORGE_SERVER_TEST_URL`, default `postgres://localhost/fuz_forge_server_test`)
sit outside `cargo test --workspace`: `repo_git_auth`,
`signed_tool_install`, `columns`, `upkeep`. CI's `rust` job runs them against a
Postgres service; locally, run them when the path they gate moves:
`cargo test -p fuz_forge_server -- --ignored --test-threads=1`, or add
`--test <name>` for one. Each drops and recreates the `public` schema of that
one database, hence the single thread. The reset (via `tests/common/`: bare
for `repo_git_auth` and `signed_tool_install`, whose `build_router` call runs
the migrations; migrated for `columns` and `upkeep`), the account / actor /
admin-grant seeding, and the `columns` assertion come from the spine's
`fuz_testing`, a dev-dependency only — it never reaches `fuzfd`, and
`cargo xtask check-release`, walking runtime dependencies, ignores it.

CI runs the rustdoc doc-link gate too; the command and its pass condition are
in the root CLAUDE.md § Commands.

## Parity fixtures (`fixtures/parity/`)

Every pure function the two backends implement twice — the git stderr
classifiers, the ref / path / sha validators, the grammars, the token-policy
schema, the raw-query readers, the read-layer constants, the disk-budget
predicate, the surface-authority rule, the reserved cell kinds, the retired env
names, the action rate-limit bounds — keeps its cases in **one JSON fixture** both sides' unit
suites assert against, so a divergence fails a test instead of waiting for a
human to diff two tables. The directory listing is the inventory.

**The envelope** — one file per function (or closely bound family):

```json
{
  "function": "is_safe_ref_name",
  "source_ts": "src/lib/server/git/parse.ts",
  "source_rust": "crates/fuz_forge_server/src/forge_git/parse.rs",
  "counts": {"refs": 35, "generated": 1},
  "tables": {"refs": [{"input": "main", "accepted": true}]}
}
```

`source_ts` / `source_rust` are repo-root-relative paths (either may be a
**list**). `counts` is the drift guard both loaders assert: a row added on one
side only fails on both. Row shapes:

| kind | row |
| --- | --- |
| predicate | `{input, accepted, note?}` |
| canonicalizing predicate | `{input, accepted, canonical}` — plus the form the grammar rewrites it to |
| parse predicate | `{input, parses}` — a record framing parses or it doesn't |
| multi-predicate | `{stderr, ref_miss, path_miss, bad_pattern, note?}` |
| transform | `{input, expected}` (plus `key` where the call takes one) |
| json-document | `{document, accepted}` |
| matrix | `{policy, scope, accepted}` — the two-axis surface-authority rule |
| argument list | `{args, accepted}` |
| constants | `{name, value}`, or a name-only `{name}` |
| generated | `{unit, repeat, accepted}` |
| stream | `{stream, expected}` |

Control bytes in stream and record rows are plain JSON escapes (`\u0000` NUL,
`\u001e` RS), readable in the file; both loaders handle them, and `gro format`
leaves JSON untouched.

**The marker rule.** A row one side cannot express carries `"rust_only": true`
or `"ts_only": true`, that side's loader skips it, and the marker always comes
with a `note` naming the missing construct; the consuming site carries the
reason on both sides.

**The censuses.** A fixture is anti-drift only while both sides read it — a
suite refactored back onto a hand-written table leaves the file in place,
correct and silently unshared. So each side asserts its set of consumed
fixtures: `fixtures/parity/parity_fixtures.meta.test.ts` (which also checks
every `source_*` resolves on disk) and
`crates/fuz_forge_server/tests/parity_fixture_census.rs`. The loader contract
is in `fixtures/parity/load.ts`.

Two deliberate exceptions, each explained where it lives: `rate_limits.json`
pins upstream **bounds** and names wiring sites rather than an implementation
(`server/action_rate_limit_bounds.test.ts`), and `crates/fuz_forge_wire` is
not fixture-driven (spine-free and relocatable, so no `include_str!` outside
its own root).

## Cross-backend integration tests (`cross_backend/`)

The TS (Hono/Deno) and Rust (`fuz_forge_server`) backends run the same
wire-shape assertions. The `cross_backend_*` vitest projects spawn a real
backend binary (via `globalSetup`), bootstrap a keeper, and run the shared
`@fuzdev/fuz_app` suites (one `describe_spine_cross_suites` call) plus the
forge-specific suites below.

**This file is the map; each suite documents itself.** What a suite *pins* —
the divergence it caught, the controls its negatives need, why a case has its
shape — goes in that file's `@module` header, beside the assertions. An index
row names the file and the one thing it holds. Don't re-narrate a suite here.

### The testing seams

**Both test servers register the same `_testing_*` methods** — the ones the
spine / fuz_app ship plus the forge's own `_testing_await_signal` — so an
upstream suite reaches the same surface on either backend:

| method | what it does |
| --- | --- |
| `_testing_reset` | auth-table wipe + fresh-keeper re-seed + the forge domain truncate |
| `_testing_drain_effects` | audit barrier before an `audit_log_list` read — awaits the emitter's in-flight writes |
| `_testing_flood_notifications` | a burst of notifications onto the caller's own socket, for the outbound-overflow cases (refuses over HTTP) |
| `_testing_mint_session` | expired-by-construction server-side session |
| `_testing_put_fact` | seed a fact row without a store handle — embedded, or external naming a given URL |
| `_testing_schema_snapshot` | live DB schema, for the schema-parity gate |
| `_testing_migration_tracker` | `schema_version` rows, for migration identity |
| `_testing_origin_check` | the origin allowlist's parse and match, for the shared conformance table |
| `_testing_shorten_credential_expiry` | pull an account's session and token expiry in (shorten-only, 1–60 s), for the credential-deadline close |
| `_testing_action_manifest` | live RPC registry, for the manifest-parity gate |
| `_testing_await_signal` | forge-local: did a client `cancel` reach the handler's signal |

All but the last gate on the daemon-token credential; `_testing_await_signal`
is account-grain on purpose (the WS transport it serves cannot present a
bearer). The shared `testing_backdoor` suite (in `spine_suites.cross.test.ts`)
pins that gate on both backends, over HTTP RPC and on an admitted `/api/ws`
session socket. Because an unregistered method answers `-32601` rather than
the `401` / `403` (over WS, `forbidden`) refusal, it also pins every
daemon-token seam's registration on both mounts; `_testing_await_signal` is pinned registered on one mount only,
over WS, by `ws_cancel.cross.test.ts`.

`_testing_action_manifest` dumps the mounted method set, so it is built *after*
the rest of the registry: each backend has a **last-position** injection seam
beside the ordinary extras one (Rust `RunAppOptions.final_action_specs_factory`,
TS `ServerTestingOptions.final_rpc_actions_factory`); production passes none.
The spawned binaries are `src/lib/server/testing_server_deno.ts` (over
`testing_server_build.ts`) and the `crates/testing_fuz_forge_server` crate;
each header lists its seams. The TS seams are one list in
`src/lib/server/testing_rpc_actions.ts`, which the binary mounts and
`cross_backend/fuz_forge_rpc_mount.ts` builds the suites' live mount from
(`fuz_forge_live_rpc_endpoints`, beside the declared
`fuz_forge_rpc_endpoints`).

### Suite index

Each row is `cross_backend/<name>.cross.test.ts`. The shared upstream
suites, the dual-spawn gates, and the in-process suites holding the
other half of a parity contract have their own sections below.

| file | what it pins | notes |
| --- | --- | --- |
| `action_throttle_order` | the dispatcher's phase order — 429 **ahead** of input validation (401 → 403 → 429 → 400) — over HTTP RPC and `/api/ws`, one account budget shared by both | limiter-enabled spawn pair; each case spends a full per-account budget (the test cap, `LOGIN_SECURITY_ACTION_RATE_LIMIT_MAX_ATTEMPTS`) on a dedicated account |
| `body_limit` | the canonical 413 at `/api/rpc`, a probe and unrouted paths, plus cap-before-origin ordering | over-cap cases send the request head alone (fuz_app's `raw_http_send_head`) |
| `consumer_surface_scoped_token` | the spine-scope axis over forge's own non-RPC surfaces, each with a full-token control | |
| `db_admin_parity` | the browsable-table allowlist, the paging-400 spellings, and the query gate's phase order across anon / roleless / admin | the mount and its ordering are the spine's |
| `db_admin_session_only` | every bearer, narrowed or full, refused at the credential channel before scope and role gates | |
| `files` | the store's CRUD contract — upload status matrix, `?meta` projection (presence, not value), delete, content-type table, unbounded list, `acting` phase order, the file cell's fact address (a foreign `file:` row is a missing file) | the large list seed is the slow case, slowest on Deno |
| `files_disk_budget` | the streaming edges — Content-Length 413, empty-body 400, multi-KB round-trip + dedup | the 507 `storage_full` path is unit-covered per backend (no shared `extra_env` knob makes it deterministic) |
| `files_scoped_token` | the per-file policy gates, the `acting` selector's 400s, `uploaded_at`'s wire shape | |
| `internal_callback` | the loopback-gated `/internal/*` 401-negatives, body strictness, the over-cap 413 before the secret compare, and that only a served repo cell names a secret (the reserved-kind create refusal, the lookup's kind + path fence) | |
| `origin_scope` | *where* the origin check mounts — every path (probes, git smart-HTTP, the 404 fallback) refuses a disallowed `Origin`; `/internal/*`, the one carve-out, answers its own 401; the file store and git refuse it ahead of an over-cap body | companion to the upstream `origin` suite, which pins *what* the check does |
| `protocol_actions_http` | `heartbeat`'s 404 and `peer/ping`'s `peer_no_transport` over HTTP, plus `/api/rpc`'s POST-envelope and GET contracts | |
| `repo_create_seed_from` | the `seed_from` grammar refusal on the wire, the clone-failure envelope + cell unwind, canonicalization over a real loopback upstream | both spawns set `FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS=true`; the default-on host policy is pinned in-process |
| `repo_git_auth` | the git smart-HTTP 401-negatives, including post-`account_delete` against a pre-delete 200 control | the tombstoned-actor half has no wire spelling — see the in-process twins |
| `repo_git_routing` | the one clone-URL grammar either backend serves, and the `?service=` refusal past it | asserts *no* status or body on refusals: not-a-route behavior differs by design (the TS route regex is wider than the grammar and answers 401 where it matches) |
| `repo_git_slug_case` | case-insensitive repo-slug lookup | |
| `repo_id_grammar` | grammar-invalid `id` → `-32602` vs valid-but-absent → `-32003`, and the spine's serde-typed UUID fields | |
| `repo_log_list_filters` | `repo_log` author/since/path + `repo_list` slug_prefix/since, the paged round-trip, the empty-page shapes | the two `since` grammars differ on purpose (below). Needs `git` + `python3` |
| `repo_push` | the whole write path: create → `git push` over smart-HTTP → hook → `/internal` callback → cell `head_sha` → read back | carries the >1 MiB pack and unknown-cell-key tripwires, and the git 404-vs-503 split. Needs `git` + `python3` |
| `repo_read_shapes` | what `repo_push`'s linear history can't reach — merge parents, byte caps, the 404 family, binary blobs, both tag shapes, an uncompilable `--author` | the byte-cap probe pushes two oversized objects, so it stays a cross case |
| `repo_updated_ws` | the `fuz_forge_repo_updated` broadcast frame and `last_pushed_at`'s wire shape | needs `/api/ws` (every TS test binary mounts it) and the `ws` dev dep |
| `rpc_credential_gates` | the session-only gate on the three session-only RPCs, with a bearer positive control | |
| `rpc_input_strictness.shape` | which keys an input admits, which values a declared grammar admits, what `null` means on an optional | failure shows as a refusal one backend gives and the other doesn't |
| `rpc_input_strictness.bounds` | declared string / list / numeric bounds refused, not clamped, each with its accepting edge | split from shape because the wrong answer here is a quieter *success* |
| `rpc_scoped_token` | the `rpc_subset` per-method gate and `token_policy_list` | |
| `server_status` | `GET /api/server/status` → `{version, uptime_ms}` authed, 401 anonymous | |
| `simple_request` | the CORS simple-request 415 on the forge's own `POST`s (raw-byte upload, git, the JSON-only hook callback), each with a typed control reaching its auth gate | the upstream suite over the spine's JSON routes runs in the one call |
| `ws_cancel` | the cancellation *effect* through `_testing_await_signal`, and the silence around the notification form | |
| `ws_envelope` | the socket read-loop classifier frame for frame — version, id, method, params — including the falsy-but-valid ids `0` and `''` | the `parse_error` arm needs a raw socket write, so it is unit-pinned per backend |
| `ws_role_gate` | the upgrade's admin gate — anonymous 401, roleless 403 over cookie and bearer, admin 101 | the whole ACL over `fuz_forge_repo_updated`; neither backend filters broadcasts per recipient |
| `ws_scoped_token` | a narrowed token rejected at the WS upgrade | |

### The two `since` grammars

Held to **different grammars deliberately**, each identical across backends.
`repo_list.since` is a strict UTC ISO 8601 datetime (`RepoListSince` on TS,
`require_iso8601_datetime` on Rust) with two bounds outside the regex,
`MIN_ISO8601_YEAR` and `SINCE_MAX_LENGTH`; off-grammar is `-32602` on both.
`repo_log.since` is git's approxidate, handed to `git log --since=` verbatim —
identical by construction, much wider, never an error. The reasons:
`fuz_forge/repo/repo_list_since.ts` and the `repo_log` describe in
`repo_log_list_filters.cross.test.ts`.

### UUID wire grammar

`z.uuid()` is stricter than every Rust-side UUID parser: Zod 4 admits only the
hyphenated 8-4-4-4-12 hex form (case-insensitive) with an RFC 9562 version
nibble in `1..=8` and a variant nibble in `[89abAB]`, plus the nil UUID and
the **lowercase** max. `Uuid::parse_str` (and Postgres) also take hyphenless,
braced and `urn:uuid:` spellings with any nibbles — so a synthetic id could be
`-32602`/400 on TS and a live lookup on Rust. Every hand-decoding ingress
therefore gates on a canonical validator first: `fuz_http::is_valid_uuid` or
`fuz_forge_wire::is_valid_repo_id`.

The max UUID is the one string the two parser families read apart: a bare
`z.uuid()` takes it in lowercase only, where `is_valid_uuid` takes it in any
case (RFC 9562 §4). fuz_app's `Uuid` closes the gap with a `pattern` on
`z.uuid()` taking the max in any case, the grammar of its `@fuzdev/fuz_schema`
twin, so on the `?acting=` query, hand-decoded params and spine RPC id field
rows below both backends read an uppercase or mixed-case max as an id naming
nothing (a 401 or `actor_not_on_account` on a query route, a not-found such
as `-32003` elsewhere); the differential's hand-written cases pin the spine
RPC id field case (`cell_get`). `RepoId` carries the same `pattern` and
`is_valid_repo_id` the same any-case max (the `repo_id.json` max rows), so
the forge RPC id fields agree too: one UUID grammar across the stack.

| surface | Rust gate | TS gate |
| --- | --- | --- |
| `?acting=` query | `is_valid_uuid` | `Uuid` |
| `acting` **value**, any spec | `check_acting_selector` | `Uuid.optional()` |
| `acting` **key** on a field-less input | `deny_unknown_fields` | strict object |
| hand-decoded RPC params | `is_valid_uuid` | `Uuid` |
| forge RPC id fields | `is_valid_repo_id` | `RepoId` |
| spine RPC id fields | `deserialize_wire_uuid` | `Uuid` |

The `acting` value row is also a phase contract: a malformed value is
`-32602` *after* the authority gates, so a caller they refuse sees `-32002` —
a shape error would confirm the method exists to someone who may not call it.
Cross rows: `files.cross.test.ts` § acting,
`rpc_input_strictness.shape.cross.test.ts` § rpc input strictness (with the
ordering case), `repo_id_grammar.cross.test.ts` § spine UUID id fields.

## Shared upstream cross suites

`spine_suites.cross.test.ts` runs every shipped `@fuzdev/fuz_app` cross suite
in one `describe_spine_cross_suites` call, on both backends, in the two
standard projects — so a suite added upstream runs here with no file of its
own. Each suite gates its cases on the backend's capabilities
(`fuz_forge_backend_config.ts` states every mount flag); what's left is
stated in that file, never as a backend branch:

- **excluded**, with its reason, shown in the run as a skipped test:
  `actor_lookup` (no resolver mounted).
- **capability skips**: `cell_gated_create: false` (the forge's create
  authorizer reserves its own kinds, not the suite's test policy) skips the
  gated-create, moderation, steward and clone-authorizer cases;
  `ws_role_gated: false` (no second, role-gated WS endpoint) skips the
  role-gated WebSocket suite.
- **`ws_required_roles: [ROLE_ADMIN]`**: the forge's `/api/ws` upgrade is
  admin-gated (`ws_role_gate`: roleless → 403), so the suites that open sockets
  for accounts they create (`credential_deadline`, `session_cap`,
  `ws_round_trip`) create them holding admin, and the notification suite
  expects revoking the admin grant to close the socket.
- **`suite_roles: {cell_grant: ROLE_KEEPER, conferral: ROLE_ADMIN}`**: the
  forge's registry holds only the builtins, so `cell_grant_role` grants to
  `keeper` (keeper reach is not admin reach, so every arm still turns on the
  grant) and `role_grant_offer_lifecycle` / `role_grant_participation` offer
  and confer `admin` (the scoped-assign case skips — a builtin is global-only).
- **overrides**: the standard bundle's `round_trip_skip_routes` (git
  smart-HTTP, `/internal/*`, the raw-byte file routes).
- **`testing_backdoors`**: both backend configs declare every backdoor in
  `TESTING_BACKDOOR_METHODS` — both test binaries mount all of them (the
  forge's own `_testing_await_signal` is account-grain, so it stays off the
  list and off `extra_methods`).

fuz_app's **standalone** cross suites, which `describe_spine_cross_suites`
leaves to the consumer, each have a file here:

- `conformance.cross.test.ts` — the conformance table over the generated
  per-method auth rows (`generate_rpc_auth_conformance_cases`) on the whole
  live mount, in the two standard projects: HTTP and `/api/ws` (without the
  `fresh_non_admin` rows — a roleless account can't open the admin-gated
  socket), each again on a multi-actor keeper. fuz_app's hand-written rows
  are its own spine's and don't run here.
- `differential.cross.test.ts` — the same rows sent to both backends over
  the same four legs, the normalized answers diffed, in `cross_backend_parity`. Accepted differences
  go in `differential_known_divergences.ts`, each with a tracking id. A
  last group sends hand-written cases no generated row reaches, each
  expecting the answer both backends give.
- `ws_action_rate_limit.cross.test.ts` — the action throttle over a real
  socket and its budget shared with HTTP RPC, on the login-security pair.

**Own spawn pair.** `login_security`, `ws_action_rate_limit` and the forge's
`action_throttle_order` need live rate limiters, which the standard test
binaries disable. The pair reads fuz_app's env contract through each side's
`stringbool` twin (no new env name): `FUZ_LOGIN_RATE_LIMIT_ENABLED` turns the
auth limiters on, and `FUZ_ACTION_RATE_LIMIT_ENABLED` with
`FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS` (fuz_app's `action_rate_limit_env`) the
action pair, capped at `LOGIN_SECURITY_ACTION_RATE_LIMIT_MAX_ATTEMPTS` so a
case reaches the throttle in a few calls. Only the test binaries read the
three (TS `create_testing_wiring`, Rust `testing_fuz_forge_server` into
`RunAppOptions`); production keeps the spine defaults, pinned in-process by
`server/action_rate_limit_bounds.test.ts`. The pair spawns on ports 14051 /
14151 via `login_security_global_setup.ts`, sharing the Rust project's
database; its files are excluded from the standard projects' glob, like the
dual-spawn gates.

`fact_serving.cross.test.ts` holds forge-local cases for what the shared
fact-serving suite can't reach: `_testing_put_fact` writes no file to disk, so an
over-threshold file-store upload is what puts a real external
`file:<shard>/<rest>` row in front of the route, and a seeded row naming that
file pins the URL-to-hash binding.

## In-process parity suites

These in-process suites hold the other half of the TS↔Rust contract.

**Inclusion rule** — a suite earns a row when it is load-bearing for the
contract, and its **why** cell names how: a shared fixture the other backend
reads too (§ Parity fixtures, or the committed `expected_schema.json` behind
both `/ready` gates), a hand-mirrored twin table, state no cross spawn can
construct, or a layer the other backend covers only over the wire. Ordinary
coverage of a surface a cross suite already drives (per-RPC route suites, UI,
env / path / storage helpers, column-drift guards) has no row, and a cross
suite that reads a fixture stays in the index above. Nothing enforces this
table; the censuses enforce only that every fixture has a consumer and every
consumed name is a fixture.

TS paths are `src/test/`-relative. On the Rust side a `path/to.rs` is
`crates/fuz_forge_server/src/`-relative, a `::` path names an item in that
crate, and anything else is spelled from the repo root. **The other side**
names the far half — a crate counterpart, the cross suite that reaches it only
over the wire, or why there is none.

| file | what it pins | why | the other side |
| --- | --- | --- | --- |
| `fixtures/parity/parity_fixtures.meta.test.ts` | that this side still reads every fixture, and each `source_*` path resolves on disk | the fixture directory itself | `crates/fuz_forge_server/tests/parity_fixture_census.rs` |
| `fuz_forge/repo/types.test.ts` | the `RepoId` / `RepoSlug` grammars, over the union of both sides' former suites | `repo_id.json`, `repo_slug.json` | `handlers/repo_id.rs`, `forge_git/auth.rs`, and the `fuzf` client's `crates/fuz_forge/src/repo_id.rs`, all over `fuz_forge_wire` |
| `fuz_forge/repo/seed_from.test.ts` | the `seed_from` grammar, its canonicalization, and the host-range policy | `seed_from_url.json`, `seed_from_host_policy.json` | `handlers/seed_from.rs`. The *breadth* lives here — every range bound, both `localhost` forms, the IPv4-mapped and folded-integer spellings |
| `fuz_forge/repo/storage.test.ts` | the `seed_from` clone's `-c` overrides and argv, plus a real clone that refuses a redirect without dialing its target and refuses a non-http transport | `seed_clone.json` | `repo_storage.rs` tests, which run the same two real clones; both sides mutation-checked |
| `fuz_forge/repo/repo_list_since.test.ts` | the `repo_list.since` ISO 8601 grammar and its two out-of-regex bounds | `repo_list_since.json` | `handlers/repo_list_since.rs` |
| `server/action_rate_limit_bounds.test.ts` | the per-IP + per-account action budgets (the spine defaults the forge inherits by passing no limiter), and how the test-mode gates resolve — `FUZ_LOGIN_RATE_LIMIT_ENABLED` to a limiter mode, the action pair to two capped limiters | `rate_limits.json` | `router::compose::tests::action_rate_limit_bounds_match_the_ts_twin`; the gates' twins are `testing_fuz_forge_server`'s own tests |
| `server/env/schema.test.ts` | the canonical spine names are read and the retired `FUZ_FORGE_`-prefixed spellings are not | `env_retired.json` | `env::tests` |
| `server/fuz_forge_cell_create_authorize.test.ts` | the reserved cell kinds and the create predicate over them | `cell_create_reserved_kinds.json` | `cell_create_authorize.rs` |
| `server/free_space.test.ts` | the disk-budget predicate's accept / reject arithmetic, plus the probe's fail-open `null` | `free_space.json` | `files/disk_budget.rs` |
| `server/fuz_forge_token_policy.test.ts` | `policy_check`, `capability_string`, and the fail-closed `policy_from_stored` read | `token_policy_schema.json`, `policy_from_stored.json` | `token_policy/tests.rs` |
| `server/fuz_forge_token_surfaces.test.ts` + `.census.test.ts` | the (policy, scope) authority rule, and that the classified surface set matches the live mount | `token_surfaces.json` for the rule; the census reads the live `src/lib` mount, tied by a hand-mirrored twin | `token_surfaces.rs` + `crates/fuz_forge_server/tests/token_surface_census.rs` |
| `server/git/parse.{stderr,validators,records,streams}.test.ts` | the 404-vs-400-vs-503 stderr classifiers, the argv-safety + sha validators, record framing, and the parsers over real captured git streams | `git_stderr_classification.json`, `git_ref_name.json`, `git_full_sha.json`, `git_safe_path.json`, `git_record_field_counts.json`, `git_real_streams.json` | `forge_git/parse/tests.rs` |
| `server/git/read.test.ts` | the read-layer byte caps / page limits, and the stderr classifiers' **order** through an injected stderr | `git_read_bounds.json`, `git_env.json` | `forge_git/read/tests.rs` + `handlers::repo_read`; both sides mutation-checked (swap the checks and each fails) |
| `server/query_params.test.ts` | first-occurrence-wins on a raw query string | `query_param.json` | `query_params.rs` |
| `server/routes/repo_git.service_param.test.ts` | first-occurrence-wins on a duplicated `?service=`, across percent-encoded spellings of the key | `service_param.json` | `forge_git/mod.rs` |
| `server/schema_ready.db.test.ts` | the committed `expected_schema.json` still matches a fresh bootstrap, and the drift check flags a missing table or column | `src/lib/server/expected_schema.json`, which the other backend reads verbatim | `router::FUZ_FORGE_BACKEND_SPEC`, whose `expected_schema_json` `include_str!`s the same file; the spine's `create_app_backend` builds `/ready` from it |
| `fuz_forge/repo/plan_repo.test.ts` | the repo-cell narrow's null-on-missing behavior | a corrupt cell, which no spawn can write | `handlers/repo_cell.rs` — `RepoCellData` is the crate's single authority on a repo cell's `data`, unit-pinned in `handlers/repo_cell/tests.rs` |
| `server/routes/fuz_forge_repo_create_rpc.db.test.ts` | the `seed_from` host policy with the override **off**, the whole `-32602` envelope, and the on-disk unwind (`readdir` before/after) | a policy-off env; both cross spawns set the override on | none, on purpose: a Rust route twin would land `#[ignore]`d and be a second copy of an assertion rather than a second gate |
| `server/routes/repo_git.auth.db.test.ts` | the git admin gate refusing an admin whose granting actor is soft-deleted | a soft-deleted granting actor, which has no wire spelling | `crates/fuz_forge_server/tests/repo_git_auth.rs`, `#[ignore]`d behind Postgres (§ Running) |
| `server/routes/repo_git.cgi_head.db.test.ts` | the CGI-head parser's 502 when the subprocess closes before the `\r\n\r\n` separator or overruns the head cap | an injected misbehaving `spawn_streaming` | hand-duplicated twin tables against `forge_git::cgi::tests` — status-line parsing, lone-`CR` framing, the CGI env key set |
| `server/routes/repo_internal.db.test.ts` | partial and type-corrupt repo cells → 401 on both internal routes | a type-corrupt cell, same reason | the two narrows, unit-pinned: `internal_routes::tests::cell_without_default_branch_does_not_narrow` and `handlers::repo_write::tests::mutation_narrow_rejects_a_wrong_typed_optional` |
| `server/routes/files.scoped_token.db.test.ts` | the `fuz_forge_api_token_policy` gates over the file-store routes — read, write, deny-all, an unreadable row — and the flat spine-scope denial for a narrowed token with no policy row | the route-level layer (below), TS-only — Rust covers these gates only over the wire | `cross_backend/files_scoped_token.cross.test.ts` and `cross_backend/consumer_surface_scoped_token.cross.test.ts` |
| `server/routes/repo_git.scoped_token.db.test.ts` | the same policy layer over git smart-HTTP: `forge_push` / `forge_pull` per-repo capabilities, the advertise's `?service=` match, the wildcard, deny-all | the route-level layer, TS-only — `forge_git/auth.rs`'s unit tests cover the slug grammar, not the policy gate | none: no suite drives git with a policy token, so `check_repo_capability`'s `policy_check` half is unpinned on Rust — the cross git case mints via fuz_app's `mint_narrowed_api_token`, which writes no policy row, so it reaches only the scope gate |
| `server/routes/scoped_token_deny_all_coverage.db.test.ts` | a deny-all policy is refused at **every** protected file-store REST surface — the family enumerated, not sampled — except `list`, which filters to the empty readable set (a spine-scope token with no policy row refuses it instead) | the route-level layer, TS-only | `cross_backend/files_scoped_token.cross.test.ts` § rpc_subset; the Rust mount has no family-wide guard |

**Three layers, three questions.** The censuses ask *was the question asked*,
the (policy, scope) unit suites *does the rule answer correctly*, the
route-level suites *is it wired*. `consumer_surface_scoped_token.cross.test.ts`
proves all three over real HTTP on both backends, but only behind
`FUZ_TEST_CROSS_BACKEND=1` — hence the other three.

## Attack-surface + fixture traps

Rules whose failure mode is silence rather than a red test.

**`skip_routes` cascades.** `describe_standard_attack_surface_tests` threads
one list into all three adversarial groups, so skipping a route for the auth
group drops its adversarial-input and adversarial-404 coverage too. When you
add a skip, say where the other two groups' coverage went — as the comment on
the existing `GET /api/facts/:hash` entry in
`server/routes/auth_attack_surface.test.ts` does.

**The fact routes need a fact-bearing fixture.** The round-trip validator and
the data-exposure suite must both override `setup_test` with the file's
hoisted `fuz_forge_in_process_setup`. Against the auth-only default each
route's 404 becomes a missing-relation 500, which round-trip fails on and data
exposure silently *skips* (`if (!res.ok) continue`).

**`FILE_STORE_MAX_BYTES_TEST` is 2 MiB, not 1**, deliberately *above*
`FACT_EMBEDDED_THRESHOLD_DEFAULT` so an upload can produce an external fact.
Tidying it down to 1 MiB silently kills the disk-CAS coverage.

## Dual-spawn gates

One gated project, `cross_backend_parity`, brings up **both** backends at
once through a dual-spawn `globalSetup` (`dual_spawn_global_setup.ts` →
fuz_app's `create_dual_spawn_global_setup`) and runs every gate that compares
them on that one pair: schema parity, action-manifest parity, and the
differential (§ Shared upstream cross suites). It runs in a later `groupOrder`
than the single-backend projects (it reuses their ports), and its files are
excluded from their glob.

**Both legs run on Postgres.** The schema snapshot compares index definitions
as the engine renders them, and the in-memory engine behind the TS backend's
`memory://` default drops an index's sort direction, `NULLS` placement,
operator classes and `NULLS NOT DISTINCT` — on mixed engines correct DDL would
read as drift. So the Deno leg gets its own database, `fuz_forge_test_ts_parity`,
on the server the Rust leg's URL names: created when missing, its `public`
schema dropped and recreated before each run (behind a guard refusing any
other database name), with a loud setup failure when Postgres is unreachable.

### Schema parity (`schema_parity.cross.test.ts`)

`schema_parity.cross.test.ts` captures each backend's live schema over
`_testing_schema_snapshot` and runs `assert_schema_snapshots_equal`. The gate
is **structure-only** — tables, columns, indexes, constraints, sequences —
over the complete schema with no excluded tables; migration *identity* is
gated upstream by `_testing_migration_tracker`. It **skips NOT NULL
constraints** (`contype = 'n'`): PG17+ catalogs them as named `pg_constraint`
rows where other engines need not, and nullability is already captured per
column, so including them would report a cataloging artifact as drift.

### Action-manifest parity (`action_manifest_parity.cross.test.ts`)

`action_manifest_parity.cross.test.ts` captures each backend's
`_testing_action_manifest` dump — one entry per mounted method with
`{side_effects, account, actor, roles, credential_types, rate_limit}` — and
runs `assert_action_manifests_equal`. It is the one mechanical tie between
`crates/fuz_forge_server/src/actions.rs` and `action_specs.ts`, each otherwise
pinned only by its own repo-local test. It first asserts a floor
(`ACTION_MANIFEST_METHOD_FLOOR`), since two *empty* manifests compare equal.

Both manifests exclude the protocol actions (`heartbeat` / `peer/ping`) by
name: their mount scope is a transport concern, not a domain surface. The
per-spec rate-limit **class** rides on each entry and is compared here; the
*bounds* those classes spend are pinned by `fixtures/parity/rate_limits.json`.

## Type Checking Exclusions

Tests mix Node + Deno imports, so the Deno checker excludes `src/test/`
(`deno.json` `exclude`). The Node side covers it: `tsconfig.json` includes
`src/**/*.ts` plus the root `*.ts` configs (`zap.ts` and `zap.forge2.ts`
included), and ESLint lints them too. Each inherits its exclusions from its
base config, so the two sets differ slightly: `scripts/*.ts` is linted but
outside the tsconfig project, and `src/test/fixtures/` is in the project but
ESLint-ignored by the shared preset. Neither zap config is format-checked —
`gro format`'s root list does not name them.

## RuntimeDeps Mock (`runtime_mock.ts`)

Wraps `create_mock_runtime` from `@fuzdev/fuz_app/runtime/mock.ts` with the
`MockFuzForgeRuntime` type alias. `run_command` records to `command_calls`,
`stdout_write` to `stdout_writes`, `stdin_read` reads `stdin_buffer`,
`env_get` reads `mock_env`, `exit` records `exit_calls` and throws
`MockExitError`, and `stat` / `read_file` / `write_file` use `mock_fs` /
`mock_dirs`.

```typescript
import {create_mock_runtime, type MockFuzForgeRuntime} from '../../runtime_mock.ts';

let runtime: MockFuzForgeRuntime;
beforeEach(() => { runtime = create_mock_runtime(); });
```

## Database Testing (`db_fixture.ts`)

**`describe_db`** runs every suite against real **PostgreSQL**, the engine the
production Rust backend uses — `create_describe_db` from
`@fuzdev/fuz_app/testing/db.ts`, bound to fuz_forge's `pg_factory` and
`TRUNCATE_TABLES` (the general pattern is in the [fuz-stack skill](https://docs.fuz.dev/skills/fuz-stack)).

Each suite's `create()` runs a clean-slate init (`DROP SCHEMA public CASCADE`
→ `CREATE SCHEMA public` → migrate), so a suite's `beforeAll` (e.g.
`create_test_app`'s keeper bootstrap) starts against an EMPTY DB; each test's
`beforeEach` then `TRUNCATE`s all tables. The `db` project runs serially
(`isolate: false`, `fileParallelism: false`), so one shared DB isolates
cleanly without per-worker databases.

`TRUNCATE_TABLES` spreads `fuz_forge_domain_truncate_tables` (the cell tables,
children first, and the fact substrate — one list in
`src/lib/server/db/fuz_forge_schema.ts`, shared with `_testing_reset`) over
`auth_integration_truncate_tables`. The file store is cell-primary, so there
is no file table to truncate.

DB tests need a local PostgreSQL. `db_fixture.ts` reads `TEST_DATABASE_URL`
from the process env, else `.env.development` (default
`postgres://localhost/fuz_forge_test`):

```bash
createdb fuz_forge_test
# .env.development
TEST_DATABASE_URL=postgres://localhost/fuz_forge_test
```

## Filesystem Testing

Tests that touch real disk (e.g. `server/routes/files.db.test.ts` /
`files.scoped_token.db.test.ts`, which drive fuz_app's `PgFactStore` disk CAS)
use a **per-suite tmp dir** with a suite-meaningful prefix, so `/tmp` listings
stay legible and abandoned crash dirs trace back to their origin:

```typescript
beforeAll(async () => {
  // Prefix `fuz_forge-fact-`, `fuz_forge-fact-pg-`, etc.
  disk_root = join(tmpdir(), `fuz_forge-fact-${randomBytes(16).toString('hex')}`);
  await mkdir(disk_root, {recursive: true});
});
afterAll(async () => {
  if (disk_root) await rm(disk_root, {recursive: true, force: true});
});
```

Content addressing makes cross-test reuse safe (same input, same path,
idempotent writes); tests that mutate or remove files between cases use unique
payloads. With `describe_db`, the DB truncates per test while the disk dir
lasts the suite.

## Svelte Rune Testing

A test file that writes runes itself (`$state`, `$effect.root()`) needs the
`.svelte.test.ts` extension so vite compiles them; a test that only *imports*
a rune module stays `.test.ts`, since vite compiles the imported `.svelte.ts`
either way (`ui/capabilities.test.ts` drives `Capabilities` that way).
`vite.config.ts` uses `resolve: {conditions: ['browser']}` in test mode.
`$effect.root()` is needed only when a test mutates state several times and
checks derived values after each:

```typescript
import {flushSync} from 'svelte';

let effect_cleanup: (() => void) | void;
afterEach(() => {
  if (effect_cleanup) { effect_cleanup(); effect_cleanup = undefined; }
});

test('derived updates', () => {
  effect_cleanup = $effect.root(() => {
    const state = new MyState();
    state.mutate(); flushSync();
    assert.strictEqual(state.derived_value, expected);
  });
});
```

## Route / RPC Integration Tests

- `server/routes/fuz_forge_test_helpers.ts` — the test-app factories: wraps
  `create_test_app` with `fuz_forge_session_config` and the forge's route/RPC
  factories.
- `server/routes/scoped_token_helpers.ts` — scoped-token coverage.
- `server/routes/auth_attack_surface_helpers.ts` — the attack-surface suites'
  app-surface spec. Also read by the token-surface census and the cross spine
  suites (`spine_suites.cross.test.ts`), and correctly stays put: the spec
  belongs with the attack-surface suites.
- `cross_backend/{git_helpers,rpc_helpers,scoped_token_mint}.ts`
  — git repo builders; the JSON-RPC helpers (`post_rpc_session`,
  `post_rpc_bearer`, the `get_rpc` pair, and the shared error-code aliases and
  probe ids the strictness suites read); the forge's scoped-token mints. The
  spine's own pieces come from fuz_app: the RPC path (`SPINE_RPC_PATH`), the
  narrowed-token mint (`mint_narrowed_api_token`) and the second-precision
  timestamp assertion (`assert_iso8601_seconds`). Only `cross_backend/` reads
  the last two local files (the bare `rpc_helpers` basename also names an upstream
  `@fuzdev/fuz_app/testing` module, which many suites read); `git_helpers.ts`
  also supplies the `git` runner `git_upstream_server.ts` builds with.
- `git_upstream_server.ts` sits at the test root: a git origin standing in for
  the world outside the forge is a domain fixture no single test domain owns,
  not a cross-suite helper. `runtime_mock.ts` is at the root for the same
  kind of reason — a `RuntimeDeps` mock belongs to no suite.

For parameterized cases, assertions, jsdom, `assert_rejects`, mock naming, and
the other shared conventions see the [fuz-stack skill](https://docs.fuz.dev/skills/fuz-stack)'s `testing-patterns.md`.
