/**
 * Cross-process integration suite for the **scoped-token WS-upgrade reject** —
 * run against BOTH fuz_forge backends (Deno/Hono + Rust `fuz_forge_server`,
 * Axum) via the `cross_backend_*` mechanism. It pins the one branch the other
 * scoped-token suites never touch: a scoped bearer is refused at the `/api/ws`
 * upgrade, before any handshake.
 *
 * **Why this is a parity probe (not duplicated coverage).** The companion
 * suites exercise the scoped-token gate on the JSON-RPC surface
 * (`rpc_scoped_token.cross.test.ts`) and the file-store surface
 * (`files_scoped_token.cross.test.ts`). Neither fires a WS upgrade, so the
 * "scoped tokens are HTTP-only — rejected at the socket" invariant is
 * cross-process-unverified without this file. It matters because the upgrade
 * gate is a *third*, independently-wired enforcement point: a connected socket
 * receives every broadcast with no per-recipient ACL, so a scoped token that
 * slipped onto the socket would leak `fuz_forge_repo_updated` (and any future
 * broadcast) outside its capability surface. Both backends close that window,
 * and this asserts the rejection on each.
 *
 * Both close it in the same place — the spine's rule 3, which refuses every
 * non-RPC surface to a narrowed token — so the expected body is one constant,
 * `SCOPED_TOKEN_WS_DENIAL_BODY`. The upgrade is refused with an HTTP 403 and a
 * JSON body, before any handshake.
 *
 * **How the upgrade is probed.** A rejected upgrade never completes the
 * WebSocket handshake — the gate returns an ordinary HTTP 403 *before* the
 * `101 Switching Protocols`. So the assertion is on the plain HTTP response
 * (`status`, JSON body, content type) — no WS client library is involved. The
 * request is built with Node's `node:http` rather than `fetch`: undici's
 * `fetch` forbids client-set `Connection`/`Upgrade` headers
 * (`InvalidArgumentError: invalid upgrade header`), so the upgrade-request
 * headers (`Upgrade: websocket`, `Connection: Upgrade`, `Sec-WebSocket-*`) plus
 * the scoped `Authorization: Bearer` go through the low-level client, which
 * delivers the 403 as a normal `response` event (the gate answered before any
 * `upgrade` event). The request carries NO `Origin`/`Referer` (the auth
 * middleware discards bearer credentials when one is present, so the token must
 * look like a non-browser caller for the gate to see a scope at all).
 *
 * **The gate keys on narrowness, not on what was granted.** Every non-`admin`
 * template derives a `methods` scope — a permissive `rpc_subset` grant *or* a
 * narrow single-filename `files_read` grant (which maps to the empty method
 * set) — and rule 3 refuses any of them the socket without reading the method
 * list. Both templates are asserted to 403 identically, pinning that the gate
 * never inspects the grant body before rejecting.
 *
 * Gated on `capabilities.ws` (skipped on a backend that doesn't mount the
 * socket).
 *
 * @module
 */

import { request as http_request } from 'node:http';

import { assert, describe } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { test_if } from '@fuzdev/fuz_app/testing/cross_backend/capabilities.ts';
import { RAW_WS_UPGRADE_HEADERS } from '@fuzdev/fuz_app/testing/transports/ws_raw_client.ts';

import { mint_scoped_token, SCOPED_TOKEN_WS_DENIAL_BODY } from './scoped_token_mint.ts';

const handle = inject_backend_handle();
// The admin WS upgrade is gated by `required_roles: [ROLE_ADMIN]`, and the
// fresh keeper holds it: `_testing_reset` seeds it `[ROLE_KEEPER, ROLE_ADMIN]`,
// so `extra_keeper_roles` (roles *beyond* that default) is not wired. Admin
// matters for the *mint* rather than the assertion: a scoped token comes from
// `fuz_forge_token_create_scoped`, which is itself admin-gated, so a keeper
// without admin would never reach the probe. The assertion does not need it —
// both spines run the two gates in the same order (scope 403 before role 403),
// so a keeper lacking admin answers `token_scope_required` on both.
const setup_test = default_cross_process_setup(handle);
const { base_url, ws_path, capabilities } = handle.config;

