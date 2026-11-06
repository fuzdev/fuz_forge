<script lang="ts">
	import { AuthState, auth_state_context } from '@fuzdev/fuz_app/ui/auth_state.svelte.ts';
	import SignupForm from '@fuzdev/fuz_app/ui/SignupForm.svelte';
	import LogoutButton from '@fuzdev/fuz_app/ui/LogoutButton.svelte';
	import { resolve } from '$app/paths';

	const auth_state = auth_state_context.set(new AuthState());
	void auth_state.check_session();
</script>

<svelte:head>
	<title>sign up - fuz_forge</title>
</svelte:head>

<div class="px_lg py_xl5 mx_auto width_atmost_md">
	{#if auth_state.verifying}
		<p class="text_50">checking session...</p>
	{:else if auth_state.verified}
		<p>You are logged in as <strong>{auth_state.account?.username}</strong>.</p>
		<LogoutButton />
		<nav class="mt_lg">
			Go to the <a href={resolve('/admin')}>admin</a> or back to the
			<a href={resolve('/')}>home page</a>.
		</nav>
	{:else}
		<h1 class="mt_0">sign up</h1>
		<SignupForm redirect_on_signup={resolve('/admin')} />
		<p class="mt_lg">Already have an account? <a href={resolve('/admin')}>Log in</a></p>
	{/if}
</div>
