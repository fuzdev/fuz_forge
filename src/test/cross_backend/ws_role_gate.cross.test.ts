/**
 * Cross-process integration suite for the **admin role gate on the `/api/ws`
 * upgrade** — run against BOTH fuz_forge backends (Hono on Node + Rust
 * `fuz_forge_server`, Axum) via the `cross_backend_*` mechanism.
 *
 * **Why this is load-bearing, not redundant with the scoped-token suite.** The
 * forge's WS carries `fuz_forge_repo_updated` broadcasts, and
 * `ConnectionRegistry::broadcast` / the TS transport's fan-out apply **no**
 * per-recipient filter — every open socket receives every frame. The upgrade
 * role gate is therefore the *entire* ACL over that broadcast, and signup
 * exists, so an ordinary non-admin account is a real principal that must be
 * refused. `ws_scoped_token.cross.test.ts` covers the orthogonal axis (a
 * *narrowed token* on an admin account); nothing covered the plain
 * unprivileged account, which is exactly where the two spines had diverged.
 *
 * The refused principal is minted the way production mints one:
 * `fixture.create_account()` (default `roles: []`) runs `invite_create` →
 * `POST /api/account/signup` → `POST /api/account/login`, so the account under
 * test is a signup-created account, not a bootstrap-cradle construction. Its
 * API token is full-scope, which is what keeps the bearer case landing on the
 * role gate rather than on the scope gate above it.
 *
 * **The three denial rungs.** The upgrade stack refuses coarse-to-fine —
 * unauthenticated 401, then scope 403, then role 403 — and this suite pins the
 * first and last on both backends (the middle one is the scoped-token suite's).
 * The 401 is here because it was the other Rust/TS divergence found alongside
 * the missing role gate: Rust answered a plain-text body where TS answers
 * `{error: 'authentication_required'}` JSON.
 *
 * **How the upgrade is probed.** A refused upgrade never reaches `101 Switching
 * Protocols` — the gate answers an ordinary HTTP response first — so the
 * negative cases assert on a plain HTTP response and need no WS client. The
 * admitted control is the same request observed reaching `101`. All of them go
 * through one `probe_ws_upgrade` helper so the outcomes are the same code path
 * with the same headers, differing only in which credential rides along. The
 * request is built with `node:http` because undici's `fetch` forbids
 * client-set `Connection`/`Upgrade` headers (`InvalidArgumentError: invalid
 * upgrade header`) — the same reason `ws_scoped_token.cross.test.ts` uses it.
 *
 * Denial bodies are pinned exactly (`deepStrictEqual` on the parsed body plus
 * the status and content type) against the TS spine's `require_auth` 401 and
 * `require_role` 403 — `{error: 'authentication_required'}` and `{error:
 * 'insufficient_permissions', required_roles: ['admin']}` — which the Rust side
 * emits through the shared `fuz_http::authentication_required_response` /
 * `fuz_http::insufficient_permissions_response`. Where the backend sends no
 * body with a refused upgrade (`capabilities.ws_refusal_body`: Node's
 * `@hono/node-ws` answers with the status and an empty body), the case pins the
 * status and that empty body instead, so the rungs are told apart by status
 * alone there.
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
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { RAW_WS_UPGRADE_HEADERS } from '@fuzdev/fuz_app/testing/transports/ws_raw_client.ts';

const handle = inject_backend_handle();

/**
 * Upper bound on one upgrade probe. A gate that neither answers nor upgrades
 * is the failure this suite exists to catch, and without a bound it surfaces as
 * vitest's bare "test timed out" with no clue which request hung — so the
 * helper fails with its own message instead. Well clear of the handful of
 * milliseconds a local upgrade takes, well under the 5 s default.
 */
const UPGRADE_PROBE_TIMEOUT = 4_000;

// The keeper holds `admin` for the control case without any wiring:
// `_testing_reset` seeds it `[ROLE_KEEPER, ROLE_ADMIN]`, and
// `extra_keeper_roles` is for roles beyond that default. The non-admin
// principal is not declared here either: each denial case mints its own via
// `fixture.create_account()`, which goes through the production signup flow —
// the `extra_accounts` cradle is the bypass for roles that aren't grantable at
// runtime, and "no roles at all" is the one shape signup already produces.
const setup_test = default_cross_process_setup(handle);
const { base_url, ws_path, capabilities } = handle.config;

/** Outcome of an upgrade attempt: admitted (`101`) or refused with a body. */
type UpgradeOutcome =
	| { upgraded: true }
	| { upgraded: false; status: number; content_type: string | undefined; body: unknown };

/**
 * The refusal outcome a case expects: `status` with the JSON `body` where the
 * backend sends a refused upgrade's body, else `status` with no content type
 * and an empty body.
 */
