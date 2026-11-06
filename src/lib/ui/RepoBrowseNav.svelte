<script lang="ts">
	/**
	 * Shared header row for tree/blob views: a path breadcrumb plus a
	 * ref-switching dropdown. Used by `RepoTree` and `RepoBlob` — same
	 * layout, same prop shape; `kind` plumbs through to both children so
	 * the blob view's last segment renders as non-link text and the ref
	 * selector falls back to tree-at-ref when switching from a blob.
	 *
	 * @module
	 */

	import RepoBreadcrumb from './RepoBreadcrumb.svelte';
	import RefSelector from './RefSelector.svelte';

	const {
		id,
		ref,
		path,
		kind
	}: {
		id: string;
		ref: string;
		/** Path within the tree — empty string for the root. */
		path: string;
		kind: 'tree' | 'blob';
	} = $props();

	const segments = $derived(path === '' ? [] : path.split('/'));
</script>

<div class="row gap_md mb_md" style:align-items="baseline">
	<RepoBreadcrumb {id} {ref} {segments} {kind} />
	<div class="flex:1"></div>
	<RefSelector {id} current_ref={ref} {path} {kind} />
</div>
