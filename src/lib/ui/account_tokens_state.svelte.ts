/**
 * Reactive state for managing API tokens on the account page.
 *
 * Uses the typed throwing RPC client (`account_token_*` actions for
 * unscoped tokens, plus `fuz_forge_token_create_scoped` and
 * `fuz_forge_token_policy_list` for scoped templates).
 *
 * Slots:
 * - `list` — fetch + post-mutation refresh (joins fuz_app's token list
 *   with fuz_forge's per-token policy templates so each row knows its scope).
 * - `create` — single slot covers both unscoped + scoped creation; the
 *   shape diverges only at the API call site.
 * - `revoke` — `KeyedAsyncSlot<token_id>` so concurrent clicks supersede
 *   on the right row and failures surface against the right token.
 *
 * `templates` is a per-token-id template-name map built from the fuz_forge
 * policy list; absent ids are unscoped (admin) by convention.
 *
 * @module
 */

import { AsyncSlot } from '@fuzdev/fuz_app/ui/async_slot.svelte.ts';
import { KeyedAsyncSlot } from '@fuzdev/fuz_app/ui/keyed_async_slot.svelte.ts';
import type { ClientApiTokenJson } from '@fuzdev/fuz_app/auth/account_schema.ts';
import type { ThrowingApi } from '@fuzdev/fuz_app/actions/rpc_client.ts';

import type { FrontendActionsApi } from '../action_metatypes.ts';
import type { FuzForgeTokenTemplateInput } from '../action_specs.ts';

export interface AccountTokensStateOptions {
	api: ThrowingApi<FrontendActionsApi>;
}

export class AccountTokensState {
	#api: ThrowingApi<FrontendActionsApi>;

	readonly list = new AsyncSlot<void>();
	readonly create = new AsyncSlot<void>();
	readonly revoke = new KeyedAsyncSlot<string, void>();

	tokens: Array<ClientApiTokenJson> = $state.raw([]);

	/** Map of `api_token.id` → template name for scoped tokens. */
	templates: Record<string, string> = $state.raw({});

	/** Raw token string shown once after creation. */
	created_token: string | null = $state.raw(null);

	/** Template name of the just-created token (for the success aside). */
	created_template: string | null = $state.raw(null);

	readonly count = $derived(this.tokens.length);

	constructor(options: AccountTokensStateOptions) {
		this.#api = options.api;
	}

	template_for(token_id: string): string {
		return this.templates[token_id] ?? 'admin';
	}

	async fetch(): Promise<void> {
		await this.list.run(async () => {
			const [tokens_result, policies_result] = await Promise.all([
				this.#api.account_token_list(),
				this.#api.fuz_forge_token_policy_list({})
			]);
			this.tokens = tokens_result.tokens;
			const next: Record<string, string> = {};
			for (const row of policies_result.policies) next[row.api_token_id] = row.template;
			this.templates = next;
		});
	}

	async submit_create(input: {
		name: string;
		template: FuzForgeTokenTemplateInput;
	}): Promise<boolean> {
		this.created_token = null;
		this.created_template = null;
		let succeeded = false as boolean;
		await this.create.run(async () => {
			if (input.template.kind === 'admin') {
				// Full-authority path — fuz_app's account_token_create. Skips the
				// fuz_forge transactional pair so a deployment without fuz_forge
				// migrations applied still works for the admin-only case. `full` is
				// what the `admin` template means, and it must be spelled: the spine
				// has no permissive default, which is the whole point of scoping.
				const result = await this.#api.account_token_create({
					name: input.name,
					scope: { kind: 'full' },
					// TODO expose a ttl picker in the mint form; eternal is the
					// pre-lifetime behavior, now spelled explicitly
					lifetime: { kind: 'eternal' }
				});
				this.created_token = result.token;
				this.created_template = 'admin';
			} else {
				const result = await this.#api.fuz_forge_token_create_scoped({
					name: input.name,
					template: input.template,
					lifetime: { kind: 'eternal' }
				});
				this.created_token = result.token;
				this.created_template = result.template;
			}
			succeeded = true;
		});
		if (succeeded) await this.fetch();
		return succeeded;
	}

	async submit_revoke(id: string): Promise<void> {
		const result = await this.revoke.run(id, async () => {
			await this.#api.account_token_revoke({ token_id: id });
		});
		if (result !== undefined) await this.fetch();
	}
}
