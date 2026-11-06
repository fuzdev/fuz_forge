<script lang="ts">
	import { resolve } from '$app/paths';
	import { Library, library_context } from '@fuzdev/fuz_ui/library.svelte.ts';
	import DocsFooter from '@fuzdev/fuz_ui/DocsFooter.svelte';

	import { library_json } from '#routes/library.ts';

	const library = new Library(library_json);
	library_context.set(() => library);
</script>

<main class="width_atmost_md mx_auto">
	<section class="box py_xl3">
		<h1>About fuz_forge</h1>
		<p>
			<code>fuz_forge</code> is a self-hosted forge: git repos mirrored by push and kept behind
			auth, a reader for their history and diffs, and a content-addressed file store that
			<code>fuz</code> installs signed first-party tools from.
		</p>
		<p>
			<a href="https://github.com/fuzdev/zap"><code>zap</code></a> deploys the forge;
			<code>fuz</code> pulls from it.
		</p>
		<p>It is not ready to be used: there is no release and no supported install.</p>
	</section>

	<section class="box">
		<a href={resolve('/docs')}>docs</a>
	</section>

	<section class="box pb_xl3">
		<DocsFooter repo_url={library.repo_url} />
	</section>
</main>
