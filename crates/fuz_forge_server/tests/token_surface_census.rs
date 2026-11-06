//! **`fuz_forge`'s surface census (Rust)** — every site in the forge backend
//! that turns request headers into a credential, or decides whether a surface
//! gate applies to one, classified with a stated reason.
//!
//! ## Why this test exists
//!
//! The spine carries a census of its own
//! (`fuz_auth/tests/token_scope_surface_census.rs`), it is exact over the
//! spine's surfaces, and it is **structurally blind to a consumer's**. A
//! consumer can mount its own bearer-reachable routes, and it can re-auth a
//! shipped one into bearer reach. The forge does both. Each consumer carries
//! its own census; this is the forge's Rust half, twinned with
//! `src/test/server/fuz_forge_token_surfaces.census.test.ts`.
//!
//! ## What it pins
//!
//! Not "someone deleted a check" — **"someone added a surface and never asked
//! the question."** A new bearer-reachable axum route that resolves a
//! credential and never consults its scope is a silent hole, and it is
//! invisible without a grep. So the set of such sites is an assertion, and the
//! reason on each row is the artifact the test exists to produce.
//!
//! The scan is broader than the spine's front door — the `AuthGate` methods,
//! `.check_origin(` / `.preflight(` / `.resolve_credential(` /
//! `.public_request_context(` — because the forge reaches a credential three
//! ways: through that gate (`route_auth`), by validating an api token directly
//! (git smart-HTTP mounts outside the spine's middleware, so it has no resolver
//! to call), and by *choosing a `required_scope`* at a gate call site — which
//! is a decision about a credential's scope even in a file that never reads
//! one. It also names the raw primitives the gate is built from
//! (`parse_session_from_cookies`, `query_session_get_valid`,
//! `validate_daemon_token`), which no forge site calls: a handler assembled
//! from them would bypass the gate, so it has to answer a census row.
//!
//! ## The two axes, and which governs
//!
//! The forge's resource-bound `fuz_forge_api_token_policy` (`policy_check`)
//! stays: it answers *which repos, which filenames*, the vocabulary the spine
//! deliberately has none for. It is not a layer the scope gate stacks on top
//! of — which axis governs depends on the token. A token minted by
//! `fuz_forge_token_create_scoped` has a policy row and is governed by it; its
//! spine scope is `Methods(∅)` by construction, so a blanket whole-surface
//! refusal would refuse every token that feature exists to issue. A token
//! minted through the spine's own `account_token_create` has **no policy row**,
//! `policy_check(None, …)` returns `true`, and only its scope is left to
//! answer. See [`fuz_forge_server::token_surfaces`].

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests panic on assertion failure by design"
)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use fuz_auth::SurfaceCapability;
use fuz_forge_server::token_surfaces::{
    FUZ_FORGE_TOKEN_SURFACES, SURFACE_DB_ADMIN, SURFACE_FILE_STORE, SURFACE_GIT_HTTP,
};

/// How a reviewed site relates to the credential's token scope.
#[derive(PartialEq, Eq)]
enum CensusRole {
    /// Reads the scope and refuses what it does not admit, or names the
    /// surface a gate is applied under.
    Consults,
    /// Reaches a credential but applies no scope gate — reason required.
    Exempt,
}

/// A reviewed site.
struct CensusEntry {
    /// Path relative to `crates/`.
    file: &'static str,
    role: CensusRole,
    /// Why — required in both directions, so an exemption is an argument
    /// someone wrote down rather than a question nobody asked.
    reason: &'static str,
}

