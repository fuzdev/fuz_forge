/**
 * API route specs for the fuz_forge file store.
 *
 * Upload, download, list, and delete files. **Cell-primary**: file metadata
 * lives in a `cell` at the globally unique path `files/<filename>` with the
 * top-level `cell.kind = 'file'`; bytes live in the content-addressed `FactStore`
 * (embedded or disk-backed by size). The cell and the fact are the only two
 * records a file has — the Rust forge (`crates/fuz_forge_server/src/files/handlers.rs`)
 * is the twin of these handlers and both speak the same cell + fact contract.
 *
 * The file cell carries the BLAKE3 fact hash (for content addressing +
 * `extract_refs`), the file's only digest; a download sends it as the
 * `X-Blake3-Hash` header. No transaction spans the fact-store + cell boundary.
 *
 * ## Authority
 *
 * Every **per-file** route funnels through `enforce_capability`, which resolves
 * the two per-token axes in one place: the forge's resource-bound policy when
 * the token has one, and the spine's `api_token.scope` when it does not. The
 * list route is the one exception, by design: it filters to the readable set
 * rather than refusing, so it takes the scope half through `enforce_surface`
 * and applies `policy_check` per entry. See `fuz_forge_token_surfaces.ts` for
 * why a whole-surface refusal would be the wrong gate here.
 *
 * @module
 */

