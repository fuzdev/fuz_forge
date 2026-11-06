import type { Gen } from '@fuzdev/gro';

import { create_fuz_forge_app_surface_spec } from './auth_attack_surface_helpers.ts';

export const gen: Gen = () => {
	return JSON.stringify(create_fuz_forge_app_surface_spec().surface);
};
