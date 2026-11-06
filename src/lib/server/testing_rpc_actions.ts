/**
 * The `_testing_*` RPC actions the cross-process test binaries mount beside
 * the forge's own surface — one list, read by the binary
 * (`testing_server_build.ts`) and by the cross suites that resolve methods off
 * the declared surface (the conformance table, the differential, and the
 * generated auth rows), so a seam can't be mounted in one place and missing
 * from the other.
 *
 * - `create_fuz_forge_testing_rpc_actions` — fuz_app's `create_testing_actions`
 *   bundle with a `reset_state` truncating the forge's domain tables, the
 *   standalone upstream `_testing_origin_check` and
 *   `_testing_shorten_credential_expiry` seams, and the forge's own
 *   `_testing_await_signal`.
 * - `create_fuz_forge_testing_final_rpc_actions` — `_testing_action_manifest`,
 *   built over the assembled mount (it dumps the live method set).
 *
 * The Rust `testing_fuz_forge_server` registers the same set
 * (`crates/testing_fuz_forge_server/src/main.rs`).
 *
 * **NEVER ships in a release.** Reaches into fuz_app's `testing/cross_backend/`
 * modules, which throw on production-bundle load.
 *
 * @module
 */

import { z } from 'zod';
import type { AppDeps } from '@fuzdev/fuz_app/auth/deps.ts';
import type { DaemonTokenState } from '@fuzdev/fuz_app/auth/daemon_token.ts';
import type { SessionOptions } from '@fuzdev/fuz_app/auth/session_cookie.ts';
import {
	create_testing_action_manifest_action,
	create_testing_actions,
	create_testing_shorten_credential_expiry_action
} from '@fuzdev/fuz_app/testing/cross_backend/testing_reset_actions.ts';
import { create_testing_origin_check_action } from '@fuzdev/fuz_app/testing/cross_backend/testing_origin_check.ts';
import { rpc_action, type RpcAction } from '@fuzdev/fuz_app/actions/action_types.ts';
import type { RequestResponseActionSpec } from '@fuzdev/fuz_app/actions/action_spec.ts';

import { fuz_forge_domain_truncate_tables } from './db/fuz_forge_schema.ts';
import type { FinalRpcActionsFactory } from './app_assembly.ts';

/**
 * `_testing_await_signal` — park until the request's `ctx.signal` aborts,
 * or until `timeout_ms` elapses, and report which happened.
 *
 * The seam that makes client cancellation observable from the wire. A
 * `cancel` notification is answered with no frame by contract, so a backend
 * that drops it looks identical on the socket to one that honors it; the
 * only difference a test can see is whether the *cancelled request's* own
 * response says its signal fired. This action is that difference, and the
 * cross-backend `ws_cancel.cross.test.ts` asserts one expectation over both
 * backends against it. Twin of the Rust
 * `create_testing_await_signal_action_spec` in
 * `crates/testing_fuz_forge_server/src/main.rs`.
 *
 * **Auth diverges from the rest of the `_testing_*` family on purpose.**
 * The others gate on the daemon-token credential, but the cross-process WS
 * transport authenticates its upgrade with a session cookie and has no way
 * to present a bearer token, so a daemon-token spec is unreachable over the
 * transport this action exists to exercise. It takes the weakest gate that
 * still admits that socket — account-grain, any credential — which on the
 * forge means admin anyway, since the WS upgrade is
 * `require_role(ROLE_ADMIN)`. It reads and writes nothing; the fence that
 * matters is the binary, which never ships.
 */
const testing_await_signal_action_spec = {
	method: '_testing_await_signal',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: z.strictObject({
		timeout_ms: z.number().int().positive().max(60_000)
	}),
	output: z.strictObject({ cancelled: z.boolean() }),
	async: true,
	description:
		"Test seam: awaits the request's abort signal against a timeout and reports whether the signal fired. Makes a client `cancel` notification's effect observable on the wire."
} satisfies RequestResponseActionSpec;

/**
 * Race `signal`'s abort against `timeout_ms`.
 *
 * @param signal - the handler's per-request abort signal
 * @param timeout_ms - how long to wait before giving up
 * @returns `true` when the signal fired first, `false` on timeout
 */
const await_abort_signal = (signal: AbortSignal, timeout_ms: number): Promise<boolean> =>
	new Promise((resolve) => {
		if (signal.aborted) {
			resolve(true);
			return;
		}
		const on_abort = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', on_abort);
			resolve(false);
		}, timeout_ms);
		signal.addEventListener('abort', on_abort, { once: true });
	});

/** Options for `create_fuz_forge_testing_rpc_actions`. */
export interface FuzForgeTestingRpcActionsOptions {
	/**
	 * The daemon-token state the daemon-token middleware reads —
	 * `_testing_reset` points it at the freshly seeded keeper.
	 */
	daemon_token_state: DaemonTokenState;
	/** The session options `create_app_server` was wired with. */
	session_options: SessionOptions<string>;
}

/**
 * The `_testing_*` actions the test binaries mount on both transports
 * (HTTP RPC + `/api/ws`), ahead of `create_fuz_forge_testing_final_rpc_actions`.
 *
 * @param deps - the backend deps the seams close over
 * @param options - the daemon-token state and session options
 * @returns the seams, in mount order
 */
export const create_fuz_forge_testing_rpc_actions = (
	deps: AppDeps,
	options: FuzForgeTestingRpcActionsOptions
): Array<RpcAction> => [
	...create_testing_actions(deps, {
		session_options: options.session_options,
		daemon_token_state: options.daemon_token_state,
		// Use the passed transactional `db` (the same connection the auth wipe
		// ran on) — a separately-pooled connection deadlocks against the open
		// `_testing_reset` transaction.
		reset_state: async (db) => {
			await db.query(
				`TRUNCATE ${fuz_forge_domain_truncate_tables.join(', ')} RESTART IDENTITY CASCADE`
			);
		}
	}),
	// `_testing_origin_check` — the origin allowlist conformance probe the
	// shared backdoor suite drives; standalone upstream rather than in the
	// bundle. Twin of the Rust binary's `create_testing_origin_check_action_spec`.
	create_testing_origin_check_action(),
	// `_testing_shorten_credential_expiry` — pull an account's session and
	// token expiry in, for the credential-deadline close; also standalone
	// upstream. Twin of the Rust binary's
	// `create_testing_shorten_credential_expiry_action_spec`.
	create_testing_shorten_credential_expiry_action(),
	rpc_action(testing_await_signal_action_spec, async ({ timeout_ms }, ctx) => ({
		cancelled: await await_abort_signal(ctx.signal, timeout_ms)
	}))
];

/**
 * `_testing_action_manifest`, built over an assembled mount: it dumps the live
 * method set, so it must see every action mounted above it. Each mount (HTTP
 * RPC + WS) calls this with its own list, so the manifest an endpoint serves
 * describes that endpoint. Twin of the Rust binary's
 * `final_action_specs_factory`.
 */
export const create_fuz_forge_testing_final_rpc_actions: FinalRpcActionsFactory = (mounted) => [
	create_testing_action_manifest_action(mounted)
];
