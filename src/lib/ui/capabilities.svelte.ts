/**
 * Capabilities detection for the fuz_forge admin dashboard.
 *
 * Three probes, each in its own `AsyncSlot`: the public `/health`
 * reachability check, the authenticated `/api/server/status` build report,
 * and the authenticated `/api/db/health` database report. One slot per
 * request is what keeps them independent — a failed probe surfaces its own
 * error, retries on its own, and neither hides nor blocks the other two.
 * The only ordering left is the real dependency: an unreachable backend
 * makes the two authenticated probes pointless, so `init` skips them.
 *
 * @module
 */

import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';
import { AsyncSlot } from '@fuzdev/fuz_app/ui/async_slot.svelte.ts';
import { parse_response_error, ui_fetch } from '@fuzdev/fuz_app/ui/ui_fetch.ts';
import { probe_backend } from '@fuzdev/fuz_app/ui/backend_probe.svelte.ts';

/**
 * Svelte context for Capabilities.
 */
export const capabilities_context = create_context<Capabilities>();

/**
 * Success payload of the public `/health` probe.
 */
export interface BackendInfo {
	/** Round-trip milliseconds of the `/health` request. */
	response_time: number;
}

/**
 * Success payload of the authenticated `/api/server/status` probe.
 */
export interface ServerInfo {
	version: string | null;
	uptime_ms: number | null;
}

/**
 * Success payload of the authenticated `/api/db/health` probe.
 */
export interface DatabaseInfo {
	type: 'postgres' | null;
	name: string | null;
	table_count: number | null;
}

/**
 * Whether a probe is worth (re)running: it has never run, or its last run
 * failed. A pending or successful slot is left alone — re-running a pending
 * one would abort it through `AsyncSlot`'s supersession.
 */
const probe_needs_check = <T>(slot: AsyncSlot<T>): boolean => slot.initial || slot.failed;

/**
 * System capabilities detection and tracking.
 *
 * Usage:
 * ```svelte
 * <script>
 *   const capabilities = new Capabilities();
 *   onMount(() => capabilities.init());
 * </script>
 *
 * {#if capabilities.backend.succeeded}
 *   {@render children?()}
 * {:else if capabilities.backend.loading}
 *   <p>Connecting...</p>
 * {:else}
 *   <p>Backend unavailable: {capabilities.backend.error}</p>
 * {/if}
 * ```
 */
export class Capabilities {
	/**
	 * Backend reachability, via the public `/health` endpoint.
	 */
	readonly backend = new AsyncSlot<BackendInfo>();

	/**
	 * Server build details, via the account-authenticated
	 * `/api/server/status` endpoint.
	 */
	readonly server = new AsyncSlot<ServerInfo>();

	/**
	 * Database details, via the account-authenticated `/api/db/health`
	 * endpoint.
	 */
	readonly database = new AsyncSlot<DatabaseInfo>();

	/**
	 * Wall-clock time of the last settled `check_backend`, or `null` before
	 * the first. `AsyncSlot` tracks status, not when a run resolved, and the
	 * dashboard shows a "last checked" stamp for a failed attempt as well as
	 * a successful one.
	 */
	backend_checked_at: number | null = $state(null);

	/** Wall-clock time of the last settled `check_server`. See `backend_checked_at`. */
	server_checked_at: number | null = $state(null);

	/** Wall-clock time of the last settled `check_database`. See `backend_checked_at`. */
	database_checked_at: number | null = $state(null);

	/**
	 * Whether the backend is available and responding.
	 */
	readonly backend_available = $derived(this.backend.succeeded);

	/**
	 * Run every probe that hasn't succeeded yet. Idempotent: an already
	 * successful or in-flight probe is skipped, a failed one is retried.
	 */
	async init(): Promise<void> {
		if (probe_needs_check(this.backend)) await this.check_backend();
		// The two protected probes are pointless against an unreachable
		// backend — their own 4xx/network errors would just restate this one.
		if (!this.backend.succeeded) return;
		await Promise.all([
			probe_needs_check(this.server) ? this.check_server() : null,
			probe_needs_check(this.database) ? this.check_database() : null
		]);
	}

	/**
	 * Check backend reachability via the public `/health` endpoint — only the
	 * health reply counts, never a static fallback's HTML.
	 */
	async check_backend(): Promise<void> {
		const start = performance.now();
		await this.backend.run(async (signal) => {
			const result = await probe_backend({ signal });
			const response_time = Math.round(performance.now() - start);
			if (!result.ok) throw new Error(result.error);
			return { response_time };
		});
		this.backend_checked_at = Date.now();
	}

	/**
	 * Fetch server details (version, uptime) from the protected
	 * `/api/server/status` endpoint.
	 */
	async check_server(): Promise<void> {
		await this.server.run(async (signal) => {
			const res = await ui_fetch('/api/server/status', { signal });
			if (!res.ok) throw new Error(await parse_response_error(res, `HTTP ${res.status}`));
			const data = await res.json();
			return { version: data.version ?? null, uptime_ms: data.uptime_ms ?? null };
		});
		this.server_checked_at = Date.now();
	}

	/**
	 * Check database availability via the protected `/api/db/health` endpoint.
	 */
	async check_database(): Promise<void> {
		await this.database.run(async (signal) => {
			const res = await ui_fetch('/api/db/health', { signal });
			if (!res.ok) throw new Error(await parse_response_error(res, `HTTP ${res.status}`));
			const data = await res.json();
			return {
				type: data.type ?? null,
				name: data.name ?? null,
				table_count: data.table_count ?? null
			};
		});
		this.database_checked_at = Date.now();
	}
}
