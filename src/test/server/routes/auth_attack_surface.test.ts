/**
 * Attack surface snapshot and adversarial HTTP auth tests.
 *
 * Standard tests (snapshot, structure, invariants, adversarial auth) via
 * `describe_standard_attack_surface_tests`. fuz_forge-specific auth assertions below.
 *
 * @module
 */

import { test, assert, describe } from 'vitest';
import { describe_standard_attack_surface_tests } from '@fuzdev/fuz_app/testing/attack_surface.ts';
import { describe_rpc_attack_surface_tests } from '@fuzdev/fuz_app/testing/rpc_attack_surface.ts';
import type { AppSurfaceSpec } from '@fuzdev/fuz_app/http/surface.ts';
import { is_protocol_action_method } from '@fuzdev/fuz_app/actions/action_codegen.ts';

import {
	create_fuz_forge_app_surface_spec,
	resolve_fuz_forge_fixture_path
} from './auth_attack_surface_helpers.ts';

describe_standard_attack_surface_tests({
	build: create_fuz_forge_app_surface_spec,
	snapshot_path: resolve_fuz_forge_fixture_path('auth_attack_surface.json'),
	expected_public_routes: [
		'GET /health',
		// Readiness probe — public liveness/readiness signal for the deploy gate;
		// reveals only a ready/not-ready code, never schema details. Spine route +
		// committed `server/expected_schema.json`.
		'GET /ready',
		'GET /api/account/status',
		// Cell-scoped per-reference fact read — `account: 'none'` because the
		// handler builds the request context itself from `c.var.account_id` and
		// enforces `can_view_cell` per reference; an anonymous caller is admitted
		// only by a public cell. The admin-only bare-hash twin
		// (`GET /api/facts/:hash`) is gated on the route shape and so is not here.
		'GET /api/cells/:cell_id/facts/:hash',
		'POST /api/account/login',
		// Invite-gated signup (`open_signup` defaults false) — mirrors the Rust
		// backend so cross-process tests mint per-test accounts through the
		// production RPC surface against either backend.
		'POST /api/account/signup',
		'POST /api/account/bootstrap',
		// RPC endpoint uses auth: {type: 'none'} at route level — per-action auth
		// is inside the dispatcher. Verified via rpc_endpoints surface assertions.
		'GET /api/rpc',
		'POST /api/rpc',
		// Forge smart-HTTP endpoints. HTTP Basic + admin role +
		// username-match enforced in-handler in `repo_git.ts`. Surface
		// marks them as `auth.account === 'none'` because the standard
		// auth middleware doesn't fire on app-root paths.
		'GET /:slug_with_git{.+\\.git}/info/refs',
		'POST /:slug_with_git{.+\\.git}/git-upload-pack',
		'POST /:slug_with_git{.+\\.git}/git-receive-pack',
		// Forge internal hook callbacks. Loopback IP +
		// per-repo secret enforced in-handler in `repo_internal.ts`.
		'GET /internal/repo-config/:id',
		'POST /internal/repo-receive-callback'
	],
	expected_api_middleware: [
		// the forge's own 1 MiB cap, first in the chain, in place of the global
		// body limit it turns off (`max_body_size: null`)
		'generic_body_cap',
		'host',
		'trusted_proxy',
		'origin',
		// listed because both test binaries mount it (production mounts none) —
		// see `create_fuz_forge_app_surface_spec`; the first credential leg
		'daemon_token',
		'session',
		'request_context',
		'bearer_auth',
		'fuz_forge_token_policy'
	],
	roles: ['admin', 'keeper'],
	skip_routes: [
		// The bare-hash fact read answers a bodiless 404 when no fact carries the
		// hash, which is every generated request: `resolve_valid_path` synthesizes
		// a grammar-valid `blake3:` hash from the params pattern, and nothing seeds
		// a fact under it. The harness reads a 404 with no `error` body as "route
		// not registered", so the correct-auth case can't be driven here.
		//
		// `skip_routes` is not scoped to that case: `describe_standard_attack_surface_tests`
		// threads one list into all three adversarial groups, so skipping the
		// route also drops its adversarial-input and adversarial-404 coverage.
		// Each is recovered elsewhere:
		//
		// - **adversarial auth** (401 / 403 / 200 by role) — cross-process in
		//   `cross_backend/fact_serving.cross.test.ts`, against seeded bytes.
		// - **adversarial input** (duplicated / unknown query keys not bypassing
		//   the gate) — the shared `query_shape` suite
		//   (`cross_backend/spine_suites.cross.test.ts`), which drives this surface
		//   explicitly.
		// - **adversarial 404** (the `blake3:` params grammar) — the cell-scoped
		//   twin `GET /api/cells/:cell_id/facts/:hash` stays on the list and
		//   declares the same `FactHashSchema` param, so the grammar is fuzzed
		//   here on the route that shares it; the Rust twin pins both routes'
		//   params refusals byte-for-byte in the `fuz_fact_serving` serve unit
		//   table.
		//
		// The route's own auth shape is still asserted by the snapshot + the
		// census.
		'GET /api/facts/:hash'
	],
	security_policy: {
		public_mutation_allowlist: [
			'POST /api/account/login',
			// Invite-gated signup — public route, invite consumed in-handler.
			'POST /api/account/signup',
			'POST /api/account/bootstrap',
			// RPC endpoint — per-action auth inside dispatcher, not route-level
			'POST /api/rpc',
			// Forge mutations — in-handler HTTP Basic + admin role gating
			'POST /:slug_with_git{.+\\.git}/git-upload-pack',
			'POST /:slug_with_git{.+\\.git}/git-receive-pack',
			// Forge internal callback — in-handler loopback + secret gating
			'POST /internal/repo-receive-callback'
		]
	}
});

