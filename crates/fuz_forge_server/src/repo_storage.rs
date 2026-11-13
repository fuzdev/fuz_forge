//! On-disk storage for forge-hosted bare git repositories.
//!
//! Rust port of `src/lib/fuz_forge/repo/storage.ts`. Repos live at
//! `<store>/<id>.git/`. All write paths are atomic: assemble the bare repo (or
//! clone) in a temp sibling directory then `rename` over the canonical path so
//! partial state is never visible. Failures clean up the temp dir
//! best-effort.
//!
//! Hook scripts (`pre-receive`, `post-receive`) installed under `hooks/` are
//! python3 that call back into the forge server over `127.0.0.1` (HTTP to a
//! localhost-bound endpoint with a per-repo shared secret). `pre-receive`
//! enforces force-push protection on the default branch; `post-receive`
//! records push metadata on the repo cell (the `/internal/*` routes in
//! [`crate::internal_routes`], mounted by [`crate::router`]).
#![expect(
    clippy::missing_errors_doc,
    reason = "the storage fns fail with a `String` naming the failed git or filesystem step, which their summaries don't enumerate"
)]

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::forge_git::read::git_env;
use crate::subprocess::{SpawnCollectOptions, spawn_collect};

/// Cap on stdout/stderr collected from storage subprocesses (git/chmod).
const MAX_CMD_OUTPUT: usize = 1_000_000;

/// Derive the on-disk bare-repo path for a cell id under `store_root`.
#[must_use]
pub fn repo_dir(store_root: &Path, id: Uuid) -> PathBuf {
    store_root.join(format!("{id}.git"))
}

/// Compose the localhost callback base URL embedded into hook scripts.
///
/// The hooks POST to `<base>/internal/repo-receive-callback`. Mirrors
/// `storage.ts:build_callback_url_base`, which takes its env deps for the same
/// reason this takes `port`: the value is read through the
/// [`crate::env::FuzForgeEnv::from_vars`] seam (`PORT`), not a `std::env::var`
/// here, so a test can inject it. The callback always targets loopback, never
/// the bind host (which may be `0.0.0.0`).
///
/// `port` is `None` only when `PORT` is unset, and then it falls back to this
/// backend's own default bind port ([`crate::runtime::DEFAULT_ADDR`] = 4041).
///
/// **Intentional divergence from the TS twin**, whose `DEFAULT_CALLBACK_PORT`
/// (`storage.ts`) falls back to 4040 (its own `BaseServerEnv.PORT` bind
/// default). Each backend's fallback matches its own default bind, so the hook
/// callback can never aim at a port the server isn't on — converging the
/// numbers was rejected for exactly that reason. Dead-path in practice: `PORT`
/// is always set explicitly (dev = 4041 both, prod = 4040, tests = 14041/14141).
#[must_use]
pub fn build_callback_url_base(port: Option<u16>) -> String {
    let port = port.unwrap_or_else(|| crate::runtime::DEFAULT_ADDR.port());
    format!("http://127.0.0.1:{port}")
}

/// The `-c` overrides every `seed_from` clone runs under, in argv order.
///
/// - `http.followRedirects=false` — git's default (`initial`) follows a
///   redirect on the first request, so an admitted public host could answer
///   `302` to a loopback, link-local or LAN address and send the clone past
///   the host policy (`handlers::seed_from`), which judges only the URL it was
///   given. With redirects refused, the host the policy judged is the only
///   host git dials; a seed that redirects fails, and the operator gives the
///   final URL instead. Refusing redirects also refuses dumb-HTTP alternates
///   on another host.
/// - `protocol.allow=never` + `protocol.{http,https}.allow=always` — the
///   transports the `seed_from` grammar admits, pinned in git itself so a
///   transport the grammar never meant to admit is refused even if the
///   grammar regresses.
///
/// Command-line `-c` outranks every config file, and [`git_env`] already
/// keeps `/etc/gitconfig`, `~/.gitconfig` and any inherited
/// `GIT_CONFIG_PARAMETERS` out, so nothing can undo these. Twin of
/// `SEED_CLONE_GIT_CONFIG` in `storage.ts`; both are asserted against
/// `src/test/fixtures/parity/seed_clone.json`.
pub(crate) const SEED_CLONE_GIT_CONFIG: &[&str] = &[
    "http.followRedirects=false",
    "protocol.allow=never",
    "protocol.http.allow=always",
    "protocol.https.allow=always",
];

