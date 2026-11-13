//! `git http-backend` CGI streaming proxy.
//!
//! Twin of `src/lib/server/routes/git_cgi.ts`. [`proxy_to_git_http_backend`] is
//! a thin orchestrator over named streaming stages, in this fixed order (the ordering
//! is load-bearing — guarded by `repo_push.cross.test.ts` +
//! `repo_git.cgi_head.db.test.ts`):
//!
//! 1. [`build_cgi_env`] — pure CGI env map.
//! 2. [`spawn_http_backend`] — spawn `git http-backend` (503 on failure).
//! 3. [`pipe_request_body`] — stream the request body into stdin (background).
//! 4. [`read_cgi_head`] — drain stdout until the CGI separator (502 on cap /
//!    read error / EOF-before-separator).
//! 5. [`parse_cgi_head`] — pure CGI head parse.
//! 6. [`drain_stderr`] — surface subprocess complaints to the log (background).
//! 7. [`build_proxy_response`] — assemble status + headers + the never-buffered
//!    streamed body.
//!
//! [`reap_child`] and [`apply_cgi_headers`] are Rust-only stages with no TS
//! analog (the runtime reaps the child for the TS twin, and `new Response(...)`
//! has no default-header collision to dedup).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{StreamExt as _, TryStreamExt as _};
use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio_util::io::{ReaderStream, StreamReader};

use crate::subprocess::{SpawnStreamingHandle, SpawnStreamingOptions, spawn_streaming};

use super::auth::GitAuthOk;

/// Cap on the CGI-head separator search. Matches `CGI_HEAD_MAX_BYTES`
/// in `git_cgi.ts`.
const CGI_HEAD_MAX_BYTES: usize = 64 * 1024;

pub struct ProxyOptions<'a> {
    pub request_method: &'a str,
    pub path_info: &'a str,
    pub query_string: &'a str,
    /// The raw request body, streamed into `git http-backend` stdin
    /// (never buffered). `Body::empty()` for the GET advertise path.
    pub body: Body,
}

/// Spawn `git http-backend`, stream the request body in, drain the CGI
/// head, and stream the remaining bytes back as the HTTP response.
///
/// Port of `proxy_to_git_http_backend` (`git_cgi.ts`). The body is piped into
/// `git http-backend`'s stdin in a background task (mirroring the TS
/// `body.pipeTo(handle.stdin)`) so a large push pack never buffers in memory —
/// the git smart-HTTP routes are off the generic 1 MiB body cap and bounded
/// only by the on-disk repo (git's own pack limits apply).
pub async fn proxy_to_git_http_backend(
    auth: &GitAuthOk,
    headers: &HeaderMap,
    options: ProxyOptions<'_>,
    remote_addr: Option<&str>,
) -> Response {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let content_encoding = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    // `repo_path` ends in `<id>.git`; `GIT_PROJECT_ROOT` is the parent
    // (matches the `build_cgi_env` strip of the trailing `.git` in
    // `git_cgi.ts`).
    let project_root = auth
        .repo_path
        .parent()
        .map_or_else(|| PathBuf::from("/"), Path::to_path_buf);
    let env = build_cgi_env(&CgiEnvOptions {
        repo_path: &project_root,
        path_info: options.path_info,
        request_method: options.request_method,
        query_string: options.query_string,
        content_type: content_type.as_deref(),
        content_encoding: content_encoding.as_deref(),
        remote_user: Some(&auth.username),
        // Threaded from the git handler's `ClientIp`. The TS twin's
        // `get_client_ip(c)` never yields nothing, so it always sets
        // `REMOTE_ADDR`; here the key is omitted when the extension is absent,
        // which only a router mounting no `client_ip_middleware` can produce.
        remote_addr,
        push_account_id: Some(&auth.account_id.to_string()),
        push_username: Some(&auth.username),
    });

    // Destructure into owned stdio handles so each stage moves the field it
    // owns: `stdin` into the body pipe, `stdout` into the head drain then the
    // response body, `stderr` into the log drain, `child` into the reaper.
    let SpawnStreamingHandle {
        stdin,
        mut stdout,
        stderr,
        mut child,
    } = match spawn_http_backend(env) {
        Ok(handle) => handle,
        Err(response) => return response,
    };

    pipe_request_body(stdin, options.body);

    let head_bytes = match read_cgi_head(&mut stdout, &mut child).await {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };

    // `read_cgi_head` only returns `Ok` once a separator is present, so this
    // parse always succeeds; the `else` is a defensive 502 mirroring the drain
    // loop's missing-separator branch.
    let Some((head, body_offset)) = parse_cgi_head(&head_bytes) else {
        let _ = child.kill().await;
        tracing::warn!("forge: CGI head missing separator before stdout EOF");
        return (StatusCode::BAD_GATEWAY, "Forge subprocess error\n").into_response();
    };

    drain_stderr(stderr);
    reap_child(child);

    build_proxy_response(head, &head_bytes[body_offset..], stdout)
}

