<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { format_relative_time } from '@fuzdev/fuz_app/ui/ui_format.ts';
	import { AsyncSlot } from '@fuzdev/fuz_app/ui/async_slot.svelte.ts';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import type { FuzForgeRepoRefsOutput } from '../action_specs.ts';
	import { fuz_forge_app_context } from './fuz_forge_app.svelte.ts';
	import { ref_path_rest, ref_short_name } from './repo_ref_paths.ts';
	import { repo_page_state_context } from './repo_page_state.svelte.ts';
	import { subscribe_to_repo_updates } from './repo_subscriptions.ts';

	const fuz_forge_app = fuz_forge_app_context.get();
	const { api } = fuz_forge_app;
	const repo_state = repo_page_state_context.get();

	const { id }: { id: string } = $props();

	const refs_slot = new AsyncSlot<FuzForgeRepoRefsOutput>();

	const data = $derived(refs_slot.data);
	const refs = $derived(data?.refs ?? []);
	const default_branch = $derived(data?.default_branch ?? '');
	const branches = $derived(refs.filter((r) => r.name.startsWith('refs/heads/')));
	const tags = $derived(refs.filter((r) => r.name.startsWith('refs/tags/')));

	const fetch_refs = (target_id: string): Promise<unknown> =>
		refs_slot.run((signal) => api.fuz_forge_repo_refs({ id: target_id }, { signal }));

	$effect(() => {
		const target_id = id;
		untrack(() => void fetch_refs(target_id));
	});

	onMount(() => subscribe_to_repo_updates(fuz_forge_app, id, () => void fetch_refs(id)));
</script>

<svelte:head>
	<title>Refs: {repo_state.repo?.slug ?? id} - fuz_forge Admin</title>
</svelte:head>

<div class="row gap_md mb_md" style:align-items="center">
	<h2 class="flex:1" style:margin="0">Refs</h2>
	<button type="button" class="plain" onclick={() => void fetch_refs(id)} title="refresh">
		refresh
		{#if refs_slot.loading}<PendingAnimation />{/if}
	</button>
</div>

{#if refs_slot.failed}<p class="color_c_50">{refs_slot.error}</p>{/if}

{#if refs_slot.loading && refs.length === 0}
	<p class="text_50"><PendingAnimation /> loading refs…</p>
{:else}
	<section class="mb_lg">
		<h3 class="font_size_md mb_sm">Branches ({branches.length})</h3>
		{#if branches.length === 0}
			<p class="text_50" style:font-style="italic">no branches.</p>
		{:else}
			<ul class="unstyled column gap_xs">
				{#each branches as ref (ref.name)}
					{@const name = ref_short_name(ref.name)}
					<li class="row gap_sm panel p_sm" style:align-items="baseline">
						<a
							class="flex:1 overflow-wrap:anywhere"
							href={resolve('/admin/repos/[id]/tree/[...rest]', {
								id,
								rest: ref_path_rest(name, '')
							})}
						>
							{name}
						</a>
						{#if name === default_branch}<span class="chip">default</span>{/if}
						<code class="font_size_sm text_50">{ref.sha.slice(0, 7)}</code>
						{#if ref.committer_date}
							<time
								class="font_size_sm text_50"
								datetime={ref.committer_date}
								title={ref.committer_date}
							>
								{format_relative_time(ref.committer_date)}
							</time>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section>
		<h3 class="font_size_md mb_sm">Tags ({tags.length})</h3>
		{#if tags.length === 0}
			<p class="text_50" style:font-style="italic">no tags.</p>
		{:else}
			<ul class="unstyled column gap_xs">
				{#each tags as ref (ref.name)}
					{@const name = ref_short_name(ref.name)}
					{@const target = ref.target_sha || ref.sha}
					<li class="row gap_sm panel p_sm" style:align-items="baseline">
						<a
							class="flex:1 overflow-wrap:anywhere"
							href={resolve('/admin/repos/[id]/tree/[...rest]', {
								id,
								rest: ref_path_rest(name, '')
							})}
						>
							{name}
						</a>
						{#if ref.object_type === 'tag'}<span class="chip">annotated</span>{/if}
						<code class="font_size_sm text_50">{target.slice(0, 7)}</code>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}
