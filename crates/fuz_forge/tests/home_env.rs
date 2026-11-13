//! End-to-end coverage of `fuzf`'s home and token resolution through the real
//! binary — the only way to drive a process environment, since the workspace
//! forbids `set_var`.
//!
//! `<fuz_forge_home>` defaults to `.fuz_forge` under `fuz_sys::home_dir`, which
//! refuses an empty or relative `HOME`. Each case seeds a token where a
//! cwd-relative `.fuz_forge` would find it, so a regression shows as that
//! read rather than the refusal. The server is the discard port on loopback,
//! so even a regression that read some other token sends it nowhere.
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
            "fuz_forge_home_env_{}",
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

/// Run `fuzf repo list` in `cwd` with `HOME` and `FUZ_FORGE_HOME` as given
/// (`None` removes it), `FUZ_FORGE_TOKEN` removed, and the server pinned to the
/// loopback discard port — so the token fallback, under the forge home, is
/// what resolves next.
fn repo_list_in(cwd: &Path, home: &str, forge_home: Option<&str>) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_fuzf"));
    cmd.args(["repo", "list"])
        .current_dir(cwd)
        .env("HOME", home)
        .env_remove("FUZ_FORGE_HOME")
        .env_remove("FUZ_FORGE_TOKEN")
        .env("FUZ_FORGE_BASE_URL", "http://127.0.0.1:9");
    if let Some(forge_home) = forge_home {
        cmd.env("FUZ_FORGE_HOME", forge_home);
    }
    cmd.output().expect("spawn fuzf")
}

/// An empty or relative `HOME` is a config error (exit 2) naming the reason,
/// with the hint — not a token read from a `.fuz_forge` under the cwd.
#[test]
fn unusable_home_is_refused() {
    for (home, token_dir, reason) in [
        ("", ".fuz_forge", "the home directory (HOME) is empty"),
        (
            "h",
            "h/.fuz_forge",
            "the home directory (HOME) is not an absolute path: h",
        ),
    ] {
        let cwd = Scratch::new();
        let token_dir = cwd.path().join(token_dir);
        std::fs::create_dir_all(&token_dir).unwrap();
        std::fs::write(token_dir.join("api_token"), "cwd-token\n").unwrap();

        let out = repo_list_in(cwd.path(), home, None);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "HOME={home:?}: {stderr}");
        assert!(
            stderr.contains(&format!(
                "cannot resolve fuz_forge home (FUZ_FORGE_HOME is unset): {reason}"
            )),
            "HOME={home:?}: {stderr}"
        );
        assert!(
            stderr.contains(
                "hint: set FUZ_FORGE_TOKEN, or set HOME to your home directory's absolute path"
            ),
            "HOME={home:?}: {stderr}"
        );
    }
}

/// A `~`-prefixed `FUZ_FORGE_HOME` with an empty or relative `HOME` is a
/// config error naming the reason — not a token read from (or a config
/// written to) a literal `~` directory under the cwd.
#[test]
fn tilde_forge_home_with_an_unusable_home_is_refused() {
    for (home, reason) in [
        ("", "the home directory (HOME) is empty"),
        ("h", "the home directory (HOME) is not an absolute path: h"),
    ] {
        let cwd = Scratch::new();
        let literal = cwd.path().join("~/x");
        std::fs::create_dir_all(&literal).unwrap();
        std::fs::write(literal.join("api_token"), "cwd-token\n").unwrap();

        let out = repo_list_in(cwd.path(), home, Some("~/x"));
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "HOME={home:?}: {stderr}");
        assert!(
            stderr.contains(&format!("cannot expand `~` in FUZ_FORGE_HOME: {reason}")),
            "HOME={home:?}: {stderr}"
        );
    }
}

