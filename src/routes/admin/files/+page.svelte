<script lang="ts">
	import { onMount } from 'svelte';
	import CopyToClipboard from '@fuzdev/fuz_ui/CopyToClipboard.svelte';
	import { format_relative_time, truncate_middle } from '@fuzdev/fuz_app/ui/ui_format.ts';
	import { format_bytes } from '@fuzdev/fuz_util/bytes.ts';

	import { FilesState } from '#lib/ui/files_state.svelte.ts';

	const files_state = new FilesState();

	onMount(() => {
		void files_state.fetch();
	});
</script>

<svelte:head>
	<title>Files - fuz_forge</title>
</svelte:head>

<div class="p_lg">
	<h1>files</h1>
	<p class="text_50">Server file store. Upload with <code>fuzf file put</code>.</p>

	{#if files_state.list.loading}
		<p class="text_50">Loading files...</p>
	{:else if files_state.list.error}
		<p class="color_c_50">{files_state.list.error}</p>
	{:else if files_state.files.length === 0}
		<p class="text_50">
			No files in the store. Upload with <code>fuzf file put &lt;path&gt;</code>.
		</p>
	{:else}
		<div class="overflow-x:auto mb_flow">
			<table>
				<thead>
					<tr>
						<th>filename</th>
						<th>size</th>
						<th>blake3</th>
						<th>uploaded</th>
					</tr>
				</thead>
				<tbody>
					{#each files_state.files as file (file.filename)}
						<tr>
							<td>
								<!--
									Not a SvelteKit route: the backend serves the file store at the
									origin root, so `resolve()` (which prefixes `base`) would break
									this link the day a base path is configured. `rel="external"`
									says so — and keeps the router's hands off the download.
								-->
								<a
									href="/api/fuz_forge/files/{encodeURIComponent(file.filename)}"
									rel="external"
									download
								>
									<code>{file.filename}</code>
								</a>
							</td>
							<td class="text_50">{format_bytes(file.size_bytes)}</td>
							<td>
								<div class="row">
									<code class="font_size_xs text_50">{truncate_middle(file.blake3_hash, 11)}</code>
									<CopyToClipboard text={file.blake3_hash} class="sized_sm" />
								</div>
							</td>
							<td class="text_50">{format_relative_time(file.uploaded_at)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<p class="mt_sm text_50">
			{files_state.files.length} file{files_state.files.length === 1 ? '' : 's'}
		</p>
	{/if}
</div>