/// The `git` argv for a `seed_from` clone: the [`SEED_CLONE_GIT_CONFIG`]
/// overrides, then `clone --bare <url> <dest>`. Twin of `seed_clone_args` in
/// `storage.ts`.
#[must_use]
pub(crate) fn seed_clone_args(url: &str, dest: &str) -> Vec<String> {
    let mut args = Vec::with_capacity(SEED_CLONE_GIT_CONFIG.len() * 2 + 4);
    for entry in SEED_CLONE_GIT_CONFIG {
        args.push("-c".to_owned());
        args.push((*entry).to_owned());
    }
    args.extend([
        "clone".to_owned(),
        "--bare".to_owned(),
        url.to_owned(),
        dest.to_owned(),
    ]);
    args
}

/// Run a command, mapping a non-zero exit — or a spawn failure — to an error
/// string carrying stderr (falling back to stdout) for the handler to log.
///
/// Twin of `run_ok` in `storage.ts`, down to both message shapes
/// (`<label>: spawn failed: <detail>` and `<label> failed: <detail>`) and the
/// label strings the callers pass. The detail is log-only — every caller's
/// failure surfaces to clients as the route's own generic message.
async fn run_ok(git_path: &str, cmd: &str, args: Vec<String>, label: &str) -> Result<(), String> {
    let opts = SpawnCollectOptions {
        env: git_env(git_path),
        cwd: None,
        max_output_bytes: Some(MAX_CMD_OUTPUT),
    };
    let res = spawn_collect(cmd, args, &opts)
        .await
        .map_err(|e| format!("{label}: spawn failed: {e}"))?;
    if res.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&res.stderr);
    let stderr = stderr.trim();
    let detail = if stderr.is_empty() {
        String::from_utf8_lossy(&res.stdout).into_owned()
    } else {
        stderr.to_owned()
    };
    Err(format!("{label} failed: {detail}"))
}

async fn path_exists(path: &Path) -> bool {
    tokio::fs::metadata(path).await.is_ok()
}

/// `<final>.tmp.<uuid>` — a unique sibling for atomic assembly.
fn tmp_path_for(final_path: &Path) -> PathBuf {
    let mut s = final_path.as_os_str().to_owned();
    s.push(format!(".tmp.{}", Uuid::new_v4()));
    PathBuf::from(s)
}

/// `git-daemon-export-ok` marker + `http.{receivepack,uploadpack}=true` so
/// `git http-backend` serves this repo (per-repo opt-in; `GIT_HTTP_EXPORT_ALL`
/// is intentionally never set on the CGI subprocess).
async fn configure_http_export(git_path: &str, repo_dir: &Path) -> Result<(), String> {
    tokio::fs::write(repo_dir.join("git-daemon-export-ok"), b"")
        .await
        .map_err(|e| format!("write git-daemon-export-ok failed: {e}"))?;
    for (key, value) in [("http.receivepack", "true"), ("http.uploadpack", "true")] {
        run_ok(
            git_path,
            "git",
            vec![
                "-C".into(),
                repo_dir.display().to_string(),
                "config".into(),
                key.into(),
                value.into(),
            ],
            &format!("git config {key}={value}"),
        )
        .await?;
    }
    Ok(())
}

/// Shrink the bare repo to owner-only (`chmod -R go-rwx`) — the hook scripts
/// embed the per-repo callback secret in plaintext, so the whole tree gets the
/// locked-down posture. `go-rwx` (not a literal `0700`) keeps git's owner bits
/// intact so `git fsck` stays happy.
async fn restrict_repo_perms(git_path: &str, repo_dir: &Path) -> Result<(), String> {
    run_ok(
        git_path,
        "chmod",
        vec!["-R".into(), "go-rwx".into(), repo_dir.display().to_string()],
        "chmod -R go-rwx",
    )
    .await
}

