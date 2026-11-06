<script lang="ts">
	import { page } from '$app/state';

	import RepoDetail from '#lib/ui/RepoDetail.svelte';

	// SvelteKit types route params as `string | undefined`; the SvelteKit
	// router only resolves this page when `[id]` matched, so `id` is always
	// a string at runtime — coerce here rather than threading optionality.
	const id = $derived(page.params.id ?? '');
</script>

<RepoDetail {id} />
