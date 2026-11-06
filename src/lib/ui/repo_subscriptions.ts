/**
 * Broadcast-subscription helpers for `/admin/repos/[id]/*` views.
 *
 * Every per-repo browse component (`RepoDetail`, `RepoRefs`, `RepoTree`,
 * `RepoBlob`, `RepoLog`, `RepoCommit`) re-fetches on the
 * `fuz_forge_repo_updated` notification when the broadcast's `repo_id` matches
 * the page's id. `subscribe_to_repo_updates` holds that filter + subscribe
 * pattern, so each component subscribes in one line.
 *
 * @module
 */

import type { FuzForgeApp } from './fuz_forge_app.svelte.ts';

/**
 * Subscribe to `fuz_forge_repo_updated` broadcasts, invoking `on_update`
 * only when the broadcast's `repo_id` matches `id`. Returns the raw
 * unsubscribe handle from `fuz_forge_app.on_notification` — meant to be
 * returned directly from `onMount(() => …)`.
 *
 * @param fuz_forge_app - the app instance carrying the WS transport
 * @param id - the repo id to match against incoming broadcasts
 * @param on_update - handler fired (without arguments) on a matching broadcast
 * @returns the unsubscribe function
 */
export const subscribe_to_repo_updates = (
	fuz_forge_app: FuzForgeApp,
	id: string,
	on_update: () => void
): (() => void) =>
	fuz_forge_app.on_notification('fuz_forge_repo_updated', (input) => {
		if (input.repo_id === id) on_update();
	});
