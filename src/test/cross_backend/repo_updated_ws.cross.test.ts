/**
 * Cross-process **`fuz_forge_repo_updated` WS broadcast** suite — run against
 * BOTH fuz_forge backends (Deno/Hono + Rust `fuz_forge_server`) via the
 * `cross_backend_*` mechanism. This is the only cross-process observation of a
 * domain broadcast: the standard cross bundle omits WS, and the shared
 * `describe_cross_process_ws_tests` drives request/response round trips
 * (`heartbeat`, account actions) — it never watches a domain notification
 * land.
 *
 * Flow: create a repo via RPC → open a WS as the admin keeper (the upgrade is
 * gated by `require_role(ROLE_ADMIN)`, which the fresh-per-test keeper holds)
 * and wait for its admission → `git push` a commit over smart-HTTP → assert the
 * `fuz_forge_repo_updated` frame arrives with the pushed HEAD and validates
 * against `fuz_forge_repo_updated_action_spec.input`.
 *
 * The post-receive callback fires the broadcast fire-and-forget after the cell
 * update, so the frame may land a beat after `git push` resolves —
 * `WsClient.wait_for` polls already-received messages then waits, so a generous
 * timeout absorbs the fan-out latency without a sleep.
 *
 * Both backends broadcast `{repo_id, head_sha, last_pushed_at, last_pushed_by}`
 * (`broadcasts.rs` / `repo_internal.ts`) to every admin WS, so this is green on
 * both. Gated on `capabilities.ws`. Requires `git` + `python3` on the host.
 *
 * @module
 */

import { rm } from 'node:fs/promises';

import { assert, describe, afterEach } from 'vitest';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { test_if } from '@fuzdev/fuz_app/testing/cross_backend/capabilities.ts';
import { create_admitted_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';
import { is_notification_with } from '@fuzdev/fuz_app/testing/transports/ws_client.ts';
import { SPINE_RPC_PATH } from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';
import { assert_iso8601_seconds } from '@fuzdev/fuz_app/testing/cross_backend/wire_shapes.ts';

import { fuz_forge_repo_updated_action_spec } from '#lib/action_specs.ts';
import { commit_files, create_work_repo, keeper_token, push_refs } from './git_helpers.ts';

const handle = inject_backend_handle();
// The admin WS upgrade requires ROLE_ADMIN, which the fresh keeper holds:
// `_testing_reset` seeds it `[ROLE_KEEPER, ROLE_ADMIN]`. `extra_keeper_roles`
// is for roles *beyond* that default, so nothing is wired.
const setup_test = default_cross_process_setup(handle);
const { base_url, ws_path, capabilities } = handle.config;

/** Wire shape echoed by the broadcast (one field per the action spec). */
interface RepoUpdatedParams {
	repo_id: string;
	head_sha: string | null;
	last_pushed_at: string;
	last_pushed_by: string | null;
}

describe('fuz_forge_repo_updated WS broadcast (cross-process, both backends)', () => {
	const cleanup_dirs: Array<string> = [];
	afterEach(async () => {
		for (const dir of cleanup_dirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test_if(capabilities.ws, 'a push broadcasts fuz_forge_repo_updated to an admin WS', async () => {
		const fixture = await setup_test();
		const slug = 'ttt/broadcast';

		// 1) Create the repo via RPC so the cell + bare repo exist before the
		// socket opens (the push targets it).
		const created = await rpc_call({
			app: fixture.transport,
			path: SPINE_RPC_PATH,
			method: 'fuz_forge_repo_create',
			params: { slug, default_branch: 'main' },
			headers: fixture.create_session_headers()
		});
		assert.isTrue(created.ok, `create failed: ${JSON.stringify(created)}`);
		const repo_id = (created.result as { repo: { id: string } }).repo.id;

		// 2) Open the admin WS (cookies from the fresh-per-test keeper, origin
		// defaults to base_url which the `http://localhost:*` allowlist accepts)
		// and wait for the backend to admit it: both backends answer the
		// handshake before the connection is admitted, and a broadcast reaches
		// only an admitted connection. The helper round-trips `heartbeat`, which
		// is answered once the connection is admitted.
		const client = await create_admitted_ws_transport({
			base_url,
			ws_path,
			cookies: fixture.transport.cookies(),
			origin: base_url
		});

		try {
			// 3) Build + push a commit over smart-HTTP — the post-receive callback
			// runs during the push and fires the broadcast.
			const work = await create_work_repo('ws');
			cleanup_dirs.push(work);
			const head = await commit_files(
				work,
				{ 'README.md': '# broadcast test\n' },
				'broadcast commit'
			);

			const token = keeper_token(fixture.create_bearer_headers());
			await push_refs(work, { base_url, username: fixture.account.username, token, slug }, [
				'HEAD:refs/heads/main'
			]);

			// 4) Await the broadcast frame for this repo (fan-out is async after
			// the push resolves — wait_for polls then waits up to the timeout).
			const frame = await client.wait_for(
				is_notification_with<RepoUpdatedParams>(
					fuz_forge_repo_updated_action_spec.method,
					(p) => p.repo_id === repo_id
				),
				5000
			);

			// 5) The params validate against the wire spec, and `head_sha` is the
			// pushed HEAD (the push touched the cell's default branch).
			const params = parse_or_throw(fuz_forge_repo_updated_action_spec.input, frame.params);
			assert.strictEqual(params.repo_id, repo_id);
			assert.strictEqual(params.head_sha, head, 'head_sha should be the pushed HEAD');
			assert.ok(params.last_pushed_at, 'last_pushed_at should be set');
			// The broadcast carries the same second-precision UTC shape the
			// repo DTO does — the schema only says "string", so the bytes need
			// their own pin on the notification path too.
			assert_iso8601_seconds(params.last_pushed_at, 'broadcast → last_pushed_at');
			assert.strictEqual(
				params.last_pushed_by,
				fixture.account.id,
				'last_pushed_by should be the pushing account id'
			);
		} finally {
			await client.close();
		}
	});
});
