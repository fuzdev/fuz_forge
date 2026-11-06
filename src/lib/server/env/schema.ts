/**
 * Environment variable schema for the fuz_forge backend.
 *
 * Extends the base server env schema with fuz_forge-specific fields.
 *
 * @module
 */

import { meta } from '@fuzdev/fuz_schema/meta.ts';
import { object, optional, string, with_default, type Infer } from '@fuzdev/fuz_schema/schema.ts';
import { BaseServerEnv } from '@fuzdev/fuz_app/server/env.ts';
import { env_integer, EnvStringbool } from '@fuzdev/fuz_app/env/env_schemas.ts';

/**
 * The fuz_forge server env: `BaseServerEnv`'s fields spread with the forge's
 * own, a strict `@fuzdev/fuz_schema` object. The integers read as the Rust
 * `FuzForgeEnv` reads them (`env_integer`, decimal digits after a trim and
 * at most one `+`).
 */
export const ServerEnv = object({
	...BaseServerEnv.def,
	/**
	 * Maximum upload size in bytes for the file store. Defaults to 10 GiB.
	 *
	 * Scoped to the `/api/fuz_forge/files` routes — the generic API/RPC surface
	 * keeps the spine's 1 MiB body cap (see `server/server.ts`'s scoped body-cap
	 * middleware). The upload handler owns this cap directly: a `Content-Length`
	 * pre-check rejects an over-cap upload before reading, and `put_stream`'s
	 * byte counter is the precise mid-stream backstop. The server streams both
	 * directions (`put_stream` on upload, a disk read stream on download), so
	 * this is a policy / disk-quota ceiling, not a memory guard. Matches the
	 * Rust backend's `DEFAULT_FILE_STORE_MAX_BYTES`.
	 */
	FUZ_FORGE_FILE_STORE_MAX_BYTES: meta(with_default(env_integer({ min: 1 }), 10 * 1024 ** 3), {
		description: 'Maximum upload size in bytes for the file store (default 10 GiB)'
	}),
	/**
	 * Free-space headroom in bytes the upload handler keeps beyond a declared
	 * upload. Defaults to 1 GiB.
	 *
	 * The per-request cap bounds a *single* upload; nothing bounds the
	 * *aggregate*, so N concurrent large uploads can fill the disk. The upload
	 * handler probes free space on the fact-store volume and rejects with `507
	 * storage_full` when `free < declared_content_length + margin` — keeping
	 * headroom for the DB, logs, and in-flight temps. `0` disables the margin
	 * (still rejects an upload larger than raw free space). Best-effort: the
	 * probe fails open (logs + proceeds) so a probe failure never rejects a
	 * valid upload — the mid-stream ENOSPC backstop is the real guarantee.
	 * Matches the Rust `DEFAULT_FILE_STORE_FREE_SPACE_MARGIN_BYTES`.
	 */
	FUZ_FORGE_FILE_STORE_FREE_SPACE_MARGIN_BYTES: meta(with_default(env_integer(), 1024 ** 3), {
		description:
			'Free-space headroom in bytes kept beyond a declared upload, else 507 storage_full (default 1 GiB, 0 disables)'
	}),
	/**
	 * Ceiling on concurrent streaming uploads. Defaults to 4. Must be `> 0`.
	 *
	 * A semaphore bounds how many uploads stream to disk at once — capping
	 * aggregate in-flight temp churn / file descriptors on top of the free-space
	 * preflight. Excess uploads wait for a permit rather than racing to fill the
	 * disk. Matches the Rust `DEFAULT_FILE_STORE_MAX_CONCURRENT_UPLOADS`.
	 */
	FUZ_FORGE_FILE_STORE_MAX_CONCURRENT_UPLOADS: meta(with_default(env_integer({ min: 1 }), 4), {
		description: 'Ceiling on concurrent streaming uploads to the file store (default 4)'
	}),
	/**
	 * Override for the on-disk fact-byte store (facts over 1 MiB).
	 *
	 * Layout: sharded `<root>/<shard>/<rest>` per fact — `<shard>` is the first
	 * 2 hex chars of the blake3 digest, `<rest>` the remaining 62 (the `file:`
	 * URL the `fact` row carries). Tilde-expanded via `resolve_tilde` at server
	 * startup; the resolved absolute path is passed to `PgFactStore` as
	 * `disk_root`. Unset → `<fuz_forge_home>/facts` (`fuz_forge_home`),
	 * so it follows `FUZ_FORGE_HOME`.
	 */
	FUZ_FORGE_FACT_STORE_PATH: meta(optional(string), {
		description: 'Override for the on-disk fact-byte store (default <FUZ_FORGE_HOME>/facts)'
	}),
	/**
	 * Override for the bare-git-repo store hosted by the forge.
	 *
	 * Layout: `<root>/<id>.git/` per repo created through `fuz_forge_repo_create`. Tilde-
	 * expanded at the read site (`repo_store_root`). Unset →
	 * `<fuz_forge_home>/repos` (`fuz_forge_home`), so it follows
	 * `FUZ_FORGE_HOME`.
	 */
	FUZ_FORGE_REPO_STORE_PATH: meta(optional(string), {
		description: 'Override for the bare-git-repo store (default <FUZ_FORGE_HOME>/repos)'
	}),
	/**
	 * Admit a `seed_from` upstream whose host is a loopback, link-local,
	 * unspecified, RFC 1918, carrier-grade NAT or ULA address (or `localhost`).
	 * Defaults to off.
	 *
	 * `fuz_forge_repo_create` hands `seed_from` to `git clone --bare` from the
	 * daemon's network position, so an unrestricted host is an admin-only SSRF
	 * into whatever that machine can reach. The default refuses those ranges at
	 * input validation (`seed_from_host_is_private`); an operator mirroring from
	 * a sibling host on their own LAN — or a test spawn seeding from a loopback
	 * upstream — turns it on. `EnvStringbool`'s closed set is the twin of the
	 * Rust `fuz_sys::env::parse_stringbool` `FuzForgeEnv::from_vars` parses it
	 * with, so one value means the same thing on both backends.
	 */
	FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS: meta(with_default(EnvStringbool, false), {
		description:
			'Admit a seed_from upstream on a loopback, link-local, or private-range host, a stringbool (default false)'
	})
});
export type ServerEnv = Infer<typeof ServerEnv>;
