/**
 * Cross-process **end-to-end git push** suite — run against BOTH fuz_forge
 * backends (Deno/Hono + Rust `fuz_forge_server`) via the `cross_backend_*`
 * mechanism. This is the only test that drives the *whole* repo-hosting write
 * path over real wires:
 *
 *   create repo (RPC) → `git push` over smart-HTTP (Basic auth = api_token)
 *   → `git-receive-pack` → `post-receive` hook → `POST /internal/repo-receive-callback`
 *   → repo-cell `head_sha` update → read back (RPC)
 *
 * It also validates each read RPC's response against its strict wire schema
 * (`FuzForgeRepoOutput` / `…LogOutput` / `…CommitOutput` / `…RefsOutput` /
 * `…TreeOutput` / `…ResyncOutput`), so a backend that drops `seed_from` /
 * `short_sha` / `parents` / committer / `resolved_sha` fields fails here — the
 * round-trip suite can't catch that (it only sees error envelopes for these
 * methods, never a populated success body).
 *
 * Beyond the create→push→read core it also covers (all on the same pushed
 * repo, all green on both backends): the browse `tree` + `blob` success
 * bodies (blob text round-trips the seeded README), the `fuz_forge_repo_commit`
 * invalid-sha error shape (bare `-32003`, no `data`), the idempotent
 * `fuz_forge_repo_resync` no-op + the session-only
 * `fuz_forge_repo_rotate_secret`, and the pre-receive force-push protection
 * (default-branch non-fast-forward rejected; non-default branch accepted).
 *
 * It also pins the read layer's 404-vs-503 split on the shapes where the two
 * backends' stderr classifiers decide it: a tree listing at a *file* path, a
 * blob sha passed to `fuz_forge_repo_commit`, and an *annotated tag's* sha
 * passed to the same (the sha `fuz_forge_repo_refs` itself advertises for
 * `refs/tags/*`) are all a bare `-32003`, and an absent default branch (empty
 * repo, or history pushed only to a feature branch) is
 * `fuz_forge_repo_resync`'s documented `head_sha: null` rather than a 503.
 * A sibling suite (`repo_log_list_filters.cross.test.ts`) covers the
 * `fuz_forge_repo_log` author/since/path filters and the `fuz_forge_repo_list`
 * slug_prefix/since filters.
 *
 * Requires `git` + `python3` on the host (the hooks are python3); both are
 * present wherever the cross suites run (the Deno backend already needs
 * `--allow-run` for `git`).
 *
 * @module
 */

import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assert, test, describe, afterEach } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';
import { assert_iso8601_seconds } from '@fuzdev/fuz_app/testing/cross_backend/wire_shapes.ts';

import { NOT_FOUND, METHOD_NOT_FOUND } from './rpc_helpers.ts';
import {
	FuzForgeRepoOutput,
	FuzForgeRepoLogOutput,
	FuzForgeRepoCommitOutput,
	FuzForgeRepoRefsOutput,
	FuzForgeRepoTreeOutput,
	FuzForgeRepoBlobOutput,
	FuzForgeRepoResyncOutput,
	FuzForgeRepoRotateSecretOutput
} from '#lib/action_specs.ts';
import {
	commit_files,
	create_work_repo,
	git,
	keeper_token,
	push_refs,
	push_url
} from './git_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url } = handle.config;

/** Seeded README content; asserted back through the blob body. */
const README_CONTENT = '# pushed by the forge cross test\n';

