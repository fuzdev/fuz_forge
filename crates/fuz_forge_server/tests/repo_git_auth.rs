//! The git smart-HTTP admin gate over a booted `fuz_forge_server` router, real
//! Postgres, and a real bare repo — the Rust twin of
//! `src/test/server/routes/repo_git.auth.db.test.ts`'s
//! `rejects an admin whose granting actor is soft-deleted`.
//!
//! The gate reads its global-`admin` grant straight off `api_token.account_id`,
//! with no acting-actor resolution in front of it, so it must use the
//! **tombstone-aware** `query_account_has_active_global_role`: a grant
//! surviving on a soft-deleted actor is not authority. That state has no wire
//! spelling — `account_delete` revokes every `api_token` on the account, so a
//! cross-process probe is refused at token validation before the role gate is
//! consulted — which is why it is driven here against the DB directly.
//!
//! Requires a local Postgres (`FUZ_FORGE_SERVER_TEST_URL`, default
//! `postgres://localhost/fuz_forge_server_test`) and `git` on `PATH`; marked
//! `#[ignore]` and run with `--ignored --test-threads=1`.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use common::{bare_db_pool, test_url};
use fuz_forge_server::FuzForgeEnv;
use fuz_forge_server::router::build_router;
use fuz_sys::fs::CleanupGuard;
use fuz_sys::rand::random_hex_suffix;
use fuz_testing::{grant_role, seed_account_actor};

const SLUG: &str = "fuzdev/tombstone";

/// Seed an admin account + actor + global `admin` grant + an `api_token` for
/// `g`, and return the **actor** id (the row the tombstone lands on). The
/// identity rows and the grant are `fuz_testing`'s `seed` fixtures; the token
/// row is written here because it stores the caller's pre-generated `g` under
/// this suite's token name.
async fn seed_admin_actor(
    pool: &fuz_db::Pool,
    g: &fuz_auth::api_token::GeneratedApiToken,
) -> uuid::Uuid {
    let (account_id, actor_id) = seed_account_actor(pool, "git_admin").await;
    grant_role(pool, actor_id, fuz_auth::ROLE_ADMIN).await;
    let scope_json = fuz_auth::token_scope::TokenScopeDocument::full()
        .to_json()
        .expect("serialize token scope");
    let client = pool.get().await.expect("pool.get");
    fuz_auth::api_token_queries::query_create_api_token(
        &client,
        &g.id,
        &account_id,
        "git",
        &g.token_hash,
        &scope_json,
        None,
    )
    .await
    .expect("create api token");
    actor_id
}

/// A booted forge over the test database: one live admin with an api token,
/// one repo cell at `repos/<SLUG>` with its bare repo on disk, and the server
/// listening on a loopback port.
struct Booted {
    _cleanup: CleanupGuard,
    pool: fuz_db::Pool,
    host: String,
    basic: String,
    actor_id: uuid::Uuid,
    cell_id: uuid::Uuid,
    server: tokio::task::JoinHandle<()>,
}

async fn boot() -> Booted {
    let scratch = std::env::temp_dir().join(format!("fuz_forge_git_auth_{}", random_hex_suffix()));
    let repo_root = scratch.join("repos");
    std::fs::create_dir_all(&repo_root).expect("create scratch dir");
    let cleanup = CleanupGuard::new(scratch.clone());

    // Fresh DB so `build_router`'s migration chain replays clean.
    let pool = bare_db_pool().await;

    let env = FuzForgeEnv {
        base: fuz_http::BaseServerEnv {
            database_url: Some(test_url()),
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

    let g = fuz_auth::api_token::generate_api_token();
    let actor_id = seed_admin_actor(&pool, &g).await;

    // A repo cell at `repos/<slug>` plus the bare repo its id names on disk, so
    // an authorized request reaches `git http-backend` and gets a real
    // advertisement rather than a 500.
    let cell_id: uuid::Uuid = pool
        .get()
        .await
        .expect("pool.get")
        .query_one(
            "INSERT INTO cell (path, data, kind) \
             VALUES ($1, '{}'::jsonb, 'repo') RETURNING id",
            &[&format!("repos/{SLUG}")],
        )
        .await
        .expect("insert cell")
        .get(0);
    let bare = repo_root.join(format!("{cell_id}.git"));
    let git = |args: &[&str]| {
        assert!(
            std::process::Command::new("git")
                .args(args)
                .status()
                .expect("spawn git (this test needs `git` on PATH)")
                .success(),
            "git {args:?} failed"
        );
    };
    let bare_str = bare.display().to_string();
    git(&[
        "init",
        "--bare",
        "--quiet",
        "--initial-branch=main",
        &bare_str,
    ]);
    // The per-repo export opt-in `repo_storage::mark_exportable` writes on a
    // real create: `git http-backend` 404s a repo without it, because
    // `GIT_HTTP_EXPORT_ALL` is deliberately never set in the CGI env.
    std::fs::write(bare.join("git-daemon-export-ok"), b"").expect("write export marker");
    git(&["-C", &bare_str, "config", "http.uploadpack", "true"]);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let host = listener.local_addr().expect("local_addr").to_string();
    // Served by `fuz_http::serve_with_shutdown`, the one server a composed
    // `GatedRouter` takes — as in production. It inserts the
    // `ConnectInfo<SocketAddr>` the router's `client_ip_middleware` reads (the
    // extractor 500s without it).
    let server = tokio::spawn(async move {
        fuz_http::serve_with_shutdown(
            listener,
            router,
            fuz_http::CancellationToken::new(),
            &fuz_http::NoopShutdownCloser,
            fuz_http::DEFAULT_DRAIN_TIMEOUT,
        )
        .await
        .expect("serve");
    });

    let basic = {
        use base64::Engine as _;
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("git_admin:{}", g.token))
        )
    };
    Booted {
        _cleanup: cleanup,
        pool,
        host,
        basic,
        actor_id,
        cell_id,
        server,
    }
}

