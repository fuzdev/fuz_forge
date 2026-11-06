<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The read-only slice of an `AsyncSlot` this card consumes. Structural,
	 * not `AsyncSlot<unknown>`: a slot of any payload satisfies it, whereas
	 * `AsyncSlot<unknown>` accepts an `AsyncSlot<DatabaseInfo>` only through
	 * method-parameter bivariance and a mutable `data` — unsoundness that
	 * would let this card call `set` with a value of the wrong type.
	 */
	interface CapabilityStatus {
		readonly succeeded: boolean;
		readonly failed: boolean;
		readonly loading: boolean;
		readonly error: string | null;
	}

	const {
		name,
		capability,
		checked_at,
		subtitle,
		description,
		onrefresh,
		children
	}: {
		name: string;
		/** The probe's slot — status and error come straight off it. */
		capability: CapabilityStatus;
		/** Wall-clock time of the probe's last settled run, or `null` before the first. */
		checked_at: number | null;
		subtitle?: string;
		description?: string;
		onrefresh?: () => void;
		children?: Snippet;
	} = $props();

	const status_label = $derived(
		capability.succeeded
			? 'available'
			: capability.failed
				? 'unavailable'
				: capability.loading
					? 'checking...'
					: 'not checked'
	);

	const checked_label = $derived(checked_at ? new Date(checked_at).toLocaleTimeString() : null);
</script>

<div class="panel p_lg">
	<div class="row gap_md" style:justify-content="space-between" style:align-items="flex-start">
		<div class="mb_lg">
			<h3 class="mt_0 mb_xs">{name}</h3>
			{#if subtitle}
				<p class="text_50 font_family_mono mb_lg" style:font-size="var(--font_size_sm)">
					{subtitle}
				</p>
			{/if}
			<p class={['chip', capability.succeeded && 'palette_b', capability.failed && 'palette_c']}>
				{status_label}
			</p>
		</div>
		{#if onrefresh}
			<button type="button" class="plain" onclick={onrefresh} disabled={capability.loading}>
				refresh
			</button>
		{/if}
	</div>

	{#if capability.error}
		<p class="color_c_50">
			{capability.error}
		</p>
	{/if}

	{#if children}
		<div class="mb_lg">
			{@render children()}
		</div>
	{/if}

	{#if description}
		<p class="text_50">{description}</p>
	{/if}

	{#if checked_label}
		<p class="text_50">
			<small>last checked: {checked_label}</small>
		</p>
	{/if}
</div>
