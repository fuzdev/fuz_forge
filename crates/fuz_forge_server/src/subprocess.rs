//! Subprocess streaming + buffered primitives.
//!
//! Twin of `src/lib/server/subprocess.ts` (`SpawnStreamingHandle`,
//! `SpawnStreamingOptions`, `SpawnCollectResult`, `SpawnCollectOptions`).
//! That module's `SpawnStreaming` / `SpawnCollect` capability types have no
//! counterpart here: callers reach for [`spawn_streaming`] / [`spawn_collect`]
//! directly rather than taking them injected. Local to this crate; a shared
//! `fuz_subprocess` crate is the move if `fuzd`'s sidecar runner or
//! `zzz_server`'s PTY manager need the same shape.
//!
//! ## Env isolation contract
//!
//! Both primitives **do not inherit parent env**. Callers pass exactly
//! the variables the subprocess needs (`PATH`, `GIT_TERMINAL_PROMPT=0`,
//! CGI vars). Mirrors the TS implementations' explicit `env: options.env`.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::Stdio;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

use crate::error::FuzForgeError;

/// Options for [`spawn_streaming`].
#[derive(Debug, Clone, Default)]
pub struct SpawnStreamingOptions {
    /// Explicit subprocess env. Parent env is **never** inherited.
    pub env: HashMap<String, String>,
    pub cwd: Option<PathBuf>,
}

/// Options for [`spawn_collect`].
#[derive(Debug, Clone, Default)]
pub struct SpawnCollectOptions {
    /// Explicit subprocess env. Parent env is **never** inherited.
    pub env: HashMap<String, String>,
    pub cwd: Option<PathBuf>,
    /// Optional cap on stdout/stderr bytes. Excess output kills the
    /// subprocess and returns [`FuzForgeError::PayloadTooLarge`].
    pub max_output_bytes: Option<usize>,
}

/// Streaming subprocess handle — exposes child stdio + status.
///
/// Used by the forge git smart-HTTP route to bridge the HTTP body
/// stream into `git http-backend` stdin and stream the stdout back as
/// the response body.
///
/// Callers destructure this into the owned stdio handles + [`Child`] and drive
/// the pipes themselves (see [`crate::forge_git`]).
#[derive(Debug)]
pub struct SpawnStreamingHandle {
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
    pub child: Child,
}

/// Spawn a subprocess for streaming I/O.
///
/// Always pipes stdin/stdout/stderr; **never** inherits parent env. The
/// returned [`SpawnStreamingHandle`] owns the child handles — callers
/// must drive stdin / drain stdout themselves.
///
/// # Errors
///
/// Returns [`FuzForgeError::Subprocess`] if `spawn()` fails or any stdio
/// handle can't be taken.
pub fn spawn_streaming<I, S>(
    cmd: &str,
    args: I,
    options: &SpawnStreamingOptions,
) -> Result<SpawnStreamingHandle, FuzForgeError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new(cmd);
    command
        .args(args)
        .env_clear()
        .envs(&options.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = options.cwd.as_ref() {
        command.current_dir(cwd);
    }
    let mut child = command
        .spawn()
        .map_err(|e| FuzForgeError::Subprocess(format!("spawn {cmd}: {e}")))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| FuzForgeError::Subprocess("stdin handle missing".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| FuzForgeError::Subprocess("stdout handle missing".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| FuzForgeError::Subprocess("stderr handle missing".into()))?;

    Ok(SpawnStreamingHandle {
        stdin,
        stdout,
        stderr,
        child,
    })
}

/// Result of [`spawn_collect`].
#[derive(Debug, Clone)]
pub struct SpawnCollectResult {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: i32,
}

impl SpawnCollectResult {
    #[must_use]
    pub const fn success(&self) -> bool {
        self.code == 0
    }
}

/// Spawn a subprocess and collect all output to memory.
///
/// No stdin (closes immediately). Honors `max_output_bytes` per stream
/// — exceeding it kills the subprocess and returns
/// [`FuzForgeError::PayloadTooLarge`].
///
/// TODO: no **wall-clock** timeout. `max_output_bytes` bounds how much a child
/// can produce, and nothing bounds how long it may take to produce it — a
/// `git clone --bare` against a hostile or hanging upstream, or a `git log` on
/// a pathological repo, stalls its request until the client gives up while
/// holding a subprocess slot. Both backends have the same hole (the TS
/// `SpawnCollect` in `src/lib/server/subprocess.ts`), so closing it is a paired
/// change: a deadline field on [`SpawnCollectOptions`], a
/// `tokio::time::timeout` around the drain, kill on expiry, and a typed
/// timeout variant the classifiers can map — the shape
/// [`FuzForgeError::PayloadTooLarge`] already set for the byte cap.
///
/// # Errors
///
/// Returns [`FuzForgeError::Subprocess`] on spawn/io failure;
/// [`FuzForgeError::PayloadTooLarge`] when the cap trips.
pub async fn spawn_collect<I, S>(
    cmd: &str,
    args: I,
    options: &SpawnCollectOptions,
) -> Result<SpawnCollectResult, FuzForgeError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new(cmd);
    command
        .args(args)
        .env_clear()
        .envs(&options.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = options.cwd.as_ref() {
        command.current_dir(cwd);
    }
    let mut child = command
        .spawn()
        .map_err(|e| FuzForgeError::Subprocess(format!("spawn {cmd}: {e}")))?;

    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| FuzForgeError::Subprocess("stdout handle missing".into()))?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| FuzForgeError::Subprocess("stderr handle missing".into()))?;

    let cap = options.max_output_bytes;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    // Drain in parallel with a cap check per chunk read, returning on the
    // FIRST failing drain — never waiting for the other to finish. Waiting is
    // what deadlocks: when stdout trips the cap its drain returns, but the
    // child keeps writing into a pipe nobody reads and so never exits, so
    // stderr never EOFs and a `join!` on both would never complete — child
    // alive, request hung. The TS twin kills from inside the drain
    // (`subprocess.ts`'s `spawn_collect`); `try_join!` is the same shape here.
    let drain_stdout = async { drain_capped(&mut stdout_pipe, &mut stdout, cap).await };
    let drain_stderr = async { drain_capped(&mut stderr_pipe, &mut stderr, cap).await };

    if let Err(e) = tokio::try_join!(drain_stdout, drain_stderr) {
        // `kill()` sends SIGKILL *and* reaps, so neither the cap path nor the
        // io-error path can leave a zombie behind.
        let _ = child.kill().await;
        return Err(e.into_fuz_forge());
    }

    let status = child
        .wait()
        .await
        .map_err(|e| FuzForgeError::Subprocess(format!("wait: {e}")))?;
    let code = status.code().unwrap_or(-1);

    Ok(SpawnCollectResult {
        stdout,
        stderr,
        code,
    })
}

