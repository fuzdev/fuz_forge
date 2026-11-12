//! Forge HTTP client — the forge's JSON-RPC endpoint (`/api/rpc`), its
//! content-addressed file store (`/api/fuz_forge/files`), and the account
//! status read. One `reqwest::Client` over a base URL + bearer token.
//!
//! The base URL is a `fuz_storage::base_url::BaseUrl` — validated by the
//! policy `forge://` storage applies (`https`, or plaintext `http` only to a
//! loopback host) — and the client is `fuz_storage::forge_client_builder`'s,
//! the one `ForgeStorage` uses, with redirects refused: a `3xx` fails the
//! request ([`ClientError::Redirected`]), so the bearer token and a write's
//! body only ever reach the configured origin, and a write can't turn into a
//! `GET` that succeeds with nothing written.
//!
//! Every response body is bounded while it is read: a download by
//! `MAX_TRANSFER_SIZE` (streamed to disk with an incremental blake3 verify, so
//! a multi-GB artifact can't OOM the client), a file listing by
//! `MAX_FORGE_LIST_SIZE`, an RPC answer by [`MAX_RPC_RESPONSE_SIZE`], the
//! small metadata answers by `MAX_METADATA_SIZE`, and an error body by
//! `fuz_storage::read_error_text`. What the server says in an error — its
//! body, an RPC error's message — is escaped where [`ClientError`] renders it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use fuz_crypto::{HashAlgo, Hasher};
use fuz_http::JsonrpcErrorCode;
use fuz_storage::base_url::BaseUrl;
use fuz_storage::{MAX_FORGE_LIST_SIZE, Redirects, forge_client_builder, read_error_text};
use fuz_sys::limits::{MAX_METADATA_SIZE, MAX_TRANSFER_SIZE};
use fuz_sys::text::{escape_untrusted, truncate};
use reqwest::StatusCode;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use url::Url;

use crate::CliError;
use crate::format::{SHORT_HASH_LEN, short};
use crate::output::{
    AccountStatus, FileListOutput, FileMetaOutput, FileUploadOutput, RepoEnvelope,
};
use crate::repo_id::{RepoLookup, resolve_repo_id_or_slug};

/// Monotonic JSON-RPC request id (the server doesn't require global
/// uniqueness; this just keeps each request's id distinct within a run).
static RPC_ID: AtomicU64 = AtomicU64::new(0);

/// Most bytes of a JSON-RPC response read before it is parsed (64 MiB).
///
/// The largest answer the forge composes is `repo show`: a diff the server
/// caps at 5 MB of git output plus commit metadata capped at 1 MB (the
/// `fuz_forge_server` git-read caps), each grown at most sixfold by JSON
/// escaping (a control byte becomes `\u00XX`) — 36 MB, which 64 MiB holds
/// with room for the envelope. A repo listing is far smaller.
pub const MAX_RPC_RESPONSE_SIZE: u64 = 64 * 1024 * 1024;

/// Most bytes of server text — an error body, an RPC error's message — an
/// error shows, before escaping. Context, not a transcript.
const MAX_SHOWN_SERVER_TEXT_LEN: usize = 512;

/// Server text for an error message: cut to [`MAX_SHOWN_SERVER_TEXT_LEN`],
/// then escaped so it can neither emit a control sequence nor add a line.
fn shown(text: &str) -> String {
    escape_untrusted(&truncate(text, MAX_SHOWN_SERVER_TEXT_LEN))
}

