/**
 * Cross-backend differential gate for the forge, TS against Rust.
 *
 * Sends every generated conformance row (`generate_rpc_auth_conformance_cases`
 * over the whole live mount, as `conformance.cross.test.ts` runs them) to both
 * backends and asserts the two normalized responses are equal
 * (`describe_differential_conformance_tests`): status, header names and the
 * whole body, ids and timestamps placeholdered by position. Each backend is
 * the oracle for the other, so a field one sends that the other doesn't — or
 * any body difference on a row the table pins by status and error code alone
 * — fails here. Tracked differences are the ledger in
 * `differential_known_divergences.ts`.
 *
 * Legs: HTTP; WS, without the `fresh_non_admin` rows (a roleless account
 * can't open the forge's admin-gated `/api/ws`, see the table's module doc);
 * and both again on a keeper holding a second actor, where the credential
 * rows bind `acting`.
 *
 * A last group sends hand-written cases the generated table has no row for,
 * each expecting the answer both backends give.
 *
 * Runs under the dual-spawn `cross_backend_parity` project (`parity_handle_a`
 * = TS, `parity_handle_b` = Rust), both on Postgres, so no engine difference
 * can show up as a body difference.
 *
 * @module
 */

import { inject_parity_handles } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import {
	default_cross_process_setup,
	type ReconstructedBootstrappedBackendHandle
} from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { describe_differential_conformance_tests } from '@fuzdev/fuz_app/testing/cross_backend/differential.ts';
import type { ConformanceCase } from '@fuzdev/fuz_app/testing/cross_backend/conformance_case.ts';
import { ERROR_CELL_NOT_FOUND } from '@fuzdev/fuz_app/auth/cell_action_specs.ts';
import { generate_rpc_auth_conformance_cases } from '@fuzdev/fuz_app/testing/cross_backend/conformance_rpc_auth.ts';
import { resolve_rpc_endpoints_for_setup } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';

import { fuz_forge_session_config } from '#lib/server/routes/account.ts';
import { create_fuz_forge_app_surface_spec } from '../server/routes/auth_attack_surface_helpers.ts';
import {
	differential_known_divergences,
	differential_ws_known_divergences
} from './differential_known_divergences.ts';
import { fuz_forge_live_rpc_endpoints, fuz_forge_rpc_endpoints } from './fuz_forge_rpc_mount.ts';

/** The keeper's second actor on the multi-actor leg. */
const SECOND_ACTOR_NAME = 'differential_second_actor';

const parity = inject_parity_handles();
const ts = parity.a;
const rust = parity.b;

const surface_source = create_fuz_forge_app_surface_spec();
const cases = generate_rpc_auth_conformance_cases({
	surface_source,
	live_rpc_endpoints: resolve_rpc_endpoints_for_setup(
		fuz_forge_live_rpc_endpoints,
		fuz_forge_session_config
	)
});
const shared = {
	surface_source,
	rpc_endpoints: fuz_forge_rpc_endpoints,
	live_rpc_endpoints: fuz_forge_live_rpc_endpoints,
	session_options: fuz_forge_session_config
};
const ws_target = (
	handle: ReconstructedBootstrappedBackendHandle
): { base_url: string; ws_path: string } => ({
	base_url: handle.config.base_url,
	ws_path: handle.config.ws_path
});

const ws_cases = cases.filter((c) => c.request.as !== 'fresh_non_admin');

const ts_setup = default_cross_process_setup(ts);
const rust_setup = default_cross_process_setup(rust);

describe_differential_conformance_tests({
	...shared,
	cases,
	backends: [
		{ name: 'ts', setup_test: ts_setup },
		{ name: 'rust', setup_test: rust_setup }
	],
	known_divergences: differential_known_divergences,
	suite_name: 'differential conformance (ts vs rust)'
});

describe_differential_conformance_tests({
	...shared,
	cases: ws_cases,
	backends: [
		{ name: 'ts', setup_test: ts_setup, ws: ws_target(ts) },
		{ name: 'rust', setup_test: rust_setup, ws: ws_target(rust) }
	],
	known_divergences: differential_ws_known_divergences,
	suite_name: 'differential conformance over WS (ts vs rust)'
});

const multi_actor_setup = { extra_actors: [SECOND_ACTOR_NAME] };
const ts_multi_actor_setup = default_cross_process_setup(ts, multi_actor_setup);
const rust_multi_actor_setup = default_cross_process_setup(rust, multi_actor_setup);

describe_differential_conformance_tests({
	...shared,
	cases,
	backends: [
		{ name: 'ts', setup_test: ts_multi_actor_setup },
		{ name: 'rust', setup_test: rust_multi_actor_setup }
	],
	known_divergences: differential_known_divergences,
	suite_name: 'differential multi-actor conformance (ts vs rust)'
});

describe_differential_conformance_tests({
	...shared,
	cases: ws_cases,
	backends: [
		{ name: 'ts', setup_test: ts_multi_actor_setup, ws: ws_target(ts) },
		{ name: 'rust', setup_test: rust_multi_actor_setup, ws: ws_target(rust) }
	],
	known_divergences: differential_ws_known_divergences,
	suite_name: 'differential multi-actor conformance over WS (ts vs rust)'
});

/**
 * Cases no generated row reaches, each pinning an agreement: `expect` is the
 * answer both backends give.
 */
const hand_written_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'keeper → cell_get with the uppercase max UUID → the lookup 404',
		request: {
			method: 'cell_get',
			as: 'keeper',
			params: { id: 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF' }
		},
		expect: { status: 404, error_reason: ERROR_CELL_NOT_FOUND }
	}
];

describe_differential_conformance_tests({
	...shared,
	cases: hand_written_cases,
	backends: [
		{ name: 'ts', setup_test: ts_setup },
		{ name: 'rust', setup_test: rust_setup }
	],
	known_divergences: differential_known_divergences,
	suite_name: 'differential hand-written agreement (ts vs rust)'
});
