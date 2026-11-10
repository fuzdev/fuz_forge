# Distribution

The forge ships two binaries, `fuzf` (the client CLI) and `fuzfd` (the
server), and moves bytes through three channels:

| channel | what | trust | how |
| --- | --- | --- | --- |
| the forge's own binaries | `fuzf`, `fuzfd` | SHA-512 sidecar | [GitHub Releases](#github-releases) (authoritative); `npm run deploy` also uploads `dist_artifacts/` to a host. `fuzf` / `fuzfd` are first-party fuz tools, so `fuz tool install` can fetch them too |
| first-party signed tools | fuzd, zap, zzz, tsv, … | ed25519 signature + blake3, verified by `fuz` | `fuzf tool publish` → file store → `fuz tool install` ([Signed tool artifacts](#signed-tool-artifacts)) |
| arbitrary files | deno, ghostty, zig, … | blake3 only | `fuzf file put` / `get` ([Arbitrary files](#arbitrary-files)) |

The last two share one substrate, the content-addressed file store
(`/api/fuz_forge/files`). The server never signs or verifies either: it is a
byte store, and all trust lives in the consumer. The forge serves no download
endpoint for its own binaries.

Release binaries are built for Linux x86_64 only. `fuzf` and `fuzfd` are
compiled Rust and need no JS runtime.

## Installing from a release

No release is published yet; [build from source](#building-from-source).
From a release, download `fuzf` and its sidecar, verify, and install:

```bash
# keep the published names: the sidecar records the filename, and `-c` resolves it
curl -fsSL -O https://github.com/fuzdev/fuz_forge/releases/latest/download/fuzf-linux-x86_64
curl -fsSL -O https://github.com/fuzdev/fuz_forge/releases/latest/download/fuzf-linux-x86_64.sha512

sha512sum -c fuzf-linux-x86_64.sha512   # or: shasum -a 512 -c fuzf-linux-x86_64.sha512
chmod +x fuzf-linux-x86_64 && mv fuzf-linux-x86_64 ~/.local/bin/fuzf
```

Then point it at a forge with `fuzf init --server https://<forge-host>` and
save an API token, minted at `https://<forge-host>/admin/account` (the UI shows
a ready-to-copy command):

```bash
(umask 077; mkdir -p ~/.fuz_forge && cat > ~/.fuz_forge/api_token)   # paste, then Ctrl-D
```

`FUZ_FORGE_TOKEN` overrides the file; `FUZ_FORGE_HOME` (absolute) moves the
home ([CLAUDE.md § Client state](../CLAUDE.md#client-state)). The token is one
printable-ASCII word in a regular file of at most 4096 bytes; keep it `600`,
since an unscoped token has its account's full authority. `fuz`'s `forge://`
storage uses the same resolver.

Which surfaces a token reaches, and how a scoped token narrows them, is
[auth_walkthrough.md § Scoped API tokens](./auth_walkthrough.md#scoped-api-tokens-per-token-capability-narrowing).

## Building from source

Other platforms (macOS, aarch64; untested) build from source with a Rust
toolchain and the sibling `fuz/` checkout beside this repo:

```bash
cargo run --bin fuzf -- --help        # the client
cargo build --release --bin fuzfd     # the server
```

`gro build` runs the same cargo build and writes each binary with a `.sha512`
into `dist_artifacts/`; its knobs are in [CLAUDE.md § Build](../CLAUDE.md#build).

## Signed tool artifacts

The file store is a byte backend for `fuz tool install <name> --storage
forge://<host>`: the signed, blake3-pinned first-party artifacts `fuz` installs.
The artifact layout, manifest, signature, and verification flow are Fuz's —
see Fuz's [release_format.md](https://github.com/fuzdev/fuz/blob/main/docs/release_format.md)
and [release_workflow.md § Publishing](https://github.com/fuzdev/fuz/blob/main/docs/release_workflow.md#publishing).
`--storage` is required: there is no default forge host.

**Producer.** `fuzf tool publish <name> <binary> --version <v>` signs the
artifact with the publisher key (via `fuz_sign`; the forge never holds it) and
uploads it under `tools/<name>/`. Flags (`fuzf tool publish --help`):

| flag | does |
| --- | --- |
| `--key-file` | signing key; default `$FUZ_HOME/config/signing.key` (`~/.fuz`), the keypair Fuz's `cargo xtask key generate` writes |
| `--server` | forge URL; else `FUZ_FORGE_BASE_URL` (blank = unset), else `config.json` |
| `--minimum-version` | the oldest installed version of the tool allowed to upgrade to this release (a fresh install is exempt) |
| `--log-repo <path>` | also record the release in a checkout of the release log repository |
| `--target <triple>` | label the release with a supported target (`{x86_64,aarch64}-unknown-linux-{gnu,musl}`, `{x86_64,aarch64}-apple-darwin`); default `fuzf`'s own |
| `-q` / `--quiet` | print nothing on success |

Before anything uploads, the publish refuses a name outside Fuz's first-party
tool set; a version or `--minimum-version` that is not semver, a floor above
the version, or build metadata on the floor; and a name, version, or target
that is not a valid storage key segment (a `/`, or a `+` build suffix). The
binary is packed under the tool's name, so `fuzf` also refuses a source file
named `testing_*`. The target names every key the release lands under, so the
binary's header is held to it: one for another architecture, OS, or libc is
refused with a hint naming the `--target` it is for, and a statically linked
one (a musl build?) is refused unless `--target` names its libc or `fuzf` is
itself a musl build. These refusals exit `2`. Uploads never follow a redirect — a `3xx`
fails the write — so `--server` must be the forge's final URL. With
`--log-repo`, the log is checked before the upload, and after it the publish
signs the new `head.json`, commits, and pushes before the target's
`latest-<target>.json` moves; a failed log write leaves it where it was. Each
target has its own pointer, so publishing one never moves another's. A log with no head takes
the release only when storage holds no other release; otherwise run Fuz's
backfill first.

**Bootstrap.** `fuz` itself always ships through Fuz's `cargo xtask publish
self`, and the first `fuzd` / `fuzf` through `cargo xtask publish tool`, since
no forge client exists yet to publish them; after that, `fuzf tool publish`.

**Server.** `latest-<target>.json` pointers, manifests, and tarballs are ordinary file-store
keys (`GET /api/fuz_forge/files/tools/<name>/…`); there is no registry or
catalog route. Every read carries a token — a forge host has no anonymous
download.

## Arbitrary files

Third-party binaries outside the first-party set are plain content-addressed
blobs: blake3 integrity, no signature, referenced from a Zap config and
installed by Zap.

```bash
fuzf file put ./ghostty-linux-x86_64
```

```ts
zap.file({
	id: 'ghostty',
	path: '~/.local/bin/ghostty',
	content: {
		type: 'remote',
		url: 'https://<forge-host>/api/fuz_forge/files/ghostty-linux-x86_64',
		auth: {scheme: 'bearer', token: zap.env('FUZ_FORGE_TOKEN')},
	},
	mode: '755',
});
```

`fuzf file get` streams to its output path — bounded memory, blake3-verified,
atomic temp + rename — and keeps no local cache.

## File store contract

The route table (method, path, role, response) is the rustdoc of
`crates/fuz_forge_server/src/files/mod.rs`; both backends answer the same.
Writes and deletes need the `admin` role, reads any authenticated account. The
semantics a client relies on:

- `POST <filename>` answers `200` with a `status`: `created` for a new key,
  `updated` when the key's bytes change, `unchanged` when identical bytes are
  re-uploaded to the same key. The same bytes under another key are `created`
  — content dedups, keys don't.
- `GET <filename>` streams the bytes; any `meta` query parameter (`?meta`,
  `?meta=`, `?meta=x`) returns the metadata JSON instead, and other keys are
  ignored.
- `GET` on the root lists the whole store, unbounded, sorted by filename in
  byte order, filtered to what the token may read.
- `DELETE <filename>` soft-deletes the metadata cell; the bytes stay in the
  fact store; nothing reclaims them yet.
- An absent key is `404 file_not_found`; an empty body `400 empty_body`; an
  upload over `FUZ_FORGE_FILE_STORE_MAX_BYTES` `413 payload_too_large`, the cap
  in its `message`; one the free-space margin can't hold `507 storage_full`
  (both in ./deploy.md § Server env). Each body is `{error: <code>}`, with
  prose in `message` where there is any.
- **Digests.** BLAKE3 is a file's address and its only digest: bare lowercase
  hex on the wire (`blake3_hash` in the upload and metadata bodies, the
  `x-blake3-hash` header on every download), `blake3:<hex>` in the file's cell
  data. A cell whose `blake3` is off that form is a missing file. `fuzfd`
  streams a disk-backed file without re-hashing it (the TS reference server
  re-hashes and answers `404` on a mismatch), so a client checks the bytes it
  received: `fuzf file get` against the metadata's `blake3_hash`, `zap`
  against its lock pin, `fuz tool install` against the signed manifest,
  anything else against `x-blake3-hash`.

### Storage

A stored file is a cell at `files/<filename>` (`kind` `file`) whose `data`
holds `content_type`, `size` and `blake3`, and whose `refs` tie it to the fact
holding the bytes. A key is `[A-Za-z0-9._/-]` with interior `/` allowed; an empty,
over-long, absolute or trailing-`/` key, or one with an empty or dot-leading
segment, is `400 invalid_route_params`.

- A fact of at most 1 MiB (`FACT_EMBEDDED_THRESHOLD_DEFAULT`) is stored in the
  database; a larger one is a file on disk under `FUZ_FORGE_FACT_STORE_PATH`
  (default `<home>/facts`), and the fact row's `external_url` names it.
- On disk a fact lives at `<2-hex>/<62-hex>`, its BLAKE3 hex split after the
  first two characters; `external_url` is `file:<2-hex>/<62-hex>`, relative to
  the store root, so moving the root rewrites no rows.
- An upload streams into a temp file under the root's `.tmp/`, hashing as it
  goes, then is renamed into place (atomic on one filesystem) or dropped when
  that fact already exists.
- A temp left by a killed upload is swept once it is an hour old: `fuzfd` and
  the TS server sweep `.tmp/` at startup and then hourly.

## GitHub Releases

To cut a release, bump `version` in `package.json` and in `Cargo.toml`'s
`[workspace.package]` (kept equal, so `fuzf version` matches the tag), commit,
and run `npm run release` (the Gro task `src/tasks/release.task.ts`, over
`src/lib/release.ts`), which:

1. reads the version from `package.json` (tag `v{version}`) and refuses
   unless `Cargo.toml`'s `[workspace.package]` version is the same;
2. refuses when `gro build` would not build both binaries for the host:
   `FUZ_FORGE_BUILD_TARGET` set, `FUZ_FORGE_BUILD_SKIP_SERVER=1`, or no
   sibling `../fuz` checkout;
3. refuses unless git is clean and `gh` is installed and authenticated, and if
   the tag already has a release;
4. runs `gro build`, refuses if it left the working tree dirty, then checks
   both binaries and their sidecars exist, refuses one that isn't an x86-64
   glibc build (a musl build can't ship as `-linux-x86_64`) or whose build
   sidecar disagrees with its bytes, and writes each under its asset name with
   a sidecar naming it, hashed from the bytes shipped;
5. runs `gh release create --latest` with generated notes, then removes the
   asset copies.

| asset | contents |
| --- | --- |
| `fuzf-linux-x86_64` | client binary |
| `fuzfd-linux-x86_64` | server binary |
| `*.sha512` | `sha512sum`-format sidecar for each |

Each is at `https://github.com/fuzdev/fuz_forge/releases/latest/download/<asset>`.
To redo a bad release, delete it and its tag
(`gh release delete v<x> --repo fuzdev/fuz_forge --yes`, then the local and
remote tag), fix, and re-run.

## Code references

- release: `src/lib/release.ts`, run by `src/tasks/release.task.ts`
- build: the cargo plugin in `gro.config.ts`
- file store: `src/lib/server/routes/files.ts` (TS), `crates/fuz_forge_server/src/files/` (Rust), `crates/fuz_forge/src/client.rs` (CLI), `src/lib/ui/files_state.svelte.ts` (UI)
