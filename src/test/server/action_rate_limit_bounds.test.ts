/**
 * The action-dispatcher rate-limit bounds, asserted against the shared parity
 * fixture.
 *
 * The two buckets are a **wire-visible** contract rather than tuning: the bound
 * decides how many calls a caller gets before the dispatcher answers `429`
 * instead of doing the work, so a backend carrying a looser budget serves
 * requests its twin refuses. Neither backend spells the numbers itself — each
 * inherits its spine's defaults (`create_app_server` here,
 * `fuz_auth::DEFAULT_ACTION_*_RATE_LIMIT` on the Rust side) — which is exactly
 * the shape that drifts unnoticed, since a bound can move upstream on one side
 * alone and nothing in either repo says the two ever agreed.
 *
 * Three things are pinned here: the *bounds* against the fixture, and the two
 * test-mode gates — how `resolve_testing_login_rate_limiter_mode` reads
 * `FUZ_LOGIN_RATE_LIMIT_ENABLED` into a `RateLimiterMode`, and how
 * `resolve_testing_action_rate_limiters` reads `FUZ_ACTION_RATE_LIMIT_ENABLED`
 * and its `FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS` cap into the two action
 * limiters; the twins are the Rust `testing_fuz_forge_server`'s
 * `resolve_login_rate_limiter_mode` and `resolve_action_rate_limits`. The
 * bounds are the forge's only because production `create_app` passes
 * `create_app_server` no limiter of its own, just the mode, so under
 * `'enforced'` every limiter is the spine default compared here; that omission
 * is a property of the call site, which this file reads nothing of.
 *
 * The Rust twin of the bounds half is
 * `router::compose::tests::action_rate_limit_bounds_match_the_ts_twin`, reading
 * the same `src/test/fixtures/parity/rate_limits.json`; the Rust side also pins
 * its wiring (`router::compose::tests::the_forge_wires_the_spine_action_rate_limits`),
 * which it can because the forge names its limiter options there. The order of
 * these phases — the throttle ahead of input validation — is pinned over the
 * wire by `cross_backend/action_throttle_order.cross.test.ts`, on a spawn
 * whose action limiters carry the test cap, so the production wiring is pinned
 * here instead: `create_testing_wiring` without `testing` hands
 * `create_app_server` `'enforced'` and no action limiter, reading no env.
 *
 * @module
 */

import { test, assert, describe } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import {
	default_action_account_rate_limit,
	default_action_ip_rate_limit
} from '@fuzdev/fuz_app/rate_limiter.ts';

import type { AppDeps } from '@fuzdev/fuz_app/auth/deps.ts';
import type { EnvDeps, RuntimeDeps } from '@fuzdev/fuz_app/runtime/deps.ts';
import { create_throwing_stub } from '@fuzdev/fuz_app/testing/stubs.ts';
import {
	ACTION_RATE_LIMIT_ENABLED_ENV,
	ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV,
	LOGIN_RATE_LIMIT_ENABLED_ENV
} from '@fuzdev/fuz_app/testing/cross_backend/spine_surface_constants.ts';

import {
	create_testing_wiring,
	resolve_testing_action_rate_limiters,
	resolve_testing_login_rate_limiter_mode
} from '#lib/server/app_assembly.ts';
import type { ServerTestingOptions } from '#lib/server/server.ts';

import { load_parity_fixture, parity_rows, parity_string } from '../fixtures/parity/load.ts';

type BucketField = 'max_attempts' | 'window_ms' | 'max_keys';

describe('action rate-limit bounds', () => {
	const fixture = load_parity_fixture('rate_limits');
	const declared: Record<string, Partial<Record<BucketField, number | null>>> = {
		action_ip: default_action_ip_rate_limit,
		action_account: default_action_account_rate_limit
	};

	for (const [table, options] of Object.entries(declared)) {
		for (const row of parity_rows(fixture, table)) {
			const name = parity_string(row, 'name');
			test(`${table}: ${name}`, () => {
				assert.strictEqual(options[name as BucketField], row.value);
			});
		}
	}
});

describe('create_testing_wiring', () => {
	// the throwing runtime and deps prove production reads no env gate and
	// starts nothing
	test('production enforces the spine defaults and injects no action limiter', async () => {
		const wiring = await create_testing_wiring(
			undefined,
			create_throwing_stub<RuntimeDeps>('runtime'),
			create_throwing_stub<AppDeps>('deps'),
			new Logger('test')
		);
		assert.strictEqual(wiring.rate_limiters, 'enforced');
		assert.strictEqual(wiring.action_ip_rate_limiter, undefined);
		assert.strictEqual(wiring.action_account_rate_limiter, undefined);
	});

	// test mode reads its env gates before it starts daemon-token rotation, so a
	// bad value refuses to start with nothing running
	for (const [name, value] of [
		[LOGIN_RATE_LIMIT_ENABLED_ENV, 'ture'],
		[ACTION_RATE_LIMIT_ENABLED_ENV, 'ture'],
		// a cap without its enable flag
		[ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV, '3']
	] as const) {
		test(`a bad ${name} throws before rotation starts`, async () => {
			const runtime = {
				env_get: (n: string) => (n === name ? value : undefined),
				mkdir: () => {
					throw new Error('rotation started');
				}
			} as unknown as RuntimeDeps;
			const testing = {
				daemon_token_path: '/nonexistent/daemon_token'
			} as unknown as ServerTestingOptions;
			await assert_rejects(
				() =>
					create_testing_wiring(
						testing,
						runtime,
						create_throwing_stub<AppDeps>('deps'),
						new Logger('test')
					),
				new RegExp(name)
			);
		});
	}
});

