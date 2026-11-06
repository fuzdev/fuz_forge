//! `cargo xtask check-release` — production binary dep-graph audit.
//!
//! Production binaries in the `fuz_forge` workspace (`fuzf`,
//! `fuzfd`) must not link `fuz_testing` or `fuz_audit`; the audit also
//! checks crate layering and test-only features on release edges. The
//! [`fuz_audit::xtask_main`] entry point owns the env-args
//! dispatch + usage.

fn main() -> std::process::ExitCode {
    fuz_audit::xtask_main()
}
