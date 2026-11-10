/**
 * On-disk storage for forge-hosted bare git repositories.
 *
 * Repos live at `<store>/<id>.git/`. All write paths are atomic: assemble
 * the bare repo (or clone) in a temp sibling directory then `rename` over
 * the canonical path so partial state is never visible. Failures clean up
 * the temp dir best-effort.
 *
 * Hook scripts (`pre-receive`, `post-receive`) installed under `hooks/` are
 * short python3 scripts that call back into the forge server over `127.0.0.1` (HTTP
 * POST to a localhost-bound endpoint with a per-repo shared secret).
 * `pre-receive` enforces force-push protection on the default branch;
 * `post-receive` records push metadata on the repo cell.
 *
 * Repo hosting is server-local, so this module operates against `RuntimeDeps`
 * for filesystem + env access. Subprocesses go through the forge's own
 * `SpawnCollect` (`RepoCommandDeps`), which is handed each subprocess's
 * environment explicitly — see that type for why.
 *
 * Structural twin of `crates/fuz_forge_server/src/repo_storage.rs`, which
 * carries the same operations over the same `git_env` isolation.
 *
 * @module
 */

import type {
	EnvDeps,
	FsReadDeps,
	FsRemoveDeps,
	FsWriteDeps
} from '@fuzdev/fuz_app/runtime/deps.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import { fuz_forge_home, resolve_tilde } from '../../runtime/path.ts';
import type { SpawnCollect } from '../../server/subprocess.ts';
import { git_env } from '../../server/git/read.ts';

/**
 * Resolve the repo store root. `FUZ_FORGE_REPO_STORE_PATH` overrides it
 * (tilde-expanded); otherwise it defaults to `<fuz_forge_home>/repos`, so it
 * follows `FUZ_FORGE_HOME` like every other fuz_forge state path (see
 * `fuz_forge_home` in `runtime/path.ts`).
 */
export const repo_store_root = (deps: Pick<EnvDeps, 'env_get'>): string => {
	const raw = deps.env_get('FUZ_FORGE_REPO_STORE_PATH');
	if (raw) return resolve_tilde(raw, deps.env_get('HOME'));
	return `${fuz_forge_home(deps)}/repos`;
};

/** Derive the on-disk path for a repo by id (absolute). */
export const repo_path = (deps: Pick<EnvDeps, 'env_get'>, id: string): string => {
	return `${repo_store_root(deps)}/${id}.git`;
};

/**
 * Cap on stdout/stderr collected from storage subprocesses (git/chmod).
 * Twin of `MAX_CMD_OUTPUT` in `repo_storage.rs`, same literal — a runaway
 * `git clone --bare` against a hostile upstream is SIGKILL'd at the cap on
 * both backends rather than buffered without bound.
 */
const MAX_CMD_OUTPUT = 1_000_000;

/** Suffix used when assembling a repo in a tmp sibling before atomic rename. */
const TMP_SUFFIX = '.tmp';

const random_suffix = (): string => Math.random().toString(36).slice(2, 10);

const tmp_path_for = (final_path: string): string =>
	`${final_path}${TMP_SUFFIX}.${Date.now()}.${random_suffix()}`;

const remove_best_effort = async (
	deps: Pick<FsRemoveDeps, 'remove'>,
	path: string
): Promise<void> => {
	try {
		await deps.remove(path, { recursive: true });
	} catch {
		// already gone or unreadable — nothing to do
	}
};

