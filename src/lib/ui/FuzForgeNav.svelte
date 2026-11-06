<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { auth_state_context } from '@fuzdev/fuz_app/ui/auth_state.svelte.ts';

	const auth_state = auth_state_context.get_maybe();
	const authenticated = $derived(auth_state?.verified ?? false);

	const at_home = $derived(page.url.pathname === '/');
	const at_docs = $derived(page.url.pathname === '/docs');
	const at_about = $derived(page.url.pathname === '/about');
	const inside_admin = $derived(page.url.pathname.startsWith('/admin'));
	const inside_repos = $derived(page.url.pathname.startsWith('/admin/repos'));
	const inside_files = $derived(page.url.pathname.startsWith('/admin/files'));
	const inside_db = $derived(page.url.pathname.startsWith('/admin/db'));
	const inside_capabilities = $derived(page.url.pathname.startsWith('/admin/capabilities'));
	const inside_account = $derived(page.url.pathname.startsWith('/admin/account'));
</script>

<nav class="unstyled" aria-label="site">
	<a href={resolve('/')} class="menuitem py_xs px_md font-weight:600" class:selected={at_home}>
		home
	</a>
	<a href={resolve('/docs')} class="menuitem py_xs px_md" class:selected={at_docs}>docs</a>
	<a href={resolve('/about')} class="menuitem py_xs px_md" class:selected={at_about}>about</a>
	<a
		href={resolve('/admin')}
		class="menuitem py_xs px_md font-weight:600"
		class:selected={inside_admin}
	>
		admin
	</a>
	{#if authenticated}
		<a
			href={resolve('/admin/repos')}
			class="menuitem py_xs pl_xl3 pr_md"
			class:selected={inside_repos}
		>
			repos
		</a>
		<a
			href={resolve('/admin/files')}
			class="menuitem py_xs pl_xl3 pr_md"
			class:selected={inside_files}
		>
			files
		</a>
		<a href={resolve('/admin/db')} class="menuitem py_xs pl_xl3 pr_md" class:selected={inside_db}>
			db
		</a>
		<a
			href={resolve('/admin/capabilities')}
			class="menuitem py_xs pl_xl3 pr_md"
			class:selected={inside_capabilities}
		>
			capabilities
		</a>
		<a
			href={resolve('/admin/account')}
			class="menuitem py_xs pl_xl3 pr_md"
			class:selected={inside_account}
		>
			account
		</a>
		<button
			type="button"
			class="menuitem py_xs pl_xl3 pr_md text_50"
			onclick={() => auth_state?.logout()}
		>
			log out
		</button>
	{/if}
</nav>
