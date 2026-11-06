/**
 * **fuz_forge's surface census** — every route the forge mounts, classified by
 * how it relates to a bearer credential's `api_token.scope`, with a reason
 * required in every direction.
 *
 * ## Why this test exists
 *
 * The spine carries a census of its own
 * (`fuz_app/src/test/auth/token_scope_surface_census.test.ts`) and it is exact
 * over the spine's surfaces — and **structurally blind to a consumer's**. A
 * consumer can mount its own bearer-reachable routes, and it can rewrite a
 * shipped route's `auth` to admit a credential the shipped gate refused. The
 * forge does both. fuz_app's own docs say each consumer carries its own census;
 * this is the forge's.
 *
 * It is not hypothetical. The forge's db-admin browser
 * (`server/routes/db.ts`) takes fuz_app's db routes — shipped
 * `roles: ['keeper'], credential_types: ['daemon_token']` — and for a long
 * time rewrote them to admin-any-credential so the dashboard could drive them
 * over a session cookie. Widening the credential axis is what let a bearer
 * `api_token` reach them at all, and nothing then asked what that token's
 * *scope* was: a token minted narrow could `GET /api/db/tables/account` and
 * `DELETE` any row. The comment above the rewrite said "only the credential
 * gate is broadened", which was true and was exactly the problem. (The rewrite
 * is session-only today — no bearer reaches the browser — but the scope row
 * stays declared as the dormant second fence, and the lesson stands for the
 * next re-auth.)
 *
 * ## What it pins
 *
 * The realistic failure is not deleting a gate. It is **adding a surface and
 * not asking the question** — and, uniquely for a consumer, **re-authing a
 * spine route into bearer reach** without noticing that its shipped gate was
 * the thing keeping narrowed tokens out.
 *
 * So the classification is an assertion over the **live mount**, not a source
 * scan: `CENSUS` is reconciled against the route specs the production
 * server actually builds (`create_fuz_forge_app_route_specs`, by way of
 * `create_fuz_forge_app_surface_spec`). Mount a route without a row and the
 * suite fails; drop a row's declared scope and it fails; leave a row behind
 * after deleting its route and it fails.
 *
 * Two of the three surfaces can't be pinned that way, and they get the
 * treatment the spine census gives its WebSocket upgrade — an exact-source map
 * (`IN_HANDLER_SURFACE_SITES`). Git smart-HTTP mounts at app root, outside
 * the `/api/*` middleware chain, so it authenticates in-handler and its route
 * shape honestly reads `account: 'none'`. The file store's gate is conditional
 * on a DB row (below), which a route shape cannot express.
 *
 * ## The two axes, and which governs
 *
 * The forge had a per-token authority control before token scoping existed:
 * `fuz_forge_api_token_policy` + `policy_check`, resource-bound
 * (`files.read:<filename>`, `forge.push:<repo_id>`). It stays — it is the
 * vocabulary the spine deliberately has none for.
 *
 * The two are not layers to stack, and getting that wrong is easy in a way
 * worth recording: gating the file store with a blanket `surface:file_store`
 * declaration refuses **every token `fuz_forge_token_create_scoped` issues**,
 * since its file and forge templates derive a `Methods(∅)` spine scope. The
 * whole-surface rule is blunt because its surfaces have no identity a token can
 * name — nothing mints a token *for* the db-admin browser, which is why that
 * one **is** declared. The forge's own surfaces are the opposite shape.
 *
 * So which axis governs depends on the token: the policy when it has a row, the
 * spine scope when it does not. The second half is what was missing — a token
 * minted through the spine's `account_token_create`, which the forge mounts by
 * way of `create_standard_rpc_actions`, carries a narrowed scope and no policy
 * row, and `policy_check(null, …)` returns `true`. See
 * `server/fuz_forge_token_surfaces.ts`.
 *
 * @module
 */

import { test, assert, describe } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	FUZ_FORGE_TOKEN_SURFACES,
	SURFACE_DB_ADMIN,
	SURFACE_FILE_STORE,
	SURFACE_GIT_HTTP,
	type FuzForgeTokenSurface
} from '#lib/server/fuz_forge_token_surfaces.ts';
import { create_fuz_forge_app_surface_spec } from './routes/auth_attack_surface_helpers.ts';

