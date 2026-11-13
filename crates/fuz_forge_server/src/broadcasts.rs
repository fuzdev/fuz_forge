//! fuz_forge-specific WS broadcasts.
//!
//! Per `src/lib/server/backend_action_types.gen.ts`:
//!
//! | Method | Trigger | Audience | Notes |
//! |---|---|---|---|
//! | `fuz_forge_repo_updated` | `POST /internal/repo-receive-callback` post-cell-update | every admin WS | `{repo_id, head_sha, last_pushed_at, last_pushed_by}` |
//!
//! `repo_id` is the repo's cell-id UUID (the wire/dir handle). The audience
//! is every admin WS connection, and what makes that true is the endpoint's
//! role gate — the `vec![fuz_auth::ROLE_ADMIN]` passed to `ws_route_state`
//! (`router/compose.rs`), the twin of
//! the TS server's `build_ws_endpoint_specs` (`required_roles: [ROLE_ADMIN]`).
//! The gate holds for the socket's lifetime, not just at the upgrade: revoking
//! an account's global `admin` grant closes its forge sockets with
//! `WS_CLOSE_PERMISSION_REVOKED` (4006), on both backends, so a demoted admin
//! stops receiving broadcasts. The shared contract leaves that close unordered
//! against the revoke's own `role_grant_revoked` notification, and the two
//! spines differ: the TS spine sends the frame and then closes; here the close
//! runs first in the post-commit drain and removes the connection, so the frame
//! is never sent. [`ConnectionRegistry::broadcast`] applies **no** per-recipient
//! filter, so that gate is the whole ACL: weaken or drop it and every broadcast
//! below reaches every socket it admits. Future per-account scoping plugs into
//! [`ConnectionRegistry::broadcast_filtered`] via a `should_deliver` predicate.
//!
//! There are no run/apply broadcasts: the forge delegates provisioning and
//! deploys to the `zap` CLI and has no convergence run to report on.

use std::sync::Arc;

use fuz_realtime::ConnectionRegistry;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Method names — single source of truth so handlers + tests reference
/// one constant.
pub mod methods {
    pub const FUZ_FORGE_REPO_UPDATED: &str = "fuz_forge_repo_updated";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FuzForgeRepoUpdatedParams {
    pub repo_id: String,
    pub head_sha: Option<String>,
    pub last_pushed_at: Option<String>,
    pub last_pushed_by: Option<String>,
}

/// Build a JSON-RPC notification envelope string for a broadcast.
///
/// The notification envelope shape is shared by HTTP-no-op and WS
/// dispatch. Callers serialize once and send the same bytes to every
/// recipient via [`ConnectionRegistry::broadcast`] / `broadcast_filtered`.
#[must_use]
pub fn build_notification(method: &str, params: &Value) -> String {
    fuz_http::notification(method, params)
}

/// Send a `fuz_forge_repo_updated` broadcast to every admin WS connection.
///
/// Today there's no `should_deliver` predicate — the endpoint's
/// `required_roles: vec![ROLE_ADMIN]` gate is what makes "every connection"
/// mean "every admin". When per-user scoping lands, swap to
/// [`ConnectionRegistry::broadcast_filtered`].
pub fn broadcast_repo_updated(
    realtime: &Arc<ConnectionRegistry>,
    params: FuzForgeRepoUpdatedParams,
) -> usize {
    broadcast(realtime, methods::FUZ_FORGE_REPO_UPDATED, params)
}

fn broadcast<T: Serialize>(realtime: &Arc<ConnectionRegistry>, method: &str, params: T) -> usize {
    let params_value = match serde_json::to_value(&params) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                error = %fuz_sys::cli::format_error_chain(&e),
                method,
                "broadcast params serialization failed"
            );
            return 0;
        }
    };
    let body = build_notification(method, &params_value);
    if body.is_empty() {
        // `fuz_http::notification` returns an empty string on
        // serialization failure (warns internally); guard against
        // emitting an empty WS frame to recipients.
        return 0;
    }
    realtime.broadcast(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_envelope_shape() {
        let body = build_notification(
            methods::FUZ_FORGE_REPO_UPDATED,
            &serde_json::json!({"repo_id": "fuz_app", "head_sha": null}),
        );
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["method"], methods::FUZ_FORGE_REPO_UPDATED);
        assert_eq!(v["jsonrpc"], "2.0");
        assert!(v.get("params").is_some());
    }
}
