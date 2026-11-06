/**
 * Cross-process coverage for the `fuz_forge_repo_log` and `fuz_forge_repo_list`
 * server-side filters — run against BOTH fuz_forge backends (Deno/Hono + Rust
 * `fuz_forge_server`).
 *
 * The generic round-trip suite only ever sees error envelopes for these
 * methods (it generates nil-id inputs), so the populated-filter behavior is
 * unverified there. This suite seeds real history + multiple repos over the
 * smart-HTTP push path, then asserts each filter returns the identical subset
 * on both backends:
 *
 *   - `repo_log` `author` — `--author=<pattern>` regex on the commit author.
 *   - `repo_log` `since`  — `--since=<approxidate>` window.
 *   - `repo_log` `path`   — path pathspec after the `--` separator.
 *   - `repo_list` `slug_prefix` — case-sensitive exact prefix on `data.slug`.
 *   - `repo_list` `since`       — `last_pushed_at >= since`, excluding
 *     never-pushed repos (null `last_pushed_at`).
 *
 * Plus the `repo_log` degenerate-selector shape: an argv-unsafe `ref`, a
 * non-SHA `cursor` (an uppercase variant of a real sha included — `is_full_sha`
 * is lowercase-only, though git would resolve it), and a well-formed-but-absent
 * ref are all the *empty page* on both backends, never an error envelope.
 *
 * Requires `git` + `python3` on the host (the hooks are python3); both are
 * present wherever the cross suites run.
 *
 * @module
 */

import { rm } from 'node:fs/promises';

import { assert, test, describe, afterEach } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';

import { INVALID_PARAMS } from './rpc_helpers.ts';
import { FuzForgeRepoOutput, FuzForgeRepoLogOutput } from '#lib/action_specs.ts';
import {
	commit_file,
	commit_files,
	create_work_repo,
	git,
	keeper_token,
	push_refs
} from './git_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url } = handle.config;

/** Two distinct commit authors so the `--author` filter has something to bite. */
const AUTHOR_A = { name: 'Alice Aardvark', email: 'alice@fuz.dev' };
const AUTHOR_B = { name: 'Bob Buffalo', email: 'bob@fuz.dev' };

