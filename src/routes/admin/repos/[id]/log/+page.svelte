<script lang="ts">
	import { page } from '$app/state';

	import RepoLog from '#lib/ui/RepoLog.svelte';

	const id = $derived(page.params.id ?? '');
</script>

<RepoLog {id} />
