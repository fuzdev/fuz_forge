<script lang="ts">
	import { page } from '$app/state';

	import RepoTree from '#lib/ui/RepoTree.svelte';
	import { split_ref_path } from '#lib/ui/repo_ref_paths.ts';

	const id = $derived(page.params.id ?? '');
	const split = $derived(split_ref_path(page.params.rest ?? ''));
</script>

{#if split.ref === ''}
	<p class="p_lg color_c_50">missing ref in URL</p>
{:else}
	<RepoTree {id} ref={split.ref} path={split.path} />
{/if}
