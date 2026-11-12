//! `fuzf tool` — the forge producer surface.
//!
//! `fuzf tool publish <name> <binary> --version <v>` signs a first-party tool
//! artifact (ed25519 over the domain-tagged canonical JSON, single-sourced in
//! Rust via `fuz_sign`) and uploads it to the configured forge's file store
//! through `fuz_storage`'s `ForgeStorage`. The forge is a dumb byte store — it
//! never signs or verifies; the consumer `fuz tool install <name>` verifies the
//! signature + blake3 against `fuz`'s embedded key after fetching, wherever the
//! bytes live.
//!
//! This is the Rust-native producer half of the distribution loop. The
//! consumer half lives on the `fuz` binary (`fuz tool install / upgrade /
//! verify / list`); signing stays single-sourced here so there is never a
//! second signed-bytes (domain tag + canonical JSON) + ed25519 implementation
//! to keep byte-identical.
//!
//! Resolution defaults match the rest of the toolchain, shared with the other
//! client commands via `crate::config`:
//! - **Signing key**: `$FUZ_HOME/config/signing.key` — the publisher keypair
//!   `cargo xtask key generate` writes in the `fuz` workspace (this workspace's
//!   xtask carries only `check-release`); override with `--key-file`. Loaded by
//!   `fuz_sign::load_signing_key`, the loader `cargo xtask publish` uses too.
//! - **Forge host**: `--server`, else `FUZ_FORGE_BASE_URL`, else
//!   `<fuz_forge_home>/config.json` (`fuz_forge_config_server_url`).
//! - **Bearer token**: `FUZ_FORGE_TOKEN`, else `<fuz_forge_home>/api_token`.
//! - **Target**: `--target <triple>`, else `fuzf`'s own build target. The
//!   binary's header is held to it before anything is signed or uploaded — a
//!   binary for another architecture, OS, or libc is refused naming the
//!   `--target` it is for, and a statically linked one (a musl build?) needs
//!   the target named unless `fuzf` itself is a musl build.

use std::borrow::Cow;
use std::path::PathBuf;

use argh::FromArgs;
use fuz_artifact::ArtifactError;
use fuz_artifact::platform::ReleaseTarget;
use fuz_release::{ManifestError, ReleaseError, is_test_binary_name};
use fuz_sign::{KeyFileError, LogRepo, PublishOptions, load_signing_key, publish_tool};
use fuz_storage::{ForgeStorage, StorageError};
use thiserror::Error;

use crate::CliError;
use crate::config;

//
// CLI args
//

/// Publish first-party tool artifacts to the forge.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "tool")]
pub struct Tool {
    #[argh(subcommand)]
    pub nested: ToolSub,
}

#[derive(FromArgs, Debug)]
#[argh(subcommand)]
pub enum ToolSub {
    Publish(Publish),
}

/// Sign and publish a first-party tool artifact to the forge.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "publish")]
pub struct Publish {
    /// tool name (e.g. zap, zzz, tsv, fuzd, fuzfd)
    #[argh(positional)]
    pub name: String,

    /// path to the compiled binary to publish
    #[argh(positional)]
    pub binary: PathBuf,

    /// version to publish (e.g. 0.1.0)
    #[argh(option)]
    pub version: String,

    /// signing key file (default: `$FUZ_HOME/config/signing.key`)
    #[argh(option)]
    pub key_file: Option<PathBuf>,

    /// forge server URL (default: from env or saved config)
    #[argh(option)]
    pub server: Option<String>,

    /// oldest installed version of the tool allowed to upgrade to this release
    /// (a fresh install is exempt)
    #[argh(option)]
    pub minimum_version: Option<String>,

    /// checkout of the release log repository: record the release there
    /// (sign head.json, commit, push) before the target's latest pointer moves
    #[argh(option)]
    pub log_repo: Option<PathBuf>,

    /// target triple to label the release with (default: fuzf's own); the
    /// binary must be an executable for it
    #[argh(option)]
    pub target: Option<ReleaseTarget>,

    /// suppress output
    #[argh(switch, short = 'q')]
    pub quiet: bool,
}

//
// Errors
//

