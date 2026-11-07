//! The `seed_from` URL grammar and host policy for `fuz_forge_repo_create`.
//!
//! `seed_from` is handed straight to `git clone --bare` as the remote, so its
//! grammar is a security boundary rather than a nicety: git's transport set is
//! much wider than "an upstream on the web", and the value is recorded on the
//! repo cell as provenance. Two gates run in a fixed order on both backends —
//! grammar → canonicalize → host policy — and the validator returns the
//! **canonical serialization** so the host that was inspected is the host git
//! dials. See [`require_seed_from_url`] and [`seed_from_host_is_private`].
//!
//! Twin of `src/lib/fuz_forge/repo/seed_from.ts`; this side folds both gates
//! into one call, the operator override
//! (`FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS`) being reachable here.

use std::net::{Ipv4Addr, Ipv6Addr};

use fuz_http::{JsonrpcError, invalid_params};
use url::Url;

/// The one rejection message both sides raise for a malformed `seed_from`.
/// Deliberately a single string across every rejection reason: the reasons
/// are the same on both backends, but their *wording* would drift, and a
/// caller can only act on the grammar as a whole.
///
/// Only this backend puts it on the wire. On TS the grammar is a `check`
/// on the input schema and the dispatcher flattens every schema failure to a
/// bare `invalid params`, so the text reaches the client there only as a
/// DEV-mode `data.issues` entry. Both sides answer -32602, so that code is
/// the cross-backend contract; the text is not.
pub(super) const SEED_FROM_URL_MESSAGE: &str =
    "seed_from must be an absolute http(s) URL with a host and no embedded credentials";

/// Hold `seed_from` to the one URL grammar `git clone --bare` may be pointed
/// at — an absolute `http`/`https` URL with a non-empty host and no
/// userinfo — and return its **canonical serialization**.
///
/// The value is passed straight to `git clone --bare` as the remote, so the
/// grammar is a security boundary, not a nicety. Without it `file://` seeds
/// any bare repo on the host's disk into a served repo, and the alternate
/// transports (`ext::`, `ssh://`, `git://`) hand git a remote helper or an
/// unvetted protocol. Credentials are refused separately from the scheme
/// because `seed_from` is recorded on the repo cell as provenance — a
/// `user:pw@` remote would persist the secret into a readable row.
///
/// The canonical form is returned rather than a unit `Ok` because the WHATWG
/// parser and git do not agree on every input.
/// `https://example.invalid\user:pw@evil.invalid/x.git` parses here as host
/// `example.invalid` with no userinfo — the backslash is a path separator —
/// while git/curl treat `\` as ordinary and would dial `evil.invalid` with
/// `example.invalid\user:pw` as credentials. Callers must store and clone
/// what this returns, so the host that was validated is the host git dials.
///
/// Twin of the `seed_from_url_canonical` `check` on
/// `FuzForgeRepoCreateInput` in `src/lib/action_specs.ts` (TS canonicalizes
/// in the handler right after parse, since a schema `transform` there
/// would blank the input schema out of the generated attack surface). Both
/// sides parse with a WHATWG URL parser (`url::Url` here, `new URL()`
/// there), so scheme and host arrive lowercase-canonicalized, IDNA hosts
/// arrive punycoded, and the two agree on every spelling — the shared case
/// tables are `src/test/fixtures/parity/seed_from_url.json` and
/// `…/seed_from_host_policy.json`, asserted by this module's tests and by
/// `src/test/fuz_forge/repo/seed_from.test.ts`.
///
/// The host **range** policy runs last, once the value is canonical, so the
/// address judged is the address git dials — see
/// [`seed_from_host_is_private`]. `allow_private_hosts` is the operator
/// override (`FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS`, off by default); when
/// set, the policy is not consulted at all.
///
/// The three gates run in a fixed order on both backends — grammar →
/// canonicalize → host policy — so an off-grammar value is refused as a
/// grammar failure whatever its host.
///
/// # Errors
///
/// [`invalid_params`] (-32602) when a present value is not such a URL, or when
/// its host is private and the override is off.
pub(super) fn require_seed_from_url(
    value: Option<&str>,
    allow_private_hosts: bool,
) -> Result<Option<String>, JsonrpcError> {
    let Some(value) = value else { return Ok(None) };
    let reject = || invalid_params(&format!("invalid params: {SEED_FROM_URL_MESSAGE}"), None);
    let url = Url::parse(value).map_err(|_| reject())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(reject());
    }
    let Some(host) = url.host_str().filter(|h| !h.is_empty()) else {
        return Err(reject());
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err(reject());
    }
    if !allow_private_hosts && seed_from_host_is_private(host) {
        return Err(invalid_params(
            &format!("invalid params: {SEED_FROM_HOST_MESSAGE}"),
            None,
        ));
    }
    Ok(Some(url.as_str().to_owned()))
}

