/**
 * The git auth chain's database contract: a Basic password that cannot be an
 * API token is refused before any database work, and a credential read that
 * fails is a 500, never the generic 401.
 *
 * Driven over stub `Db`s — one that records every query, so "no database work"
 * is observed rather than inferred, and one whose every read throws. The Rust
 * twin pins the same two answers in `forge_git/auth.rs` (`basic_api_token`)
 * and `forge_git/mod.rs` (`auth_answers`).
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { Hono } from 'hono';
import type { Db } from '@fuzdev/fuz_app/db/db.ts';
import { generate_api_token } from '@fuzdev/fuz_app/auth/api_token.ts';
import { apply_route_specs } from '@fuzdev/fuz_app/http/route_spec.ts';
import { fuz_auth_guard_resolver } from '@fuzdev/fuz_app/auth/auth_guard_resolver.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { authenticate_git_request } from '#lib/server/routes/repo_git_auth.ts';
import { create_repo_git_route_specs } from '#lib/server/routes/repo_git.ts';

/** A `Db` whose every read records the SQL and finds nothing. */
const recording_db = (): { db: Db; queries: Array<string> } => {
	const queries: Array<string> = [];
	const record = async (sql: string): Promise<never> => {
		queries.push(sql);
		return undefined as never;
	};
	const db = {
		query: async (sql: string) => {
			queries.push(sql);
			return [];
		},
		query_one: record
	} as unknown as Db;
	return { db, queries };
};

/** Run `authenticate_git_request` for a request carrying `password` as its Basic password. */
const authenticate = async (password: string) => {
	const { db, queries } = recording_db();
	const deps = { query_deps: { db }, log: new Logger('test', { level: 'off' }) };
	const app = new Hono();
	let result: unknown = 'unset';
	app.get('/', async (c) => {
		result = await authenticate_git_request(deps, c, 'org/repo');
		return c.text('done');
	});
	await app.request('/', {
		headers: { Authorization: `Basic ${btoa(`git:${password}`)}` }
	});
	return { result, queries };
};

describe('authenticate_git_request token-shape precheck', () => {
	test('a password that cannot be a token is refused with no query', async () => {
		const token = generate_api_token().token;
		for (const junk of ['hunter2', token.slice(0, -1), 'secret_fuz_token_', `${token}x`]) {
			const { result, queries } = await authenticate(junk);
			assert.isNull(result, junk);
			assert.deepEqual(queries, [], `${junk}: no database work`);
		}
	});

	test('a token-shaped password reaches the token lookup', async () => {
		// The control: the same stub sees the lookup when the shape passes, so the
		// empty query lists above are the precheck, not a stub that never records.
		const { result, queries } = await authenticate(generate_api_token().token);
		assert.isNull(result, 'no such token');
		assert.strictEqual(queries.length, 1);
		assert.match(queries[0]!, /FROM api_token/);
	});
});

describe('git routes over a database that fails', () => {
	/** The three git routes mounted through the route pipeline over a `Db` whose every read throws. */
	const app = (): Hono => {
		const fail = async (): Promise<never> => {
			throw new Error('connection refused');
		};
		const db = { query: fail, query_one: fail } as unknown as Db;
		const log = new Logger('test', { level: 'off' });
		const hono = new Hono();
		const specs = create_repo_git_route_specs({
			query_deps: { db },
			log,
			runtime: undefined as never,
			spawn_streaming: undefined
		});
		apply_route_specs(hono, specs, fuz_auth_guard_resolver, log, db);
		return hono;
	};

	/** Each git route's response, presenting `password` as the Basic password. */
	const responses = async (password: string): Promise<Array<Response>> => {
		const hono = app();
		const authorization = `Basic ${btoa(`git:${password}`)}`;
		return Promise.all([
			hono.request('/org/repo.git/info/refs?service=git-upload-pack', {
				headers: { Authorization: authorization }
			}),
			hono.request('/org/repo.git/git-upload-pack', {
				method: 'POST',
				headers: {
					Authorization: authorization,
					'Content-Type': 'application/x-git-upload-pack-request'
				}
			}),
			hono.request('/org/repo.git/git-receive-pack', {
				method: 'POST',
				headers: {
					Authorization: authorization,
					'Content-Type': 'application/x-git-receive-pack-request'
				}
			})
		]);
	};

	test('a failed credential read answers the 500, not the 401', async () => {
		for (const res of await responses(generate_api_token().token)) {
			assert.strictEqual(res.status, 500);
			assert.isNull(res.headers.get('WWW-Authenticate'));
			const body = (await res.json()) as { error: string };
			assert.strictEqual(body.error, 'internal_error');
		}
	});

	test('a malformed password is the generic 401 over the same database', async () => {
		for (const res of await responses('hunter2')) {
			assert.strictEqual(res.status, 401);
			assert.isNotNull(res.headers.get('WWW-Authenticate'));
		}
	});
});