/** How a mounted route relates to the calling credential's token scope. */
type CensusRole =
	/**
	 * Unrestricted: the route demands nothing of a credential and reads none, so
	 * there is no scope to consult.
	 *
	 * Both halves matter and only the first is checkable from a route spec — see
	 * the `public routes are unrestricted` test. A route that declares
	 * `account: 'none'` but *reads* a credential when one is present belongs in
	 * `spine` or `exempt` with that stated, which is why `GET /api/account/status`
	 * sits below rather than here.
	 */
	| 'public'
	/** The forge gates it — declared on the route shape, or checked in-handler. */
	| 'consults'
	/** Mounted verbatim from fuz_app; the gate decision is the spine's. */
	| 'spine'
	/** The forge authors or re-auths it and decided no scope gate applies. */
	| 'exempt';

/** A reviewed route. */
interface CensusEntry {
	/** `<METHOD> <path>`, exactly as the generated surface spells it. */
	route: string;
	role: CensusRole;
	/**
	 * The capability the route declares on `auth.required_scope`, or `null` when
	 * it declares none. Asserted against the live mount, so a gate that is
	 * quietly dropped fails here and a gate that is quietly added demands a row.
	 */
	scope: string | null;
	/**
	 * The surface this route is gated on **in-handler**, when its gate cannot
	 * live on the route shape. Set on exactly the routes whose `role` is
	 * `consults` and whose `scope` is `null`.
	 *
	 * This is what makes `role` load-bearing rather than prose. Without it, a
	 * `consults` row with no declared scope is indistinguishable from an
	 * `exempt` row that forgot to say so — and the file store and git smart-HTTP
	 * are both exactly that shape, so the two classifications the forge's own
	 * surfaces live under were the two nothing checked.
	 */
	in_handler_surface?: FuzForgeTokenSurface;
	/**
	 * Why — required in every direction, so an exemption is an argument someone
	 * wrote down rather than a question nobody asked.
	 */
	reason: string;
}

/**
 * Every route the forge mounts.
 *
 * Adding a row is the review. A new bearer-reachable surface must decide which
 * side it is on **and say why**.
 */
