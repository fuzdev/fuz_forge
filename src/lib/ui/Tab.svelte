<script lang="ts">
	/**
	 * One tab in a `Tabs` bar: fuz_ui's `MenuLink` as an `<a class="tab">`,
	 * marked `.selected` by the caller's `selected` when given (a `blob/`
	 * subroute lights the parent `tree` tab), else on an exact match of its
	 * own page. Its own page carries `aria-current="page"` either way.
	 *
	 * @module
	 */

	import type { Snippet } from 'svelte';
	import MenuLink from '@fuzdev/fuz_ui/MenuLink.svelte';
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
		 * Override the derived selected state. Default: an exact match of
		 * the tab's own page. Pass an explicit boolean when the active tab
		 * doesn't correspond to a pathname-exact match.
		 */
		selected?: boolean;
		children: Snippet;
	} = $props();
</script>

<MenuLink {href} exact {selected} class="tab">
	{@render children()}
</MenuLink>
