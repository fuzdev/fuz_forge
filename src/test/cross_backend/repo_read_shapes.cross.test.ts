/**
 * Cross-process **repo read-shape** suite — run against BOTH fuz_forge backends
 * (TS/Hono + Rust `fuz_forge_server`) via the `cross_backend_*` mechanism.
 *
 * `repo_push.cross.test.ts` drives the write path and reads a *linear,
 * single-commit, small-object* repo back through every read RPC. The shapes
 * below need history that suite deliberately doesn't build — a merge, an
 * annotated **and** a lightweight tag, a binary blob, and objects past the read
 * layer's byte caps — so they live here over one purpose-built fixture repo
 * rather than growing a second history inside the push suite.
 *
 * What each case pins, once, with no per-backend branch:
 *
 * - **A merge commit.** `fuz_forge_repo_log` reports both parents in git's
 *   `%P` order; `fuz_forge_repo_commit` reports the same pair; and the
 *   `next_cursor` walk follows the **first** parent only (`<cursor>^`), so the
 *   side branch never appears on a later page. The merge's diff is what `git
 *   show -p` actually emits for a conflict-free merge — the *empty* combined
 *   diff, `{text: '', truncated: false}` — which is a different shape from the
 *   cap-truncated `{text: '', truncated: true}` below and worth telling apart.
 * - **The byte caps.** A commit adding a >5 MB text file exceeds
 *   `MAX_DIFF_BYTES`, and a >5 MB blob exceeds `MAX_BLOB_BYTES`; both degrade
 *   to a structured outcome rather than an error, and the blob's `size` is the
 *   real byte count even though the bytes were never read.
 * - **The 404 family.** An absent path, a *directory* handed to
 *   `fuz_forge_repo_blob`, and an absent ref each answer a bare `-32003` with
 *   no `data` — and the message distinguishes `path` / `blob` / `ref` so a
 *   client can tell "file gone" from "that's a directory" from "branch gone".
 * - **The ref shapes.** An annotated tag's `committer_date` is the empty
 *   string (the date lives on the tag object, and neither backend fabricates a
 *   fallback), and a lightweight tag is `object_type: 'commit'` with an empty
 *   `target_sha`.
 * - **An uncompilable `--author` pattern.** git compiles the regex a client
 *   sends, so `[` exits 128; both backends classify that stderr as client
 *   input and answer `-32602` with a fixed message rather than the 503 an
 *   unclassified stderr produces.
 *
 * Every success body is parsed against its strict wire schema, so a dropped or
 * renamed field fails here too.
 *
 * Requires `git` + `python3` on the host (the hooks are python3); both are
 * present wherever the cross suites run.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { assert, test, describe, afterEach, afterAll, beforeAll } from 'vitest';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';

import { INVALID_PARAMS, NOT_FOUND } from './rpc_helpers.ts';
import {
	FuzForgeRepoOutput,
	FuzForgeRepoLogOutput,
	FuzForgeRepoCommitOutput,
	FuzForgeRepoRefsOutput,
	FuzForgeRepoBlobOutput
} from '#lib/action_specs.ts';
import { commit_files, create_work_repo, git, keeper_token, push_refs } from './git_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url } = handle.config;

/**
 * A blob comfortably past `MAX_BLOB_BYTES` / `MAX_DIFF_BYTES` (both 5 MB on
 * both backends, pinned as literals in `src/test/server/git/read.test.ts` and
 * `forge_git/read.rs`). 6 MB clears the cap without making the push slow — the
 * whole oversized-object case costs well under a second on each probe.
 */
const OVER_CAP_BYTES = 6 * 1024 * 1024;

/** A ~1 MiB binary blob: big enough to be real, small enough to stay under the cap. */
const BINARY_BYTES = 1024 * 1024 + 7;