/// Errors from `fuzf tool` commands.
#[derive(Debug, Error)]
pub enum PublishError {
    /// Release/publish operation failed (signing, packaging, upload).
    #[error("{0}")]
    Release(#[from] ReleaseError),

    /// Storage operation failed (forge config, transfer).
    #[error("{0}")]
    Storage(#[from] StorageError),

    /// The signing key could not be located, read, or parsed.
    #[error(transparent)]
    Key(#[from] KeyFileError),
}

impl PublishError {
    /// Process exit code: caller-side failures are `2` — the signing key, an
    /// argument the publish refuses before reading anything (tool name,
    /// version, binary names, key segments), a binary that is not an
    /// executable for the release's target (or no `--target` where `fuzf`'s
    /// own is unsupported), or a token or path the store refused. Runtime
    /// failures are `1`.
    pub const fn exit_code(&self) -> u8 {
        let caller_side = match self {
            Self::Key(_) => true,
            Self::Storage(e) | Self::Release(ReleaseError::Storage(e)) => {
                matches!(
                    e,
                    StorageError::PermissionDenied { .. } | StorageError::InvalidKey { .. }
                )
            }
            Self::Release(e) => matches!(
                e,
                ReleaseError::Manifest(
                    ManifestError::ToolNotAllowed(_)
                        | ManifestError::EmptyBinaries(_)
                        | ManifestError::ReservedBinaryName { .. }
                        | ManifestError::TestBinaryRejected { .. }
                        | ManifestError::UnpublishableField { .. }
                        | ManifestError::UnpublishableVersion { .. }
                        | ManifestError::UnsupportedTarget(_)
                ) | ReleaseError::Artifact(
                    ArtifactError::BinaryPlatform { .. } | ArtifactError::BinaryUnreadable { .. }
                )
            ),
        };
        if caller_side { 2 } else { 1 }
    }

    /// User-facing hint, if any.
    pub fn hint(&self) -> Option<Cow<'static, str>> {
        match self {
            Self::Release(e) => e.hint(),
            Self::Storage(e) => e.hint().map(Cow::Borrowed),
            Self::Key(e) => e.hint().map(Cow::Borrowed),
        }
    }
}

//
// Dispatch
//

pub async fn cmd_tool(args: Tool) -> Result<(), CliError> {
    match args.nested {
        ToolSub::Publish(opts) => cmd_publish(opts).await,
    }
}

async fn cmd_publish(opts: Publish) -> Result<(), CliError> {
    // 0. The binary is packed under the tool's name, so the manifest's own
    //    `testing_*` filter never sees the source; refuse a test binary here,
    //    before the key is read or the forge contacted.
    if opts
        .binary
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_test_binary_name)
    {
        return Err(CliError::Usage(format!(
            "refusing to publish a test binary: {}",
            opts.binary.display()
        )));
    }

    // 1. Load the maintainer signing key (the only signer; the forge never has it).
    let key = load_signing_key(opts.key_file.as_deref())
        .map_err(PublishError::Key)?
        .key;

    // 2. Resolve the forge connection and build the byte-store backend. Server
    //    + token resolution is shared with the other client commands
    //    (`crate::config`): flag → FUZ_FORGE_BASE_URL → config for the URL,
    //    FUZ_FORGE_TOKEN → <fuz_forge_home>/api_token for the token.
    let base = config::resolve_server_url(opts.server.as_deref())?;
    let token = config::resolve_token()?;
    let storage = ForgeStorage::new(&base.url, token).map_err(PublishError::Storage)?;

    // 3. Sign + package + upload. The in-tarball binary name is the tool name,
    //    so it links into `~/.fuz/bin/<name>` on the consumer side; the source
    //    path may be anything (e.g. ./target/release/<name>).
    let options = PublishOptions {
        minimum_version: opts.minimum_version,
        log_repo: opts.log_repo.map(LogRepo::new),
        target: opts.target,
    };
    let binaries = [(opts.name.clone(), opts.binary)];
    let result = publish_tool(
        &storage,
        &opts.name,
        &opts.version,
        &binaries,
        &key,
        &options,
    )
    .await
    .map_err(PublishError::Release)?;

    if !opts.quiet {
        println!(
            "published {} {} for {} ({})",
            opts.name, result.version, result.target, result.content_hash
        );
        println!("  manifest: {}", result.manifest_path);
        println!("  tarball:  {}", result.tarball_path);
        if let Some(logged) = &result.logged {
            println!("  log:      {logged}");
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fuz_home::FuzHomeError;
    use fuz_sign::KeyError;
    use fuz_sys::secure_file::SecureFileError;

    /// A refusal the caller fixes locally exits 2; a runtime failure exits 1.
    #[test]
    fn publish_exit_codes_by_category() {
        let denied = || StorageError::PermissionDenied {
            backend: fuz_storage::StorageBackendKind::Forge,
            path: "tools/x".to_string(),
        };
        let upload_failed = || StorageError::UploadFailed {
            backend: fuz_storage::StorageBackendKind::Forge,
            message: "y".to_string(),
        };
        assert_eq!(PublishError::Storage(denied()).exit_code(), 2);
        assert_eq!(
            PublishError::Release(ReleaseError::Storage(denied())).exit_code(),
            2
        );
        assert_eq!(
            PublishError::Release(ManifestError::ToolNotAllowed("x".to_string()).into())
                .exit_code(),
            2
        );
        assert_eq!(PublishError::Storage(upload_failed()).exit_code(), 1);
        assert_eq!(
            PublishError::Release(ReleaseError::Storage(upload_failed())).exit_code(),
            1
        );
    }

    /// An unresolvable fuz home forwards the home layer's hint.
    #[test]
    fn config_dir_error_forwards_the_home_hint() {
        let error = PublishError::Key(KeyFileError::ConfigDir(FuzHomeError::RelativeFuzHome {
            path: PathBuf::from("relhome"),
        }));
        assert_eq!(error.exit_code(), 2);
        assert_eq!(
            error.to_string(),
            "failed to resolve fuz config directory: \
             FUZ_HOME must be an absolute path, got relhome"
        );
        let hint = error.hint().expect("a hint");
        assert!(hint.contains("FUZ_HOME"), "{hint}");
    }

    /// Every way the signing key can fail to load is a configuration error
    /// (exit 2) reading as the loader's own message, with the loader's hint.
    #[test]
    fn signing_key_errors_are_configuration_errors_with_the_loader_hint() {
        let path = || PathBuf::from("/keys/signing.key");
        let cases = [
            (
                KeyFileError::Read {
                    path: path(),
                    source: SecureFileError::NotFound(path()),
                },
                "failed to read signing key file /keys/signing.key: \
                 file not found: /keys/signing.key",
                "create a signing key with `cargo xtask key generate` in the fuz workspace",
            ),
            (
                KeyFileError::Read {
                    path: path(),
                    source: SecureFileError::InsecurePermissions(path(), 0o100_644),
                },
                "failed to read signing key file /keys/signing.key: \
                 insecure permissions on /keys/signing.key: 100644 (expected 0600)",
                "a signing key file is its owner's alone: `chmod 600` it",
            ),
            (
                KeyFileError::from(KeyError::InvalidFormat),
                "failed to parse key file: invalid structure",
                "Key file is malformed. Regenerate with `cargo xtask key generate`",
            ),
        ];
        for (key_error, message, hint) in cases {
            let error = PublishError::Key(key_error);
            assert_eq!(error.exit_code(), 2, "{message}");
            assert_eq!(error.to_string(), message);
            assert_eq!(error.hint().as_deref(), Some(hint));
        }
    }

    /// A binary the publish refuses as not for the release's target is the
    /// caller's to fix — rebuild, or name the target it is for — so exit 2.
    #[test]
    fn a_binary_not_for_the_target_exits_2() {
        use fuz_artifact::platform::{
            Arch, BinaryFormatError, BinaryPlatform, Libc, Linkage, PlatformMismatch,
        };
        let target = ReleaseTarget::linux(Arch::X86_64, Libc::Gnu);
        let mismatch = PublishError::Release(
            ArtifactError::BinaryPlatform {
                name: "zap".to_string(),
                target,
                found: BinaryPlatform::Elf {
                    arch: Arch::X86_64,
                    linkage: Linkage::Static,
                },
                mismatch: PlatformMismatch::StaticUnconfirmed,
            }
            .into(),
        );
        assert_eq!(mismatch.exit_code(), 2);
        assert_eq!(
            mismatch.hint().unwrap(),
            "pass --target x86_64-unknown-linux-musl, or --target x86_64-unknown-linux-gnu for \
             a static glibc build"
        );
        let unreadable = PublishError::Release(
            ArtifactError::BinaryUnreadable {
                name: "zap".to_string(),
                reason: BinaryFormatError::NotABinary,
            }
            .into(),
        );
        assert_eq!(unreadable.exit_code(), 2);
        let unsupported = PublishError::Release(
            ManifestError::UnsupportedTarget(fuz_artifact::platform::UnsupportedTarget(
                "riscv64gc-unknown-linux-gnu".to_string(),
            ))
            .into(),
        );
        assert_eq!(unsupported.exit_code(), 2);
    }

    /// `--target` parses to a supported target; omitted, the publish takes
    /// fuzf's own; an unsupported triple is a parse error naming the set.
    #[test]
    fn target_flag_parses_a_supported_triple() {
        let args = Publish::from_args(
            &["publish"],
            &[
                "zap",
                "/bin/zap",
                "--version",
                "0.1.0",
                "--target",
                "aarch64-unknown-linux-musl",
            ],
        )
        .unwrap();
        assert_eq!(
            args.target.map(ReleaseTarget::triple),
            Some("aarch64-unknown-linux-musl")
        );
        let args =
            Publish::from_args(&["publish"], &["zap", "/bin/zap", "--version", "0.1.0"]).unwrap();
        assert_eq!(args.target, None);
        let err = Publish::from_args(
            &["publish"],
            &["zap", "/bin/zap", "--version", "0.1.0", "--target", "musl"],
        )
        .unwrap_err();
        assert!(
            err.output.contains("unsupported release target \"musl\""),
            "{}",
            err.output
        );
    }

    #[test]
    fn log_repo_flag_is_optional() {
        let args = Publish::from_args(
            &["publish"],
            &[
                "fuzd",
                "/bin/fuzd",
                "--version",
                "0.1.0",
                "--log-repo",
                "/log",
            ],
        )
        .unwrap();
        assert_eq!(args.log_repo, Some(PathBuf::from("/log")));
        assert_eq!(args.log_repo.map(LogRepo::new), Some(LogRepo::new("/log")));

        let args =
            Publish::from_args(&["publish"], &["fuzd", "/bin/fuzd", "--version", "0.1.0"]).unwrap();
        assert_eq!(args.log_repo, None);
    }
}