// ─── streaming stages ────────────────────────────────────────────────────

/// Spawn `git http-backend` with the CGI `env`, mapping a spawn failure to the
/// 503 response. Parent env is NOT inherited (see [`crate::subprocess`]).
#[expect(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
fn spawn_http_backend(env: HashMap<String, String>) -> Result<SpawnStreamingHandle, Response> {
    let spawn_opts = SpawnStreamingOptions { env, cwd: None };
    spawn_streaming("git", ["http-backend"], &spawn_opts).map_err(|e| {
        tracing::error!(
            error = %fuz_sys::cli::format_error_chain(&e),
            "forge: git http-backend spawn failed"
        );
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "Forge subprocess unavailable\n",
        )
            .into_response()
    })
}

/// Stream the request `body` into the subprocess `stdin` in a background task,
/// then close stdin so the subprocess sees EOF. The body is an `AsyncRead` over
/// the HTTP stream (never fully buffered), so a multi-GiB push pack copies
/// chunk-by-chunk. Mirrors the TS `body.pipeTo(handle.stdin)` fire-and-forget
/// pipe — a pipe failure is logged here; the subprocess's own EOF / error
/// surfaces through the CGI head parse + stderr drain.
fn pipe_request_body(mut stdin: ChildStdin, body: Body) {
    tokio::spawn(async move {
        let mut reader = StreamReader::new(body.into_data_stream().map_err(std::io::Error::other));
        if let Err(e) = tokio::io::copy(&mut reader, &mut stdin).await {
            tracing::warn!(
                error = %fuz_sys::cli::format_error_chain(&e),
                "forge: stdin pipe failed"
            );
        }
        if let Err(e) = stdin.shutdown().await {
            tracing::warn!(
                error = %fuz_sys::cli::format_error_chain(&e),
                "forge: stdin shutdown failed"
            );
        }
    });
}

/// Drain `stdout` into a head buffer until the CGI separator appears, returning
/// the accumulated bytes (through the separator). On a cap overflow, a read
/// error, or EOF before the separator, kills the child and returns the matching
/// 502 response.
#[expect(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the crate-wide REST handler idiom"
)]
async fn read_cgi_head(stdout: &mut ChildStdout, child: &mut Child) -> Result<Vec<u8>, Response> {
    let mut head_bytes: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    loop {
        match stdout.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                head_bytes.extend_from_slice(&chunk[..n]);
                if find_separator(&head_bytes).is_some() {
                    return Ok(head_bytes);
                }
                if head_bytes.len() > CGI_HEAD_MAX_BYTES {
                    let _ = child.kill().await;
                    tracing::warn!(
                        bytes = head_bytes.len(),
                        "forge: CGI head exceeded cap before separator"
                    );
                    return Err(
                        (StatusCode::BAD_GATEWAY, "Forge subprocess error\n").into_response()
                    );
                }
            }
            Err(e) => {
                let _ = child.kill().await;
                tracing::warn!(
                    error = %fuz_sys::cli::format_error_chain(&e),
                    "forge: stdout read failed"
                );
                return Err(
                    (StatusCode::BAD_GATEWAY, "Forge subprocess read error\n").into_response()
                );
            }
        }
    }
    // stdout closed before the CGI separator appeared.
    let _ = child.kill().await;
    tracing::warn!("forge: CGI head missing separator before stdout EOF");
    Err((StatusCode::BAD_GATEWAY, "Forge subprocess error\n").into_response())
}

