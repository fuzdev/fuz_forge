/**
 * Repo identity primitives — `RepoSlug` and the `<id-or-slug>` lookup
 * shape.
 *
 * A forge repo's stable machine key is its cell's `id` (a `Uuid`). That
 * UUID is also the public handle: the admin browse URL segment
 * (`/admin/repos/<uuid>/log`), the on-disk bare-repo directory
 * (`<uuid>.git`), and the wire id every repo RPC accepts. It is
 * slash-free by construction, which is what the nested SvelteKit browse
 * routes require (rest params must be the final segment).
 *
 * The human identity is the `RepoSlug` (`org/repo`) — the clone-URL path
 * and `data.slug` on the cell. It is also mirrored into `cell.path` as
 * `repos/<slug>` so the global-unique path index enforces slug
 * uniqueness and gives an indexed slug→cell lookup.
 *
 * @module
 */

import {
	check,
	max_length,
	message,
	min_length,
	pipe,
	regex,
	string,
	to_lower_case,
	uuid,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

/**
 * Min length for one segment of a `RepoSlug`. Single-char names are
 * permitted — rare but legitimate (math notation, scratch buckets,
 * short codenames).
 */
export const REPO_SEGMENT_LENGTH_MIN = 1;

/** Max length for one segment of a `RepoSlug`. */
export const REPO_SEGMENT_LENGTH_MAX = 64;

/**
 * Shared character pattern for each half of a `RepoSlug`. Inspired by
 * `Username` in `@fuzdev/fuz_app`'s `primitive_schemas.ts` but stricter:
 *
 * - starts and ends with `[a-zA-Z0-9]`
 * - between: alphanumeric, or a single `-`/`_` followed by alphanumeric
 *   — no consecutive non-alphanumerics, no leading or trailing `-`/`_`
 *
 * Unanchored — callers anchor with `^` / `$` (or compose with `/`
 * between segments for the slug regex). Mixed-case input is allowed at
 * the schema level and canonicalized to lowercase via `to_lower_case`.
 */
const REPO_SEGMENT_PATTERN = '[a-zA-Z0-9](?:[a-zA-Z0-9]|[_-][a-zA-Z0-9])*';

/**
 * The wire/dir/URL handle for a forge repo: the cell's `id`, a UUID.
 *
 * Deliberately **unbranded** (it infers a plain `string`) — the id flows
 * through frontend route params, the typed RPC client, and the CLI as a bare
 * string, so a nominal brand would force casts at every boundary for no
 * safety win. The server casts to the package's branded `Uuid` only at the
 * `query_cell_get` seam.
 *
 * This schema **is the one repo-id wire grammar** on both backends:
 * fuz_schema's `uuid`, the grammar of `@fuzdev/fuz_app`'s `Uuid` — hyphenated
 * 8-4-4-4-12 hex with the RFC 9562 version nibble in 1-8 and variant in
 * `[89abAB]`, plus nil and max as special cases, the max in any case. Every
 * real repo cell id is a Postgres `gen_random_uuid()` v4, so the strictness
 * rejects nothing a legitimate flow produces. The Rust twin is
 * `fuz_forge_wire`'s `is_valid_repo_id`, enforced at the Rust server's id
 * ingresses so both backends refuse the same strings with the same `-32602`;
 * a grammar-valid but absent id (including nil/max) is `-32003` on both.
 * (`fuz_forge_wire`'s `looks_like_uuid` is looser on purpose — it is the
 * CLI's slug-vs-id disambiguator, not a validator.)
 *
 * Accepts either case and outputs lowercase, like `@fuzdev/fuz_app`'s `Uuid`:
 * lowercase is the form Postgres renders a `uuid` in, so a parsed id equals
 * the same id read back from the database — which matters wherever an id is
 * kept as a string rather than cast, as the token templates' `repo_ids`
 * become policy map keys matched against the cell's own id.
 */
export const RepoId = pipe(string, uuid, to_lower_case);
export type RepoId = Infer<typeof RepoId>;

/**
 * Public path segment for a forge repo's clone URL (`<slug>.git`) and the
 * canonical human identity. Lowercase-canonicalized. Exactly one `/`,
 * each side a slug segment.
 *
 * Mirrored into `cell.path` as `repos/<slug>`; the global-unique path
 * index makes the slug unique forge-wide.
 *
 * `fuzdev/fuz_app` and `org_1/repo-2` are conforming slugs.
 */
export const RepoSlug = pipe(
	pipe(
		string,
		min_length(REPO_SEGMENT_LENGTH_MIN * 2 + 1),
		max_length(REPO_SEGMENT_LENGTH_MAX * 2 + 1),
		message(
			regex(new RegExp(`^${REPO_SEGMENT_PATTERN}/${REPO_SEGMENT_PATTERN}$`)),
			'RepoSlug must be <segment>/<segment> with exactly one `/`; each segment is [a-zA-Z0-9] with optional single `-`/`_` between alphanumerics'
		)
	),
	// The whole-slug `max_length` above admits one oversized segment paired with a
	// short one (e.g. a 100-char half + a 1-char half is under 129); cap each
	// segment to match the canonical Rust `fuz_forge_wire` rule.
	message(
		check((s: string) =>
			s.split('/').every((segment) => segment.length <= REPO_SEGMENT_LENGTH_MAX)
		),
		`RepoSlug segment exceeds ${REPO_SEGMENT_LENGTH_MAX} chars`
	),
	to_lower_case
);
export type RepoSlug = Infer<typeof RepoSlug>;

/**
 * Recover the repo-name segment (the part after the `/`) from a slug.
 * `fuzdev/fuz_app` → `fuz_app`. The slug is already validated to contain
 * exactly one `/`, so this is total on a parsed `RepoSlug`.
 */
export const repo_name_from_slug = (slug: string): string => slug.slice(slug.indexOf('/') + 1);