import type { Context } from 'hono';
import { define_route, type RouteSpec } from '@fuzdev/fuz_app/http/route_spec.ts';
import {
	route_fail,
	route_ok,
	route_raw,
	type RouteFailOf
} from '@fuzdev/fuz_app/http/route_result.ts';
import {
	array,
	boolean,
	literal,
	loose_object,
	object,
	string,
	unknown
} from '@fuzdev/fuz_schema/schema.ts';
import {
	ERROR_PAYLOAD_TOO_LARGE,
	REST_INVALID_ROUTE_PARAMS,
	REST_TOKEN_SCOPE_REQUIRED,
	rest_error
} from '@fuzdev/fuz_app/http/error_schemas.ts';
import { ActingActor, type Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { require_request_context } from '@fuzdev/fuz_app/auth/request_context.ts';
import type { QueryDeps } from '@fuzdev/fuz_app/db/query_deps.ts';
import type { JsonObject } from '@fuzdev/fuz_util/json.ts';
import type { AsyncSemaphore } from '@fuzdev/fuz_util/async.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import type { HeldFactStore } from '@fuzdev/fuz_app/db/fact_store.ts';
import { FACT_HASH_PREFIX, is_fact_hash, type FactHash } from '@fuzdev/fuz_util/hash_schemas.ts';
import {
	FactPayloadTooLargeError,
	FactStorageFullError
} from '@fuzdev/fuz_app/db/fact_store_errors.ts';
import { free_space_bytes, has_sufficient_free_space } from '../free_space.ts';
import {
	enforce_capability,
	enforce_surface,
	get_request_policy,
	REST_FORBIDDEN
} from '../fuz_forge_token_policy_middleware.ts';
import { policy_check } from '../fuz_forge_token_policy.ts';
import { SURFACE_FILE_STORE } from '../fuz_forge_token_surfaces.ts';
import {
	query_cell_create,
	query_cell_delete,
	query_cell_get_by_path,
	query_cell_update
} from '@fuzdev/fuz_app/db/cell_queries.ts';
import { query_addressed_cells_by_kind } from '../db/fuz_forge_cell_queries.ts';
import { first_query_param, raw_query_of } from '../query_params.ts';
import type { FileMetaOutput } from '../../fuz_forge/file_meta.ts';

/** The code of a file-store miss: no file at the key, or its bytes are gone. */
export const ERROR_FILE_NOT_FOUND = 'file_not_found';

/** The code of an upload whose body is empty. */
export const ERROR_EMPTY_BODY = 'empty_body';

/** The code of an upload refused for disk space, before or while streaming. */
export const ERROR_STORAGE_FULL = 'storage_full';

/** A file-store miss, at 404. */
export const REST_FILE_NOT_FOUND = rest_error(404, ERROR_FILE_NOT_FOUND, { message: string });

/** An upload with an empty body, at 400. */
export const REST_EMPTY_BODY = rest_error(400, ERROR_EMPTY_BODY, { message: string });

/**
 * An upload over `max_upload_bytes`, at 413 — fuz_app's `payload_too_large`
 * code, with the cap in `message`. The upload route is outside the generic
 * body cap, so this is the only 413 it answers.
 */
export const REST_FILE_TOO_LARGE = rest_error(413, ERROR_PAYLOAD_TOO_LARGE, { message: string });

/** An upload the fact-store volume can't hold, at 507. */
export const REST_STORAGE_FULL = rest_error(507, ERROR_STORAGE_FULL);

/** The answer to a file-store miss, the body every per-file route shares. */
const file_not_found = (): RouteFailOf<typeof REST_FILE_NOT_FOUND> =>
	route_fail(REST_FILE_NOT_FOUND, { message: 'File not found' });

/** The answer to an upload with an empty body. */
const empty_body = (): RouteFailOf<typeof REST_EMPTY_BODY> =>
	route_fail(REST_EMPTY_BODY, { message: 'Empty body' });

/** The answer to an upload over `max_upload_bytes`. */
const file_too_large = (message: string): RouteFailOf<typeof REST_FILE_TOO_LARGE> =>
	route_fail(REST_FILE_TOO_LARGE, { message });

/** Dependencies for file store routes. */
export interface FileRoutesDeps {
	query_deps: QueryDeps;
	max_upload_bytes: number;
	/**
	 * Content-addressed fact substrate — file bytes live here. Held, so every
	 * upload records the acting admin as the bytes' holder (cell ref admission).
	 */
	fact_store: HeldFactStore;
	/**
	 * Disk root backing the fact store (`env.FUZ_FORGE_FACT_STORE_PATH`), for the
	 * free-space preflight. `undefined` (embedded-only, no disk overflow) skips
	 * the preflight — there's no volume whose free space to probe.
	 */
	disk_root?: string;
	/**
	 * Free-space headroom (bytes) kept beyond a declared upload — the upload is
	 * rejected with `507 storage_full` when `free < declared + margin`. The
	 * per-request cap bounds one upload; this bounds the *aggregate* so
	 * concurrent uploads can't fill the disk to zero.
	 */
	free_space_margin_bytes: number;
	/**
	 * Bounds how many uploads stream to disk concurrently — a permit is held
	 * across `put_stream`, so excess uploads wait rather than racing to fill the
	 * disk (caps aggregate in-flight temp churn on top of the preflight).
	 */
	upload_semaphore: AsyncSemaphore;
	/** Logged on the free-space-probe-rejected + probe-failed-open paths. */
	log: Pick<Logger, 'warn'>;
}

/**
 * The acting actor's id on a route declared `actor: 'required'`.
 *
 * The dispatcher's authorization phase resolves the actor before the handler
 * runs, so a missing one is a wiring bug — thrown rather than read as `null`,
 * which would record an upload with no holder or a delete with no `deleted_by`.
 * The Rust twin's `resolve_acting_actor` returns a bare `Uuid`, so it has no
 * such state.
 *
 * @param c - the Hono context of an `actor: 'required'` route
 * @returns the acting actor's id
 * @throws Error if the request context carries no actor (dispatcher misconfiguration)
 */
const require_acting_actor_id = (c: Context): Uuid => {
	const { actor } = require_request_context(c);
	if (!actor) {
		throw new Error(
			"require_acting_actor_id: no acting actor on an `actor: 'required'` route — is the dispatcher authorization phase wired?"
		);
	}
	return actor.id;
};

/**
 * Cell `data` shape for a file. BLAKE3 string is set explicitly so
 * `extract_refs` lifts it into `cell.refs` for reverse-lookup ("which
 * cells reference this fact?").
 *
 * Extends `JsonObject` so the literal is directly assignable to
 * `cell.data: Json` without a cast.
 */
interface FileCellData extends JsonObject {
	content_type: string;
	size: number;
	blake3: FactHash;
}

/**
 * Global `cell.path` prefix for file-store cells. A file's cell lives at
 * `${FILE_PATH_PREFIX}${filename}` — the prefix keeps file paths from
 * colliding with other cell kinds (e.g. repos) now that `path` is
 * globally unique rather than hub-scoped.
 */
const FILE_PATH_PREFIX = 'files/';

/** Build the canonical `cell.path` for a file from its filename. */
const file_cell_path = (filename: string): string => `${FILE_PATH_PREFIX}${filename}`;

/** Recover the bare filename from a file cell's prefixed `cell.path`. */
const filename_from_cell_path = (path: string): string =>
	path.startsWith(FILE_PATH_PREFIX) ? path.slice(FILE_PATH_PREFIX.length) : path;

/** Allowed key charset — `[A-Za-z0-9._/-]`, matching `validate_forge_key`. */
const FILE_KEY_CHARSET = /^[A-Za-z0-9._/-]+$/;

/**
 * Traversal-safe filename validation — the TS twin of Rust's
 * `fuz_storage::validate_forge_key`. Allows interior `/` (the release layout is
 * path-structured, `tools/<name>/<version>/...`); rejects empty, over-length
 * (>512), absolute (leading `/`), trailing `/`, empty / `.` / `..` /
 * leading-dot segments, and out-of-charset keys. Both backends must accept and
 * reject the same keys (cross-backend parity).
 *
 * Filenames here are DB cell-path keys (`files/<filename>`), not filesystem
 * paths — bytes are content-addressed by blake3 in the `FactStore` — so this is
 * key hygiene + producer parity, not an FS-escape defense (there is no
 * filename-derived filesystem path to traverse).
 */
const is_valid_file_key = (key: string): boolean => {
	if (key.length === 0 || key.length > 512) return false;
	if (key.startsWith('/') || key.endsWith('/')) return false;
	for (const segment of key.split('/')) {
		if (segment.length === 0) return false;
		if (segment === '.' || segment === '..') return false;
		if (segment.startsWith('.')) return false;
	}
	return FILE_KEY_CHARSET.test(key);
};

/**
 * Create the file store API route specs.
 *
 * File metadata cells live at the globally unique `files/<filename>`
 * path with the top-level `cell.kind = 'file'`; there is no hub to resolve.
 */
export const create_file_route_specs = (deps: FileRoutesDeps): Array<RouteSpec> => {
	const {
		query_deps,
		max_upload_bytes,
		fact_store,
		disk_root,
		free_space_margin_bytes,
		upload_semaphore,
		log
	} = deps;

	return [
		// POST /:filename{.+} — upload a file (admin, not keeper — stores bytes, doesn't execute).
		// Catch-all param so path-structured keys (`tools/<name>/...`) match.
		define_route({
			method: 'POST',
			path: '/:filename{.+}',
			auth: { account: 'required', actor: 'required', roles: ['admin'] },
			description: 'Upload a file to the file store',
			input: literal(null),
			raw_body: true,
			query: object({ acting: ActingActor }),
			output: loose_object({ filename: string }),
			// the handler reads the filename param itself (no `params` schema)
			errors: [
				REST_INVALID_ROUTE_PARAMS,
				REST_EMPTY_BODY,
				REST_TOKEN_SCOPE_REQUIRED,
				REST_FORBIDDEN,
				REST_FILE_TOO_LARGE,
				REST_STORAGE_FULL
			],
			// The fact-store and cell writes can't share a single PG transaction
			// (the fact bytes may land on a different substrate), so skip the
			// framework's auto-transaction wrap and run the mutations directly.
			transaction: false,
			handler: async (c) => {
				const filename = c.req.param('filename');
				if (!filename || !is_valid_file_key(filename)) {
					return route_fail(REST_INVALID_ROUTE_PARAMS);
				}

				const denied = enforce_capability(c, { kind: 'files.write', filename }, SURFACE_FILE_STORE);
				if (denied) return denied;

				// Reject an over-cap upload from the declared `Content-Length` before
				// reading a byte — the cheap, common path. `put_stream`'s byte counter
				// is the backstop for a chunked / mis-declared length. A missing or
				// non-numeric header is `NaN` (never `> max`), so chunked uploads pass
				// here and rely on the mid-stream counter.
				const declared_content_length = parse_content_length(c.req.header('Content-Length'));
				if (declared_content_length !== null && declared_content_length > max_upload_bytes) {
					return file_too_large(
						`File too large: ${declared_content_length} bytes exceeds ${max_upload_bytes} byte limit`
					);
				}

				// the acting admin: stamped on the cell write and recorded as the
				// fact's holder, which cell ref admission reads — resolved before the
				// permit so a request without one never takes or waits on a permit
				const actor_id = require_acting_actor_id(c);

				// Bound concurrent streaming uploads: hold a permit across the
				// preflight + `put_stream` so at most `max_concurrent_uploads` stream
				// to disk at once. Taken after the cheap rejects above so an over-cap
				// or actorless upload doesn't consume a permit. `try`/`finally` releases
				// it on every exit (success, 413, 507, throw).
				await upload_semaphore.acquire();
				try {
					// Disk-budget preflight: reject before streaming when the volume
					// wouldn't hold the declared upload plus the configured headroom
					// (`507 storage_full`). Best-effort + fail-open — no-op without both
					// a disk root and a declared length; a probe failure proceeds.
					const budget = await check_disk_budget(
						disk_root,
						declared_content_length,
						free_space_margin_bytes,
						log
					);
					if (!budget) {
						return route_fail(REST_STORAGE_FULL);
					}

					const content_type = infer_content_type(filename);
					const cell_path = file_cell_path(filename);

					// Look up the existing cell before streaming so the post-stream
					// blake3 decides Created / Updated / Unchanged. The hash isn't known
					// until the stream ends, so (unlike a buffering handler) an
					// unchanged re-upload streams-then-dedups rather than
					// short-circuiting up front — the CAS dedups the bytes; only the
					// cell write is skipped.
					const existing = await query_cell_get_by_path(query_deps, cell_path);
					const existing_data = existing ? narrow_file_cell_data(existing.data) : null;

					// Stream the body into the fact store: bounded memory,
					// content-addressed, cap enforced mid-stream. An absent body (e.g. a
					// GET-shaped request) is treated as an empty upload → 400 below.
					const body = c.req.raw.body ?? empty_stream();
					let outcome;
					try {
						outcome = await fact_store.put_stream(body, max_upload_bytes, {
							content_type,
							refs: [],
							holder: actor_id
						});
					} catch (err) {
						if (err instanceof FactPayloadTooLargeError) {
							return file_too_large(`File too large: exceeds ${max_upload_bytes} byte limit`);
						}
						// Mid-stream disk-full (ENOSPC) — the backstop for what the
						// free-space preflight can't catch (chunked uploads, TOCTOU races).
						if (err instanceof FactStorageFullError) {
							return route_fail(REST_STORAGE_FULL);
						}
						throw err;
					}

					if (outcome.size === 0) {
						return empty_body();
					}

					const blake3_hash = outcome.hash.slice(FACT_HASH_PREFIX.length);

					// Idempotent: identical bytes → no cell write (the fact deduped).
					if (existing_data?.blake3 === outcome.hash) {
						return route_ok({
							filename,
							blake3_hash,
							size_bytes: outcome.size,
							content_type,
							status: 'unchanged'
						});
					}

					const cell_data: FileCellData = {
						content_type,
						size: outcome.size,
						blake3: outcome.hash
					};

					let status: 'created' | 'updated';
					if (existing) {
						await query_cell_update(query_deps, existing.id, {
							data: cell_data,
							updated_by: actor_id
						});
						status = 'updated';
					} else {
						await query_cell_create(query_deps, {
							path: cell_path,
							data: cell_data,
							// `kind` is the write-once top-level `cell.kind` column — not a
							// `data` field (a `kind` inside `data` is rejected upstream).
							kind: 'file',
							created_by: actor_id
						});
						status = 'created';
					}

					return route_ok({
						filename,
						blake3_hash,
						size_bytes: outcome.size,
						content_type,
						status
					});
				} finally {
					upload_semaphore.release();
				}
			}
		}),

		// GET / — list all files. Distinct path from the catch-all `/:filename{.+}`
		// (which needs ≥1 trailing segment), so no shadowing.
		define_route({
			method: 'GET',
			path: '/',
			auth: { account: 'required', actor: 'none' },
			description: 'List all files in the file store',
			input: literal(null),
			output: loose_object({ files: array(unknown) }),
			errors: [REST_TOKEN_SCOPE_REQUIRED],
			handler: async (c) => {
				// Ahead of the listing query, matching every other route's
				// refuse-before-work placement: a token with no policy row has
				// nothing to filter *by*, so it is refused outright rather than
				// shown everything (which is what the policy-less branch used to
				// do) — and it should not cost a full store enumeration to be told.
				const denied = enforce_surface(c, SURFACE_FILE_STORE);
				if (denied) return denied;

				// TODO: unbounded — the whole `file` kind is read into memory and
				// serialized as one response, so a store of N files costs N rows
				// and N metadata objects per list call. Bounding it is a
				// **product** change, not an internal one: the store is the
				// namespace, so a page cap would silently hide files from a
				// client that asked for the list, and paging needs a cursor on
				// the wire, in `fuzf file list`, and on both backends at once.
				// Revisit when a real store outgrows one response. Twin TODO:
				// `crates/fuz_forge_server/src/files/handlers.rs`. Only cells at a
				// path: a pathless `file` cell is no entry, and the scan never loads
				// one (`query_addressed_cells_by_kind`).
				const cells = await query_addressed_cells_by_kind(query_deps, 'file');

				const merged: Array<FileMetaOutput> = [];
				for (const cell of cells) {
					if (!cell.path) continue;
					const file_data = narrow_file_cell_data(cell.data);
					if (!file_data) continue;
					merged.push(
						file_meta_view(
							filename_from_cell_path(cell.path),
							file_data,
							cell.updated_at ?? cell.created_at
						)
					);
				}

				// Byte/codepoint order, not locale collation — file keys are ASCII
				// (`FILE_KEY_CHARSET`), so this is identical to the Rust twin's
				// `str::cmp` (UTF-8 byte order) in `files/handlers.rs`. `localeCompare` would
				// diverge (it reorders case and punctuation per the runtime locale).
				merged.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));

				// Scoped tokens see only entries their policy permits to read.
				// Filter rather than 403 — list is the entry point CLIs use to
				// discover what they CAN read. The scope half already ran above.
				const policy = get_request_policy(c);
				const visible = policy
					? merged.filter((entry) =>
							policy_check(policy, { kind: 'files.read', filename: entry.filename })
						)
					: merged;
				return route_ok({ files: visible });
			}
		}),

		// GET /:filename{.+} — download a file, or (with `?meta`) its metadata JSON.
		// One handler for both: they share the `files.read` gate, validation, and
		// cell lookup; `?meta` only flips whether the bytes are fetched. The
		// metadata endpoint can't be a `/:filename/meta` suffix because the Rust
		// twin's axum 0.8 catch-all must be terminal, so it rides as a query param
		// on the same GET (keeping one validation + capability path, no drift).
		define_route({
			method: 'GET',
			path: '/:filename{.+}',
			auth: { account: 'required', actor: 'none' },
			description: 'Download a file (or its metadata with ?meta) from the file store',
			input: literal(null),
			// The `?meta` branch returns JSON (validated in DEV); the download branch
			// returns raw bytes (non-JSON → output validation skips it).
			output: loose_object({ filename: string }),
			// the handler reads the filename param itself (no `params` schema)
			errors: [
				REST_INVALID_ROUTE_PARAMS,
				REST_TOKEN_SCOPE_REQUIRED,
				REST_FORBIDDEN,
				REST_FILE_NOT_FOUND
			],
			handler: async (c) => {
				const filename = c.req.param('filename')!;
				if (!is_valid_file_key(filename)) {
					return route_fail(REST_INVALID_ROUTE_PARAMS);
				}

				const denied = enforce_capability(c, { kind: 'files.read', filename }, SURFACE_FILE_STORE);
				if (denied) return denied;

				const cell = await query_cell_get_by_path(query_deps, file_cell_path(filename));
				const file_data = cell ? narrow_file_cell_data(cell.data) : null;
				if (!cell || !file_data) {
					return file_not_found();
				}

				// `?meta`: metadata only — no fact-store byte fetch. Presence
				// selects the branch whatever the value (a bare `?meta` reads as
				// the empty string), and any other key is ignored. Read off the
				// raw query rather than through `c.req.query`, which is not
				// WHATWG form-urlencoded — the same convergence the git route's
				// `?service=` made, and what lets the Rust twin drop its axum
				// `Query<T>` extractor (whose pre-auth 400 on a duplicate key
				// had no counterpart here).
				if (first_query_param(raw_query_of(c.req.raw.url), 'meta') !== undefined) {
					return route_ok(file_meta_view(filename, file_data, cell.updated_at ?? cell.created_at));
				}

				const bytes = await fact_store.get(file_data.blake3);
				if (!bytes) {
					return file_not_found();
				}

				// `Content-Length` is intentionally NOT set here: the body is a
				// fully-buffered `Uint8Array`, so every runtime derives the length
				// from it (Deno's `Response`, `@hono/node-server`, `Bun.serve`).
				// Setting it manually produced a *duplicate* `Content-Length` under
				// `@hono/node-server`: it lowercases the supplied header to
				// `content-length` then re-adds `Content-Length` from `byteLength`,
				// and Node's `writeHead` emits both keys — which the bench's undici
				// client (Node `fetch`) rejects as an HTTP/1.1 protocol violation.
				// TODO: remove double cast when Deno and Node BodyInit types align on Uint8Array
				return route_raw(
					new Response(bytes as unknown as BodyInit, {
						headers: {
							'Content-Type': file_data.content_type,
							'Content-Disposition': `attachment; filename="${filename}"`,
							'X-Blake3-Hash': file_data.blake3.slice(FACT_HASH_PREFIX.length)
						}
					})
				);
			}
		}),

		// DELETE /:filename{.+} — delete a file (admin, not keeper — data management, not execution)
		define_route({
			method: 'DELETE',
			path: '/:filename{.+}',
			auth: { account: 'required', actor: 'required', roles: ['admin'] },
			description: 'Delete a file from the file store',
			input: literal(null),
			query: object({ acting: ActingActor }),
			output: loose_object({ deleted: boolean }),
			// the handler reads the filename param itself (no `params` schema)
			errors: [
				REST_INVALID_ROUTE_PARAMS,
				REST_TOKEN_SCOPE_REQUIRED,
				REST_FORBIDDEN,
				REST_FILE_NOT_FOUND
			],
			// Matches POST — fact-store + cell mutations are not wrapped in one
			// transaction. See POST's `transaction: false` comment.
			transaction: false,
			handler: async (c) => {
				const filename = c.req.param('filename')!;
				if (!is_valid_file_key(filename)) {
					return route_fail(REST_INVALID_ROUTE_PARAMS);
				}

				const denied = enforce_capability(
					c,
					{ kind: 'files.delete', filename },
					SURFACE_FILE_STORE
				);
				if (denied) return denied;

				const cell = await query_cell_get_by_path(query_deps, file_cell_path(filename));
				if (!cell) {
					return file_not_found();
				}

				// Soft-delete the cell; the fact is intentionally left in the
				// store (the forge runs no sweep of unreferenced facts).
				const actor_id = require_acting_actor_id(c);
				await query_cell_delete(query_deps, cell.id, { deleted_by: actor_id });

				return route_ok({ deleted: true, filename });
			}
		})
	];
};

