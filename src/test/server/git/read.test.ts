/**
 * Unit coverage for `server/git/read.ts`: the locked-down git subprocess env,
 * the read layer's numeric bounds, and the `git log` stderr classifier chain.
 *
 * The env is a security surface — it is what keeps `/etc/gitconfig`,
 * `~/.gitconfig` and the server's own environment out of every `git` the forge
 * runs — and it is hand-written twice, so both halves live in
 * `src/test/fixtures/parity/git_env.json`: the exact key set, and the
 * `DEFAULT_GIT_PATH` literal the two backends fall back to when the server
 * starts without a `PATH`. The bounds come from `…/git_read_bounds.json`. The
 * Rust twins are `forge_git/read/tests.rs` and `handlers/repo_read/tests.rs`.
 *
 * @module
 */

import { test, describe, assert } from 'vitest';

import type { SpawnCollect } from '#lib/server/subprocess.ts';
import { is_invalid_pattern_stderr, is_no_such_ref_stderr } from '#lib/server/git/parse.ts';
import {
	BLOB_BINARY_SNIFF_BYTES,
	DEFAULT_GIT_PATH,
	DEFAULT_LOG_LIMIT,
	MAX_BLOB_BYTES,
	MAX_COMMIT_META_BYTES,
	MAX_DIFF_BYTES,
	MAX_LOG_BYTES,
	MAX_LOG_LIMIT,
	MAX_REFS_BYTES,
	MAX_TREE_BYTES,
	git_env,
	read_log
} from '#lib/server/git/read.ts';
import { load_parity_fixture, parity_rows, parity_string } from '../../fixtures/parity/load.ts';

describe('git_env', () => {
	// The env is a security surface — it is what keeps `/etc/gitconfig`,
	// `~/.gitconfig` and the server's own environment out of every `git` the
	// forge runs — and it is hand-written twice, so both halves are asserted
	// against `src/test/fixtures/parity/git_env.json`, which the Rust twin's
	// `git_env_carries_the_injected_path_and_the_locked_down_keys` reads too. A
	// shorter `DEFAULT_GIT_PATH` resolves `git` differently on a host that starts
	// the server without `PATH`.
	const fixture = load_parity_fixture('git_env');
	const constants: Record<string, unknown> = { DEFAULT_GIT_PATH };

	for (const row of parity_rows(fixture, 'constants')) {
		const name = parity_string(row, 'name');
		test(`the shared constant ${name}`, () => {
			assert.strictEqual(constants[name], row.value);
		});
	}

	test('PATH comes from the env deps, falling back to DEFAULT_GIT_PATH', () => {
		assert.strictEqual(git_env({ env_get: () => '/injected/bin' }).PATH, '/injected/bin');
		assert.strictEqual(git_env({ env_get: () => undefined }).PATH, DEFAULT_GIT_PATH);
	});

	test('the key set is exactly the locked-down four', () => {
		// No server env leaks in, and `GIT_CONFIG_NOSYSTEM` is present on both.
		const env = git_env({ env_get: () => undefined });
		assert.deepStrictEqual(
			Object.keys(env).sort(),
			parity_rows(fixture, 'keys').map((row) => parity_string(row, 'name'))
		);
	});

	for (const row of parity_rows(fixture, 'env')) {
		const name = parity_string(row, 'name');
		test(`the fixed env pair ${name}`, () => {
			const env: Record<string, string> = git_env({ env_get: () => undefined });
			assert.strictEqual(env[name], row.value);
		});
	}
});

