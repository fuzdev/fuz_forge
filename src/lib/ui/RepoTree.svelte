<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { AsyncSlot } from '@fuzdev/fuz_app/ui/async_slot.svelte.ts';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import { format_bytes } from '@fuzdev/fuz_util/bytes.ts';

	import type { FuzForgeRepoTreeOutput } from '../action_specs.ts';
	import { fuz_forge_app_context } from './fuz_forge_app.svelte.ts';
	import { ref_path_rest } from './repo_ref_paths.ts';
	import RepoBrowseNav from './RepoBrowseNav.svelte';
	import { repo_page_state_context } from './repo_page_state.svelte.ts';
	import { subscribe_to_repo_updates } from './repo_subscriptions.ts';

	const {
		id,
		ref,
		path
	}: {
		id: string;
		ref: string;
		/** Path within the tree — empty string for the root. */
		path: string;
	} = $props();

	const fuz_forge_app = fuz_forge_app_context.get();
	const { api } = fuz_forge_app;
	const repo_state = repo_page_state_context.get();

	const tree_slot = new AsyncSlot<FuzForgeRepoTreeOutput>();

	const entries = $derived(tree_slot.data?.entries ?? []);
	const resolved_sha = $derived(tree_slot.data?.resolved_sha ?? '');

	const segments = $derived(path === '' ? [] : path.split('/'));
	const parent_path = $derived(segments.slice(0, -1).join('/'));
	const has_parent = $derived(segments.length > 0);

	const format_size = (size: string): string => {
		if (size === '-') return '';
		const n = Number.parseInt(size, 10);
		return Number.isFinite(n) ? format_bytes(n) : size;
	};

	const entry_icon = (type: string): string => {
		if (type === 'tree') return '📁';
		if (type === 'commit') return '🔗'; // submodule
		return '📄';
	};

	// `git ls-tree` modes for blobs: 100644 = regular, 100755 = executable,
	// 120000 = symlink. Chips surface the distinction that the bare icon
	// can't.
	const mode_chip = (mode: string, type: string): string | null => {
		if (type !== 'blob') return null;
		if (mode === '100755') return 'exec';
		if (mode === '120000') return 'link';
		return null;
	};

	const fetch_tree = (
		target_id: string,
		target_ref: string,
		target_path: string
	): Promise<unknown> =>
		tree_slot.run((signal) =>
			api.fuz_forge_repo_tree({ id: target_id, ref: target_ref, path: target_path }, { signal })
		);

	$effect(() => {
		const a = id;
		const b = ref;
		const c = path;
		untrack(() => void fetch_tree(a, b, c));
	});

	onMount(() => subscribe_to_repo_updates(fuz_forge_app, id, () => void fetch_tree(id, ref, path)));

	// `git ls-tree` doesn't guarantee a sort order; surface trees-first +
	// alpha-by-name like every other forge UI for readability.
	const sorted = $derived(
		[...entries].sort((a, b) => {
			const tree_diff = (b.type === 'tree' ? 1 : 0) - (a.type === 'tree' ? 1 : 0);
			if (tree_diff !== 0) return tree_diff;
			return a.name.localeCompare(b.name);
		})
	);
</script>

<svelte:head>
	<title>{path ? `${path} — ` : ''}{repo_state.repo?.slug ?? id} @ {ref} - fuz_forge Admin</title>
</svelte:head>

<RepoBrowseNav {id} {ref} {path} kind="tree" />

<div class="row gap_md mb_md" style:align-items="baseline">
	<h2 class="min-width:0" style:margin="0">{path === '' ? '/' : path}</h2>
	{#if resolved_sha}
		<a
			href={resolve('/admin/repos/[id]/c/[sha]', { id, sha: resolved_sha })}
			class="chip font_size_sm"
			title="view commit at this tree"
		>
			{resolved_sha.slice(0, 7)}
		</a>
	{/if}
	{#if tree_slot.loading}<PendingAnimation />{/if}
</div>

{#if tree_slot.failed}<p class="color_c_50">{tree_slot.error}</p>{/if}

{#if !tree_slot.loading && entries.length === 0 && !tree_slot.failed}
	<p class="text_50" style:font-style="italic">empty tree.</p>
{:else}
	<ul class="unstyled">
		{#if has_parent}
			<li class="row gap_sm p_sm tree-row">
				<span>📁</span>
				<a
					class="flex:1"
					href={resolve('/admin/repos/[id]/tree/[...rest]', {
						id,
						rest: ref_path_rest(ref, parent_path)
					})}
				>
					..
				</a>
			</li>
		{/if}
		{#each sorted as entry (entry.name)}
			{@const child_path = path === '' ? entry.name : `${path}/${entry.name}`}
			{@const chip = mode_chip(entry.mode, entry.type)}
			<li class="row gap_sm p_sm tree-row">
				<span>{entry_icon(entry.type)}</span>
				{#if entry.type === 'tree'}
					<a
						class="flex:1 overflow-wrap:anywhere"
						href={resolve('/admin/repos/[id]/tree/[...rest]', {
							id,
							rest: ref_path_rest(ref, child_path)
						})}
					>
						{entry.name}
					</a>
				{:else}
					<a
						class="flex:1 overflow-wrap:anywhere"
						href={resolve('/admin/repos/[id]/blob/[...rest]', {
							id,
							rest: ref_path_rest(ref, child_path)
						})}
					>
						{entry.name}
					</a>
				{/if}
				{#if chip}<span class="chip font_size_sm">{chip}</span>{/if}
				{#if entry.type === 'commit'}
					<code class="font_size_sm text_50">{entry.sha.slice(0, 7)}</code>
				{/if}
				<span class="font_size_sm text_50">{format_size(entry.size)}</span>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.tree-row {
		border-bottom: 1px solid var(--border_color_30);
	}
</style>