/**
 * The `-c` overrides every `seed_from` clone runs under, in argv order.
 *
 * - `http.followRedirects=false` — git's default (`initial`) follows a
 *   redirect on the first request, so an admitted public host could answer
 *   `302` to a loopback, link-local or LAN address and send the clone past
 *   the host policy (`seed_from_host_is_private`), which judges only the URL it
 *   was given. With redirects refused, the host the policy judged is the only
 *   host git dials; a seed that redirects fails, and the operator gives the
 *   final URL instead. Refusing redirects also refuses dumb-HTTP alternates on
 *   another host.
 * - `protocol.allow=never` + `protocol.{http,https}.allow=always` — the
 *   transports the `seed_from` grammar admits, pinned in git itself so a
 *   transport the grammar never meant to admit is refused even if the grammar
 *   regresses.
 *
 * Command-line `-c` outranks every config file, and `git_env` already keeps
 * `/etc/gitconfig`, `~/.gitconfig` and any inherited `GIT_CONFIG_PARAMETERS`
 * out, so nothing can undo these. Twin of `SEED_CLONE_GIT_CONFIG` in
 * `repo_storage.rs`; both are asserted against
 * `src/test/fixtures/parity/seed_clone.json`.
 */
export const SEED_CLONE_GIT_CONFIG: ReadonlyArray<string> = [
	'http.followRedirects=false',
	'protocol.allow=never',
	'protocol.http.allow=always',
	'protocol.https.allow=always'
];

/**
 * The `git` argv for a `seed_from` clone: the `SEED_CLONE_GIT_CONFIG`
 * overrides, then `clone --bare <url> <dest>`. Twin of `seed_clone_args` in
 * `repo_storage.rs`.
 *
 * @param url - the canonical seed URL
 * @param dest - the temp path the bare clone assembles in
 * @returns the argv after `git`
 */
export const seed_clone_args = (url: string, dest: string): Array<string> => [
	...SEED_CLONE_GIT_CONFIG.flatMap((entry) => ['-c', entry]),
	'clone',
	'--bare',
	url,
	dest
];

/**
 * The subprocess capability the storage module runs `git` and `chmod` through.
 *
 * Every subprocess gets an explicit `env`, never the daemon's whole
 * environment: its `HOME`, and with it `~/.gitconfig`'s `credential.helper` /
 * `url.<base>.insteadOf`, would defeat the `seed_from` scheme allowlist and
 * canonicalization outright. `SpawnCollect` takes that `env` and closes
 * stdin, which is what the read layer
 * (`server/git/read.ts`) and the CGI proxy already use, and what the Rust twin
 * (`repo_storage.rs`) gets from its own `spawn_collect`.
 */
export interface RepoCommandDeps {
	env_get: EnvDeps['env_get'];
	spawn_collect: SpawnCollect;
}

/**
 * Run a storage subprocess under `git_env`, mapping a non-zero exit — or
 * a spawn failure — to a thrown error carrying stderr (falling back to
 * stdout). Twin of `run_ok` in `repo_storage.rs`, down to both message shapes:
 * `<label>: spawn failed: <detail>` when the process never ran, and
 * `<label> failed: <detail>` when it ran and exited non-zero. Callers pass the
 * same label strings on both sides.
 *
 * The detail is log-only — every caller's failure surfaces to clients as the
 * route's own generic message, never as this string.
 */
const run_ok = async (
	deps: RepoCommandDeps,
	cmd: string,
	args: Array<string>,
	label: string
): Promise<void> => {
	let result;
	try {
		result = await deps.spawn_collect(cmd, args, {
			env: git_env(deps),
			max_output_bytes: MAX_CMD_OUTPUT
		});
	} catch (err) {
		throw new Error(`${label}: spawn failed: ${to_error_message(err)}`);
	}
	if (result.success) return;
	const decoder = new TextDecoder('utf-8');
	const stderr = decoder.decode(result.stderr).trim();
	const detail = stderr.length === 0 ? decoder.decode(result.stdout) : stderr;
	throw new Error(`${label} failed: ${detail}`);
};

