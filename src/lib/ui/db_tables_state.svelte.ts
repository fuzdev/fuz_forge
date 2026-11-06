/**
 * Reactive state for the admin DB tables sidebar.
 *
 * @module
 */

import { AsyncSlot } from '@fuzdev/fuz_app/ui/async_slot.svelte.ts';
import { parse_response_error, ui_fetch } from '@fuzdev/fuz_app/ui/ui_fetch.ts';

export interface TableInfo {
	name: string;
	row_count: number;
}

export class DbTablesState {
	readonly list = new AsyncSlot<void>();

	tables: Array<TableInfo> = $state.raw([]);

	async fetch(): Promise<void> {
		await this.list.run(async () => {
			const response = await ui_fetch('/api/db/tables');
			if (!response.ok) {
				throw new Error(await parse_response_error(response, 'Failed to fetch tables'));
			}
			const data = await response.json();
			this.tables = data.tables ?? [];
		});
	}
}
