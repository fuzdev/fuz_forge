/**
 * Reactive state for the per-repo log view.
 *
 * Owns:
 * - first-page + next-page `AsyncSlot`s (split so a `Load more` failure
 *   doesn't blow away accumulated rows);
 * - the accumulated `commits` array, `next_cursor`, and server-echoed
 *   `active_ref` (none derivable from a single slot — pagination spans
 *   slots);
 * - the applied-filter snapshot used to build subsequent requests.
 *
 * Filter form bindings stay in the component (transient UI state); this
 * class only sees the committed values via `apply_filters`.
 *
 * @module
 */

import { AsyncSlot } from '@fuzdev/fuz_app/ui/async_slot.svelte.ts';
import type { ThrowingApi } from '@fuzdev/fuz_app/actions/rpc_client.ts';

import type {
	FuzForgeRepoCommitSummary,
	FuzForgeRepoLogInput,
	FuzForgeRepoLogOutput
} from '../action_specs.ts';
import type { FrontendActionsApi } from '../action_metatypes.ts';

const PAGE_LIMIT = 50;

export interface RepoLogFilters {
	ref: string;
	author: string;
	since: string;
	path: string;
}

export class RepoLogState {
	readonly #api: ThrowingApi<FrontendActionsApi>;

	readonly first_page = new AsyncSlot<FuzForgeRepoLogOutput>();
	readonly next_page = new AsyncSlot<FuzForgeRepoLogOutput>();

	commits: Array<FuzForgeRepoCommitSummary> = $state.raw([]);
	next_cursor: string | null = $state.raw(null);
	/**
	 * Echoed back from the server — when filters omit `ref`, this is the
	 * repo's `default_branch`.
	 */
	active_ref: string = $state.raw('');

	#id: string = '';
	#applied: RepoLogFilters = { ref: '', author: '', since: '', path: '' };

	constructor(options: { api: ThrowingApi<FrontendActionsApi> }) {
		this.#api = options.api;
	}

	set_id(id: string): void {
		this.#id = id;
	}

	#build_params(cursor: string | undefined): FuzForgeRepoLogInput {
		const params: FuzForgeRepoLogInput = { id: this.#id, limit: PAGE_LIMIT };
		if (this.#applied.ref.length > 0) params.ref = this.#applied.ref;
		if (this.#applied.author.length > 0) params.author = this.#applied.author;
		if (this.#applied.since.length > 0) params.since = this.#applied.since;
		if (this.#applied.path.length > 0) params.path = this.#applied.path;
		if (cursor !== undefined) params.cursor = cursor;
		return params;
	}

	async fetch_first_page(): Promise<void> {
		// Drop any in-flight pagination — its accumulated cursor refers to
		// the list we're about to replace, so a late next-page result would
		// append stale rows onto the refreshed first page.
		this.next_page.abort();
		const result = await this.first_page.run((signal) =>
			this.#api.fuz_forge_repo_log(this.#build_params(undefined), { signal })
		);
		if (!result) return; // failure or supersession — slot carries error
		this.commits = result.commits;
		this.next_cursor = result.next_cursor;
		this.active_ref = result.ref;
	}

	async load_more(): Promise<void> {
		// Pagination is only valid while the base list is settled; the
		// cursor would be stale by the time we appended otherwise.
		if (this.first_page.loading) return;
		if (this.next_cursor === null) return;
		const cursor = this.next_cursor;
		const result = await this.next_page.run((signal) =>
			this.#api.fuz_forge_repo_log(this.#build_params(cursor), { signal })
		);
		if (!result) return;
		this.commits = [...this.commits, ...result.commits];
		this.next_cursor = result.next_cursor;
	}

	apply_filters(filters: RepoLogFilters): void {
		this.#applied = filters;
		void this.fetch_first_page();
	}
}
