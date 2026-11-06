<script lang="ts">
	import { resolve } from '$app/paths';

	import Tabs from './Tabs.svelte';
	import Tab from './Tab.svelte';
	import { ref_path_rest } from './repo_ref_paths.ts';

	const {
		id,
		default_branch,
		selected
	}: {
		id: string;
		default_branch: string;
		/** Which tab is the current view. `'repo'` is the overview at `/admin/repos/[id]`. */
		selected: 'repo' | 'tree' | 'refs' | 'log' | 'commit';
	} = $props();
</script>

<Tabs label="Repo views">
	<Tab href={resolve('/admin/repos/[id]', { id })} selected={selected === 'repo'}>repo</Tab>
	<Tab
		href={resolve('/admin/repos/[id]/tree/[...rest]', {
			id,
			rest: ref_path_rest(default_branch, '')
		})}
		selected={selected === 'tree'}
	>
		tree
	</Tab>
	<Tab href={resolve('/admin/repos/[id]/refs', { id })} selected={selected === 'refs'}>refs</Tab>
	<Tab href={resolve('/admin/repos/[id]/log', { id })} selected={selected === 'log'}>log</Tab>
</Tabs>