const CENSUS: ReadonlyArray<CensusEntry> = [
	// --- Public: no credential, nothing to narrow ---
	{
		route: 'GET /health',
		role: 'public',
		scope: null,
		reason: 'unauthenticated liveness probe — returns a fixed body and reads nothing'
	},
	{
		route: 'GET /ready',
		role: 'public',
		scope: null,
		reason:
			'unauthenticated readiness probe for the deploy gate — answers ready/not-ready and never discloses the schema it compared'
	},
	{
		route: 'POST /api/account/login',
		role: 'public',
		scope: null,
		reason: 'mints a session — the caller holds no credential yet, so there is no scope to read'
	},
	{
		route: 'POST /api/account/signup',
		role: 'public',
		scope: null,
		reason: 'invite-gated account creation — same pre-credential position as login'
	},
	{
		route: 'POST /api/account/bootstrap',
		role: 'public',
		scope: null,
		reason:
			'first-keeper bootstrap, proved by a filesystem token rather than an api token — there is no `api_token.scope` in play'
	},

	// --- Spine routes, mounted verbatim ---
	{
		route: 'GET /api/account/status',
		role: 'spine',
		scope: null,
		reason:
			"fuz_app's bootstrap/login/dashboard discriminator, mounted unchanged. It declares `account: 'none'` because the SPA fetches it before holding any credential, but it *reads* one when present and answers with that caller's own account, actor, and role grants — so it is not `public` in this table's sense. No scope gate, which is the spine's call: the handler reads the credential through `get_public_account_id`, so a scope-narrowed token is answered as the anonymous caller (401 with the bootstrap flag) rather than with its account — the downgrade both backends make"
	},
	{
		route: 'GET /api/account/verify',
		role: 'spine',
		scope: 'surface:account_verify',
		reason:
			"fuz_app's nginx `auth_request` shim, mounted unchanged — it declares the spine's own `surface:account_verify` upstream, so a narrowed token is refused 403 rather than passing an `auth_request` gate as its account, and the forge inherits the gate rather than restating it"
	},
	{
		route: 'POST /api/account/logout',
		role: 'spine',
		scope: null,
		reason:
			'mounted unchanged, and `credential_types: [session]` means no bearer credential arrives to narrow'
	},
	{
		route: 'POST /api/account/password',
		role: 'spine',
		scope: null,
		reason: 'mounted unchanged, session-only for the same reason as logout'
	},
	{
		route: 'GET /api/server/status',
		role: 'spine',
		scope: null,
		reason:
			"fuz_app's `create_server_status_route_spec`, mounted unchanged — it discloses the build version and uptime, no account data and no mutation. The closest call in this table: gating it would be defensible, but the route is the spine's and second-guessing a shipped gate in the consumer is the drift this census exists to catch. If it should be gated, it should be gated upstream"
	},
	{
		route: 'GET /api/cells/:cell_id/facts/:hash',
		role: 'spine',
		scope: null,
		reason:
			"fuz_app's cell-scoped per-reference fact read, mounted unchanged. It declares `account: 'none'` and reads a credential when one is present — so it is not `public` in this table's sense, the same position as `GET /api/account/status`. No scope gate, which is the spine's own call: authz lives on the `(cell, hash)` edge, so a caller reaches exactly the bytes the cells it can already view reference — never the union of a fact's other referrers, and never bytes no viewable cell names. A scope-narrowed token resolves to the anonymous caller (`get_public_account_id`) on both backends, so it reads public cells' facts only — never a private cell its account could view"
	},
	{
		route: 'GET /api/facts/:hash',
		role: 'spine',
		scope: 'surface:fact_bare',
		reason:
			"fuz_app's admin-only bare-hash fact read, mounted unchanged — it declares the spine's own `surface:fact_bare` upstream (the broad half of the pair: any stored fact by hash, with no per-reference cell check), so the forge inherits the gate rather than restating it"
	},
	{
		route: 'GET /api/admin/audit/stream',
		role: 'spine',
		scope: 'surface:audit_stream',
		reason:
			"fuz_app's audit SSE route, mounted unchanged — it declares the spine's own `surface:audit_stream` upstream, so the forge inherits the gate rather than restating it"
	},

	// --- The forge gates these ---
	{
		route: 'GET /api/db/health',
		role: 'consults',
		scope: SURFACE_DB_ADMIN,
		reason:
			'the forge rewrites the shipped `keeper` + `daemon_token` gate to admin + session-only for the dashboard — no bearer reaches the browser, and the scope gate stays declared as the dormant second fence should the channel gate ever re-widen'
	},
	{
		route: 'GET /api/db/tables',
		role: 'consults',
		scope: SURFACE_DB_ADMIN,
		reason: 're-authed by the forge; see `GET /api/db/health`'
	},
	{
		route: 'GET /api/db/tables/:name',
		role: 'consults',
		scope: SURFACE_DB_ADMIN,
		reason:
			're-authed by the forge, and the widest read in the deployment — paginated rows of every browsable table (the credential tables sit behind the unoverridable `NON_BROWSABLE_TABLES` floor, but `cell.data` carries per-repo `hook_secret_hash`es)'
	},
	{
		route: 'DELETE /api/db/tables/:name/rows/:id',
		role: 'consults',
		scope: SURFACE_DB_ADMIN,
		reason: 're-authed by the forge, and deletes any browsable row by id'
	},
	{
		route: 'POST /api/fuz_forge/files/:filename{.+}',
		role: 'consults',
		scope: null,
		in_handler_surface: SURFACE_FILE_STORE,
		reason:
			"the forge's own surface, gated in-handler through `enforce_capability` because the decision is conditional on a policy row a route shape can't see — the policy governs a token that has one, the spine scope governs a token that doesn't"
	},
	{
		route: 'GET /api/fuz_forge/files',
		role: 'consults',
		scope: null,
		in_handler_surface: SURFACE_FILE_STORE,
		reason:
			"the forge's own surface; a token with a policy row sees the entries it may read, and one without is refused outright rather than shown everything"
	},
	{
		route: 'GET /api/fuz_forge/files/:filename{.+}',
		role: 'consults',
		scope: null,
		in_handler_surface: SURFACE_FILE_STORE,
		reason:
			"the forge's own surface — serves stored bytes, the signed release artifacts among them; same in-handler funnel as the upload"
	},
	{
		route: 'DELETE /api/fuz_forge/files/:filename{.+}',
		role: 'consults',
		scope: null,
		in_handler_surface: SURFACE_FILE_STORE,
		reason: "the forge's own surface; deletes a file cell, same in-handler funnel as the upload"
	},
	{
		route: 'GET /:slug_with_git{.+\\.git}/info/refs',
		role: 'consults',
		scope: null,
		in_handler_surface: SURFACE_GIT_HTTP,
		reason:
			'git smart-HTTP, gated in-handler through `check_repo_capability` — it mounts at app root outside `/api/*`, so the auth middleware never fires and the route shape honestly reads `account: none`. See `IN_HANDLER_SURFACE_SITES`'
	},
	{
		route: 'POST /:slug_with_git{.+\\.git}/git-upload-pack',
		role: 'consults',
		scope: null,
		in_handler_surface: SURFACE_GIT_HTTP,
		reason: 'git smart-HTTP fetch, gated in-handler; see `GET .../info/refs`'
	},
	{
		route: 'POST /:slug_with_git{.+\\.git}/git-receive-pack',
		role: 'consults',
		scope: null,
		in_handler_surface: SURFACE_GIT_HTTP,
		reason: 'git smart-HTTP push, gated in-handler; see `GET .../info/refs`'
	},

	// --- Exempt, with reasons ---
	{
		route: 'GET /internal/repo-config/:id',
		role: 'exempt',
		scope: null,
		reason:
			'loopback-only + per-repo secret, and it authenticates no api token at all — there is no credential to read a scope off. A narrowed token is not a way to reach it; a loopback foothold is, which is a different threat this gate would not touch'
	},
	{
		route: 'POST /internal/repo-receive-callback',
		role: 'exempt',
		scope: null,
		reason: 'the git hook callback, same loopback + per-repo-secret shape as `repo-config`'
	},
	{
		route: 'POST /api/rpc',
		role: 'exempt',
		scope: null,
		reason:
			'the JSON-RPC endpoint is not a non-RPC surface — it is the RPC surface, and the per-method gate runs inside `perform_action` between the credential gate and the role gate. Declaring a whole-surface refusal here would refuse a narrowed token the very methods it was minted for'
	},
	{
		route: 'GET /api/rpc',
		role: 'exempt',
		scope: null,
		reason: 'the GET half of the same endpoint; see `POST /api/rpc`'
	}
];

