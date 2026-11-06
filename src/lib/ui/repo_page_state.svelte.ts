/**
 * Shared repo-fetch state for the `/admin/repos/[id]/*` route subtree.
 *
 * The route subtree's `+layout.svelte` owns one `RepoPageState`, sets
 * it on `repo_page_state_context`, and triggers fetches on
 * `id` change + on the `fuz_forge_repo_updated` broadcast. Every page below
 * (`+page.svelte` for repo overview, `refs`, `tree/[...rest]`,
 * `blob/[...rest]`, `log`, `c/[sha]`) consumes the same instance via
 * the context so the header (slug, default branch chip, tabs) renders
 * once and stays mounted across navigations.
 *
 * @module
 */

import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';
import type { FuzForgeApp } from './fuz_forge_app.svelte.ts';
import type { FuzForgeRepoOutput } from '../action_specs.ts';

export class RepoPageState {
	#fuz_forge_app: FuzForgeApp;

	id: string = $state.raw('');
	repo: FuzForgeRepoOutput | null = $state.raw(null);
	loading: boolean = $state.raw(false);
	error: string | null = $state.raw(null);

	constructor(options: { fuz_forge_app: FuzForgeApp }) {
		this.#fuz_forge_app = options.fuz_forge_app;
	}

	set_id(next_id: string): void {
		this.id = next_id;
	}

	async fetch(): Promise<void> {
		const target_id = this.id;
		if (!target_id) return;
		this.loading = true;
		this.error = null;
		try {
			const { repo } = await this.#fuz_forge_app.api.fuz_forge_repo_get({ id: target_id });
			// Drop if the id changed mid-flight — the next fetch wins.
			if (this.id !== target_id) return;
			this.repo = repo;
		} catch (e) {
			if (this.id !== target_id) return;
			this.error = to_error_message(e, 'Request failed');
			this.repo = null;
		} finally {
			if (this.id === target_id) this.loading = false;
		}
	}
}

export const repo_page_state_context = create_context<RepoPageState>();
