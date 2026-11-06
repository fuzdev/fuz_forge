<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Library, library_context } from '@fuzdev/fuz_ui/library.svelte.ts';

	import { library_json } from '#routes/library.ts';

	const { children }: { children: Snippet } = $props();

	const library = new Library(library_json);
	library_context.set(() => library);
</script>

{@render children()}
