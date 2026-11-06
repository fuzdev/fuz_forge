<script lang="ts">
	import { resolve } from '$app/paths';
</script>

<svelte:head>
	<title>Admin - fuz_forge</title>
</svelte:head>

<div class="p_lg">
	<h1>admin</h1>
	<p class="text_50">Manage forge repos, the file store, and access.</p>

	<nav class="mt_lg" aria-label="admin overview">
		<ul>
			<li><a href={resolve('/admin/repos')}>repos</a> — forge-hosted repositories</li>
			<li><a href={resolve('/admin/files')}>files</a> — the file store</li>
			<li><a href={resolve('/admin/accounts')}>accounts</a> — accounts and invites</li>
			<li><a href={resolve('/admin/capabilities')}>capabilities</a> — scoped-token capabilities</li>
			<li><a href={resolve('/admin/db')}>db</a> — database tables</li>
		</ul>
	</nav>
</div>
