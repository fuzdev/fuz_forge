/**
 * Read-only git subprocess wrappers against forge-hosted bare repos.
 *
 * Uses the buffered subprocess primitive (`SpawnCollect`) — a
 * bounded `git log` invocation writes a small, finite amount of output,
 * so streaming would be overkill. Output parsing is shared via
 * `server/git/parse.ts`; this module owns argv construction + env isolation +
 * error mapping.
 *
 * Locked-down posture (`server/routes/git_cgi.ts`'s CGI env is built separately
 * on the same principles, `GIT_CONFIG_NOSYSTEM` included):
 *
 * - Subprocess env is empty plus `PATH` + `LC_ALL` + `GIT_TERMINAL_PROMPT` +
 *   `GIT_CONFIG_NOSYSTEM` only (`git_env`) — server env is NOT
 *   inherited.
 * - Ref names are validated against `git check-ref-format` semantics
 *   (`is_safe_ref_name`) before being passed as a rev argument so
 *   a malformed input can't be interpreted as a flag or pathspec.
 * - Pagination cursors must be a full SHA-1 hex string (40 chars,
 *   `[0-9a-f]`); other shapes are rejected to keep the argv tight.
 * - Output is capped at `MAX_LOG_BYTES`; oversize output kills
 *   the subprocess and returns an error rather than buffering unbounded
 *   memory.
 *
 * @module
 */

import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import type { EnvDeps } from '@fuzdev/fuz_app/runtime/deps.ts';

import { type SpawnCollect, type SpawnCollectResult, is_output_too_large } from '../subprocess.ts';
import {
	LOG_RECORD_FORMAT,
	COMMIT_DETAIL_FORMAT,
	REF_RECORD_FORMAT,
	type LogRecord,
	type CommitDetailRecord,
	type RefRecord,
	type TreeEntry,
	is_safe_ref_name,
	is_safe_path,
	is_full_sha,
	is_no_such_ref_stderr,
	is_no_such_path_stderr,
	is_invalid_pattern_stderr,
	parse_log_records,
	parse_commit_detail,
	parse_ref_records,
	parse_tree_records
} from './parse.ts';

/**
 * Shared UTF-8 decoder. `decode()` is stateless for one-shot (non-streaming)
 * use, so a single module-level instance is safe to reuse everywhere stdout or
 * stderr bytes are turned into a string.
 */
const text_decoder = new TextDecoder('utf-8');
const decode = (bytes: Uint8Array): string => text_decoder.decode(bytes);

/** Max bytes captured from `git log` stdout before the subprocess is killed. */
export const MAX_LOG_BYTES = 1_000_000;

/** Default page size for `read_log`. Detail-page recent-commits panel uses this implicitly via `fuz_forge_repo_log` defaults. */
export const DEFAULT_LOG_LIMIT = 50;

/** Maximum page size for `fuz_forge_repo_log`, enforced by the handler (mirrors the Rust backend) and the spec input cap. */
export const MAX_LOG_LIMIT = 200;

/**
 * Max bytes captured from the metadata `git show --no-patch` call.
 * Commit headers are tiny; 1 MB matches `MAX_LOG_BYTES` so the
 * envelope is uniform across read-only forge subprocess calls.
 */
export const MAX_COMMIT_META_BYTES = 1_000_000;

/**
 * Max bytes captured from the diff body `git show -p` call. Diff
 * bodies can legitimately be much larger than commit metadata —
 * vendored libraries, generated code, etc. — so this cap is set well
 * above the metadata cap. Hitting the cap surfaces a structured
 * `truncated: true` outcome to the UI rather than throwing.
 */
export const MAX_DIFF_BYTES = 5_000_000;

/**
 * Outcome of a read. `ok` cases carry the parsed records; `error` cases
 * distinguish "no such ref" (empty repo / branch not yet pushed / cursor
 * pointing at a GC'd commit) from "subprocess failed" so callers can
 * map them to different HTTP statuses.
 */
export type GitLogResult =
	| { ok: true; commits: Array<LogRecord> }
	| {
			ok: false;
			reason: 'no_such_ref' | 'invalid_pattern' | 'subprocess_failed' | 'output_too_large';
			detail: string;
	  };

