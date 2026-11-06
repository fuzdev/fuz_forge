import { test, assert } from 'vitest';

import { concat_uint8 } from '#lib/runtime/bytes.ts';

test('concatenates no chunks to an empty array', () => {
	assert.deepStrictEqual(concat_uint8([]), new Uint8Array(0));
});

test('returns the bytes of a single chunk', () => {
	assert.deepStrictEqual(concat_uint8([new Uint8Array([1, 2, 3])]), new Uint8Array([1, 2, 3]));
});

test('joins multiple chunks in order', () => {
	assert.deepStrictEqual(
		concat_uint8([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])]),
		new Uint8Array([1, 2, 3, 4, 5, 6])
	);
});

test('joins zero-offset views bounded only by their length, not by their backing buffer', () => {
	// the production shape on the Deno path: a `Deno.Command` stdout reader hands
	// back a short view at `byteOffset` 0 over its much larger read buffer, so
	// `length` is the only bound separating the chunk from the trailing slack
	const first_backing = new ArrayBuffer(64);
	new Uint8Array(first_backing).set([1, 2, 3]);
	const first = new Uint8Array(first_backing, 0, 3);
	const second_backing = new ArrayBuffer(64);
	new Uint8Array(second_backing).set([4, 5]);
	const second = new Uint8Array(second_backing, 0, 2);
	assert.deepStrictEqual(concat_uint8([first, second]), new Uint8Array([1, 2, 3, 4, 5]));
});

test('joins views at a non-zero byteOffset by their own bytes, not their backing buffer', () => {
	// the offset half of the same contract: a chunk may start partway into its
	// backing buffer, so `byteOffset` bounds it on the near side as `length` does
	// on the far side
	const backing = new ArrayBuffer(9);
	new Uint8Array(backing).set([9, 9, 1, 2, 3, 9, 4, 5, 9]);
	const first = new Uint8Array(backing, 2, 3);
	const second = new Uint8Array(backing, 6, 2);
	assert.deepStrictEqual(concat_uint8([first, second]), new Uint8Array([1, 2, 3, 4, 5]));
});

test('skips a zero-length chunk among non-empty ones', () => {
	assert.deepStrictEqual(
		concat_uint8([new Uint8Array([1, 2]), new Uint8Array(0), new Uint8Array([3])]),
		new Uint8Array([1, 2, 3])
	);
});

test('concatenates only zero-length chunks to an empty array', () => {
	assert.deepStrictEqual(concat_uint8([new Uint8Array(0), new Uint8Array(0)]), new Uint8Array(0));
});

test('copies the chunks rather than aliasing them', () => {
	const chunk = new Uint8Array([1, 2]);
	const out = concat_uint8([chunk]);
	chunk[0] = 9;
	assert.deepStrictEqual(out, new Uint8Array([1, 2]));
});