describe('repo push (cross-process, both backends)', () => {
	const cleanup_dirs: Array<string> = [];
	afterEach(async () => {
		for (const dir of cleanup_dirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('create → push over smart-HTTP → post-receive updates head_sha; read RPCs match schema', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/pushed';

		// 1) Create the repo via RPC (session-authed keeper).
		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug, default_branch: 'main' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `create failed: ${JSON.stringify(created)}`);
		// Strict-schema validation catches a dropped `seed_from`/`seed_completed_at`.
		const created_repo = FuzForgeRepoOutput.parse((created.result as { repo: unknown }).repo);
		// The timestamp *shape*, which no schema check can see: both backends
		// serialize second-precision UTC. Rust gets it from the spine
		// (`iso8601_timestamp_column` / `rfc3339_now`), TS from the cell
		// layer's matching projection.
		assert_iso8601_seconds(created_repo.created_at, 'create → created_at');
		assert_iso8601_seconds(created_repo.updated_at, 'create → updated_at');

		// 2) Build a local repo with one commit.
		const work = await create_work_repo('push');
		cleanup_dirs.push(work);
		const head = await commit_files(work, { 'README.md': README_CONTENT }, 'initial commit');

		// 3) Push over smart-HTTP with Basic auth (username + api_token).
		const token = keeper_token(fixture.create_bearer_headers());
		const target = { base_url, username: fixture.account.username, token, slug };
		await push_refs(work, target, ['HEAD:refs/heads/main']);

		// 4) The post-receive callback ran synchronously during the push, so the
		// cell's head_sha is already updated. Read it back via RPC.
		const got = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_get',
			params: { slug },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(got.ok, `get failed: ${JSON.stringify(got)}`);
		const repo = FuzForgeRepoOutput.parse((got.result as { repo: unknown }).repo);
		assert.strictEqual(repo.head_sha, head, 'head_sha should match the pushed commit');
		assert.ok(repo.last_pushed_at, 'last_pushed_at should be set by the callback');
		// The same shape on the read path and on the value the post-receive
		// callback wrote.
		assert_iso8601_seconds(repo.created_at, 'get → created_at');
		assert_iso8601_seconds(repo.updated_at, 'get → updated_at');
		assert_iso8601_seconds(repo.last_pushed_at, 'get → last_pushed_at');

		// 5) repo_log — strict schema (sha/short_sha/subject/author*/parents) +
		// the pushed commit is the tip.
		const log = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_log',
			params: { id: repo.id },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(log.ok, `log failed: ${JSON.stringify(log)}`);
		const log_out = FuzForgeRepoLogOutput.parse(log.result);
		assert.strictEqual(log_out.commits.length, 1);
		assert.strictEqual(log_out.commits[0]!.sha, head);
		assert.strictEqual(log_out.commits[0]!.subject, 'initial commit');
		assert.deepEqual(log_out.commits[0]!.parents, [], 'root commit has no parents');

		// 6) repo_commit — strict schema incl. committer fields + body + parents.
		const commit = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_commit',
			params: { id: repo.id, sha: head },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(commit.ok, `commit failed: ${JSON.stringify(commit)}`);
		const commit_out = FuzForgeRepoCommitOutput.parse(commit.result);
		assert.strictEqual(commit_out.commit.sha, head);
		assert.strictEqual(commit_out.commit.committer_email, 'test@fuz.dev');

		// 7) repo_refs — the pushed branch is advertised.
		const refs = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_refs',
			params: { id: repo.id },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(refs.ok, `refs failed: ${JSON.stringify(refs)}`);
		const refs_out = FuzForgeRepoRefsOutput.parse(refs.result);
		assert.ok(
			refs_out.refs.some((r) => r.name === 'refs/heads/main'),
			'refs should include refs/heads/main'
		);

		// 8) repo_tree at the root — README is listed as a blob with a resolved sha.
		const tree = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_tree',
			params: { id: repo.id, ref: 'main', path: '' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(tree.ok, `tree failed: ${JSON.stringify(tree)}`);
		const tree_out = FuzForgeRepoTreeOutput.parse(tree.result);
		assert.ok(tree_out.resolved_sha, 'tree resolved_sha should be set');
		const readme_entry = tree_out.entries.find((e) => e.name === 'README.md');
		assert.ok(readme_entry, 'tree should include README.md');
		assert.strictEqual(readme_entry.type, 'blob', 'README.md should be a blob');
		assert.ok(readme_entry.sha, 'README.md tree entry should carry a sha');

		// 8b) repo_tree at a *file* path → 404 `path`, not a 503. `git ls-tree
		// -l <sha>:README.md` exits 128 with `fatal: not a tree object`; both
		// backends' `is_no_such_path_stderr` classifies that wording, so a
		// client asking for a tree listing where a blob lives gets the same
		// `-32003` it gets for a path that doesn't exist at all.
		const tree_at_file = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_tree',
			params: { id: repo.id, ref: 'main', path: 'README.md' },
			headers: fixture.create_session_headers()
		});
		assert.isFalse(
			tree_at_file.ok,
			`expected tree-at-file error, got: ${JSON.stringify(tree_at_file)}`
		);
		assert.strictEqual(
			(tree_at_file as { error: { code: number } }).error.code,
			NOT_FOUND,
			'a tree listing at a file path should map to not_found (-32003), never a 503'
		);
		assert.strictEqual(
			(tree_at_file as { error: { data?: unknown } }).error.data,
			undefined,
			'tree-at-file error must carry no data (no reason leak)'
		);

		// 9) repo_blob — the seeded README is a text blob whose body round-trips
		// the exact content. `<ref>:<path>` names the blob directly; the prior
		// `^{blob}` peel suffix made git read it as the path `README.md^{blob}`
		// (404). Strict-schema parse catches a dropped `sha`/`size`/`body` field.
		const blob = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_blob',
			params: { id: repo.id, ref: 'main', path: 'README.md' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(blob.ok, `blob failed: ${JSON.stringify(blob)}`);
		const blob_out = FuzForgeRepoBlobOutput.parse(blob.result);
		assert.strictEqual(blob_out.body.kind, 'text', 'README.md should be a text blob');
		assert.strictEqual(
			blob_out.body.kind === 'text' ? blob_out.body.text : null,
			README_CONTENT,
			'blob text should match the seeded README content'
		);
		assert.strictEqual(
			blob_out.size,
			README_CONTENT.length,
			'blob size should match the README byte length'
		);

		// 9b) repo_commit with a malformed sha → bare `not_found('commit')`:
		// JSON-RPC `-32003` with `error.data === undefined` (the data-leak-minimal
		// shape; no `{reason: 'invalid sha'}` leak).
		const bad_commit = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_commit',
			params: { id: repo.id, sha: 'not-a-sha' },
			headers: fixture.create_session_headers()
		});
		assert.isFalse(bad_commit.ok, `expected commit error, got: ${JSON.stringify(bad_commit)}`);
		assert.strictEqual(
			(bad_commit as { error: { code: number } }).error.code,
			NOT_FOUND,
			'invalid sha should map to not_found (-32003)'
		);
		assert.strictEqual(
			(bad_commit as { error: { data?: unknown } }).error.data,
			undefined,
			'invalid-sha error must carry no data (no reason leak)'
		);

		// 9c) repo_commit with a *well-formed* sha that names a blob rather than
		// a commit → the same bare `-32003`. `git show --no-patch --format=…
		// <blob-sha> --` exits **0** and prints the blob's bytes, so the commit
		// parse fails on output git considered a success — and the sha came
		// straight out of `repo_blob` above, so a client can trivially produce
		// it. Both backends answer 404 `commit`; a 500 here would read as a
		// server bug for what is a client miss. (An annotated *tag* sha is the
		// harder sibling — git exits 0 with output that still parses — see 9d.)
		const blob_as_commit = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_commit',
			params: { id: repo.id, sha: blob_out.sha },
			headers: fixture.create_session_headers()
		});
		assert.isFalse(
			blob_as_commit.ok,
			`expected blob-as-commit error, got: ${JSON.stringify(blob_as_commit)}`
		);
		assert.strictEqual(
			(blob_as_commit as { error: { code: number } }).error.code,
			NOT_FOUND,
			'a blob sha passed to repo_commit should map to not_found (-32003), never a 500'
		);
		assert.strictEqual(
			(blob_as_commit as { error: { data?: unknown } }).error.data,
			undefined,
			'blob-as-commit error must carry no data (no reason leak)'
		);

		// 9d) repo_commit with an *annotated tag's* sha → the same bare `-32003`.
		// This is the case a "does it parse?" guard alone misses: `git show
		// --no-patch --format=… <tag-sha> --` exits **0** and prints git's tag
		// preamble (`tag v1` / `Tagger: …` / the tag message) followed by the
		// *peeled* commit's full 11-field record, so `parse_commit_detail`
		// succeeds on both backends with `%H` carrying the preamble. And the sha
		// is handed to clients by `repo_refs` below — every annotated tag on
		// every hosted repo — so without the readers' `%H === <requested sha>`
		// check a client browsing tags gets a 200 whose `commit.sha` is a
		// multi-line string with a tagger block in it.
		await git(work, ['tag', '-a', 'v1', '-m', 'tagged release']);
		await push_refs(work, target, ['refs/tags/v1']);
		const tag_refs = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_refs',
			params: { id: repo.id },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(tag_refs.ok, `refs after tag push failed: ${JSON.stringify(tag_refs)}`);
		const tag_refs_out = FuzForgeRepoRefsOutput.parse(tag_refs.result);
		const tag_ref = tag_refs_out.refs.find((r) => r.name === 'refs/tags/v1');
		assert.ok(tag_ref, 'refs should include the pushed refs/tags/v1');
		assert.strictEqual(
			tag_ref.object_type,
			'tag',
			'`git tag -a` creates a tag object, so for-each-ref reports objecttype=tag'
		);
		assert.strictEqual(tag_ref.target_sha, head, 'the annotated tag peels to the pushed commit');
		assert.notStrictEqual(tag_ref.sha, head, 'the tag object has its own sha');
		const tag_as_commit = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_commit',
			params: { id: repo.id, sha: tag_ref.sha },
			headers: fixture.create_session_headers()
		});
		assert.isFalse(
			tag_as_commit.ok,
			`expected tag-as-commit error, got: ${JSON.stringify(tag_as_commit)}`
		);
		assert.strictEqual(
			(tag_as_commit as { error: { code: number } }).error.code,
			NOT_FOUND,
			'an annotated tag sha passed to repo_commit should map to not_found (-32003), never a 200'
		);
		assert.strictEqual(
			(tag_as_commit as { error: { data?: unknown } }).error.data,
			undefined,
			'tag-as-commit error must carry no data (no reason leak)'
		);

		// 10) repo_resync — idempotent no-op: the cell already matches disk (the
		// post-receive callback already wrote `head`), so previous === current.
		const resync = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_resync',
			params: { id: repo.id },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(resync.ok, `resync failed: ${JSON.stringify(resync)}`);
		const resync_out = FuzForgeRepoResyncOutput.parse(resync.result);
		assert.strictEqual(resync_out.head_sha, head, 'resync should read the on-disk tip');
		assert.strictEqual(
			resync_out.head_sha,
			resync_out.previous_head_sha,
			'resync should be a no-op when the cell already matches disk'
		);

		// 11) repo_rotate_secret — session-only mutation (a bearer/scoped token
		// can't rotate the hook-callback credential). Returns `{ok: true}`; the
		// new secret never crosses the wire.
		const rotate = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_rotate_secret',
			params: { id: repo.id },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(rotate.ok, `rotate_secret failed: ${JSON.stringify(rotate)}`);
		const rotate_out = FuzForgeRepoRotateSecretOutput.parse(rotate.result);
		assert.strictEqual(rotate_out.ok, true);

		// 12) repo_recent_commits — the legacy method was folded into repo_log
		// and removed from both backends, so a client calling it gets JSON-RPC
		// `method_not_found` (-32601) on both, not a stale handler dispatch.
		const recent = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_recent_commits',
			params: { id: repo.id },
			headers: fixture.create_session_headers()
		});
		assert.isFalse(recent.ok, `expected method_not_found, got: ${JSON.stringify(recent)}`);
		assert.strictEqual(
			(recent as { error: { code: number } }).error.code,
			METHOD_NOT_FOUND,
			'fuz_forge_repo_recent_commits should be method_not_found on both backends'
		);
	});

	// `read_default_branch_tip` spawns `git rev-parse --verify
	// refs/heads/<default_branch>` — the one forge argv shape with neither a
	// `--verify`-less form nor a `--` separator, so git answers an absent ref
	// with `fatal: Needed a single revision` rather than the log reader's `bad
	// revision`. Both backends' `is_no_such_ref_stderr` had missed that wording,
	// so the two shapes below — the ones both docs promise as `head_sha: null` —
	// answered 503 on each instead.
	//
	// These two are the *reachable* absent-default-branch shapes. A third,
	// deleting the default branch over the push path, is refused twice over:
	// git's own `receive.denyDeleteCurrent` guards the branch HEAD points at,
	// and the forge's pre-receive hook rejects the deletion as a
	// non-fast-forward besides.
	test('resync answers head_sha null for an empty repo and an absent default branch', async () => {
		const fixture = await setup_test();

		const resync = async (id: string): Promise<FuzForgeRepoResyncOutput> => {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_resync',
				params: { id },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(res.ok, `resync failed: ${JSON.stringify(res)}`);
			return FuzForgeRepoResyncOutput.parse(res.result);
		};

		const create = async (slug: string): Promise<string> => {
			const created = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_create',
				params: { slug, default_branch: 'main' },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(created.ok, `create ${slug} failed: ${JSON.stringify(created)}`);
			return FuzForgeRepoOutput.parse((created.result as { repo: unknown }).repo).id;
		};

		// 1) A never-pushed repo: the bare repo exists but has no refs at all.
		const empty_id = await create('ttt/emptytip');
		const empty_resync = await resync(empty_id);
		assert.strictEqual(empty_resync.head_sha, null, 'an empty repo has no default-branch tip');
		assert.strictEqual(empty_resync.previous_head_sha, null);

		// 2) A repo with real history whose *configured* default branch was
		// never pushed — the objects are all there, only `refs/heads/main` is
		// missing, so this can't be mistaken for the empty-repo path above.
		const absent_id = await create('ttt/absenttip');
		const work = await create_work_repo('absenttip');
		cleanup_dirs.push(work);
		await commit_files(work, { 'README.md': README_CONTENT }, 'on a feature branch only');
		const token = keeper_token(fixture.create_bearer_headers());
		await push_refs(
			work,
			{ base_url, username: fixture.account.username, token, slug: 'ttt/absenttip' },
			['HEAD:refs/heads/feature']
		);

		// The feature-branch push landed (the refs listing proves the repo isn't
		// empty), but it never touched `refs/heads/main`.
		const refs = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_refs',
			params: { id: absent_id },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(refs.ok, `refs failed: ${JSON.stringify(refs)}`);
		const refs_out = FuzForgeRepoRefsOutput.parse(refs.result);
		assert.deepEqual(
			refs_out.refs.map((r) => r.name),
			['refs/heads/feature'],
			'only the feature branch should exist'
		);

		const absent_resync = await resync(absent_id);
		assert.strictEqual(
			absent_resync.head_sha,
			null,
			'an absent default branch on a non-empty repo is the null tip'
		);
		assert.strictEqual(absent_resync.previous_head_sha, null);
	});

	// A push whose pack exceeds 1 MiB must succeed on both backends. This is the
	// tripwire for the Rust git-push body-cap divergence: the forge git
	// smart-HTTP routes had been mounted under the generic 1 MiB
	// `body_limit_layer` (and buffered the pack as `axum::body::Bytes`), so a
	// pack > 1 MiB got a plain-text 413 on Rust while the TS twin streamed it
	// (bounded only by the global ~800 MiB). The Rust git routes are now OFF the
	// 1 MiB cap and stream the request body straight into `git http-backend`'s
	// stdin, matching the TS path. A ~2 MiB incompressible blob (random bytes)
	// guarantees the pack clears 1 MiB even after git's zlib pass.
	test('push of a >1 MiB pack succeeds and updates head_sha', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/bigpush';

		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug, default_branch: 'main' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `create failed: ${JSON.stringify(created)}`);
		const repo = FuzForgeRepoOutput.parse((created.result as { repo: unknown }).repo);

		const work = await create_work_repo('bigpush');
		cleanup_dirs.push(work);
		// ~2 MiB of incompressible random bytes → the pack stays well over the
		// old 1 MiB cap even after deflate.
		const head = await commit_files(
			work,
			{ 'blob.bin': randomBytes(2 * 1024 * 1024) },
			'big binary blob'
		);

		// The push itself is the assertion: a 413 (or any non-zero git exit)
		// throws. Resolving = the >1 MiB pack was accepted end-to-end.
		const token = keeper_token(fixture.create_bearer_headers());
		await push_refs(work, { base_url, username: fixture.account.username, token, slug }, [
			'HEAD:refs/heads/main'
		]);

		// The post-receive callback ran synchronously; the cell's head_sha now
		// matches the pushed commit.
		const got = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_get',
			params: { id: repo.id },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(got.ok, `get failed: ${JSON.stringify(got)}`);
		const updated = FuzForgeRepoOutput.parse((got.result as { repo: unknown }).repo);
		assert.strictEqual(updated.head_sha, head, 'head_sha should match the pushed >1 MiB commit');
	});

	// The pre-receive hook protects the configured `default_branch`: a
	// non-fast-forward (force) push to it is rejected, while a force push to a
	// non-default branch is accepted. Both backends render the identical python3
	// hook (`repo_storage.rs` / `storage.ts`), so the rejection message + the
	// branch-name gate must match.
	test('pre-receive rejects force-push to default branch, accepts it on a feature branch', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/forcepush';

		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug, default_branch: 'main' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `create failed: ${JSON.stringify(created)}`);

		const work = await create_work_repo('forcepush');
		cleanup_dirs.push(work);
		await commit_files(work, { 'README.md': '# base\n' }, 'base commit');

		const token = keeper_token(fixture.create_bearer_headers());
		const url = push_url(base_url, fixture.account.username, token, slug);

		// Establish history on the default branch with an ordinary push.
		await git(work, ['push', url, 'HEAD:refs/heads/main']);

		// Rewrite history to a divergent commit (amend → new SHA, same parent
		// chain root, no longer a fast-forward over the pushed tip).
		await writeFile(join(work, 'README.md'), '# rewritten\n');
		await git(work, ['add', '.']);
		await git(work, ['commit', '--amend', '-m', 'rewritten base commit']);

		// Force-push the divergent history to the default branch → the
		// pre-receive hook rejects it as non-fast-forward.
		await assert_rejects(
			() => git(work, ['push', '--force', url, 'HEAD:refs/heads/main']),
			/non-fast-forward|denied|rejected/i
		);

		// The same divergent history force-pushed to a NON-default branch is
		// accepted — the hook only guards the configured default branch. A
		// rejected push would throw (non-zero exit); resolving = accepted.
		await git(work, ['push', '--force', url, 'HEAD:refs/heads/feature']);

		// Confirm via RPC that the feature ref landed.
		const repo = FuzForgeRepoOutput.parse((created.result as { repo: unknown }).repo);
		const refs = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_refs',
			params: { id: repo.id },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(refs.ok, `refs failed: ${JSON.stringify(refs)}`);
		const refs_out = FuzForgeRepoRefsOutput.parse(refs.result);
		assert.ok(
			refs_out.refs.some((r) => r.name === 'refs/heads/feature'),
			'refs should include the force-pushed refs/heads/feature'
		);
	});

	// `info/refs` validates the `?service=` param AFTER auth on BOTH backends
	// (the Rust twin used to validate it pre-auth). So an unauthenticated
	// request with a bogus / missing service gets the generic 401 — no pre-auth
	// 400 signalling request shape — while a *valid* credential surfaces the 400.
	test('info/refs validates service after auth (unauth bogus → 401, authed bogus → 400)', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/advertise_order';
		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug, default_branch: 'main' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `create failed: ${JSON.stringify(created)}`);

		const refs_url = (service?: string): string =>
			`${base_url}/${slug}.git/info/refs${service === undefined ? '' : `?service=${service}`}`;

		// No credential + bogus service → 401 (auth gate fires before the
		// service check). The pre-auth-service Rust twin returned 400 here.
		const unauth_bogus = await fetch(refs_url('bogus-service'));
		assert.strictEqual(unauth_bogus.status, 401, 'unauth + bogus service must be 401, not 400');

		// No credential + missing service → also 401 (not 400 "missing service").
		const unauth_missing = await fetch(refs_url(undefined));
		assert.strictEqual(unauth_missing.status, 401, 'unauth + missing service must be 401');

		// Valid Basic auth + bogus service → 400: the service IS validated, but
		// only after auth succeeds (proving the check moved post-auth, not away).
		const token = keeper_token(fixture.create_bearer_headers());
		const basic = `Basic ${Buffer.from(`${fixture.account.username}:${token}`).toString('base64')}`;
		const authed_bogus = await fetch(refs_url('bogus-service'), {
			headers: { Authorization: basic }
		});
		assert.strictEqual(authed_bogus.status, 400, 'authed + bogus service → 400 (post-auth)');
	});

	test('cell keys outside the repo-cell shape survive a push and a rotate_secret', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/cell_extra_keys';
		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug, default_branch: 'main' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `create failed: ${JSON.stringify(created)}`);
		const repo_id = (created.result as { repo: { id: string } }).repo.id;

		// The forge mounts the spine cell bundle, so the repo cell's `data` is
		// readable/writable through the generic `cell_get` / `cell_update` — the
		// one way this process can put a key on the cell that no repo schema
		// names. Those are the spine's admin-gated RAW cell surfaces and this
		// caller is the bootstrap keeper, so the `hook_secret_hash` they return is a
		// fixture affordance, not a leak: the forge's own repo read DTO
		// (`fuz_forge_repo_get` / `_list`) deliberately withholds it.
		const read_cell_data = async (): Promise<Record<string, unknown>> => {
			const got = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'cell_get',
				params: { id: repo_id },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(got.ok, `cell_get failed: ${JSON.stringify(got)}`);
			return (got.result as { cell: { data: Record<string, unknown> } }).cell.data;
		};

		const before = await read_cell_data();
		const updated = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'cell_update',
			params: { cell_id: repo_id, data: { ...before, x_extra: 1 } },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(updated.ok, `cell_update failed: ${JSON.stringify(updated)}`);

		// Push: the post-receive callback rewrites the cell's `data`. Writing
		// back over the NARROW would drop `x_extra` (and materialize `null`s for
		// every absent optional field); both backends write over the raw object.
		const work = await create_work_repo('extra');
		cleanup_dirs.push(work);
		await commit_files(work, { 'README.md': README_CONTENT }, 'initial commit');
		const token = keeper_token(fixture.create_bearer_headers());
		await push_refs(work, { base_url, username: fixture.account.username, token, slug }, [
			'HEAD:refs/heads/main'
		]);

		const after_push = await read_cell_data();
		assert.strictEqual(after_push.x_extra, 1, 'push must preserve unknown cell keys');
		assert.isString(after_push.head_sha, 'push still writes head_sha');

		// The mutation RPCs write back the same way.
		const rotated = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_rotate_secret',
			params: { id: repo_id },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(rotated.ok, `rotate_secret failed: ${JSON.stringify(rotated)}`);
		const after_rotate = await read_cell_data();
		assert.strictEqual(after_rotate.x_extra, 1, 'rotate_secret must preserve unknown cell keys');
		assert.notStrictEqual(
			after_rotate.hook_secret_hash,
			after_push.hook_secret_hash,
			'rotate_secret replaces the stored secret digest'
		);

		// The rewritten hooks still authenticate: the cell keeps only a digest of
		// the new secret and the scripts carry its plaintext, so a push after the
		// rotate proves the two agree. A mismatch fails the pre-receive callback
		// (push refused) or the post-receive one (`head_sha` left stale).
		const second_head = await commit_files(
			work,
			{ 'NOTES.md': 'after the rotate\n' },
			'commit after rotate'
		);
		await push_refs(work, { base_url, username: fixture.account.username, token, slug }, [
			'HEAD:refs/heads/main'
		]);
		const after_second_push = await read_cell_data();
		assert.strictEqual(
			after_second_push.head_sha,
			second_head,
			'a push after rotate_secret records the new tip'
		);
		assert.strictEqual(after_second_push.x_extra, 1);
	});
});
