//! Free-space preflight for the upload route.
//!
//! The per-request cap bounds *one* upload; nothing bounds the aggregate, so
//! [`check_disk_budget`] rejects (`507 storage_full`) when the fact-store volume
//! wouldn't hold the declared upload plus the configured headroom. The pure
//! decision predicate ([`has_sufficient_free_space`]) is factored out so the
//! overflow-saturating arithmetic is unit-testable without a live server.

use axum::http::StatusCode;
use axum::response::Response;

use fuz_http::rest_error_response;

/// `507 Insufficient Storage` `{ "error": "storage_full" }` — the disk-full
/// response, distinct from a generic 500 so clients can message "server out of
/// space" (non-retryable) rather than retrying a transient internal error. Used
/// by both the free-space preflight below and the mid-stream ENOSPC path
/// (`fuz_fact`'s `FactError::StorageFull`, mapped in the sibling `handlers`
/// module), so the wire shape is single-sourced.
pub fn storage_full_response() -> Response {
    rest_error_response(StatusCode::INSUFFICIENT_STORAGE, "storage_full")
}

/// Whether `free` bytes can hold a `declared`-byte upload while keeping `margin`
/// bytes of headroom. The free-space preflight's decision, factored out as a
/// pure predicate so the overflow-saturating arithmetic is unit-testable
/// without a live server. `declared + margin` saturates at `u64::MAX` so an
/// absurd declared length can't wrap and spuriously pass.
const fn has_sufficient_free_space(free: u64, declared: u64, margin: u64) -> bool {
    free >= declared.saturating_add(margin)
}

/// Free-space preflight for an upload — `Ok(())` to proceed, `Err(507
/// storage_full)` to reject before streaming.
///
/// The per-request cap bounds *one* upload but nothing bounds the aggregate, so
/// this rejects when the fact-store volume wouldn't hold the declared upload
/// plus the configured headroom. No-op without both a disk root *and* a declared
/// `Content-Length` — a chunked upload relies on the mid-stream
/// ENOSPC→`storage_full` backstop instead. A `statvfs` probe failure fails
/// *open* (logs, proceeds — the backstop still catches a real ENOSPC, and we
/// don't reject a valid upload because the probe couldn't run). Races the
/// concurrency semaphore (TOCTOU) under load, which the ENOSPC backstop closes.
#[allow(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
pub fn check_disk_budget(
    disk_root: Option<&std::path::Path>,
    declared_content_length: Option<u64>,
    margin_bytes: u64,
) -> Result<(), Response> {
    let (Some(disk_root), Some(declared)) = (disk_root, declared_content_length) else {
        return Ok(());
    };
    match fuz_sys::fs::free_space_bytes(disk_root) {
        Ok(free) if has_sufficient_free_space(free, declared, margin_bytes) => Ok(()),
        Ok(free) => {
            tracing::warn!(
                free,
                declared,
                margin = margin_bytes,
                "files.upload rejected: insufficient disk space",
            );
            Err(storage_full_response())
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "files.upload free-space preflight probe failed; proceeding (ENOSPC backstop applies)",
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parity::parity_rows;

    const FREE_SPACE_FIXTURE: &str =
        include_str!("../../../../src/test/fixtures/parity/free_space.json");

    /// The decision arithmetic, asserted against
    /// `src/test/fixtures/parity/free_space.json` — the TS twin's
    /// `has_sufficient_free_space` suite reads the same rows, minus the
    /// `rust_only` saturation edge (`declared + margin` must saturate rather
    /// than wrap, and a JS number cannot carry those values exactly).
    #[test]
    fn free_space_preflight_predicate() {
        for row in parity_rows(FREE_SPACE_FIXTURE, "cases") {
            let args: Vec<u64> = row["args"]
                .as_array()
                .expect("args is a list")
                .iter()
                .map(|v| v.as_u64().expect("args are u64"))
                .collect();
            let [free, declared, margin] = args[..] else {
                panic!("free_space rows carry three args")
            };
            assert_eq!(
                has_sufficient_free_space(free, declared, margin),
                row["accepted"].as_bool().expect("a bool"),
                "free {free}, declared {declared}, margin {margin}",
            );
        }
    }

    #[test]
    fn check_disk_budget_short_circuits_without_root_or_length() {
        // No disk root → nothing to probe → Ok (embedded-only deployment).
        assert!(check_disk_budget(None, Some(1_000), 0).is_ok());
        // No declared Content-Length (chunked upload) → defer to the ENOSPC
        // backstop → Ok.
        let tmp = std::env::temp_dir();
        assert!(check_disk_budget(Some(&tmp), None, 0).is_ok());
    }

    #[test]
    fn check_disk_budget_accepts_when_space_is_ample() {
        // A real existing dir with a 1-byte declared upload and no margin: the
        // volume comfortably holds it.
        let tmp = std::env::temp_dir();
        assert!(check_disk_budget(Some(&tmp), Some(1), 0).is_ok());
    }

    #[test]
    fn check_disk_budget_rejects_over_budget_with_507() {
        // A margin no real volume can satisfy → reject. `u64::MAX` margin also
        // exercises the saturating add (declared + margin must not wrap).
        let tmp = std::env::temp_dir();
        let err = check_disk_budget(Some(&tmp), Some(1), u64::MAX)
            .expect_err("an impossible margin must be rejected");
        assert_eq!(err.status(), StatusCode::INSUFFICIENT_STORAGE);
    }

    #[test]
    fn check_disk_budget_fails_open_when_probe_errors() {
        // A path that can't be probed (does not exist) fails *open* — we don't
        // reject a valid upload because statvfs couldn't run; the mid-stream
        // ENOSPC backstop still applies.
        let missing = std::path::Path::new("/nonexistent-fuz-forge-disk-budget-probe");
        assert!(check_disk_budget(Some(missing), Some(1_000), 0).is_ok());
    }
}
