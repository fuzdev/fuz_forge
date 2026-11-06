/**
 * Path resolution utilities.
 *
 * Deno's filesystem APIs don't expand shell tilde (`~`),
 * so paths from environment variables need explicit resolution.
 *
 * @module
 */

import type { EnvDeps } from '@fuzdev/fuz_app/runtime/deps.ts';

/**
 * Expand a leading `~` to the given home directory.
 *
 * Only expands `~` at the start of the path (before `/` or end of string).
 * Does not handle `~user` syntax. Returns the path unchanged if `home` is undefined.
 */
export const resolve_tilde = (path: string, home: string | undefined): string => {
	if (!home || !path.startsWith('~')) return path;
	if (path === '~') return home;
	if (path[1] === '/') return home.replace(/\/+$/, '') + path.slice(1);
	return path; // ~user or ~other — don't expand
};

/**
 * Resolve the fuz_forge home — the single base directory every other
 * fuz_forge state path defaults under (CLI config/token/cache, the server's
 * fact + repo stores). `FUZ_FORGE_HOME` overrides it (tilde-expanded);
 * otherwise it is `${HOME}/.fuz_forge`.
 *
 * Mirrors the `FUZ_HOME` / `ZAP_HOME` overrides the sibling `fuz` and `zap`
 * tools already expose. Setting one var (e.g. `FUZ_FORGE_HOME=$PWD/.fuz_forge`)
 * relocates an entire forge environment, so dev and prod never collide on
 * `~/.fuz_forge/`. The bootstrap token path is deliberately *not* derived from
 * this base — an unset `FUZ_BOOTSTRAP_TOKEN_PATH` disables bootstrap, a
 * conscious on/off rather than a defaulted-on path (see `server/server.ts`).
 *
 * @returns absolute base dir, or `~/.fuz_forge` literal when `$HOME` is unset
 */
export const fuz_forge_home = (deps: Pick<EnvDeps, 'env_get'>): string => {
	const override = deps.env_get('FUZ_FORGE_HOME');
	if (override) return resolve_tilde(override, deps.env_get('HOME'));
	return resolve_tilde('~/.fuz_forge', deps.env_get('HOME'));
};