/**
 * Fixed message both backends answer an uncompilable `--author` pattern with.
 * Fixed rather than git's stderr, which echoes the pattern back and carries a
 * platform-dependent `regcomp` message. Twin: `INVALID_AUTHOR_PATTERN_MESSAGE`
 * in `forge_git/read.rs`.
 */
export const INVALID_AUTHOR_PATTERN_MESSAGE = 'invalid author pattern';

export interface GitReadDeps {
	spawn_collect: SpawnCollect;
	runtime: Pick<EnvDeps, 'env_get'>;
}

/**
 * Filter / pagination options for `read_log`.
 *
 * `cursor` is a commit SHA of the last record shown on the previous
 * page. The next page is requested as `git log <cursor>^` — i.e. start
 * from the parent of the cursor. That means a force-push that rewrites
 * history between requests yields an empty next page (the cursor SHA
 * may have been GC'd) rather than silently skipping or duplicating
 * commits, which is the desired fail-loud behavior.
 */
export interface ReadLogOptions {
	repo_path: string;
	ref: string;
	limit?: number;
	/** Continue after this commit SHA (exclusive). Must be a full SHA-1. */
	cursor?: string;
	/** `--author=<pattern>` regex. Passed through unmodified. */
	author?: string;
	/** `--since=<approxidate>` (e.g. "2 weeks ago", ISO date). */
	since?: string;
	/** Path filter (after the `--` separator). */
	path?: string;
}

/**
 * Fallback `PATH` for the forge's git subprocesses when the server's own
 * environment carries none.
 *
 * Twin of `DEFAULT_GIT_PATH` in `forge_git/read.rs`, which pins the same
 * literal — a shorter list on either side would resolve `git` differently
 * than the other backend on a host that starts the server without `PATH`.
 * Both sides assert the literal in a unit test so a one-sided edit fails.
 */
export const DEFAULT_GIT_PATH = '/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin';

/**
 * Locked-down subprocess env for every `git` the forge runs outside the CGI
 * proxy: `PATH` + `LC_ALL` + `GIT_TERMINAL_PROMPT` + `GIT_CONFIG_NOSYSTEM`
 * only, never the server's own environment.
 *
 * Twin of `git_env` in `forge_git/read.rs`, and shared with the repo storage
 * layer (`fuz_forge/repo/storage.ts`) the same way the Rust `repo_storage.rs`
 * imports it — one env means `git clone --bare` and `git log` are isolated
 * identically.
 *
 * `GIT_CONFIG_NOSYSTEM=1` is load-bearing, not hygiene: without it
 * `/etc/gitconfig` can carry a `url.<base>.insteadOf` that silently rewrites
 * the remote a validated `seed_from` names, or a `credential.helper` that
 * hands credentials to it. `HOME` is already absent (so `~/.gitconfig` is out
 * of reach) and `GIT_TERMINAL_PROMPT=0` keeps git from blocking on an
 * interactive credential prompt.
 */
export const git_env = (deps: Pick<EnvDeps, 'env_get'>): Record<string, string> => ({
	PATH: deps.env_get('PATH') ?? DEFAULT_GIT_PATH,
	// Some git plumbing reads LC_ALL for output formatting; leave other
	// vars unset so the server's environment doesn't leak through.
	LC_ALL: 'C.UTF-8',
	GIT_TERMINAL_PROMPT: '0',
	GIT_CONFIG_NOSYSTEM: '1'
});

/**
 * Spawn `git -C <repo_path> <sub_args...>` with the locked-down `git_env`
 * envelope and an output cap, returning the raw `SpawnCollectResult` (or
 * throwing — e.g. `SpawnOutputTooLargeError` on cap overflow). The exact
 * structural twin of the Rust backend's `git_collect`
 * (`crates/fuz_forge_server/src/forge_git/read.rs`): both factor the same `-C`-prefix
 * + spawn options shared by every read-only git call. The error-mapping
 * envelope is layered on top in `run_git`.
 */
const git_collect = (
	deps: GitReadDeps,
	repo_path: string,
	sub_args: Array<string>,
	cap: number
): Promise<SpawnCollectResult> =>
	deps.spawn_collect('git', ['-C', repo_path, ...sub_args], {
		env: git_env(deps.runtime),
		max_output_bytes: cap
	});

