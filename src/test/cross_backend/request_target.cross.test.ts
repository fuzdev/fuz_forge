/**
 * Cross-process suite for the **strict request-target reads** on the forge's
 * own routes — run against BOTH fuz_forge backends (TS/Hono + Rust
 * `fuz_forge_server`, Axum) via the `cross_backend_*` mechanism.
 *
 * A percent escape that doesn't decode — a `%` not followed by two hex
 * digits, or decoded bytes that are not UTF-8 — is refused, never kept as
 * text and never replaced with U+FFFD: either way a handler would read a value
 * the client never sent. Both spines read by that rule (`fuz_app`'s
 * `http/request_target.ts` ↔ `fuz_http::request_target`), and the forge's
 * routes read through them: the path params through the route's `params`
 * schema (TS) and `fuz_http::RouteParams` (Rust), the query through the route
 * context's `query_pairs` (TS) and `fuz_http::read_query_pairs` over
 * `RawQuery` (Rust).
 *
 * Each refusal sits where the TS route pipeline puts it: an undecodable path
 * param is `400 invalid_route_params` ahead of the query and of every
 * credential check, so an anonymous caller hears it; an undecodable query on
 * a route with a `query` schema is `400 invalid_query_params` ahead of the
 * credential checks; and a query a handler reads itself (`?meta`,
 * `?service=`) is refused where the handler reads it, past its auth gate.
 *
 * Each refusal has a control spelling one escape away that decodes and is
 * served, so a refusal can only be the escape.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';

import { keeper_token } from './git_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url } = handle.config;

type Fixture = Awaited<ReturnType<typeof setup_test>>;

/** The escapes that don't decode, each a refusal on both backends. */
const UNDECODABLE: ReadonlyArray<readonly [label: string, escape: string]> = [
	['a % not followed by two hex digits', '%G0'],
	['a trailing bare %', '%'],
	['decoded bytes that are not UTF-8', '%FF']
];

const keeper_bearer = (fixture: Fixture): string => keeper_token(fixture.create_bearer_headers());

