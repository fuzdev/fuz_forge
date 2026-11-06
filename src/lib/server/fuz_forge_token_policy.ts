/**
 * Scoped-token policy enforcement: capability checks, capability
 * string formatter, and template-to-policy builders.
 *
 * Single source of truth for "does this token permit this action" — over the
 * forge's **resource-bound** surfaces, and only those. Three call sites reach
 * `policy_check`: the file store's per-file gate (`enforce_capability`), git
 * smart-HTTP (`check_repo_capability`), and the file-store list route, which
 * calls it directly per entry because it filters rather than refuses. The RPC
 * dispatcher and the WS upgrade do not — the spine's `api_token.scope` owns
 * both, so a policy document's `rpc` grant is a mint-time record with no
 * checker (see `policy_from_template`).
 *
 * A `null` policy passes every check, which is this axis **abstaining**, not
 * granting. Which axis governs a request depends on the token; that rule lives
 * in `fuz_forge_token_surfaces.ts` and every gate goes through it.
 *
 * **Discipline:** a new resource-bound surface MUST call `policy_check`.
 * `scoped_token_deny_all_coverage.db.test.ts` iterates the file-store routes
 * under a synthetic deny-all policy and demands a 403 from every per-file
 * route — except the list, which filters to the empty readable set and so
 * answers 200 with no entries. Refuse-vs-filter is the route's contract, not
 * an exemption from the discipline. `repo_git.scoped_token.db.test.ts` does
 * the same for git.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';

import type { FuzForgeTokenTemplateInput } from '../action_specs.ts';

import {
	DENY_ALL_POLICY,
	FuzForgeTokenPolicy,
	type FuzForgeTokenPolicyResourceMap
} from './fuz_forge_token_policy_schema.ts';

/**
 * A capability to be checked against a token policy.
 *
 * Discriminated by `kind`. Each variant carries the minimal identifying
 * data for that capability — `repo_id` for forge ops, `filename` for
 * file store ops.
 *
 * **There is no `rpc` variant**, and its absence is the design: the spine's
 * `api_token.scope` gates RPC methods inside `perform_action`, so the forge has
 * no say there. A variant would be a checker nothing calls in front of a
 * decision this layer doesn't make — the same "declared but never reached"
 * shape the surface censuses exist to catch.
 */
export type FuzForgeCapability =
	| { kind: 'forge.push'; repo_id: string }
	| { kind: 'forge.pull'; repo_id: string }
	| { kind: 'files.read'; filename: string }
	| { kind: 'files.write'; filename: string }
	| { kind: 'files.delete'; filename: string };

/**
 * Check whether a `ResourceMap` allows the given resource id.
 *
 * `null`/`undefined` map → denied. `'*'` → allowed.
 * Otherwise look up the key (value may be `true` or an empty
 * qualifier object — both pass; the per-key qualifier semantics
 * are reserved for v2).
 */
const resource_map_allows = (
	map: FuzForgeTokenPolicyResourceMap | undefined,
	id: string
): boolean => {
	if (map === undefined) return false;
	if (map === '*') return true;
	return Object.hasOwn(map, id);
};

/**
 * Check a capability against a token policy.
 *
 * Returns `true` to allow, `false` to deny. A `null` policy passes
 * unconditionally — but **that is not the authority decision**, it is only
 * this axis abstaining. A token with no policy row has never been granted
 * anything *here*, so the question falls through to its spine scope; see
 * `token_scope_admits_forge_surface`, which is what callers must use.
 *
 * The check is intentionally strict: anything not explicitly
 * allowed is denied. No deny rules; no precedence; no inheritance.
 */
export const policy_check = (
	policy: FuzForgeTokenPolicy | null,
	capability: FuzForgeCapability
): boolean => {
	if (policy === null) return true; // this axis abstains — see the doc above
	switch (capability.kind) {
		case 'forge.push':
			return resource_map_allows(policy.forge?.push, capability.repo_id);
		case 'forge.pull':
			return resource_map_allows(policy.forge?.pull, capability.repo_id);
		case 'files.read':
			return resource_map_allows(policy.files?.read, capability.filename);
		case 'files.write':
			return resource_map_allows(policy.files?.write, capability.filename);
		case 'files.delete':
			return resource_map_allows(policy.files?.delete, capability.filename);
	}
};

