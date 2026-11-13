<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { format_relative_time, truncate_uuid } from '@fuzdev/fuz_app/ui/ui_format.ts';
	import { AsyncSlot } from '@fuzdev/fuz_app/ui/async_slot.svelte.ts';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import RepoCloneUrl from './RepoCloneUrl.svelte';
	import CommitListItem from './CommitListItem.svelte';
	import type { FuzForgeRepoCommitSummary } from '../action_specs.ts';
	import { fuz_forge_app_context } from './fuz_forge_app.svelte.ts';
	import { repo_page_state_context } from './repo_page_state.svelte.ts';
	import { subscribe_to_repo_updates } from './repo_subscriptions.ts';

	const fuz_forge_app = fuz_forge_app_context.get();
	const { api } = fuz_forge_app;
	const repo_state = repo_page_state_context.get();

	const { id }: { id: string } = $props();

	const repo = $derived(repo_state.repo);
	let clone_url_origin = $state('');

	const commits_slot = new AsyncSlot<Array<FuzForgeRepoCommitSummary>>();

	const clone_url = $derived(repo ? `${clone_url_origin}/${repo.slug}.git` : '');

	const fetch_commits = (target_id: string): Promise<unknown> =>
		commits_slot.run(async (signal) => {
			const { commits } = await api.fuz_forge_repo_log({ id: target_id, limit: 20 }, { signal });
			return commits;
		});

	$effect(() => {
		const target_id = id;
		untrack(() => void fetch_commits(target_id));
	});

	onMount(() => {
		clone_url_origin = window.location.origin;
		return subscribe_to_repo_updates(fuz_forge_app, id, () => void fetch_commits(id));
	});
</script>

<svelte:head>
	<title>Repo {repo?.slug ?? id} - fuz_forge Admin</title>
</svelte:head>

{#if repo}
	<div class="panel p_md mb_md column gap_sm">
		<RepoCloneUrl url={clone_url} />
		<p class="font_size_sm text_50">
			HTTP Basic auth: username = your account username, password = an API token from
			<a href={resolve('/admin/account')}>account settings</a>.
		</p>
	</div>

	<dl
		class="grid gap_sm overflow-wrap:anywhere"
		style:grid-template-columns="max-content minmax(0, 1fr)"
	>
		<dt class="text_50">id</dt>
		<dd><code>{repo.id}</code></dd>

		<dt class="text_50">head SHA</dt>
		<dd>
			{#if repo.head_sha}
				<code title={repo.head_sha}>{repo.head_sha.slice(0, 12)}</code>
				<span class="font_size_sm text_50">({repo.head_sha})</span>
			{:else}
				<span class="text_50" style:font-style="italic">no pushes yet</span>
			{/if}
		</dd>

		<dt class="text_50">last push</dt>
		<dd>
			{#if repo.last_pushed_at}
				<time datetime={repo.last_pushed_at} title={repo.last_pushed_at}>
					{format_relative_time(repo.last_pushed_at)}
				</time>
				{#if repo.last_push_username}
					by <strong>{repo.last_push_username}</strong>
				{/if}
				{#if repo.last_pushed_by}
					<code class="font_size_sm text_50" title={repo.last_pushed_by}>
						{truncate_uuid(repo.last_pushed_by)}
					</code>
				{/if}
			{:else}
				<span class="text_50">—</span>
			{/if}
		</dd>

		<dt class="text_50">seed_from</dt>
		<dd>
			{#if repo.seed_from}
				<code>{repo.seed_from}</code>
				{#if repo.seed_completed_at}
					<span class="font_size_sm text_50">
						(seeded {format_relative_time(repo.seed_completed_at)})
					</span>
				{/if}
			{:else}
				<span class="text_50">—</span>
			{/if}
		</dd>

		<dt class="text_50">created</dt>
		<dd>
			<time datetime={repo.created_at} title={repo.created_at}>
				{format_relative_time(repo.created_at)}
			</time>
		</dd>

		<dt class="text_50">updated</dt>
		<dd>
			<time datetime={repo.updated_at} title={repo.updated_at}>
				{format_relative_time(repo.updated_at)}
			</time>
		</dd>
	</dl>

	<section class="mt_md">
		<div class="row gap_sm mb_sm" style:align-items="baseline">
			<h2 class="font_size_md flex:1" style:margin="0">
				Recent commits on {repo.default_branch}
			</h2>
			<a href={resolve('/admin/repos/[id]/log', { id })} class="font_size_sm">View full log →</a>
		</div>
		{#if commits_slot.loading && !commits_slot.data}
			<p class="text_50"><PendingAnimation /> loading commits…</p>
		{:else if commits_slot.failed}
			<p class="color_c_50">{commits_slot.error}</p>
		{:else if !commits_slot.data || commits_slot.data.length === 0}
			<p class="text_50" style:font-style="italic">
				{repo.head_sha ? 'no commits to show.' : 'no commits yet — push to see history.'}
			</p>
		{:else}
			<ul class="unstyled column gap_xs">
				{#each commits_slot.data as commit (commit.sha)}
					<CommitListItem {commit} repo_id={id} />
				{/each}
			</ul>
		{/if}
	</section>
{/if}
