/**
 * The `seed_from` URL grammar for `fuz_forge_repo_create`.
 *
 * `seed_from` is handed straight to `git clone --bare` as the remote, so its
 * grammar is a security boundary rather than a nicety. Git's transport set is
 * much wider than "an upstream on the web": a `file://` seed imports any bare
 * repo on the host's disk into a served repo, and `ext::`/`ssh://`/`git://`
 * hand git a remote helper or an unvetted protocol from the daemon's network
 * position. The value is also recorded on the repo cell as provenance — in its
 * canonical form, see below — which is why userinfo is refused separately from
 * the scheme: a `user:pw@` remote would persist the secret into a readable
 * row.
 *
 * The validator **returns the canonical serialization**, not a boolean,
 * because the WHATWG parser and git's own URL handling do not agree on every
 * input. `https://example.invalid\user:pw@evil.invalid/x.git` parses here as
 * host `example.invalid` with no userinfo — the backslash is a path
 * separator — while git/curl treat `\` as an ordinary character and would
 * dial `evil.invalid` with `example.invalid\user:pw` as credentials. Passing
 * the raw string on would mean validating one authority and contacting
 * another. Storing and cloning the *serialized* URL closes that by
 * construction: the host this module inspected is the host git dials.
 *
 * The grammar is one of two gates and runs first. The second is the **host
 * policy** — `seed_from_host_is_private` — which refuses a canonicalized host
 * naming the daemon's own machine or a network only it can reach, unless the
 * operator sets `FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS`. The order is
 * grammar → canonicalize → host policy on both backends, so an off-grammar
 * value is refused as a grammar failure whatever its host.
 *
 * The Rust twin is `require_seed_from_url` in
 * `crates/fuz_forge_server/src/handlers/seed_from.rs` (which folds both
 * gates into one call, the flag being reachable there). Both sides parse
 * with a WHATWG URL parser (`new URL()` here, `url::Url` there), so scheme and
 * host arrive lowercase-canonicalized, IP literals arrive in one spelling
 * apiece, IDNA hosts arrive punycoded, and the two agree on every input;
 * both unit suites read the shared accept/reject/canonicalized/host cases
 * from `src/test/fixtures/parity/seed_from_url.json` and
 * `seed_from_host_policy.json`.
 *
 * @module
 */

/**
 * The one rejection message both sides raise for a malformed `seed_from`.
 * Deliberately a single string across every rejection reason: the reasons are
 * identical on both backends, but their wording would drift, and a caller can
 * only act on the grammar as a whole.
 *
 * Only the Rust backend puts it on the wire. On TS the grammar is a
 * `check` on the input schema, and the dispatcher flattens every schema
 * failure to a bare `invalid params` — this message reaches the client only
 * as a DEV-mode `data.issues` entry. Both sides answer `-32602`, so that code
 * is the cross-backend contract; the text is not.
 */
export const SEED_FROM_URL_MESSAGE =
	'seed_from must be an absolute http(s) URL with a host and no embedded credentials';

/**
 * Canonicalize a `seed_from` URL, or refuse it.
 *
 * Accepts only what `git clone --bare` may be pointed at: an absolute
 * `http`/`https` URL with a non-empty host and no userinfo. The return value
 * is the parser's serialization (`URL.href`) — lowercased scheme and host,
 * punycoded IDNA, backslashes resolved as path separators — and *that* string
 * is what callers must store on the cell and hand to git, so the authority
 * this function admitted is the authority git contacts.
 *
 * The host *range* policy is a second, separable gate —
 * `seed_from_host_is_private`, applied by the caller after this
 * function has canonicalized the value, so the host it judges is the host git
 * dials.
 *
 * @param value - the raw `seed_from` string off the wire
 * @returns the canonical URL, or `null` when the value is not an absolute
 * credential-free http(s) URL
 */
export const seed_from_url_canonical = (value: string): string | null => {
	let url;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (!url.hostname) return null;
	if (url.username || url.password) return null;
	return url.href;
};

