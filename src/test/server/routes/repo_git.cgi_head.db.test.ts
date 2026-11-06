/**
 * CGI-head error-path tests for the git smart-HTTP routes.
 *
 * The auth file uses `spawn_streaming: undefined` to assert auth gates
 * fire before the subprocess. This file instead injects a fake
 * `spawn_streaming` whose stdout misbehaves — closing before the CGI
 * `\r\n\r\n` separator, or pumping bytes past the head-size cap — so
 * the route's CGI-head parser exercises its error path and we verify
 * the response is a 502 (not a default-200 with truncated bytes).
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { create_test_app } from '@fuzdev/fuz_app/testing/app_server.ts';
import type { AppServerContext } from '@fuzdev/fuz_app/server/app_server_context.ts';
import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { fuz_forge_session_config } from '#lib/server/routes/account.ts';
import { create_fuz_forge_app_route_specs } from '#lib/server/routes/fuz_forge_route_specs.ts';
import { repo_cell_path, type RepoCellData } from '#lib/fuz_forge/repo/plan_repo.ts';
import { query_cell_create } from '@fuzdev/fuz_app/db/cell_queries.ts';
import type { SpawnStreaming, SpawnStreamingHandle } from '#lib/server/subprocess.ts';

import { describe_db } from '../../db_fixture.ts';
import {
	test_file_route_deps,
	test_audit_sse_deps,
	test_facts_dir
} from './fuz_forge_test_helpers.ts';

const SLUG = 'fuzdev/fuz_app';

const seed_repo_cell = async (db: Db): Promise<void> => {
	const deps: QueryDeps = { db };
	const data: RepoCellData = {
		slug: SLUG,
		name: 'fuz_app',
		default_branch: 'main',
		seed_from: null,
		seed_completed_at: null,
		hook_secret_hash: 'secret',
		head_sha: null,
		last_pushed_at: null,
		last_pushed_by: null,
		last_push_username: null
	};
	await query_cell_create(deps, { path: repo_cell_path(SLUG), data, kind: 'repo' });
};

/**
 * Build a `SpawnStreamingHandle` whose stdout yields `stdout_bytes`
 * (chunked as a single push) then closes. stderr and stdin are inert.
 * Used to drive the CGI-head parser into its error branches without
 * spawning a real subprocess.
 */
const make_fake_handle = (stdout_bytes: Uint8Array): SpawnStreamingHandle => ({
	stdin: new WritableStream<Uint8Array>({
		write() {
			/* swallow */
		},
		close() {
			/* swallow */
		}
	}),
	stdout: new ReadableStream<Uint8Array>({
		start(controller) {
			if (stdout_bytes.length > 0) controller.enqueue(stdout_bytes);
			controller.close();
		}
	}),
	stderr: new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		}
	}),
	status: Promise.resolve({ code: 0, success: true }),
	kill: () => {
		/* no-op */
	}
});

const build_test_app = async (get_db: () => Db, spawn_streaming: SpawnStreaming) => {
	const log = new Logger('test-repo-git-cgi', { level: 'off' });
	const create_route_specs = (ctx: AppServerContext) => {
		const query_deps: QueryDeps = { db: ctx.deps.db };
		return create_fuz_forge_app_route_specs(ctx, {
			audit_sse: test_audit_sse_deps(),
			fuz_forge: {
				runtime: undefined as never,
				query_deps,
				seed_from_allow_private_hosts: false,
				log
			},
			files: test_file_route_deps({
				query_deps,
				max_upload_bytes: 1024,
				fact_store: undefined as never
			}),
			repo_git: {
				runtime: { env_get: (name: string) => (name === 'PATH' ? '/usr/bin' : undefined) } as never,
				query_deps,
				spawn_streaming,
				log
			},
			repo_internal: {
				query_deps,
				broadcast: {
					fuz_forge_run_created: async () => undefined,
					fuz_forge_run_updated: async () => undefined,
					fuz_forge_repo_updated: async () => undefined
				} as never,
				log,
				get_connection_ip: () => '127.0.0.1'
			},
			version: '0.0.0-test',
			get_uptime_ms: () => 0,
			facts_dir: test_facts_dir()
		});
	};
	return await create_test_app({
		session_options: fuz_forge_session_config,
		create_route_specs,
		db: get_db(),
		roles: [ROLE_ADMIN]
	});
};