describe('read-layer bounds', () => {
	// Every bound the read layer applies is declared twice, and each one is a
	// *wire* contract rather than an implementation detail: a smaller diff cap
	// on one backend answers `truncated: true` where the other returns the
	// patch, a smaller blob cap answers `{kind: 'truncated'}` where the other
	// returns the bytes, a narrower sniff window calls a blob binary where the
	// other calls it text, and a different page limit pages differently. The
	// Rust twins (`forge_git/read/tests.rs:read_layer_bounds_match_the_ts_twin`
	// and `handlers/repo_read/tests.rs:log_page_limits_match_the_ts_twin`) read
	// the same `src/test/fixtures/parity/git_read_bounds.json`.
	const fixture = load_parity_fixture('git_read_bounds');
	const declared: Record<string, unknown> = {
		MAX_LOG_BYTES,
		MAX_COMMIT_META_BYTES,
		MAX_DIFF_BYTES,
		MAX_REFS_BYTES,
		MAX_TREE_BYTES,
		MAX_BLOB_BYTES,
		BLOB_BINARY_SNIFF_BYTES,
		DEFAULT_LOG_LIMIT,
		MAX_LOG_LIMIT
	};

	for (const table of ['byte_caps', 'log_page_limits']) {
		for (const row of parity_rows(fixture, table)) {
			const name = parity_string(row, 'name');
			test(`${table}: ${name}`, () => {
				assert.strictEqual(declared[name], row.value);
			});
		}
	}
});

describe('read_log stderr classification', () => {
	/**
	 * A `spawn_collect` that never runs git: it fails with the given stderr and
	 * a git-shaped exit code, so a case can hand the classifier chain a byte
	 * string it would be awkward to provoke for real. The Rust twin has no such
	 * seam (its subprocess layer is not injected) and pins the same chain
	 * against **real** git instead —
	 * `forge_git/read.rs:read_log_refuses_an_uncompilable_author_pattern`,
	 * whose first assertion is that git's own stderr for this pattern is
	 * byte-for-byte the shape injected below.
	 */
	const failing_spawn = (stderr: string): SpawnCollect => {
		return async () => ({
			stdout: new Uint8Array(),
			stderr: new TextEncoder().encode(stderr),
			code: 128,
			success: false
		});
	};

	const deps = (stderr: string) => ({
		spawn_collect: failing_spawn(stderr),
		runtime: { env_get: () => undefined }
	});

	const log = (stderr: string) =>
		read_log(deps(stderr), { repo_path: '/nonexistent.git', ref: 'main', author: 'ignored' });

	test('an uncompilable author pattern is the invalid_pattern reason', async () => {
		const result = await log("fatal: header, '[': Invalid regular expression");
		assert.isFalse(result.ok);
		assert.strictEqual(result.reason, 'invalid_pattern');
	});

	test('a warning line ahead of the fatal still classifies', async () => {
		// git prints a `warning:` before the `fatal:` when the rev is an
		// ambiguous refname, so the prefix is not always at byte 0 — which is
		// why the predicate anchors per LINE rather than per message.
		const result = await log(
			"warning: refname 'dup' is ambiguous.\nfatal: header, '[': Invalid regular expression"
		);
		assert.isFalse(result.ok);
		assert.strictEqual(result.reason, 'invalid_pattern');
	});

	test('a pattern echoing a ref-miss vocabulary is still the invalid_pattern reason', async () => {
		// The ordering pin, which no predicate test can express. git echoes the
		// client's pattern into its own message, so this real git stderr
		// satisfies `is_no_such_ref_stderr` as well — and with the two checks
		// swapped, `read_log` answers the EMPTY PAGE for what is a `-32602`.
		// Same case, against real git, in the Rust twin.
		const stderr = "fatal: header, 'bad revision [': Invalid regular expression";
		assert.isTrue(is_no_such_ref_stderr(stderr), 'the collision is live, not hypothetical');
		assert.isTrue(is_invalid_pattern_stderr(stderr));
		const result = await log(stderr);
		assert.isFalse(result.ok);
		assert.strictEqual(result.reason, 'invalid_pattern');
	});

	test('a genuine ref miss is still the empty page', async () => {
		// The control the ordering cases need: moving the pattern check first
		// must not steal an ordinary absent-ref exit.
		const result = await log("fatal: bad revision 'no-such-branch'");
		assert.isTrue(result.ok);
		assert.deepStrictEqual(result.ok ? result.commits : null, []);
	});

	test('an unclassified stderr stays a transient read failure', async () => {
		const result = await log(
			'fatal: not a git repository (or any of the parent directories): .git'
		);
		assert.isFalse(result.ok);
		assert.strictEqual(result.reason, 'subprocess_failed');
	});
});
