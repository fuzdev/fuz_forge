<script lang="ts">
	import { page } from '$app/state';

	import RepoCommit from '#lib/ui/RepoCommit.svelte';

	// SvelteKit types route params as `string | undefined`; the SvelteKit
	// router only resolves this page when both `[id]` and `[sha]` matched,
	// so they're always strings at runtime — coerce here rather than
	// threading optionality.
	const id = $derived(page.params.id ?? '');
	const sha = $derived(page.params.sha ?? '');
</script>

<RepoCommit {id} {sha} />
