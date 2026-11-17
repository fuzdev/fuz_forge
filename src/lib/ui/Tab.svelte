<script lang="ts">
	/**
	 * A single tab inside a `<Tabs>` bar. Renders `<a class="tab">` with
	 * `.selected` driven by either an explicit `selected` prop (when the
	 * active tab doesn't map to a pathname-exact match — e.g. a `blob/`
	 * subroute highlighting the parent `tree` tab) or, by default,
	 * exact-match against `page.url.pathname`.
	 *
	 * Not a wrapper over fuz_ui's `MenuLink`. TODO consider wrapping it with
	 * `exact` and `selected`, which also adds `aria-current`.
	 *
	 * Parallel impl note: other apps on fuz_app have a sibling `Tab.svelte`
	 * that inlines its `<a>` the same way. The impls will reconcile when
	 * they lift to `@fuzdev/fuz_ui`; until then keep them in sync API-wise.
	 *
	 * @module
	 */

	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import type { ResolvedPathname } from '$app/types';

	const {
		href,
		selected,
		children
	}: {
		/**
		 * The tab's link, already resolved by the caller — pass the route-ID-plus-params
		 * form of `resolve` from `$app/paths` (`resolve('/admin/repos/[id]/log', {id})`)
		 * so the route id is checked against the app's routes.
		 */
		href: ResolvedPathname;
		/**
		 * Override the auto-derived selected state. Default: exact match
		 * against `page.url.pathname`. Pass an explicit boolean when the
		 * active tab doesn't correspond to a pathname-exact match.
		 */
		selected?: boolean;
		children: Snippet;
	} = $props();

	const is_selected = $derived(selected ?? href === page.url.pathname);
</script>

<!-- href is resolved by the caller; the lint rule only catches inline `resolve()`. -->
<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
<a {href} class="tab" class:selected={is_selected}>
	{@render children()}
</a>