/// Every site in the forge backend that reaches a credential or decides about
/// its scope.
///
/// Adding a row here is the review. A new bearer-reachable surface must decide
/// which side it is on **and say why**.
const CENSUS: &[CensusEntry] = &[
    // --- Consults scope ---
    CensusEntry {
        file: "fuz_forge_server/src/files/handlers.rs",
        role: CensusRole::Consults,
        reason: "`enforce_surface` is the file store's one scope gate — \
                 `enforce_capability` calls it ahead of the resource check on the \
                 per-file routes, and the list route calls it directly, since it \
                 filters rather than 403s and a token with no policy row has \
                 nothing to filter by. One branch, so the two cannot drift and \
                 the source pin below covers both",
    },
    CensusEntry {
        file: "fuz_forge_server/src/forge_git/auth.rs",
        role: CensusRole::Consults,
        reason: "git smart-HTTP mounts outside the spine middleware and validates \
                 the api token itself, so `check_repo_capability` resolves both \
                 axes there — carrying the scope on `GitAuthOk` because nothing \
                 else on the request holds it",
    },
    // --- Exempt, with reasons ---
    CensusEntry {
        file: "fuz_forge_server/src/files/mod.rs",
        role: CensusRole::Exempt,
        reason: "the auth wrappers behind the handlers above; they resolve the \
                 credential and gate the role, and the surface decision is made \
                 where the policy is read, since it is conditional on that row",
    },
    CensusEntry {
        file: "fuz_forge_server/src/router/compose.rs",
        role: CensusRole::Exempt,
        reason: "`GET /api/server/status` resolves a credential and applies no \
                 surface gate — fuz_app ships that route shape ungated and the TS \
                 backend mounts it unchanged, so gating it here would be the forge \
                 diverging from a shipped gate on the spine's own route, which is \
                 the drift this census exists to catch. If a build version + uptime \
                 read should be closed to narrowed tokens, that is an upstream call",
    },
    CensusEntry {
        file: "fuz_forge_server/src/route_auth.rs",
        role: CensusRole::Exempt,
        reason: "the shared front-door-plus-role helper: `require_auth` runs the \
                 gate's `preflight` (the origin check, then the credential walk), \
                 `require_admin_role` the role gate. It applies no surface gate \
                 because it cannot: the forge's two surfaces need the \
                 `fuz_forge_api_token_policy` row to know which authority axis \
                 governs, so they gate where that row is read",
    },
];

/// Files the scan sees that hold no credential of their own.
///
/// An explicit list rather than a filter in the walker, so the exclusions are as
/// reviewable as the inclusions.
const NON_SURFACE_SITES: &[&str] = &[
    // The capability vocabulary itself — it declares the names every gate above
    // is written in, exactly as the spine census parks `auth/token_scope.ts`.
    "fuz_forge_server/src/token_surfaces.rs",
    // This census.
    "fuz_forge_server/tests/token_surface_census.rs",
];

/// A file that must contain each of `sources` verbatim.
///
/// Exact-match, not "does this file mention the helper". An import that outlives
/// the call it was added for still satisfies a mention — which is how the first
/// draft of this test would have passed with both gates deleted, since the
/// unused `use` lines remained. The strings below are the branch and the
/// argument, so deleting either fails here.
struct SurfaceSite {
    /// Path relative to `crates/`.
    file: &'static str,
    sources: &'static [&'static str],
}

/// Which forge sources gate each surface, empty when the spine mounts it.
///
/// Two shapes, because there are two kinds of surface here. The file store and
/// git smart-HTTP are the forge's own routes and the forge gates them. The
/// db-admin browser is the spine's `fuz_db_admin` router, **mounted unchanged**
/// on this backend — its `route_auth` carries the gate, so there is no forge
/// site to pin and the constant exists only for the census to name.
///
/// That asymmetry with the TS backend is the point rather than an oversight: the
/// TS backend re-auths the same routes to admin-any-credential for the dashboard
/// and therefore must declare the surface itself. Recording it here is what
/// keeps "Rust needs no site" an argument rather than an absence.
///
/// **A surface takes as many pins as it has gated entry points.** The file store
/// routes its per-file gate and its list gate through one `enforce_surface`
/// branch, which stops the two from drifting — but a pin on that branch alone
/// stays green when the list route's *call* is deleted. Reachability is
/// per-call-site; sharing a branch is not the same as being reached through it.
const SURFACE_SITES: &[(SurfaceCapability, &[SurfaceSite])] = &[
    (SURFACE_DB_ADMIN, &[]),
    (
        SURFACE_FILE_STORE,
        &[SurfaceSite {
            file: "fuz_forge_server/src/files/handlers.rs",
            sources: &[
                // The shared branch.
                "if token_scope_admits_forge_surface(policy, auth.scope()) {",
                // Reached by the per-file routes through `enforce_capability`.
                "enforce_surface(auth, policy)?;",
                // …and directly by the list route, which filters rather than
                // 403s and so has no capability check to carry the gate for it.
                "enforce_surface(&auth, policy.as_ref())?;",
            ],
        }],
    ),
    (
        SURFACE_GIT_HTTP,
        &[SurfaceSite {
            file: "fuz_forge_server/src/forge_git/auth.rs",
            sources: &["if !token_scope_admits_forge_surface(auth.policy.as_ref(), &auth.scope) {"],
        }],
    ),
];

