/**
 * Forge-local cell reads.
 *
 * `query_addressed_cells_by_kind` is the unbounded by-kind scan the repo list
 * and the file-store list read, restricted to cells at a path. Both resources
 * are addressed by their path (`repos/<slug>`, `files/<key>`), so a pathless
 * cell of either kind is no entry; filtering it in the SQL means the scan never
 * loads one. The spine's `query_cell_list_by_kind` has no path filter, hence
 * this read beside it.
 *
 * @module
 */

import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import { cell_row_projection, type CellRow } from '@fuzdev/fuz_app/db/cell_queries.ts';

/**
 * List the live cells of one `kind` that sit at a path, newest first, with no
 * visibility predicate and no page cap.
 *
 * The spine's `query_cell_list_by_kind` plus `path IS NOT NULL`, over the same
 * projection. The Rust twin has one SQL site per caller: the repo list
 * (`handlers/repo_read.rs`) and the file-store list (`files/handlers.rs`).
 *
 * @param deps - query deps
 * @param kind - `cell.kind` value to match
 * @returns the matching rows
 */
export const query_addressed_cells_by_kind = (
	deps: QueryDeps,
	kind: string
): Promise<Array<CellRow>> =>
	deps.db.query<CellRow>(
		`SELECT ${cell_row_projection('cell')}
		 FROM cell
		 WHERE kind = $1
		   AND path IS NOT NULL
		   AND deleted_at IS NULL
		 ORDER BY cell.created_at DESC`,
		[kind]
	);