// --- RPC attack surface tests (auth enforcement, adversarial envelopes, adversarial params) ---

/**
 * The unified-cell read actions (`cell_get`, `cell_list`, `cell_field_list`,
 * `cell_item_list`) are declared `account: 'optional'` by the package — they
 * admit an unauthenticated caller and filter rows by the SQL-side visibility
 * predicate. The RPC attack-surface harness treats every non-public method
 * as auth-required (unauthenticated → 401), which is inconsistent with that
 * optional-read design: a paramless anonymous request reaches input
 * validation and returns 400, not 401.
 *
 * The forge keeps these reads mounted with the package's optional-auth
 * semantics (twin-impl parity with `@fuzdev/fuz_app` + the Rust `fuz_cell`
 * spine), but exempts them from the auth-enforcement assertion. There is no
 * anonymous-read exposure in practice: every forge cell is created `private`
 * (repos, files), so the visibility predicate returns nothing to a null
 * caller.
 */
const EXEMPT_OPTIONAL_CELL_READS: ReadonlySet<string> = new Set([
	'cell_get',
	'cell_list',
	'cell_field_list',
	'cell_item_list'
]);

const build_rpc_surface_without_optional_cell_reads = (): AppSurfaceSpec => {
	const spec = create_fuz_forge_app_surface_spec();
	return {
		...spec,
		surface: {
			...spec.surface,
			rpc_endpoints: spec.surface.rpc_endpoints.map((endpoint) => ({
				...endpoint,
				methods: endpoint.methods.filter((m) => !EXEMPT_OPTIONAL_CELL_READS.has(m.name))
			}))
		}
	};
};

describe_rpc_attack_surface_tests({
	build: build_rpc_surface_without_optional_cell_reads,
	roles: ['admin', 'keeper']
});

// --- fuz_forge-specific auth assertions ---