/**
 * Recursively narrow the bare repo's permissions to owner-only
 * (0700 dirs / 0600 files). `git init --bare` and `git clone --bare`
 * respect the umask, which defaults to 022 on most distros — leaving
 * the repo world-traversable. The hook scripts under `hooks/` already
 * carry the per-repo callback secret in plaintext (their file mode is
 * tightened separately to 0700), and we want the same posture for the
 * entire bare repo: any local account on the daemon host that can
 * `cat` files under the repo root could exfiltrate refs, packs, or
 * future secrets we add. Locked-down posture: shrink the read surface
 * by default.
 *
 * Uses `chmod -R go-rwx` because applying a literal `0700` to files
 * would strip the loose objects' read bit too unevenly to keep
 * `git fsck` happy — `go-rwx` keeps the owner bits as git set them
 * while reliably stripping group and world access.
 */
const restrict_repo_perms = async (deps: RepoCommandDeps, repo_dir: string): Promise<void> => {
	await run_ok(deps, 'chmod', ['-R', 'go-rwx', repo_dir], 'chmod -R go-rwx');
};

/**
 * Make the bare repo exportable over HTTP via `git http-backend`.
 *
 * Per-repo opt-in is the locked-down stance: `GIT_HTTP_EXPORT_ALL=1` is
 * intentionally NOT set on the subprocess (see
 * `server/routes/repo_git.ts`), so `git http-backend` will only
 * serve a repo that has BOTH:
 *
 * - A `git-daemon-export-ok` marker file at the repo root (git's
 *   per-repo "this is exportable" gate).
 * - `http.receivepack=true` (and explicitly `http.uploadpack=true` for
 *   symmetry, even though `true` is the default) so push and fetch are
 *   both honored by the backend.
 *
 * If either is missing, `git http-backend` returns 404 "Repository not
 * exported" — exactly the surface we want for arbitrary bare repos on
 * disk that happen to share the store root.
 */
const configure_http_export = async (
	deps: RepoCommandDeps & Pick<FsWriteDeps, 'write_text_file'>,
	repo_dir: string
): Promise<void> => {
	// Empty marker file — git only checks existence, not contents.
	await deps.write_text_file(`${repo_dir}/git-daemon-export-ok`, '');

	for (const [key, value] of [
		['http.receivepack', 'true'],
		['http.uploadpack', 'true']
	] as const) {
		await run_ok(deps, 'git', ['-C', repo_dir, 'config', key, value], `git config ${key}=${value}`);
	}
};

/** Deps for repo storage — narrow union of `RuntimeDeps` capabilities. */
export type RepoStorageDeps = Pick<FsReadDeps, 'stat' | 'read_text_file'> &
	Pick<FsWriteDeps, 'mkdir' | 'write_text_file' | 'rename'> &
	Pick<FsRemoveDeps, 'remove'> &
	RepoCommandDeps;

/** Result of a storage operation. */
export interface RepoStorageResult {
	/** Absolute path to the bare repo. */
	path: string;
}

/**
 * Initialize a bare repository at `<store>/<id>.git/` via `git init --bare`.
 *
 * Atomic: builds in `<final>.tmp.<ts>.<rand>/`, then renames into place.
 * Throws if the path already exists (caller should detect first and
 * skip).
 *
 * @mutates filesystem - creates `<store>/<id>.git/`
 */
export const init_bare_repo = async (
	deps: RepoStorageDeps,
	id: string
): Promise<RepoStorageResult> => {
	const store = repo_store_root(deps);
	await deps.mkdir(store, { recursive: true });
	const final_path = `${store}/${id}.git`;
	if (await path_exists(deps, final_path)) {
		throw new Error(`repo path already exists: ${final_path}`);
	}
	const tmp = tmp_path_for(final_path);
	try {
		await run_ok(deps, 'git', ['init', '--bare', tmp], 'git init --bare');
		await configure_http_export(deps, tmp);
		await restrict_repo_perms(deps, tmp);
		await deps.rename(tmp, final_path);
	} catch (err) {
		await remove_best_effort(deps, tmp);
		throw err;
	}
	return { path: final_path };
};