/** A file that must contain each of `sources` verbatim. */
interface SurfaceSite {
	/** Path relative to `src/lib`. */
	file: string;
	sources: ReadonlyArray<string>;
}

/** Where an in-handler-gated surface is written, and what it stands in front of. */
interface InHandlerSurface {
	/** The source pins — one entry per gated entry point. */
	sites: ReadonlyArray<SurfaceSite>;
	/**
	 * Every route this surface guards, as an **exact** set.
	 *
	 * Exact so that *narrowing* it fails, not just widening — the twin of the
	 * Rust census's `the_scope_consulting_set_is_the_expected_one`. Without it, a
	 * route quietly reclassified from `consults` to `exempt` still passes every
	 * other assertion here, because a sibling route goes on claiming the surface
	 * (verified). That is the one downgrade a per-row consistency check cannot
	 * see, and it is the shape a forgotten reclassification actually takes.
	 */
	routes: ReadonlyArray<string>;
}

/**
 * Surfaces gated in-handler rather than on a route shape, and the exact source
 * lines that must appear for each.
 *
 * The spine census's `RULE_3_SURFACE_SITES` in miniature, and it exists for the
 * same reason: the assertion has to fail on a gate that is *imported and
 * documented but never reached*, which a "does this file mention the helper"
 * check would pass. So both halves are pinned — the branch that refuses, and
 * the capability the refusal is recorded under.
 *
 * **A surface takes as many entries as it has gated entry points**, and the file
 * store needing two is the lesson. Collapsing its per-file gate and its list
 * gate onto one `enforce_surface` branch removed the risk that the two copies
 * drift apart — but it did not make the list route's *call* visible here, and a
 * pin on the shared branch alone stays green when that call is deleted
 * (verified). Reachability is per-call-site; sharing a branch is not the same as
 * being reached through it.
 */
