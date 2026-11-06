//! `fuzf file put|get|list|delete` — the content-addressed file store.
//!
//! Uploads/downloads stream with bounded memory and verify blake3 (the upload
//! verifies the server stored what was sent; the download verifies the bytes
//! match the server's metadata).

use std::path::PathBuf;

use argh::FromArgs;
use fuz_crypto::{HashAlgo, hash_file};

use crate::CliError;
use crate::cli::print_json;
use crate::client::{ClientError, FileMetaLookup, ForgeClient};
use crate::format::{SHORT_HASH_LEN, fit_column, format_bytes, short};
use crate::output::FileMetaOutput;

/// Content-addressed file store (put|get|list|delete).
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "file")]
pub struct File {
    #[argh(subcommand)]
    pub nested: FileSub,
}

#[derive(FromArgs, Debug)]
#[argh(subcommand)]
pub enum FileSub {
    Put(Put),
    Get(Get),
    List(List),
    Delete(Delete),
}

/// Upload files to the server file store.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "put")]
pub struct Put {
    /// file path(s) to upload
    #[argh(positional)]
    pub paths: Vec<PathBuf>,

    /// override filename on the server (single file only)
    #[argh(option)]
    pub name: Option<String>,
}

/// Download a file from the server file store.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "get")]
pub struct Get {
    /// filename to download
    #[argh(positional)]
    pub name: String,

    /// output path (defaults to the filename in the current directory)
    #[argh(option, short = 'o')]
    pub output: Option<PathBuf>,
}

/// List files in the store, or show one file's metadata.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "list")]
pub struct List {
    /// optional filename for a single-file detail view
    #[argh(positional)]
    pub name: Option<String>,

    /// output as JSON
    #[argh(switch)]
    pub json: bool,
}

/// Delete a file from the server file store.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "delete")]
pub struct Delete {
    /// filename to delete
    #[argh(positional)]
    pub name: String,

    /// auto-confirm deletion
    #[argh(switch, short = 'y')]
    pub yes: bool,
}

pub async fn cmd_file(args: File) -> Result<(), CliError> {
    match args.nested {
        FileSub::Put(a) => cmd_put(a).await,
        FileSub::Get(a) => cmd_get(a).await,
        FileSub::List(a) => cmd_list(a).await,
        FileSub::Delete(a) => cmd_delete(a).await,
    }
}

async fn cmd_put(args: Put) -> Result<(), CliError> {
    if args.paths.is_empty() {
        return Err(CliError::Usage(
            "file put requires at least one path".to_string(),
        ));
    }
    if args.name.is_some() && args.paths.len() > 1 {
        return Err(CliError::Usage(
            "--name can only be used with a single file".to_string(),
        ));
    }

    let client = ForgeClient::connect()?;

    for path in &args.paths {
        let filename = match &args.name {
            Some(n) => n.clone(),
            None => path
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| {
                    CliError::Usage(format!("cannot derive filename from {}", path.display()))
                })?
                .to_string(),
        };

        let is_file = std::fs::metadata(path).is_ok_and(|m| m.is_file());
        if !is_file {
            return Err(ClientError::NotAFile(path.clone()).into());
        }

        // Up-to-date pre-check: hash the local file and skip the network round
        // trip when the server already has identical bytes.
        let (local_hash, size) = hash_file(HashAlgo::Blake3, path).map_err(ClientError::Io)?;
        let local_hex = local_hash.to_hex();
        // The wire's `size_bytes` is `i64`, so the local `u64` converts here —
        // saturating rather than wrapping, since a wrap would print a negative
        // size. Nothing on disk reaches `i64::MAX` bytes.
        let size = i64::try_from(size).unwrap_or(i64::MAX);

        // Only the exact-hash-match case skips the upload; a missing file (404)
        // or a read-denied probe (403, e.g. an upload-only token) falls through
        // to upload, where the write enforces its own scope.
        if let FileMetaLookup::Found(existing) = client.fetch_file_meta(&filename).await?
            && existing.blake3_hash == local_hex
        {
            println!("{filename}  {}  already up to date", format_bytes(size));
            continue;
        }

        let result = client.upload_file(&filename, path).await?;
        if result.blake3_hash != local_hex {
            return Err(ClientError::HashMismatch {
                filename,
                expected: short(&local_hex, SHORT_HASH_LEN),
                actual: short(&result.blake3_hash, SHORT_HASH_LEN),
            }
            .into());
        }
        println!(
            "{}  {}  {}...",
            result.filename,
            format_bytes(result.size_bytes),
            short(&result.blake3_hash, SHORT_HASH_LEN)
        );
    }
    Ok(())
}

