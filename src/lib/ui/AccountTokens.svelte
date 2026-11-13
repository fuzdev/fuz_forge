<script lang="ts">
	import { format_relative_time } from '@fuzdev/fuz_app/ui/ui_format.ts';
	import CopyToClipboard from '@fuzdev/fuz_ui/CopyToClipboard.svelte';

	import { AccountTokensState } from './account_tokens_state.svelte.ts';
	import { fuz_forge_app_context } from './fuz_forge_app.svelte.ts';
	import AccountTokenTemplate from './AccountTokenTemplate.svelte';
	import type { FuzForgeTokenTemplateInput } from '../action_specs.ts';

	const { api } = fuz_forge_app_context.get();

	const tokens_state = new AccountTokensState({ api });

	void tokens_state.fetch();

	let token_name = $state.raw('CLI token');
	let template = $state.raw<FuzForgeTokenTemplateInput>({ kind: 'admin' });

	const template_invalid = $derived.by(() => {
		switch (template.kind) {
			case 'admin':
				return false;
			case 'forge_push':
			case 'forge_pull':
				return template.repo_ids.length === 0;
			case 'files_read':
			case 'files_write':
			case 'files_read_write':
				return template.filenames !== '*' && template.filenames.length === 0;
			case 'rpc_subset':
				return template.methods.length === 0;
		}
	});

	const handle_create = async (): Promise<void> => {
		const ok = await tokens_state.submit_create({ name: token_name, template });
		if (ok) {
			token_name = 'CLI token';
			template = { kind: 'admin' };
		}
	};

	const save_command = $derived(
		tokens_state.created_token
			? `mkdir -p ~/.fuz_forge && echo "${tokens_state.created_token}" > ~/.fuz_forge/api_token && chmod 600 ~/.fuz_forge/api_token`
			: null
	);

	/** Convert `tok_<base64url>` ID to a display hint like `secret_fuz_token_<base64url>...` */
	const format_token_hint = (id: string): string => `secret_fuz_token_${id.slice(4)}...`;
</script>

<section>
	<h2>
		API tokens
		{#if tokens_state.count > 0}
			<span class="chip palette_a">{tokens_state.count}</span>
		{/if}
	</h2>

	{#if tokens_state.created_token}
		<aside class="panel p_md mb_md column gap_sm">
			<p class="mb_0">
				<strong>token created</strong>
				{#if tokens_state.created_template && tokens_state.created_template !== 'admin'}
					— <span class="chip palette_b">{tokens_state.created_template}</span>
				{/if}
				— copy it now, it won't be shown again
			</p>
			<code class="p_sm" style:word-break="break-all" style:user-select="all">
				{tokens_state.created_token}
			</code>
			<div class="row gap_sm">
				<CopyToClipboard text={tokens_state.created_token} icon_button={false}>
					{#snippet children(copied)}
						{copied ? 'copied' : 'copy token'}
					{/snippet}
				</CopyToClipboard>
				<CopyToClipboard text={save_command} icon_button={false}>
					{#snippet children(copied)}
						{copied ? 'copied' : 'copy save command'}
					{/snippet}
				</CopyToClipboard>
				<button type="button" class="text_50" onclick={() => (tokens_state.created_token = null)}>
					dismiss
				</button>
			</div>
			<p class="font_size_sm text_50">
				save command writes to <code>~/.fuz_forge/api_token</code> with mode 600
			</p>
		</aside>
	{/if}

	<form
		class="column gap_sm mb_md"
		onsubmit={(e) => {
			e.preventDefault();
			void handle_create();
		}}
	>
		<input type="text" bind:value={token_name} placeholder="token name" />
		<AccountTokenTemplate
			bind:template
			disabled={tokens_state.list.loading || tokens_state.create.loading}
		/>
		<button
			type="submit"
			disabled={tokens_state.list.loading ||
				tokens_state.create.loading ||
				!token_name.trim() ||
				template_invalid}
		>
			{tokens_state.create.loading ? 'creating…' : 'create'}
		</button>
	</form>

	{#if tokens_state.create.error}
		<p class="color_c_50">{tokens_state.create.error}</p>
	{/if}

	{#if tokens_state.list.loading}
		<p class="text_50">loading tokens...</p>
	{:else if tokens_state.list.error}
		<p class="color_c_50">{tokens_state.list.error}</p>
	{:else if tokens_state.tokens.length === 0}
		<p class="text_50">no API tokens</p>
	{:else}
		<div class="column gap_xs">
			{#each tokens_state.tokens as token (token.id)}
				{@const tpl = tokens_state.template_for(token.id)}
				<div class="row gap_sm" style:align-items="center">
					<code class="font_size_sm text_50">{format_token_hint(token.id)}</code>
					<strong class="flex:1">{token.name}</strong>
					<span
						class="chip {tpl === 'admin' ? 'palette_a' : 'palette_b'} font_size_sm"
						title="scope"
					>
						{tpl}
					</span>
					{#if token.last_used_at}
						<span class="font_size_sm text_50" title="last used">
							used {format_relative_time(token.last_used_at)}
						</span>
					{:else}
						<span class="font_size_sm text_50">never used</span>
					{/if}
					<span class="font_size_sm text_50">
						{format_relative_time(token.created_at)}
					</span>
					<button
						type="button"
						disabled={tokens_state.revoke.loading(token.id)}
						onclick={() => tokens_state.submit_revoke(token.id)}
					>
						{tokens_state.revoke.loading(token.id) ? 'revoking…' : 'revoke'}
					</button>
					{#if tokens_state.revoke.error(token.id)}
						<span class="color_c_50 font_size_sm">{tokens_state.revoke.error(token.id)}</span>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</section>