const IN_HANDLER_SURFACE_SITES: Record<string, InHandlerSurface> = {
	[SURFACE_FILE_STORE]: {
		sites: [
			// The shared branch, reached by the per-file routes through
			// `enforce_capability`.
			{
				file: 'server/fuz_forge_token_policy_middleware.ts',
				sources: [
					'const scope = resolved_auth_scope(get_resolved_auth(c));',
					'if (token_scope_admits_forge_surface(get_request_policy(c), scope)) return null;',
					'return c.json(token_scope_denied_body(surface), 403);',
					'const denied = enforce_surface(c, surface);'
				]
			},
			// The list route reaches the same branch directly — it filters rather
			// than 403s, so it has no capability check to carry the gate for it.
			{
				file: 'server/routes/files.ts',
				sources: ['const denied = enforce_surface(c, SURFACE_FILE_STORE);']
			}
		],
		routes: [
			'POST /api/fuz_forge/files/:filename{.+}',
			'GET /api/fuz_forge/files',
			'GET /api/fuz_forge/files/:filename{.+}',
			'DELETE /api/fuz_forge/files/:filename{.+}'
		]
	},
	[SURFACE_GIT_HTTP]: {
		sites: [
			{
				file: 'server/routes/repo_git_auth.ts',
				sources: [
					'if (!token_scope_admits_forge_surface(policy, auth.scope)) {',
					'token scope denied ${SURFACE_GIT_HTTP}'
				]
			}
		],
		routes: [
			'GET /:slug_with_git{.+\\.git}/info/refs',
			'POST /:slug_with_git{.+\\.git}/git-upload-pack',
			'POST /:slug_with_git{.+\\.git}/git-receive-pack'
		]
	}
};

const lib_dir = fileURLToPath(new URL('../../lib', import.meta.url));

/** Read a `src/lib`-relative source file. */
const read_lib_source = (file: string): string => readFileSync(join(lib_dir, file), 'utf-8');

/** The routes the production factory actually builds, as `<METHOD> <path>`. */
const mounted_routes = (): Map<string, { required_scope: string | undefined }> => {
	const { surface } = create_fuz_forge_app_surface_spec();
	return new Map(
		surface.routes.map((r) => [`${r.method} ${r.path}`, { required_scope: r.auth.required_scope }])
	);
};