/**
 * The shared file-metadata projection — served by the `?meta` branch and each
 * list entry, so the shape is single-sourced (no drift between the two). Its
 * type is `FileMetaOutput` (`fuz_forge/file_meta.ts`), which the admin
 * dashboard reads back. The Rust twin hand-writes the same shape once, as
 * `FileMetaOutput` in the `fuz_forge_wire` crate, which its server constructs
 * (`FileCellData::to_meta_output`) and its `fuzf` client deserializes; the
 * cross-backend file suite holds this literal and that struct to the same key
 * set. Note the upload response is a *different* shape: it carries `status`
 * and no `uploaded_at`.
 */
const file_meta_view = (
	filename: string,
	file_data: FileCellData,
	uploaded_at: string
): FileMetaOutput => ({
	filename,
	blake3_hash: file_data.blake3.slice(FACT_HASH_PREFIX.length),
	size_bytes: file_data.size,
	content_type: file_data.content_type,
	// Both backends read this column as the canonical second-precision string
	// — the Rust twin through `iso8601_timestamp_column`, the cell layer here.
	uploaded_at
});

/**
 * Narrow a cell's `data` JSON to `FileCellData`. Returns `null`
 * when any required field is missing or the wrong type — read handlers
 * treat that as a file miss (404).
 */
