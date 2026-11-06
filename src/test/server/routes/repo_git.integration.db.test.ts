/**
 * End-to-end git smart-HTTP integration test.
 *
 * Spins up the test app on a real listening port via `@hono/node-server`,
 * creates a bare repo + matching cell on disk, installs the pre-receive /
 * post-receive hooks pointed at the listening port's `/internal/*` callback, then
 * runs real `git` subprocess commands (`clone`, `push`) against the
 * forge URL. Asserts the auth + protocol round-trip works, the
 * post-receive hook updated the cell, and the broadcast fired.
 *
 * Real subprocess + real network — heavier than the auth-path tests in
 * `repo_git.auth.db.test.ts`, so this file holds only the smoke cases
 * that need the full stack:
 *
 * - Clone over HTTP (fetch round-trip + auth).
 * - Push over HTTP (push round-trip + auth + cell update + broadcast).
 * - Force-push to default branch rejected by pre-receive.
 * - Force-push to non-default branch accepted.
 *
 * @module
 */

import { mkdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { assert, test, beforeAll, afterAll } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import {
	create_test_app,
	type TestApp,
	type TestAccount
} from '@fuzdev/fuz_app/testing/app_server.ts';
import { create_node_runtime } from '@fuzdev/fuz_app/runtime/node.ts';
import type { AppServerContext } from '@fuzdev/fuz_app/server/app_server_context.ts';
import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { fuz_forge_session_config } from '#lib/server/routes/account.ts';
import { create_fuz_forge_app_route_specs } from '#lib/server/routes/fuz_forge_route_specs.ts';
import { spawn_collect_node, spawn_streaming_node } from '#lib/server/server_node.ts';
import { init_bare_repo, install_hooks } from '#lib/fuz_forge/repo/storage.ts';
import { repo_cell_path, type RepoCellData } from '#lib/fuz_forge/repo/plan_repo.ts';
import { hash_hook_secret } from '#lib/server/routes/fuz_forge_repo_cell.ts';
import { query_cell_create, query_cell_get_by_path } from '@fuzdev/fuz_app/db/cell_queries.ts';

import { describe_db } from '../../db_fixture.ts';
import {
	test_file_route_deps,
	test_audit_sse_deps,
	test_facts_dir
} from './fuz_forge_test_helpers.ts';

const SLUG = 'fuzdev/fuz_app';
const HOOK_SECRET = 'integration-secret';

let store_root: string;
let upstream_path: string;
const runtime = create_node_runtime([]);

beforeAll(async () => {
	const tag = randomBytes(16).toString('hex');
	store_root = join(tmpdir(), `fuz_forge-forge-int-${tag}`);
	await mkdir(store_root, { recursive: true });

	// Build a small upstream with one commit on main.
	upstream_path = join(store_root, '__upstream.git');
	const init_upstream = await runtime.run_command('git', ['init', '--bare', upstream_path]);
	if (!init_upstream.success) {
		throw new Error(`upstream git init failed: ${init_upstream.stderr}`);
	}
	const work_tree = join(store_root, '__upstream_work');
	await mkdir(work_tree, { recursive: true });
	const cmds: Array<[string, Array<string>]> = [
		['git', ['init', work_tree]],
		['git', ['-C', work_tree, 'config', 'user.email', 'test@example.com']],
		['git', ['-C', work_tree, 'config', 'user.name', 'Test']],
		['git', ['-C', work_tree, 'config', 'commit.gpgsign', 'false']],
		['git', ['-C', work_tree, 'commit', '--allow-empty', '-m', 'seed']],
		['git', ['-C', work_tree, 'branch', '-M', 'main']],
		['git', ['-C', work_tree, 'remote', 'add', 'origin', upstream_path]],
		['git', ['-C', work_tree, 'push', 'origin', 'main']]
	];
	for (const [cmd, args] of cmds) {
		const result = await runtime.run_command(cmd, args);
		if (!result.success) {
			throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr}`);
		}
	}
});

afterAll(async () => {
	if (store_root) await rm(store_root, { recursive: true, force: true });
});

interface BootedServer {
	test_app: TestApp;
	admin: TestAccount;
	port: number;
	server: ServerType;
	broadcast_calls: Array<unknown>;
	scoped_store: string;
	/** Cell-id UUID — the on-disk dir name + hook/callback repo id. */
	repo_id: string;
}

const boot_server = async (get_db: () => Db): Promise<BootedServer> => {
	const log = new Logger('test-repo-git-int', { level: 'off' });
	const broadcast_calls: Array<unknown> = [];

	// Per-test scoped store so concurrent tests don't collide.
	const scoped_store = join(store_root, `case-${randomBytes(6).toString('hex')}`);
	await mkdir(scoped_store, { recursive: true });

	// Build a runtime that returns the scoped store as
	// FUZ_FORGE_REPO_STORE_PATH so `repo_path()` resolves under it.
	const scoped_runtime = {
		...runtime,
		env_get: (name: string) => {
			if (name === 'FUZ_FORGE_REPO_STORE_PATH') return scoped_store;
			return runtime.env_get(name);
		}
	};

	const create_route_specs = (ctx: AppServerContext) => {
		const query_deps: QueryDeps = { db: ctx.deps.db };
		return create_fuz_forge_app_route_specs(ctx, {
			audit_sse: test_audit_sse_deps(),
			fuz_forge: {
				runtime: scoped_runtime,
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
				runtime: scoped_runtime,
				query_deps,
				spawn_streaming: spawn_streaming_node,
				log
			},
			repo_internal: {
				query_deps,
				broadcast: {
					fuz_forge_run_created: async () => undefined,
					fuz_forge_run_updated: async () => undefined,
					fuz_forge_repo_updated: async (input: unknown) => {
						broadcast_calls.push(input);
					}
				} as never,
				log,
				get_connection_ip: () => '127.0.0.1'
			},
			version: '0.0.0-test',
			get_uptime_ms: () => 0,
			facts_dir: test_facts_dir()
		});
	};

	const test_app = await create_test_app({
		session_options: fuz_forge_session_config,
		create_route_specs,
		db: get_db(),
		roles: [ROLE_ADMIN]
	});
	const admin = await test_app.create_account({
		username: 'forge_admin',
		roles: [ROLE_ADMIN]
	});

	const server = serve({ fetch: test_app.app.fetch, port: 0, hostname: '127.0.0.1' });
	await new Promise<void>((resolve) => {
		server.on('listening', () => resolve());
	});
	const address = server.address() as AddressInfo;
	const port = address.port;

	// Seed cell + bare repo + hooks pointed at the live server. The cell is
	// created first so its DB-generated id becomes the on-disk dir name and
	// the hook scripts' repo id (the new identity model).
	const deps: QueryDeps = { db: get_db() };
	const data: RepoCellData = {
		slug: SLUG,
		name: 'fuz_app',
		default_branch: 'main',
		seed_from: null,
		seed_completed_at: null,
		hook_secret_hash: hash_hook_secret(HOOK_SECRET),
		head_sha: null,
		last_pushed_at: null,
		last_pushed_by: null,
		last_push_username: null
	};
	const created = await query_cell_create(deps, { path: repo_cell_path(SLUG), data, kind: 'repo' });
	const repo_id = created.id;

	const storage_deps = { ...scoped_runtime, spawn_collect: spawn_collect_node };
	await init_bare_repo(storage_deps, repo_id);
	await install_hooks(storage_deps, {
		id: repo_id,
		hook_secret: HOOK_SECRET,
		callback_url_base: `http://127.0.0.1:${port}`
	});
	// Seed initial HEAD ref to refs/heads/main so symbolic-ref matches.
	const bare_path = join(scoped_store, `${repo_id}.git`);
	await runtime.run_command('git', ['-C', bare_path, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

	return { test_app, admin, port, server, broadcast_calls, scoped_store, repo_id };
};

const teardown_server = async (booted: BootedServer): Promise<void> => {
	await new Promise<void>((resolve) => booted.server.close(() => resolve()));
};

const remote_url = (port: number, account: TestAccount): string => {
	// `git` URL-encodes credentials in the URL; supply the API token as
	// the password and the account.username as the user.
	return `http://${encodeURIComponent(account.account.username)}:${encodeURIComponent(
		account.api_token
	)}@127.0.0.1:${port}/${SLUG}.git`;
};

describe_db('repo_git real git protocol round-trip', (get_db) => {
	test('clone + push round-trip + cell update + broadcast', async () => {
		const booted = await boot_server(get_db);
		try {
			const work = join(booted.scoped_store, 'work');
			const clone_result = await runtime.run_command('git', [
				'clone',
				remote_url(booted.port, booted.admin),
				work
			]);
			// Empty bare repo — clone succeeds with a "warning: You appear to
			// have cloned an empty repository" message on stderr but exit 0.
			assert.isTrue(clone_result.success, `clone failed: ${clone_result.stderr}`);

			// Build a commit on main and push.
			const work_cmds: Array<[string, Array<string>]> = [
				['git', ['-C', work, 'config', 'user.email', 'a@b.c']],
				['git', ['-C', work, 'config', 'user.name', 'A']],
				['git', ['-C', work, 'config', 'commit.gpgsign', 'false']],
				['git', ['-C', work, 'checkout', '-b', 'main']],
				['git', ['-C', work, 'commit', '--allow-empty', '-m', 'first']]
			];
			for (const [cmd, args] of work_cmds) {
				const r = await runtime.run_command(cmd, args);
				assert.isTrue(r.success, `${cmd} ${args.join(' ')} failed: ${r.stderr}`);
			}

			const push_result = await runtime.run_command('git', ['-C', work, 'push', 'origin', 'main']);
			assert.isTrue(push_result.success, `push failed: ${push_result.stderr}`);

			// Cell reflects the push.
			const deps: QueryDeps = { db: get_db() };
			const cell = await query_cell_get_by_path(deps, repo_cell_path(SLUG));
			const data = cell!.data as RepoCellData;
			assert.isString(data.head_sha);
			assert.match(data.head_sha ?? '', /^[0-9a-f]{40}$/);
			assert.isNotNull(data.last_pushed_at);
			assert.strictEqual(data.last_push_username, booted.admin.account.username);
			assert.strictEqual(data.last_pushed_by, booted.admin.account.id);

			// Broadcast fired exactly once with matching payload.
			assert.strictEqual(booted.broadcast_calls.length, 1);
			const payload = booted.broadcast_calls[0] as { repo_id: string; head_sha: string };
			assert.strictEqual(payload.repo_id, booted.repo_id);
			assert.strictEqual(payload.head_sha, data.head_sha);
		} finally {
			await teardown_server(booted);
		}
	}, 30_000);

	test('force-push to default branch rejected by pre-receive', async () => {
		const booted = await boot_server(get_db);
		try {
			const work = join(booted.scoped_store, 'work');
			await runtime.run_command('git', ['clone', remote_url(booted.port, booted.admin), work]);
			const setup: Array<[string, Array<string>]> = [
				['git', ['-C', work, 'config', 'user.email', 'a@b.c']],
				['git', ['-C', work, 'config', 'user.name', 'A']],
				['git', ['-C', work, 'config', 'commit.gpgsign', 'false']],
				['git', ['-C', work, 'checkout', '-b', 'main']],
				['git', ['-C', work, 'commit', '--allow-empty', '-m', 'first']],
				['git', ['-C', work, 'push', 'origin', 'main']],
				// Rewrite the only commit so the new tip is a divergent history.
				['git', ['-C', work, 'commit', '--allow-empty', '--amend', '-m', 'rewrite']]
			];
			for (const [cmd, args] of setup) {
				await runtime.run_command(cmd, args);
			}

			const force_push = await runtime.run_command('git', [
				'-C',
				work,
				'push',
				'--force',
				'origin',
				'main'
			]);
			assert.isFalse(force_push.success);
			assert.match(force_push.stderr, /non-fast-forward/i);
		} finally {
			await teardown_server(booted);
		}
	}, 30_000);

	test('force-push to non-default branch accepted', async () => {
		const booted = await boot_server(get_db);
		try {
			const work = join(booted.scoped_store, 'work');
			await runtime.run_command('git', ['clone', remote_url(booted.port, booted.admin), work]);
			const setup: Array<[string, Array<string>]> = [
				['git', ['-C', work, 'config', 'user.email', 'a@b.c']],
				['git', ['-C', work, 'config', 'user.name', 'A']],
				['git', ['-C', work, 'config', 'commit.gpgsign', 'false']],
				['git', ['-C', work, 'checkout', '-b', 'feature']],
				['git', ['-C', work, 'commit', '--allow-empty', '-m', 'feature 1']],
				['git', ['-C', work, 'push', 'origin', 'feature']],
				['git', ['-C', work, 'commit', '--allow-empty', '--amend', '-m', 'rewrite']]
			];
			for (const [cmd, args] of setup) {
				await runtime.run_command(cmd, args);
			}

			const force_push = await runtime.run_command('git', [
				'-C',
				work,
				'push',
				'--force',
				'origin',
				'feature'
			]);
			assert.isTrue(
				force_push.success,
				`expected force-push to feature to succeed: ${force_push.stderr}`
			);
		} finally {
			await teardown_server(booted);
		}
	}, 30_000);
});
