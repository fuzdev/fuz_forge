/**
 * Builtin-only role registry for the forge.
 *
 * The forge defines no custom roles — it leans on the builtin
 * `admin` / `keeper` tiers — so `create_role_registry([])` yields the
 * `RoleRegistry` the cell grant actions validate role-shaped
 * principals against.
 *
 * @module
 */

import { create_role_registry, type RoleRegistry } from '@fuzdev/fuz_app/auth/role_schema.ts';

/** Builtin-only (`admin` / `keeper`) role registry; the forge defines no custom roles. */
export const fuz_forge_roles: RoleRegistry = create_role_registry([]);