/**
 * Outcome of `run_git`: the `spawn → try/catch → !success →
 * decode-stderr` scaffold normalized into one discriminated value so each
 * `read_*` maps it to its own reason union. `nonzero` carries the stderr
 * (decoded once) and exit code; `too_large` is split from `thrown` so a caller
 * can turn a cap overflow into a structured outcome (e.g. `read_commit`'s
 * `truncated`) rather than a generic failure. Twin of the Rust `GitFail`
 * (`crates/fuz_forge_server/src/forge_git/read.rs`), which splits the same
 * three failure kinds off an `Ok(stdout)`.
 */
type GitRun =
	| { ok: true; stdout: Uint8Array }
	| { ok: false; kind: 'thrown'; detail: string }
	| { ok: false; kind: 'too_large'; detail: string }
	| { ok: false; kind: 'nonzero'; stderr: string; code: number };

/**
 * `git_collect` wrapped in the shared error envelope: catches the spawn
 * throw (splitting `SpawnOutputTooLargeError` into `too_large`) and folds
 * a non-zero exit into `nonzero` with stderr decoded once. Twin of the Rust
 * `git_run` — the recurring scaffold is factored here so callers own only the
 * reason mapping, and a spawn failure can never reach a caller as anything but
 * a classified failure.
 */
const run_git = async (
	deps: GitReadDeps,
	repo_path: string,
	sub_args: Array<string>,
	cap: number
): Promise<GitRun> => {
	let result;
	try {
		result = await git_collect(deps, repo_path, sub_args, cap);
	} catch (err) {
		const detail = to_error_message(err);
		return is_output_too_large(err)
			? { ok: false, kind: 'too_large', detail }
			: { ok: false, kind: 'thrown', detail };
	}
	if (!result.success) {
		return { ok: false, kind: 'nonzero', stderr: decode(result.stderr), code: result.code };
	}
	return { ok: true, stdout: result.stdout };
};

/**
 * Render the `subprocess_failed` detail for a non-ok `run_git` outcome:
 * the stderr (or `exit code N` when stderr is empty) for `nonzero`, else the
 * thrown message.
 */
const fail_detail = (r: Extract<GitRun, { ok: false }>): string =>
	r.kind === 'nonzero' ? r.stderr || `exit code ${r.code}` : r.detail;

const collect_git_log = async (
	deps: GitReadDeps,
	repo_path: string,
	args: Array<string>
): Promise<GitLogResult> => {
	const r = await run_git(deps, repo_path, args, MAX_LOG_BYTES);
	if (r.ok) return { ok: true, commits: parse_log_records(r.stdout) };
	if (r.kind === 'too_large') return { ok: false, reason: 'output_too_large', detail: r.detail };
	// The pattern check runs FIRST, and the order is load-bearing rather than
	// stylistic: git echoes the client's `--author` pattern into this stderr,
	// so `--author=bad revision [` produces a message the substring
	// `is_no_such_ref_stderr` below also matches — and would answer the empty
	// page where `-32602` is the truth. `is_invalid_pattern_stderr` is anchored
	// (a line must *start with* git's prefix), so it can only fire on a real
	// compile failure; asking it first therefore cannot steal a genuine ref
	// miss, while asking it second would let a client forge one. Same order,
	// same reason, in the Rust `read_log`.
	if (r.kind === 'nonzero' && is_invalid_pattern_stderr(r.stderr)) {
		return { ok: false, reason: 'invalid_pattern', detail: r.stderr };
	}
	// A "no such ref" exit is the empty-repo / unpushed-branch / GC'd-cursor
	// case — surfaced as an empty page, not an error.
	if (r.kind === 'nonzero' && is_no_such_ref_stderr(r.stderr)) return { ok: true, commits: [] };
	return { ok: false, reason: 'subprocess_failed', detail: fail_detail(r) };
};

