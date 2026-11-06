<script lang="ts">
	import CopyToClipboard from '@fuzdev/fuz_ui/CopyToClipboard.svelte';

	const { url }: { url: string } = $props();
</script>

<div class="row gap_sm" style:align-items="center">
	<code class="font_size_sm flex:1" style:word-break="break-all">{url}</code>
	<CopyToClipboard text={url} icon_button={false}>
		{#snippet children(copied)}
			{copied ? 'copied' : 'copy clone URL'}
		{/snippet}
	</CopyToClipboard>
</div>
