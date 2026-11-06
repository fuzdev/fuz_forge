/**
 * The forge's `CellCreateAuthorize`: the cell kinds the forge's own routes
 * trust are the global admin's to create.
 *
 * Twin of `crates/fuz_forge_server/src/cell_create_authorize.rs`.
 *
 * The forge mounts the spine's generic cell layer beside its own surfaces, and
 * two of those surfaces read cells by `kind`: a `repo` cell carries the hook
 * secret digest the `/internal/*` callbacks compare against, and a `file` cell
 * is a file-store entry. The cell layer reserves no kinds, so without this
 * authorizer any account could `cell_create` (or `cell_clone`) a cell of
 * either kind carrying data of its choosing. `RESERVED_CELL_KINDS` are refused
 * to everyone but a global admin, with the spine's 403 `cell_create_forbidden`;
 * every other kind is admitted.
 *
 * The forge's own writers — `fuz_forge_repo_create` and the file-store upload —
 * write their cells directly, not through `cell_create`, so this gates only the
 * generic verbs. `cell_clone` asks the authorizer as a parentless create of the
 * source's kind, so it is no side door.
 *
 * Mounting an authorizer moves one other answer: a contribution (a create under
 * a parent) is born `moderation: 'approved'`, not the `null` of the spine's open
 * create, since an allowing verdict always carries a moderation outcome. With no `validate_policy`, every root `policy` write is still
 * refused `cell_policy_unsupported`, as with no authorizer.
 *
 * @module
 */

import { has_scoped_role } from '@fuzdev/fuz_app/auth/request_context.ts';
import { ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';
import type { CellCreateAuthorize } from '@fuzdev/fuz_app/auth/cell_actions.ts';

/**
 * The cell kinds only a global admin may create through the generic cell verbs:
 * `repo` (a hosted repo, whose `data` holds the hook secret digest) and `file`
 * (a file-store entry). Twin of the Rust `RESERVED_CELL_KINDS`.
 */
export const RESERVED_CELL_KINDS: ReadonlyArray<string> = ['repo', 'file'];

/**
 * Whether a create of `kind` is admitted: always for a global admin, and for
 * anyone else unless `kind` is one of `RESERVED_CELL_KINDS`. A typeless cell
 * (`null`) is never reserved.
 *
 * Asserted against `src/test/fixtures/parity/cell_create_reserved_kinds.json`,
 * which the Rust twin reads too.
 *
 * @param kind - the cell's `kind`, `null` for a typeless cell
 * @param is_admin - whether the caller holds a global `admin` grant
 * @returns `true` when the create is admitted
 */
export const cell_create_admits = (kind: string | null, is_admin: boolean): boolean =>
	is_admin || kind === null || !RESERVED_CELL_KINDS.includes(kind);

/**
 * The forge's create authorizer — `cell_create_admits` over the caller's global
 * `admin` grant. Pure: it reads nothing but its input.
 */
export const reserved_kind_create_authorize: CellCreateAuthorize = {
	authorize: (auth, input) =>
		cell_create_admits(input.kind, has_scoped_role(auth, ROLE_ADMIN, null))
			? { allow: true, moderation_required: false }
			: { allow: false }
};
