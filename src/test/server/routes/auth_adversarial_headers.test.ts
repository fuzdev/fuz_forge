/**
 * Adversarial header attack tests for the fuz_forge middleware stack.
 *
 * @module
 */

import { describe_standard_adversarial_headers } from '@fuzdev/fuz_app/testing/adversarial_headers.ts';

// Matches fuz_forge server.ts: trusted_proxies=['127.0.0.1','::1'], origins from env
const TRUSTED_PROXY = '127.0.0.1';
const ALLOWED_ORIGIN = 'https://forge.example.com';
const DEV_ORIGIN = 'http://localhost:5173';

// Production origin
describe_standard_adversarial_headers(
	'fuz_forge adversarial header attacks (production origin)',
	{
		trusted_proxies: [TRUSTED_PROXY, '::1'],
		allowed_origins: ALLOWED_ORIGIN,
		connection_ip: TRUSTED_PROXY
	},
	ALLOWED_ORIGIN
);

// Dev origin — verifies localhost dev origins work correctly
describe_standard_adversarial_headers(
	'fuz_forge adversarial header attacks (dev origin)',
	{
		trusted_proxies: [TRUSTED_PROXY, '::1'],
		allowed_origins: DEV_ORIGIN,
		connection_ip: TRUSTED_PROXY
	},
	DEV_ORIGIN
);