/// Spawn a background drain of `stderr` so subprocess complaints surface on the
/// server log; the response body comes from stdout.
fn drain_stderr(mut stderr: ChildStderr) {
    tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        if !buf.is_empty() {
            tracing::warn!(
                stderr = %String::from_utf8_lossy(&buf).trim(),
                "forge: git http-backend stderr",
            );
        }
    });
}

/// Reap the subprocess once it exits. `stdout` keeps the read-end fd alive, so
/// dropping `child` here doesn't close the pipe; `wait()` only completes when
/// git finishes writing (or gets EPIPE because the client disconnected and the
/// body stream below was dropped). Mirrors the TS twin, which lets the runtime
/// reap the spawned process.
fn reap_child(mut child: Child) {
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
}

/// Assemble the response: stream the bytes already read past the CGI separator,
/// then the rest of the stdout pipe — never buffered. A `git-upload-pack`
/// (clone) response is the whole repo's packfile, so buffering it would scale
/// server memory with repo size; streaming matches the TS twin's
/// `new Response(body_stream)`.
fn build_proxy_response(head: CgiHead, prefix_bytes: &[u8], stdout: ChildStdout) -> Response {
    let prefix = axum::body::Bytes::copy_from_slice(prefix_bytes);
    let body_stream = futures_util::stream::once(async move { Ok::<_, std::io::Error>(prefix) })
        .chain(ReaderStream::new(stdout));
    let body = Body::from_stream(body_stream);

    let status = StatusCode::from_u16(head.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = (status, body).into_response();
    apply_cgi_headers(&mut response, head.headers);
    response
}

/// Reflect the CGI head's headers onto `response` — the head carries the
/// authoritative set (notably the git `application/x-git-*-advertisement`
/// content type).
///
/// The FIRST occurrence of each name is `insert`ed, so it replaces anything
/// axum may already have put on the response rather than joining it (a
/// duplicated `Content-Type` breaks smart-HTTP for nginx/git); occurrences
/// 2..n are `append`ed, preserving a genuinely multi-valued header as separate
/// lines. The TS twin's `Headers.append` instead folds repeats of one name
/// into a single comma-joined value — a difference with no observable
/// consequence here, since `git http-backend` emits no duplicate header name
/// and neither runtime supplies a default the head could collide with
/// (`Body::from_stream(...).into_response()` sets no header, and
/// `new Response(stream, {headers})` starts empty).
///
/// A name or value the HTTP layer cannot represent (a lone `\r` folded into a
/// value, say) is dropped, matching the TS twin's `headers.append` skip.
fn apply_cgi_headers(response: &mut Response, headers: Vec<(String, String)>) {
    let mut seen: std::collections::HashSet<header::HeaderName> = std::collections::HashSet::new();
    for (name, value) in headers {
        if let Ok(hn) = header::HeaderName::from_bytes(name.as_bytes())
            && let Ok(hv) = header::HeaderValue::from_str(&value)
        {
            if seen.insert(hn.clone()) {
                response.headers_mut().insert(hn, hv);
            } else {
                response.headers_mut().append(hn, hv);
            }
        }
    }
}

// ─── pure helpers (port directly from the TS source) ─────────────────────

/// Inputs for [`build_cgi_env`] — the repo root, the request shape, the two
/// optional body headers, and the four auth-derived attribution values.
///
/// A struct rather than positional params: six of the ten are adjacent
/// `Option<&str>`, and three of those carry only two distinct values
/// (`remote_user` and `push_username` are both the authenticated account's username, with
/// `push_account_id` between them), so any transposition compiles clean and
/// silently rewrites the environment `git http-backend` runs under.
/// `push_account_id` / `push_username` become the push's attribution in the
/// repo cell's `last_pushed_by`, which the `cgi_env_key_set_is_pinned` test
/// cannot catch — it asserts which keys are present, not which value landed on
/// which key. The TS twin has no equivalent hazard: its `build_cgi_env` takes
/// `(deps, auth, c, options)` and reads the attribution off `auth` by name.
struct CgiEnvOptions<'a> {
    repo_path: &'a Path,
    path_info: &'a str,
    request_method: &'a str,
    query_string: &'a str,
    content_type: Option<&'a str>,
    content_encoding: Option<&'a str>,
    /// `REMOTE_USER` — the username of the account behind the token.
    remote_user: Option<&'a str>,
    /// `REMOTE_ADDR` — the XFF-resolved client IP.
    remote_addr: Option<&'a str>,
    /// `FUZ_FORGE_PUSH_ACCOUNT_ID` — read by the `post-receive` hook.
    push_account_id: Option<&'a str>,
    /// `FUZ_FORGE_PUSH_USERNAME` — read by the `post-receive` hook.
    push_username: Option<&'a str>,
}

