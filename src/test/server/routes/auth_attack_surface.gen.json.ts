import type { Gen } from '@fuzdev/gro';

import { create_fuz_forge_app_surface_spec } from './auth_attack_surface_helpers.ts';

export const gen: Gen = () => {
	// tab-indented so a surface change reads as a reviewable diff
	return JSON.stringify(create_fuz_forge_app_surface_spec().surface, null, '\t') + '\n';
};