/// The status of one raw HTTP/1.1 `GET` of `path` with `headers` (each a full
/// `Name: value` line). A raw request rather than a client crate: the only
/// thing under test is the status line, and a plain `TcpStream` needs no TLS
/// provider setup for what is a loopback plaintext request.
async fn get_status(host: &str, path: &str, headers: &[String]) -> u16 {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let mut stream = tokio::net::TcpStream::connect(host).await.expect("connect");
    let mut request = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n");
    for header in headers {
        request.push_str(header);
        request.push_str("\r\n");
    }
    request.push_str("Connection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write request");
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("read response");
    let head = String::from_utf8_lossy(&response);
    head.lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .expect("status line")
        .parse::<u16>()
        .expect("status code")
}

impl Booted {
    /// The upload-pack advertisement's status for the booted admin.
    async fn advertise(&self) -> u16 {
        get_status(
            &self.host,
            &format!("/{SLUG}.git/info/refs?service=git-upload-pack"),
            &[format!("Authorization: {}", self.basic)],
        )
        .await
    }

    /// Run one DDL statement against the test database.
    async fn ddl(&self, sql: &str) {
        self.pool
            .get()
            .await
            .expect("pool.get")
            .batch_execute(sql)
            .await
            .expect(sql);
    }
}

/// A grant held by a soft-deleted actor must not admit a git request, and the
/// refusal must be the same generic 401 every other cause produces.
///
/// The pre-tombstone **200** is the control: it proves the credential, the slug
/// and the on-disk repo are all good, so the 401 below can only be the role
/// gate. Swap the gate back to the tombstone-blind
/// `query_account_has_global_role` and this test fails with a second 200.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a local Postgres (FUZ_FORGE_SERVER_TEST_URL); run with --ignored"]
async fn git_auth_refuses_an_admin_whose_granting_actor_is_soft_deleted() {
    let booted = boot().await;
    assert_eq!(
        booted.advertise().await,
        200,
        "a live admin gets the advertisement"
    );

    // Tombstone the actor the grant hangs off, leaving the account and the
    // api_token untouched — the state `account_delete` can never produce over
    // the wire, since it revokes every token on the account.
    let client = booted.pool.get().await.expect("pool.get");
    assert!(
        fuz_auth::actor_queries::query_actor_soft_delete(&client, &booted.actor_id, None)
            .await
            .expect("soft-delete actor"),
        "the actor should soft-delete"
    );
    drop(client);

    assert_eq!(
        booted.advertise().await,
        401,
        "a grant on a tombstoned actor must not admit"
    );

    booted.server.abort();
}

/// A read the database cannot answer is a 500 on git and on the hook callback,
/// never the 401 a refusal gets — each read failed by hiding its table, past a
/// checkout that succeeds (the in-crate `auth_answers` and
/// `a_failed_lookup_answers_the_500` tests fail the checkout itself).
///
/// The token-policy read comes after the credential, role and repo reads
/// succeed, so its 500 is that read's alone; the cell table hides both the git
/// repo lookup and the callback's cell lookup.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a local Postgres (FUZ_FORGE_SERVER_TEST_URL); run with --ignored"]
async fn a_failed_read_past_the_checkout_answers_the_500() {
    let booted = boot().await;
    assert_eq!(booted.advertise().await, 200, "the control");

    booted
        .ddl("ALTER TABLE fuz_forge_api_token_policy RENAME TO fuz_forge_api_token_policy_hidden")
        .await;
    assert_eq!(booted.advertise().await, 500, "a failed token-policy read");
    booted
        .ddl("ALTER TABLE fuz_forge_api_token_policy_hidden RENAME TO fuz_forge_api_token_policy")
        .await;
    assert_eq!(booted.advertise().await, 200, "the table restored");

    let repo_config = format!("/internal/repo-config/{}", booted.cell_id);
    let secret = ["x-fuzforge-repo-secret: s3cr3t".to_owned()];
    assert_eq!(
        get_status(&booted.host, &repo_config, &secret).await,
        401,
        "the callback's control: the cell's empty data names no secret"
    );
    booted.ddl("ALTER TABLE cell RENAME TO cell_hidden").await;
    assert_eq!(booted.advertise().await, 500, "a failed repo cell read");
    assert_eq!(
        get_status(&booted.host, &repo_config, &secret).await,
        500,
        "a failed hook cell read"
    );
    booted.ddl("ALTER TABLE cell_hidden RENAME TO cell").await;

    booted.server.abort();
}
