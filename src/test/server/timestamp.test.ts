/**
 * Unit tests for the forge's canonical wire timestamp shape.
 *
 * The format is the parity contract: the Rust backend emits second-precision
 * UTC from `fuz_db`'s `iso8601_timestamp_column` (repo `created_at` /
 * `updated_at`) and `fuz_sys::rfc3339_now` (`seed_completed_at` /
 * `last_pushed_at`), so a millisecond `toISOString()` here would put a
 * different byte string on the wire for the same instant. The cross suites pin
 * the shape end-to-end; this file pins the helper.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { ISO8601_SECONDS, to_iso8601_seconds } from '#lib/server/timestamp.ts';

describe('to_iso8601_seconds', () => {
	test('renders the 20-char second-precision UTC form', () => {
		const rendered = to_iso8601_seconds(new Date('2026-05-17T12:34:56.789Z'));
		assert.strictEqual(rendered, '2026-05-17T12:34:56Z');
		assert.strictEqual(rendered.length, 20);
		assert.match(rendered, ISO8601_SECONDS);
	});

	test('truncates sub-second precision rather than rounding', () => {
		// `.999` must stay on the same second — rounding up would report an
		// instant the DB row does not carry.
		assert.strictEqual(
			to_iso8601_seconds(new Date('2026-05-17T12:34:56.999Z')),
			'2026-05-17T12:34:56Z'
		);
		assert.strictEqual(
			to_iso8601_seconds(new Date('2026-05-17T12:34:56.000Z')),
			'2026-05-17T12:34:56Z'
		);
	});

	test('normalizes a non-UTC instant to UTC', () => {
		assert.strictEqual(
			to_iso8601_seconds(new Date('2026-05-17T12:34:56-04:00')),
			'2026-05-17T16:34:56Z'
		);
	});

	test('renders the current time in the wire shape', () => {
		assert.match(to_iso8601_seconds(new Date()), ISO8601_SECONDS);
	});
});

describe('ISO8601_SECONDS', () => {
	test('rejects the millisecond `toISOString` form the pattern exists to catch', () => {
		assert.notMatch(new Date('2026-05-17T12:34:56.789Z').toISOString(), ISO8601_SECONDS);
	});

	test('rejects an offset-bearing or space-separated timestamp', () => {
		assert.notMatch('2026-05-17T12:34:56+00:00', ISO8601_SECONDS);
		assert.notMatch('2026-05-17 12:34:56Z', ISO8601_SECONDS);
	});
});
