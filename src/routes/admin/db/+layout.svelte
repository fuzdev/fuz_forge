<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import ColumnLayout from '@fuzdev/fuz_app/ui/ColumnLayout.svelte';
	import MenuLink from '@fuzdev/fuz_app/ui/MenuLink.svelte';

	import { DbTablesState } from '#lib/ui/db_tables_state.svelte.ts';

	const { children }: { children: Snippet } = $props();

	const tables_state = new DbTablesState();

	onMount(() => {
		void tables_state.fetch();
	});
</script>

<ColumnLayout toggle_label="tables">
	{#snippet aside()}
		<nav aria-label="tables">
			<MenuLink path="/admin/db" class="menuitem flex:1 font_size_lg">tables</MenuLink>
			<button type="button" class="plain" onclick={() => tables_state.fetch()} title="refresh">
				refresh
				{#if tables_state.list.loading}<PendingAnimation />{/if}
			</button>
			{#if tables_state.list.error}
				<p class="color_c_50">{tables_state.list.error}</p>
			{:else if tables_state.tables.length === 0}
				<p class="text_50">No tables found.</p>
			{:else}
				<div class="column">
					{#each tables_state.tables as table (table.name)}
						<MenuLink path={`/admin/db/${table.name}`} class="menuitem">
							{table.name}
							<span class="font_size_sm text_50">({table.row_count})</span>
						</MenuLink>
					{/each}
				</div>
			{/if}
		</nav>
	{/snippet}
	<div class="p_lg">
		{@render children()}
	</div>
</ColumnLayout>
