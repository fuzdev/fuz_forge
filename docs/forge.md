# Forge

fuz_forge hosts git repositories: it accepts pushes, serves clones, and
exposes a browse UI. Hosting is **push-primary** — the forge is the source of
truth for the repos it hosts — and every `fuz_forge_*` request/response method, git smart-HTTP,
and the browse UI require the `admin` role.

## Initial focus

The UX is held to three use cases:

1. **Mirror git repos behind auth** — keep repos current by fanning an
   ordinary `git push` out to the forge alongside other remotes; the forge only
   receives, and there is no anonymous read.
2. **Review commits and diffs** — the commit log and single-commit diffs, as a
   reader; not a code-review workflow.
3. **Move files and self-host the first-party registry** — `fuzf file put/get`
   and the signed tool artifacts `fuz tool install` pulls; see
   [distribution.md](./distribution.md).

What is out of scope is listed under [Not built](#not-built).

## Quickstart

```bash
fuzf repo create me/my_repo                 # or --seed-from <https-url> to mirror
git remote add forge "$(fuzf repo clone me/my_repo)"   # prints the clone URL
git push forge main                         # the default branch refuses force-push
```

git asks for credentials: any non-empty username, the API token as the password.
`fuzf repo clone me/my_repo --exec --with-auth` clones without storing the
token anywhere, so later pushes from that clone ask too. A repo's web UI is
`https://<forge-host>/admin/repos/<id>`, linked from the repo list.

## Concepts

A repo is a bare git repo on disk (`<id>.git/`) plus one cell at
`path = repos/<slug>`.

| field | meaning |
| --- | --- |
| id | The cell's UUID: the on-disk directory name, the browse-URL segment, and the wire id every repo RPC accepts. Slash-free, which the nested browse routes need. |
| slug | `org/repo`, the clone-URL path and human identity. Case-insensitive: input in any case canonicalizes to the stored lowercase form. Immutable. Mirrored into `cell.path`, whose unique index makes slugs unique. A CLI `<id-or-slug>` with a `/` is a slug, otherwise an id. |
| name | The repo segment of the slug, derived at create. |
| hook secret | Per-repo secret in the hook scripts, authenticating the hooks' HTTP callbacks; the cell keeps only its digest; see [The hook secret at rest](#the-hook-secret-at-rest). |
| default branch | The ref the pre-receive hook protects from non-fast-forward updates; the bare repo's `HEAD` tracks it. |
| seed_from | One-shot upstream URL cloned with `git clone --bare` at create, then kept as provenance only; see [seed_from](#seed_from). |

## seed_from

A seed URL passes three gates, in this order on both backends, before any disk
or DB work; each refusal is `-32602`, and the host-policy refusal carries the
same message on both:

1. **Grammar** — an absolute `http`/`https` URL with a host and no embedded
   credentials (the URL is stored on a readable cell).
2. **Canonicalize** — what is stored and cloned is the URL parser's canonical
   serialization, so the host that was validated is the host git dials.
3. **Host policy** — [below](#seed_from-host-policy).

The clone runs with `http.followRedirects=false` and git's transports pinned to
`http` and `https`, so a seed that redirects fails the create; give the final
URL. A seeded create resolves the upstream's default-branch tip into
`head_sha` before it answers, so a mirror browses immediately; an unseeded repo
has `head_sha: null` until its first push. The rationale for each gate is the
TSDoc of `src/lib/fuz_forge/repo/seed_from.ts`.

### seed_from host policy

By default a canonical host is refused when it is one of these literals:

| range | IPv4 | IPv6 |
| --- | --- | --- |
| loopback | `127/8` | `::1` |
| link-local | `169.254/16` | `fe80::/10` |
| unspecified | `0.0.0.0` | `::` |
| private (RFC 1918 / ULA) | `10/8`, `172.16/12`, `192.168/16` | `fc00::/7` |
| carrier-grade NAT | `100.64/10` | — |

…an IPv4-mapped IPv6 spelling of any of them, or `localhost` and any name under
the `.localhost` TLD, with or without a trailing dot (`notlocalhost` and
`localhost.example.com` are admitted). Because the check runs on the canonical
host, alternate IPv4 spellings (`2130706433`, `0177.0.0.1`) hit the same rows.

`FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS` admits every range above, for a forge
mirroring from its own LAN; it is a stringbool, and an unrecognized value is a
startup error.

**Names are not resolved.** The policy reads the host text, so a name that
resolves into a refused range (`127.0.0.1.nip.io`, internal DNS) passes. The
create is admin-only, so this is a guardrail, not a trust boundary.

## Authentication

| surface | credential |
| --- | --- |
| browser (web UI) | cookie session; every `/admin/repos/*` page needs `admin` |
| JSON-RPC, file store | `Authorization: Bearer <api-token>` |
| git smart-HTTP | HTTP Basic with the API token as the password; any non-empty username (it is not checked) |

At git smart-HTTP, a token authenticates only when its account holds the
global `admin` role on a live actor — a grant on a soft-deleted actor or account does not admit. A
request carrying `Origin` or `Referer` is refused token auth on every surface,
so browsers must use a cookie session. The reverse proxy forwards
`Authorization` on every path; scope is enforced by the backend.

Every git refusal is the same 401 with a `Basic` challenge. A password without
an API token's shape is refused before any database read. A database read that
fails is not a refusal: git gets a 500, or a 503 when no database connection
can be checked out, so an outage never looks like a revoked token. The file
store answers that 503 too when its scoped-token policy read cannot get a
connection.

For CI, mint a **scoped** token — `forge_push` / `forge_pull` narrow it to
named repos by their UUID ids (a slug is refused at mint):

```ts
// fuz_forge_token_create_scoped (session-only), or the dashboard's token form
{
	name: 'CI push for my_repo',
	template: {kind: 'forge_push', repo_ids: ['<repo-uuid>']},
	lifetime: {kind: 'ttl', days: 90},
}
```

The templates, the two layers they write, and what each surface answers a
narrowed token are [auth_walkthrough.md § Scoped API
tokens](./auth_walkthrough.md#scoped-api-tokens-per-token-capability-narrowing).

### The hook secret at rest

The secret itself lives only in the repo's two hook scripts on disk. The cell
stores `data.hook_secret_hash`, the bare-hex BLAKE3 of the secret, and the
`/internal/*` callbacks compare the digest of the presented secret against it in
constant time, so reading the cell does not yield a usable credential.

The callbacks accept only a `repo` cell under `repos/`, and the
generic cell verbs (`cell_create`, `cell_clone`) refuse the `repo` and `file`
kinds to anyone but a global admin (403 `cell_create_forbidden`), so an account
cannot mint a repo-shaped cell carrying a digest of its own choosing.

The repo RPCs never return `hook_secret_hash` either — their DTOs have no such
field. That is a shape decision, not access control: whoever may read the cell
can read it through `cell_get` / `cell_list` — its owning actor, any holder of a
cell grant on it, admins, and anyone if the cell's visibility is `public`.
`fuz_forge_repo_rotate_secret` (session-only, `admin`) replaces a leaked secret.

A repo cell holding a plaintext `hook_secret` and no `hook_secret_hash` does not
narrow: it is skipped on list, a 404 on read, and its hooks' callbacks are
refused. Pre-release, the fix is to re-create such a repo, or reset a dev
database with `npm run dev:reset`; either removes the plaintext with the
cell. A cell given a `hook_secret_hash` by hand instead narrows with the
plaintext still in it, until its next rotation drops the `hook_secret` key.

## Clone-URL grammar

The only smart-HTTP URL either backend serves is
`<base>/<org>/<repo>.git/<endpoint>`: exactly two `RepoSlug` segments (each
1–64 chars of `[a-zA-Z0-9]` with single `-`/`_` separators between
alphanumerics) and a trailing `.git`. The grammar is checked before the
credential, on the percent-decoded path, so an off-grammar URL does no database
work and never reaches `git http-backend`. Refused spellings include:

- no `.git` suffix, one segment, or three or more segments
- a doubled suffix (`<repo>.git.git` leaves `<repo>.git`, and `.` is off-charset)
- a segment over 64 chars
- a non-ASCII homoglyph (U+212A KELVIN SIGN, which a naive lowercase fold maps to `k`)
- a percent-decoded control byte (`<re%00po>`)
- a percent-encoded `/` (`%2F`) in either segment; other percent-encoded
  bytes decode before the check (`%2Egit` serves as `.git`)

The refusal's shape is not contractual: `fuzfd` answers its router 404, while
the TS reference server, which also mounts the SPA fallback, answers the SPA or
a generic 401.

## Push semantics

- **Force-push to the default branch is refused** by the pre-receive hook;
  other branches accept any update.
- **Hooks fail closed**: if the pre-receive hook can't reach the daemon's
  `/internal/repo-config/:id`, it refuses the push. The daemon must be up to
  accept pushes.
- **Post-receive is synchronous**: `git push` waits for the hook's callback
  (one loopback POST, one cell update). The `fuz_forge_repo_updated` broadcast
  is fired without awaiting delivery.

## Browse UI

All pages are under `/admin/repos/` and need `admin`.

| page | shows |
| --- | --- |
| `/admin/repos` | catalog: slug, last push, copy-clone-URL |
| `[id]` | cell metadata and recent commits on the default branch |
| `[id]/refs` | branches and tags with timestamps and SHAs |
| `[id]/log` | cursor-paginated log, filtered by ref, author, since, path |
| `[id]/c/[sha]` | one commit: message, author/committer, parents, unified diff |
| `[id]/tree/[...rest]` | tree at `<ref>[:<path>]`, trees first |
| `[id]/blob/[...rest]` | file at `<ref>:<path>`: text, binary, or truncated |

The `[...rest]` splat splits on the first `:` into ref and path — git's own
`<rev>:<path>`, and a character no ref name contains, so slash-bearing branches
(`release/1.x`) address cleanly. A splat with no `:` is all ref: the tree root
under `/tree/`, a "missing ref or path" notice under `/blob/`. Dot segments
after the colon (`main:../etc`) survive URL normalization and are refused
server-side by `is_safe_path` on both backends. The UI re-fetches on a
`fuz_forge_repo_updated` broadcast for the visible repo.

## On-disk layout

Each repo is `<repo_store>/<id>.git/`, where the store is
`$FUZ_FORGE_REPO_STORE_PATH`, default `<home>/repos` (`$FUZ_FORGE_HOME`,
default `~/.fuz_forge`; on a zap-deployed host, the `fuz_forge` user's home).
Repo hosting is server-local: no SSH or remote targets.

- **Owner-only permissions** (`chmod -R go-rwx`) — the hooks embed the secret,
  the only place its plaintext is kept.
- **`git-daemon-export-ok`** plus per-repo `http.receivepack=true` /
  `http.uploadpack=true`: smart-HTTP serves only repos that opt in (not
  `GIT_HTTP_EXPORT_ALL`).
- **`hooks/pre-receive`** and **`hooks/post-receive`** — Python 3 scripts that
  call the daemon's `/internal/repo-config/:id` and
  `/internal/repo-receive-callback` (loopback-only, per-repo secret). The
  callback refuses an update whose `new` is not a full lowercase 40-hex sha;
  the all-zero id of a deleted ref is one, so deletes pass.

## Cell shape

The cell's `data`:

```ts
{
	kind: 'repo',            // cell-kind discriminator
	slug,                    // immutable; mirrored into cell.path
	name,
	default_branch,
	seed_from,               // canonical URL, provenance only
	seed_completed_at,
	hook_secret_hash,        // BLAKE3 of the hooks' secret; withheld from the repo DTOs
	head_sha,                // default-branch tip as of the last push touching it
	last_pushed_at,          // most recent push to any ref
	last_pushed_by,          // account id behind the token
	last_push_username,      // that account's username
}
```

Push-derived fields are `null` until the first push, except a seeded repo's
`head_sha`. The last-push fields are overwritten on every push and
`seed_completed_at` never is; there is no per-push history (see [Not
built](#not-built)).

Every forge timestamp on the wire — these, the repo DTO's `created_at` /
`updated_at`, the file store's `uploaded_at` — is second-precision UTC,
`YYYY-MM-DDTHH:MM:SSZ`. Commit timestamps (`author_date` / `committer_date`)
are git's strict ISO form with the committer's offset, byte-identical on both
backends. Spine surfaces (accounts, sessions, tokens, cells) shape their own.

## Operations

`fuzf repo --help` is the flag reference.

| command | does |
| --- | --- |
| `repo create <org/repo>` | init (or `--seed-from` clone) the bare repo, install hooks, create the cell; prints the new id |
| `repo list` | list repos; `--since` filters on `last_pushed_at` |
| `repo view <id-or-slug>` | show one repo; `--web` opens it |
| `repo clone <id-or-slug>` | print the clone URL; `--exec` runs `git clone` |
| `repo log` / `show` / `refs` | commit log, one commit, refs |
| `repo resync <id-or-slug> --yes` | re-read the on-disk default-branch tip into `head_sha` (idempotent) |

Filter grammars:

- `repo list --since` is a **UTC ISO 8601 datetime** (`2026-01-01T00:00:00Z`;
  optional seconds and fraction, a literal `Z`). Never-pushed repos are
  excluded when it is set; anything else is `-32602` on both backends, which is
  what keeps them agreeing.
- `repo log --since` (and the browse filter) is handed to `git log --since=`,
  so it is git's approxidate: `2 weeks ago` works, and an unrecognized spelling
  resolves to *now*, dropping every past commit, rather than erroring.
- `repo log --author` is a regex handed to `git log --author`; one git refuses
  is `-32602 invalid author pattern`.
- A ref or cursor that resolves to nothing is an empty page.

`repo clone --with-auth` (only with `--exec`) passes an `Authorization: Basic`
header for that one URL through git's `GIT_CONFIG_COUNT` environment, so the
token never appears in argv, the printed URL, or `.git/config`, and refuses
redirects for that URL.

`fuz_forge_repo_rotate_secret` has no CLI: it mints a new hook secret, rewrites
both hooks, and updates the cell's digest inside the dispatcher's transaction.
It reads the installed hooks first; if the rewrite fails, those bytes are put
back and the transaction rolls back.

## Not built

- `fuzf repo rotate-secret`, repo deletion and prune, gc, disk-size sampling,
  and cell/disk/config drift reporting.
- A forensic event log: per-push history with `{old, new, ref}`, rejected
  pushes and bad auth, non-default ref movement, secret rotations and resyncs.
- Reader features: syntax highlighting, diff ranges, a cross-repo commit feed,
  a raw blob endpoint with image preview.
- Repo metadata RPCs (description, README, tags, visibility).
- Compare views, per-file history and blame, content search, public reads,
  outbound mirroring, PRs and issues, SSH push, per-branch protection beyond
  the default branch, per-repo ACLs, multi-tenant hosting.
