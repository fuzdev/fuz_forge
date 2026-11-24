//! `fuz_forge_repo_create` over a booted `fuz_forge_server` router, a real
//! database, and a real repo store — the Rust twin of
//! `src/test/server/routes/fuz_forge_repo_create_rpc.db.test.ts`.
//!
//! This suite owns the store root, so it sees what no cross-process caller
//! can: the bare repo and its hooks on disk, and the **on-disk** unwind of a
//! failed create (the bare repo is keyed by a freshly minted cell UUID that no
//! client learns, so only a `read_dir` before and after proves neither
//! `<uuid>.git` nor its `.tmp` sibling survived). A failed *clone* can't show
//! that unwind — git deletes its own target — so the pin is a failure past
//! the init, an unsettable `default_branch`. It also boots the forge with
//! the `seed_from` host policy **on** — the shipped default, which both cross
//! spawns turn off so their positive control can be a loopback URL — and pins
//! the whole `-32602` envelope the policy answers.
//!
//! A *successful* seeded create needs an upstream served over HTTP; that
//! clone is driven on both backends by
//! `src/test/cross_backend/repo_create_seed_from.cross.test.ts` and in the TS
//! twin, not here.
//!
//! Requires `git` on `PATH`.

#![expect(
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers outside `#[test]` fns panic on a failed setup or check"
)]

mod common;

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, header};
use common::bare_db;
use fuz_forge_server::FuzForgeEnv;
use fuz_forge_server::router::build_router;
use fuz_sys::fs::CleanupGuard;
use fuz_sys::rand::random_hex_suffix;
use fuz_testing::{grant_role, seed_account_actor};
use serde_json::{Value, json};
use tower::ServiceExt as _;

/// The host-policy refusal's wire message — `SEED_FROM_HOST_MESSAGE` in
/// `handlers::seed_from`, and the TS twin's constant of the same name.
const SEED_FROM_HOST_MESSAGE: &str =
    "seed_from must not name a loopback, link-local, unspecified, or private-range host";

/// The fixed `-32603` a failed seeded assembly answers —
/// `REPO_CREATE_SEED_FAILED_MESSAGE` on both backends.
const REPO_CREATE_SEED_FAILED_MESSAGE: &str = "repo create failed: seed clone failed";

/// The unseeded form — `REPO_CREATE_ASSEMBLY_FAILED_MESSAGE` on both backends.
const REPO_CREATE_ASSEMBLY_FAILED_MESSAGE: &str = "repo create failed: repo assembly failed";

/// A booted forge: one admin with a full-scope api token, the router, and the
/// store root its creates write under.
struct Booted {
    _cleanup: CleanupGuard,
    pool: fuz_testing::TestDb,
    router: fuz_http::GatedRouter,
    token: String,
    actor_id: uuid::Uuid,
    repo_root: PathBuf,
}

/// Boot the forge with the `seed_from` operator override as given.
async fn boot(seed_from_allow_private_hosts: bool) -> Booted {
    let scratch =
        std::env::temp_dir().join(format!("fuz_forge_repo_create_{}", random_hex_suffix()));
    let repo_root = scratch.join("repos");
    std::fs::create_dir_all(&repo_root).expect("create scratch dir");
    let cleanup = CleanupGuard::new(scratch.clone());

    // Fresh DB so `build_router`'s migration chain replays clean.
    let pool = bare_db().await;

    let env = FuzForgeEnv {
        base: fuz_http::BaseServerEnv {
            database_url: Some(pool.url().to_owned()),
            cookie_keys: Some("0123456789abcdef0123456789abcdef".to_owned()),
            host: None,
            port: None,
            allowed_origins: fuz_http::AllowedOrigins::parse("http://127.0.0.1")
                .expect("valid allowlist"),
            trusted_proxies: Vec::new(),
            bootstrap_token_path: None,
            allow_origin_wildcards: false,
            db_checkout_timeout: fuz_db::DEFAULT_CHECKOUT_TIMEOUT,
            db_audit_checkout_timeout: fuz_db::DEFAULT_AUDIT_CHECKOUT_TIMEOUT,
        },
        git_path: "/usr/local/bin:/usr/bin:/bin".to_owned(),
        fact_store_path: Some(scratch.join("facts")),
        repo_path: Some(repo_root.clone()),
        fuz_forge_home: scratch.clone(),
        file_store_max_bytes: fuz_forge_server::env::DEFAULT_FILE_STORE_MAX_BYTES,
        file_store_free_space_margin_bytes: 0,
        file_store_max_concurrent_uploads: 4,
        seed_from_allow_private_hosts,
    };
    let hasher: Arc<dyn fuz_auth::PasswordHasher> = Arc::new(fuz_auth::Argon2idHasher::new());
    let fuz_forge_server::router::BuiltRouter::Live { router, .. } = build_router(
        &env,
        fuz_forge_server::router::BuildRouterOptions {
            backend: fuz_actions::server::SpineBackendOptions::production(
                hasher,
                fuz_auth::AuthCleanupSchedule::Off,
            ),
            extra_action_specs_factory: None,
            final_action_specs_factory: None,
            // `fuz_forge_repo_create` spends the per-account action budget,
            // and the policy table below drives it once per refused host.
            action_rate_limiters: fuz_auth::RateLimiterMode::DisabledForTesting,
            action_rate_limit_max_attempts: None,
        },
    )
    .await
    .expect("build_router") else {
        panic!("a database builds the full router");
    };

    let (account_id, actor_id) = seed_account_actor(&pool, "repo_admin").await;
    grant_role(&pool, actor_id, fuz_auth::ROLE_ADMIN).await;
    let g = fuz_auth::api_token::generate_api_token();
    let scope_json = fuz_auth::token_scope::TokenScopeDocument::full()
        .to_json()
        .expect("serialize token scope");
    fuz_auth::api_token_queries::query_create_api_token(
        &pool.get().await.expect("pool.get"),
        &g.id,
        &account_id,
        "repo_create",
        &g.token_hash,
        &scope_json,
        None,
    )
    .await
    .expect("create api token");

    Booted {
        _cleanup: cleanup,
        pool,
        router,
        token: g.token,
        actor_id,
        repo_root,
    }
}

