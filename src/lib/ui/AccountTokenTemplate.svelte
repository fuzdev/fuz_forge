<script lang="ts">
	import type { FuzForgeTokenTemplateInput } from '../action_specs.ts';

	interface Props {
		template: FuzForgeTokenTemplateInput;
		disabled?: boolean;
	}

	/* eslint-disable-next-line @typescript-eslint/no-useless-default-assignment */
	let { template = $bindable(), disabled = false }: Props = $props();

	const kinds: ReadonlyArray<FuzForgeTokenTemplateInput['kind']> = [
		'admin',
		'forge_push',
		'forge_pull',
		'files_read',
		'files_write',
		'files_read_write',
		'rpc_subset'
	];

	const kind_label = (k: FuzForgeTokenTemplateInput['kind']): string => {
		switch (k) {
			case 'admin':
				return 'admin (unscoped)';
			case 'forge_push':
				return 'forge push (per-repo)';
			case 'forge_pull':
				return 'forge pull (per-repo)';
			case 'files_read':
				return 'files read';
			case 'files_write':
				return 'files write';
			case 'files_read_write':
				return 'files read + write';
			case 'rpc_subset':
				return 'rpc method subset';
		}
	};

	const select_kind = (next: FuzForgeTokenTemplateInput['kind']): void => {
		switch (next) {
			case 'admin':
				template = { kind: 'admin' };
				return;
			case 'forge_push':
				template = { kind: 'forge_push', repo_ids: [] };
				return;
			case 'forge_pull':
				template = { kind: 'forge_pull', repo_ids: [] };
				return;
			case 'files_read':
				template = { kind: 'files_read', filenames: '*' };
				return;
			case 'files_write':
				template = { kind: 'files_write', filenames: '*' };
				return;
			case 'files_read_write':
				template = { kind: 'files_read_write', filenames: '*' };
				return;
			case 'rpc_subset':
				template = { kind: 'rpc_subset', methods: [] };
				return;
		}
	};

	// Parse comma-separated input into trimmed non-empty values. Used for
	// the array fields (repo_ids, methods, explicit filename lists).
	const parse_list = (raw: string): Array<string> =>
		raw
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s !== '');

	const repo_ids_raw = $derived(
		template.kind === 'forge_push' || template.kind === 'forge_pull'
			? template.repo_ids.join(', ')
			: ''
	);
	const methods_raw = $derived(template.kind === 'rpc_subset' ? template.methods.join(', ') : '');
	const filenames_raw = $derived(
		template.kind === 'files_read' ||
			template.kind === 'files_write' ||
			template.kind === 'files_read_write'
			? template.filenames === '*'
				? ''
				: template.filenames.join(', ')
			: ''
	);

	const set_repo_ids = (raw: string): void => {
		if (template.kind === 'forge_push')
			template = { kind: 'forge_push', repo_ids: parse_list(raw) };
		else if (template.kind === 'forge_pull')
			template = { kind: 'forge_pull', repo_ids: parse_list(raw) };
	};
	const set_methods = (raw: string): void => {
		if (template.kind === 'rpc_subset') template = { kind: 'rpc_subset', methods: parse_list(raw) };
	};
	const set_filenames = (raw: string): void => {
		const trimmed = raw.trim();
		const filenames: '*' | Array<string> = trimmed === '' ? '*' : parse_list(raw);
		if (template.kind === 'files_read') template = { kind: 'files_read', filenames };
		else if (template.kind === 'files_write') template = { kind: 'files_write', filenames };
		else if (template.kind === 'files_read_write')
			template = { kind: 'files_read_write', filenames };
	};
</script>

<div class="column gap_sm">
	<label class="column gap_xs">
		<span class="font_size_sm text_50">template</span>
		<select
			value={template.kind}
			{disabled}
			onchange={(e) => select_kind(e.currentTarget.value as FuzForgeTokenTemplateInput['kind'])}
		>
			{#each kinds as kind (kind)}
				<option value={kind}>{kind_label(kind)}</option>
			{/each}
		</select>
	</label>

	{#if template.kind === 'forge_push' || template.kind === 'forge_pull'}
		<label class="column gap_xs">
			<span class="font_size_sm text_50">repo ids (comma-separated)</span>
			<input
				type="text"
				value={repo_ids_raw}
				placeholder="my-repo, other-repo"
				{disabled}
				oninput={(e) => set_repo_ids(e.currentTarget.value)}
			/>
		</label>
	{:else if template.kind === 'files_read' ||
		template.kind === 'files_write' ||
		template.kind === 'files_read_write'
	}
		<label class="column gap_xs">
			<span class="font_size_sm text_50">filenames (comma-separated, blank for *)</span>
			<input
				type="text"
				value={filenames_raw}
				placeholder="* (any) or e.g. zig.tar.xz, node.tar.xz"
				{disabled}
				oninput={(e) => set_filenames(e.currentTarget.value)}
			/>
		</label>
	{:else if template.kind === 'rpc_subset'}
		<label class="column gap_xs">
			<span class="font_size_sm text_50">rpc methods (comma-separated)</span>
			<input
				type="text"
				value={methods_raw}
				placeholder="fuz_forge_repo_log, fuz_forge_repo_refs"
				{disabled}
				oninput={(e) => set_methods(e.currentTarget.value)}
			/>
		</label>
	{/if}
</div>
