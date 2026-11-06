<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import Alert from '@fuzdev/fuz_ui/Alert.svelte';
	import CopyToClipboard from '@fuzdev/fuz_ui/CopyToClipboard.svelte';
	import { AuthState, auth_state_context } from '@fuzdev/fuz_app/ui/auth_state.svelte.ts';
	import LoginForm from '@fuzdev/fuz_app/ui/LoginForm.svelte';
	import BootstrapForm from '@fuzdev/fuz_app/ui/BootstrapForm.svelte';
	import ColumnLayout from '@fuzdev/fuz_app/ui/ColumnLayout.svelte';
	import MenuLink from '@fuzdev/fuz_app/ui/MenuLink.svelte';
	import {
		create_admin_rpc_adapters,
		provide_admin_rpc_contexts
	} from '@fuzdev/fuz_app/ui/admin_rpc_adapters.ts';
	import { account_sessions_rpc_context } from '@fuzdev/fuz_app/ui/account_sessions_state.svelte.ts';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	import { capabilities_context } from '#lib/ui/capabilities.svelte.ts';
	import { create_fuz_forge_app, fuz_forge_app_context } from '#lib/ui/fuz_forge_app.svelte.ts';

	const { children }: { children: Snippet } = $props();

	const auth_state = auth_state_context.set(new AuthState());
	void auth_state.check_session();
	const fuz_forge_app = fuz_forge_app_context.set(create_fuz_forge_app());
	const capabilities = capabilities_context.set(fuz_forge_app.capabilities);
	// Probe backend reachability up front (public `/health`) so the unauthenticated
	// gate can surface a recovery hint when the daemon is down, instead of a dead
	// login form. The post-verify `init()` below reuses this result (its own
	// `check_backend` is a no-op once resolved) and adds the protected checks.
	void capabilities.check_backend();

	provide_admin_rpc_contexts(create_admin_rpc_adapters(fuz_forge_app.api));

	// Self-serve account sessions context, consumed by `AccountSessions` on
	// `/admin/account`. Not part of `provide_admin_rpc_contexts`, so wire it
	// here against the same typed throwing client.
	account_sessions_rpc_context.set(() => ({
		list: () => fuz_forge_app.api.account_session_list(),
		revoke: (params) => fuz_forge_app.api.account_session_revoke(params),
		revoke_all: () => fuz_forge_app.api.account_session_revoke_all()
	}));

	$effect(() => {
		if (!auth_state.verified) return;
		untrack(() => fuz_forge_app.socket.connect());
		return () => {
			untrack(() => fuz_forge_app.socket.disconnect());
		};
	});

	$effect(() => {
		if (auth_state.verified && capabilities.backend_available) {
			untrack(() => void capabilities.init());
		}
	});
</script>

{#snippet backend_unavailable()}
	<Alert status="error" style="width: auto">
		<p>
			<strong>Backend unavailable:</strong>
			{capabilities.backend.error ?? 'Connection failed'}
		</p>
		<p>
			Start the server with <code>fuzfd start</code>, or in development run <code>gro dev</code>
			(Vite plus the TS reference backend)
		</p>
	</Alert>
{/snippet}

{#if auth_state.verified}
	<div class="admin-layout">
		<ColumnLayout class="flex:1 overflow:hidden" toggle_label="admin">
			{#snippet aside()}
				<nav aria-label="admin">
					<MenuLink path="/admin" class="menuitem font_size_lg">admin</MenuLink>
					<hr class="nav-separator" />
					<MenuLink path="/admin/files" class="menuitem">files</MenuLink>
					<MenuLink path="/admin/repos" class="menuitem">repos</MenuLink>
					<hr class="nav-separator" />
					<MenuLink path="/admin/db" class="menuitem">db</MenuLink>
					<MenuLink path="/admin/capabilities" class="menuitem">capabilities</MenuLink>
					<hr class="nav-separator" />
					<MenuLink path="/admin/accounts" class="menuitem">accounts</MenuLink>
					<MenuLink path="/admin/invites" class="menuitem">invites</MenuLink>
					<MenuLink path="/admin/sessions" class="menuitem">sessions</MenuLink>
					<MenuLink path="/admin/audit-log" class="menuitem">audit log</MenuLink>
					<MenuLink path="/admin/role-grant-history" class="menuitem">role grant history</MenuLink>
					<hr class="nav-separator" />
					<MenuLink path="/admin/account" class="menuitem">account</MenuLink>
				</nav>
			{/snippet}
			<main class="admin-content">
				<!-- in the content column, not above the layout, so it scrolls with the page
					content instead of holding its height inside the bounded box -->
				{#if capabilities.backend.failed}
					<div class="row p_lg">
						<!-- TODO look into maybe removing `width: 100%` on this upstream, problem is it's a flex container, maybe add a block wrapper? -->
						{@render backend_unavailable()}
					</div>
				{/if}
				{@render children()}
			</main>
		</ColumnLayout>
	</div>
{:else}
	<main class="p_lg">
		{#if auth_state.verifying || capabilities.backend.initial || capabilities.backend.loading}
			<p class="text_50">verifying session...</p>
		{:else if capabilities.backend.failed}
			{@render backend_unavailable()}
		{:else if auth_state.needs_bootstrap}
			<h1 class="mt_0">create account</h1>
			<p>No accounts exist yet. Create the first admin account.</p>
			<p>
				Get the bootstrap token: <code>cat ~/.fuz_forge/secret_bootstrap_token</code>
				<CopyToClipboard text="cat ~/.fuz_forge/secret_bootstrap_token" />
			</p>
			<BootstrapForm />
		{:else}
			<h1 class="mt_0">log in</h1>
			<!-- stay on the admin page that asked for the login -->
			<LoginForm username_label="username" redirect_on_login={page.url.pathname} />
			<p class="mt_lg">Need an account? <a href={resolve('/signup')}>Sign up</a></p>
		{/if}
	</main>
{/if}

<style>
	.admin-layout {
		display: flex;
		flex-direction: column;
		/* a viewport tall, not `100%` of the shell's content column, which has
		   only a min-height and so wouldn't bound it; nothing sits above this
		   in the shell, so the whole viewport is ours - with `min-height: 0`
		   and `overflow: hidden`, the `ColumnLayout` columns scroll
		   independently inside it on wide screens, and on narrow ones its
		   stacked column scrolls as one under a sticky toggle */
		height: 100dvh;
		min-height: 0;
		overflow: hidden;
	}

	/* passes the content column's bounded height down, so a nested
	   `ColumnLayout` (`/admin/db`) resolves its `height: 100%` against it and
	   scrolls its own columns, as it did with the column as its parent */
	.admin-content {
		height: 100%;
	}

	.nav-separator {
		margin: var(--space_md) 0;
		border: none;
		border-top: 1px solid var(--ink_10);
	}
</style>
