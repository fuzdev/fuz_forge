<script lang="ts">
	import { resolve } from '$app/paths';

	import { ref_path_rest } from './repo_ref_paths.ts';

	const {
		id,
		ref,
		segments,
		kind
	}: {
		id: string;
		ref: string;
		segments: Array<string>;
		/** `'tree'` makes every segment link as a tree; `'blob'` keeps the last segment as a non-link blob path. */
		kind: 'tree' | 'blob';
	} = $props();

	const trail = $derived.by(() => {
		const acc: Array<{ label: string; sub_path: string; is_blob_last: boolean }> = [];
		let path = '';
		segments.forEach((seg, i) => {
			path = path === '' ? seg : `${path}/${seg}`;
			const is_blob_last = i === segments.length - 1 && kind === 'blob';
			acc.push({ label: seg, sub_path: path, is_blob_last });
		});
		return acc;
	});
</script>

<nav class="row gap_sm font_size_sm text_50" style:flex-wrap="wrap" aria-label="Path">
	<a href={resolve('/admin/repos')}>repos</a>
	<span>/</span>
	<a href={resolve('/admin/repos/[id]', { id })}>{id}</a>
	<span>/</span>
	<a href={resolve('/admin/repos/[id]/tree/[...rest]', { id, rest: ref_path_rest(ref, '') })}>
		{ref}
	</a>
	{#each trail as seg (seg.sub_path)}
		<span>/</span>
		{#if seg.is_blob_last}
			<span class="color_a_50">{seg.label}</span>
		{:else}
			<a
				href={resolve('/admin/repos/[id]/tree/[...rest]', {
					id,
					rest: ref_path_rest(ref, seg.sub_path)
				})}
			>
				{seg.label}
			</a>
		{/if}
	{/each}
</nav>
