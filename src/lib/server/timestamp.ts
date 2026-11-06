/**
 * The forge's canonical wire timestamp shape.
 *
 * Every timestamp the forge writes to the wire is second-precision UTC —
 * `YYYY-MM-DDTHH:MM:SSZ`, exactly 20 characters. That is the shape the Rust
 * backend already emits from both of its sources: `fuz_db`'s
 * `iso8601_timestamp_column` (the `to_char` projection behind the repo DTO's
 * `created_at` / `updated_at` and the file store's `uploaded_at`) and
 * `fuz_sys::rfc3339_now` (`seed_completed_at`, `last_pushed_at`). This module
 * is the TS twin of that shape, so the two backends serialize the same instant
 * to the same bytes.
 * The spine's own surfaces (cells, auth, the audit log) project the same shape
 * from `@fuzdev/fuz_app`, so a stamp read off a `CellRow` goes to the wire as
 * read — this module is for the stamps the forge mints itself.
 *
 * @module
 */

/**
 * The canonical wire timestamp shape as a regex — second-precision UTC,
 * exactly 20 characters.
 *
 * Lives here rather than in a test helper so the unit suites, the db suites,
 * and the cross-backend suites all pin the same pattern the server renders.
 */
export const ISO8601_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Render a `Date` as the forge's canonical second-precision UTC wire
 * timestamp (`YYYY-MM-DDTHH:MM:SSZ`).
 *
 * Truncates rather than rounds, mirroring `fuz_sys::rfc3339_now`'s
 * "take the first 19 characters and append `Z`" and Postgres'
 * `to_char(… , 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`.
 */
export const to_iso8601_seconds = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;
