//! End-to-end signed-artifact distribution loop over the **HTTP forge backend**
//! (`fuz_storage::ForgeStorage`), the twin of `fuz_sign`'s
//! `publish_then_install_tool_end_to_end` (which runs over `FileStorage`).
//!
//! `fuz_sign`'s suite already proves the sign → publish → fetch → verify → install
//! composition against a local `FileStorage`. This suite proves the same loop
//! survives the real HTTP transport: a signed tool artifact is published through a
//! booted `fuz_forge_server` router (bearer-authenticated file store, real
//! Postgres), then installed back over a `ForgeStorage` pointed at that server.
//!
//! The verification semantics are identical to the `FileStorage` path — the forge
//! is a dumb byte store; `fuz_release` verifies the ed25519 signature + blake3
//! pins client-side after download, regardless of where the bytes came from. What
//! is new here is the HTTP hop: bearer auth, an in-process axum server, a real
//! migration chain, and DB-seeded admin credentials.
//!
//! Two dev-dependency-only seams make it driveable (both compiled out of every
//! shipping binary by resolver-2, the same isolation `cargo xtask check-release`
//! enforces by dep graph):
//!
//! - `fuz_crypto/test_trust_anchor` — register a key the test controls so the
//!   real `verify_signature()` trust check admits it.
//! - `fuz_home/test_home_override` — redirect `~/.fuz` in-process, since edition
//!   2024 + the workspace `unsafe_code = "forbid"` rule out `std::env::set_var`.
//!
//! Requires a local Postgres (`FUZ_FORGE_SERVER_TEST_URL`, default
//! `postgres://localhost/fuz_forge_server_test`); marked `#[ignore]` and run with
//! `--ignored --test-threads=1`.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use common::{bare_db_pool, test_url};
use fuz_forge_server::FuzForgeEnv;
use fuz_forge_server::router::build_router;
use fuz_release::{ToolInstallOptions, ToolInstallOutcome, install_tool, verify_installed_tool};
use fuz_sign::{PublishOptions, SigningKey, publish_tool};
use fuz_sys::fs::CleanupGuard;
use fuz_sys::rand::random_hex_suffix;
use fuz_testing::{grant_role, seed_account_actor};

/// Serializes the whole file. The trust anchor and home override are process
/// globals; a tokio mutex (not std) so it can be held across `.await` without
/// tripping `await_holding_lock` and without poisoning when an assertion panics.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Seed an admin account: `account` + `actor` + a global `admin` `role_grant` +
/// an `api_token` row for `g`. Returns the seeded account id. The identity
/// rows and the grant are `fuz_testing`'s `seed` fixtures; the token row is
/// written here because it stores the caller's pre-generated `g` under this
/// suite's token name.
async fn seed_admin_with_token(
    pool: &fuz_db::Pool,
    g: &fuz_auth::api_token::GeneratedApiToken,
) -> uuid::Uuid {
    let (account_id, actor_id) = seed_account_actor(pool, "capstone_admin").await;
    grant_role(pool, actor_id, fuz_auth::ROLE_ADMIN).await;
    // `TokenScope::Full` — this capstone drives the whole publish/install flow
    // over bearer, so the token needs the reach an operator's admin token has.
    // The scope axis is exercised in `fuz_auth`, not here.
    let scope_json = fuz_auth::token_scope::TokenScopeDocument::full()
        .to_json()
        .expect("serialize token scope");
    let client = pool.get().await.expect("pool.get");
    fuz_auth::api_token_queries::query_create_api_token(
        &client,
        &g.id,
        &account_id,
        "capstone",
        &g.token_hash,
        &scope_json,
        None,
    )
    .await
    .expect("create api token");
    account_id
}