/// Build the CGI environment map for `git http-backend`.
///
/// Port of `build_cgi_env` (`git_cgi.ts`). Parent env is
/// intentionally NOT inherited; the returned map is the complete env.
#[must_use]
fn build_cgi_env(options: &CgiEnvOptions<'_>) -> HashMap<String, String> {
    let &CgiEnvOptions {
        repo_path,
        path_info,
        request_method,
        query_string,
        content_type,
        content_encoding,
        remote_user,
        remote_addr,
        push_account_id,
        push_username,
    } = options;
    let mut env = HashMap::new();
    env.insert("GIT_PROJECT_ROOT".into(), repo_path.display().to_string());
    env.insert("PATH_INFO".into(), path_info.into());
    env.insert("REQUEST_METHOD".into(), request_method.into());
    env.insert("QUERY_STRING".into(), query_string.into());
    if let Some(v) = content_type {
        env.insert("CONTENT_TYPE".into(), v.into());
    }
    if let Some(v) = content_encoding {
        env.insert("HTTP_CONTENT_ENCODING".into(), v.into());
    }
    if let Some(v) = remote_user {
        env.insert("REMOTE_USER".into(), v.into());
    }
    if let Some(v) = remote_addr {
        env.insert("REMOTE_ADDR".into(), v.into());
    }
    if let Some(v) = push_account_id {
        env.insert("FUZ_FORGE_PUSH_ACCOUNT_ID".into(), v.into());
    }
    if let Some(v) = push_username {
        env.insert("FUZ_FORGE_PUSH_USERNAME".into(), v.into());
    }
    env.insert("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into());
    env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    // `/etc/gitconfig` is outside the forge's control, and `git http-backend`
    // execs `git-receive-pack` under it: a system-wide `core.hooksPath` would
    // point the push path at hooks the forge never installed, bypassing the
    // per-repo `pre-receive` force-push guard and the `post-receive` callback.
    // `HOME` is already absent (so `~/.gitconfig` is out of reach); this closes
    // the remaining tier, matching the read + storage paths' `git_env`.
    env.insert("GIT_CONFIG_NOSYSTEM".into(), "1".into());
    env
}

/// Parsed CGI head returned by [`parse_cgi_head`].
#[derive(Debug, Clone, Default)]
struct CgiHead {
    /// HTTP status — defaults to 200 when no `Status:` header present.
    status: u16,
    /// Headers in insertion order.
    headers: Vec<(String, String)>,
}

/// Parse the CGI head from a byte slice.
///
/// Port of `parse_cgi_head` in `git_cgi.ts`, plus the separator scan the TS
/// side does inside `read_cgi_head`. Returns `Some((head, body_offset))` once
/// the `\r\n\r\n` (or `\n\n`) separator is found, `None` if the input is
/// shorter than the separator.
///
/// Lines split on `\n` with one optional trailing `\r` — the twin of the TS
/// `text.split(/\r?\n/)`, so a **lone** `\r` is not a line break on either
/// side: `"a: 1\rb: 2"` is one header `a` whose value is `1\rb: 2`.
#[must_use]
fn parse_cgi_head(bytes: &[u8]) -> Option<(CgiHead, usize)> {
    let (sep_at, sep_len) = find_separator(bytes)?;
    let head_bytes = &bytes[..sep_at];
    let head_str = std::str::from_utf8(head_bytes).ok()?;
    let mut status: u16 = 200;
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in head_str
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|s| !s.is_empty())
    {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if key.eq_ignore_ascii_case("Status") {
            if let Some(code) = parse_cgi_status(value) {
                status = code;
            }
        } else {
            headers.push((key.to_owned(), value.to_owned()));
        }
    }
    Some((CgiHead { status, headers }, sep_at + sep_len))
}