/**
 * Resolve a rev to a full object SHA via `git rev-parse`, mapping the outcome
 * to the `no_such_ref`-vs-`subprocess_failed` distinction shared by
 * `read_default_branch_tip` and `read_tree`. (`read_blob` resolves
 * its own rev inline — it needs the extra ref-vs-path disambiguation probe.)
 * Twin of the Rust `resolve_sha` + `ResolveFail`
 * (`crates/fuz_forge_server/src/forge_git/read.rs`), which splits the same two
 * reasons off an `Ok(sha)`.
 */
const resolve_sha = async (
	deps: GitReadDeps,
	repo_path: string,
	rev_args: Array<string>
): Promise<
	| { ok: true; sha: string }
	| { ok: false; reason: 'no_such_ref' | 'subprocess_failed'; detail: string }
> => {
	const r = await run_git(deps, repo_path, rev_args, 4096);
	if (!r.ok) {
		if (r.kind === 'nonzero' && is_no_such_ref_stderr(r.stderr)) {
			return { ok: false, reason: 'no_such_ref', detail: r.stderr };
		}
		return { ok: false, reason: 'subprocess_failed', detail: fail_detail(r) };
	}
	const sha = decode(r.stdout).trim();
	if (!is_full_sha(sha)) {
		return { ok: false, reason: 'subprocess_failed', detail: 'rev-parse returned non-sha' };
	}
	return { ok: true, sha };
};

/**
 * Run a filtered `git log` against a bare repo and parse the result.
 *
 * Cursor pagination: when `cursor` is set, the rev becomes `<cursor>^`
 * so the next page starts at the parent of the previous page's last
 * commit. On a merge commit cursor, `^` is the first parent — linear
 * mainline pagination is the v1 trade-off for force-push immunity.
 *
 * Returns a structured error on:
 * - unknown ref / cursor not present (e.g. GC'd by force-push) →
 *   `no_such_ref`
 * - an `author` pattern git's regex compiler refuses → `invalid_pattern`
 * - other subprocess failure → `subprocess_failed` with stderr detail
 * - output exceeded `MAX_LOG_BYTES` → `output_too_large`
 */
export const read_log = async (
	deps: GitReadDeps,
	options: ReadLogOptions
): Promise<GitLogResult> => {
	const { repo_path, ref, cursor, author, since, path } = options;
	// No clamp here — the caller (handler) clamps the page size to MAX_LOG_LIMIT
	// and passes `limit + 1` as a pagination probe, which must reach git intact
	// (matches the Rust `read_log`, which also trusts its caller's limit).
	const limit = options.limit ?? DEFAULT_LOG_LIMIT;
	if (!is_safe_ref_name(ref)) {
		return { ok: false, reason: 'no_such_ref', detail: `unsafe ref name: ${ref}` };
	}
	if (cursor !== undefined && !is_full_sha(cursor)) {
		// Reject anything that isn't a plain SHA-1 — the cursor goes
		// into an argv slot. Defense-in-depth in case a `-flag` slipped
		// through past the spec's max-length check.
		return { ok: false, reason: 'no_such_ref', detail: `invalid cursor: ${cursor}` };
	}
	const rev = cursor === undefined ? ref : `${cursor}^`;

	const args = ['log', '-n', String(limit), `--format=${LOG_RECORD_FORMAT}%x1e`];
	if (author !== undefined && author.length > 0) {
		// A regex passed through unmodified: git compiles it, and an
		// uncompilable one comes back as the `invalid_pattern` reason via
		// `is_invalid_pattern_stderr` rather than a transient failure.
		args.push(`--author=${author}`);
	}
	if (since !== undefined && since.length > 0) {
		args.push(`--since=${since}`);
	}
	args.push(rev, '--');
	if (path !== undefined && path.length > 0) {
		// `path` lands after `--`; git treats it as a pathspec, not a
		// flag, so leading-dash strings are safe here. Skip empties to
		// keep the argv tight.
		args.push(path);
	}
	return collect_git_log(deps, repo_path, args);
};

/**
 * Outcome of `read_default_branch_tip`. `no_such_ref` is the
 * expected response when the branch hasn't been pushed yet (empty
 * repo) or when the configured `default_branch` no longer exists on
 * disk — the resync handler maps this to `head_sha: null`.
 * `subprocess_failed` is preserved separately so callers can refuse
 * to overwrite a known-good `head_sha` based on a transient error.
 */