/// The headline composition: sign + publish a tool through a booted
/// `fuz_forge_server` router (bearer-authenticated file store over a real
/// Postgres), then install it back over a `ForgeStorage` pointed at that server.
///
/// Asserts the install landed under the overridden `~/.fuz/tools/<name>/v1-<hash>/`
/// with the published binary bytes, and that `verify_installed_tool` re-hashes
/// them clean against the tool's `meta.json` — i.e. the ed25519 signature +
/// blake3 pins verified end to end over HTTP, not just over `FileStorage`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a local Postgres (FUZ_FORGE_SERVER_TEST_URL); run with --ignored"]
async fn publish_then_install_tool_over_forge_storage() {
    let _serial = SERIAL.lock().await;

    // Scratch dirs (the forge workspace doesn't dep `tempfile`): one root under
    // the system temp dir, auto-removed by a `CleanupGuard` on drop.
    let scratch =
        std::env::temp_dir().join(format!("fuz_forge_signed_tool_{}", random_hex_suffix()));
    let home_dir = scratch.join("home");
    let facts_dir = scratch.join("facts");
    let bin_dir = scratch.join("bin");
    for dir in [&home_dir, &facts_dir, &bin_dir] {
        std::fs::create_dir_all(dir).expect("create scratch dir");
    }
    // `home_dir` is the overridden `~/.fuz`, and `install_tool` refuses a
    // world-writable one (`check_fuz_home_not_world_writable`). `create_dir_all`
    // takes its mode from the process umask, so under a permissive runner umask
    // (`umask 000`, routine in containers) the home would arrive `0777` and the
    // install would refuse — a suite that passes or fails by whoever launched
    // it. Set the mode a real `ensure_fuz_home` creates instead of inheriting
    // one. The sibling scratch dirs are not `FUZ_HOME` and need no pin.
    std::fs::set_permissions(
        &home_dir,
        std::fs::Permissions::from_mode(fuz_sys::SECURE_DIR_MODE),
    )
    .expect("pin the scratch home at 0700");
    let _cleanup = CleanupGuard::new(scratch.clone());

    // Trust anchor (so the real `verify_signature` admits our key) + home
    // override (so the install lands under the temp `~/.fuz`). Process globals,
    // guarded by `SERIAL`.
    let key = SigningKey::from_bytes(&[11u8; 32]);
    fuz_crypto::clear_trusted_keys_for_testing();
    fuz_crypto::add_trusted_key_for_testing(&key.verifying_key());
    fuz_home::set_fuz_home_override_for_testing(&home_dir);

    // Fresh DB: reset the `public` schema so `build_router`'s full migration
    // chain (auth → cell → fact → fuz_forge) replays clean.
    let pool = bare_db_pool().await;

    // Boot the router in-process. `build_router` runs the migration chain
    // internally; production `Argon2idHasher` is fine (api-token auth is
    // blake3-hashed + seeded directly, so no password hashing happens here).
    let env = FuzForgeEnv {
        base: fuz_http::BaseServerEnv {
            database_url: Some(test_url()),
            cookie_keys: Some("0123456789abcdef0123456789abcdef".to_owned()), // >= 32 chars
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
        git_path: "/usr/bin:/bin".to_owned(),
        fact_store_path: Some(facts_dir.clone()),
        repo_path: None,
        // Both store roots this test touches are set explicitly above, so the
        // home is only the (unused) default root; point it at the scratch dir
        // so nothing can reach the real `~/.fuz_forge`.
        fuz_forge_home: facts_dir.clone(),
        file_store_max_bytes: fuz_forge_server::env::DEFAULT_FILE_STORE_MAX_BYTES,
        file_store_free_space_margin_bytes: 0,
        file_store_max_concurrent_uploads: 4,
        seed_from_allow_private_hosts: false,
    };
    let hasher: Arc<dyn fuz_auth::PasswordHasher> = Arc::new(fuz_auth::Argon2idHasher::new());
    let router = build_router(
        &env,
        fuz_forge_server::router::BuildRouterOptions {
            backend: fuz_actions::server::SpineBackendOptions::production(hasher),
            extra_action_specs_factory: None,
            final_action_specs_factory: None,
            action_rate_limiters: fuz_auth::RateLimiterMode::Enforced,
            action_rate_limit_max_attempts: None,
        },
    )
    .await
    .expect("build_router")
    .router;

    // Seed an admin account + a max-privilege (unscoped) API token so the file
    // store's POST (publish) `require_admin_role` and GET (install)
    // `require_auth` gates both pass.
    let g = fuz_auth::api_token::generate_api_token();
    seed_admin_with_token(&pool, &g).await;

    // Bind our own listener so we control the port; serve on a background task
    // with a graceful-shutdown token. `fuz_http::serve_with_shutdown` is the one
    // server a composed `GatedRouter` takes — as in production — and it inserts
    // the `ConnectInfo<SocketAddr>` the router's `client_ip_middleware` reads
    // (the extractor 500s without it).
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("local_addr").port();
    let shutdown = fuz_http::CancellationToken::new();
    let server = tokio::spawn({
        let shutdown = shutdown.clone();
        async move {
            let _ = fuz_http::serve_with_shutdown(
                listener,
                router,
                shutdown,
                &fuz_http::NoopShutdownCloser,
                fuz_http::DEFAULT_DRAIN_TIMEOUT,
            )
            .await;
        }
    });

    // Drive the loop over the HTTP forge backend. `http://127.0.0.1` is allowed
    // by `validate_base_url` (localhost plaintext).
    let storage = fuz_storage::ForgeStorage::new(&format!("http://127.0.0.1:{port}"), g.token)
        .expect("forge storage");

    let bin_path = bin_dir.join("fuzf");
    // An executable for the host target: the publish and the install both hold
    // the binary's header to the release's target.
    let content: &[u8] =
        &fuz_artifact::platform::test_stubs::host(b"fuzf binary bytes -- forge storage e2e tool");
    std::fs::write(&bin_path, content).expect("write tool binary");

    publish_tool(
        &storage,
        "fuzf",
        "0.1.0",
        &[("fuzf".to_owned(), bin_path.clone())],
        &key,
        &PublishOptions::default(),
    )
    .await
    .expect("publish_tool over forge storage");

    let result = install_tool(&storage, "fuzf", &ToolInstallOptions::default())
        .await
        .expect("install_tool over forge storage");

    assert_eq!(result.name, "fuzf");
    assert_eq!(result.version, "0.1.0");
    assert_eq!(result.outcome, ToolInstallOutcome::Installed);
    assert_eq!(result.binaries, vec!["fuzf".to_owned()]);
    assert!(
        result.install_dir.starts_with(&home_dir),
        "install dir {:?} must be under the overridden home {home_dir:?}",
        result.install_dir,
    );
    let installed_bin = result.install_dir.join("fuzf");
    assert!(installed_bin.exists(), "installed binary must be present");
    assert_eq!(
        std::fs::read(&installed_bin).expect("read installed binary"),
        content,
        "the installed binary bytes must match what was published",
    );

    // Re-hash the on-disk binaries against the tool's `meta.json` — the blake3
    // pins verify clean after the full HTTP round trip.
    verify_installed_tool("fuzf").expect("installed tool must verify against its meta");

    // Teardown: stop the server, clear the process-global overrides. `_cleanup`
    // removes the scratch tree on drop.
    shutdown.cancel();
    let _ = server.await;
    fuz_home::clear_fuz_home_override_for_testing();
    fuz_crypto::clear_trusted_keys_for_testing();
}
