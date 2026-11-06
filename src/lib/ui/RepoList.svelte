<script lang="ts">
	import { resolve } from '$app/paths';
	import { format_relative_time } from '@fuzdev/fuz_app/ui/ui_format.ts';

	import RepoCloneUrl from './RepoCloneUrl.svelte';
	import type { FuzForgeRepoOutput } from '../action_specs.ts';

	const {
		repos,
		clone_url_origin
	}: {
		repos: Array<FuzForgeRepoOutput>;
		/**
		 * Origin for the clone URL — typically `window.location.origin` at
		 * call sites. The page passes it in so this component stays SSR-safe
		 * (no `window` access at module scope) and easy to unit-test.
		 */
		clone_url_origin: string;
	} = $props();

	const clone_url = (slug: string): string => `${clone_url_origin}/${slug}.git`;
</script>

<div class="column gap_xs">
	{#if repos.length === 0}
		<p class="p_lg text_50" style:text-align="center">
			No repos hosted yet. Create one with <code>fuz_forge repo create &lt;org/repo&gt;</code>.
		</p>
	{:else}
		{#each repos as repo (repo.id)}
			<div class="panel p_md column gap_sm">
				<div class="row gap_md" style:align-items="center">
					<a
						href={resolve('/admin/repos/[id]', { id: repo.id })}
						class="menuitem flex:1 font_size_lg"
					>
						<span class="font_size_md">{repo.slug}</span>
					</a>
					<span class="chip">{repo.default_branch}</span>
				</div>
				<div
					class="row gap_md text_50 font_size_sm"
					style:align-items="center"
					style:flex-wrap="wrap"
				>
					{#if repo.head_sha}
						<code title={repo.head_sha}>{repo.head_sha.slice(0, 8)}</code>
					{:else}
						<span style:font-style="italic">no pushes yet</span>
					{/if}
					{#if repo.last_pushed_at}
						<span>
							pushed
							<time datetime={repo.last_pushed_at} title={repo.last_pushed_at}>
								{format_relative_time(repo.last_pushed_at)}
							</time>
							{#if repo.last_push_username}
								by <strong>{repo.last_push_username}</strong>
							{/if}
						</span>
					{/if}
					{#if repo.seed_completed_at}
						<span title={`seeded from ${repo.seed_from ?? '?'} at ${repo.seed_completed_at}`}>
							seeded
						</span>
					{/if}
				</div>
				<RepoCloneUrl url={clone_url(repo.slug)} />
			</div>
		{/each}
	{/if}
</div>