/**
 * Clone a bare repository into `<store>/<id>.git/` from an upstream URL.
 *
 * Used for the one-shot `seed_from` import. Atomic — clones into
 * a temp sibling then renames into place.
 *
 * @mutates filesystem - creates `<store>/<id>.git/`
 */
export const clone_bare_repo = async (
	deps: RepoStorageDeps,
	id: string,
	seed_from_url: string
): Promise<RepoStorageResult> => {
	const store = repo_store_root(deps);
	await deps.mkdir(store, { recursive: true });
	const final_path = `${store}/${id}.git`;
	if (await path_exists(deps, final_path)) {
		throw new Error(`repo path already exists: ${final_path}`);
	}
	const tmp = tmp_path_for(final_path);
	try {
		// `run_ok` bounds git's output at `MAX_CMD_OUTPUT` on both backends and
		// SIGKILLs the child on the trip. There is still no **wall-clock**
		// timeout on either side, so a hostile or hanging upstream can stall
		// this clone indefinitely — see the TODO on `SpawnCollect`
		// (`server/subprocess.ts`). `seed_from` is grammar-checked, host-checked
		// and canonicalized at the RPC input boundary
		// (`seed_from_url_canonical` + `seed_from_host_is_private`), so the
		// remote is an absolute credential-free public http(s) URL — in its
		// serialized form, and `SEED_CLONE_GIT_CONFIG` refuses redirects, so
		// the host that was validated is the only host git dials here.
		await run_ok(deps, 'git', seed_clone_args(seed_from_url, tmp), 'git clone --bare');
		await configure_http_export(deps, tmp);
		await restrict_repo_perms(deps, tmp);
		await deps.rename(tmp, final_path);
	} catch (err) {
		await remove_best_effort(deps, tmp);
		throw err;
	}
	return { path: final_path };
};

/**
 * Point the bare repo's `HEAD` at `refs/heads/<default_branch>` via
 * `git symbolic-ref`.
 *
 * `git init`'s default varies by git config and a seed clone inherits
 * upstream's default, so normalize it to the requested branch. Twin of
 * `set_default_head` in `repo_storage.rs`.
 *
 * @mutates filesystem - rewrites `<store>/<id>.git/HEAD`
 */
export const set_default_head = async (
	deps: RepoStorageDeps,
	id: string,
	default_branch: string
): Promise<void> => {
	await run_ok(
		deps,
		'git',
		['-C', repo_path(deps, id), 'symbolic-ref', 'HEAD', `refs/heads/${default_branch}`],
		'git symbolic-ref HEAD'
	);
};

/**
 * Remove a repo's on-disk bare directory (`<store>/<id>.git/`),
 * best-effort. Used to unwind a partially-created repo when
 * `fuz_forge_repo_create` fails after the disk write but before the
 * transaction commits — the filesystem isn't transactional, so the cell
 * rollback alone would otherwise orphan the directory.
 *
 * @mutates filesystem - removes `<store>/<id>.git/` if present
 */
export const remove_repo_dir = async (
	deps: Pick<EnvDeps, 'env_get'> & Pick<FsRemoveDeps, 'remove'>,
	id: string
): Promise<void> => {
	await remove_best_effort(deps, repo_path(deps, id));
};

