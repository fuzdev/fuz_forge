<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { format_value } from '@fuzdev/fuz_app/ui/ui_format.ts';
	import { TableState } from '@fuzdev/fuz_app/ui/table_state.svelte.ts';
	import ConfirmButton from '@fuzdev/fuz_app/ui/ConfirmButton.svelte';

	const { params }: { params: { table: string } } = $props();

	const table_state = new TableState();

	$effect(() => {
		// Track params.table - re-run when navigating between tables
		const table_name = params.table;

		// Read URL params without creating dependency (avoid re-fetch on URL update)
		untrack(() => {
			const url_offset = page.url.searchParams.get('offset');
			const url_limit = page.url.searchParams.get('limit');
			const offset = url_offset ? parseInt(url_offset, 10) || 0 : 0;
			const limit = url_limit ? Math.min(1000, parseInt(url_limit, 10) || 100) : 100;
			void table_state.fetch(table_name, offset, limit);
		});
	});

	function update_url(): void {
		const url = new URL(page.url.href);
		url.searchParams.set('offset', String(table_state.offset));
		url.searchParams.set('limit', String(table_state.limit));
		const resolved = resolve('/admin/db/[table]', { table: params.table });
		void goto(resolved + url.search, { replace: true, reset: false });
	}

	function go_prev(): void {
		table_state.go_prev();
		update_url();
		void table_state.fetch(params.table, table_state.offset, table_state.limit);
	}

	function go_next(): void {
		table_state.go_next();
		update_url();
		void table_state.fetch(params.table, table_state.offset, table_state.limit);
	}

	async function handle_delete(row: Record<string, unknown>): Promise<void> {
		await table_state.delete_row(row);
	}
</script>

<svelte:head>
	<title>{params.table} - Database - fuz_forge</title>
</svelte:head>

{#snippet pagination()}
	<div class="row gap_sm">
		<span class="font_size_sm text_50">
			{table_state.showing_start}-{table_state.showing_end} of {table_state.total}
		</span>
		<button type="button" disabled={!table_state.has_prev} onclick={go_prev}>prev</button>
		<button type="button" disabled={!table_state.has_next} onclick={go_next}>next</button>
	</div>
{/snippet}

<h1>{params.table}</h1>

{#if table_state.list.loading}
	<p class="text_50">Loading...</p>
{:else if table_state.list.error}
	<p class="color_c_50">{table_state.list.error}</p>
{:else}
	<section class="mb_lg">
		<h2>Schema ({table_state.columns.length} columns)</h2>
		<table class="font_size_sm">
			<thead>
				<tr>
					<th>Column</th>
					<th>Type</th>
					<th>Nullable</th>
				</tr>
			</thead>
			<tbody>
				{#each table_state.columns as col (col.column_name)}
					<tr>
						<td><code>{col.column_name}</code></td>
						<td>{col.data_type}</td>
						<td>{col.is_nullable === 'YES' ? 'yes' : 'no'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>

	<section>
		<div class="row mb_sm">
			<h2 class="flex:1 mt_0">Data ({table_state.total} rows)</h2>
			{#if table_state.total > 0}
				{@render pagination()}
			{/if}
		</div>
		{#if table_state.delete_error}
			<p class="color_c_50 mb_sm">{table_state.delete_error}</p>
		{/if}
		{#if table_state.rows.length === 0}
			<p class="text_50">No rows.</p>
		{:else}
			<div style:overflow-x="auto" style:max-height="600px" style:overflow-y="auto">
				<table class="font_size_xs font_family_mono">
					<thead>
						<tr>
							{#if table_state.primary_key}
								<th style:width="40px"></th>
							{/if}
							{#each table_state.columns as col (col.column_name)}
								<th>{col.column_name}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each table_state.rows as row, i (i)}
							<tr>
								{#if table_state.primary_key}
									{@const pk_str = format_value(row[table_state.primary_key])}
									<td style:text-align="center">
										<ConfirmButton
											onconfirm={() => handle_delete(row)}
											disabled={table_state.deleting === pk_str}
											title="delete row"
										>
											{table_state.deleting === pk_str ? '...' : '×'}
										</ConfirmButton>
									</td>
								{/if}
								{#each table_state.columns as col (col.column_name)}
									<td class="ellipsis" style:max-width="300px">
										{format_value(row[col.column_name])}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		{#if table_state.total > table_state.limit}
			<div class="mt_sm justify-content:center">
				{@render pagination()}
			</div>
		{/if}
	</section>
{/if}