/// The ways a site reaches a resolved credential, or decides about one.
const CREDENTIAL_MARKERS: &[&str] = &[
    // The spine's front door: the `AuthGate` methods, the only way outside
    // `fuz_auth` to read a credential off request headers.
    ".check_origin(",
    ".preflight(",
    ".resolve_credential(",
    ".public_request_context(",
    // The raw credential primitives the gate is built from — a cookie parse, a
    // session-row lookup, a daemon-token compare. A handler that assembles its
    // own resolution out of them reaches a credential with no origin check and
    // no scope in sight, so each is a marker although no forge site calls one.
    "parse_session_from_cookies(",
    "query_session_get_valid(",
    "validate_daemon_token(",
    // Git smart-HTTP has no resolver to call and validates the token directly.
    "query_validate_api_token(",
    // The rule-3 predicate.
    "admits_non_rpc_surface(",
    // Passing a `required_scope` (or deliberately passing `None`) is a decision
    // about a credential's scope even in a file that never reads one.
    "require_admin_role(",
    "require_auth(",
    // Naming a forge surface.
    "SURFACE_",
];

fn crates_dir() -> PathBuf {
    // `CARGO_MANIFEST_DIR` is `<repo>/crates/fuz_forge_server`.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates dir")
        .to_path_buf()
}

