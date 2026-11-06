<script lang="ts">
	import { page } from '$app/state';

	import RepoBlob from '#lib/ui/RepoBlob.svelte';
	import { split_ref_path } from '#lib/ui/repo_ref_paths.ts';

	const id = $derived(page.params.id ?? '');
	const split = $derived(split_ref_path(page.params.rest ?? ''));
</script>

{#if split.ref === '' || split.path === ''}
	<p class="p_lg color_c_50">missing ref or path in URL</p>
{:else}
	<RepoBlob {id} ref={split.ref} path={split.path} />
{/if}