/// Initialize a bare repo at `<store>/<id>.git/` via `git init --bare`.
///
/// Atomic: builds in a temp sibling, then renames into place. Errors if the
/// final path already exists (caller detects the cell-path collision first).
pub async fn init_bare_repo(
    git_path: &str,
    store_root: &Path,
    id: Uuid,
) -> Result<PathBuf, String> {
    assemble_bare_repo(git_path, store_root, id, None).await
}

/// Clone a bare repo into `<store>/<id>.git/` from `seed_from_url`
/// (`git clone --bare`). Atomic, same as [`init_bare_repo`].
pub async fn clone_bare_repo(
    git_path: &str,
    store_root: &Path,
    id: Uuid,
    seed_from_url: &str,
) -> Result<PathBuf, String> {
    assemble_bare_repo(git_path, store_root, id, Some(seed_from_url)).await
}

/// Shared atomic-assembly body for init (`seed_from = None`) and clone.
async fn assemble_bare_repo(
    git_path: &str,
    store_root: &Path,
    id: Uuid,
    seed_from: Option<&str>,
) -> Result<PathBuf, String> {
    tokio::fs::create_dir_all(store_root)
        .await
        .map_err(|e| format!("mkdir repo store failed: {e}"))?;
    let final_path = repo_dir(store_root, id);
    if path_exists(&final_path).await {
        return Err(format!(
            "repo path already exists: {}",
            final_path.display()
        ));
    }
    let tmp = tmp_path_for(&final_path);
    let build = async {
        if let Some(url) = seed_from {
            // `run_ok` bounds git's output at `MAX_CMD_OUTPUT` on both backends
            // and kills the child on the trip — the TS twin passes the same
            // literal through its own `run_ok`
            // (`src/lib/fuz_forge/repo/storage.ts`).
            //
            // TODO: neither backend puts a **wall-clock** timeout on the clone,
            // so an upstream that accepts the connection and then trickles (or
            // stalls) holds this task — and, on the create path, the open
            // transaction — for as long as it likes. See the TODO on
            // `crate::subprocess::spawn_collect`.
            //
            // `seed_from` is grammar-checked, host-checked and canonicalized at
            // the RPC input boundary
            // (`handlers::seed_from::require_seed_from_url`), so the remote
            // is an absolute credential-free public http(s) URL in its
            // serialized form, and [`SEED_CLONE_GIT_CONFIG`] refuses
            // redirects — the host that was validated is the only host git
            // dials here.
            run_ok(
                git_path,
                "git",
                seed_clone_args(url, &tmp.display().to_string()),
                "git clone --bare",
            )
            .await?;
        } else {
            run_ok(
                git_path,
                "git",
                vec!["init".into(), "--bare".into(), tmp.display().to_string()],
                "git init --bare",
            )
            .await?;
        }
        configure_http_export(git_path, &tmp).await?;
        restrict_repo_perms(git_path, &tmp).await?;
        tokio::fs::rename(&tmp, &final_path)
            .await
            .map_err(|e| format!("rename into place failed: {e}"))?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(e) = build {
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        return Err(e);
    }
    Ok(final_path)
}

/// Point the bare repo's `HEAD` at `refs/heads/<default_branch>` via
/// `git symbolic-ref`.
///
/// `git init`'s default varies by git config and a seed clone inherits
/// upstream's default, so normalize it to the requested branch.
pub async fn set_default_head(
    git_path: &str,
    store_root: &Path,
    id: Uuid,
    default_branch: &str,
) -> Result<(), String> {
    let repo = repo_dir(store_root, id);
    run_ok(
        git_path,
        "git",
        vec![
            "-C".into(),
            repo.display().to_string(),
            "symbolic-ref".into(),
            "HEAD".into(),
            format!("refs/heads/{default_branch}"),
        ],
        "git symbolic-ref HEAD",
    )
    .await
}

/// Remove a repo's bare directory best-effort (unwind a partial create when
/// the surrounding transaction rolls the cell back).
pub async fn remove_repo_dir(store_root: &Path, id: Uuid) {
    let _ = tokio::fs::remove_dir_all(repo_dir(store_root, id)).await;
}

/// Install pre-receive + post-receive hooks under `<store>/<id>.git/hooks/`
/// and mark them executable (`0700` — they embed the callback secret).
/// Replaces any existing script of the same name.
pub async fn install_hooks(
    git_path: &str,
    store_root: &Path,
    id: Uuid,
    hook_secret: &str,
    callback_url_base: &str,
) -> Result<(), String> {
    let hooks_dir = repo_dir(store_root, id).join("hooks");
    tokio::fs::create_dir_all(&hooks_dir)
        .await
        .map_err(|e| format!("mkdir hooks failed: {e}"))?;
    let scripts = [
        (
            "pre-receive",
            render_pre_receive_hook(id, hook_secret, callback_url_base),
        ),
        (
            "post-receive",
            render_post_receive_hook(id, hook_secret, callback_url_base),
        ),
    ];
    for (name, body) in scripts {
        let path = hooks_dir.join(name);
        tokio::fs::write(&path, body)
            .await
            .map_err(|e| format!("write hook {name} failed: {e}"))?;
        run_ok(
            git_path,
            "chmod",
            vec!["0700".into(), path.display().to_string()],
            &format!("chmod 0700 {name}"),
        )
        .await?;
    }
    Ok(())
}

/// The hook scripts [`install_hooks`] writes, by file name under `hooks/`.
/// Twin of the TS `HOOK_NAMES` in `storage.ts`.
const HOOK_NAMES: [&str; 2] = ["pre-receive", "post-receive"];

/// A repo's hook scripts as they stood before a rewrite, so a failed rewrite
/// can put them back ([`restore_hooks`]).
///
/// The cell keeps only a digest of the hook secret, so a rollback cannot
/// re-render the old scripts from the cell; it restores their bytes instead.
/// `None` records a script that was absent. The bytes embed the plaintext
/// secret, so the type has no `Debug` that would print them.
pub struct HookSnapshot {
    scripts: Vec<(&'static str, Option<Vec<u8>>)>,
}

impl std::fmt::Debug for HookSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HookSnapshot")
            .field("scripts", &"<redacted>")
            .finish()
    }
}

