<script lang="ts">
	import { auth_state_context } from '@fuzdev/fuz_app/ui/auth_state.svelte.ts';
	import AccountSessions from '@fuzdev/fuz_app/ui/AccountSessions.svelte';

	import AccountTokens from '#lib/ui/AccountTokens.svelte';

	const auth_state = auth_state_context.get();
</script>

<svelte:head>
	<title>account - fuz_forge</title>
</svelte:head>

<div class="p_lg">
	<h1>account</h1>

	<section>
		<h2>authentication</h2>
		{#if auth_state.account}
			<p>Logged in as <strong>{auth_state.account.username}</strong>.</p>
		{:else}
			<p>Logged in via session cookie.</p>
		{/if}
		<button type="button" onclick={() => auth_state.logout()}>log out</button>
	</section>

	<AccountTokens />

	<AccountSessions />
</div>
