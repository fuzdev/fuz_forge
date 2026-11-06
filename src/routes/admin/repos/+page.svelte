<script lang="ts">
	import { onMount } from 'svelte';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import RepoList from '#lib/ui/RepoList.svelte';
	import { ReposState } from '#lib/ui/repos_state.svelte.ts';
	import { fuz_forge_app_context } from '#lib/ui/fuz_forge_app.svelte.ts';

	const fuz_forge_app = fuz_forge_app_context.get();
	const repos_state = new ReposState(fuz_forge_app.api);

	// `window.location.origin` is only safe to read after mount (SSR-tolerant).
	// Empty default renders `/<slug>.git` which is also a valid clone URL on
	// the same host, so even a missed hydration paint stays clickable.
	let clone_url_origin = $state('');

	onMount(() => {
		clone_url_origin = window.location.origin;
		void repos_state.fetch();
		return fuz_forge_app.on_notification('fuz_forge_repo_updated', () => void repos_state.fetch());
	});
</script>

<svelte:head>
	<title>Repos - fuz_forge Admin</title>
</svelte:head>

<div class="p_lg">
	<div class="row gap_md mb_md" style:align-items="center">
		<h1 class="flex:1" style:margin="0">Repos</h1>
		<button type="button" class="plain" onclick={() => repos_state.fetch()} title="refresh">
			refresh
			{#if repos_state.list.loading}<PendingAnimation />{/if}
		</button>
	</div>
	<p class="text_50 mb_md">
		Forge-hosted git repositories. Push over HTTPS with an API token; the admin sees every push live
		via the <code>fuz_forge_repo_updated</code> broadcast.
	</p>
	{#if repos_state.list.error}
		<p class="color_c_50">{repos_state.list.error}</p>
	{:else}
		<RepoList repos={repos_state.repos} {clone_url_origin} />
	{/if}
</div>