/// The metadata of `filename`, or the refusal `get` and `list` report when the
/// server has none to give: a 404 is [`ClientError::FileNotFound`], a 403
/// [`ClientError::Forbidden`].
async fn require_file_meta(
    client: &ForgeClient,
    filename: &str,
) -> Result<FileMetaOutput, ClientError> {
    match client.fetch_file_meta(filename).await? {
        FileMetaLookup::Found(meta) => Ok(meta),
        FileMetaLookup::Missing => Err(ClientError::FileNotFound(filename.to_owned())),
        FileMetaLookup::Forbidden => Err(ClientError::Forbidden(filename.to_owned())),
    }
}

async fn cmd_get(args: Get) -> Result<(), CliError> {
    let client = ForgeClient::connect()?;
    let filename = &args.name;

    let meta = require_file_meta(&client, filename).await?;

    let output_path = args
        .output
        .clone()
        .unwrap_or_else(|| PathBuf::from(format!("./{filename}")));

    // Stream straight to the output path: temp-beside-dest + incremental
    // blake3 verify + atomic rename, bounded memory. No local cache — `get` is
    // a one-shot delivery (each fetch is independent), so a content cache here
    // would only add a redundant full-file copy per call; the durable content
    // cache lives at the consumer install layer (`~/.fuz/tools/<name>/v1-<hash>/`),
    // not in this byte-pull primitive.
    client
        .download_file(filename, &output_path, &meta.blake3_hash)
        .await?;

    println!(
        "{filename}  → {}  {}...",
        output_path.display(),
        short(&meta.blake3_hash, SHORT_HASH_LEN)
    );
    Ok(())
}

async fn cmd_list(args: List) -> Result<(), CliError> {
    let client = ForgeClient::connect()?;

    if let Some(filename) = &args.name {
        let meta = require_file_meta(&client, filename).await?;
        if args.json {
            print_json(&serde_json::json!({"file": meta}))?;
            return Ok(());
        }
        println!("{}", meta.filename);
        println!("  Size:        {}", format_bytes(meta.size_bytes));
        println!("  BLAKE3:      {}", meta.blake3_hash);
        println!("  Type:        {}", meta.content_type);
        println!("  Uploaded:    {}", meta.uploaded_at);
        return Ok(());
    }

    let files = client.list_files().await?;
    if args.json {
        print_json(&serde_json::json!({"files": files}))?;
        return Ok(());
    }
    if files.is_empty() {
        println!("No files in the file store.");
        return Ok(());
    }

    println!("{:<45} {:>10} {:<16} UPLOADED", "FILENAME", "SIZE", "HASH");
    for file in &files {
        let name = fit_column(&file.filename, 45);
        let size = format!("{:>10}", format_bytes(file.size_bytes));
        let hash = format!(
            "{:<16}",
            format!("{}...", short(&file.blake3_hash, SHORT_HASH_LEN))
        );
        let uploaded = short(&file.uploaded_at, 10);
        println!("{name} {size} {hash} {uploaded}");
    }
    let n = files.len();
    println!("\n{n} file{}", if n == 1 { "" } else { "s" });
    Ok(())
}

async fn cmd_delete(args: Delete) -> Result<(), CliError> {
    let client = ForgeClient::connect()?;
    let filename = &args.name;

    // Probe metadata, but don't gate the delete on a read the token may lack: a
    // real 404 errors early (nicer than deferring to the delete call), while a
    // 403 (a read-denied scoped token that may still hold files.delete) falls
    // through — the server is authoritative on the delete itself.
    let meta = client.fetch_file_meta(filename).await?;
    if matches!(meta, FileMetaLookup::Missing) {
        return Err(ClientError::FileNotFound(filename.clone()).into());
    }

    if !args.yes {
        let size_note = match &meta {
            FileMetaLookup::Found(m) => format!(" ({})", format_bytes(m.size_bytes)),
            _ => String::new(),
        };
        println!("Delete {filename}{size_note}?");
        println!("Run with --yes to confirm deletion.");
        return Err(CliError::Declined);
    }

    client.delete_file(filename).await?;
    println!("Deleted {filename}");
    Ok(())
}