describe('resolve_testing_login_rate_limiter_mode', () => {
	const env_with = (value: string | undefined): EnvDeps => ({
		env_get: (name) => (name === LOGIN_RATE_LIMIT_ENABLED_ENV ? value : undefined),
		env_set: () => {
			throw new Error('env_set is not expected');
		}
	});

	// the standard cross suites spawn with the gate unset
	test('unset disables every limiter', () => {
		assert.strictEqual(
			resolve_testing_login_rate_limiter_mode(env_with(undefined)),
			'disabled_for_testing'
		);
	});

	// the login-security cross projects spawn with `'true'`
	test('a truthy value enforces the limiters', () => {
		for (const raw of ['true', 'TRUE', '1', 'yes', 'on', 'y', 'enabled']) {
			assert.strictEqual(resolve_testing_login_rate_limiter_mode(env_with(raw)), 'enforced', raw);
		}
	});

	test('a falsy value disables every limiter', () => {
		for (const raw of ['false', '0', 'no', 'off', 'n', 'disabled']) {
			assert.strictEqual(
				resolve_testing_login_rate_limiter_mode(env_with(raw)),
				'disabled_for_testing',
				raw
			);
		}
	});

	// a typo must not silently read as off — the Rust binary refuses to start on one
	test('an unrecognized value throws', () => {
		for (const raw of ['', 'ture', 'enable']) {
			assert.throws(
				() => resolve_testing_login_rate_limiter_mode(env_with(raw)),
				LOGIN_RATE_LIMIT_ENABLED_ENV
			);
		}
	});
});

describe('resolve_testing_action_rate_limiters', () => {
	const env_from = (values: Record<string, string>): EnvDeps => ({
		env_get: (name) => values[name],
		env_set: () => {
			throw new Error('env_set is not expected');
		}
	});

	// the standard cross suites spawn with the gate unset
	test('unset builds neither limiter', () => {
		assert.deepStrictEqual(resolve_testing_action_rate_limiters(env_from({})), {
			action_ip_rate_limiter: null,
			action_account_rate_limiter: null
		});
		assert.deepStrictEqual(
			resolve_testing_action_rate_limiters(env_from({ [ACTION_RATE_LIMIT_ENABLED_ENV]: 'off' })),
			{ action_ip_rate_limiter: null, action_account_rate_limiter: null }
		);
	});

	test('the gate alone builds both at the spine defaults', () => {
		const limiters = resolve_testing_action_rate_limiters(
			env_from({ [ACTION_RATE_LIMIT_ENABLED_ENV]: 'true' })
		);
		assert.deepStrictEqual(limiters.action_ip_rate_limiter?.options, default_action_ip_rate_limit);
		assert.deepStrictEqual(
			limiters.action_account_rate_limiter?.options,
			default_action_account_rate_limit
		);
	});

	// the login-security cross projects spawn with the gate and a small cap
	test('the cap replaces both max_attempts and nothing else', () => {
		const limiters = resolve_testing_action_rate_limiters(
			env_from({
				[ACTION_RATE_LIMIT_ENABLED_ENV]: 'true',
				[ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV]: ' 6 '
			})
		);
		assert.deepStrictEqual(limiters.action_ip_rate_limiter?.options, {
			...default_action_ip_rate_limit,
			max_attempts: 6
		});
		assert.deepStrictEqual(limiters.action_account_rate_limiter?.options, {
			...default_action_account_rate_limit,
			max_attempts: 6
		});
	});

	// the Rust binary refuses to start on each of these
	test('a bad pair throws', () => {
		// a cap without the gate would do nothing
		assert.throws(
			() =>
				resolve_testing_action_rate_limiters(
					env_from({ [ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV]: '6' })
				),
			ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV
		);
		for (const cap of ['0', '-1', '', 'six', '1.5', '4294967296']) {
			assert.throws(
				() =>
					resolve_testing_action_rate_limiters(
						env_from({
							[ACTION_RATE_LIMIT_ENABLED_ENV]: 'true',
							[ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV]: cap
						})
					),
				ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV,
				cap
			);
		}
		assert.throws(
			() =>
				resolve_testing_action_rate_limiters(
					env_from({ [ACTION_RATE_LIMIT_ENABLED_ENV]: 'enable' })
				),
			ACTION_RATE_LIMIT_ENABLED_ENV
		);
	});
});