/// Parse a CGI `Status:` value's code: the leading space/tab-delimited token of
/// `"<code> <reason>"`, which must be three ASCII digits in `200..=599`
/// excluding the null-body statuses (204/205/304).
///
/// `None` — leaving the CGI default 200 in place — for anything else
/// (`404abc`, `600`, `100`, `099`, `204`, an empty value). The set is the one
/// both runtimes can emit: the TS twin's `new Response` throws outside 200-599
/// and on a null-body status with a stream body, so a wider rule here would
/// put a status on the wire that the other backend answers as a 500. Splitting on `[' ', '\t']` rather than `split_whitespace`
/// keeps the token identical to the TS `split(/[ \t]/)` — JS `\s` matches
/// U+FEFF and Rust whitespace does not. `git http-backend` only ever emits
/// 2xx-5xx, so the shared rule refuses nothing real.
#[must_use]
fn parse_cgi_status(value: &str) -> Option<u16> {
    let code = value.split([' ', '\t']).next()?;
    if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let code = code.parse::<u16>().ok()?;
    if !(200..=599).contains(&code) || matches!(code, 204 | 205 | 304) {
        return None;
    }
    Some(code)
}

/// Find the CGI head/body separator (`\r\n\r\n` or `\n\n`), scanning the whole
/// slice. The head-size cap lives in the streaming drain loop (not here), so
/// this stays a pure parser whose tail-inclusive scan matches the TS twin
/// (`find_double_newline` in `git_cgi.ts`) — a separator in the final bytes is
/// found rather than missed.
fn find_separator(bytes: &[u8]) -> Option<(usize, usize)> {
    for i in 0..bytes.len() {
        if bytes[i..].starts_with(b"\r\n\r\n") {
            return Some((i, 4));
        }
        if bytes[i..].starts_with(b"\n\n") {
            return Some((i, 2));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    //! CGI-head parse fixtures, twinned with
    //! `src/test/server/routes/repo_git.cgi_head.db.test.ts`.
    //!
    //! Three head-parse divergences these fixtures pin, each of which put a
    //! different response on the wire per backend:
    //!
    //! - **Lone `\r`.** This side split on `['\n', '\r']`, promoting an
    //!   attacker-supplied `X-Injected` in a `git http-backend` head into a
    //!   real response header; the TS `split(/\r?\n/)` never did.
    //! - **`Status:` code shape.** A bare `parse::<u16>()` here read `Status:
    //!   99` as a 99 while TS `parseInt` read `404abc` as a 404; a `600` went
    //!   out as an HTTP 600 here but threw a `RangeError` there (→ 500, plus an
    //!   unreaped `git http-backend` child), and an `099` was a 500 here
    //!   (`StatusCode::from_u16(99)` errors) against a 200 there. `200..=599`
    //!   minus the null-body statuses (204/205/304, which `new Response`
    //!   refuses with a stream body) is the set both runtimes can emit.
    //! - **Status token split.** `split_whitespace` here vs TS `\s` disagree on
    //!   U+FEFF, so `Status: 404\u{FEFF}Not Found` was a 404 on TS and a 200
    //!   here; both now split on space/tab alone.

    use super::*;

    /// A closed `ChildStdout` for [`build_proxy_response`], whose signature
    /// owns a real pipe handle. The body under test is entirely the
    /// already-read prefix, so the child only has to exist and exit.
    async fn empty_child_stdout() -> ChildStdout {
        let mut child = tokio::process::Command::new("/bin/sh")
            .args(["-c", ""])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn /bin/sh for a pipe handle");
        let stdout = child.stdout.take().expect("piped stdout");
        let _ = child.wait().await;
        stdout
    }

    #[test]
    fn parses_simple_cgi_head() {
        let input = b"Status: 200 OK\r\nContent-Type: text/plain\r\n\r\nbody";
        let (head, offset) = parse_cgi_head(input).unwrap();
        assert_eq!(head.status, 200);
        assert_eq!(head.headers[0].0, "Content-Type");
        assert_eq!(head.headers[0].1, "text/plain");
        assert_eq!(&input[offset..], b"body");
    }

    #[test]
    fn parses_lf_only_separator() {
        let input = b"Content-Type: text/plain\n\nbody";
        let (head, offset) = parse_cgi_head(input).unwrap();
        assert_eq!(head.status, 200);
        assert_eq!(head.headers[0].0, "Content-Type");
        assert_eq!(&input[offset..], b"body");
    }

    #[test]
    fn parses_custom_status_code() {
        let input = b"Status: 404 Not Found\r\n\r\n";
        let (head, _) = parse_cgi_head(input).unwrap();
        assert_eq!(head.status, 404);
    }

    #[test]
    fn finds_separator_in_final_bytes() {
        // A `\n\n` in the buffer's last bytes must be found (the old
        // `..len-3` bound missed it), matching the TS tail-inclusive scan.
        let input = b"X: y\n\nZ";
        let (head, offset) = parse_cgi_head(input).unwrap();
        assert_eq!(head.headers[0], ("X".to_owned(), "y".to_owned()));
        assert_eq!(&input[offset..], b"Z");
        // Header-only head terminated by `\n\n` at the very end → empty body.
        let head_only = b"Content-Type: text/plain\n\n";
        let (_, offset) = parse_cgi_head(head_only).unwrap();
        assert_eq!(&head_only[offset..], b"");
    }

    #[tokio::test]
    async fn lone_cr_is_not_a_line_break() {
        // Twin fixture of the TS `repo_git.cgi_head.db.test.ts` case
        // "a lone \r inside a CGI head line is not a line break". The `\r`
        // deliberately sits on a NON-`Status` header, the branch that actually
        // diverged: it folds into the `Content-Type` VALUE, and a header value
        // carrying a `\r` is then unrepresentable — dropped by
        // `apply_cgi_headers` here and skipped by the TS `headers.append`
        // try/catch. Same observable outcome on both: no `X-Injected`, and no
        // `Content-Type` either.
        let input = b"Content-Type: text/plain\rX-Injected: yes\r\n\r\nbody";
        let (head, offset) = parse_cgi_head(input).unwrap();
        assert_eq!(head.status, 200);
        assert_eq!(
            head.headers,
            vec![(
                "Content-Type".to_owned(),
                "text/plain\rX-Injected: yes".to_owned()
            )],
            "a lone \\r must not split a header line",
        );
        assert_eq!(&input[offset..], b"body");

        // …and the unrepresentable value never reaches the wire. Asserted on
        // the response `build_proxy_response` actually assembles, not on
        // `apply_cgi_headers` in isolation, so the fixture pins the bytes the
        // client sees.
        let response = build_proxy_response(head, &input[offset..], empty_child_stdout().await);
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get("x-injected").is_none());
        assert!(response.headers().get("content-type").is_none());
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(&body[..], b"body");
    }

    #[test]
    fn status_value_must_be_a_supported_three_digit_code() {
        assert_eq!(parse_cgi_status("200 OK"), Some(200));
        assert_eq!(parse_cgi_status("404"), Some(404));
        assert_eq!(parse_cgi_status("404 Not Found"), Some(404));
        // A tab is a separator on both sides.
        assert_eq!(parse_cgi_status("404\tNot Found"), Some(404));
        // Outside 200-599, or a null-body status — what both runtimes can put
        // on the wire.
        assert_eq!(parse_cgi_status("600"), None);
        assert_eq!(parse_cgi_status("100"), None);
        assert_eq!(parse_cgi_status("099"), None);
        assert_eq!(parse_cgi_status("204"), None);
        assert_eq!(parse_cgi_status("304 Not Modified"), None);
        // Not three digits at all.
        assert_eq!(parse_cgi_status("404abc"), None);
        assert_eq!(parse_cgi_status("99"), None);
        assert_eq!(parse_cgi_status("1000"), None);
        assert_eq!(parse_cgi_status(""), None);
        assert_eq!(parse_cgi_status("OK"), None);
        // U+FEFF is JS-regex `\s` but not Rust whitespace — splitting on
        // space/tab alone is what makes both sides see `404\u{FEFF}Not`.
        assert_eq!(parse_cgi_status("404\u{FEFF}Not Found"), None);
    }

    #[test]
    fn head_with_an_unusable_status_defaults_to_200() {
        for value in [
            "404abc",
            "600",
            "100",
            "099",
            "204",
            "",
            "404\u{FEFF}Not Found",
        ] {
            let input = format!("Status: {value}\r\nContent-Type: text/plain\r\n\r\nbody");
            let (head, _) = parse_cgi_head(input.as_bytes()).unwrap();
            assert_eq!(head.status, 200, "Status: {value:?}");
        }
        // …and a usable one still lands.
        let input = b"Status: 404 Not Found\r\nContent-Type: text/plain\r\n\r\nbody";
        let (head, _) = parse_cgi_head(input).unwrap();
        assert_eq!(head.status, 404);
    }

    #[test]
    fn returns_none_without_separator() {
        let input = b"Content-Type: text/plain\r\n";
        assert!(parse_cgi_head(input).is_none());
    }

    /// The CGI env is the **complete** subprocess env (the caller clears the
    /// parent), so its key set is a wire-adjacent contract. Pinned literally
    /// here and — for the same authenticated `info/refs` shape — in the TS twin
    /// (`src/test/server/routes/repo_git.cgi_head.db.test.ts`); the two lists
    /// must stay identical.
    #[test]
    fn cgi_env_key_set_is_pinned() {
        let authenticated = build_cgi_env(&CgiEnvOptions {
            repo_path: Path::new("/repos/foo"),
            path_info: "/info/refs",
            request_method: "GET",
            query_string: "service=git-upload-pack",
            content_type: None,
            content_encoding: None,
            remote_user: Some("keeper"),
            remote_addr: Some("127.0.0.1"),
            push_account_id: Some("00000000-0000-4000-8000-000000000000"),
            push_username: Some("keeper"),
        });
        let mut keys: Vec<&str> = authenticated.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "FUZ_FORGE_PUSH_ACCOUNT_ID",
                "FUZ_FORGE_PUSH_USERNAME",
                "GIT_CONFIG_NOSYSTEM",
                "GIT_PROJECT_ROOT",
                "GIT_TERMINAL_PROMPT",
                "PATH",
                "PATH_INFO",
                "QUERY_STRING",
                "REMOTE_ADDR",
                "REMOTE_USER",
                "REQUEST_METHOD",
            ]
        );
        assert_eq!(authenticated["PATH_INFO"], "/info/refs");
        assert_eq!(authenticated["GIT_TERMINAL_PROMPT"], "0");
        // `/etc/gitconfig` must not reach `git http-backend` — a system
        // `core.hooksPath` would bypass the forge's own hooks.
        assert_eq!(authenticated["GIT_CONFIG_NOSYSTEM"], "1");
        // `GIT_HTTP_EXPORT_ALL` is deliberately never set — per-repo
        // `http.receivepack` / `http.uploadpack` is the export switch.
        assert!(!authenticated.contains_key("GIT_HTTP_EXPORT_ALL"));

        // With no auth / body headers the optional keys are omitted, not
        // emitted empty. Only `CONTENT_TYPE` / `HTTP_CONTENT_ENCODING` mirror a
        // TS guard; the twin builds the other four off `auth` + `get_client_ip`
        // and always emits them, so this shape is reachable only from a router
        // that mounts no auth or no `client_ip_middleware`.
        let bare = build_cgi_env(&CgiEnvOptions {
            repo_path: Path::new("/repos/foo"),
            path_info: "/info/refs",
            request_method: "GET",
            query_string: "",
            content_type: None,
            content_encoding: None,
            remote_user: None,
            remote_addr: None,
            push_account_id: None,
            push_username: None,
        });
        let mut bare_keys: Vec<&str> = bare.keys().map(String::as_str).collect();
        bare_keys.sort_unstable();
        assert_eq!(
            bare_keys,
            [
                "GIT_CONFIG_NOSYSTEM",
                "GIT_PROJECT_ROOT",
                "GIT_TERMINAL_PROMPT",
                "PATH",
                "PATH_INFO",
                "QUERY_STRING",
                "REQUEST_METHOD",
            ]
        );
    }
}
