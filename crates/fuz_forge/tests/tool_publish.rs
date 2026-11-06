//! `fuzf tool publish` and the signing key, through the real binary: a key
//! that cannot be loaded is a configuration error (exit 2) with the loader's
//! message and hint, raised before the forge is resolved or contacted; and a
//! `testing_*` source binary is refused before the key is read.
//!
//! Every run sets `HOME`, `FUZ_HOME` and `FUZ_FORGE_HOME` to paths under one
//! scratch directory, and pins the server to the discard port on loopback.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::ffi::OsStr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// A scratch directory under the system temp dir, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "fuz_forge_tool_publish_{}",
            fuz_sys::rand::random_hex_suffix()
        ));
        std::fs::create_dir(&dir).unwrap();
        std::fs::create_dir(dir.join("home")).unwrap();
        std::fs::set_permissions(dir.join("home"), std::fs::Permissions::from_mode(0o700)).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn home(&self) -> PathBuf {
        self.0.join("home")
    }

    /// Run `fuzf tool publish fuzd no-such-binary --version 0.1.0` plus
    /// `extra`, with the fuz home at `fuz_home`.
    fn publish(&self, fuz_home: impl AsRef<OsStr>, extra: &[&str]) -> Output {
        self.publish_binary(fuz_home, "no-such-binary", extra)
    }

    /// [`Self::publish`] with the binary path named.
    fn publish_binary(&self, fuz_home: impl AsRef<OsStr>, binary: &str, extra: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_fuzf"))
            .args(["tool", "publish", "fuzd", binary, "--version", "0.1.0"])
            .args(extra)
            .current_dir(self.path())
            .env("HOME", self.home())
            .env("FUZ_HOME", fuz_home)
            .env("FUZ_FORGE_HOME", self.home().join("forge"))
            .env_remove("FUZ_FORGE_TOKEN")
            .env("FUZ_FORGE_BASE_URL", "http://127.0.0.1:9")
            .output()
            .expect("spawn fuzf")
    }

    fn entries(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[track_caller]
fn assert_config_error(out: &Output, expected: &str, context: &str) {
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{context}: {stderr}");
    assert_eq!(stderr, expected, "{context}");
    assert!(out.stdout.is_empty(), "{context}: nothing on stdout");
}

/// No key at the default location, or at the one `--key-file` names: the file
/// is named and the hint says how to make one.
#[test]
fn a_missing_signing_key_is_a_configuration_error_with_the_hint() {
    let scratch = Scratch::new();
    let hint = "hint: create a signing key with `cargo xtask key generate` in the fuz workspace\n";

    let default_key = scratch.home().join("config").join("signing.key");
    let out = scratch.publish(scratch.home(), &[]);
    assert_config_error(
        &out,
        &format!(
            "error: failed to read signing key file {0}: file not found: {0}\n{hint}",
            default_key.display()
        ),
        "the default key",
    );

    let out = scratch.publish(scratch.home(), &["--key-file", "keys/absent.key"]);
    assert_config_error(
        &out,
        &format!(
            "error: failed to read signing key file keys/absent.key: \
             file not found: keys/absent.key\n{hint}"
        ),
        "--key-file",
    );
    assert_eq!(scratch.entries(), ["home"]);
    assert_eq!(std::fs::read_dir(scratch.home()).unwrap().count(), 0);
}

/// A key file that is there and unusable: open to other users, or not a key
/// file at all.
#[test]
fn an_unusable_signing_key_says_what_to_do_about_it() {
    let scratch = Scratch::new();
    let key = scratch.path().join("signing.key");
    std::fs::write(&key, "not a key file\n").unwrap();

    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
    let out = scratch.publish(scratch.home(), &["--key-file", "./signing.key"]);
    assert_config_error(
        &out,
        "error: failed to read signing key file ./signing.key: \
         insecure permissions on ./signing.key: 100644 (expected 0600)\n\
         hint: a signing key file is its owner's alone: `chmod 600` it\n",
        "mode 0644",
    );

    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
    let out = scratch.publish(scratch.home(), &["--key-file", "./signing.key"]);
    assert_config_error(
        &out,
        "error: failed to parse key file: invalid structure\n\
         hint: Key file is malformed. Regenerate with `cargo xtask key generate`\n",
        "not a key file",
    );
}

/// A relative `FUZ_HOME` names no default key location: the home layer's
/// cause and hint, and nothing created under the working directory.
#[test]
fn a_relative_fuz_home_has_no_default_signing_key() {
    let scratch = Scratch::new();
    let out = scratch.publish("relhome", &[]);
    assert_config_error(
        &out,
        "error: failed to resolve fuz config directory: \
         FUZ_HOME must be an absolute path, got relhome\n\
         hint: set FUZ_HOME to an absolute path, or unset it to use ~/.fuz\n",
        "FUZ_HOME=relhome",
    );
    assert_eq!(scratch.entries(), ["home"]);
}

/// A `testing_*` source binary is a usage error, refused before the key is
/// read: the tarball names the binary for the tool, so nothing later sees it.
#[test]
fn a_test_binary_is_refused_before_the_key_is_read() {
    let scratch = Scratch::new();
    let out = scratch.publish_binary(scratch.home(), "target/release/testing_fuzfd", &[]);
    assert_config_error(
        &out,
        "error: refusing to publish a test binary: target/release/testing_fuzfd\n",
        "testing_ binary",
    );
    assert_eq!(scratch.entries(), ["home"]);
}