/// Errors from forge HTTP operations.
#[derive(Debug, Error)]
pub enum ClientError {
    /// reqwest transport/build failure.
    #[error("{0}")]
    Http(#[from] reqwest::Error),

    /// Could not construct a request URL from the configured server.
    #[error("invalid server URL: {0}")]
    Url(String),

    /// JSON-RPC error envelope returned by the server. The message is the
    /// server's, shown escaped.
    #[error("RPC {method}: {}", shown(.message))]
    Rpc {
        method: String,
        code: i64,
        message: String,
    },

    /// JSON-RPC succeeded over HTTP but carried no `result`.
    #[error("RPC {0}: empty result")]
    RpcEmpty(String),

    /// The forge answered with a redirect, which the client never follows.
    /// The body (a login page, say) isn't the forge's and isn't echoed.
    #[error(
        "{context}: the server answered with a redirect (HTTP {status}); fuzf follows no redirects"
    )]
    Redirected { context: String, status: StatusCode },

    /// Non-2xx HTTP response with a body excerpt for context — the start of
    /// the body as `read_error_text` bounds it, shown escaped.
    #[error("{context}: {status}{}", body_suffix(.body))]
    Status {
        context: String,
        status: StatusCode,
        body: String,
    },

    /// A file-store filename was not found on the server.
    #[error("file not found: {0}")]
    FileNotFound(String),

    /// The token may not read this file (403) — e.g. an upload-only scoped token.
    #[error("forbidden: the token cannot read {0}")]
    Forbidden(String),

    /// A local upload source path is not a readable file.
    #[error("not a file: {0}")]
    NotAFile(PathBuf),

    /// A downloaded file's blake3 didn't match the server's metadata. The
    /// expected digest is the server's, shown escaped.
    #[error(
        "hash mismatch for {filename}: expected {}…, got {actual}…",
        escape_untrusted(.expected)
    )]
    HashMismatch {
        filename: String,
        expected: String,
        actual: String,
    },

    /// Local filesystem failure (read/write/rename during file transfer).
    #[error("{0}")]
    Io(#[from] std::io::Error),

    /// A response body is larger than its bound; refused while it is read.
    #[error("{context}: the response exceeds {max} bytes")]
    TooLarge { context: String, max: u64 },

    /// Failed to decode (or encode) JSON. A decode error can quote the
    /// server's text, so it is shown escaped — and kept out of `source()`,
    /// which the error chain would print raw.
    #[error("failed to decode response: {}", shown(&.0.to_string()))]
    Decode(serde_json::Error),

    /// The account status response carried no username.
    #[error("account response missing username")]
    MissingUsername,
}

/// Render a body excerpt as a newline-prefixed suffix, or empty when blank.
/// The excerpt is escaped, so it is one line whatever the server sent.
fn body_suffix(body: &str) -> String {
    if body.is_empty() {
        String::new()
    } else {
        format!("\n{}", shown(body))
    }
}

impl ClientError {
    /// Process exit code: caller-side failures are `2` — a bad local path or
    /// server URL, a request the forge refused as malformed (`400`, RPC
    /// `-32602`), or a credential it refused (`401` / `403`, RPC `-32001` /
    /// `-32002`). Every other client failure is runtime (`1`).
    pub const fn exit_code(&self) -> u8 {
        const INVALID_PARAMS: i64 = JsonrpcErrorCode::InvalidParams.as_i32() as i64;
        const UNAUTHENTICATED: i64 = JsonrpcErrorCode::Unauthenticated.as_i32() as i64;
        const FORBIDDEN: i64 = JsonrpcErrorCode::Forbidden.as_i32() as i64;
        let caller_side = match self {
            Self::NotAFile(_) | Self::Forbidden(_) | Self::Url(_) | Self::Redirected { .. } => true,
            Self::Status { status, .. } => matches!(status.as_u16(), 400 | 401 | 403),
            Self::Rpc { code, .. } => {
                matches!(*code, INVALID_PARAMS | UNAUTHENTICATED | FORBIDDEN)
            }
            _ => false,
        };
        if caller_side { 2 } else { 1 }
    }

    /// User-facing hint, if any.
    pub const fn hint(&self) -> Option<&'static str> {
        match self {
            Self::Rpc { code, .. } if *code == JsonrpcErrorCode::NotFound.as_i32() as i64 => {
                Some("the target was not found on the forge")
            }
            Self::Redirected { .. } => Some(
                "set the server URL (`fuzf init --server` or FUZ_FORGE_BASE_URL) to the \
                 https:// origin the forge serves from",
            ),
            Self::Forbidden(_) => {
                Some("the token lacks files.read scope for that file; use a token with read access")
            }
            // A 401 is the forge's one generic refusal for every credential
            // problem — including a token past its `expires_at` (every mint
            // names a lifetime, and a `ttl` one expires). Name the expiry
            // possibility so recovery doesn't require guessing.
            Self::Status { status, .. } if status.as_u16() == 401 => Some(
                "the token was refused — it may be invalid, revoked, or expired; \
                 mint a new one in the web UI at /admin/account and update \
                 FUZ_FORGE_TOKEN or the api_token file",
            ),
            _ => None,
        }
    }
}

