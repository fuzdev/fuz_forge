/**
 * Reactive state for the forge-hosted repo list: a one-shot fetch via the
 * typed RPC client. Callers subscribe to the `fuz_forge_repo_updated`
 * broadcast at the component layer to re-fetch on every push.
 *
 * @module
 */

import { AsyncSlot } from '@fuzdev/fuz_app/ui/async_slot.svelte.ts';
import type { ThrowingApi } from '@fuzdev/fuz_app/actions/rpc_client.ts';

import type { FuzForgeRepoOutput } from '../action_specs.ts';
import type { FrontendActionsApi } from '../action_metatypes.ts';

export class ReposState {
	readonly #api: ThrowingApi<FrontendActionsApi>;

	readonly list = new AsyncSlot<void>();

	repos: Array<FuzForgeRepoOutput> = $state.raw([]);

	constructor(api: ThrowingApi<FrontendActionsApi>) {
		this.#api = api;
	}

	async fetch(): Promise<void> {
		await this.list.run(async () => {
			const { repos } = await this.#api.fuz_forge_repo_list();
			this.repos = repos;
		});
	}
}