export type GitDefaultBranchTipResult =
	| { ok: true; sha: string }
	| { ok: false; reason: 'no_such_ref' | 'subprocess_failed'; detail: string };

/**
 * Resolve the tip SHA of `refs/heads/<default_branch>` in a bare repo
 * via `git rev-parse --verify`. Used by `fuz_forge_repo_resync` to refresh
 * the cell's `head_sha` from on-disk truth.
 *
 * Distinguishes "branch absent" (empty repo or renamed-away default)
 * from a real subprocess failure so the handler can write `null` on
 * the former but leave the cell untouched on the latter. Shares the
 * env-isolation envelope with the read-only forge family.
 *
 * `--verify` on an absent `refs/heads/<b>` prints `Needed a single revision`,
 * not the `bad revision` `read_log` sees — see
 * `is_no_such_ref_stderr`'s per-argv table.
 */
export const read_default_branch_tip = async (
	deps: GitReadDeps,
	options: { repo_path: string; default_branch: string }
): Promise<GitDefaultBranchTipResult> => {
	const { repo_path, default_branch } = options;
	if (!is_safe_ref_name(default_branch)) {
		return { ok: false, reason: 'no_such_ref', detail: `unsafe ref name: ${default_branch}` };
	}
	return resolve_sha(deps, repo_path, ['rev-parse', '--verify', `refs/heads/${default_branch}`]);
};

export interface ReadCommitOptions {
	repo_path: string;
	/** Full 40-char SHA-1 of the commit. Validated as hex before spawn. */
	sha: string;
}

/**
 * Outcome of a `read_commit` call. Diff is structured so a
 * size-cap hit surfaces as `{text: '', truncated: true}` rather than
 * an error — the UI renders the commit metadata and a "diff too
 * large" notice instead of failing the whole page.
 */
export type GitCommitResult =
	| {
			ok: true;
			commit: CommitDetailRecord;
			diff: { text: string; truncated: boolean };
	  }
	| { ok: false; reason: 'no_such_ref' | 'subprocess_failed'; detail: string };

/**
 * Fetch a single commit's metadata + diff body via two `git show`
 * subprocesses with independent byte caps.
 *
 * Two subprocesses (vs one combined `git show --format=… -p`):
 * - Metadata header has a tight cap (`MAX_COMMIT_META_BYTES`)
 *   matching the read-only forge family's 1 MB budget.
 * - Diff body has a much larger cap (`MAX_DIFF_BYTES`, 5 MB);
 *   merging them would force a single 6 MB envelope where 99% of
 *   responses fit in <10 KB.
 * - The diff body's `truncated: true` outcome must not poison the
 *   metadata fetch — splitting keeps the surfaces independent.
 *
 * Both calls share `git_env` so the env-isolation contract is
 * identical to `read_log`.
 */