const narrow_file_cell_data = (data: unknown): FileCellData | null => {
	if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.content_type !== 'string') return null;
	if (typeof d.size !== 'number') return null;
	if (typeof d.blake3 !== 'string' || !is_fact_hash(d.blake3)) return null;
	return d as unknown as FileCellData;
};

/** Infer content type from filename extension. */
const infer_content_type = (filename: string): string => {
	if (filename.endsWith('.tar.xz')) return 'application/x-xz';
	if (filename.endsWith('.tar.gz') || filename.endsWith('.tgz')) return 'application/gzip';
	if (filename.endsWith('.zip')) return 'application/zip';
	if (filename.endsWith('.png')) return 'image/png';
	if (filename.endsWith('.ts')) return 'text/typescript';
	if (filename.endsWith('.json')) return 'application/json';
	return 'application/octet-stream';
};

/**
 * Parse a declared `Content-Length` header to a non-negative integer, or `null`
 * when absent / non-numeric (a chunked upload sends none). `null` skips the
 * cheap over-cap pre-check + the free-space preflight, deferring to the
 * mid-stream byte counter / ENOSPC backstop.
 */
const parse_content_length = (header: string | undefined): number | null => {
	if (header === undefined) return null;
	const n = Number(header);
	return Number.isInteger(n) && n >= 0 ? n : null;
};

