<script lang="ts">
	import { page } from '$app/state';

	import RepoRefs from '#lib/ui/RepoRefs.svelte';

	const id = $derived(page.params.id ?? '');
</script>

<RepoRefs {id} />
