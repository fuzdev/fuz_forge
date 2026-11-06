/**
 * fuz_forge session configuration.
 *
 * @module
 */

import { create_session_config } from '@fuzdev/fuz_app/auth/session_cookie.ts';

export const fuz_forge_session_config = create_session_config('fuz_forge_session');
