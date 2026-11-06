<script lang="ts">
	import { onMount, untrack, type Snippet } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import { fuz_forge_app_context } from '#lib/ui/fuz_forge_app.svelte.ts';
	import { RepoPageState, repo_page_state_context } from '#lib/ui/repo_page_state.svelte.ts';
	import RepoTabs from '#lib/ui/RepoTabs.svelte';

	const { children }: { children: Snippet } = $props();

	const fuz_forge_app = fuz_forge_app_context.get();
	const repo_state = repo_page_state_context.set(new RepoPageState({ fuz_forge_app }));

	const id = $derived(page.params.id ?? '');

	// Selected tab follows the route. Anything under `tree/` or `blob/`
	// is "tree" (blobs are sub-views of the tree); commit pages roll up
	// under "log".
	const selected = $derived.by(() => {
		const pathname = page.url.pathname;
		const base = `/admin/repos/${id}`;
		const rest = pathname.startsWith(base) ? pathname.slice(base.length) : '';
		if (rest === '' || rest === '/') return 'repo' as const;
		if (rest.startsWith('/refs')) return 'refs' as const;
		if (rest.startsWith('/tree')) return 'tree' as const;
		if (rest.startsWith('/blob')) return 'tree' as const;
		if (rest.startsWith('/log')) return 'log' as const;
		if (rest.startsWith('/c/')) return 'log' as const;
		return 'repo' as const;
	});

	$effect(() => {
		const target_id = id;
		untrack(() => {
			repo_state.set_id(target_id);
			void repo_state.fetch();
		});
	});

	onMount(() =>
		fuz_forge_app.on_notification('fuz_forge_repo_updated', (input) => {
			if (input.repo_id === repo_state.id) void repo_state.fetch();
		})
	);
</script>

<div class="p_lg">
	<nav class="row gap_sm font_size_sm text_50 mb_sm" aria-label="Breadcrumb">
		<a href={resolve('/admin/repos')}>repos</a>
		<span>/</span>
		<a href={resolve('/admin/repos/[id]', { id })}>{repo_state.repo?.slug ?? id}</a>
	</nav>

	{#if repo_state.error}
		<p class="color_c_50">{repo_state.error}</p>
	{/if}

	{#if repo_state.repo}
		<div class="row gap_md mb_md" style:align-items="center">
			<h1 class="flex:1 min-width:0" style:margin="0">{repo_state.repo.slug}</h1>
			<span class="chip">{repo_state.repo.default_branch}</span>
			<button
				type="button"
				class="plain"
				onclick={() => void repo_state.fetch()}
				title="refresh repo metadata"
			>
				refresh
				{#if repo_state.loading}<PendingAnimation />{/if}
			</button>
		</div>

		<RepoTabs {id} default_branch={repo_state.repo.default_branch} {selected} />
	{:else if repo_state.loading}
		<p class="text_50"><PendingAnimation /> loading repo…</p>
	{/if}

	{@render children()}
</div>