/// Read a repo's installed hook scripts into a [`HookSnapshot`]. A missing
/// script is recorded as absent; any other read failure is an error, raised
/// before the caller has written anything.
pub async fn snapshot_hooks(store_root: &Path, id: Uuid) -> Result<HookSnapshot, String> {
    let hooks_dir = repo_dir(store_root, id).join("hooks");
    let mut scripts = Vec::with_capacity(HOOK_NAMES.len());
    for name in HOOK_NAMES {
        let bytes = match tokio::fs::read(hooks_dir.join(name)).await {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("read hook {name} failed: {e}")),
        };
        scripts.push((name, bytes));
    }
    Ok(HookSnapshot { scripts })
}

/// Put a repo's hook scripts back as a [`HookSnapshot`] recorded them: each
/// recorded script rewritten byte for byte and re-`chmod`ed `0700`, each
/// absent one removed.
pub async fn restore_hooks(
    git_path: &str,
    store_root: &Path,
    id: Uuid,
    snapshot: &HookSnapshot,
) -> Result<(), String> {
    let hooks_dir = repo_dir(store_root, id).join("hooks");
    for (name, bytes) in &snapshot.scripts {
        let path = hooks_dir.join(name);
        match bytes {
            Some(bytes) => {
                tokio::fs::write(&path, bytes)
                    .await
                    .map_err(|e| format!("restore hook {name} failed: {e}"))?;
                run_ok(
                    git_path,
                    "chmod",
                    vec!["0700".into(), path.display().to_string()],
                    &format!("chmod 0700 {name}"),
                )
                .await?;
            }
            None => match tokio::fs::remove_file(&path).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("remove hook {name} failed: {e}")),
            },
        }
    }
    Ok(())
}