const to_refusal = (status: number, body: unknown): UpgradeOutcome =>
	capabilities.ws_refusal_body
		? { upgraded: false, status, content_type: 'application/json', body }
		: { upgraded: false, status, content_type: undefined, body: '' };

/**
 * Attempt a WebSocket upgrade carrying `auth_headers`.
 *
 * `origin` is explicit rather than defaulted because it selects the credential
 * channel: a session cookie is the browser channel and must carry an
 * allowlisted `Origin`, while a bearer token must carry **none** (the auth
 * middleware discards bearer credentials when an Origin/Referer is present, so
 * the token has to look like a non-browser caller to be seen at all).
 *
 * Resolves `{upgraded: true}` on `101` — the socket is destroyed immediately,
 * the control only needs to know the gate admitted it — or the refusal's
 * status, content type, and parsed JSON body.
 */
const probe_ws_upgrade = (options: {
	auth_headers: Record<string, string>;
	origin: string | null;
}): Promise<UpgradeOutcome> =>
	new Promise((resolve, reject) => {
		const { auth_headers, origin } = options;
		const url = new URL(`${base_url}${ws_path}`);
		const req = http_request(
			{
				hostname: url.hostname,
				port: url.port,
				path: url.pathname,
				method: 'GET',
				headers: {
					...auth_headers,
					...(origin === null ? {} : { Origin: origin }),
					...RAW_WS_UPGRADE_HEADERS
				}
			},
			(res) => {
				const chunks: Array<Buffer> = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					const raw = Buffer.concat(chunks).toString('utf8');
					let body: unknown;
					try {
						body = JSON.parse(raw);
					} catch {
						body = raw;
					}
					settle({
						upgraded: false,
						status: res.statusCode ?? 0,
						content_type: res.headers['content-type'],
						body
					});
				});
			}
		);
		const timer = setTimeout(() => {
			req.destroy();
			reject(
				new Error(
					`WS upgrade probe to ${url.pathname} neither answered nor upgraded within ` +
						`${UPGRADE_PROBE_TIMEOUT}ms`
				)
			);
		}, UPGRADE_PROBE_TIMEOUT);
		const settle = (outcome: UpgradeOutcome): void => {
			clearTimeout(timer);
			resolve(outcome);
		};
		req.on('upgrade', (_res, socket) => {
			socket.destroy();
			settle({ upgraded: true });
		});
		req.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		req.end();
	});

describe('admin role gate on the WS upgrade (cross-process, both backends)', () => {
	test_if(
		capabilities.ws,
		'an anonymous upgrade is refused with 401 + the exact body',
		async () => {
			// The fixture is awaited for the DB reset even though the request
			// carries no credential — a stale account from a prior test must not
			// be what makes this 401.
			await setup_test();

			const outcome = await probe_ws_upgrade({ auth_headers: {}, origin: base_url });

			assert.deepStrictEqual(outcome, to_refusal(401, { error: 'authentication_required' }));
		}
	);

	test_if(
		capabilities.ws,
		'a non-admin account is refused at the WS upgrade with 403 + the exact body',
		async () => {
			const fixture = await setup_test();
			const non_admin = await fixture.create_account();

			const outcome = await probe_ws_upgrade({
				auth_headers: non_admin.create_session_headers(),
				origin: base_url
			});

			assert.deepStrictEqual(
				outcome,
				to_refusal(403, { error: 'insufficient_permissions', required_roles: [ROLE_ADMIN] })
			);
		}
	);

	// The same principal over the other credential channel. It is a distinct
	// path, not a restatement: the minted account's token is **full-scope**, so
	// it clears the scope gate the `ws_scoped_token` suite pins and the role gate
	// is the only thing left to refuse it — and the bearer channel is the one a
	// CLI or script uses, where a socket-shaped privilege escalation would
	// actually be reached for.
	test_if(capabilities.ws, 'a non-admin full-scope bearer is refused the same way', async () => {
		const fixture = await setup_test();
		const non_admin = await fixture.create_account();

		const outcome = await probe_ws_upgrade({
			auth_headers: non_admin.create_bearer_headers(),
			origin: null
		});

		assert.deepStrictEqual(
			outcome,
			to_refusal(403, { error: 'insufficient_permissions', required_roles: [ROLE_ADMIN] })
		);
	});

	// The control that keeps the negatives honest: the identical request over an
	// admin's cookie must reach `101`, so the refusals above are attributable to
	// the gates rather than to anything else in the upgrade stack.
	test_if(capabilities.ws, 'an admin account upgrades over the same request shape', async () => {
		const fixture = await setup_test();

		// `FetchTransport.cookies()` yields bare `name=value` heads, so joining
		// them is already a `Cookie` header value.
		const outcome = await probe_ws_upgrade({
			auth_headers: { cookie: fixture.transport.cookies().join('; ') },
			origin: base_url
		});

		assert.deepStrictEqual(outcome, { upgraded: true });
	});
});
