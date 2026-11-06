<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { AsyncSlot } from '@fuzdev/fuz_app/ui/async_slot.svelte.ts';

	import type { FuzForgeRepoRefEntry } from '../action_specs.ts';
	import { fuz_forge_app_context } from './fuz_forge_app.svelte.ts';
	import { ref_path_rest, ref_short_name } from './repo_ref_paths.ts';

	const fuz_forge_app = fuz_forge_app_context.get();
	const { api } = fuz_forge_app;

	const {
		id,
		current_ref,
		path,
		kind
	}: {
		id: string;
		current_ref: string;
		/** Current path within the tree (empty string = root). */
		path: string;
		/** Whether the navigation target is a tree view or a blob view. */
		kind: 'tree' | 'blob';
	} = $props();

	// The payload carries the repo the refs were read for: this component is
	// reused across `[id]` changes on the same route, so refs loaded for one
	// repo must not be offered as another's.
	const refs_slot = new AsyncSlot<{ id: string; refs: Array<FuzForgeRepoRefEntry> }>();

	const result = $derived(refs_slot.data);
	const refs = $derived(result && result.id === id ? result.refs : []);
	/** Whether `refs` holds a settled read of *this* repo. */
	const is_current = $derived(refs_slot.succeeded && result?.id === id);

	/**
	 * The repo the slot's last `run` targeted. The slot's *pending* and
	 * *failed* states belong to that repo, not necessarily to `id` — the
	 * payload's own `id` can't say, because it exists only on success.
	 */
	let requested_id: string | null = $state(null);

	/** The slot's error, but only while it belongs to the repo on screen. */
	const error = $derived(requested_id === id ? refs_slot.error : null);

	/**
	 * Load this repo's refs unless they're already in hand or a request for
	 * *this* repo is in flight — the guard is on the in-flight state, not just
	 * the settled one, because opening the dropdown fires `focus` and `click`
	 * back to back and each RPC spawns a real `git for-each-ref` on the
	 * server. It's keyed on the target repo because a read still in flight for
	 * the previous `[id]` must not swallow this repo's first interaction;
	 * `run` supersedes that read on its own.
	 */
	const ensure_loaded = (): void => {
		if (is_current || (refs_slot.loading && requested_id === id)) return;
		const target_id = id;
		requested_id = target_id;
		void refs_slot.run(async (signal) => {
			const result = await api.fuz_forge_repo_refs({ id: target_id }, { signal });
			return { id: target_id, refs: result.refs };
		});
	};

	const on_change = (e: Event): void => {
		const target = e.currentTarget as HTMLSelectElement;
		const new_ref = target.value;
		if (!new_ref || new_ref === current_ref) return;
		// Switching ref while viewing a blob falls back to the tree at that
		// ref — paths aren't guaranteed to exist on other branches.
		const rest = ref_path_rest(new_ref, kind === 'tree' ? path : '');
		void goto(resolve('/admin/repos/[id]/tree/[...rest]', { id, rest }));
	};
</script>

<!--
	Both handlers stay: `focus` is what a keyboard user fires (they may never
	click), and `click` covers browsers that don't focus a `<select>` on
	mousedown. `ensure_loaded` is idempotent, so the overlap costs nothing.
-->
<select
	class="font_size_sm"
	onfocus={ensure_loaded}
	onclick={ensure_loaded}
	onchange={on_change}
	title={error ?? 'switch ref'}
>
	<option value={current_ref}>{current_ref}</option>
	{#each refs as ref (ref.name)}
		{@const name = ref_short_name(ref.name)}
		{#if name !== current_ref}
			<option value={name}>{name}</option>
		{/if}
	{/each}
</select>
