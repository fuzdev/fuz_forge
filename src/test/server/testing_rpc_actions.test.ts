import { assert, describe, test } from 'vitest';
import { parse_any } from '@fuzdev/fuz_app/schema_issues.ts';
import type { AppDeps } from '@fuzdev/fuz_app/auth/deps.ts';

import { create_fuz_forge_testing_rpc_actions } from '#lib/server/testing_rpc_actions.ts';

describe('_testing_await_signal input', () => {
	const action = create_fuz_forge_testing_rpc_actions({} as AppDeps, {
		daemon_token_state: {} as never,
		session_options: {} as never
	}).find((a) => a.spec.method === '_testing_await_signal');

	test('takes an integer timeout in 1..=60000, as the Rust twin does', () => {
		assert.ok(action);
		const ok = (timeout_ms: unknown): boolean => parse_any(action.spec.input, { timeout_ms }).ok;
		for (const v of [1, 60_000, 1e3]) assert.isTrue(ok(v), String(v));
		for (const v of [0, -1, 60_001, 1.5, '5', null]) assert.isFalse(ok(v), String(v));
	});
});
