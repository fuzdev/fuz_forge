import { assert, test } from 'vitest';
import { debian_nginx_spa_site } from '@fuzdev/zap/recipe_debian_nginx.ts';
import { alpine_nginx_spa_site } from '@fuzdev/zap/recipe_alpine_nginx.ts';

import { forge_nginx_locations } from '#lib/nginx_locations.ts';

// The options both deploy configs pass. `zap.ts` and `zap.forge2.ts` differ only
// in the distro wrapper they call; everything here is shared.
const site_options = {
	domain: 'forge.example.com',
	port: '4040',
	root: '/srv/current/build',
	csp: "default-src 'self'",
	ssl: 'snippet' as const,
	spa_try_files: '$uri /200.html',
	extra_locations: forge_nginx_locations()
};

/**
 * The one path that legitimately differs: the Debian and Alpine wrappers point
 * the SSL `include` at their own layout.
 */
const normalize_ssl_path = (config: string): string =>
	config.replace(/include \S+ssl_params\.conf;/, 'include <ssl_params>;');

test('the Debian and Alpine forge server blocks are identical', () => {
	// Both configs document the server block as identical, and they used to keep
	// that true by hand — until the Alpine copy lost `X-Forwarded-Proto` on the
	// git route and nothing noticed. This is what makes the claim checkable.
	assert.equal(
		normalize_ssl_path(alpine_nginx_spa_site(site_options).template),
		normalize_ssl_path(debian_nginx_spa_site(site_options).template)
	);
});

test('every proxying location forwards the client scheme', () => {
	const locations = forge_nginx_locations();
	const proxying = locations
		.split(/^ {4}(?=location |# )/m)
		.filter((block) => block.includes('proxy_pass'));

	assert.ok(proxying.length >= 2, 'found the proxying blocks');
	for (const block of proxying) {
		const name = /location [^{]+/.exec(block)?.[0].trim();
		// Without it the daemon reads an HTTPS request as plaintext, which shows up
		// as wrong redirect URLs and wrong secure-cookie decisions rather than a
		// hard failure — so it goes unnoticed until someone reads the config.
		assert.ok(
			block.includes('proxy_set_header X-Forwarded-Proto $scheme;'),
			`${name} forwards X-Forwarded-Proto`
		);
	}
});

test('the forge locations declare no add_header', () => {
	// nginx drops every inherited `add_header` in a block that declares one of its
	// own, so a single header here would silently strip the server-level security
	// set (HSTS, X-Frame-Options, nosniff, Referrer-Policy, CSP) from that route.
	assert.ok(!forge_nginx_locations().includes('add_header'), 'no add_header');
});

test('the git location matches exactly the git route shape', () => {
	// nginx picks a matching regex over every plain prefix, `location /api`
	// included, so a git regex that also matched other `/api` paths would lift the
	// `/api` rate limit and body cap off them.
	const pattern = /location ~ (\S+\\\.git\S*) \{/.exec(forge_nginx_locations())?.[1];
	assert.ok(pattern, 'found the git location');
	const git_location = new RegExp(pattern);

	for (const path of [
		'/org/repo.git/info/refs',
		'/org/repo.git/git-receive-pack',
		'/api/repo.git/info/refs' // the git route for an org named `api`
	]) {
		assert.ok(git_location.test(path), `${path} reaches the git route`);
	}
	for (const path of [
		'/api/rpc/x.git/info/refs',
		'/api/fuz_forge/files/x.git/y',
		'/repo.git/info/refs',
		'/a/b/repo.git/info/refs',
		'/org/repo.git'
	]) {
		assert.ok(!git_location.test(path), `${path} stays off the git route`);
	}
});

test('the file store is a `^~` prefix so no regex location takes its paths', () => {
	assert.ok(forge_nginx_locations().includes('location ^~ /api/fuz_forge/files {'));
});
