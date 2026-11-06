/**
 * Shared git push/clone helpers for the cross-backend suites that drive the
 * forge's smart-HTTP write path against the spawned binary (Deno/Hono + Rust
 * `fuz_forge_server`).
 *
 * Every suite that seeds history builds it the same way — a work tree under
 * the system temp dir, one commit per file, a push over Basic auth — so the
 * whole chain lives here rather than inline per suite: the deterministic git
 * env, the `git` runner, the work-repo + commit composites, and the
 * Basic-auth push-url builder. A backend that changes the smart-HTTP shape,
 * or a git release that changes the default branch name, then breaks every
 * consumer at one callsite.
 *
 * Requires `git` on the host; the forge's smart-HTTP routes additionally need
 * `python3` (the installed hooks are python3) — both are present wherever the
 * cross suites run.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { assert } from 'vitest';

const run = promisify(execFile);

/**
 * Deterministic, host-config-free git env so commits are reproducible and
 * never prompt for credentials. `GIT_CONFIG_GLOBAL`/`_SYSTEM` → `/dev/null`
 * isolates from the host's git config; the fixed author/committer identity
 * makes the recorded SHA + committer fields stable across machines.
 */
export const GIT_ENV = {
	...process.env,
	GIT_TERMINAL_PROMPT: '0',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_SYSTEM: '/dev/null',
	GIT_AUTHOR_NAME: 'Forge Test',
	GIT_AUTHOR_EMAIL: 'test@fuz.dev',
	GIT_COMMITTER_NAME: 'Forge Test',
	GIT_COMMITTER_EMAIL: 'test@fuz.dev'
};

/** Run `git <args>` in `cwd` under the deterministic env. */
export const git = (
	cwd: string,
	args: Array<string>
): Promise<{ stdout: string; stderr: string }> => run('git', args, { cwd, env: GIT_ENV });

/**
 * Build a smart-HTTP clone/push URL embedding HTTP Basic credentials
 * (username + raw api_token) for `<slug>.git` against the spawned binary.
 *
 * The token is the keeper's raw api_token; both backends authenticate the
 * push as the admin behind that token. The username/password are
 * percent-encoded so tokens with URL-significant characters round-trip.
 */
export const push_url = (
	base_url: string,
	username: string,
	token: string,
	slug: string
): string => {
	const user = encodeURIComponent(username);
	const pass = encodeURIComponent(token);
	return `${base_url.replace('://', `://${user}:${pass}@`)}/${slug}.git`;
};

/**
 * Extract the raw api_token from a fixture's bearer `Authorization` header
 * (either casing), stripping the `Bearer ` scheme prefix. Used to build the
 * Basic-auth push URL — git push authenticates with the api_token as the
 * Basic password.
 */
export const keeper_token = (headers: Record<string, string>): string => {
	const value = headers.Authorization ?? headers.authorization;
	assert.ok(value, 'expected a bearer Authorization header');
	return value.replace(/^Bearer /, '');
};

/**
 * Create a work tree under the system temp dir with an initialized git repo on
 * `main`. `prefix` names the owning suite so an abandoned crash dir traces back
 * to its origin; the caller registers the returned path for cleanup.
 *
 * `-b main` is explicit rather than inherited: git's compiled-in default is
 * still `master` on hosts without `init.defaultBranch`, and `GIT_ENV`
 * points the global config at `/dev/null` so no host setting can supply one.
 * The pushes here name the destination ref outright (`HEAD:refs/heads/main`),
 * so the local branch name is invisible to the forge — but a case that
 * branches and comes back (`git checkout -b side` … `git checkout main`) needs
 * the local name to be the one the forge's `default_branch` is.
 */
export const create_work_repo = async (prefix: string): Promise<string> => {
	const work = await mkdtemp(join(tmpdir(), `fuz_forge-${prefix}-`));
	await git(work, ['init', '-b', 'main']);
	return work;
};

/**
 * Write `files` into the work tree, stage them, and commit as `message`.
 * Returns the new `HEAD` sha, which is what the callers assert against
 * `head_sha` / `commits[0].sha`. A key with a `/` in it seeds a subdirectory —
 * parents are created — so a case can build a nested tree in one call.
 *
 * The author and committer are `GIT_ENV`'s fixed forge-test identity; a case
 * that needs a per-commit author or date uses `commit_file` instead.
 */
export const commit_files = async (
	work: string,
	files: Record<string, string | Uint8Array>,
	message: string
): Promise<string> => {
	for (const [name, content] of Object.entries(files)) {
		const path = join(work, name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content);
	}
	await git(work, ['add', '.']);
	await git(work, ['commit', '-m', message]);
	return (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();
};

/**
 * Commit a single file with an explicit author + date. Both the author date
 * (`--date`) and the committer date (`GIT_COMMITTER_DATE`) are pinned to
 * `iso_date` because `git log --since` filters on the *committer* date — a
 * commit authored in the past but committed "now" would otherwise slip past
 * the `since` window. The committer *identity* stays the deterministic
 * forge-test identity from `GIT_ENV`; only the *author* and the dates
 * vary.
 */
export const commit_file = async (
	work: string,
	file: string,
	content: string,
	author: { name: string; email: string },
	iso_date: string
): Promise<void> => {
	await writeFile(join(work, file), content);
	await git(work, ['add', file]);
	await run(
		'git',
		[
			'-c',
			`user.name=${author.name}`,
			'-c',
			`user.email=${author.email}`,
			'commit',
			'-m',
			`touch ${file}`,
			`--author=${author.name} <${author.email}>`,
			`--date=${iso_date}`
		],
		{ cwd: work, env: { ...GIT_ENV, GIT_COMMITTER_DATE: iso_date } }
	);
};

/** Where a push goes: the spawned backend, the credential, and the repo slug. */
export interface PushTarget {
	base_url: string;
	username: string;
	token: string;
	slug: string;
}

/**
 * Push `refspecs` to the forge over smart-HTTP with Basic auth. A rejected
 * push exits non-zero, so the returned promise rejecting *is* the assertion
 * for the negative cases; resolving means the forge accepted the pack.
 */
export const push_refs = (
	work: string,
	target: PushTarget,
	refspecs: Array<string>
): Promise<{ stdout: string; stderr: string }> =>
	git(work, [
		'push',
		push_url(target.base_url, target.username, target.token, target.slug),
		...refspecs
	]);
