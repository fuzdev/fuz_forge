//! `fuzf repo clone` argument checks through the real binary.

use std::process::Command;

/// `--with-auth` without `--exec` is a usage error (exit 2) raised before any
/// request: the forge here is the loopback discard port, so reaching the
/// network would fail with a connection error instead.
#[test]
fn with_auth_without_exec_is_a_usage_error_offline() {
    let out = Command::new(env!("CARGO_BIN_EXE_fuzf"))
        .args(["repo", "clone", "org/repo", "--with-auth"])
        .current_dir(std::env::temp_dir())
        .env("HOME", std::env::temp_dir())
        .env_remove("FUZ_FORGE_HOME")
        .env("FUZ_FORGE_TOKEN", "secret_fuz_token_abc")
        .env("FUZ_FORGE_BASE_URL", "http://127.0.0.1:9")
        .output()
        .expect("spawn fuzf");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{stderr}");
    assert!(stderr.contains("--with-auth needs --exec"), "{stderr}");
    assert!(out.stdout.is_empty(), "nothing printed");
}