/// Outcome of a file-metadata probe (`ForgeClient::fetch_file_meta`).
#[derive(Debug)]
pub enum FileMetaLookup {
    /// The server returned metadata.
    Found(FileMetaOutput),
    /// No such file (404).
    Missing,
    /// The token may not read this file's metadata (403) — e.g. an upload-only
    /// scoped token. The bytes can't be read either, but a write or delete may
    /// still be permitted.
    Forbidden,
}

/// A connected forge client. `Debug` redacts the bearer token.
pub struct ForgeClient {
    client: reqwest::Client,
    /// Base URL, trailing slash trimmed (e.g. `https://forge.example.com`).
    base_url: String,
    token: String,
}

impl std::fmt::Debug for ForgeClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForgeClient")
            .field("base_url", &self.base_url)
            .field("token", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl ForgeClient {
    /// Build a client for a validated `base` with a bearer `token`, from
    /// `fuz_storage::forge_client_builder` — the policy and timeouts
    /// `ForgeStorage` uses — with redirects refused: no redirect followed, no
    /// `Referer`, `https_only` for an `https` base, and the environment's
    /// proxies bypassed for a loopback `http` base.
    pub fn new(base: BaseUrl, token: String) -> Result<Self, ClientError> {
        let client = forge_client_builder(&base, Redirects::Refuse).build()?;
        Ok(Self {
            client,
            base_url: base.url,
            token,
        })
    }

    /// Resolve the connection from config/env (server URL + bearer token) and
    /// build a client — the opener every client command shares.
    pub fn connect() -> Result<Self, CliError> {
        let (base, token) = crate::config::load_connection()?;
        Ok(Self::new(base, token)?)
    }

    /// The resolved base URL (trailing slash trimmed) — for building non-API
    /// URLs like the admin page or the bare clone URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The bearer token — reused as the git password for `repo clone --with-auth`.
    pub fn token(&self) -> &str {
        &self.token
    }

    /// `<base>/api/fuz_forge/files/<filename>` with each filename segment
    /// percent-encoded (interior `/` preserved as separators), optionally
    /// `?meta`.
    fn files_url(&self, filename: &str, meta: bool) -> Result<Url, ClientError> {
        let mut url = Url::parse(&format!("{}/api/fuz_forge/files", self.base_url))
            .map_err(|e| ClientError::Url(e.to_string()))?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|()| ClientError::Url("base URL cannot be a base".to_string()))?;
            for segment in filename.split('/') {
                segments.push(segment);
            }
        }
        if meta {
            url.set_query(Some("meta"));
        }
        Ok(url)
    }

    /// Call a JSON-RPC method. Auth via `Bearer <token>`. Errors on non-2xx
    /// HTTP (with body excerpt) and on JSON-RPC `error` envelopes.
    pub async fn rpc<T: DeserializeOwned>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T, ClientError> {
        #[derive(Deserialize)]
        struct RpcEnvelope<T> {
            result: Option<T>,
            error: Option<RpcErr>,
        }
        #[derive(Deserialize)]
        struct RpcErr {
            code: i64,
            message: String,
        }

        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": RPC_ID.fetch_add(1, Ordering::Relaxed) + 1,
            "method": method,
            "params": params,
        });
        let response = self
            .client
            .post(format!("{}/api/rpc", self.base_url))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await?;
        let context = format!("RPC {method} failed");
        let response = self.ensure_ok(response, context.as_str()).await?;
        let envelope: RpcEnvelope<T> = read_json(response, MAX_RPC_RESPONSE_SIZE, &context).await?;
        if let Some(err) = envelope.error {
            return Err(ClientError::Rpc {
                method: method.to_string(),
                code: err.code,
                message: err.message,
            });
        }
        envelope
            .result
            .ok_or_else(|| ClientError::RpcEmpty(method.to_string()))
    }

    /// Probe file metadata without downloading. Distinguishes 404 (`Missing`)
    /// from 403 (`Forbidden` — a scoped token that can't read this file's
    /// metadata) so each caller decides: `put` proceeds to upload on either,
    /// `get`/`list` report the difference, and `delete` doesn't block on a read
    /// it doesn't need.
    pub async fn fetch_file_meta(&self, filename: &str) -> Result<FileMetaLookup, ClientError> {
        let url = self.files_url(filename, true)?;
        let response = self.client.get(url).bearer_auth(&self.token).send().await?;
        match response.status() {
            StatusCode::NOT_FOUND => Ok(FileMetaLookup::Missing),
            StatusCode::FORBIDDEN => Ok(FileMetaLookup::Forbidden),
            s if s.is_success() => Ok(FileMetaLookup::Found(
                read_json(response, MAX_METADATA_SIZE, "failed to fetch file metadata").await?,
            )),
            _ => Err(self
                .status_error("failed to fetch file metadata".to_string(), response)
                .await),
        }
    }

    /// Stream a local file to the store as the request body (bounded memory),
    /// with an explicit Content-Length so the forge's pre-checks apply.
    ///
    /// The response is [`FileUploadOutput`], **not** the `?meta` metadata shape:
    /// the upload answers with a `status` and no `uploaded_at`, so decoding it
    /// as [`FileMetaOutput`] fails after the bytes have already landed.
    pub async fn upload_file(
        &self,
        filename: &str,
        src: &Path,
    ) -> Result<FileUploadOutput, ClientError> {
        let file = tokio::fs::File::open(src).await?;
        let size = file.metadata().await?.len();
        let url = self.files_url(filename, false)?;
        let response = self
            .client
            .post(url)
            .bearer_auth(&self.token)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header(reqwest::header::CONTENT_LENGTH, size)
            .body(reqwest::Body::from(file))
            .send()
            .await?;
        let context = "failed to upload file";
        let response = self.ensure_ok(response, context).await?;
        read_json(response, MAX_METADATA_SIZE, context).await
    }

    /// Stream a file from the store to `dest`, verifying blake3 incrementally
    /// against `expected_blake3`. Downloads to a sibling `.downloading-*` temp,
    /// fails loud on mismatch (no partial file left), then atomically renames.
    ///
    /// Bounded by `MAX_TRANSFER_SIZE`, as `ForgeStorage`'s downloads are: a
    /// larger declared `Content-Length` is refused before anything is created,
    /// and a body that runs past it is refused mid-stream, the temp removed.
    pub async fn download_file(
        &self,
        filename: &str,
        dest: &Path,
        expected_blake3: &str,
    ) -> Result<(), ClientError> {
        let url = self.files_url(filename, false)?;
        let response = self.client.get(url).bearer_auth(&self.token).send().await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err(ClientError::FileNotFound(filename.to_string()));
        }
        let context = "failed to download file";
        let mut response = self.ensure_ok(response, context).await?;
        check_content_length(&response, MAX_TRANSFER_SIZE, context)?;

        let parent = dest.parent().filter(|p| !p.as_os_str().is_empty());
        if let Some(dir) = parent {
            tokio::fs::create_dir_all(dir).await?;
        }
        let tmp_path =
            dest.with_file_name(format!(".downloading-{}", fuz_sys::rand::random_hex(16)));

        let actual = stream_to_file(&mut response, &tmp_path, MAX_TRANSFER_SIZE, context).await?;
        if actual != expected_blake3 {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(ClientError::HashMismatch {
                filename: filename.to_string(),
                expected: short(expected_blake3, SHORT_HASH_LEN),
                actual: short(&actual, SHORT_HASH_LEN),
            });
        }
        // No fsync before the rename: the payload was just blake3-verified and
        // is content-addressed/regenerable (a cache entry or a re-fetchable
        // output), so durability isn't load-bearing — the CAS convention's
        // deliberate fsync waiver, not an oversight.
        tokio::fs::rename(&tmp_path, dest).await?;
        Ok(())
    }

    /// List every file in the store.
    pub async fn list_files(&self) -> Result<Vec<FileMetaOutput>, ClientError> {
        let response = self
            .client
            .get(format!("{}/api/fuz_forge/files", self.base_url))
            .bearer_auth(&self.token)
            .send()
            .await?;
        let context = "failed to list files";
        let response = self.ensure_ok(response, context).await?;
        let body: FileListOutput = read_json(response, MAX_FORGE_LIST_SIZE, context).await?;
        Ok(body.files)
    }

    /// Delete a file from the store.
    ///
    /// The server answers `fuz_forge_wire::output::FileDeleteOutput`
    /// (`{deleted: true, filename}`); nothing in it is worth rendering over the
    /// filename the caller already has, so the body is discarded and only the
    /// status is checked.
    pub async fn delete_file(&self, filename: &str) -> Result<(), ClientError> {
        let url = self.files_url(filename, false)?;
        let response = self
            .client
            .delete(url)
            .bearer_auth(&self.token)
            .send()
            .await?;
        self.ensure_ok(response, "failed to delete file").await?;
        Ok(())
    }

    /// Resolve the calling account's username (for `repo clone --with-auth`).
    pub async fn account_username(&self) -> Result<String, ClientError> {
        let response = self
            .client
            .get(format!("{}/api/account/status", self.base_url))
            .bearer_auth(&self.token)
            .send()
            .await?;
        let context = "failed to resolve account username";
        let response = self.ensure_ok(response, context).await?;
        let status: AccountStatus = read_json(response, MAX_METADATA_SIZE, context).await?;
        status
            .account
            .and_then(|a| a.username)
            .ok_or(ClientError::MissingUsername)
    }

    /// Resolve an `<id-or-slug>` to a cell-id UUID. Pass-through for the id
    /// case; one `fuz_forge_repo_get` roundtrip for the slug case. Returns
    /// `CliError` because it composes an arg-parse (`RepoId`) with an RPC.
    pub async fn resolve_repo_id(&self, input: &str) -> Result<String, CliError> {
        match resolve_repo_id_or_slug(input)? {
            RepoLookup::Id(id) => Ok(id),
            RepoLookup::Slug(slug) => {
                let wrapper: RepoEnvelope = self
                    .rpc("fuz_forge_repo_get", serde_json::json!({"slug": slug}))
                    .await?;
                Ok(wrapper.repo.id)
            }
        }
    }

    /// Return `response` when 2xx, else a `Redirected` error for a `3xx` or a
    /// `Status` error carrying `context` + a body excerpt — the non-2xx
    /// contract every request shares.
    async fn ensure_ok(
        &self,
        response: reqwest::Response,
        context: impl Into<String>,
    ) -> Result<reqwest::Response, ClientError> {
        if response.status().is_success() {
            Ok(response)
        } else {
            Err(self.status_error(context.into(), response).await)
        }
    }

    /// Build a `Status` error carrying the start of the body for context —
    /// read to a bound by `read_error_text`, so an error response costs the
    /// same whatever the server sends — or, for a `3xx` (never followed), a
    /// `Redirected` error with no body.
    async fn status_error(&self, context: String, mut response: reqwest::Response) -> ClientError {
        let status = response.status();
        if status.is_redirection() {
            return ClientError::Redirected { context, status };
        }
        let body = read_error_text(&mut response).await;
        ClientError::Status {
            context,
            status,
            body,
        }
    }
}