#[derive(Debug)]
enum DrainError {
    Cap,
    Io(std::io::Error),
}

impl DrainError {
    fn into_fuz_forge(self) -> FuzForgeError {
        match self {
            Self::Cap => FuzForgeError::PayloadTooLarge,
            Self::Io(e) => FuzForgeError::Subprocess(format!("io: {e}")),
        }
    }
}

async fn drain_capped<R: AsyncReadExt + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    cap: Option<usize>,
) -> Result<(), DrainError> {
    let mut chunk = [0u8; 4096];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => return Ok(()),
            Ok(n) => {
                if let Some(cap) = cap
                    && buf.len().saturating_add(n) > cap
                {
                    return Err(DrainError::Cap);
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(e) => return Err(DrainError::Io(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// A cap trip must answer promptly, not hang.
    ///
    /// Before the `try_join!` fix this deadlocked: the shell loop writes
    /// unbounded stdout, so the stdout drain returns `Cap` immediately, but
    /// the child blocks on the full stdout pipe and never exits — so its
    /// stderr never EOFs, and waiting for BOTH drains before killing meant the
    /// request hung with the child alive. Reachable in production through
    /// `repo_commit`'s `git show -p` diff cap, `repo_blob`, and the
    /// `git clone --bare` in `repo_create` (which holds a transaction open).
    ///
    /// The `timeout` is the assertion: without the fix this test never
    /// returns.
    #[tokio::test]
    async fn spawn_collect_cap_overflow_returns_instead_of_hanging() {
        let options = SpawnCollectOptions {
            env: HashMap::from([(
                "PATH".to_owned(),
                "/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin".to_owned(),
            )]),
            cwd: None,
            max_output_bytes: Some(1024),
        };
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            // A shell builtin loop rather than `yes`, so the test doesn't
            // depend on coreutils being installed.
            spawn_collect("sh", ["-c", "while :; do echo y; done"], &options),
        )
        .await
        .expect("spawn_collect must return rather than hang on a cap trip");
        assert!(
            matches!(result, Err(FuzForgeError::PayloadTooLarge)),
            "a cap trip is PayloadTooLarge, got {result:?}"
        );
    }

    /// Output under the cap collects normally and reports the exit code.
    #[tokio::test]
    async fn spawn_collect_under_the_cap_collects_both_streams() {
        let options = SpawnCollectOptions {
            env: HashMap::from([(
                "PATH".to_owned(),
                "/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin".to_owned(),
            )]),
            cwd: None,
            max_output_bytes: Some(1024),
        };
        let result = spawn_collect("sh", ["-c", "printf out; printf err >&2; exit 3"], &options)
            .await
            .expect("a small-output command must succeed");
        assert_eq!(result.stdout, b"out");
        assert_eq!(result.stderr, b"err");
        assert_eq!(result.code, 3);
        assert!(!result.success());
    }
}
