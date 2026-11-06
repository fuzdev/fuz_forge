<script lang="ts">
	import { resolve } from '$app/paths';

	import type { FuzForgeRepoCommitSummary } from '../action_specs.ts';
	import CommitByline from './CommitByline.svelte';

	const { commit, repo_id }: { commit: FuzForgeRepoCommitSummary; repo_id: string } = $props();
</script>

<li class="panel p_sm row gap_sm" style:align-items="baseline">
	<a
		href={resolve('/admin/repos/[id]/c/[sha]', { id: repo_id, sha: commit.sha })}
		class="font_size_sm"
		title={commit.sha}
	>
		<code>{commit.short_sha}</code>
	</a>
	<div class="column gap_xs" style:flex="1" style:min-width="0">
		<a
			href={resolve('/admin/repos/[id]/c/[sha]', { id: repo_id, sha: commit.sha })}
			style:overflow="hidden"
			style:text-overflow="ellipsis"
			style:white-space="nowrap"
		>
			{commit.subject}
		</a>
		<span class="font_size_sm text_50 overflow-wrap:anywhere">
			<CommitByline
				name={commit.author_name}
				email={commit.author_email}
				date={commit.author_date}
			/>
			{#if commit.parents.length > 1}
				· <span class="chip">merge ({commit.parents.length} parents)</span>
			{/if}
		</span>
	</div>
</li>