describe('repo log + list filters (cross-process, both backends)', () => {
	const cleanup_dirs: Array<string> = [];
	afterEach(async () => {
		for (const dir of cleanup_dirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('repo_log filters by author, since, and path identically on both backends', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/logfilters';

		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug, default_branch: 'main' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `create failed: ${JSON.stringify(created)}`);
		const repo = FuzForgeRepoOutput.parse((created.result as { repo: unknown }).repo);

		// Build three commits: an old commit by Alice touching alpha.txt, then
		// two recent commits — Alice touches beta.txt, Bob touches gamma.txt.
		const work = await create_work_repo('logfilters');
		cleanup_dirs.push(work);
		await commit_file(work, 'alpha.txt', 'alpha\n', AUTHOR_A, '2020-01-01T00:00:00Z');
		await commit_file(work, 'beta.txt', 'beta\n', AUTHOR_A, '2026-05-01T00:00:00Z');
		await commit_file(work, 'gamma.txt', 'gamma\n', AUTHOR_B, '2026-05-02T00:00:00Z');

		const token = keeper_token(fixture.create_bearer_headers());
		await push_refs(work, { base_url, username: fixture.account.username, token, slug }, [
			'HEAD:refs/heads/main'
		]);

		const log_with = async (params: Record<string, unknown>): Promise<FuzForgeRepoLogOutput> => {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_log',
				params: { id: repo.id, ...params },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(res.ok, `log failed: ${JSON.stringify(res)}`);
			return FuzForgeRepoLogOutput.parse(res.result);
		};

		// Baseline: all three commits, newest-first.
		const all = await log_with({});
		assert.strictEqual(all.commits.length, 3, 'all three commits should be present');

		// EVERY sha, not just `commits[0]`. `git log --format=<fmt>%x1e` is a
		// tformat, so git writes `RS LF` after every record and each record
		// past the first arrives with the previous record's LF attached; a
		// parser that trims only the stream tail returns `"\n<sha>"` for
		// records 2..n — which silently poisons `next_cursor` and every
		// per-commit link. Comparing against `git rev-list` is what makes the
		// bytes, not just the count, the contract.
		const pushed_shas = (await git(work, ['rev-list', 'HEAD'])).stdout.trim().split('\n');
		assert.deepEqual(
			all.commits.map((c) => c.sha),
			pushed_shas,
			'every sha matches git, newest-first'
		);

		// A full `next_cursor` round-trip over the same history: page 1 of 2
		// hands back the second sha as the cursor, and paging with it yields
		// exactly the third commit and a null cursor. This is the path a
		// leading-LF sha breaks — the cursor is rejected by `is_full_sha` and
		// page 2 comes back empty.
		const page1 = await log_with({ limit: 2 });
		assert.deepEqual(
			page1.commits.map((c) => c.sha),
			pushed_shas.slice(0, 2),
			'page 1 is the two newest commits'
		);
		assert.strictEqual(page1.next_cursor, pushed_shas[1], 'the cursor is the last sha on page 1');
		const page2 = await log_with({ limit: 2, cursor: page1.next_cursor });
		assert.deepEqual(
			page2.commits.map((c) => c.sha),
			pushed_shas.slice(2),
			'page 2 is the remaining commit'
		);
		assert.strictEqual(page2.next_cursor, null, 'the last page has no cursor');

		// `repo_commit` on a sha past `commits[0]` — the read that 404s on a
		// backend whose parser leaves the LF in place.
		const commit = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_commit',
			params: { id: repo.id, sha: all.commits[1]!.sha },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(commit.ok, `repo_commit on commits[1] failed: ${JSON.stringify(commit)}`);
		assert.strictEqual((commit.result as { commit: { sha: string } }).commit.sha, pushed_shas[1]);

		// author=Alice → the two commits she authored (alpha + beta), not Bob's gamma.
		const by_alice = await log_with({ author: AUTHOR_A.email });
		assert.deepEqual(
			by_alice.commits.map((c) => c.subject).sort(),
			['touch alpha.txt', 'touch beta.txt'],
			'author filter should keep only Alice commits'
		);
		assert.ok(
			by_alice.commits.every((c) => c.author_email === AUTHOR_A.email),
			'every author-filtered commit is by Alice'
		);

		// author=Bob → only the gamma commit.
		const by_bob = await log_with({ author: AUTHOR_B.email });
		assert.deepEqual(
			by_bob.commits.map((c) => c.subject),
			['touch gamma.txt'],
			'author filter should keep only the Bob commit'
		);

		// since=2025 → the two 2026 commits, not the 2020 alpha commit.
		const recent = await log_with({ since: '2025-01-01T00:00:00Z' });
		assert.deepEqual(
			recent.commits.map((c) => c.subject).sort(),
			['touch beta.txt', 'touch gamma.txt'],
			'since filter should drop the 2020 commit'
		);

		// path=beta.txt → only the commit that touched beta.txt.
		const beta_only = await log_with({ path: 'beta.txt' });
		assert.deepEqual(
			beta_only.commits.map((c) => c.subject),
			['touch beta.txt'],
			'path filter should keep only the commit touching beta.txt'
		);
	});

	test('repo_log answers the empty page for a malformed or absent ref on both backends', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/logempty';

		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug, default_branch: 'main' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `create failed: ${JSON.stringify(created)}`);
		const repo = FuzForgeRepoOutput.parse((created.result as { repo: unknown }).repo);

		// Push real history so `head_sha` is set — otherwise the handlers take
		// the never-pushed shortcut and the git-layer behavior under test never
		// runs. Two commits, not one: a cursor resolves to `<sha>^`, so a root
		// commit would make *every* cursor the empty page and the cursor cases
		// below would pass vacuously.
		const work = await create_work_repo('logempty');
		cleanup_dirs.push(work);
		await commit_file(work, 'alpha.txt', 'alpha\n', AUTHOR_A, '2026-05-01T00:00:00Z');
		await commit_file(work, 'beta.txt', 'beta\n', AUTHOR_A, '2026-05-02T00:00:00Z');
		const token = keeper_token(fixture.create_bearer_headers());
		await push_refs(work, { base_url, username: fixture.account.username, token, slug }, [
			'HEAD:refs/heads/main'
		]);

		const log_with = async (params: Record<string, unknown>): Promise<FuzForgeRepoLogOutput> => {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_log',
				params: { id: repo.id, ...params },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(res.ok, `log failed: ${JSON.stringify(res)}`);
			return FuzForgeRepoLogOutput.parse(res.result);
		};

		// Baseline: the seeded commit is readable, so an empty page below is
		// the ref/cursor answer and not an empty repo.
		const all = await log_with({});
		assert.strictEqual(all.commits.length, 2, 'the seeded commits should be present');

		// A well-formed but absent ref — git's `bad revision` (the `--`
		// separator the log argv always carries settles the rev-vs-pathspec
		// ambiguity, so this is the wording both backends classify). The
		// shared baseline both other cases must match.
		const absent = await log_with({ ref: 'no-such-branch' });
		assert.deepEqual(absent.commits, [], 'an absent ref is the empty page');
		assert.strictEqual(absent.next_cursor, null);
		assert.strictEqual(absent.ref, 'no-such-branch', 'the requested ref is echoed back');

		// An argv-unsafe ref never reaches git: it's refused by the read
		// layer's own guard, and must answer with the same empty page rather
		// than a `-32602`. (Over-long values are still `-32602` — that bound is
		// the handler's, not this guard's.)
		const unsafe = await log_with({ ref: '-rf' });
		assert.deepEqual(unsafe.commits, [], 'an unsafe ref is the empty page');
		assert.strictEqual(unsafe.next_cursor, null);
		assert.strictEqual(unsafe.ref, '-rf', 'the requested ref is echoed back');

		// A non-SHA cursor likewise — the empty page, with the default branch
		// echoed since no explicit ref was given.
		const bad_cursor = await log_with({ cursor: 'nope' });
		assert.deepEqual(bad_cursor.commits, [], 'a malformed cursor is the empty page');
		assert.strictEqual(bad_cursor.next_cursor, null);
		assert.strictEqual(bad_cursor.ref, 'main');

		// A case variant of a *real* sha is the sharpest version of the same
		// case: git itself resolves `<UPPERCASE-SHA>^` fine, so this is the
		// empty page only because `is_full_sha` is lowercase-only on both
		// backends — a hex-digit check that admits `A-F` would page here while
		// TS returns the empty page, which is the divergence this case pins.
		const head_sha = all.commits[0]!.sha;
		assert.strictEqual(head_sha, head_sha.toLowerCase(), 'git emits lowercase shas');
		// Control: the same sha in lowercase *does* page (to the parent
		// commit), so the uppercase empty page below is the grammar and not a
		// history artifact.
		const lower_cursor = await log_with({ cursor: head_sha });
		assert.strictEqual(lower_cursor.commits.length, 1, 'a lowercase cursor pages');
		const upper_cursor = await log_with({ cursor: head_sha.toUpperCase() });
		assert.deepEqual(upper_cursor.commits, [], 'an uppercase cursor is the empty page');
		assert.strictEqual(upper_cursor.next_cursor, null);
		assert.strictEqual(upper_cursor.ref, 'main');
	});

	test('repo_list filters by slug_prefix and since identically on both backends', async () => {
		const fixture = await setup_test();

		// Three repos: two share the `team/` prefix, one is under `other/`.
		const slugs = ['team/alpha', 'team/beta', 'other/gamma'];
		const ids: Record<string, string> = {};
		for (const slug of slugs) {
			const created = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_create',
				params: { slug, default_branch: 'main' },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(created.ok, `create ${slug} failed: ${JSON.stringify(created)}`);
			ids[slug] = FuzForgeRepoOutput.parse((created.result as { repo: unknown }).repo).id;
		}

		const token = keeper_token(fixture.create_bearer_headers());

		// Push to the two `team/` repos so they gain a `last_pushed_at`; leave
		// `other/gamma` never-pushed (null `last_pushed_at`).
		for (const slug of ['team/alpha', 'team/beta']) {
			const work = await create_work_repo('listfilters');
			cleanup_dirs.push(work);
			await commit_files(work, { 'README.md': `# ${slug}\n` }, 'init');
			await push_refs(work, { base_url, username: fixture.account.username, token, slug }, [
				'HEAD:refs/heads/main'
			]);
		}

		const list_with = async (params: Record<string, unknown>): Promise<Array<string>> => {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_list',
				params,
				headers: fixture.create_session_headers()
			});
			assert.isTrue(res.ok, `list failed: ${JSON.stringify(res)}`);
			const repos = (res.result as { repos: Array<unknown> }).repos.map((r) =>
				FuzForgeRepoOutput.parse(r)
			);
			return repos.map((r) => r.slug).sort();
		};

		// Sanity: all three seeded repos show up unfiltered (the fixture wipes
		// cell state per test, so only these three exist).
		const all = await list_with({});
		assert.deepEqual(all, ['other/gamma', 'team/alpha', 'team/beta'], 'all three repos listed');

		// slug_prefix=team/ → the two team repos, not other/gamma.
		const team = await list_with({ slug_prefix: 'team/' });
		assert.deepEqual(
			team,
			['team/alpha', 'team/beta'],
			'slug_prefix should keep only team/* repos'
		);

		// slug_prefix=team/a → only team/alpha (exact, case-sensitive prefix).
		const team_a = await list_with({ slug_prefix: 'team/a' });
		assert.deepEqual(team_a, ['team/alpha'], 'slug_prefix is an exact case-sensitive prefix');

		// slug_prefix is case-sensitive — uppercase prefix matches nothing.
		const upper = await list_with({ slug_prefix: 'TEAM/' });
		assert.deepEqual(upper, [], 'slug_prefix is case-sensitive');

		// since=2000 → only the two pushed repos; other/gamma has null
		// last_pushed_at and is excluded even though `since` is in the past.
		const pushed = await list_with({ since: '2000-01-01T00:00:00Z' });
		assert.deepEqual(
			pushed,
			['team/alpha', 'team/beta'],
			'since excludes never-pushed repos (null last_pushed_at)'
		);

		// since in the future → no repos match (all pushes are in the past).
		const future = await list_with({ since: '2999-01-01T00:00:00Z' });
		assert.deepEqual(future, [], 'a future since matches nothing');

		// The grammar gate, over the wire. `repo_list.since` is the shared UTC
		// ISO 8601 datetime on both backends (`Datetime` on the TS input schema,
		// `require_iso8601_datetime` on Rust), and it exists because the two
		// stores resolve the string with different parsers: Postgres takes its
		// special words, `Date.parse` answers `NaN` for them and degrades to no
		// filter. So `{since: 'yesterday'}` filtered on Rust and listed
		// everything on TS, and `{since: 'infinity'}` answered zero rows there
		// and every row here. Both are `-32602` on both backends now — asserted
		// against the ISO controls above, which still filter.
		for (const since of ['yesterday', 'infinity']) {
			const refused = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_list',
				params: { since },
				headers: fixture.create_session_headers()
			});
			assert.isFalse(refused.ok, `repo_list since=${since} must be refused`);
			assert.strictEqual(
				refused.error.code,
				INVALID_PARAMS,
				`repo_list since=${since}: ${refused.error.message}`
			);
		}
	});

	/**
	 * `fuz_forge_repo_log`'s `since` is the *other* grammar, and the contrast is
	 * the point: it reaches `git log --since=` verbatim on both backends, so it
	 * reads git's approxidate — much wider than the list's ISO 8601 (`2 weeks
	 * ago` works) and never an error envelope.
	 *
	 * "Never an error" is not "no-op", and the difference is worth pinning: git
	 * resolves a spelling it doesn't recognize to **now**
	 * (`git rev-parse --since=garbage` prints `--max-age=<current epoch>`), so
	 * `since: 'garbage'` silently drops every commit already in the past rather
	 * than returning the full log. Identical on both backends, and the reason
	 * `repo_list` — where the same string is `-32602` — does not follow suit.
	 */
	test('repo_log since stays git approxidate on both backends', async () => {
		const fixture = await setup_test();
		const slug = 'sincegrammar/repo';
		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug, default_branch: 'main' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `create failed: ${JSON.stringify(created)}`);
		const repo = FuzForgeRepoOutput.parse((created.result as { repo: unknown }).repo);

		const token = keeper_token(fixture.create_bearer_headers());
		const work = await create_work_repo('sincegrammar');
		cleanup_dirs.push(work);
		// One commit, dated far in the past. A *recent* commit would make the
		// `garbage` case below race the clock — git resolves `garbage` to `now`,
		// and a commit pushed in the same second sits on the boundary.
		await commit_file(work, 'alpha.txt', 'alpha\n', AUTHOR_A, '2020-01-01T00:00:00Z');
		await push_refs(work, { base_url, username: fixture.account.username, token, slug }, [
			'HEAD:refs/heads/main'
		]);

		const log_with = async (params: Record<string, unknown>): Promise<number> => {
			const res = await rpc_call({
				app: fixture.transport,
				path: SPINE_RPC_PATH,
				method: 'fuz_forge_repo_log',
				params: { id: repo.id, ...params },
				headers: fixture.create_session_headers()
			});
			assert.isTrue(res.ok, `log failed: ${JSON.stringify(res)}`);
			return (res.result as { commits: Array<unknown> }).commits.length;
		};

		// The control: the commit is there unfiltered.
		assert.strictEqual(await log_with({}), 1, 'the pushed commit is in the unfiltered log');

		// An ISO datetime reaches approxidate too, and admits the 2020 commit —
		// the non-vacuity control for the two empty pages below.
		assert.strictEqual(
			await log_with({ since: '2019-01-01T00:00:00Z' }),
			1,
			'an ISO window before the commit keeps it'
		);

		// A *relative* approxidate — which `repo_list` refuses outright — is a
		// clean 200 here and correctly drops the 2020 commit.
		assert.strictEqual(
			await log_with({ since: '2 weeks ago' }),
			0,
			'a relative approxidate window drops a 2020 commit'
		);

		// `garbage` is not approxidate. git does not fail on it — the call is a
		// clean 200, where `repo_list` answers `-32602` for the same string —
		// but it does not ignore it either: `git rev-parse --since=garbage`
		// resolves to `--max-age=<now>`, so every past commit drops out. The
		// page is empty on both backends, and that is the pin: forgiving is not
		// the same as no-op.
		assert.strictEqual(
			await log_with({ since: 'garbage' }),
			0,
			'an unrecognized approxidate resolves to now, so past commits drop out'
		);
	});
});