/** Plain HTTP response captured from the rejected upgrade attempt. */
interface UpgradeRejection {
	status: number;
	content_type: string | undefined;
	body: string;
}

/**
 * Attempt a WebSocket upgrade over a scoped bearer with NO Origin/Referer
 * (bearer credentials are discarded by the auth middleware when an
 * Origin/Referer is present, so the token must look like a non-browser
 * caller). A rejected upgrade returns a plain HTTP response — no handshake — so
 * this asserts on `status` + JSON body rather than opening a socket.
 *
 * Built on `node:http` because undici's `fetch` forbids client-set
 * `Connection`/`Upgrade` headers (`InvalidArgumentError: invalid upgrade
 * header`). The gate answers 403 before any `101`, so the low-level client
 * delivers it as a normal `response` event, not an `upgrade`.
 */
const attempt_ws_upgrade = (bearer: string): Promise<UpgradeRejection> =>
	new Promise((resolve, reject) => {
		const url = new URL(`${base_url}${ws_path}`);
		const req = http_request(
			{
				hostname: url.hostname,
				port: url.port,
				path: url.pathname,
				method: 'GET',
				headers: {
					Authorization: `Bearer ${bearer}`,
					...RAW_WS_UPGRADE_HEADERS
				}
			},
			(res) => {
				const chunks: Array<Buffer> = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					resolve({
						status: res.statusCode ?? 0,
						content_type: res.headers['content-type'],
						body: Buffer.concat(chunks).toString('utf8')
					});
				});
			}
		);
		// A 403 reject is a `response`, but guard against the gate ever letting
		// the upgrade through (would surface as an `upgrade` event) so the test
		// fails loudly rather than hanging.
		req.on('upgrade', (_res, socket) => {
			socket.destroy();
			reject(new Error('WS upgrade unexpectedly succeeded for a scoped token'));
		});
		req.on('error', reject);
		req.end();
	});

describe('scoped-token WS upgrade reject (cross-process, both backends)', () => {
	test_if(
		capabilities.ws,
		'a permissive rpc_subset scoped token is rejected at the WS upgrade with 403 + the exact body',
		async () => {
			const fixture = await setup_test();
			const { token } = await mint_scoped_token(
				fixture,
				{ kind: 'rpc_subset', methods: ['fuz_forge_repo_list'] },
				'ws upgrade reject probe'
			);

			const res = await attempt_ws_upgrade(token);
			assert.strictEqual(res.status, 403, 'scoped token must be refused at WS upgrade');
			assert.strictEqual(res.content_type, 'application/json', 'reject body is JSON');
			assert.deepStrictEqual(JSON.parse(res.body), SCOPED_TOKEN_WS_DENIAL_BODY);
		}
	);

	test_if(
		capabilities.ws,
		'a restrictive (single-filename files_read) scoped policy is also rejected — the gate keys on narrowness',
		async () => {
			const fixture = await setup_test();
			// A narrow `files_read` granting one filename derives the empty method
			// set and confers no WS or broadcast reach. Rule 3 inspects only
			// *whether* the scope is narrowed, not which methods it names, so this
			// must 403 identically to the permissive token above — proving any
			// scoped token rejects. (`filenames` must be non-empty per the template
			// grammar, so a single-entry allowlist is the minimal
			// present-but-restrictive policy.)
			const { token } = await mint_scoped_token(
				fixture,
				{ kind: 'files_read', filenames: ['unreachable_from_ws.bin'] },
				'ws upgrade reject probe (narrow files_read policy)'
			);

			const res = await attempt_ws_upgrade(token);
			assert.strictEqual(res.status, 403, 'a narrow scoped token must also be refused');
			assert.strictEqual(res.content_type, 'application/json');
			assert.deepStrictEqual(JSON.parse(res.body), SCOPED_TOKEN_WS_DENIAL_BODY);
		}
	);
});
