<script lang="ts">
	/**
	 * Route-driven tab bar. Renders a horizontal `<nav>` around a snippet
	 * of `<Tab>` children. Styling lives in `src/routes/style.css` (the
	 * `.tabs` / `.tab` / `.tab.selected` rules).
	 *
	 * Deliberately not `role="tablist"`: ARIA tabs imply in-page state
	 * switching; here each tab is a real route. Plain `<nav>` + `<a>`
	 * semantics match the actual interaction.
	 *
	 * @module
	 */

	import type { Snippet } from 'svelte';

	const { children, label }: { children: Snippet; label?: string } = $props();
</script>

<nav class="tabs mb_md" aria-label={label}>
	{@render children()}
</nav>