/// The repo cell a create writes, as the database holds it.
struct RepoCellRow {
    id: uuid::Uuid,
    created_by: Option<uuid::Uuid>,
    kind: String,
    data: Value,
}

impl Booted {
    /// One JSON-RPC call over the composed router, bearer-authenticated as the
    /// admin. Returns the parsed envelope.
    async fn rpc(&self, method: &str, params: Value) -> Value {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/rpc")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .body(Body::from(body.to_string()))
            .expect("the request builds");
        // `serve_with_shutdown` inserts the peer; a `oneshot` has no connection.
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:40000"
                .parse::<SocketAddr>()
                .expect("the peer parses"),
        ));
        let response = self
            .router
            .clone()
            .into_router_for_testing()
            .oneshot(request)
            .await
            .expect("the router answers");
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("the body reads");
        serde_json::from_slice(&bytes).expect("a JSON-RPC envelope")
    }

    /// `fuz_forge_repo_create` with `params`.
    async fn create(&self, params: Value) -> Value {
        self.rpc("fuz_forge_repo_create", params).await
    }

    /// The live repo cell at `repos/<slug>`, if any.
    async fn cell(&self, slug: &str) -> Option<RepoCellRow> {
        self.pool
            .get()
            .await
            .expect("pool.get")
            .query_opt(
                "SELECT id, created_by, kind, data::text FROM cell \
                 WHERE path = $1 AND deleted_at IS NULL",
                &[&format!("repos/{slug}")],
            )
            .await
            .expect("query cell")
            .map(|row| RepoCellRow {
                id: row.get(0),
                created_by: row.get(1),
                kind: row.get(2),
                data: serde_json::from_str(row.get::<_, &str>(3)).expect("cell data parses"),
            })
    }

    /// The store root's entries, by name.
    fn store_entries(&self) -> BTreeSet<String> {
        std::fs::read_dir(&self.repo_root)
            .expect("read store root")
            .map(|entry| {
                entry
                    .expect("store entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    }
}

/// The envelope's `result`, or a panic naming the error it holds.
fn result(envelope: &Value) -> &Value {
    envelope
        .get("result")
        .unwrap_or_else(|| panic!("expected a result: {envelope}"))
}

/// The envelope's `error` object, or a panic naming the result it holds.
fn error(envelope: &Value) -> &Value {
    envelope
        .get("error")
        .unwrap_or_else(|| panic!("expected an error: {envelope}"))
}

/// `git symbolic-ref HEAD` in the bare repo at `bare`.
fn symbolic_head(bare: &Path) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(bare)
        .args(["symbolic-ref", "HEAD"])
        .output()
        .expect("spawn git (this test needs `git` on PATH)");
    assert!(out.status.success(), "git symbolic-ref failed: {out:?}");
    String::from_utf8(out.stdout)
        .expect("utf-8 ref")
        .trim()
        .to_owned()
}

/// The plaintext secret a hook script embeds on its
/// `FUZ_FORGE_HOOK_SECRET = '…'` line.
fn embedded_hook_secret(script: &str) -> Option<&str> {
    script.lines().find_map(|line| {
        line.strip_prefix("FUZ_FORGE_HOOK_SECRET = '")?
            .strip_suffix('\'')
            .filter(|s| !s.contains(['\'', '\\']))
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn creates_the_bare_repo_hooks_and_cell_without_a_seed() {
    let booted = boot(true).await;
    let res = booted.create(json!({"slug": "fuzdev/new_repo"})).await;
    let repo = &result(&res)["repo"];
    assert_eq!(repo["slug"], "fuzdev/new_repo");
    assert_eq!(repo["name"], "new_repo");
    assert_eq!(repo["default_branch"], "main");
    assert_eq!(repo["seed_from"], Value::Null);
    // Only a seeded create resolves a tip: an empty repo has none until the
    // first push.
    assert_eq!(repo["head_sha"], Value::Null);
    let id = repo["id"].as_str().expect("a string id");

    // The cell at `repos/<slug>` mirrors the output.
    let cell = booted.cell("fuzdev/new_repo").await.expect("the repo cell");
    assert_eq!(cell.id.to_string(), id);
    assert_eq!(cell.created_by, Some(booted.actor_id));
    assert_eq!(cell.kind, "repo");
    assert_eq!(cell.data["name"], "new_repo");
    let digest = cell.data["hook_secret_hash"]
        .as_str()
        .expect("a hook secret digest");
    assert!(
        digest.len() == 64
            && digest
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
        "the cell holds a 64-hex digest: {digest}"
    );
    assert!(
        cell.data.get("hook_secret").is_none(),
        "no plaintext secret in the cell"
    );

    // The bare repo and its hooks, keyed on the cell-id UUID.
    let bare = booted.repo_root.join(format!("{id}.git"));
    assert!(bare.join("HEAD").is_file());
    for name in ["pre-receive", "post-receive"] {
        let script = std::fs::read_to_string(bare.join("hooks").join(name)).expect("read the hook");
        let secret =
            embedded_hook_secret(&script).unwrap_or_else(|| panic!("{name} embeds the secret"));
        // The plaintext the hooks embed is what the cell's digest is of.
        assert_eq!(
            fuz_crypto::ContentHash::blake3(secret.as_bytes()).to_hex(),
            digest,
            "{name}"
        );
    }
    assert_eq!(symbolic_head(&bare), "refs/heads/main");
    // The digest never reaches the wire.
    assert!(!result(&res).to_string().contains(digest));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_duplicate_slug_is_a_conflict() {
    let booted = boot(true).await;
    let params = json!({"slug": "fuzdev/dup_repo"});
    result(&booted.create(params.clone()).await);
    let second = booted.create(params).await;
    let message = error(&second)["message"].as_str().expect("a message");
    assert!(
        message.to_lowercase().contains("already exists"),
        "{second}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_invalid_slug_shape_is_a_validation_error() {
    let booted = boot(true).await;
    // Passes the bounded-string length check but fails the strict `RepoSlug`
    // parse in the handler (no `/`).
    let res = booted.create(json!({"slug": "no_slash_here"})).await;
    let message = error(&res)["message"].as_str().expect("a message");
    assert!(message.to_lowercase().contains("slug"), "{res}");
    assert!(
        booted.store_entries().is_empty(),
        "nothing reached the store"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_default_branch_override_is_honored() {
    let booted = boot(true).await;
    let res = booted
        .create(json!({"slug": "fuzdev/trunk_repo", "default_branch": "trunk"}))
        .await;
    let repo = &result(&res)["repo"];
    assert_eq!(repo["default_branch"], "trunk");
    let id = repo["id"].as_str().expect("a string id");
    assert_eq!(
        symbolic_head(&booted.repo_root.join(format!("{id}.git"))),
        "refs/heads/trunk"
    );
}

/// The grammar runs before any disk or DB work. A `file://` seed is the
/// load-bearing case: without the check it would import any bare repo on the
/// host's disk into a served repo.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_off_grammar_seed_from_is_refused_before_any_disk_or_db_work() {
    let booted = boot(true).await;
    let slug = "fuzdev/rejected_seed";
    for seed_from in [
        "file:///tmp/upstream.git",
        "/tmp/upstream.git",
        "ext::sh -c id",
        "git@example.com:x.git",
        "https://user:pw@example.com/x.git",
    ] {
        let res = booted
            .create(json!({"slug": slug, "seed_from": seed_from}))
            .await;
        assert_eq!(error(&res)["code"], -32602, "{seed_from}: {res}");
        assert!(
            booted.cell(slug).await.is_none(),
            "{seed_from} must not create a cell"
        );
        assert!(
            booted.store_entries().is_empty(),
            "{seed_from} must not touch the store"
        );
    }
}

/// Port 1 on loopback is never listening, so the clone fails on
/// `ECONNREFUSED` with no DNS lookup or timeout. The override is on, so the
/// seed passes all three gates and the failure can only be the clone's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_clone_unwinds_the_cell_and_the_store_directory() {
    let booted = boot(true).await;
    let slug = "fuzdev/unreachable_seed";
    let before = booted.store_entries();
    let res = booted
        .create(json!({"slug": slug, "seed_from": "http://127.0.0.1:1/x.git"}))
        .await;
    let err = error(&res);
    assert_eq!(err["code"], -32603, "{res}");
    // The fixed message: git's stderr names the store root, the `.tmp`
    // assembly path and the cell UUID that just rolled back.
    assert_eq!(err["message"], REPO_CREATE_SEED_FAILED_MESSAGE);
    assert!(
        !res.to_string()
            .contains(&booted.repo_root.display().to_string()),
        "the store root never reaches the wire: {res}"
    );

    assert!(
        booted.cell(slug).await.is_none(),
        "a failed clone must roll the cell back"
    );
    // A guard, not the unwind's pin: git deletes its own clone target when
    // the clone fails, so this holds with both unwinds removed. The test
    // below is the one that fails without them.
    assert_eq!(
        booted.store_entries(),
        before,
        "a failed clone must leave no directory in the store"
    );
}

/// A failure **after** the bare repo is in place is what the handler's
/// unwind exists for. `default_branch` is only length-bounded on the wire (on
/// both backends), so `a..b` passes dispatch, the init renames `<uuid>.git`
/// into the store, and `git symbolic-ref` then refuses the ref name: only
/// `repo_storage::remove_repo_dir` stands between that directory and a leak.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failure_past_the_init_unwinds_the_bare_repo_and_the_cell() {
    let booted = boot(true).await;
    let slug = "fuzdev/bad_branch";
    let before = booted.store_entries();
    let res = booted
        .create(json!({"slug": slug, "default_branch": "a..b"}))
        .await;
    assert_eq!(
        *error(&res),
        json!({"code": -32603, "message": REPO_CREATE_ASSEMBLY_FAILED_MESSAGE}),
        "{res}"
    );
    assert!(
        booted.cell(slug).await.is_none(),
        "a failed assembly must roll the cell back"
    );
    assert_eq!(
        booted.store_entries(),
        before,
        "a failed assembly must leave no directory in the store"
    );
}

/// One spelling per refusal shape the wire can distinguish; the breadth is
/// the shared unit tables (`handlers::seed_from`'s tests and
/// `src/test/fuz_forge/repo/seed_from.test.ts`). What this adds is that each
/// shape survives the round trip through the dispatcher.
const NON_PUBLIC_HOST_SEEDS: &[&str] = &[
    // loopback literal
    "http://127.0.0.1:1/x.git",
    // RFC 1918
    "https://10.1.2.3/x.git",
    // CGNAT
    "https://100.64.0.1/x.git",
    // the cloud metadata endpoint — the reason the gate exists
    "http://169.254.169.254/latest/meta-data/",
    // IPv6 loopback, and the v4-mapped spelling the parser rewrites
    "https://[::1]/x.git",
    "https://[::ffff:127.0.0.1]/x.git",
    // the two RFC 6761 loopback names
    "http://localhost/x.git",
    "http://evil.localhost/x.git",
    // an alternate IPv4 spelling the parser folds before the policy runs
    "https://2130706433/x.git",
];

/// With the override **off** — the shape the forge ships — a private-host seed
/// is refused with the whole envelope: the code, the host message (not the
/// grammar one), and no `data`, which is what tells the handler's
/// `invalid_params` apart from a schema failure.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_private_host_seed_is_refused_with_the_full_envelope_before_any_work() {
    let booted = boot(false).await;
    let slug = "fuzdev/non_public_host_seed";
    for &seed_from in NON_PUBLIC_HOST_SEEDS {
        let before = booted.store_entries();
        let res = booted
            .create(json!({"slug": slug, "seed_from": seed_from}))
            .await;
        assert_eq!(
            *error(&res),
            json!({
                "code": -32602,
                "message": format!("invalid params: {SEED_FROM_HOST_MESSAGE}"),
            }),
            "{seed_from} must answer the host-policy envelope"
        );
        assert!(
            booted.cell(slug).await.is_none(),
            "{seed_from} must not create a cell"
        );
        assert_eq!(
            booted.store_entries(),
            before,
            "{seed_from} must not touch the store"
        );
    }
}

/// The non-vacuity control for the refusals above: the same policy-off app, a
/// public host, and it gets past the host gate to fail at the clone instead.
/// An RFC 2606 `.invalid` name is admitted by the policy and refused by DNS at
/// once, so the clone fails without a connect timeout.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_public_host_still_reaches_the_clone_with_the_override_off() {
    let booted = boot(false).await;
    let res = booted
        .create(json!({
            "slug": "fuzdev/public_host_seed",
            "seed_from": "http://seed-control.invalid/x.git",
        }))
        .await;
    let err = error(&res);
    assert_eq!(
        err["code"], -32603,
        "a public host must reach the clone: {res}"
    );
    assert_eq!(err["message"], REPO_CREATE_SEED_FAILED_MESSAGE);
}
