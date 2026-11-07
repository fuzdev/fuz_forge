<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { AsyncSlot } from '@fuzdev/fuz_app/ui/async_slot.svelte.ts';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import type { FuzForgeRepoCommitOutput } from '../action_specs.ts';
	import { fuz_forge_app_context } from './fuz_forge_app.svelte.ts';
	import { repo_page_state_context } from './repo_page_state.svelte.ts';
	import { subscribe_to_repo_updates } from './repo_subscriptions.ts';
	import CommitByline from './CommitByline.svelte';

	const fuz_forge_app = fuz_forge_app_context.get();
	const { api } = fuz_forge_app;
	const repo_state = repo_page_state_context.get();

	const { id, sha }: { id: string; sha: string } = $props();

	const commit_slot = new AsyncSlot<FuzForgeRepoCommitOutput>();

	const commit = $derived(commit_slot.data?.commit ?? null);
	const diff = $derived(commit_slot.data?.diff ?? null);

	// Show committer when ANY of name / email / date differ from author —
	// email-only changes are real (git-config flips between
	// `commit -s` and `commit --amend --reset-author=no`).
	const committer_differs = $derived.by(() => {
		if (!commit) return false;
		return (
			commit.committer_name !== commit.author_name ||
			commit.committer_email !== commit.author_email ||
			commit.committer_date !== commit.author_date
		);
	});

	const fetch_commit = (target_id: string, target_sha: string): Promise<unknown> =>
		commit_slot.run((signal) =>
			api.fuz_forge_repo_commit({ id: target_id, sha: target_sha }, { signal })
		);

	$effect(() => {
		const target_id = id;
		const target_sha = sha;
		untrack(() => void fetch_commit(target_id, target_sha));
	});

	// A force-push that GC's the commit surfaces a not-found state on
	// re-fetch rather than leaving a stale view here.
	onMount(() => subscribe_to_repo_updates(fuz_forge_app, id, () => void fetch_commit(id, sha)));
</script>

<svelte:head>
	<title>
		{commit ? commit.short_sha : sha.slice(0, 7)} - {repo_state.repo?.slug ?? id} - fuz_forge Admin
	</title>
</svelte:head>

<nav class="row gap_sm font_size_sm text_50 mb_sm" aria-label="Breadcrumb">
	<a href={resolve('/admin/repos/[id]/log', { id })}>log</a>
	<span>/</span>
	<span><code>{sha.slice(0, 7)}</code></span>
</nav>

{#if commit_slot.loading && !commit}
	<p><PendingAnimation /> loading commit…</p>
{:else if commit_slot.failed}
	<p class="color_c_50">{commit_slot.error}</p>
{:else if commit && diff}
	<div class="row gap_md mb_md" style:align-items="center">
		<h2 class="flex:1 min-width:0" style:margin="0">{commit.subject}</h2>
		<button type="button" class="plain" onclick={() => void fetch_commit(id, sha)} title="refresh">
			refresh
			{#if commit_slot.loading}<PendingAnimation />{/if}
		</button>
	</div>

	{#if commit.body.trim().length > 0 && commit.body.trim() !== commit.subject.trim()}
		<pre
			class="panel p_md mb_md overflow-wrap:anywhere"
			style:white-space="pre-wrap"
			style:margin="0">{commit.body}</pre>
	{/if}

	<dl
		class="grid gap_sm mb_md overflow-wrap:anywhere"
		style:grid-template-columns="max-content minmax(0, 1fr)"
	>
		<dt class="text_50">sha</dt>
		<dd><code title={commit.sha}>{commit.sha}</code></dd>

		<dt class="text_50">author</dt>
		<dd>
			<CommitByline
				name={commit.author_name}
				email={commit.author_email}
				date={commit.author_date}
			/>
		</dd>

		{#if committer_differs}
			<dt class="text_50">committer</dt>
			<dd>
				<CommitByline
					name={commit.committer_name}
					email={commit.committer_email}
					date={commit.committer_date}
				/>
			</dd>
		{/if}

		<dt class="text_50">parents</dt>
		<dd>
			{#if commit.parents.length === 0}
				<span class="text_50" style:font-style="italic">root commit (no parents)</span>
			{:else}
				<ul style:list-style="none" style:padding="0" style:margin="0">
					{#each commit.parents as parent_sha (parent_sha)}
						<li>
							<a href={resolve('/admin/repos/[id]/c/[sha]', { id, sha: parent_sha })}>
								<code>{parent_sha.slice(0, 12)}</code>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</dd>
	</dl>

	<section>
		<h3 class="font_size_md mb_sm">Diff</h3>
		{#if diff.truncated}
			<p class="color_c_50">
				Diff exceeded the size limit and was not returned. View it locally with
				<code>git show {commit.short_sha}</code>.
			</p>
		{:else if diff.text.length === 0}
			<p class="text_50" style:font-style="italic">empty diff (no file changes).</p>
		{:else}
			<pre class="panel p_md font_size_sm" style:margin="0">{diff.text}</pre>
		{/if}
	</section>
{:else if !commit_slot.loading}
	<p class="color_c_50">Commit not found.</p>
{/if}