/// With `FUZ_FORGE_HOME` set and no token file there, the error names that
/// file — the token is not looked for under `~/.fuz_forge` instead.
#[test]
fn a_missing_token_under_forge_home_names_that_file() {
    let cwd = Scratch::new();
    let forge_home = cwd.path().join("forge_home");
    std::fs::create_dir_all(&forge_home).unwrap();
    std::fs::create_dir_all(cwd.path().join(".fuz_forge")).unwrap();
    std::fs::write(cwd.path().join(".fuz_forge/api_token"), "home-token\n").unwrap();

    let out = repo_list_in(
        cwd.path(),
        cwd.path().to_str().unwrap(),
        Some(forge_home.to_str().unwrap()),
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{stderr}");
    assert!(
        stderr.contains(&format!(
            "no forge token: FUZ_FORGE_TOKEN is unset and {} cannot be read: ",
            forge_home.join("api_token").display()
        )),
        "{stderr}"
    );
    assert!(stderr.contains("hint: set FUZ_FORGE_TOKEN"), "{stderr}");
}

/// A relative `FUZ_FORGE_HOME` is a config error (exit 2) naming it — not a
/// forge home resolved under the cwd.
#[test]
fn a_relative_forge_home_is_refused() {
    let cwd = Scratch::new();
    std::fs::create_dir_all(cwd.path().join("rel")).unwrap();
    std::fs::write(cwd.path().join("rel/api_token"), "cwd-token\n").unwrap();

    let out = repo_list_in(cwd.path(), cwd.path().to_str().unwrap(), Some("rel"));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{stderr}");
    assert!(
        stderr.contains("FUZ_FORGE_HOME must be an absolute path, got rel"),
        "{stderr}"
    );
}

/// A malformed token is a config error (exit 2) naming where it came from and
/// what is wrong, with the hint — from the token file and from
/// `FUZ_FORGE_TOKEN` alike — and is never sent.
#[test]
fn a_malformed_token_is_refused_with_exit_2() {
    let cwd = Scratch::new();
    let forge_home = cwd.path().join("forge_home");
    std::fs::create_dir_all(&forge_home).unwrap();
    let token_file = forge_home.join("api_token");
    std::fs::write(&token_file, "two words\n").unwrap();

    let out = repo_list_in(
        cwd.path(),
        cwd.path().to_str().unwrap(),
        Some(forge_home.to_str().unwrap()),
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{stderr}");
    assert!(
        stderr.contains(&format!(
            "error: forge token from {} is malformed: it contains whitespace\n",
            token_file.display()
        )),
        "{stderr}"
    );
    assert!(
        stderr.contains("hint: a forge token is one word"),
        "{stderr}"
    );

    let out = Command::new(env!("CARGO_BIN_EXE_fuzf"))
        .args(["repo", "list"])
        .current_dir(cwd.path())
        .env("HOME", cwd.path())
        .env("FUZ_FORGE_HOME", &forge_home)
        .env("FUZ_FORGE_TOKEN", "tok\u{7}en")
        .env("FUZ_FORGE_BASE_URL", "http://127.0.0.1:9")
        .output()
        .expect("spawn fuzf");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{stderr}");
    assert!(
        stderr.contains(
            "error: forge token from FUZ_FORGE_TOKEN is malformed: \
             it contains a control character\n"
        ),
        "{stderr}"
    );
}

/// A transport failure prints the causes the HTTP client keeps as its source
/// chain after its own text, so the `error:` line says why the request was
/// not sent — here a loopback port nothing listens on.
#[test]
fn a_refused_connection_names_its_cause() {
    let cwd = Scratch::new();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let out = Command::new(env!("CARGO_BIN_EXE_fuzf"))
        .args(["repo", "list"])
        .current_dir(cwd.path())
        .env("HOME", cwd.path())
        .env_remove("FUZ_FORGE_HOME")
        .env("FUZ_FORGE_TOKEN", "token")
        .env("FUZ_FORGE_BASE_URL", format!("http://127.0.0.1:{port}"))
        .output()
        .expect("spawn fuzf");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(1), "{stderr}");
    let line = stderr.lines().next().unwrap_or_default();
    assert!(
        line.starts_with(&format!(
            "error: error sending request for url (http://127.0.0.1:{port}/"
        )),
        "{stderr}"
    );
    assert!(
        line.ends_with(": Connection refused (os error 111)"),
        "{stderr}"
    );
}

/// A declined confirmation prints its own prompt to stdout and exits 2 with
/// nothing on stderr — no `error:` line under the prompt.
#[test]
fn a_declined_confirmation_prints_no_error_line() {
    let cwd = Scratch::new();
    let out = Command::new(env!("CARGO_BIN_EXE_fuzf"))
        .args(["repo", "resync", "org/repo"])
        .current_dir(cwd.path())
        .env("HOME", cwd.path())
        .env_remove("FUZ_FORGE_HOME")
        .env("FUZ_FORGE_TOKEN", "token")
        .env("FUZ_FORGE_BASE_URL", "http://127.0.0.1:9")
        .output()
        .expect("spawn fuzf");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{stdout}{stderr}");
    assert!(stdout.contains("Run with --yes to confirm."), "{stdout}");
    assert_eq!(stderr, "");
}

/// `FUZ_FORGE_BASE_URL` is read by the resolver `fuz` shares: a blank value
/// is unset, falling through to `config.json` (absent here, so no server is
/// configured), and a non-UTF-8 one is refused rather than read as unset.
/// Both are config errors (exit 2), each with its own hint.
#[test]
fn forge_base_url_env_blank_is_unset_and_non_utf8_is_refused() {
    use std::os::unix::ffi::OsStrExt as _;
    for (value, message, hint) in [
        (
            std::ffi::OsStr::new("  \n"),
            "error: fuz_forge server URL not configured\n",
            "hint: run `fuzf init",
        ),
        (
            std::ffi::OsStr::from_bytes(b"http://127.0.0.1:9\xff"),
            "error: FUZ_FORGE_BASE_URL is not valid UTF-8\n",
            "hint: unset or fix FUZ_FORGE_BASE_URL (it must be UTF-8)",
        ),
    ] {
        let cwd = Scratch::new();
        let out = Command::new(env!("CARGO_BIN_EXE_fuzf"))
            .args(["repo", "list"])
            .current_dir(cwd.path())
            .env("HOME", cwd.path())
            .env("FUZ_FORGE_HOME", cwd.path().join("forge_home"))
            .env("FUZ_FORGE_TOKEN", "token")
            .env("FUZ_FORGE_BASE_URL", value)
            .output()
            .expect("spawn fuzf");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{stderr}");
        assert!(stderr.starts_with(message), "{stderr}");
        assert!(stderr.contains(hint), "{stderr}");
    }
}