const basic_header = (username: string, password: string): string =>
	`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

describe_db('repo_git CGI head error paths', (get_db) => {
	describe('GET /:slug.git/info/refs', () => {
		test('502 when subprocess closes stdout without CGI separator', async () => {
			const fake_spawn: SpawnStreaming = () => make_fake_handle(new Uint8Array(0));
			const test_app = await build_test_app(get_db, fake_spawn);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());

			const res = await test_app.app.request(`/${SLUG}.git/info/refs?service=git-upload-pack`, {
				method: 'GET',
				headers: { Authorization: basic_header(admin.account.username, admin.api_token) }
			});
			assert.strictEqual(res.status, 502);
		});

		test('502 when subprocess emits partial headers then EOF', async () => {
			// "Status: 200 OK\nContent-Type: foo" — no blank line, then EOF.
			const partial = new TextEncoder().encode('Status: 200 OK\nContent-Type: foo');
			const fake_spawn: SpawnStreaming = () => make_fake_handle(partial);
			const test_app = await build_test_app(get_db, fake_spawn);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());

			const res = await test_app.app.request(`/${SLUG}.git/info/refs?service=git-upload-pack`, {
				method: 'GET',
				headers: { Authorization: basic_header(admin.account.username, admin.api_token) }
			});
			assert.strictEqual(res.status, 502);
		});

		test('502 when CGI head exceeds size cap without a separator', async () => {
			// 128 KiB of header-looking bytes with no blank line — should trip
			// the 64 KiB cap and bail out as 502.
			const oversize = new Uint8Array(128 * 1024).fill(0x41); // 'A'
			const fake_spawn: SpawnStreaming = () => make_fake_handle(oversize);
			const test_app = await build_test_app(get_db, fake_spawn);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());

			const res = await test_app.app.request(`/${SLUG}.git/info/refs?service=git-upload-pack`, {
				method: 'GET',
				headers: { Authorization: basic_header(admin.account.username, admin.api_token) }
			});
			assert.strictEqual(res.status, 502);
		});

		test('happy path: separator present yields the parsed status', async () => {
			const head = new TextEncoder().encode(
				'Status: 200 OK\r\nContent-Type: application/x-git-upload-pack-advertisement\r\n\r\nbody-bytes'
			);
			const fake_spawn: SpawnStreaming = () => make_fake_handle(head);
			const test_app = await build_test_app(get_db, fake_spawn);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());

			const res = await test_app.app.request(`/${SLUG}.git/info/refs?service=git-upload-pack`, {
				method: 'GET',
				headers: { Authorization: basic_header(admin.account.username, admin.api_token) }
			});
			assert.strictEqual(res.status, 200);
			assert.strictEqual(
				res.headers.get('Content-Type'),
				'application/x-git-upload-pack-advertisement'
			);
			assert.strictEqual(await res.text(), 'body-bytes');
		});

		test('a lone \\r inside a CGI head line is not a line break', async () => {
			// Twin fixture of the Rust `forge_git::cgi::tests::lone_cr_is_not_a_line_break`.
			// `parse_cgi_head` splits on /\r?\n/, so the lone \r folds into the
			// preceding header's VALUE and `X-Injected` never becomes a header of
			// its own. The Rust twin used to split on ['\n', '\r'] and promoted it
			// to a real response header — a head-injection divergence, since the
			// head comes from `git http-backend`'s stdout.
			//
			// The \r sits on a NON-`Status` header deliberately: that is the
			// branch where the two backends actually diverged. The folded value
			// carries a \r, which no HTTP layer can represent — `headers.append`
			// throws here (a 500 before the try/catch-and-skip) and
			// `HeaderValue::from_str` errors there. Both now drop the header, so
			// the response carries neither `X-Injected` nor a `Content-Type`.
			const head = new TextEncoder().encode(
				'Content-Type: text/plain\rX-Injected: yes\r\n\r\nbody-bytes'
			);
			const fake_spawn: SpawnStreaming = () => make_fake_handle(head);
			const test_app = await build_test_app(get_db, fake_spawn);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());

			const res = await test_app.app.request(`/${SLUG}.git/info/refs?service=git-upload-pack`, {
				method: 'GET',
				headers: { Authorization: basic_header(admin.account.username, admin.api_token) }
			});
			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.headers.get('X-Injected'), null, 'lone \\r must not open a header');
			assert.strictEqual(
				res.headers.get('Content-Type'),
				null,
				'a value carrying a lone \\r is unrepresentable — the header is dropped'
			);
			assert.strictEqual(await res.text(), 'body-bytes');
		});

		test('only a three-digit CGI Status both runtimes can emit becomes the response status', async () => {
			// Twin fixture table of the Rust
			// `forge_git::cgi::tests::status_value_must_be_a_supported_three_digit_code`
			// + `head_with_an_unusable_status_defaults_to_200`. Three divergences
			// converge here:
			//
			// - `parseInt` salvaged the leading digits of `404abc` and answered
			//   404 where Rust's `parse::<u16>()` answered the default 200.
			// - `600` went out as an HTTP 600 on Rust, while `new Response`
			//   throws a `RangeError` on it here — a 500, plus a `git
			//   http-backend` child left unreaped. `099` was a 500 on Rust the
			//   same way. 200-599 minus the null-body statuses (204/205/304) is the
			//   set both runtimes can emit.
			// - The status token was split on `\s` here and `split_whitespace`
			//   there, which disagree on U+FEFF: `404\uFEFFNot Found` was a 404
			//   on TS and a 200 on Rust. Both now split on space/tab alone.
			const cases: Array<[value: string, expected: number]> = [
				['404 Not Found', 404],
				['404', 404],
				['404abc', 200],
				['600', 200],
				['100', 200],
				['099', 200],
				['204', 200],
				['304 Not Modified', 200],
				['', 200],
				['404\uFEFFNot Found', 200]
			];
			let head = new Uint8Array(0);
			const fake_spawn: SpawnStreaming = () => make_fake_handle(head);
			const test_app = await build_test_app(get_db, fake_spawn);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());

			for (const [value, expected] of cases) {
				head = new TextEncoder().encode(
					`Status: ${value}\r\nContent-Type: application/x-git-upload-pack-advertisement\r\n\r\nbody-bytes`
				);
				const res = await test_app.app.request(`/${SLUG}.git/info/refs?service=git-upload-pack`, {
					method: 'GET',
					headers: { Authorization: basic_header(admin.account.username, admin.api_token) }
				});
				assert.strictEqual(res.status, expected, `Status: ${JSON.stringify(value)}`);
				assert.strictEqual(
					res.headers.get('Content-Type'),
					'application/x-git-upload-pack-advertisement',
					`Status: ${JSON.stringify(value)}`
				);
				await res.text();
			}
		});

		test('the CGI env key set is exactly the pinned list', async () => {
			// Twin of the Rust `forge_git::cgi::tests::cgi_env_key_set_is_pinned`
			// — the same authenticated `info/refs` shape, the same literal list.
			// The CGI env is the COMPLETE subprocess env (both backends clear the
			// parent), so its key set is a contract: `GIT_CONFIG_NOSYSTEM` keeps
			// `/etc/gitconfig` — and any system `core.hooksPath` — away from
			// `git http-backend`, and `GIT_HTTP_EXPORT_ALL` must never appear
			// (per-repo `http.receivepack`/`http.uploadpack` is the export switch).
			const head = new TextEncoder().encode(
				'Status: 200 OK\r\nContent-Type: application/x-git-upload-pack-advertisement\r\n\r\nbody-bytes'
			);
			let captured: Record<string, string> | undefined;
			const fake_spawn: SpawnStreaming = (_cmd, _args, options) => {
				captured = options?.env;
				return make_fake_handle(head);
			};
			const test_app = await build_test_app(get_db, fake_spawn);
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());

			const res = await test_app.app.request(`/${SLUG}.git/info/refs?service=git-upload-pack`, {
				method: 'GET',
				headers: { Authorization: basic_header(admin.account.username, admin.api_token) }
			});
			assert.strictEqual(res.status, 200);
			await res.text();

			assert(captured !== undefined, 'the CGI proxy must pass an explicit env');
			assert.deepStrictEqual(Object.keys(captured).sort(), [
				'FUZ_FORGE_PUSH_ACCOUNT_ID',
				'FUZ_FORGE_PUSH_USERNAME',
				'GIT_CONFIG_NOSYSTEM',
				'GIT_PROJECT_ROOT',
				'GIT_TERMINAL_PROMPT',
				'PATH',
				'PATH_INFO',
				'QUERY_STRING',
				'REMOTE_ADDR',
				'REMOTE_USER',
				'REQUEST_METHOD'
			]);
			assert.strictEqual(captured.GIT_CONFIG_NOSYSTEM, '1');
			assert.strictEqual(captured.GIT_TERMINAL_PROMPT, '0');
			// `PATH_INFO` is `/<repo-uuid>.git/info/refs` — `GIT_PROJECT_ROOT` is
			// the store root, so the repo dir is part of the CGI path.
			assert.isTrue(
				captured.PATH_INFO?.endsWith('/info/refs'),
				`unexpected PATH_INFO: ${captured.PATH_INFO}`
			);
		});

		test('any Basic username is accepted with a valid token (PAT semantics)', async () => {
			const head = new TextEncoder().encode(
				'Status: 200 OK\r\nContent-Type: application/x-git-upload-pack-advertisement\r\n\r\nbody-bytes'
			);
			const fake_spawn: SpawnStreaming = () => make_fake_handle(head);
			const test_app = await build_test_app(get_db, fake_spawn);
			const admin = await test_app.create_account({ username: 'real_user', roles: [ROLE_ADMIN] });
			await seed_repo_cell(get_db());

			// Username 'anything' != 'real_user': the token alone identifies the
			// account, so a mismatched (or arbitrary) git username still succeeds.
			const res = await test_app.app.request(`/${SLUG}.git/info/refs?service=git-upload-pack`, {
				method: 'GET',
				headers: { Authorization: basic_header('anything', admin.api_token) }
			});
			assert.strictEqual(res.status, 200);
		});
	});
});
