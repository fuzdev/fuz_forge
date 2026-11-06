<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { AsyncSlot } from '@fuzdev/fuz_app/ui/async_slot.svelte.ts';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import { format_bytes } from '@fuzdev/fuz_util/bytes.ts';

	import type { FuzForgeRepoBlobOutput } from '../action_specs.ts';
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
		path: string;
	} = $props();

	const fuz_forge_app = fuz_forge_app_context.get();
	const { api } = fuz_forge_app;
	const repo_state = repo_page_state_context.get();

	const blob_slot = new AsyncSlot<FuzForgeRepoBlobOutput>();

	const blob = $derived(blob_slot.data);
	// `path` is guaranteed non-empty: the `[...rest]` route refuses to
	// mount `RepoBlob` unless the param carries a path after its `:`.
	const parent_path = $derived(path.split('/').slice(0, -1).join('/'));

	const fetch_blob = (
		target_id: string,
		target_ref: string,
		target_path: string
	): Promise<unknown> =>
		blob_slot.run((signal) =>
			api.fuz_forge_repo_blob({ id: target_id, ref: target_ref, path: target_path }, { signal })
		);

	$effect(() => {
		const a = id;
		const b = ref;
		const c = path;
		untrack(() => void fetch_blob(a, b, c));
	});

	onMount(() => subscribe_to_repo_updates(fuz_forge_app, id, () => void fetch_blob(id, ref, path)));
</script>

<svelte:head>
	<title>{path} — {repo_state.repo?.slug ?? id} @ {ref} - fuz_forge Admin</title>
</svelte:head>

<RepoBrowseNav {id} {ref} {path} kind="blob" />

<div class="row gap_md mb_md" style:align-items="baseline">
	<h2 class="min-width:0" style:margin="0">{path}</h2>
	<a
		href={resolve('/admin/repos/[id]/tree/[...rest]', {
			id,
			rest: ref_path_rest(ref, parent_path)
		})}
		class="font_size_sm"
	>
		↑ parent
	</a>
	{#if blob}
		<code class="font_size_sm text_50" title="blob SHA">{blob.sha.slice(0, 7)}</code>
		<span class="font_size_sm text_50">{format_bytes(blob.size)}</span>
	{/if}
	{#if blob_slot.loading}<PendingAnimation />{/if}
</div>

{#if blob_slot.failed}<p class="color_c_50">{blob_slot.error}</p>{/if}

{#if blob}
	{#if blob.body.kind === 'text'}
		<pre class="panel p_md font_size_sm" style:max-height="80svh">{blob.body.text}</pre>
	{:else if blob.body.kind === 'binary'}
		<div class="panel p_md text_50" style:font-style="italic">
			binary file ({format_bytes(blob.size)}) — preview not available.
		</div>
	{:else if blob.body.kind === 'truncated'}
		<div class="panel p_md">
			<p class="text_50">
				file is {format_bytes(blob.body.size)}, exceeds the 5 MB blob cap. clone the repo and
				inspect by SHA:
			</p>
			<pre class="font_size_sm" style:margin="0">git show {blob.sha}</pre>
		</div>
	{/if}
{/if}
