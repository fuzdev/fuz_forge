/**
 * Mock RuntimeDeps for testing.
 *
 * Wraps fuz_app's `create_mock_runtime` with a fuz_forge-specific type alias.
 *
 * @module
 */

import {
	create_mock_runtime as create_mock_runtime_base,
	type MockRuntime
} from '@fuzdev/fuz_app/runtime/mock.ts';
import type { RuntimeDeps } from '@fuzdev/fuz_app/runtime/deps.ts';

/**
 * Mock RuntimeDeps with observable state for assertions.
 */
export type MockFuzForgeRuntime = MockRuntime & RuntimeDeps;

/**
 * Create a mock RuntimeDeps for testing.
 *
 * @param args - CLI arguments
 * @returns `MockFuzForgeRuntime` with controllable state
 *
 * @example
 * ```ts
 * const runtime = create_mock_runtime();
 * runtime.mock_env.set('HOME', '/home/test');
 *
 * await some_function(runtime);
 *
 * assert.ok(runtime.command_calls.length === 1);
 * assert.deepStrictEqual(runtime.exit_calls, [0]);
 * ```
 */
export const create_mock_runtime = (args: Array<string> = []): MockFuzForgeRuntime =>
	create_mock_runtime_base(args);
