/**
 * Reactive state for the file store page.
 *
 * @module
 */

import { AsyncSlot } from '@fuzdev/fuz_app/ui/async_slot.svelte.ts';
import { parse_response_error, ui_fetch } from '@fuzdev/fuz_app/ui/ui_fetch.ts';

import type { FileMetaOutput } from '../fuz_forge/file_meta.ts';

export class FilesState {
	readonly list = new AsyncSlot<void>();

	files: Array<FileMetaOutput> = $state.raw([]);

	async fetch(): Promise<void> {
		await this.list.run(async () => {
			const response = await ui_fetch('/api/fuz_forge/files');
			if (!response.ok) {
				throw new Error(await parse_response_error(response, 'Failed to fetch files'));
			}
			const data = await response.json();
			this.files = data.files ?? [];
		});
	}
}