describe('fuz_forge token surface census', () => {
	/**
	 * Every mounted route is reviewed, and every review names a mounted route.
	 *
	 * Failing the first half means a surface was added without anyone deciding
	 * whether a narrowed token may reach it. Failing the second means the census
	 * describes a route that no longer exists, which makes it read as covering
	 * more than it does.
	 */
	test('the census is exactly the live route mount', () => {
		const mounted = [...mounted_routes().keys()].sort();
		const reviewed = CENSUS.map((e) => e.route).sort();

		const unreviewed = mounted.filter((r) => !reviewed.includes(r));
		assert.deepStrictEqual(
			unreviewed,
			[],
			"unreviewed routes — each must decide whether a narrowed api token may reach it, and say why (see this module's docs)"
		);

		const vanished = reviewed.filter((r) => !mounted.includes(r));
		assert.deepStrictEqual(vanished, [], 'census names routes the forge no longer mounts');
	});

	/**
	 * Every entry carries a reason, in every direction.
	 *
	 * An exemption with no argument is indistinguishable from an oversight —
	 * this is what keeps the exempt rows from becoming a place to park things.
	 */
	test('every census entry states its reasoning', () => {
		for (const entry of CENSUS) {
			assert.ok(entry.reason.length > 20, `${entry.route} needs a real reason, not a placeholder`);
		}
	});

	/**
	 * The declared scope on every route is exactly what the census says.
	 *
	 * The load-bearing assertion. It fails when a gate is dropped, when one is
	 * added without a decision, and when a route is re-authed onto a different
	 * surface — all as a diff against a reviewed table rather than a silent
	 * change to a route file.
	 */
	test('every route declares the scope the census records', () => {
		const mounted = mounted_routes();
		for (const entry of CENSUS) {
			const route = mounted.get(entry.route);
			assert.ok(route, `${entry.route} is censused but not mounted`);
			assert.strictEqual(
				route.required_scope ?? null,
				entry.scope,
				`${entry.route} declares ${JSON.stringify(route.required_scope ?? null)} but the census records ${JSON.stringify(entry.scope)}`
			);
		}
	});

	/**
	 * A `public` row demands nothing of a credential.
	 *
	 * The one classification with a checkable half: if the route spec gates on an
	 * account, an actor, a role, a credential type, or a scope, then "there is no
	 * scope to consult" is not a reason, it is a mistake. Adding any gate to a
	 * public route therefore forces a re-decision instead of inheriting an
	 * exemption that was only ever true of the ungated case.
	 *
	 * The other half — that the handler reads no credential either — a route
	 * shape cannot express, and it is exactly where the classification can still
	 * be wrong: `GET /api/account/status` passes every assertion here and is
	 * censused `spine`, because it answers an authenticated caller with that
	 * caller's own account. So the reason text still carries weight; this test
	 * bounds it rather than replacing it.
	 */
	test('public routes are unrestricted', () => {
		const { surface } = create_fuz_forge_app_surface_spec();
		const by_route = new Map(surface.routes.map((r) => [`${r.method} ${r.path}`, r]));
		for (const entry of CENSUS) {
			if (entry.role !== 'public') continue;
			const { auth } = by_route.get(entry.route)!;
			assert.deepStrictEqual(
				{
					account: auth.account,
					actor: auth.actor,
					roles: auth.roles ?? null,
					credential_types: auth.credential_types ?? null,
					required_scope: auth.required_scope ?? null
				},
				{
					account: 'none',
					actor: 'none',
					roles: null,
					credential_types: null,
					required_scope: null
				},
				`${entry.route} is censused public but its route shape gates on a credential`
			);
		}
	});

	/**
	 * Every row's `role` agrees with how the route is actually gated.
	 *
	 * The Rust twin pins its consulting set as an exact list; this is the same
	 * assertion in the shape a route table takes. Without it `role` is prose: a
	 * `consults` row with no declared scope reads identically to an `exempt` row
	 * that forgot to say so, and the forge's own two surfaces are both exactly
	 * that shape — so the classification carrying the most weight was the one
	 * nothing checked.
	 *
	 * `spine` is the deliberate gap: whether one of fuz_app's routes declares a
	 * scope is fuz_app's call, and asserting either way here would re-litigate a
	 * shipped decision — which is the drift this census exists to catch.
	 */
	test('every role agrees with how the route is gated', () => {
		for (const entry of CENSUS) {
			const gated_on_route_shape = entry.scope !== null;
			const gated_in_handler = entry.in_handler_surface !== undefined;
			switch (entry.role) {
				case 'consults':
					// Exactly one of the two — a route-shape `required_scope`, or an
					// in-handler check. Both would mean the gate runs twice under two
					// names; neither would mean the row claims a gate it doesn't have.
					assert.strictEqual(
						[gated_on_route_shape, gated_in_handler].filter(Boolean).length,
						1,
						`${entry.route} is censused as consulting scope but is gated ${
							gated_in_handler ? 'both on its route shape and in-handler' : 'neither way'
						} — a consulting route is gated exactly one of the two`
					);
					break;
				case 'public':
				case 'exempt':
					assert.isNull(
						entry.scope,
						`${entry.route} is censused ${entry.role} but declares a scope — reclassify it`
					);
					assert.isFalse(
						gated_in_handler,
						`${entry.route} is censused ${entry.role} but names an in-handler surface — reclassify it`
					);
					break;
				case 'spine':
					assert.isFalse(
						gated_in_handler,
						`${entry.route} is mounted verbatim from fuz_app, so the forge gates nothing in-handler on it`
					);
					break;
			}
		}
	});

	/**
	 * Each in-handler surface guards exactly the routes it says it does.
	 *
	 * Closes the loop the other way from `IN_HANDLER_SURFACE_SITES`: its
	 * `sites` say *where the gate is written*, its `routes` says *what it stands
	 * in front of*, and this reconciles that against what the rows claim. Exact
	 * in both directions, so dropping a route from a surface fails here — the one
	 * downgrade the per-row consistency check above cannot see, since a sibling
	 * row keeps the surface claimed.
	 */
	test('each in-handler surface guards exactly the routes it claims', () => {
		const mounted = mounted_routes();
		for (const [capability, surface] of Object.entries(IN_HANDLER_SURFACE_SITES)) {
			const claimed = CENSUS.filter((e) => e.in_handler_surface === capability)
				.map((e) => e.route)
				.sort();
			assert.deepStrictEqual(
				claimed,
				[...surface.routes].sort(),
				`the routes censused as gated on ${capability} and the routes it declares disagree`
			);
			// …and each is really mounted, so the list can't drift into naming
			// routes the forge no longer serves.
			for (const route of surface.routes) {
				assert.ok(mounted.has(route), `${capability} names ${route}, which is not mounted`);
			}
		}
	});

	/**
	 * Every in-handler surface reaches its guard.
	 *
	 * Exact-source, because the failure this is aimed at is a gate that is
	 * present in the imports and absent from the code path — the shape of the
	 * spine's own first token-scoping miss, where `token_scope_admits_non_rpc`
	 * was exported with a docstring asserting the rule while nothing called it.
	 */
	test('in-handler surfaces reach the guard', () => {
		for (const [capability, surface] of Object.entries(IN_HANDLER_SURFACE_SITES)) {
			for (const site of surface.sites) {
				const source = read_lib_source(site.file);
				for (const expected of site.sources) {
					assert.ok(
						source.includes(expected),
						`${site.file} gates ${capability} but does not contain \`${expected}\``
					);
				}
			}
		}
	});

	/**
	 * Every declared surface is a surface the forge actually mounts, and every
	 * surface the forge declares is reached.
	 *
	 * Both directions. A name in `FUZ_FORGE_TOKEN_SURFACES` that nothing
	 * reaches is a capability declared and unwired — the original miss again,
	 * one layer up. A `surface:` string on a route that is not in the tuple is a
	 * typo that would otherwise only surface as a mis-labelled denial, since the
	 * spine validates the *shape* of a consumer capability and deliberately not
	 * its membership.
	 */
	test('the declared surfaces and the mounted surfaces agree', () => {
		const declared = new Set<string>();
		for (const { required_scope } of mounted_routes().values()) {
			if (required_scope?.startsWith('surface:')) declared.add(required_scope);
		}
		for (const capability of Object.keys(IN_HANDLER_SURFACE_SITES)) declared.add(capability);

		// `surface:account_verify`, `surface:audit_stream` and `surface:fact_bare`
		// are the spine's, inherited by mounting its routes unchanged — the forge
		// names its own surfaces, not fuz_app's.
		const spine_declared = new Set([
			'surface:account_verify',
			'surface:audit_stream',
			'surface:fact_bare'
		]);
		const forge_declared = [...declared]
			.filter((c) => !spine_declared.has(c))
			.sort() as Array<FuzForgeTokenSurface>;

		assert.deepStrictEqual(
			forge_declared,
			[...FUZ_FORGE_TOKEN_SURFACES].sort(),
			'the surfaces the forge declares and the surfaces it names in `fuz_forge_token_surfaces.ts` disagree'
		);
	});
});