/// The one rejection message both sides raise for a `seed_from` whose host is
/// private. Single-string for the same reason as [`SEED_FROM_URL_MESSAGE`]:
/// the ranges are identical on both backends, their wording would drift, and a
/// caller can only act on the policy as a whole.
///
/// Unlike the grammar message, this one reaches the wire on **both** backends:
/// the TS twin raises it from the handler (where the dispatcher forwards a
/// thrown error's message) rather than from the input schema, so the `-32602`
/// envelope is byte-identical.
pub(super) const SEED_FROM_HOST_MESSAGE: &str =
    "seed_from must not name a loopback, link-local, unspecified, or private-range host";

/// Whether an IPv4 address falls in a range the seed policy refuses.
fn ipv4_is_private(addr: Ipv4Addr) -> bool {
    let [a, b, c, d] = addr.octets();
    a == 127 // loopback 127/8
        || (a == 169 && b == 254) // link-local 169.254/16
        || a == 10 // RFC 1918 10/8
        || (a == 172 && (16..=31).contains(&b)) // RFC 1918 172.16/12
        || (a == 192 && b == 168) // RFC 1918 192.168/16
        || (a == 100 && (64..=127).contains(&b)) // CGNAT 100.64/10
        || (a == 0 && b == 0 && c == 0 && d == 0) // unspecified 0.0.0.0
}

/// Whether an IPv6 address falls in a range the seed policy refuses.
fn ipv6_is_private(addr: Ipv6Addr) -> bool {
    // IPv4-mapped `::ffff:a.b.c.d` decides on the embedded IPv4, so a mapped
    // spelling of a refused v4 literal is refused too.
    if let Some(mapped) = addr.to_ipv4_mapped() {
        return ipv4_is_private(mapped);
    }
    let g = addr.segments();
    addr.is_unspecified() // ::
        || addr.is_loopback() // ::1
        || (g[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (g[0] & 0xfe00) == 0xfc00 // ULA fc00::/7
}

/// Whether a canonical `seed_from` host names the daemon's own machine or a
/// network only it can reach.
///
/// `seed_from` is handed to `git clone --bare` from the daemon's network
/// position, so an unrestricted host is an admin-only SSRF into whatever the
/// host can reach — a cloud metadata endpoint (`169.254.169.254`), a sibling
/// service on loopback, a LAN-internal admin panel. Refusing the ranges below
/// is the default; an operator who wants LAN mirrors sets
/// `FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS` and this predicate stops being
/// consulted.
///
/// Refused: loopback (127/8, `::1`), link-local (169.254/16, fe80::/10),
/// unspecified (0.0.0.0, `::`), RFC 1918 (10/8, 172.16/12, 192.168/16), CGNAT
/// (100.64/10), ULA (fc00::/7), IPv4-mapped IPv6 spellings of any of those, and
/// the RFC 6761 `localhost` name — the bare label and anything under the
/// reserved `.localhost` TLD, with or without a trailing root dot. The TLD half
/// matters: a stock Debian resolver answers `evil.localhost` with `::1`, so the
/// bare-label check alone would admit a loopback dial.
///
/// **Only literals and `localhost`.** This is a check on the URL's host text,
/// not a DNS resolution: a name that resolves into a refused range —
/// `127.0.0.1.nip.io`, a `localtest.me` subdomain, an operator's own internal
/// record — is admitted here and reaches git. Closing that means resolving the
/// name and pinning the connection to the resolved address, which git's own
/// transport does not expose; the honest boundary is the literal.
///
/// Twin of `seed_from_host_is_private` in
/// `src/lib/fuz_forge/repo/seed_from.ts`; `host` is
/// [`Url::host_str`] on a canonicalized URL, so IPv6 arrives bracketed and
/// every IPv4 spelling has already collapsed to dotted-quad.
fn seed_from_host_is_private(host: &str) -> bool {
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return inner.parse::<Ipv6Addr>().is_ok_and(ipv6_is_private);
    }
    if let Ok(addr) = host.parse::<Ipv4Addr>() {
        return ipv4_is_private(addr);
    }
    // RFC 6761 reserves `localhost` and the whole `.localhost` TLD for the
    // loopback interface, and resolvers honor it — a stock Debian answers
    // `evil.localhost` with `::1` — so the subdomain form is refused alongside
    // the bare label. A single trailing root dot is the same name either way.
    let name = host.strip_suffix('.').unwrap_or(host);
    name == "localhost" || name.ends_with(".localhost")
}

#[cfg(test)]
mod tests;