/// The three `FUZ_FORGE_*` config assignments shared by both hook scripts,
/// each value rendered as a safe python literal.
fn hook_config_block(id: Uuid, hook_secret: &str, callback_url_base: &str) -> String {
    format!(
        "FUZ_FORGE_REPO_ID = {}\nFUZ_FORGE_HOOK_SECRET = {}\nFUZ_FORGE_CALLBACK_BASE = {}\n",
        python_literal(&id.to_string()),
        python_literal(hook_secret),
        python_literal(callback_url_base),
    )
}

/// Shared shebang + import preamble for both generated hook scripts (the
/// pre- and post-receive headers are byte-identical, so they single-source here).
/// Twin of the TS `HOOK_HEADER` in `storage.ts`; the two backends must write the
/// same bytes to disk.
const HOOK_HEADER: &str = r"#!/usr/bin/env python3
# Installed by fuz_forge.
import json
import os
import sys
import urllib.error
import urllib.request

";

const PRE_RECEIVE_BODY: &str = r#"
ZERO_SHA = "0000000000000000000000000000000000000000"


def die(message: str) -> "None":
    print(f"fuz_forge: {message}", file=sys.stderr)
    sys.exit(1)


def fetch_default_branch() -> str:
    req = urllib.request.Request(
        f"{FUZ_FORGE_CALLBACK_BASE}/internal/repo-config/{FUZ_FORGE_REPO_ID}",
        headers={"X-FuzForge-Repo-Secret": FUZ_FORGE_HOOK_SECRET},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            payload = json.load(resp)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as err:
        die(f"pre-receive callback failed (daemon unreachable?): {err}")
    branch = payload.get("default_branch") if isinstance(payload, dict) else None
    if not isinstance(branch, str) or not branch:
        die("could not read default_branch from daemon")
    return branch


def is_ancestor(old: str, new: str) -> bool:
    import subprocess
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", old, new],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def main() -> "None":
    default_branch = fetch_default_branch()
    default_ref = f"refs/heads/{default_branch}"
    for line in sys.stdin:
        parts = line.split()
        if len(parts) < 3:
            continue
        old, new, ref = parts[0], parts[1], parts[2]
        if ref == default_ref and old != ZERO_SHA:
            if not is_ancestor(old, new):
                die(f"non-fast-forward push to {default_branch} rejected")


if __name__ == "__main__":
    main()
"#;

const POST_RECEIVE_BODY: &str = r#"

def die(message: str) -> "None":
    print(f"fuz_forge: {message}", file=sys.stderr)
    sys.exit(1)


def main() -> "None":
    updates = []
    for line in sys.stdin:
        parts = line.split()
        if len(parts) < 3:
            continue
        updates.append({"old": parts[0], "new": parts[1], "ref": parts[2]})

    body = json.dumps({
        "repo_id": FUZ_FORGE_REPO_ID,
        "updates": updates,
        "pushed_by": os.environ.get("FUZ_FORGE_PUSH_ACCOUNT_ID") or None,
        "push_username": os.environ.get("FUZ_FORGE_PUSH_USERNAME") or None,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{FUZ_FORGE_CALLBACK_BASE}/internal/repo-receive-callback",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-FuzForge-Repo-Secret": FUZ_FORGE_HOOK_SECRET,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as err:
        die(f"post-receive callback failed: {err}")


if __name__ == "__main__":
    main()
"#;

fn render_pre_receive_hook(id: Uuid, hook_secret: &str, callback_url_base: &str) -> String {
    format!(
        "{HOOK_HEADER}{}{PRE_RECEIVE_BODY}",
        hook_config_block(id, hook_secret, callback_url_base),
    )
}

fn render_post_receive_hook(id: Uuid, hook_secret: &str, callback_url_base: &str) -> String {
    format!(
        "{HOOK_HEADER}{}{POST_RECEIVE_BODY}",
        hook_config_block(id, hook_secret, callback_url_base),
    )
}

/// Render `value` as a safe single-quoted python3 string literal, escaping
/// quotes, backslashes, and non-printables via `\xNN` / `\uNNNN` / `\UNNNNNNNN`
/// — so embedding config into hook scripts never depends on the input charset.
/// Mirrors `storage.ts:python_literal`.
fn python_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        let code = ch as u32;
        match ch {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ if code < 0x20 || code == 0x7f => {
                let _ = write!(out, "\\x{code:02x}");
            }
            _ if code > 0xffff => {
                let _ = write!(out, "\\U{code:08x}");
            }
            _ if code > 0x7e => {
                let _ = write!(out, "\\u{code:04x}");
            }
            _ => out.push(ch),
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpListener;

    use super::*;
    use crate::forge_git::read::DEFAULT_GIT_PATH;
    use crate::parity::{field, parity_rows};

    const SEED_CLONE_FIXTURE: &str =
        include_str!("../../../src/test/fixtures/parity/seed_clone.json");

    /// The seed clone's argv is a security surface written twice, so both
    /// halves are asserted against `src/test/fixtures/parity/seed_clone.json`,
    /// which the TS twin's storage suite reads too.
    #[test]
    fn seed_clone_args_match_the_ts_twin() {
        let config: Vec<String> = parity_rows(SEED_CLONE_FIXTURE, "config")
            .iter()
            .map(|row| field(row, "value").to_owned())
            .collect();
        assert_eq!(config, SEED_CLONE_GIT_CONFIG);
        for row in parity_rows(SEED_CLONE_FIXTURE, "argv") {
            let expected: Vec<String> =
                serde_json::from_value(row["expected"].clone()).expect("argv row");
            assert_eq!(
                seed_clone_args(field(&row, "url"), field(&row, "dest")),
                expected
            );
        }
    }

    /// A scratch directory under the system temp dir, removed on drop (the
    /// workspace deliberately doesn't dep `tempfile`).
    struct ScratchDir(PathBuf);

    impl ScratchDir {
        fn create(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "fuz_forge_repo_storage_{label}_{}",
                fuz_sys::rand::random_hex_suffix()
            ));
            std::fs::create_dir_all(&dir).expect("create scratch dir");
            Self(dir)
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn test_git_path() -> String {
        std::env::var("PATH").unwrap_or_else(|_| DEFAULT_GIT_PATH.to_owned())
    }

    /// Bind a loopback listener that counts the connections it accepts and
    /// answers each with `response` (closing it after).
    async fn counting_server(response: String) -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("local addr").port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                let response = response.clone();
                tokio::spawn(async move {
                    // Drain the request head before answering, so curl sees
                    // a response rather than a reset.
                    let mut buf = vec![0_u8; 8192];
                    let mut head = Vec::new();
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => head.extend_from_slice(&buf[..n]),
                        }
                    }
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (port, hits)
    }

    /// The host policy judges the seed URL it was handed, so a redirect is a
    /// way past it: an admitted public host answers `302` to a loopback or
    /// link-local address. The seed clone must fail without ever dialing the
    /// redirect target — a second loopback listener that records every
    /// connection stands in for it.
    #[tokio::test]
    async fn seed_clone_refuses_a_redirect_without_dialing_its_target() {
        let (target_port, target_hits) = counting_server(
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned(),
        )
        .await;
        let (origin_port, origin_hits) = counting_server(format!(
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target_port}/x.git/info/refs?service=git-upload-pack\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        ))
        .await;
        let store = ScratchDir::create("redirect");
        let result = clone_bare_repo(
            &test_git_path(),
            &store.0,
            Uuid::new_v4(),
            &format!("http://127.0.0.1:{origin_port}/x.git"),
        )
        .await;
        assert!(result.is_err(), "a redirecting seed must fail the clone");
        assert!(
            origin_hits.load(Ordering::SeqCst) > 0,
            "the clone dialed the seed origin"
        );
        assert_eq!(
            target_hits.load(Ordering::SeqCst),
            0,
            "the clone must not dial the redirect target"
        );
    }

    /// The transport pin holds independently of the `seed_from` grammar: a
    /// local path (git's `file` transport) is refused by git itself.
    #[tokio::test]
    async fn seed_clone_refuses_a_non_http_transport() {
        let scratch = ScratchDir::create("file_transport");
        let upstream = scratch.0.join("upstream.git");
        let status = std::process::Command::new("git")
            .args(["init", "--bare", "--quiet"])
            .arg(&upstream)
            .status()
            .expect("spawn `git init --bare` (this test needs `git` on PATH)");
        assert!(status.success(), "`git init --bare` failed");
        let result = clone_bare_repo(
            &test_git_path(),
            &scratch.0.join("store"),
            Uuid::new_v4(),
            &upstream.display().to_string(),
        )
        .await;
        let err = result.expect_err("a local-path seed must be refused by the transport pin");
        assert!(err.contains("transport 'file' not allowed"), "{err}");
    }

    /// A rotate rollback restores the hooks from their bytes: a recorded
    /// script comes back byte for byte, a script absent at snapshot time is
    /// removed. Twin of the TS rotate-secret recovery cases.
    #[tokio::test]
    async fn restore_hooks_puts_back_the_snapshot() {
        let store = ScratchDir::create("restore_hooks");
        let id = Uuid::new_v4();
        let hooks_dir = repo_dir(&store.0, id).join("hooks");
        std::fs::create_dir_all(&hooks_dir).expect("create hooks dir");
        let pre = hooks_dir.join("pre-receive");
        let post = hooks_dir.join("post-receive");
        std::fs::write(&pre, b"old pre\n").expect("write pre-receive");

        let snapshot = snapshot_hooks(&store.0, id).await.expect("snapshot");
        std::fs::write(&pre, b"new pre\n").expect("overwrite pre-receive");
        std::fs::write(&post, b"new post\n").expect("write post-receive");

        restore_hooks(&test_git_path(), &store.0, id, &snapshot)
            .await
            .expect("restore");
        assert_eq!(std::fs::read(&pre).expect("read pre-receive"), b"old pre\n");
        assert!(!post.exists(), "a hook absent at snapshot time is removed");
    }

    /// Only a missing script reads as absent: any other read failure (here a
    /// directory where a script should be) refuses the snapshot.
    #[tokio::test]
    async fn snapshot_hooks_refuses_an_unreadable_script() {
        let store = ScratchDir::create("snapshot_unreadable");
        let id = Uuid::new_v4();
        let hooks_dir = repo_dir(&store.0, id).join("hooks");
        std::fs::create_dir_all(hooks_dir.join("pre-receive")).expect("create dir");
        let err = snapshot_hooks(&store.0, id)
            .await
            .expect_err("an unreadable hook refuses the snapshot");
        assert!(err.contains("read hook pre-receive failed"), "{err}");
    }

    #[test]
    fn python_literal_escapes() {
        assert_eq!(python_literal("main"), "'main'");
        assert_eq!(python_literal("a'b"), "'a\\'b'");
        assert_eq!(python_literal("a\\b"), "'a\\\\b'");
        assert_eq!(python_literal("a\nb"), "'a\\nb'");
    }

    #[test]
    fn callback_base_takes_port_only() {
        // Always loopback — only the numeric `PORT` matters for the callback,
        // and it arrives already parsed through the `FuzForgeEnv` seam.
        assert_eq!(
            build_callback_url_base(Some(14141)),
            "http://127.0.0.1:14141"
        );
        assert_eq!(build_callback_url_base(Some(4041)), "http://127.0.0.1:4041");
        // `PORT` unset → this backend's own production default bind port.
        assert_eq!(
            build_callback_url_base(None),
            format!("http://127.0.0.1:{}", crate::runtime::DEFAULT_ADDR.port())
        );
    }

    #[test]
    fn hooks_embed_config() {
        let id = Uuid::nil();
        let pre = render_pre_receive_hook(id, "sek'ret", "http://127.0.0.1:14141");
        assert!(pre.contains("FUZ_FORGE_HOOK_SECRET = 'sek\\'ret'"));
        assert!(pre.contains("/internal/repo-config/"));
        let post = render_post_receive_hook(id, "s", "http://127.0.0.1:14141");
        assert!(post.contains("/internal/repo-receive-callback"));
    }
}