/// Blank whole-line `//` comments, keeping the line structure.
///
/// Discovery asks "does this file reach a credential", and without this a file
/// that merely *writes about* the rule — the mint's doc naming
/// `admits_non_rpc_surface` to explain what a template's scope implies, a `//`
/// note on why a gate lives elsewhere — reads exactly like one that implements
/// it. The answer is then a census row demanded of prose, or a file parked in an
/// exclusion list because of a sentence, and both make the census describe the
/// comments rather than the code.
///
/// **Line-leading only, and deliberately not the TS twin's regex.** That one
/// also strips `/* … */`, which is unsafe over this crate's source: a route
/// literal can open a block comment the scanner then runs to the end of the
/// file, dropping every credential marker below it out of discovery — the one
/// failure direction this census cannot tolerate. Such literals are a property
/// of route-shaped source, not of one file — the spine's boot-only warning
/// (`"boot-only mode (no /api/*, no /ready)"`, whose `/*` is the opener) is
/// one, and `fuz_auth`'s census twin guards the same case — so the hazard
/// holds wherever the markers happen to live. A trailing
/// `// see admits_non_rpc_surface()` survives instead and merely demands a
/// census row, which fails loud. The TS twin has the same hazard on its own
/// `'/api/*'` literals and runs the same line-oriented shape, keyed off
/// `//`, `/*`, and the ` * ` continuation a doc block carries there.
fn strip_comment_lines(source: &str) -> String {
    source
        .lines()
        .map(|line| {
            if line.trim_start().starts_with("//") {
                ""
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The stripper drops prose and keeps code — including code that only *looks*
/// like a comment opener. See [`strip_comment_lines`] for what the `/*` case
/// cost before it was line-leading.
#[test]
fn the_stripper_drops_prose_and_keeps_code() {
    let stripped = strip_comment_lines(concat!(
        "/// a doc comment naming require_auth(\n",
        "    // a leading note naming require_auth(\n",
        "    let msg = \"boot-only mode (no /api/*)\";\n",
        "    require_auth(&headers); // a trailing note\n",
    ));
    assert_eq!(
        stripped.matches("require_auth(").count(),
        1,
        "prose about a marker must not read as the marker, but the call must survive",
    );
    assert!(
        stripped.contains("no /api/*"),
        "a route-glob literal must survive intact — reading its `/*` as a comment \
         opener is what silently swallowed a whole file",
    );
}

/// Walk `crates/` for `.rs` files whose source matches a predicate, by path
/// relative to `crates/`.
fn discover_rs_files(matches: impl Fn(&str) -> bool) -> BTreeSet<String> {
    let root = crates_dir();
    let mut found = BTreeSet::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // Skip build output; it contains generated copies.
                if path.file_name().is_some_and(|n| n == "target") {
                    continue;
                }
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let Ok(text) = std::fs::read_to_string(&path) else {
                    continue;
                };
                if !matches(&strip_comment_lines(&text)) {
                    continue;
                }
                found.insert(
                    path.strip_prefix(&root)
                        .expect("under crates/")
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    found
}

fn discover_credential_sites() -> BTreeSet<String> {
    discover_rs_files(|text| CREDENTIAL_MARKERS.iter().any(|m| text.contains(m)))
}

/// Every credential-reaching site is reviewed.
///
/// Failing here means a surface was added that reaches an authenticated identity
/// without anyone deciding whether the credential's scope applies. Add a
/// [`CensusEntry`] — and if the answer is "exempt", write the reason, because
/// that reason is the artifact this test exists to produce.
#[test]
fn every_credential_site_is_reviewed() {
    let discovered = discover_credential_sites();
    let reviewed: BTreeSet<String> = CENSUS
        .iter()
        .map(|e| e.file.to_owned())
        .chain(NON_SURFACE_SITES.iter().map(|s| (*s).to_owned()))
        .collect();

    let unreviewed: Vec<&String> = discovered.difference(&reviewed).collect();
    assert!(
        unreviewed.is_empty(),
        "unreviewed credential-reaching sites — each must decide whether the token \
         scope applies, and say why (see this test's module docs): {unreviewed:#?}",
    );

    let vanished: Vec<&String> = reviewed.difference(&discovered).collect();
    assert!(
        vanished.is_empty(),
        "census names sites that no longer reach a credential — a stale entry makes \
         the census read as covering more than it does: {vanished:#?}",
    );
}

/// Every census entry carries a reason, in both directions.
///
/// An exemption without an argument is indistinguishable from an oversight;
/// this is what keeps the exempt rows from becoming a place to park things.
#[test]
fn every_census_entry_states_its_reasoning() {
    for entry in CENSUS {
        assert!(
            entry.reason.len() > 20,
            "{} needs a real reason, not a placeholder",
            entry.file,
        );
    }
}

/// The scope-consulting set is exactly the two surfaces the forge owns — an
/// exact list, so *narrowing* it fails here too, not just widening it.
#[test]
fn the_scope_consulting_set_is_the_expected_one() {
    let mut consulting: Vec<&str> = CENSUS
        .iter()
        .filter(|e| e.role == CensusRole::Consults)
        .map(|e| e.file)
        .collect();
    consulting.sort_unstable();
    assert_eq!(
        consulting,
        [
            "fuz_forge_server/src/files/handlers.rs",
            "fuz_forge_server/src/forge_git/auth.rs",
        ],
    );
}

/// Every surface the forge names is gated where the map says, and every gating
/// site is censused as consulting.
///
/// The source half is the assertion that would catch a gate that is *imported
/// and documented but never reached* — the shape of the spine's own first
/// token-scoping miss, where the rule-3 predicate was exported with a docstring
/// asserting the rule while nothing called it.
#[test]
fn every_named_surface_reaches_its_gate() {
    let consulting: BTreeSet<&str> = CENSUS
        .iter()
        .filter(|e| e.role == CensusRole::Consults)
        .map(|e| e.file)
        .collect();

    for (capability, sites) in SURFACE_SITES {
        for site in *sites {
            assert!(
                consulting.contains(site.file),
                "{} gates {capability} but is not censused as consulting scope",
                site.file,
            );
            let source = strip_comment_lines(
                &std::fs::read_to_string(crates_dir().join(site.file)).expect("gating site source"),
            );
            for expected in site.sources {
                assert!(
                    source.contains(expected),
                    "{} gates {capability} but does not contain `{expected}`",
                    site.file,
                );
            }
        }
    }
}

/// The surface map and the vocabulary are the same set.
///
/// A name in `FUZ_FORGE_TOKEN_SURFACES` with no row here is a capability
/// declared and unwired; a row here naming a capability the vocabulary doesn't
/// carry is a string that would only surface as a mis-labelled denial, since the
/// spine validates the *shape* of a consumer capability and deliberately not its
/// membership.
#[test]
fn the_surface_map_covers_the_vocabulary() {
    let mapped: BTreeSet<&str> = SURFACE_SITES.iter().map(|(c, _)| c.as_str()).collect();
    let declared: BTreeSet<&str> = FUZ_FORGE_TOKEN_SURFACES
        .iter()
        .map(|c| c.as_str())
        .collect();
    assert_eq!(mapped, declared);
}