fn too_large(context: &str, max: u64) -> ClientError {
    ClientError::TooLarge {
        context: context.to_string(),
        max,
    }
}

/// Refuse a response whose declared `Content-Length` already exceeds `max`,
/// before any of the body is read. A fast path only: the counter in the read
/// is the bound that holds.
fn check_content_length(
    response: &reqwest::Response,
    max: u64,
    context: &str,
) -> Result<(), ClientError> {
    match response.content_length() {
        Some(len) if len > max => Err(too_large(context, max)),
        _ => Ok(()),
    }
}

/// Buffer a response body, refusing it as soon as it passes `max` bytes
/// however the server framed it.
async fn read_body_capped(
    response: &mut reqwest::Response,
    max: u64,
    context: &str,
) -> Result<Vec<u8>, ClientError> {
    check_content_length(response, max, context)?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if (body.len() + chunk.len()) as u64 > max {
            return Err(too_large(context, max));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Stream a response body into a file created at `path`, hashing it as it
/// goes, and refuse it as soon as it passes `max` bytes. Returns the body's
/// blake3 as hex.
///
/// On any failure — an overrun, a read or write error — the file at `path` is
/// removed, so no partial download is left behind.
async fn stream_to_file(
    response: &mut reqwest::Response,
    path: &Path,
    max: u64,
    context: &str,
) -> Result<String, ClientError> {
    let mut hasher = Hasher::new(HashAlgo::Blake3);
    let result = async {
        let mut file = tokio::fs::File::create(path).await?;
        let mut total: u64 = 0;
        while let Some(chunk) = response.chunk().await? {
            total = total.saturating_add(chunk.len() as u64);
            if total > max {
                return Err(too_large(context, max));
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        Ok::<_, ClientError>(())
    }
    .await;
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(path).await;
        return Err(e);
    }
    Ok(hasher.finalize().to_hex())
}

/// Decode a JSON response body read to at most `max` bytes.
async fn read_json<T: DeserializeOwned>(
    mut response: reqwest::Response,
    max: u64,
    context: &str,
) -> Result<T, ClientError> {
    let body = read_body_capped(&mut response, max, context).await?;
    serde_json::from_slice(&body).map_err(ClientError::Decode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fuz_storage::MAX_ERROR_BODY_LEN;
    use fuz_storage::base_url::validate_base_url;

    /// A client for `base`, which must pass the base-URL policy.
    fn client_for(base: &str) -> ForgeClient {
        ForgeClient::new(validate_base_url(base).unwrap(), "secret".to_owned()).unwrap()
    }

    #[test]
    fn forge_client_debug_redacts_the_token() {
        let client = ForgeClient::new(
            validate_base_url("https://forge.example.com/").unwrap(),
            "secret_fuz_token_client-Mv3qZ8".to_owned(),
        )
        .unwrap();
        let rendered = format!("{client:?}");
        assert!(!rendered.contains("client-Mv3qZ8"), "{rendered}");
        assert!(rendered.contains("<redacted>"), "{rendered}");
        assert!(rendered.contains("https://forge.example.com"), "{rendered}");
    }

    // A plaintext URL to a remote host is refused before a client exists: a
    // `ForgeClient` takes only a validated `BaseUrl`, and the refusal is
    // `config`'s (`server_url_refusal_is_a_config_error`).

    /// Serve one connection with a `302` to `location`, returning the port and
    /// a handle that yields the request head the server read.
    fn serve_one_redirect(location: String) -> (u16, std::thread::JoinHandle<String>) {
        use std::io::{BufRead as _, BufReader, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
            let mut head = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            );
            head
        });
        (port, handle)
    }

    /// A redirect fails the request rather than carrying the bearer token (or
    /// a write's body) to wherever it points — reads and writes alike.
    #[tokio::test]
    async fn redirects_are_not_followed() {
        // a listener that must never be reached: the redirect target
        let target = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        target.set_nonblocking(true).expect("nonblocking");
        let target_port = target.local_addr().expect("addr").port();
        let location = format!("http://127.0.0.1:{target_port}/api/rpc");

        let (port, served) = serve_one_redirect(location.clone());
        let client = client_for(&format!("http://127.0.0.1:{port}"));
        let err = client
            .rpc::<serde_json::Value>("fuz_forge_repo_list", serde_json::json!({}))
            .await
            .unwrap_err();
        assert!(
            matches!(err, ClientError::Redirected { status, .. } if status == StatusCode::FOUND),
            "{err:?}"
        );
        assert_eq!(err.exit_code(), 2);
        assert!(err.hint().is_some());
        assert!(served.join().unwrap().starts_with("POST /api/rpc "));

        let (port, served) = serve_one_redirect(location);
        let client = client_for(&format!("http://127.0.0.1:{port}"));
        let err = client.list_files().await.unwrap_err();
        assert!(matches!(err, ClientError::Redirected { .. }), "{err:?}");
        served.join().unwrap();

        assert!(
            target.accept().is_err(),
            "the redirect target was contacted"
        );
    }

    /// Serve one connection with the raw `response` bytes — after reading the
    /// request head and any `Content-Length` body, so closing never resets a
    /// request still being sent. Returns the port and a join handle.
    fn serve_one(response: Vec<u8>) -> (u16, std::thread::JoinHandle<()>) {
        use std::io::{BufRead as _, BufReader, Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
            let mut body_len = 0;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if let Some(len) = lower.strip_prefix("content-length:") {
                    body_len = len.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0; body_len];
            let _ = reader.read_exact(&mut body);
            let _ = stream.write_all(&response);
        });
        (port, handle)
    }

    /// Wait for a `serve_one` thread off the runtime thread: the client's
    /// connection task must keep running to close a connection whose body it
    /// stopped reading, or the server blocks writing the rest.
    async fn joined(served: std::thread::JoinHandle<()>) {
        tokio::task::spawn_blocking(move || served.join().expect("server thread"))
            .await
            .expect("join");
    }

    /// A response head plus `body`, framed by `Content-Length`.
    fn reply(status: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    /// A hostile server's error body is read to a bound however long it is,
    /// and shown cut and escaped: its control sequence and line breaks cannot
    /// reach the terminal.
    #[tokio::test]
    async fn an_error_body_is_bounded_and_escaped() {
        let mut body = b"\x1b[2J\x1b]0;pwned\x07fake\nerror: line".to_vec();
        body.extend(std::iter::repeat_n(b'A', 4 * 1024 * 1024));
        let (port, served) = serve_one(reply("500 Internal Server Error", &body));
        let err = client_for(&format!("http://127.0.0.1:{port}"))
            .list_files()
            .await
            .unwrap_err();
        joined(served).await;
        let ClientError::Status { body, .. } = &err else {
            panic!("{err:?}");
        };
        assert!(body.len() <= MAX_ERROR_BODY_LEN, "{}", body.len());
        let shown = fuz_sys::cli::format_error_chain(&err);
        // the one line break is the error's own, before the excerpt
        let (head, excerpt) = shown.split_once('\n').expect("an excerpt line");
        assert_eq!(head, "failed to list files: 500 Internal Server Error");
        assert!(!excerpt.chars().any(char::is_control), "{shown:?}");
        assert!(excerpt.starts_with("\\u{1b}[2J"), "{shown}");
        assert!(shown.contains("fake\\nerror: line"), "{shown}");
        // the cut excerpt, its ellipsis, and the fixed text around it
        assert!(
            shown.len() < 2 * MAX_SHOWN_SERVER_TEXT_LEN,
            "{}",
            shown.len()
        );
        assert_eq!(err.exit_code(), 1);
    }

    /// An RPC error's message is the server's text, shown escaped and cut.
    #[tokio::test]
    async fn an_rpc_error_message_is_escaped() {
        let message = format!("\x1b[31mred\r\nerror: forged{}", "B".repeat(10_000));
        let envelope = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": {"code": -32603, "message": message},
        });
        let (port, served) = serve_one(reply("200 OK", &serde_json::to_vec(&envelope).unwrap()));
        let err = client_for(&format!("http://127.0.0.1:{port}"))
            .rpc::<serde_json::Value>("fuz_forge_repo_list", serde_json::json!({}))
            .await
            .unwrap_err();
        joined(served).await;
        assert!(matches!(err, ClientError::Rpc { .. }), "{err:?}");
        let shown = fuz_sys::cli::format_error_chain(&err);
        assert!(!shown.chars().any(char::is_control), "{shown:?}");
        assert!(
            shown.starts_with("RPC fuz_forge_repo_list: \\u{1b}[31mred\\r\\nerror: forged"),
            "{shown}"
        );
        assert!(
            shown.len() < 2 * MAX_SHOWN_SERVER_TEXT_LEN,
            "{}",
            shown.len()
        );
    }

    /// A decode error can quote the server's text; it is shown escaped too.
    #[tokio::test]
    async fn a_decode_error_is_escaped() {
        let (port, served) = serve_one(reply("200 OK", b"{\"files\": \"\\u001b[2Jx\"}"));
        let err = client_for(&format!("http://127.0.0.1:{port}"))
            .list_files()
            .await
            .unwrap_err();
        joined(served).await;
        assert!(matches!(err, ClientError::Decode(_)), "{err:?}");
        let shown = fuz_sys::cli::format_error_chain(&err);
        assert!(!shown.chars().any(char::is_control), "{shown:?}");
        assert!(shown.contains("\\u{1b}[2Jx"), "{shown}");
    }

    /// Declared lengths past each read's bound are refused before the body is
    /// read: a listing past `MAX_FORGE_LIST_SIZE`, an RPC answer past
    /// `MAX_RPC_RESPONSE_SIZE`, a download past `MAX_TRANSFER_SIZE` — the last
    /// before its destination or temp file is created.
    #[tokio::test]
    async fn an_oversized_declared_length_is_refused_before_reading() {
        let declared = |len: u64| {
            format!("HTTP/1.1 200 OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n")
                .into_bytes()
        };

        let (port, served) = serve_one(declared(MAX_FORGE_LIST_SIZE + 1));
        let err = client_for(&format!("http://127.0.0.1:{port}"))
            .list_files()
            .await
            .unwrap_err();
        joined(served).await;
        assert!(
            matches!(err, ClientError::TooLarge { max, .. } if max == MAX_FORGE_LIST_SIZE),
            "{err:?}"
        );
        assert_eq!(err.exit_code(), 1);

        let (port, served) = serve_one(declared(MAX_RPC_RESPONSE_SIZE + 1));
        let err = client_for(&format!("http://127.0.0.1:{port}"))
            .rpc::<serde_json::Value>("fuz_forge_repo_list", serde_json::json!({}))
            .await
            .unwrap_err();
        joined(served).await;
        assert!(
            matches!(err, ClientError::TooLarge { max, .. } if max == MAX_RPC_RESPONSE_SIZE),
            "{err:?}"
        );

        let dir =
            std::env::temp_dir().join(format!("fuzf_client_test_{}", fuz_sys::rand::random_hex(8)));
        let dest = dir.join("out.bin");
        let (port, served) = serve_one(declared(MAX_TRANSFER_SIZE + 1));
        let err = client_for(&format!("http://127.0.0.1:{port}"))
            .download_file("a.bin", &dest, "00")
            .await
            .unwrap_err();
        joined(served).await;
        assert!(
            matches!(err, ClientError::TooLarge { max, .. } if max == MAX_TRANSFER_SIZE),
            "{err:?}"
        );
        assert!(!dir.exists(), "the download created {}", dir.display());
    }

    /// A chunked response of four 1 KiB chunks, with no declared length.
    fn chunked_4k() -> Vec<u8> {
        let mut response =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
        for _ in 0..4 {
            response.extend_from_slice(b"400\r\n");
            response.extend(std::iter::repeat_n(b'x', 0x400));
            response.extend_from_slice(b"\r\n");
        }
        response.extend_from_slice(b"0\r\n\r\n");
        response
    }

    /// The download's byte counter holds however the body is framed: a
    /// chunked body is refused once it passes the bound, and the file it was
    /// streaming into is removed.
    #[tokio::test]
    async fn a_streamed_download_past_its_bound_leaves_no_file() {
        let (port, served) = serve_one(chunked_4k());
        let base = format!("http://127.0.0.1:{port}");
        let mut got = client_for(&base).client.get(base).send().await.unwrap();
        let path = std::env::temp_dir().join(format!(
            ".downloading-test-{}",
            fuz_sys::rand::random_hex(8)
        ));
        let err = stream_to_file(&mut got, &path, 2048, "download")
            .await
            .unwrap_err();
        joined(served).await;
        assert!(
            matches!(err, ClientError::TooLarge { max: 2048, .. }),
            "{err:?}"
        );
        assert!(!path.exists(), "{} was left behind", path.display());
    }

    /// The byte counter holds however the body is framed: a chunked body with
    /// no declared length is refused once it passes the bound.
    #[tokio::test]
    async fn a_chunked_body_is_refused_past_its_bound() {
        let (port, served) = serve_one(chunked_4k());
        let base = format!("http://127.0.0.1:{port}");
        let mut got = client_for(&base).client.get(base).send().await.unwrap();
        let err = read_body_capped(&mut got, 2048, "read").await.unwrap_err();
        joined(served).await;
        assert!(
            matches!(err, ClientError::TooLarge { max: 2048, .. }),
            "{err:?}"
        );
    }

    /// Type-level pin on what [`ForgeClient::upload_file`] decodes.
    ///
    /// The upload body carries `status` and no `uploaded_at`, so binding the
    /// upload back to the `?meta` metadata shape — which every real upload
    /// would then fail to deserialize, after the bytes had already landed —
    /// stops compiling here.
    #[allow(dead_code, reason = "compile-time assertion, never called")]
    async fn upload_file_decodes_the_upload_body(
        client: &ForgeClient,
        filename: &str,
        src: &Path,
    ) -> Result<FileUploadOutput, ClientError> {
        client.upload_file(filename, src).await
    }

    /// The same pin for the metadata probe: `fetch_file_meta` reads the `?meta`
    /// body, the one shape that does resolve `uploaded_at`.
    #[allow(dead_code, reason = "compile-time assertion, never called")]
    fn file_meta_lookup_carries_the_metadata_body(
        lookup: FileMetaLookup,
    ) -> Option<FileMetaOutput> {
        match lookup {
            FileMetaLookup::Found(meta) => Some(meta),
            FileMetaLookup::Missing | FileMetaLookup::Forbidden => None,
        }
    }
}
