<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { on } from 'svelte/events';
	import 'virtual:fuz.css';
	import '@fuzdev/fuz_code/theme.css';
	import '#routes/style.css';
	// the plugin never scans `.css` files, so ship the variables `style.css` reads
	// @fuz-variables border_color_30 space_xs space_md ink_10 palette_a_50

	import ThemeRoot from '@fuzdev/fuz_ui/ThemeRoot.svelte';
	import { SiteState, site_context } from '@fuzdev/fuz_ui/site.svelte.ts';
	import AppShell from '@fuzdev/fuz_app/ui/AppShell.svelte';
	import pkg_json from 'virtual:pkg.json';

	import FuzForgeNav from '#lib/ui/FuzForgeNav.svelte';

	const {
		children
	}: {
		children: Snippet;
	} = $props();

	site_context.set(new SiteState({ pkg_json }));

	// Auto-reload on stale-chunk errors. After a deploy, an open SPA's
	// dynamic imports reference chunk URLs whose files no longer exist
	// in the new release — Vite emits `vite:preloadError` and the
	// browser blocks the `<script type="module">` load (404 page is
	// text/html, or partial response → NS_ERROR_CORRUPTED_CONTENT
	// during the daemon restart window).
	//
	// We capture the build version at mount time, then on a preload
	// error poll `/_app/version.json` with backoff until we see a
	// version *change*. Reloading on the same version would just
	// re-load the same broken chunks (e.g. the daemon is unresponsive
	// for a reason unrelated to deploy). On timeout we log and bail
	// rather than reload-blind.
	onMount(() => {
		let reload_scheduled = false;
		const VERSION_URL = '/_app/version.json';
		const MAX_WAIT_MS = 30_000;
		let baseline_version: string | null = null;

		const read_version = async (): Promise<string | null> => {
			try {
				const res = await fetch(VERSION_URL, { cache: 'no-store' });
				if (!res.ok) return null;
				const body = (await res.json()) as { version?: unknown };
				return typeof body.version === 'string' ? body.version : null;
			} catch {
				return null;
			}
		};

		void read_version().then((v) => {
			baseline_version = v;
		});

		const wait_for_new_version = async (): Promise<boolean> => {
			const started = Date.now();
			let delay = 250;
			while (Date.now() - started < MAX_WAIT_MS) {
				const current = await read_version();
				if (current && current !== baseline_version) return true;
				await new Promise((r) => setTimeout(r, delay));
				delay = Math.min(delay * 1.5, 2000);
			}
			return false;
		};

		const handler = (e: Event): void => {
			e.preventDefault();
			if (reload_scheduled) return;
			reload_scheduled = true;
			void wait_for_new_version().then((changed) => {
				if (changed) {
					window.location.reload();
				} else {
					console.warn(
						'[vite:preloadError] version unchanged after',
						MAX_WAIT_MS,
						'ms — not reloading'
					);
					reload_scheduled = false;
				}
			});
		};
		return on(window, 'vite:preloadError', handler);
	});
</script>

<svelte:head>
	<title>fuz_forge</title>
	<meta
		name="description"
		content="a personal-scale forge for self-hosting git repos, signed releases, and files"
	/>
</svelte:head>

<ThemeRoot>
	<AppShell keyboard_shortcut="`">
		{#snippet sidebar()}
			<FuzForgeNav />
		{/snippet}
		{@render children()}
	</AppShell>
</ThemeRoot>