describe('fuz_forge-specific auth requirements', () => {
	test('all fuz_forge REST routes require admin or keeper (except file store reads)', () => {
		const surface = create_fuz_forge_app_surface_spec().surface;
		// file store read routes use 'authenticated' — any logged-in user can download.
		// The catch-all GET serves both download and (with ?meta) metadata.
		const file_store_read_paths = new Set([
			'GET /api/fuz_forge/files/:filename{.+}',
			'GET /api/fuz_forge/files'
		]);
		// fuz_forge REST routes live under /api/fuz_forge/ (SSE, files, state)
		const fuz_forge_routes = surface.routes.filter(
			(r) =>
				(r.path.startsWith('/api/fuz_forge/') || r.path === '/api/fuz_forge') &&
				!file_store_read_paths.has(`${r.method} ${r.path}`)
		);
		for (const route of fuz_forge_routes) {
			const has_role = !!route.auth.roles?.length;
			const has_keeper_credential = !!route.auth.credential_types?.includes('daemon_token');
			assert.ok(
				has_role || has_keeper_credential,
				`${route.method} ${route.path} should require a role or keeper credentials`
			);
		}
	});

	test('no RPC method is public, protocol actions aside', () => {
		const surface = create_fuz_forge_app_surface_spec().surface;
		const rpc_endpoints = surface.rpc_endpoints;
		assert.strictEqual(rpc_endpoints.length, 1, 'should have one RPC endpoint');
		const endpoint = rpc_endpoints[0]!;
		assert.strictEqual(endpoint.path, '/api/rpc');
		// `peer/ping` is the one mounted method declaring `auth: public`, and it
		// is a wire-protocol primitive rather than a domain method: over HTTP its
		// only outcome is the `peer_no_transport` refusal, so it reads nothing,
		// writes nothing, and reveals nothing an unauthenticated caller could not
		// learn from the endpoint's existence. Exempting it by name (the same
		// `is_protocol_action_method` predicate the WS mount and the action
		// manifest use) keeps the invariant meaningful for every consumer-owned
		// method — a new public domain method still fails here.
		const [exempt, consumer_methods] = endpoint.methods.reduce<
			[Array<string>, typeof endpoint.methods]
		>(
			(acc, m) => {
				if (is_protocol_action_method(m.name)) acc[0].push(m.name);
				else acc[1].push(m);
				return acc;
			},
			[[], []]
		);
		// Name the exemption exactly, so mounting another public protocol
		// action over HTTP shows up as a test change rather than a silent one.
		assert.deepStrictEqual(exempt, ['peer/ping']);
		assert.ok(consumer_methods.length > 0, 'expected consumer-owned RPC methods');
		for (const method of consumer_methods) {
			assert.ok(
				method.auth.account !== 'none' || method.auth.actor !== 'none',
				`RPC method ${method.name} should not be public`
			);
		}
	});

	test('all db routes require admin auth over a session cookie only', () => {
		// fuz_forge rewrites fuz_app's keeper+daemon_token gate on /api/db/* to
		// admin + session-only — the dashboard's Capabilities check + table
		// browser run against the operator's session cookie, and no bearer
		// (narrowed or Full) reaches the browser at all. See
		// `server/routes/db.ts`.
		const surface = create_fuz_forge_app_surface_spec().surface;
		const db_routes = surface.routes.filter((r) => r.path.startsWith('/api/db/'));
		assert.ok(db_routes.length > 0, 'expected at least one /api/db/* route');
		for (const route of db_routes) {
			assert.ok(
				route.auth.roles?.includes('admin'),
				`${route.method} ${route.path} should require admin role`
			);
			assert.deepStrictEqual(
				route.auth.credential_types,
				['session'],
				`${route.method} ${route.path} should be session-only`
			);
		}
	});

	test('/api/server/status requires authentication', () => {
		const surface = create_fuz_forge_app_surface_spec().surface;
		const status = surface.routes.find((r) => r.path === '/api/server/status');
		assert.ok(status);
		assert.strictEqual(status.auth.account, 'required');
	});
});
