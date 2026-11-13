//! `fuzf init --server` through the real binary: it saves the normalized URL
//! the server-URL policy returns, and refuses one every later command would
//! refuse before writing anything.
#![expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test helpers outside `#[test]` fns panic on a failed setup or check"
)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// A scratch directory under the system temp dir, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "fuz_forge_init_{}",
            fuz_sys::rand::random_hex_suffix()
        ));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Run `fuzf init --server <server>` with the forge home at `home`.
fn init(home: &Path, server: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_fuzf"))
        .args(["init", "--server", server])
        .env("FUZ_FORGE_HOME", home)
        .output()
        .expect("spawn fuzf")
}

fn saved_server(home: &Path) -> String {
    let body = std::fs::read_to_string(home.join("config.json")).unwrap();
    let config: serde_json::Value = serde_json::from_str(&body).unwrap();
    config["fuz_forge_config_server_url"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn init_saves_the_normalized_url() {
    for (server, saved) in [
        ("https://forge.example.com/", "https://forge.example.com"),
        ("https://Forge.Example.COM", "https://forge.example.com"),
        (
            "  https://forge.example.com/base/  ",
            "https://forge.example.com/base",
        ),
        ("HTTP://LOCALHOST:4041/", "http://localhost:4041"),
    ] {
        let home = Scratch::new();
        let output = init(home.path(), server);
        assert!(output.status.success(), "{server}: {output:?}");
        assert_eq!(saved_server(home.path()), saved, "{server}");
    }
}

#[test]
fn init_refuses_a_url_before_writing_it() {
    let home = Scratch::new();
    let output = init(home.path(), "http://forge.example.com");
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("plaintext"), "{stderr}");
    assert!(!home.path().join("config.json").exists());
}