describe('repo read shapes (cross-process, both backends)', () => {
	const cleanup_dirs: Array<string> = [];
	afterEach(async () => {
		for (const dir of cleanup_dirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('a merge commit reports both parents, an empty diff, and pages the first parent', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/readmerge';
		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug, default_branch: 'main' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `create failed: ${JSON.stringify(created)}`);
		const repo = parse_or_throw(FuzForgeRepoOutput, (created.result as { repo: unknown }).repo);

		// base → (side | main) → merge. `--no-ff` forces a real merge commit
		// even though the side branch could fast-forward.
		const work = await create_work_repo('readmerge');
		cleanup_dirs.push(work);
		const base = await commit_files(work, { 'README.md': '# base\n' }, 'base commit');
		await git(work, ['checkout', '-b', 'side']);
		const side = await commit_files(work, { 'side.txt': 'side\n' }, 'side commit');
		await git(work, ['checkout', 'main']);
		const mainline = await commit_files(work, { 'main.txt': 'main\n' }, 'main commit');
		await git(work, ['merge', '--no-ff', 'side', '-m', 'merge side into main']);
		const merge = (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();

		const token = keeper_token(fixture.create_bearer_headers());
		await push_refs(work, { base_url, username: fixture.account.username, token, slug }, [
			'HEAD:refs/heads/main'
		]);

		const log = async (params: Record<string, unknown>): Promise<FuzForgeRepoLogOutput> => {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_log',
				params: { id: repo.id, ...params },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(res.ok, `log failed: ${JSON.stringify(res)}`);
			return parse_or_throw(FuzForgeRepoLogOutput, res.result);
		};

		// git's own `%P` order is the contract, not "sorted" or "reversed": the
		// first parent is the branch that was merged *into*.
		const parents_from_git = (await git(work, ['log', '-1', '--format=%P', merge])).stdout
			.trim()
			.split(' ');
		assert.deepEqual(parents_from_git, [mainline, side], 'git orders mainline first');

		const all = await log({});
		const merge_summary = all.commits.find((c) => c.sha === merge);
		assert.ok(merge_summary, 'the merge commit should be in the log');
		assert.deepEqual(merge_summary.parents, parents_from_git, 'log parents match git');

		const commit = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_commit',
			params: { id: repo.id, sha: merge },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(commit.ok, `commit failed: ${JSON.stringify(commit)}`);
		const commit_out = parse_or_throw(FuzForgeRepoCommitOutput, commit.result);
		assert.deepEqual(commit_out.commit.parents, parents_from_git, 'commit parents match git');
		// `git show -p <merge>` emits the *combined* diff, which is empty for a
		// conflict-free merge (nothing changed relative to both parents). Both
		// backends therefore report the empty patch — and, unlike the cap case
		// below, report it as NOT truncated.
		const combined_diff = (
			await git(work, ['show', '-p', '--format=', '--no-color', '--full-index', merge, '--'])
		).stdout;
		assert.strictEqual(combined_diff, '', 'a clean merge has an empty combined diff');
		assert.strictEqual(commit_out.diff.text, '', 'the merge diff is the empty combined diff');
		assert.isFalse(commit_out.diff.truncated, 'an empty combined diff is not a truncation');

		// Paging past the merge follows `<cursor>^` — the FIRST parent — so the
		// side branch is unreachable from a cursor walk even though it is in the
		// unpaged log above.
		assert.ok(
			all.commits.some((c) => c.sha === side),
			'the side commit is reachable in the unpaged log'
		);
		const after_merge = await log({ cursor: merge });
		assert.deepEqual(
			after_merge.commits.map((c) => c.sha),
			[mainline, base],
			'the cursor walk follows the first parent'
		);
	});

	test('a diff and a blob past the byte caps degrade to the truncated shapes', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/readcaps';
		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug, default_branch: 'main' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `create failed: ${JSON.stringify(created)}`);
		const repo = parse_or_throw(FuzForgeRepoOutput, (created.result as { repo: unknown }).repo);

		const work = await create_work_repo('readcaps');
		cleanup_dirs.push(work);
		// Adding a >5 MB text file makes the commit's own patch >5 MB: every
		// line lands as a `+` line, so the diff is the file plus a header.
		const line = `${'x'.repeat(63)}\n`;
		const big_text = line.repeat(Math.ceil(OVER_CAP_BYTES / line.length));
		const big_diff_sha = await commit_files(work, { 'big.txt': big_text }, 'big text file');
		// Random bytes so the blob can't compress under the cap on the way in,
		// and so it also reads as binary if the cap were ever raised past it.
		await commit_files(work, { 'huge.bin': randomBytes(OVER_CAP_BYTES) }, 'huge binary file');

		const token = keeper_token(fixture.create_bearer_headers());
		await push_refs(work, { base_url, username: fixture.account.username, token, slug }, [
			'HEAD:refs/heads/main'
		]);

		const commit = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_commit',
			params: { id: repo.id, sha: big_diff_sha },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(commit.ok, `commit failed: ${JSON.stringify(commit)}`);
		const commit_out = parse_or_throw(FuzForgeRepoCommitOutput, commit.result);
		// The metadata survives the oversized diff — that split (two `git show`
		// calls with independent caps) is the whole reason the cap degrades
		// instead of failing the response.
		assert.strictEqual(commit_out.commit.sha, big_diff_sha);
		assert.strictEqual(commit_out.commit.subject, 'big text file');
		assert.isTrue(commit_out.diff.truncated, 'a >5 MB diff is truncated');
		assert.strictEqual(commit_out.diff.text, '', 'a truncated diff carries no partial text');

		const blob = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_blob',
			params: { id: repo.id, ref: 'main', path: 'huge.bin' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(blob.ok, `blob failed: ${JSON.stringify(blob)}`);
		const blob_out = parse_or_throw(FuzForgeRepoBlobOutput, blob.result);
		assert.strictEqual(blob_out.body.kind, 'truncated', 'a >5 MB blob is truncated');
		// The size comes from `cat-file -s`, not from the bytes — the point of
		// probing size before body is that the oversize blob is never read.
		assert.strictEqual(
			blob_out.body.kind === 'truncated' ? blob_out.body.size : -1,
			OVER_CAP_BYTES,
			'the truncated body carries the real size'
		);
		assert.strictEqual(blob_out.size, OVER_CAP_BYTES, 'the top-level size is the real size');
	});

	describe('a pushed repo with a binary blob, a directory, and two tag kinds', () => {
		let fixture: Awaited<ReturnType<typeof setup_test>>;
		let repo: FuzForgeRepoOutput;
		let merge_sha: string;
		// The shared work tree outlives every case here, so it gets its own
		// `afterAll` rather than the outer `afterEach` list — that list is
		// spliced after each test, which would delete the tree the *second*
		// case still needs (harmlessly today, since everything is pushed by
		// then, but it makes the fixture's lifetime a lie).
		let shared_work: string;

		afterAll(async () => {
			if (shared_work) await rm(shared_work, { recursive: true, force: true });
		});

		beforeAll(async () => {
			fixture = await setup_test();
			const slug = 'ttt/readshapes';
			const created = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_create',
				params: { slug, default_branch: 'main' },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(created.ok, `create failed: ${JSON.stringify(created)}`);
			repo = parse_or_throw(FuzForgeRepoOutput, (created.result as { repo: unknown }).repo);

			const work = await create_work_repo('readshapes');
			shared_work = work;
			await commit_files(work, { 'README.md': '# base\n' }, 'base commit');
			// The tags hang off this commit, so the annotated tag's target is a
			// sha the refs listing also advertises as `refs/heads/main`'s ancestor.
			merge_sha = await commit_files(work, { 'blob.bin': randomBytes(BINARY_BYTES) }, 'binary');
			await commit_files(work, { 'dir/inner.txt': 'inner\n' }, 'a directory');
			// `-a` makes a tag *object* (its own sha, its own tagger, peeling to
			// the commit); a bare `git tag` makes a ref pointing straight at the
			// commit. The two are the only tag shapes `for-each-ref` reports.
			await git(work, ['tag', '-a', 'v-annotated', '-m', 'annotated release', merge_sha]);
			await git(work, ['tag', 'v-lightweight', merge_sha]);

			const token = keeper_token(fixture.create_bearer_headers());
			await push_refs(work, { base_url, username: fixture.account.username, token, slug }, [
				'HEAD:refs/heads/main',
				'refs/tags/v-annotated',
				'refs/tags/v-lightweight'
			]);
		});

		/** Call a read RPC against the suite's repo. */
		const read = async (
			method: string,
			params: Record<string, unknown>
		): Promise<Awaited<ReturnType<typeof rpc_call>>> =>
			rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method,
				params: { id: repo.id, ...params },
				headers: fixture.create_session_headers()
			});

		/**
		 * Assert a read answered the bare `-32003` both backends use for every
		 * read-layer miss: the given message, and **no** `data` — the locked-down
		 * posture keeps the reason out of the envelope.
		 */
		const assert_not_found = (
			res: Awaited<ReturnType<typeof rpc_call>>,
			message: string,
			label: string
		): void => {
			assert.isFalse(res.ok, `${label}: expected an error, got ${JSON.stringify(res)}`);
			const error = (res as { error: { code: number; message: string; data?: unknown } }).error;
			assert.strictEqual(error.code, NOT_FOUND, `${label}: code`);
			assert.strictEqual(error.message, message, `${label}: message`);
			assert.strictEqual(error.data, undefined, `${label}: no data (no reason leak)`);
		};

		test('a binary blob is {kind: binary} with the real size', async () => {
			const res = await read('fuz_forge_repo_blob', { ref: 'main', path: 'blob.bin' });
			assert.isTrue(res.ok, `blob failed: ${JSON.stringify(res)}`);
			const blob = parse_or_throw(FuzForgeRepoBlobOutput, res.result);
			// The NUL sniff runs over the first 8 KB on both backends, so a
			// megabyte of random bytes is binary with overwhelming probability
			// — and the body carries no bytes, only the kind.
			assert.deepEqual(blob.body, { kind: 'binary' }, 'a binary blob carries no text');
			assert.strictEqual(blob.size, BINARY_BYTES, 'the size is the real byte count');
		});

		test('an absent path, a directory, and an absent ref are each a bare -32003', async () => {
			// Control first: the same ref and a real path succeed, so the misses
			// below are the path/ref and not the repo or the credential.
			const control = await read('fuz_forge_repo_tree', { ref: 'main', path: 'dir' });
			assert.isTrue(control.ok, `tree control failed: ${JSON.stringify(control)}`);

			assert_not_found(
				await read('fuz_forge_repo_tree', { ref: 'main', path: 'no/such/path' }),
				'path not found',
				'tree at an absent path'
			);
			assert_not_found(
				await read('fuz_forge_repo_blob', { ref: 'main', path: 'no/such/path' }),
				'path not found',
				'blob at an absent path'
			);
			// A directory resolves to a *tree* object, so this is not a path miss:
			// both backends assert the object's type with `cat-file -t` and answer
			// the distinct `blob not found` rather than letting the body fetch fail.
			assert_not_found(
				await read('fuz_forge_repo_blob', { ref: 'main', path: 'dir' }),
				'blob not found',
				'blob at a directory'
			);
			// An absent ref is a third message again — the readers re-resolve the
			// bare ref to tell "branch gone" from "file gone".
			assert_not_found(
				await read('fuz_forge_repo_tree', { ref: 'no-such-branch', path: '' }),
				'ref not found',
				'tree on an absent ref'
			);
			assert_not_found(
				await read('fuz_forge_repo_blob', { ref: 'no-such-branch', path: 'README.md' }),
				'ref not found',
				'blob on an absent ref'
			);
		});

		test('an annotated tag has an empty committer_date; a lightweight tag is a commit', async () => {
			const res = await read('fuz_forge_repo_refs', {});
			assert.isTrue(res.ok, `refs failed: ${JSON.stringify(res)}`);
			const refs = parse_or_throw(FuzForgeRepoRefsOutput, res.result);

			const annotated = refs.refs.find((r) => r.name === 'refs/tags/v-annotated');
			assert.ok(annotated, 'refs should include the annotated tag');
			assert.strictEqual(annotated.object_type, 'tag', '`git tag -a` creates a tag object');
			assert.notStrictEqual(annotated.sha, merge_sha, 'the tag object has its own sha');
			assert.strictEqual(annotated.target_sha, merge_sha, 'the annotated tag peels to the commit');
			// `%(committerdate)` is empty for a tag object — the date lives on the
			// tag, not on a commit — and neither backend substitutes the target's
			// date or the taggerdate. Left to the UI to decide.
			assert.strictEqual(
				annotated.committer_date,
				'',
				"an annotated tag's committer_date is the empty string"
			);

			const lightweight = refs.refs.find((r) => r.name === 'refs/tags/v-lightweight');
			assert.ok(lightweight, 'refs should include the lightweight tag');
			assert.strictEqual(lightweight.object_type, 'commit', 'a lightweight tag IS the commit');
			assert.strictEqual(lightweight.sha, merge_sha, 'it points straight at the commit');
			assert.strictEqual(lightweight.target_sha, '', 'there is nothing to peel');
			assert.notStrictEqual(
				lightweight.committer_date,
				'',
				"a lightweight tag carries the commit's own date"
			);
		});

		test('an author pattern git cannot compile is -32602 on both backends', async () => {
			// Control: a well-formed pattern that matches nothing is an ordinary
			// empty page, so the refusal below is the *compile* failure and not
			// "the filter found nothing".
			const control = await read('fuz_forge_repo_log', { author: 'nobody@example.invalid' });
			assert.isTrue(control.ok, `author control failed: ${JSON.stringify(control)}`);
			assert.deepEqual(parse_or_throw(FuzForgeRepoLogOutput, control.result).commits, []);

			// `--author` is a regex handed to git unmodified, so `[` exits 128
			// with `fatal: header, '[': <regcomp message>`. Both backends
			// classify that as client input rather than a transient read failure.
			// The message is git's *only* by classification, never by
			// pass-through: the fixed `INVALID_AUTHOR_PATTERN_MESSAGE` is what
			// crosses the wire, because git's own text echoes the pattern back
			// and its tail is the platform `regcomp`'s wording — and the two
			// deploy targets are glibc and musl.
			//
			// The second pattern is the adversarial one: git echoes the client's
			// pattern into the very stderr the classifiers read, so `bad revision
			// [` yields `fatal: header, 'bad revision [': …`, which the substring
			// `is_no_such_ref_stderr` *also* matches. Both backends ask the
			// (anchored) pattern predicate first, so it answers `-32602` rather
			// than the empty page a forged ref miss would produce — this case is
			// the cross-process pin on that ordering.
			for (const author of ['[', 'bad revision [']) {
				const res = await read('fuz_forge_repo_log', { author });
				assert.isFalse(res.ok, `${author}: expected a refusal, got ${JSON.stringify(res)}`);
				const error = (res as { error: { code: number; message: string } }).error;
				assert.strictEqual(
					error.code,
					INVALID_PARAMS,
					`${author}: an uncompilable author pattern is invalid params, never a 503 or a 200`
				);
				assert.strictEqual(
					error.message,
					'invalid author pattern',
					`${author}: the fixed message, on both`
				);
			}
		});
	});
});
