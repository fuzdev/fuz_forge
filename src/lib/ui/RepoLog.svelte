<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import CommitListItem from './CommitListItem.svelte';
	import { fuz_forge_app_context } from './fuz_forge_app.svelte.ts';
	import { repo_page_state_context } from './repo_page_state.svelte.ts';
	import { subscribe_to_repo_updates } from './repo_subscriptions.ts';
	import { RepoLogState } from './repo_log_state.svelte.ts';

	const fuz_forge_app = fuz_forge_app_context.get();
	const { api } = fuz_forge_app;
	const repo_state = repo_page_state_context.get();

	const { id }: { id: string } = $props();

	const repo = $derived(repo_state.repo);

	const log_state = new RepoLogState({ api });

	// Filter form bindings — UI-only state. Committed values flow into
	// `log_state.apply_filters()` on submit.
	let ref_input = $state('');
	let author_input = $state('');
	let since_input = $state('');
	let path_input = $state('');

	const apply_filters = (): void => {
		log_state.apply_filters({
			ref: ref_input.trim(),
			author: author_input.trim(),
			since: since_input.trim(),
			path: path_input.trim()
		});
	};

	$effect(() => {
		const target_id = id;
		untrack(() => {
			log_state.set_id(target_id);
			void log_state.fetch_first_page();
		});
	});

	onMount(() =>
		subscribe_to_repo_updates(fuz_forge_app, id, () => void log_state.fetch_first_page())
	);
</script>

<svelte:head>
	<title>Log: {repo?.slug ?? id} - fuz_forge Admin</title>
</svelte:head>

<div class="row gap_md mb_md" style:align-items="center">
	<h2 class="flex:1" style:margin="0">
		Log
		{#if log_state.active_ref}<span class="chip">{log_state.active_ref}</span>{/if}
	</h2>
	<button
		type="button"
		class="plain"
		onclick={() => void log_state.fetch_first_page()}
		title="refresh"
	>
		refresh
		{#if log_state.first_page.loading || log_state.next_page.loading}<PendingAnimation />{/if}
	</button>
</div>

<form
	class="panel p_md mb_md column gap_sm"
	onsubmit={(e) => {
		e.preventDefault();
		apply_filters();
	}}
>
	<div
		class="grid gap_sm align-items:center --flow_margin:0"
		style:grid-template-columns="max-content 1fr"
	>
		<label for="ref" class="text_50">ref</label>
		<input
			id="ref"
			type="text"
			bind:value={ref_input}
			placeholder={repo?.default_branch ?? 'main'}
		/>

		<label for="author" class="text_50">author</label>
		<input
			id="author"
			type="text"
			bind:value={author_input}
			placeholder="alice (matched as regex)"
		/>

		<label for="since" class="text_50">since</label>
		<input
			id="since"
			type="text"
			bind:value={since_input}
			placeholder="2026-01-01 or '2 weeks ago'"
		/>

		<label for="path" class="text_50">path</label>
		<input id="path" type="text" bind:value={path_input} placeholder="src/lib/server/git" />
	</div>
	<div class="row gap_sm">
		<button type="submit" class="palette_a">Apply filters</button>
		<button
			type="button"
			class="plain"
			onclick={() => {
				ref_input = '';
				author_input = '';
				since_input = '';
				path_input = '';
				apply_filters();
			}}
		>
			Reset
		</button>
	</div>
</form>

{#if log_state.first_page.failed}
	<p class="color_c_50">{log_state.first_page.error}</p>
{:else if log_state.next_page.failed}
	<p class="color_c_50">{log_state.next_page.error}</p>
{/if}

{#if log_state.first_page.loading && log_state.commits.length === 0}
	<p class="text_50"><PendingAnimation /> loading commits…</p>
{:else if log_state.commits.length === 0}
	<p class="text_50" style:font-style="italic">
		{repo && !repo.head_sha
			? 'no commits yet — push to see history.'
			: 'no commits match the current filters.'}
	</p>
{:else}
	<ul class="unstyled column gap_xs">
		{#each log_state.commits as commit (commit.sha)}
			<CommitListItem {commit} repo_id={id} />
		{/each}
	</ul>

	<div class="row gap_sm mt_md" style:justify-content="center">
		{#if log_state.next_cursor !== null}
			<button
				type="button"
				onclick={() => void log_state.load_more()}
				disabled={log_state.next_page.loading}
			>
				{#if log_state.next_page.loading}<PendingAnimation /> loading…{:else}Load more{/if}
			</button>
		{:else}
			<span class="text_50 font_size_sm" style:font-style="italic">
				end of history ({log_state.commits.length} commit{log_state.commits.length === 1 ? '' : 's'}
				shown)
			</span>
		{/if}
	</div>
{/if}
