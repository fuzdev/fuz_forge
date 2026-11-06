<script lang="ts">
	import { page } from '$app/state';
	import { format_uptime } from '@fuzdev/fuz_app/ui/ui_format.ts';

	import { capabilities_context } from '#lib/ui/capabilities.svelte.ts';
	import CapabilityCard from '#lib/ui/CapabilityCard.svelte';

	const capabilities = capabilities_context.get();

	// Gate every payload on the probe's *settled success*, not on the payload
	// itself: `AsyncSlot.data` survives a failed retry by design
	// (stale-while-revalidate), so reading it straight would render the last
	// good numbers under an `unavailable` chip beside a freshly stamped
	// "last checked" — presenting stale as current.
	const backend_info = $derived(
		capabilities.backend.succeeded ? capabilities.backend.data : undefined
	);
	const server_info = $derived(
		capabilities.server.succeeded ? capabilities.server.data : undefined
	);
	const database_info = $derived(
		capabilities.database.succeeded ? capabilities.database.data : undefined
	);

	const db_type_label = $derived(database_info?.type === 'postgres' ? 'PostgreSQL' : 'unknown');

	const short_commit = __GIT_COMMIT__.slice(0, 7);
	const build_date = __BUILD_TIMESTAMP__
		? new Date(__BUILD_TIMESTAMP__).toLocaleString()
		: 'unknown';
</script>

<div class="p_lg">
	<h1>capabilities</h1>
	<p class="text_50">System service availability.</p>

	<table>
		<tbody>
			<tr>
				<td class="text_50">version</td>
				<td><code>{server_info?.version ?? '...'}</code></td>
			</tr>
			<tr>
				<td class="text_50">commit</td>
				<td><code>{short_commit}</code></td>
			</tr>
			<tr>
				<td class="text_50">branch</td>
				<td><code>{__GIT_BRANCH__}</code></td>
			</tr>
			<tr>
				<td class="text_50">built</td>
				<td>{build_date}</td>
			</tr>
		</tbody>
	</table>

	<div class="cards">
		<CapabilityCard
			name="backend"
			subtitle={page.url.origin}
			capability={capabilities.backend}
			checked_at={capabilities.backend_checked_at}
			description="Public /health probe — is the forge API server reachable? (the Rust fuzfd in production)."
			onrefresh={() => void capabilities.check_backend()}
		>
			{#if backend_info}
				<dl class="stats">
					<div>
						<dt class="font_size_sm text_50">response</dt>
						<dd class="font_family_mono" style:margin="0">
							{backend_info.response_time}ms
						</dd>
					</div>
				</dl>
			{/if}
		</CapabilityCard>

		<CapabilityCard
			name="server"
			capability={capabilities.server}
			checked_at={capabilities.server_checked_at}
			description="Authenticated /api/server/status — the running build and how long it has been up."
			onrefresh={() => void capabilities.check_server()}
		>
			{#if server_info}
				<dl class="stats">
					<div>
						<dt class="font_size_sm text_50">version</dt>
						<dd class="font_family_mono" style:margin="0">{server_info.version ?? '—'}</dd>
					</div>
					{#if server_info.uptime_ms !== null}
						<div>
							<dt class="font_size_sm text_50">uptime</dt>
							<dd class="font_family_mono" style:margin="0">
								{format_uptime(server_info.uptime_ms)}
							</dd>
						</div>
					{/if}
				</dl>
			{/if}
		</CapabilityCard>

		<CapabilityCard
			name="database"
			subtitle={database_info?.name ?? undefined}
			capability={capabilities.database}
			checked_at={capabilities.database_checked_at}
			description="PostgreSQL for the facts + cells substrate."
			onrefresh={() => void capabilities.check_database()}
		>
			{#if database_info}
				<dl class="stats">
					<div>
						<dt class="font_size_sm text_50">type</dt>
						<dd class="font_family_mono" style:margin="0">{db_type_label}</dd>
					</div>
					<div>
						<dt class="font_size_sm text_50">tables</dt>
						<dd class="font_family_mono" style:margin="0">{database_info.table_count}</dd>
					</div>
				</dl>
			{/if}
		</CapabilityCard>
	</div>
</div>

<style>
	.cards {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space_lg);
		margin-top: var(--space_lg);
	}

	.cards > :global(*) {
		flex: 1 1 300px;
		max-width: 400px;
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: var(--space_sm) var(--space_md);
		margin: 0;
	}
</style>
