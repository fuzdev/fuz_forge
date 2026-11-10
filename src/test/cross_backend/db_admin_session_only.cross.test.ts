/**
 * Cross-process integration suite for the **session-only db-admin gate** —
 * run against BOTH fuz_forge backends (TS/Hono + Rust `fuz_forge_server`)
 * via the `cross_backend_*` mechanism.
 *
 * **Why this surface needs its own probe.** `/api/db/*` is the largest blast
 * radius the forge exposes: `GET /tables/:name` serves paginated rows of every
 * browsable table — the credential tables sit behind the browser's
 * unoverridable `NON_BROWSABLE_TABLES` floor, but the browsable set still
 * includes `cell` with per-repo `hook_secret_hash`es in `cell.data` — and
 * `DELETE /tables/:name/rows/:id` deletes any browsable row by id. The admin
 * dashboard is the sole consumer, so the gate is the **credential channel**:
 * `credential_types: ['session']` on the TS wrapper,
 * `CredentialGate::SESSION_ONLY` on the Rust mount. Every bearer — narrowed
 * or Full, whatever roles its account holds — is refused before the scope and
 * role gates even run.
 *
 * Token scoping's rule 3 (`surface:db_admin`) stays declared behind the
 * channel gate as the dormant second fence: it cannot be observed through a
 * bearer here any more (the channel refusal answers first), and that is the
 * point — if the channel gate is ever re-widened, the scope gate again
 * refuses narrowed tokens.
 *
 * The probes carry NO `Origin`/`Referer` — the auth middleware discards bearer
 * credentials when one is present, so a bearer must look like a non-browser
 * caller for the gate to see a credential at all (an Origin-carrying bearer
 * would 401 as anonymous instead, a different refusal than the one pinned
 * here).
 *
 * Both backends refuse with the spine's one credential-channel denial shape
 * (`credential_type_required` + the declared allowlist), so the expected body
 * is a constant.
 *
 * @module
 */

import { assert, test, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';

import { mint_scoped_token } from './scoped_token_mint.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { base_url } = handle.config;

/** A read and a delete — the two shapes of reach this surface grants. */
const DB_ADMIN_PROBES = [
	{ name: 'GET /api/db/tables', path: '/api/db/tables', method: 'GET' },
	{ name: 'GET /api/db/tables/:name', path: '/api/db/tables/cell', method: 'GET' },
	{
		name: 'DELETE /api/db/tables/:name/rows/:id',
		path: '/api/db/tables/cell/rows/00000000-0000-4000-8000-000000000000',
		method: 'DELETE'
	}
] as const;

/** The body both backends emit for a credential outside the channel gate. */
const EXPECTED_BODY = {
	error: 'credential_type_required',
	required_credential_types: ['session']
};

const request_with_bearer = async (
	bearer: string,
	path: string,
	method: string
): Promise<{ status: number; body: unknown }> => {
	const res = await fetch(`${base_url}${path}`, {
		method,
		headers: { Authorization: `Bearer ${bearer}` }
	});
	// The reject is JSON; a non-JSON body means the gate did not answer.
	const text = await res.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, body };
};

describe('session-only db-admin gate (cross-process, both backends)', () => {
	test('a narrowed token is refused at every db-admin route', async () => {
		const fixture = await setup_test();
		// `rpc_subset` is the *permissive* narrowing — it grants real RPC reach.
		// The channel gate refuses it before its scope is ever consulted:
		// naming RPC methods never buys a non-session surface.
		const { token } = await mint_scoped_token(
			fixture,
			{ kind: 'rpc_subset', methods: ['fuz_forge_repo_list'] },
			'db admin channel reject probe'
		);

		for (const probe of DB_ADMIN_PROBES) {
			const res = await request_with_bearer(token, probe.path, probe.method);
			assert.strictEqual(res.status, 403, `${probe.name} must refuse a bearer`);
			assert.deepStrictEqual(res.body, EXPECTED_BODY, `${probe.name} denial body`);
		}
	});

	test('even an unscoped admin token is refused — the gate is the channel, not the scope or role', async () => {
		const fixture = await setup_test();
		// The strongest bearer the forge can mint: admin account, Full scope.
		// Pre-narrowing this was the positive control proving bearers reached
		// the surface; now it pins the opposite — no bearer does.
		const { token } = await mint_scoped_token(
			fixture,
			{ kind: 'admin' },
			'db admin full-bearer reject probe'
		);

		for (const probe of DB_ADMIN_PROBES) {
			const res = await request_with_bearer(token, probe.path, probe.method);
			assert.strictEqual(res.status, 403, `${probe.name} must refuse a Full bearer`);
			assert.deepStrictEqual(res.body, EXPECTED_BODY, `${probe.name} denial body`);
		}
	});

	test('the operator session still reaches the surface — the denials are not vacuous', async () => {
		const fixture = await setup_test();
		const res = await fetch(`${base_url}/api/db/tables`, {
			headers: fixture.create_session_headers()
		});
		assert.strictEqual(
			res.status,
			200,
			'the admin session cookie should reach db-admin after the bearer narrowing'
		);
		const body: unknown = await res.json();
		assert.ok(
			Array.isArray((body as { tables?: unknown }).tables),
			'table listing shape over the session channel'
		);
	});
});