export const read_commit = async (
	deps: GitReadDeps,
	options: ReadCommitOptions
): Promise<GitCommitResult> => {
	const { repo_path, sha } = options;
	if (!is_full_sha(sha)) {
		// The SHA lands in an argv slot before `--`. A non-hex value
		// could be interpreted as a `-flag` if anything slipped past
		// the spec's max-length check.
		return { ok: false, reason: 'no_such_ref', detail: `invalid sha: ${sha}` };
	}
	// Metadata fetch — `--no-patch` suppresses the diff so the small
	// cap is sufficient.
	const meta = await run_git(
		deps,
		repo_path,
		['show', '--no-patch', `--format=${COMMIT_DETAIL_FORMAT}`, sha, '--'],
		MAX_COMMIT_META_BYTES
	);
	if (!meta.ok) {
		if (
			meta.kind === 'nonzero' &&
			(is_no_such_ref_stderr(meta.stderr) || meta.stderr.includes('bad object'))
		) {
			return { ok: false, reason: 'no_such_ref', detail: meta.stderr };
		}
		return { ok: false, reason: 'subprocess_failed', detail: fail_detail(meta) };
	}
	// Unparseable metadata is a *client* miss, not a server bug: `git show
	// --no-patch --format=… <sha> --` exits 0 with non-commit output whenever
	// `sha` names a blob or a tree — and `read_blob` hands clients blob SHAs to
	// paste back here. `no_such_ref` → the handler's `not_found('commit')`,
	// matching the Rust twin's `read_commit`.
	const commit = parse_commit_detail(meta.stdout);
	if (!commit) {
		return { ok: false, reason: 'no_such_ref', detail: 'malformed commit metadata' };
	}
	// The parse succeeding is not enough: `git show --no-patch --format=…
	// <annotated-tag-sha> --` exits **0** and prints git's tag preamble
	// (`tag <name>` / `Tagger: …` / the tag message) followed by the *peeled*
	// commit's full 11-field record — so the parse succeeds and `%H` comes back
	// carrying the preamble ahead of the commit sha. `read_refs` hands clients
	// exactly that sha for every `refs/tags/*` annotated tag, so it is trivially
	// reachable. Requiring `%H` to be the sha the client asked for rejects it
	// (and, by construction, every other non-commit object: a blob or tree
	// prints bytes that either fail the field-count check or can't echo the
	// requested sha). 404 `commit`, matching the Rust twin's `read_commit`.
	// It is *not* what rejects a case-variant sha: `is_full_sha` is
	// lowercase-only on both backends, so an uppercase sha is refused by the
	// argv guard above and never reaches git (which would happily resolve it).
	if (commit.sha !== sha) {
		return { ok: false, reason: 'no_such_ref', detail: 'sha does not name a commit' };
	}

	// Diff body fetch — empty `--format=` makes show emit only the
	// patch (no header), so the body field is pure unified diff.
	// `--no-color` blocks ANSI escapes if the operator ever sets
	// `color.ui=always` in /etc/gitconfig; `--full-index` produces
	// stable hash output for future hunk-level diffing.
	const diff = await run_git(
		deps,
		repo_path,
		['show', '-p', '--format=', '--no-color', '--full-index', sha, '--'],
		MAX_DIFF_BYTES
	);
	let diff_text = '';
	let truncated = false;
	if (diff.ok) {
		diff_text = decode(diff.stdout);
	} else if (diff.kind === 'too_large') {
		// Cap-on-overflow surfaces structured rather than blowing up the whole
		// response — the metadata is still useful.
		truncated = true;
	} else {
		return { ok: false, reason: 'subprocess_failed', detail: fail_detail(diff) };
	}

	return { ok: true, commit, diff: { text: diff_text, truncated } };
};

/**
 * Max bytes captured from `git for-each-ref`. Even a fairly busy repo
 * with hundreds of refs comfortably fits in 1 MB.
 */
export const MAX_REFS_BYTES = 1_000_000;

/**
 * Max bytes captured from `git ls-tree`. Trees at monorepo roots can
 * be large (thousands of entries × ~80 bytes/line), but a single tree
 * level rarely exceeds a few hundred KB. 5 MB matches the diff cap.
 */
export const MAX_TREE_BYTES = 5_000_000;

/**
 * Max bytes captured from `git cat-file blob`. Matches the diff cap —
 * larger files surface as `{kind: 'truncated'}` so the UI shows a
 * notice + fallback command rather than streaming megabytes into the
 * JSON-RPC envelope.
 */
export const MAX_BLOB_BYTES = 5_000_000;

export type GitRefsResult =
	| { ok: true; refs: Array<RefRecord> }
	| { ok: false; reason: 'subprocess_failed' | 'output_too_large'; detail: string };

/**
 * List all branches and tags in a bare repo via `git for-each-ref`.
 *
 * Filtered to `refs/heads` and `refs/tags` only — `refs/remotes`,
 * `refs/notes`, etc. are not surfaced because fuz_forge doesn't host remotes
 * or notes (bare repos receive pushes directly).
 */
export const read_refs = async (
	deps: GitReadDeps,
	options: { repo_path: string }
): Promise<GitRefsResult> => {
	const { repo_path } = options;
	const r = await run_git(
		deps,
		repo_path,
		['for-each-ref', `--format=${REF_RECORD_FORMAT}`, 'refs/heads', 'refs/tags'],
		MAX_REFS_BYTES
	);
	if (r.ok) return { ok: true, refs: parse_ref_records(r.stdout) };
	if (r.kind === 'too_large') return { ok: false, reason: 'output_too_large', detail: r.detail };
	return { ok: false, reason: 'subprocess_failed', detail: fail_detail(r) };
};