/**
 * The one rejection message both sides raise for a `seed_from` whose host is
 * private. Single-string for the same reason as `SEED_FROM_URL_MESSAGE`:
 * the ranges are identical on both backends, their wording would drift, and a
 * caller can only act on the policy as a whole.
 *
 * Unlike the grammar message, this one reaches the wire on **both** backends:
 * the refusal is raised from the handler on TS (the dispatcher forwards a
 * thrown error's message) and from `require_seed_from_url` on Rust, so the
 * `-32602` envelope is byte-identical. The code is still the contract; the
 * text is not.
 */
export const SEED_FROM_HOST_MESSAGE =
	'seed_from must not name a loopback, link-local, unspecified, or private-range host';

/*
 * Identifier parity with the Rust twin is partial here, and deliberately so.
 * Three of the five helpers below are true twins —
 * `seed_from_host_is_private`, `ipv4_is_private`, `ipv6_is_private` carry the
 * same names and the same range tables on both sides. The other two,
 * `ipv4_octets` and `ipv6_groups`, have **no** Rust counterpart: Rust reaches
 * the same octets and groups through `Ipv4Addr::from_str` / `Ipv6Addr::from_str`
 * + `Ipv6Addr::segments` from `std::net`, so these two exist only to give the
 * TS side the parsed form the standard library hands Rust for free. Adding
 * matching Rust wrappers would be parity theater over `std`.
 */

/** The eight 16-bit groups of an IPv6 address, once expanded. */
type Ipv6Groups = [number, number, number, number, number, number, number, number];

/** The four octets of an IPv4 address. */
type Ipv4Octets = [number, number, number, number];

/** Narrow a parsed group list to the fixed IPv6 width. */
const is_ipv6_groups = (groups: Array<number>): groups is Ipv6Groups => groups.length === 8;

/** Narrow a parsed octet list to the fixed IPv4 width. */
const is_ipv4_octets = (octets: Array<number>): octets is Ipv4Octets => octets.length === 4;

/**
 * Expand a canonical IPv6 serialization into its eight 16-bit groups, or
 * `null` when the text is not one.
 *
 * The input is always a WHATWG URL parser's `hostname` with its brackets
 * stripped, so it is lowercase hex with at most one `::` run and no zone id or
 * embedded dotted-quad tail (`::ffff:127.0.0.1` serializes as
 * `::ffff:7f00:1`). Stands in for Rust's `Ipv6Addr::from_str` +
 * `Ipv6Addr::segments`; it is not a named twin — see the note above.
 */
const ipv6_groups = (text: string): Ipv6Groups | null => {
	const halves = text.split('::');
	if (halves.length > 2) return null;
	const to_groups = (part: string): Array<number> | null => {
		if (!part) return [];
		const groups: Array<number> = [];
		for (const token of part.split(':')) {
			if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
			groups.push(parseInt(token, 16));
		}
		return groups;
	};
	const head = to_groups(halves[0] ?? '');
	const tail = halves.length === 2 ? to_groups(halves[1] ?? '') : [];
	if (head === null || tail === null) return null;
	if (halves.length === 1) return is_ipv6_groups(head) ? head : null;
	const gap = 8 - head.length - tail.length;
	if (gap < 1) return null;
	const expanded = [...head, ...Array.from({ length: gap }, () => 0), ...tail];
	return is_ipv6_groups(expanded) ? expanded : null;
};

/**
 * Split a dotted-quad IPv4 serialization into its four octets, or `null` when
 * the text is not one.
 *
 * Strict decimal, no leading zeros — the shape a WHATWG parser emits, and the
 * shape Rust's `Ipv4Addr::from_str` accepts. Stands in for that call rather
 * than twinning a Rust function — see the note above. The parser has already
 * folded the octal / hex / integer spellings (`0177.0.0.1`, `2130706433`) into
 * this one, so the policy never sees them.
 */
const ipv4_octets = (text: string): Ipv4Octets | null => {
	const parts = text.split('.');
	if (parts.length !== 4) return null;
	const octets: Array<number> = [];
	for (const part of parts) {
		if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		octets.push(octet);
	}
	return is_ipv4_octets(octets) ? octets : null;
};