const basic_header = (username: string, password: string): string =>
	`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

const assert_error = async (
	res: Response,
	status: number,
	error: string,
	label: string
): Promise<void> => {
	assert.strictEqual(res.status, status, `${label}: status`);
	const body = (await res.json()) as { error?: unknown };
	assert.strictEqual(body.error, error, `${label}: error`);
};

const upload = async (bearer: string, path_and_query: string): Promise<Response> =>
	fetch(`${base_url}/api/fuz_forge/files/${path_and_query}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${bearer}`,
			'Content-Type': 'application/octet-stream',
			'Content-Length': '1'
		},
		body: new Uint8Array([1]) as unknown as BodyInit
	});

describe('strict path params (cross-process, both backends)', () => {
	test('a file key whose escape does not decode is 400 invalid_route_params, ahead of auth', async () => {
		await setup_test();
		for (const [label, escape] of UNDECODABLE) {
			// anonymous: the params refusal precedes the credential check
			for (const method of ['GET', 'DELETE'] as const) {
				const res = await fetch(`${base_url}/api/fuz_forge/files/a${escape}b.bin`, { method });
				await assert_error(res, 400, 'invalid_route_params', `${method} ${label}`);
			}
			const posted = await fetch(`${base_url}/api/fuz_forge/files/a${escape}b.bin`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1' },
				body: new Uint8Array([1]) as unknown as BodyInit
			});
			await assert_error(posted, 400, 'invalid_route_params', `POST ${label}`);
		}
		// control: a decodable escape reaches the credential check
		const control = await fetch(`${base_url}/api/fuz_forge/files/a%41b.bin`);
		assert.strictEqual(control.status, 401, 'a decodable key reaches auth');
	});

	test('the upload content-type refusal stays ahead of the params refusal', async () => {
		await setup_test();
		const res = await fetch(`${base_url}/api/fuz_forge/files/a%G0b.bin`, {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain', 'Content-Length': '1' },
			body: 'x'
		});
		assert.strictEqual(res.status, 415, 'the 415 precedes the params read');
	});

	test('a repo-config id whose escape does not decode is 400 invalid_route_params, ahead of the loopback gate', async () => {
		await setup_test();
		for (const [label, escape] of UNDECODABLE) {
			const res = await fetch(`${base_url}/internal/repo-config/${escape}`, {
				headers: { 'X-FuzForge-Repo-Secret': 'not-a-secret' }
			});
			await assert_error(res, 400, 'invalid_route_params', label);
		}
		// control: a decodable id that names no repo is the bare 401
		const control = await fetch(`${base_url}/internal/repo-config/%41`, {
			headers: { 'X-FuzForge-Repo-Secret': 'not-a-secret' }
		});
		assert.strictEqual(control.status, 401, 'a decodable id reaches the secret check');
	});

	test('a git clone URL whose escape does not decode is 400 invalid_route_params, ahead of auth', async () => {
		await setup_test();
		for (const [label, escape] of UNDECODABLE) {
			const advertised = await fetch(
				`${base_url}/ttt/repo${escape}x.git/info/refs?service=git-upload-pack`
			);
			await assert_error(advertised, 400, 'invalid_route_params', `info/refs ${label}`);
			const packed = await fetch(`${base_url}/ttt/repo${escape}x.git/git-upload-pack`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-git-upload-pack-request' },
				body: ''
			});
			await assert_error(packed, 400, 'invalid_route_params', `git-upload-pack ${label}`);
		}
	});
});

describe('strict query reads (cross-process, both backends)', () => {
	test('an undecodable query on the file mutations is 400 invalid_query_params, ahead of auth', async () => {
		await setup_test();
		for (const [label, escape] of UNDECODABLE) {
			// a nameless pair the strict schema would ignore, so the refusal can
			// only be the escape
			for (const method of ['DELETE', 'POST'] as const) {
				const res = await fetch(`${base_url}/api/fuz_forge/files/q.bin?=${escape}`, {
					method,
					...(method === 'POST'
						? {
								headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1' },
								body: new Uint8Array([1]) as unknown as BodyInit
							}
						: {})
				});
				await assert_error(res, 400, 'invalid_query_params', `${method} ${label}`);
			}
		}
		// control: the same nameless pair, decodable, reaches the credential check
		const control = await fetch(`${base_url}/api/fuz_forge/files/q.bin?=%41`, {
			method: 'DELETE'
		});
		assert.strictEqual(control.status, 401, 'a decodable nameless pair reaches auth');
	});

	test('an undecodable query on a file read is 400 invalid_query_params where ?meta is read', async () => {
		const fixture = await setup_test();
		const bearer = keeper_bearer(fixture);
		const uploaded = await upload(bearer, 'strict_query_meta.bin');
		assert.strictEqual(uploaded.status, 200, 'seed upload');
		for (const [label, escape] of UNDECODABLE) {
			for (const query of [`meta=${escape}`, `other=${escape}&meta`]) {
				const res = await fetch(`${base_url}/api/fuz_forge/files/strict_query_meta.bin?${query}`, {
					headers: { Authorization: `Bearer ${bearer}` }
				});
				await assert_error(res, 400, 'invalid_query_params', `${label} (${query})`);
			}
			// read past the auth gate: an anonymous caller hears the 401
			const anon = await fetch(
				`${base_url}/api/fuz_forge/files/strict_query_meta.bin?meta=${escape}`
			);
			assert.strictEqual(anon.status, 401, `${label}: anonymous`);
		}
		// control: a decodable value serves the metadata
		const control = await fetch(`${base_url}/api/fuz_forge/files/strict_query_meta.bin?meta=%41`, {
			headers: { Authorization: `Bearer ${bearer}` }
		});
		assert.strictEqual(control.status, 200, 'a decodable ?meta serves');
	});

	test('an undecodable query on the git advertisement is 400 invalid_query_params past auth', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/strict_query_git';
		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug, default_branch: 'main' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `create ${slug} failed: ${JSON.stringify(created)}`);
		const authorization = basic_header(fixture.account.username, keeper_bearer(fixture));
		for (const [label, escape] of UNDECODABLE) {
			const res = await fetch(
				`${base_url}/${slug}.git/info/refs?service=git-upload-pack&x=${escape}`,
				{ headers: { Authorization: authorization } }
			);
			await assert_error(res, 400, 'invalid_query_params', label);
			const anon = await fetch(
				`${base_url}/${slug}.git/info/refs?service=git-upload-pack&x=${escape}`
			);
			assert.strictEqual(anon.status, 401, `${label}: anonymous hears the 401`);
		}
		// control: the same query, decodable, serves the advertisement
		const control = await fetch(`${base_url}/${slug}.git/info/refs?service=git-upload-pack&x=%41`, {
			headers: { Authorization: authorization }
		});
		assert.strictEqual(control.status, 200, 'a decodable query serves');
		await control.body?.cancel();
	});
});