export type GitTreeResult =
	| { ok: true; entries: Array<TreeEntry>; resolved_sha: string }
	| {
			ok: false;
			reason: 'no_such_ref' | 'no_such_path' | 'subprocess_failed' | 'output_too_large';
			detail: string;
	  };

/**
 * List entries at a path within a tree. `path === ''` means the root
 * tree. Returns both the parsed entries and the resolved tree-ish SHA
 * (for breadcrumb anchoring and stable URLs even when refs move).
 *
 * Resolution: a separate `git rev-parse <ref>` returns the SHA the
 * ref currently points at — done as a second subprocess so the
 * `ls-tree` output cap doesn't impact the SHA fetch.
 */
export const read_tree = async (
	deps: GitReadDeps,
	options: { repo_path: string; ref: string; path: string }
): Promise<GitTreeResult> => {
	const { repo_path, ref, path } = options;
	if (!is_safe_ref_name(ref)) {
		return { ok: false, reason: 'no_such_ref', detail: `unsafe ref name: ${ref}` };
	}
	if (!is_safe_path(path)) {
		return { ok: false, reason: 'no_such_path', detail: `unsafe path: ${path}` };
	}
	const resolved = await resolve_sha(deps, repo_path, ['rev-parse', ref]);
	if (!resolved.ok) return resolved;
	const resolved_sha = resolved.sha;

	// `<sha>:<path>` lands as a single argv slot before `--`. When path
	// is empty, `<sha>:` resolves to the root tree of the commit.
	const rev = `${resolved_sha}:${path}`;
	const tr = await run_git(deps, repo_path, ['ls-tree', '-l', rev], MAX_TREE_BYTES);
	if (tr.ok) return { ok: true, entries: parse_tree_records(tr.stdout), resolved_sha };
	if (tr.kind === 'too_large') return { ok: false, reason: 'output_too_large', detail: tr.detail };
	if (tr.kind === 'nonzero' && is_no_such_path_stderr(tr.stderr)) {
		return { ok: false, reason: 'no_such_path', detail: tr.stderr };
	}
	return { ok: false, reason: 'subprocess_failed', detail: fail_detail(tr) };
};

export type BlobBody =
	{ kind: 'text'; text: string } | { kind: 'binary' } | { kind: 'truncated'; size: number };

export type GitBlobResult =
	| {
			ok: true;
			sha: string;
			size: number;
			body: BlobBody;
	  }
	| {
			ok: false;
			reason: 'no_such_ref' | 'no_such_path' | 'not_a_blob' | 'subprocess_failed';
			detail: string;
	  };

/**
 * Bytes of a blob scanned for a NUL when classifying text vs binary. Twin of
 * `BLOB_BINARY_SNIFF_BYTES` in `forge_git/read.rs`: a wider window on one
 * backend would classify a blob whose first NUL sits past the other's window
 * as binary where the other serves it as text.
 */
export const BLOB_BINARY_SNIFF_BYTES = 8192;

/** Heuristic: a NUL byte in the first window means binary. */
const looks_binary = (bytes: Uint8Array): boolean => {
	const sniff_len = Math.min(bytes.length, BLOB_BINARY_SNIFF_BYTES);
	for (let i = 0; i < sniff_len; i++) {
		if (bytes[i] === 0) return true;
	}
	return false;
};

/**
 * Fetch a single blob via three subprocesses: peel-to-blob (resolves
 * SHA and asserts type), size probe, body fetch. Separating size from
 * body lets us return `{kind: 'truncated', size}` without ever
 * materializing the oversize blob — important when a hosted repo
 * contains a 200 MB lockfile or generated SQL dump.
 *
 * `spawn_collect` has no stdin, so `git cat-file --batch-check` (which
 * would collapse sha+type+size into one call) isn't reachable.
 */