/**
 * Free-space preflight — `true` to proceed, `false` to reject with `507
 * storage_full`. The TS twin of the Rust `check_disk_budget`.
 *
 * No-op (`true`) without both a `disk_root` *and* a declared `Content-Length` —
 * a chunked upload relies on the mid-stream ENOSPC backstop instead. The probe
 * **fails open**: `free_space_bytes` returns `null` on any probe failure, which
 * is logged and treated as proceed (the backstop still catches a real ENOSPC,
 * and a valid upload isn't rejected because the probe couldn't run). Rejects
 * only when the probe succeeds AND `free < declared + margin`.
 */
const check_disk_budget = async (
	disk_root: string | undefined,
	declared_content_length: number | null,
	margin_bytes: number,
	log: Pick<Logger, 'warn'>
): Promise<boolean> => {
	if (disk_root === undefined || declared_content_length === null) return true;
	const free = await free_space_bytes(disk_root);
	if (free === null) {
		log.warn(
			'files.upload free-space preflight probe failed; proceeding (ENOSPC backstop applies)'
		);
		return true;
	}
	if (has_sufficient_free_space(free, declared_content_length, margin_bytes)) return true;
	log.warn(
		`files.upload rejected: insufficient disk space (free=${free} declared=${declared_content_length} margin=${margin_bytes})`
	);
	return false;
};

/** An already-closed empty byte stream — stand-in for an absent request body. */
const empty_stream = (): ReadableStream<Uint8Array> =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		}
	});
