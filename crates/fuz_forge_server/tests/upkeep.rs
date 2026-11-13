//! The upkeep tasks `run_app` runs beside the server
//! (`fuz_forge_server::runtime::upkeep_options`, spawned by the spine's
//! `fuz_actions::server::spawn_upkeep`), over real Postgres and a
//! scratch fact-store root: their startup passes run the spine's auth cleanup
//! (an expired session is deleted and closed through the closer they're
//! handed, an expired role-grant offer audited through the emitter) and the
//! orphan-temp sweep, and cancelling the token ends them.
//!
//! The sweeps and their schedulers are covered where they live (`fuz_auth`'s
//! `auth_cleanup` suite, `fuz_fact`'s sweeper tests); this pins that the
//! server schedules both.
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
use std::time::{Duration, SystemTime};

use common::fresh_db_pool;

use fuz_actions::server::spawn_upkeep;
use fuz_auth::{
    AuditEmitter, AuditLogEvent, ConnectionCloseTarget, ConnectionCloser,
    CreateRoleGrantOfferInput, query_role_grant_offer_create,
};
use fuz_forge_server::runtime::upkeep_options;
use fuz_sys::fs::CleanupGuard;
use fuz_sys::rand::random_hex_suffix;
use fuz_testing::seed_account_actor;
use tokio_util::sync::CancellationToken;

const TIMEOUT: Duration = Duration::from_secs(30);

/// A `ConnectionCloser` recording every close it is asked for, by target.
#[derive(Default)]
struct RecordingCloser {
    closed: std::sync::Mutex<Vec<ConnectionCloseTarget>>,
}

impl RecordingCloser {
    fn record(&self, target: ConnectionCloseTarget) -> usize {
        self.closed.lock().expect("lock").push(target);
        0
    }
}

impl ConnectionCloser for RecordingCloser {
    fn close_connections(&self, target: &ConnectionCloseTarget) -> usize {
        self.record(target.clone())
    }
}

impl fuz_http::ShutdownCloser for RecordingCloser {
    fn close_all_connections(&self) -> usize {
        0
    }
    fn wait_closed(&self) -> fuz_http::WaitClosedFuture<'_> {
        Box::pin(std::future::ready(()))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a local Postgres (FUZ_FORGE_SERVER_TEST_URL); run with --ignored"]
async fn the_upkeep_tasks_sweep_at_startup_and_stop_on_shutdown() {
    // Fresh DB under the chain `build_router` runs.
    let pool = fresh_db_pool().await;

    // What the auth cleanup audits: a role-grant offer already expired.
    let (_, grantor) = seed_account_actor(&pool, "upkeep_grantor").await;
    let (recipient_account, _) = seed_account_actor(&pool, "upkeep_recipient").await;
    let offer = {
        let client = pool.get().await.expect("pool.get");
        query_role_grant_offer_create(
            &client,
            CreateRoleGrantOfferInput {
                from_actor_id: grantor,
                to_account_id: recipient_account,
                to_actor_id: None,
                role: "upkeep_role".to_owned(),
                scope_kind: None,
                scope_id: None,
                message: None,
                expires_at: SystemTime::now() - Duration::from_secs(3600),
            },
        )
        .await
        .expect("create offer")
    };

    // What the auth cleanup deletes and closes: a session already expired,
    // beside a live one on the same account.
    pool.get()
        .await
        .expect("pool.get")
        .execute(
            "INSERT INTO auth_session (id, account_id, expires_at) VALUES
               ('upkeep-expired', $1, NOW() - INTERVAL '1 hour'),
               ('upkeep-live', $1, NOW() + INTERVAL '1 hour')",
            &[&recipient_account],
        )
        .await
        .expect("seed sessions");

    // What the orphan-temp sweep reaps: a temp older than the max age.
    let fact_store_root =
        std::env::temp_dir().join(format!("fuz_forge_upkeep_{}", random_hex_suffix()));
    let _cleanup = CleanupGuard::new(fact_store_root.clone());
    let tmp_dir = fact_store_root.join(fuz_fact::FACT_TMP_DIRNAME);
    std::fs::create_dir_all(&tmp_dir).expect("create the temp dir");
    let orphan = tmp_dir.join("orphan");
    std::fs::write(&orphan, b"left by a crash").expect("write the orphan");
    std::fs::File::options()
        .write(true)
        .open(&orphan)
        .expect("open the orphan")
        .set_modified(SystemTime::now() - fuz_fact::ORPHAN_TEMP_MAX_AGE - Duration::from_secs(60))
        .expect("backdate the orphan");

    let audit = Arc::new(AuditEmitter::new(pool.clone()));
    let (tx, mut audited) = tokio::sync::mpsc::unbounded_channel::<Arc<AuditLogEvent>>();
    audit.add_listener(Arc::new(move |event| {
        // a send after the test's last `recv` has nowhere to go
        let _ = tx.send(event);
        Box::pin(async {})
    }));
    let recording = Arc::new(RecordingCloser::default());
    let connection_closer: Arc<dyn ConnectionCloser> = Arc::<RecordingCloser>::clone(&recording);
    let shutdown = CancellationToken::new();
    let tasks = spawn_upkeep(
        upkeep_options(
            fuz_auth::AuthCleanupOptions {
                pool: pool.clone(),
                audit: Arc::clone(&audit),
                connection_closer,
            },
            fact_store_root,
        ),
        &shutdown,
    );
    assert_eq!(
        tasks.len(),
        2,
        "the auth cleanup and the orphan-temp sweeper"
    );

    // the auth cleanup's startup pass audits the expired offer
    let event = tokio::time::timeout(TIMEOUT, audited.recv())
        .await
        .expect("the auth cleanup's startup pass audits the expired offer")
        .expect("the listener is registered");
    assert_eq!(event.event_type, "role_grant_offer_expire");
    assert_eq!(
        event.metadata.as_ref().expect("metadata")["offer_id"],
        serde_json::json!(offer.id)
    );
    // the cleanup sweeps sessions before it audits offers, so its session
    // close has run by the time the offer's audit arrives
    assert_eq!(
        *recording.closed.lock().expect("lock"),
        [ConnectionCloseTarget::Session("upkeep-expired".to_owned())],
        "the auth cleanup closes the expired session it deleted, and only that"
    );
    // the sweeper's startup pass reaps the orphan; yield until it has
    tokio::time::timeout(TIMEOUT, async {
        while orphan.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the orphan-temp sweeper's startup pass reaps the orphan");
    assert!(tasks.iter().all(|task| !task.is_finished()));

    shutdown.cancel();
    for task in tasks {
        tokio::time::timeout(TIMEOUT, task)
            .await
            .expect("cancelling the token ends each task")
            .expect("the task ends cleanly");
    }
}