export const read_blob = async (
	deps: GitReadDeps,
	options: { repo_path: string; ref: string; path: string }
): Promise<GitBlobResult> => {
	const { repo_path, ref, path } = options;
	if (!is_safe_ref_name(ref)) {
		return { ok: false, reason: 'no_such_ref', detail: `unsafe ref name: ${ref}` };
	}
	if (!is_safe_path(path) || path.length === 0) {
		return { ok: false, reason: 'no_such_path', detail: `unsafe or empty path: ${path}` };
	}
	// `<ref>:<path>` names the object directly via `git rev-parse`. Do NOT
	// append a `^{blob}` peel suffix — git parses the trailing `^{blob}` as
	// part of the *path* (`<path>^{blob}`), turning a valid blob into a
	// no-such-path miss. The object's type is asserted separately below via
	// `cat-file -t` so a tree (directory) path still maps to `not_a_blob`.
	const rev = `${ref}:${path}`;

	const sha_run = await run_git(deps, repo_path, ['rev-parse', '--verify', rev], 4096);
	if (!sha_run.ok) {
		// A throw (process limit, ENOMEM, cap overflow) is a real failure;
		// only a non-zero exit triggers the ref-vs-path disambiguation.
		if (sha_run.kind !== 'nonzero') {
			return { ok: false, reason: 'subprocess_failed', detail: sha_run.detail };
		}
		// Unknown ref and unknown path share stderr shape. A second probe
		// against the ref alone disambiguates: if it resolves, the path is
		// the problem. The probe's own failure (throw or non-zero) falls back
		// to the conservative `no_such_ref` bucket — the caller maps both to
		// 404 anyway, and a partial 5xx here would lose the original stderr.
		const ref_only = await run_git(
			deps,
			repo_path,
			['rev-parse', '--verify', `${ref}^{commit}`],
			4096
		);
		return ref_only.ok
			? { ok: false, reason: 'no_such_path', detail: sha_run.stderr }
			: { ok: false, reason: 'no_such_ref', detail: sha_run.stderr };
	}
	const sha = decode(sha_run.stdout).trim();
	if (!is_full_sha(sha)) {
		return { ok: false, reason: 'subprocess_failed', detail: 'rev-parse returned non-sha' };
	}

	// Assert the resolved object is a blob — `<ref>:<dir>` resolves to a tree
	// SHA, which would otherwise fail confusingly at the body fetch.
	const type_run = await run_git(deps, repo_path, ['cat-file', '-t', sha], 64);
	if (!type_run.ok) {
		return { ok: false, reason: 'subprocess_failed', detail: fail_detail(type_run) };
	}
	const object_type = decode(type_run.stdout).trim();
	if (object_type !== 'blob') {
		return { ok: false, reason: 'not_a_blob', detail: `object is a ${object_type}, not a blob` };
	}

	const size_run = await run_git(deps, repo_path, ['cat-file', '-s', sha], 64);
	if (!size_run.ok) {
		return { ok: false, reason: 'subprocess_failed', detail: fail_detail(size_run) };
	}
	const size = Number.parseInt(decode(size_run.stdout).trim(), 10);
	if (!Number.isFinite(size) || size < 0) {
		return { ok: false, reason: 'subprocess_failed', detail: 'cat-file -s returned non-number' };
	}

	if (size > MAX_BLOB_BYTES) {
		return { ok: true, sha, size, body: { kind: 'truncated', size } };
	}

	const body_run = await run_git(deps, repo_path, ['cat-file', 'blob', sha], MAX_BLOB_BYTES);
	if (!body_run.ok) {
		// A cap overflow degrades to the structured `truncated` body rather than
		// a failure — the same arm the Rust twin's `read_blob` takes on
		// `GitFail::TooLarge`. Unreachable while the `size > MAX_BLOB_BYTES`
		// pre-check above fires first, but the two unions have to match
		// branch-for-branch or a future change to that pre-check silently
		// diverges the backends (503 here, `truncated` there).
		if (body_run.kind === 'too_large') {
			return { ok: true, sha, size, body: { kind: 'truncated', size } };
		}
		return { ok: false, reason: 'subprocess_failed', detail: fail_detail(body_run) };
	}
	if (looks_binary(body_run.stdout)) {
		return { ok: true, sha, size, body: { kind: 'binary' } };
	}
	return { ok: true, sha, size, body: { kind: 'text', text: decode(body_run.stdout) } };
};
