import { test, assert } from 'vitest';

import { resolve_tilde } from '#lib/runtime/path.ts';

test('expands ~ to home directory', () => {
	assert.strictEqual(
		resolve_tilde('~/.fuz_forge/token', '/home/user'),
		'/home/user/.fuz_forge/token'
	);
});

test('expands bare ~', () => {
	assert.strictEqual(resolve_tilde('~', '/home/user'), '/home/user');
});

test('does not expand ~user syntax', () => {
	assert.strictEqual(
		resolve_tilde('~other/.fuz_forge/token', '/home/user'),
		'~other/.fuz_forge/token'
	);
});

test('returns path unchanged when home is undefined', () => {
	assert.strictEqual(resolve_tilde('~/.fuz_forge/token', undefined), '~/.fuz_forge/token');
});

test('returns absolute path unchanged', () => {
	assert.strictEqual(resolve_tilde('/etc/config', '/home/user'), '/etc/config');
});

test('returns relative path unchanged', () => {
	assert.strictEqual(resolve_tilde('relative/path', '/home/user'), 'relative/path');
});

test('handles home with trailing slash', () => {
	assert.strictEqual(
		resolve_tilde('~/.fuz_forge/token', '/home/user/'),
		'/home/user/.fuz_forge/token'
	);
});
