//! The post-receive callback dropped by its hook while its write commits —
//! over a booted `fuz_forge_server` router served as production serves it,
//! and real Postgres.
//!
//! `POST /internal/repo-receive-callback` folds a push into the repo cell and
//! then broadcasts `fuz_forge_repo_updated`. The hook that calls it gives up
//! after a timeout (`repo_storage`'s hook script), so a slow commit can lose its
//! caller mid-write. Once the write's commit has started, that drop must not
//! separate it from the broadcast that follows: the write is a transaction
//! committed through `fuz_db::commit_checked`, which marks the request, and the
//! serve's write tracker finishes it.
//!
//! The commit is held open by a deferred constraint trigger on `cell` that
//! sleeps at `COMMIT`, so the case can drop the socket while the write's round
//! trip is in flight — it waits for the trigger's sleep to show in `pg_stat_activity`.
//!
//! Requires a local Postgres (`FUZ_FORGE_SERVER_TEST_URL`, default
//! `postgres://localhost/fuz_forge_server_test`); marked `#[ignore]` and run
//! with `--ignored --test-threads=1`.

#![expect(
    clippy::expect_used,
    reason = "test helpers outside `#[test]` fns panic on a failed setup or check"
)]

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{bare_db_pool, test_url};
use fuz_forge_server::FuzForgeEnv;
use fuz_forge_server::broadcasts::methods::FUZ_FORGE_REPO_UPDATED;
use fuz_forge_server::router::{BuildRouterOptions, BuiltRouter, build_router};
use fuz_sys::fs::CleanupGuard;
use fuz_sys::rand::random_hex_suffix;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

/// Every update of a `cell` row makes its transaction's `COMMIT` sleep: the
/// deferred constraint trigger fires at commit, so the commit's round trip is
/// held open for the sleep. Installed after the boot's migrations.
const SLOW_CELL_COMMIT_SQL: &str = "
CREATE FUNCTION slow_commit_sleep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_sleep(3);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cell_slow_commit
  AFTER UPDATE ON cell
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION slow_commit_sleep();
";

/// Bound on every wait a broken case could otherwise turn into a hang.
const STEP_TIMEOUT: Duration = Duration::from_secs(10);

const SECRET: &str = "past-commit-hook-secret";
const NEW_SHA: &str = "1111111111111111111111111111111111111111";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires PostgreSQL with fuz_forge_server_test database"]
async fn a_receive_callback_dropped_mid_commit_still_broadcasts() {
    let scratch = std::env::temp_dir().join(format!(
        "fuz_forge_receive_past_commit_{}",
        random_hex_suffix()
    ));
    std::fs::create_dir_all(&scratch).expect("create scratch dir");
    let _cleanup = CleanupGuard::new(scratch.clone());
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
        repo_path: Some(scratch.join("repos")),
        fuz_forge_home: scratch.clone(),
        file_store_max_bytes: fuz_forge_server::env::DEFAULT_FILE_STORE_MAX_BYTES,
        file_store_free_space_margin_bytes: 0,
        file_store_max_concurrent_uploads: 4,
        seed_from_allow_private_hosts: false,
    };
    let hasher: Arc<dyn fuz_auth::PasswordHasher> = Arc::new(fuz_auth::Argon2idHasher::new());
    let BuiltRouter::Live { router, app } = build_router(
        &env,
        BuildRouterOptions {
            backend: fuz_actions::server::SpineBackendOptions::production(hasher),
            extra_action_specs_factory: None,
            final_action_specs_factory: None,
            action_rate_limiters: fuz_auth::RateLimiterMode::Enforced,
            action_rate_limit_max_attempts: None,
        },
    )
    .await
    .expect("build_router") else {
        panic!("a database builds the full router");
    };

    let client = pool.get().await.expect("pool.get");
    client
        .batch_execute(SLOW_CELL_COMMIT_SQL)
        .await
        .expect("install the slow-commit trigger");
    let data = json!({
        "slug": "fuzdev/past_commit",
        "name": "past_commit",
        "default_branch": "main",
        // the digest `handlers::hash_hook_secret` stores
        "hook_secret_hash": fuz_crypto::ContentHash::blake3(SECRET.as_bytes()).to_hex(),
    });
    let cell_id: uuid::Uuid = client
        .query_one(
            "INSERT INTO cell (path, data, kind) \
             VALUES ('repos/fuzdev/past_commit', $1::text::jsonb, 'repo') RETURNING id",
            &[&data.to_string()],
        )
        .await
        .expect("insert the repo cell")
        .get(0);

    // a recording socket on the forge's realtime registry — where the
    // broadcast fans out to the admin WebSockets
    let (sender, mut receiver) = fuz_realtime::connection_channel(1 << 20);
    let _connection = app.backend.realtime.add_connection(
        sender,
        fuz_realtime::ConnectionIdentity::default(),
        fuz_http::CancellationToken::new(),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    // served as `fuzfd` serves it: `serve_with_shutdown` over the composed
    // router, which carries the backend's shutdown duties (its write tracker)
    tokio::spawn(fuz_http::serve_with_shutdown(
        listener,
        router,
        fuz_http::CancellationToken::new(),
        Vec::new(),
        STEP_TIMEOUT,
    ));

    let body = json!({
        "repo_id": cell_id.to_string(),
        "updates": [{
            "old": "0000000000000000000000000000000000000000",
            "new": NEW_SHA,
            "ref": "refs/heads/main",
        }],
        "pushed_by": null,
        "push_username": null,
    })
    .to_string();
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let request = format!(
        "POST /internal/repo-receive-callback HTTP/1.1\r\nHost: {addr}\r\n\
         Content-Type: application/json\r\nX-FuzForge-Repo-Secret: {SECRET}\r\n\
         Content-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .await
        .expect("send the callback");
    until_commit_sleeps(&pool).await;
    // the hook gives up mid-commit: hyper drops the request with its connection
    drop(stream);

    let frame = tokio::time::timeout(STEP_TIMEOUT, receiver.recv())
        .await
        .expect("the broadcast arrives")
        .expect("the registry keeps the socket open");
    let notification: Value = serde_json::from_str(&frame).expect("a JSON frame");
    assert_eq!(notification["method"], FUZ_FORGE_REPO_UPDATED);
    assert_eq!(notification["params"]["repo_id"], cell_id.to_string());
    assert_eq!(notification["params"]["head_sha"], NEW_SHA);

    tokio::time::timeout(STEP_TIMEOUT, app.backend.background_writes().drain())
        .await
        .expect("the tracker drains");
    let head_sha: Option<String> = client
        .query_one(
            "SELECT data->>'head_sha' FROM cell WHERE id = $1",
            &[&cell_id],
        )
        .await
        .expect("read the cell")
        .get(0);
    assert_eq!(head_sha.as_deref(), Some(NEW_SHA), "the write committed");
}

/// Wait until the deferred trigger is sleeping in the callback's write of
/// the cell: the fire point is the write's commit — its own `COMMIT`, or the
/// end of an autocommit `UPDATE` — so the request is past the point a drop
/// could still roll it back.
async fn until_commit_sleeps(pool: &fuz_db::Pool) {
    tokio::time::timeout(STEP_TIMEOUT, async {
        loop {
            let in_flight: i64 = pool
                .get()
                .await
                .expect("pool.get")
                .query_one(
                    "SELECT count(*) FROM pg_stat_activity \
                     WHERE datname = current_database() AND state = 'active' \
                     AND wait_event = 'PgSleep'",
                    &[],
                )
                .await
                .expect("read pg_stat_activity")
                .get(0);
            if in_flight > 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the callback's commit starts");
}