/** Whether an IPv4 address falls in a range the seed policy refuses. */
const ipv4_is_private = ([a, b, c, d]: Ipv4Octets): boolean =>
	a === 127 || // loopback 127/8
	(a === 169 && b === 254) || // link-local 169.254/16
	a === 10 || // RFC 1918 10/8
	(a === 172 && b >= 16 && b <= 31) || // RFC 1918 172.16/12
	(a === 192 && b === 168) || // RFC 1918 192.168/16
	(a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
	(a === 0 && b === 0 && c === 0 && d === 0); // unspecified 0.0.0.0

/** Whether an IPv6 address falls in a range the seed policy refuses. */
const ipv6_is_private = (groups: Ipv6Groups): boolean => {
	const head_zero = groups.slice(0, 5).every((g) => g === 0);
	// IPv4-mapped `::ffff:a.b.c.d` decides on the embedded IPv4, so a mapped
	// spelling of a refused v4 literal is refused too.
	if (head_zero && groups[5] === 0xffff) {
		return ipv4_is_private([groups[6] >>> 8, groups[6] & 0xff, groups[7] >>> 8, groups[7] & 0xff]);
	}
	return (
		// unspecified `::` and loopback `::1` — the Rust twin's
		// `is_unspecified() || is_loopback()`, folded since they differ only in
		// the last group.
		(head_zero && groups[5] === 0 && groups[6] === 0 && groups[7] <= 1) ||
		(groups[0] & 0xffc0) === 0xfe80 || // link-local fe80::/10
		(groups[0] & 0xfe00) === 0xfc00 // ULA fc00::/7
	);
};

/**
 * Whether a canonical `seed_from` host names the daemon's own machine or a
 * network only it can reach.
 *
 * `seed_from` is handed to `git clone --bare` from the daemon's network
 * position, so an unrestricted host is an admin-only SSRF into whatever the
 * host can reach — a cloud metadata endpoint (`169.254.169.254`), a sibling
 * service on loopback, a LAN-internal admin panel. Refusing the ranges below
 * is the default; an operator who wants LAN mirrors sets
 * `FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS` and this predicate stops being
 * consulted.
 *
 * Refused: loopback (127/8, `::1`), link-local (169.254/16, fe80::/10),
 * unspecified (0.0.0.0, `::`), RFC 1918 (10/8, 172.16/12, 192.168/16), CGNAT
 * (100.64/10), ULA (fc00::/7), IPv4-mapped IPv6 spellings of any of those, and
 * the RFC 6761 `localhost` name — the bare label and anything under the
 * reserved `.localhost` TLD, with or without a trailing root dot. The TLD half
 * matters: a stock Debian resolver answers `evil.localhost` with `::1`, so the
 * bare-label check alone would admit a loopback dial.
 *
 * **Only literals and `localhost`.** This is a check on the URL's host text,
 * not a DNS resolution: a name that resolves into a refused range —
 * `127.0.0.1.nip.io`, a `localtest.me` subdomain, an operator's own internal
 * record — is admitted here and reaches git. Closing that means resolving the
 * name and pinning the connection to the resolved address, which git's own
 * transport does not expose; the honest boundary is the literal.
 *
 * @param host - the `hostname` of a canonicalized `seed_from` URL, as
 * `seed_from_url_canonical` produced it (IPv6 still bracketed)
 * @returns whether the policy refuses this host when the operator override is off
 */
export const seed_from_host_is_private = (host: string): boolean => {
	if (host.startsWith('[') && host.endsWith(']')) {
		const groups = ipv6_groups(host.slice(1, -1));
		return groups !== null && ipv6_is_private(groups);
	}
	const octets = ipv4_octets(host);
	if (octets !== null) return ipv4_is_private(octets);
	// RFC 6761 reserves `localhost` and the whole `.localhost` TLD for the
	// loopback interface, and resolvers honor it — a stock Debian answers
	// `evil.localhost` with `::1` — so the subdomain form is refused alongside
	// the bare label. A single trailing root dot is the same name either way.
	const name = host.endsWith('.') ? host.slice(0, -1) : host;
	return name === 'localhost' || name.endsWith('.localhost');
};
