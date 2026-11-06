<script lang="ts">
	import { library_context } from '@fuzdev/fuz_ui/library.svelte.ts';
	import DocsFooter from '@fuzdev/fuz_ui/DocsFooter.svelte';

	const get_library = library_context.get();
	const library = $derived(get_library());
</script>

<main class="width_atmost_md mx_auto box p_lg">
	<h1 class="mt_xl5">fuz_forge docs</h1>
	<p class="text_50">
		<code>fuz_forge</code> is a self-hosted forge: git repos mirrored by push and kept behind auth,
		a reader for their history and diffs, and a content-addressed file store that <code>fuz</code>
		installs signed first-party tools from. See the
		<a href="https://github.com/fuzdev/fuz_forge">source code</a>.
	</p>

	<section class="box mt_xl5">
		<DocsFooter repo_url={library.repo_url} />
	</section>
</main>