/**
 * Read a stored `fuz_forge_api_token_policy.policy` document, failing closed.
 *
 * The one place either backend turns stored JSON into a policy, so the
 * decision is made once: a document that fails `FuzForgeTokenPolicy`
 * resolves to `DENY_ALL_POLICY`, never to `null`. The row exists, so the
 * token *is* scoped, and reading it as unscoped — which is what `null` means
 * to `policy_check` — is the one outcome that would widen it. Twin of the Rust
 * `policy_from_stored` (`token_policy/check.rs`).
 *
 * @param stored - the document as the driver returned it (jsonb, pre-parsed but unvalidated)
 * @param api_token_id - named in the log line, so an unreadable row is traceable to its token
 * @param log - where the parse failure is recorded
 * @returns the validated policy, or the deny-all document
 */
export const policy_from_stored = (
	stored: unknown,
	api_token_id: string,
	log: Pick<Logger, 'error'>
): FuzForgeTokenPolicy => {
	const parsed = FuzForgeTokenPolicy.safeParse(stored);
	if (parsed.success) return parsed.data;
	log.error(
		`fuz_forge_token_policy: stored policy for ${api_token_id} is unreadable; denying every capability`,
		parsed.error
	);
	return DENY_ALL_POLICY;
};

/**
 * Format a capability as a stable string for surfacing in 403
 * responses (`{required: '<string>'}`) and audit logs.
 *
 * Shape: `<section>.<op>:<resource_id>`. Stable across versions — CLIs can
 * parse it. The spine emits the `rpc:<method>` form for its own per-method
 * gate (`token_scope_method_capability`); nothing here does.
 */
export const capability_string = (capability: FuzForgeCapability): string => {
	switch (capability.kind) {
		case 'forge.push':
		case 'forge.pull':
			return `${capability.kind}:${capability.repo_id}`;
		case 'files.read':
		case 'files.write':
		case 'files.delete':
			return `${capability.kind}:${capability.filename}`;
	}
};

/**
 * Build a `ResourceMap` from an explicit string list, or pass
 * `'*'` through.
 *
 * Always produces `true` values in the record (the canonical
 * "no qualifiers" shape — `{}` is equivalent but verbose). De-dups
 * via Set so duplicate user input doesn't bloat the document.
 *
 * Built with `Object.fromEntries` rather than keyed assignment, because
 * `record['__proto__'] = true` invokes the `Object.prototype.__proto__` setter
 * instead of creating an own property — and since `true` is not an object the
 * setter silently no-ops, dropping the grant. A filename of exactly `__proto__`
 * passes `FILE_KEY_CHARSET`, so that was reachable, and it diverged from the
 * Rust twin's `BTreeMap` (which stores the key like any other). `fromEntries`
 * defines own properties, so the key survives and the prototype is untouched.
 * Reads are already safe — `resource_map_allows` uses `Object.hasOwn`.
 */
const build_resource_map = (ids: '*' | ReadonlyArray<string>): FuzForgeTokenPolicyResourceMap =>
	ids === '*' ? '*' : Object.fromEntries([...new Set(ids)].map((id) => [id, true as const]));

/**
 * Build a `FuzForgeTokenPolicy` document from a template selection.
 *
 * Pure function — no I/O, no auth check. Called by the
 * `fuz_forge_token_create_scoped` handler after the template + params
 * have been validated. The `admin` template returns `null` to signal
 * "no policy row needed"; every other template produces a populated
 * policy.
 *
 * The handler is responsible for ensuring the issuer is privileged
 * to mint the requested template (v1: issuer must hold global
 * `admin` role).
 */
export const policy_from_template = (
	template: FuzForgeTokenTemplateInput
): FuzForgeTokenPolicy | null => {
	switch (template.kind) {
		case 'admin':
			return null;
		case 'forge_push':
			return { version: 1, forge: { push: build_resource_map(template.repo_ids) } };
		case 'forge_pull':
			return { version: 1, forge: { pull: build_resource_map(template.repo_ids) } };
		case 'files_read':
			return { version: 1, files: { read: build_resource_map(template.filenames) } };
		case 'files_write':
			return { version: 1, files: { write: build_resource_map(template.filenames) } };
		case 'files_read_write': {
			const map = build_resource_map(template.filenames);
			return { version: 1, files: { read: map, write: map } };
		}
		case 'rpc_subset':
			// `rpc` is a **record, not a grant**: nothing reads it back, because the
			// spine's `api_token.scope` — derived from this same template at mint —
			// is what gates RPC methods. It stays so the stored row still says what
			// the token was minted for. Do not add a checker for it; that decision
			// belongs to `perform_action`.
			return { version: 1, rpc: build_resource_map(template.methods) };
	}
};