/** Hook script names installed under `<repo>/hooks/`. */
export const HOOK_NAMES = ['pre-receive', 'post-receive'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** Inputs for `install_hooks`. */
export interface InstallHooksOptions {
	id: string;
	/**
	 * Per-repo shared secret used to authenticate the callback — the plaintext
	 * the scripts embed; the cell holds its digest.
	 */
	hook_secret: string;
	/** Base URL of the daemon (e.g. `http://127.0.0.1:4041`). */
	callback_url_base: string;
}

/**
 * Shared shebang + import preamble for both generated hook scripts (the
 * pre- and post-receive headers are byte-identical, so they single-source
 * here). Twin of the Rust `HOOK_HEADER` in `repo_storage.rs`; the two
 * backends must write the same bytes to disk.
 */
export const HOOK_HEADER = `#!/usr/bin/env python3
# Installed by fuz_forge.
import json
import os
import sys
import urllib.error
import urllib.request

`;

/**
 * Render the pre-receive hook script.
 *
 * Fetches `default_branch` from the daemon and rejects non-fast-forward
 * updates against it. Fails closed if the callback is unreachable: a
 * hook that cannot read the default branch rejects the push rather than
 * letting a force-push through.
 *
 * Written in python3 rather than bash: parsing JSON with `sed` and
 * building request URLs by string concat is fragile against any
 * non-trivial branch name. python3 + urllib give
 * us a real HTTP client and a real JSON parser with no extra
 * dependencies (the daemon already requires python3 on the host for
 * unrelated tooling). Git invokes the hook directly as an executable,
 * so the shebang chooses the runtime — no bash wrapper needed.
 */
export const render_pre_receive_hook = (options: InstallHooksOptions): string => {
	const { id, hook_secret, callback_url_base } = options;
	return `${HOOK_HEADER}FUZ_FORGE_REPO_ID = ${python_literal(id)}
FUZ_FORGE_HOOK_SECRET = ${python_literal(hook_secret)}
FUZ_FORGE_CALLBACK_BASE = ${python_literal(callback_url_base)}

ZERO_SHA = "0000000000000000000000000000000000000000"


def die(message: str) -> "None":
    print(f"fuz_forge: {message}", file=sys.stderr)
    sys.exit(1)


def fetch_default_branch() -> str:
    req = urllib.request.Request(
        f"{FUZ_FORGE_CALLBACK_BASE}/internal/repo-config/{FUZ_FORGE_REPO_ID}",
        headers={"X-FuzForge-Repo-Secret": FUZ_FORGE_HOOK_SECRET},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            payload = json.load(resp)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as err:
        die(f"pre-receive callback failed (daemon unreachable?): {err}")
    branch = payload.get("default_branch") if isinstance(payload, dict) else None
    if not isinstance(branch, str) or not branch:
        die("could not read default_branch from daemon")
    return branch


def is_ancestor(old: str, new: str) -> bool:
    import subprocess
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", old, new],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def main() -> "None":
    default_branch = fetch_default_branch()
    default_ref = f"refs/heads/{default_branch}"
    for line in sys.stdin:
        parts = line.split()
        if len(parts) < 3:
            continue
        old, new, ref = parts[0], parts[1], parts[2]
        if ref == default_ref and old != ZERO_SHA:
            if not is_ancestor(old, new):
                die(f"non-fast-forward push to {default_branch} rejected")


if __name__ == "__main__":
    main()
`;
};

/**
 * Render the post-receive hook script.
 *
 * Reads `<old> <new> <ref>` triples from stdin and POSTs them to the
 * daemon's internal callback. The transport is an HTTP POST carrying
 * the per-repo shared secret.
 *
 * Push attribution (`account_id`, `username`) is threaded from the git
 * endpoint into the subprocess env as `FUZ_FORGE_PUSH_ACCOUNT_ID` /
 * `FUZ_FORGE_PUSH_USERNAME`. The hook forwards them verbatim; the callback
 * handler authoritatively decides what to persist. If either is unset
 * (e.g. a future code path that bypasses the endpoint) the hook
 * substitutes a JSON `null`.
 *
 * python3 with stdlib `json` handles encoding correctly regardless of
 * what an audit field contains — string concatenation in the shell
 * would be robust only as long as `account.username` stays within the
 * server-validated character set. Locked-down posture: don't depend
 * on upstream input shape for output correctness.
 */
export const render_post_receive_hook = (options: InstallHooksOptions): string => {
	const { id, hook_secret, callback_url_base } = options;
	return `${HOOK_HEADER}FUZ_FORGE_REPO_ID = ${python_literal(id)}
FUZ_FORGE_HOOK_SECRET = ${python_literal(hook_secret)}
FUZ_FORGE_CALLBACK_BASE = ${python_literal(callback_url_base)}


def die(message: str) -> "None":
    print(f"fuz_forge: {message}", file=sys.stderr)
    sys.exit(1)


def main() -> "None":
    updates = []
    for line in sys.stdin:
        parts = line.split()
        if len(parts) < 3:
            continue
        updates.append({"old": parts[0], "new": parts[1], "ref": parts[2]})

    body = json.dumps({
        "repo_id": FUZ_FORGE_REPO_ID,
        "updates": updates,
        "pushed_by": os.environ.get("FUZ_FORGE_PUSH_ACCOUNT_ID") or None,
        "push_username": os.environ.get("FUZ_FORGE_PUSH_USERNAME") or None,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{FUZ_FORGE_CALLBACK_BASE}/internal/repo-receive-callback",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-FuzForge-Repo-Secret": FUZ_FORGE_HOOK_SECRET,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as err:
        die(f"post-receive callback failed: {err}")


if __name__ == "__main__":
    main()
`;
};

/**
 * Install pre-receive + post-receive hook scripts under
 * `<store>/<id>.git/hooks/` and mark them executable.
 *
 * Replaces any existing script of the same name.
 *
 * @mutates filesystem - writes hook scripts and chmods them
 */
export const install_hooks = async (
	deps: RepoStorageDeps,
	options: InstallHooksOptions
): Promise<void> => {
	const hooks_dir = `${repo_path(deps, options.id)}/hooks`;
	await deps.mkdir(hooks_dir, { recursive: true });

	const scripts: Record<HookName, string> = {
		'pre-receive': render_pre_receive_hook(options),
		'post-receive': render_post_receive_hook(options)
	};

	for (const name of HOOK_NAMES) {
		const path = `${hooks_dir}/${name}`;
		await deps.write_text_file(path, scripts[name]);
		// Owner-only — the script embeds the per-repo callback secret in
		// plaintext, so anything wider would leak the secret to any local
		// account with shell access on the daemon host. Locked-down
		// posture: defense holds even when other local users exist.
		await run_ok(deps, 'chmod', ['0700', path], `chmod 0700 ${name}`);
	}
};

const path_exists = async (deps: Pick<FsReadDeps, 'stat'>, path: string): Promise<boolean> => {
	const s = await deps.stat(path);
	return s !== null;
};

/**
 * A repo's hook scripts as they stood before a rewrite, so a failed rewrite can
 * put them back (`restore_hooks`). The cell keeps only a digest of the hook
 * secret, so a rollback cannot re-render the old scripts from the cell; it
 * restores their text instead. `null` records a script that was absent. Twin
 * of `HookSnapshot` in `repo_storage.rs`.
 */
export type HookSnapshot = Record<HookName, string | null>;

/**
 * Whether a thrown filesystem error means the path does not exist. Node, Bun,
 * and the fuz_app mock all set `code: 'ENOENT'`. `stat` can't answer this: it
 * returns `null` for every failure, a permission error included.
 */
const is_not_found_error = (error: unknown): boolean =>
	typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';

/**
 * Read a repo's installed hook scripts into a `HookSnapshot`. A missing script
 * is recorded as absent; any other read failure throws, before the caller has
 * written anything.
 */
export const snapshot_hooks = async (deps: RepoStorageDeps, id: string): Promise<HookSnapshot> => {
	const hooks_dir = `${repo_path(deps, id)}/hooks`;
	const snapshot: HookSnapshot = { 'pre-receive': null, 'post-receive': null };
	for (const name of HOOK_NAMES) {
		try {
			snapshot[name] = await deps.read_text_file(`${hooks_dir}/${name}`);
		} catch (error) {
			if (!is_not_found_error(error)) throw error;
		}
	}
	return snapshot;
};

/**
 * Put a repo's hook scripts back as a `HookSnapshot` recorded them: each
 * recorded script rewritten and re-`chmod`ed `0700`, each absent one removed.
 *
 * @mutates filesystem - rewrites or removes the hook scripts
 */
export const restore_hooks = async (
	deps: RepoStorageDeps,
	id: string,
	snapshot: HookSnapshot
): Promise<void> => {
	const hooks_dir = `${repo_path(deps, id)}/hooks`;
	for (const name of HOOK_NAMES) {
		const path = `${hooks_dir}/${name}`;
		const text = snapshot[name];
		if (text === null) {
			try {
				await deps.remove(path);
			} catch (error) {
				if (!is_not_found_error(error)) throw error;
			}
			continue;
		}
		await deps.write_text_file(path, text);
		await run_ok(deps, 'chmod', ['0700', path], `chmod 0700 ${name}`);
	}
};

/**
 * Default daemon callback port when `PORT` is unset. Mirrors this backend's own
 * default bind port — `BaseServerEnv.PORT` (4040) — so a hook callback always
 * targets the port this server actually listens on.
 *
 * **Intentional divergence from the Rust twin**, which falls back to 4041
 * (`callback_base_from_port` in `repo_storage.rs`, mirroring its own
 * `DEFAULT_ADDR` bind). Each backend's fallback matches its own default bind, so
 * the callback can never point at the wrong port — converging the *numbers*
 * (e.g. "make Rust 4040") was rejected because it would aim one backend's hook
 * at a port it isn't on. This fallback is **dead-path** in practice: `PORT` is
 * always set explicitly (dev `.env.development` = 4041 for both backends, prod
 * `.env.production` = 4040, tests = 14041/14141), so the swap-backends-behind-
 * one-URL dev workflow already works without converging this default.
 */
const DEFAULT_CALLBACK_PORT = 4040;

/**
 * Compose the localhost callback base URL embedded into hook scripts.
 *
 * The hooks POST to `<base>/internal/repo-receive-callback`. Reads the
 * server `PORT` env var and assumes the daemon listens on `127.0.0.1`.
 *
 * Shared between `execute_repo` (initial install) and the
 * `fuz_forge_repo_rotate_secret` handler (re-render with new secret) so the
 * base URL is composed identically on both code paths.
 */
export const build_callback_url_base = (deps: Pick<EnvDeps, 'env_get'>): string => {
	const raw_port = deps.env_get('PORT');
	const port = raw_port ? Number(raw_port) || DEFAULT_CALLBACK_PORT : DEFAULT_CALLBACK_PORT;
	return `http://127.0.0.1:${port}`;
};

/**
 * Render `value` as a safe Python 3 string literal — single-quoted, with
 * any embedded single quote, backslash, or non-printable rendered via
 * `\xNN` / `\uNNNN`. Used to embed config values into hook scripts
 * without depending on any whitelisting of the input character set.
 *
 * `JSON.stringify` is deliberately not used: JSON's `U+2028` line
 * separator and other surrogates aren't legal in single-quoted Python
 * literals, and JSON's `"` quoting collides with double-quoted strings
 * in our generated source. Hand-rolled is small, total, and obviously
 * correct.
 */
const python_literal = (value: string): string => {
	let out = "'";
	for (const ch of value) {
		const code = ch.codePointAt(0)!;
		if (ch === '\\') out += '\\\\';
		else if (ch === "'") out += "\\'";
		else if (ch === '\n') out += '\\n';
		else if (ch === '\r') out += '\\r';
		else if (ch === '\t') out += '\\t';
		else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
		else if (code > 0xffff) out += `\\U${code.toString(16).padStart(8, '0')}`;
		else if (code > 0x7e) out += `\\u${code.toString(16).padStart(4, '0')}`;
		else out += ch;
	}
	return out + "'";
};
