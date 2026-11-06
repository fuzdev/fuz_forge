//! Server env validation.
//!
//! Port of `src/lib/server/env/schema.ts` (the Rust subset needed by the
//! web/storage/forge surface). Provisioning/deployment env (apply timeouts,
//! deploy secrets) is the standalone `zap` CLI's, read from its own operator
//! env files — the forge server never sees it.
//!
//! ## Caching
//!
//! The env is read once at startup — `FuzForgeEnv::from_process()` runs in
//! `run_app` before the router is built — rather than behind a global cached-env
//! `OnceCell`. No global state.

use std::fmt::Display;
use std::path::PathBuf;
use std::str::FromStr;

use fuz_actions::server::StartupError;
use fuz_http::{BaseServerEnv, ServerEnvOptions};

/// Default file-store upload cap when `FUZ_FORGE_FILE_STORE_MAX_BYTES` is unset.
///
/// Scoped to the `/api/fuz_forge/files` routes only — the generic API/RPC
/// surface keeps `fuz_http::DEFAULT_BODY_LIMIT_BYTES` (1 MiB). The file-store
/// upload handler owns this cap directly (Content-Length pre-check + the
/// streaming byte counter in `FactStore::put_stream`).
///
/// 10 GiB covers Debian DVD ISOs (~3.7 GB) and future OS images. The server
/// streams both directions (`put_stream` on upload, `ReaderStream` on
/// download), so this is a policy / disk-quota ceiling, not a memory guard.
///
/// The signed-artifact path (`fuz self upgrade` / `tool install` and the
/// `fuz_sign` producer) and the `fuzf file get`/`put` raw-file client both
/// stream end-to-end (bounded memory), so no client hop buffers a whole
/// artifact. Operators can still lower this ceiling via the env var.
pub const DEFAULT_FILE_STORE_MAX_BYTES: usize = 10 * 1024 * 1024 * 1024;

/// Default free-space headroom (1 GiB) kept beyond a declared upload when
/// `FUZ_FORGE_FILE_STORE_FREE_SPACE_MARGIN_BYTES` is unset.
///
/// The per-request cap bounds a *single* upload; nothing bounds the *aggregate*,
/// so N concurrent ~10 GiB uploads can fill the disk (ENOSPC cascade). The
/// upload handler probes free space (statvfs) and rejects with `507
/// storage_full` when `free < declared_size + margin` — keeping headroom for the
/// DB, logs, and in-flight temps rather than letting the file store fill the
/// volume to zero. `0` disables the margin (still rejects an upload larger than
/// raw free space).
pub const DEFAULT_FILE_STORE_FREE_SPACE_MARGIN_BYTES: u64 = 1024 * 1024 * 1024;

/// Default ceiling on concurrent streaming uploads when
/// `FUZ_FORGE_FILE_STORE_MAX_CONCURRENT_UPLOADS` is unset.
///
/// A semaphore bounds how many large uploads stream to disk at once — capping
/// aggregate in-flight temp churn / file descriptors on top of the free-space
/// preflight (the preflight is the teeth; this bounds the herd). Excess uploads
/// wait for a permit rather than racing to fill the disk. Must be `> 0`.
pub const DEFAULT_FILE_STORE_MAX_CONCURRENT_UPLOADS: usize = 4;

/// The spine's base env, with the forge's trusted proxies under
/// `FUZ_FORGE_TRUSTED_PROXIES`.
///
/// Unset or empty, the list is the loopback nginx hop (`127.0.0.1` + `::1`,
/// [`fuz_http::DEFAULT_TRUSTED_PROXIES`]), matching the TS twin's hardcoded
/// `trusted_proxies` (`server.ts`); the zap recipe renders its IPv4 half,
/// `127.0.0.1` — so
/// the forge reads the *real* client out of `X-Forwarded-For` behind its own
/// nginx hop, and `api_token.last_used_ip`, `audit_log.ip`, and the per-IP
/// login rate limiter see the caller rather than `127.0.0.1`. Only loopback is
/// trusted, so a direct (non-loopback) client can never spoof the header. A
/// value that parses empty (`,`) opts out of XFF trust, not of client-IP
/// resolution: `router::compose` mounts `client_ip_middleware` for any set,
/// so an empty one keys on the TCP peer.
pub const ENV_OPTIONS: ServerEnvOptions = ServerEnvOptions {
    trusted_proxies_var: "FUZ_FORGE_TRUSTED_PROXIES",
};

/// Default fuz_forge home when `FUZ_FORGE_HOME` is unset or empty, before
/// tilde expansion. The literal the TS `fuz_forge_home` (`src/lib/runtime/path.ts`)
/// falls back to, character for character.
const DEFAULT_FUZ_FORGE_HOME: &str = "~/.fuz_forge";

/// Validated environment for the fuz_forge server.
///
/// Source order: process env > sensible defaults. No file-based
/// `.env` resolution — operators set vars via systemd / Docker / direnv.
///
/// `Debug` redacts the credential-bearing base fields (`database_url` carries
/// the DB password; `cookie_keys` is the `SECRET_FUZ_COOKIE_KEYS` value) through
/// [`BaseServerEnv`]'s own `Debug`, so a stray `{env:?}` can't leak them.
#[derive(Clone)]
pub struct FuzForgeEnv {
    /// The spine's base vars: `DATABASE_URL` (absent → boot-only mode),
    /// `SECRET_FUZ_COOKIE_KEYS`, `HOST` / `PORT`, `FUZ_ALLOWED_ORIGINS`
    /// (required), `FUZ_FORGE_TRUSTED_PROXIES` ([`ENV_OPTIONS`]), and
    /// `FUZ_BOOTSTRAP_TOKEN_PATH`. `base.port` alone also feeds the git hooks'
    /// loopback callback base ([`crate::repo_storage::build_callback_url_base`]),
    /// which always targets `127.0.0.1` whatever the bind host.
    pub base: BaseServerEnv,

    /// `PATH` for the forge's git/chmod subprocesses, defaulted to
    /// [`crate::forge_git::read::DEFAULT_GIT_PATH`] when the daemon's own
    /// environment carries none — the twin of the TS `git_env(deps)`'s
    /// `deps.env_get('PATH') ?? <literal>`. Read through this seam rather than
    /// by a `std::env::var("PATH")` inside `git_env` so tests can inject it.
    pub git_path: String,

    /// Override for the disk-backed fact storage root. `None` when
    /// `FUZ_FORGE_FACT_STORE_PATH` is unset — read it through
    /// [`FuzForgeEnv::fact_store_root`], which defaults to `<home>/facts`.
    pub fact_store_path: Option<PathBuf>,

    /// Override for the forge git bare-repo root. `None` when
    /// `FUZ_FORGE_REPO_STORE_PATH` is unset — read it through
    /// [`FuzForgeEnv::repo_store_root`], which defaults to `<home>/repos`.
    pub repo_path: Option<PathBuf>,

    /// The fuz_forge home base — the single root every other fuz_forge state
    /// path defaults under. `FUZ_FORGE_HOME` when set and non-empty, else
    /// [`DEFAULT_FUZ_FORGE_HOME`]; either way tilde-expanded. Read through the
    /// `from_vars` seam (not a `std::env::var` inside the accessors) so tests
    /// inject it like every other var — the twin of the TS `fuz_forge_home(deps)`
    /// in `src/lib/runtime/path.ts`, which takes its `deps` for the same reason.
    ///
    /// Mirrors the sibling `fuz` (`FUZ_HOME`) and `zap` (`ZAP_HOME`) overrides:
    /// setting one var relocates a whole forge environment, so dev and prod
    /// never collide on `~/.fuz_forge/`. The bootstrap token path is
    /// deliberately *not* derived from it — an unset `FUZ_BOOTSTRAP_TOKEN_PATH`
    /// disables bootstrap, a conscious on/off rather than a defaulted-on path.
    pub fuz_forge_home: PathBuf,

    /// Max upload size (bytes) for the `/api/fuz_forge/files` routes. From
    /// `FUZ_FORGE_FILE_STORE_MAX_BYTES` (same env var the TS backend reads),
    /// defaulting to [`DEFAULT_FILE_STORE_MAX_BYTES`]. Scoped to the file store;
    /// the generic surface keeps the 1 MiB default.
    pub file_store_max_bytes: usize,

    /// Free-space headroom (bytes) the upload handler keeps beyond a declared
    /// upload. From `FUZ_FORGE_FILE_STORE_FREE_SPACE_MARGIN_BYTES`, defaulting to
    /// [`DEFAULT_FILE_STORE_FREE_SPACE_MARGIN_BYTES`]. `0` disables the margin.
    pub file_store_free_space_margin_bytes: u64,

    /// Ceiling on concurrent streaming uploads. From
    /// `FUZ_FORGE_FILE_STORE_MAX_CONCURRENT_UPLOADS`, defaulting to
    /// [`DEFAULT_FILE_STORE_MAX_CONCURRENT_UPLOADS`]. Must be `> 0`.
    pub file_store_max_concurrent_uploads: usize,

    /// Admit a `fuz_forge_repo_create` `seed_from` whose host is a loopback,
    /// link-local, unspecified, RFC 1918, carrier-grade NAT or ULA address (or
    /// `localhost`). From
    /// `FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS`, **off** by default.
    ///
    /// `seed_from` becomes `git clone --bare`'s remote, so an unrestricted host
    /// is an admin-only SSRF from the daemon's network position. An operator
    /// mirroring from a sibling host on their own LAN — or a test spawn seeding
    /// from a loopback upstream — turns it on. Parsed through
    /// [`fuz_sys::env::parse_stringbool`], the twin of the TS forge's
    /// `EnvStringbool` on the same name, so one value means the same thing on
    /// both backends and an unrecognized one is a startup error rather than a
    /// silent `false`.
    pub seed_from_allow_private_hosts: bool,
}

impl std::fmt::Debug for FuzForgeEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FuzForgeEnv")
            .field("base", &self.base)
            .field("git_path", &self.git_path)
            .field("fact_store_path", &self.fact_store_path)
            .field("repo_path", &self.repo_path)
            .field("fuz_forge_home", &self.fuz_forge_home)
            .field("file_store_max_bytes", &self.file_store_max_bytes)
            .field(
                "file_store_free_space_margin_bytes",
                &self.file_store_free_space_margin_bytes,
            )
            .field(
                "file_store_max_concurrent_uploads",
                &self.file_store_max_concurrent_uploads,
            )
            .field(
                "seed_from_allow_private_hosts",
                &self.seed_from_allow_private_hosts,
            )
            .finish()
    }
}

impl FuzForgeEnv {
    /// Read + validate the env from the current process.
    ///
    /// Returns `StartupError::Config` on malformed values; absent
    /// optional fields fall through to defaults.
    pub fn from_process() -> Result<Self, StartupError> {
        Self::from_vars(&|key| std::env::var(key).ok())
    }

    /// Read + validate from an arbitrary var lookup. `from_process` injects
    /// `std::env::var`; tests inject a map so env reading is verified without
    /// mutating (racy) global process env.
    ///
    /// **Canonical names.** The spine-owned vars match the TS backend's
    /// (`fuz_app`'s `BaseServerEnv`) names + shapes — un-prefixed `HOST` +
    /// numeric `PORT` (not a single `host:port` `FUZ_FORGE_BIND_ADDR`),
    /// `FUZ_ALLOWED_ORIGINS`, `FUZ_BOOTSTRAP_TOKEN_PATH`, `DATABASE_URL`.
    /// Forge-specific vars keep the `FUZ_FORGE_` prefix and match the TS
    /// forge's (`FUZ_FORGE_REPO_STORE_PATH`, `FUZ_FORGE_FACT_STORE_PATH`,
    /// `FUZ_FORGE_FILE_STORE_*`). Both backends read one env contract — no
    /// per-backend remap in the cross-backend harness.
    pub(crate) fn from_vars(get: &impl Fn(&str) -> Option<String>) -> Result<Self, StartupError> {
        let base = BaseServerEnv::from_vars(get, ENV_OPTIONS)?;
        let git_path =
            get("PATH").unwrap_or_else(|| crate::forge_git::read::DEFAULT_GIT_PATH.to_owned());

        // Every operator-supplied path goes through `fuz_sys::expand_tilde`,
        // matching the TS twin's `resolve_tilde` on all four shapes: `~` and
        // `~/rest` expand against the home, `~user` and a bare relative path are
        // left alone. The home is `fuz_sys::home_dir`'s (`$HOME`, else the
        // password database's entry); one it refuses — empty, relative, or not
        // found — leaves the value verbatim. The TS twin reads `$HOME` alone —
        // unset leaves the value verbatim there, and a relative one expands.
        // Without the expansion a `~/…` store path lands literally (a `./~`
        // directory under the daemon's cwd) where the TS forge expands it.
        let fact_store_path = get("FUZ_FORGE_FACT_STORE_PATH").map(|s| fuz_sys::expand_tilde(&s));
        let repo_path = get("FUZ_FORGE_REPO_STORE_PATH").map(|s| fuz_sys::expand_tilde(&s));
        // `FUZ_FORGE_HOME` empty-or-unset both fall through to the default,
        // matching the TS `fuz_forge_home(deps)`'s truthiness check on the
        // override — an exported-but-empty var must not relocate the forge to
        // the process cwd.
        let fuz_forge_home = fuz_sys::expand_tilde(
            get("FUZ_FORGE_HOME")
                .filter(|s| !s.is_empty())
                .as_deref()
                .unwrap_or(DEFAULT_FUZ_FORGE_HOME),
        );

        let file_store_max_bytes = parse_or(
            get,
            "FUZ_FORGE_FILE_STORE_MAX_BYTES",
            DEFAULT_FILE_STORE_MAX_BYTES,
        )?;
        if file_store_max_bytes == 0 {
            return Err(StartupError::Config(
                "FUZ_FORGE_FILE_STORE_MAX_BYTES must be > 0".to_string(),
            ));
        }

        let file_store_free_space_margin_bytes = parse_or(
            get,
            "FUZ_FORGE_FILE_STORE_FREE_SPACE_MARGIN_BYTES",
            DEFAULT_FILE_STORE_FREE_SPACE_MARGIN_BYTES,
        )?;

        let file_store_max_concurrent_uploads = parse_or(
            get,
            "FUZ_FORGE_FILE_STORE_MAX_CONCURRENT_UPLOADS",
            DEFAULT_FILE_STORE_MAX_CONCURRENT_UPLOADS,
        )?;
        if file_store_max_concurrent_uploads == 0 {
            return Err(StartupError::Config(
                "FUZ_FORGE_FILE_STORE_MAX_CONCURRENT_UPLOADS must be > 0".to_string(),
            ));
        }

        // Off unless the operator says otherwise, and a value outside the
        // stringbool set is a startup error — a typo must not read as "allow".
        let seed_from_allow_private_hosts = match get("FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS") {
            Some(raw) => fuz_sys::env::parse_stringbool(&raw).map_err(|e| {
                StartupError::Config(format!("FUZ_FORGE_SEED_FROM_ALLOW_PRIVATE_HOSTS: {e}"))
            })?,
            None => false,
        };

        Ok(Self {
            base,
            git_path,
            fact_store_path,
            repo_path,
            fuz_forge_home,
            file_store_max_bytes,
            file_store_free_space_margin_bytes,
            file_store_max_concurrent_uploads,
            seed_from_allow_private_hosts,
        })
    }
}

/// Parse an optional numeric (or any `FromStr`) var via `get`, falling back to
/// `default` when unset. A malformed value is a `StartupError::Config` naming
/// the var. Whitespace is trimmed first.
fn parse_or<T: FromStr>(
    get: &impl Fn(&str) -> Option<String>,
    key: &str,
    default: T,
) -> Result<T, StartupError>
where
    T::Err: Display,
{
    get(key).map_or_else(
        || Ok(default),
        |s| {
            s.trim()
                .parse::<T>()
                .map_err(|e| StartupError::Config(format!("{key}: {e}")))
        },
    )
}

impl FuzForgeEnv {
    /// Effective fact-store disk root: the `FUZ_FORGE_FACT_STORE_PATH` override
    /// or [`Self::fuz_forge_home`] joined with `facts`.
    #[must_use]
    pub fn fact_store_root(&self) -> PathBuf {
        self.fact_store_path
            .clone()
            .unwrap_or_else(|| self.fuz_forge_home.join("facts"))
    }

    /// Effective repo-store root: the `FUZ_FORGE_REPO_STORE_PATH` override or
    /// [`Self::fuz_forge_home`] joined with `repos`.
    #[must_use]
    pub fn repo_store_root(&self) -> PathBuf {
        self.repo_path
            .clone()
            .unwrap_or_else(|| self.fuz_forge_home.join("repos"))
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use super::*;
    use crate::parity::parity_rows;
    use crate::runtime::DEFAULT_ADDR;
    use std::collections::HashMap;

    /// Build an env from explicit pairs via the injectable `from_vars` — no
    /// global `std::env` mutation, so these run race-free in parallel.
    fn env_from(pairs: &[(&str, &str)]) -> FuzForgeEnv {
        let mut map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        // The loader hard-fails on an empty origin allowlist; give tests that
        // aren't about origins a baseline so they exercise the field they care
        // about. Tests that set `FUZ_ALLOWED_ORIGINS` explicitly override this.
        map.entry("FUZ_ALLOWED_ORIGINS".to_string())
            .or_insert_with(|| "http://localhost".to_string());
        FuzForgeEnv::from_vars(&|k| map.get(k).cloned()).expect("env should parse")
    }

    #[test]
    fn reads_canonical_spine_var_names() {
        let env = env_from(&[
            ("HOST", "127.0.0.1"),
            ("PORT", "14141"),
            ("FUZ_ALLOWED_ORIGINS", "http://a.example, http://b.example"),
            ("FUZ_BOOTSTRAP_TOKEN_PATH", "/tmp/bt"),
            ("FUZ_FORGE_REPO_STORE_PATH", "/tmp/repos"),
        ]);
        assert_eq!(
            env.base.bind_addr(DEFAULT_ADDR).unwrap(),
            "127.0.0.1:14141".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(origin_strs(&env), ["http://a.example", "http://b.example"]);
        assert_eq!(
            env.base.bootstrap_token_path,
            Some(PathBuf::from("/tmp/bt"))
        );
        assert_eq!(env.repo_path, Some(PathBuf::from("/tmp/repos")));
    }

    const ENV_RETIRED_FIXTURE: &str =
        include_str!("../../../src/test/fixtures/parity/env_retired.json");

    /// The retired names come from
    /// `src/test/fixtures/parity/env_retired.json`, which the TS twin's
    /// `ServerEnv` suite reads too. The assertions differ by side and that
    /// asymmetry is the contract, not a gap: this loader silently ignores each
    /// name while the TS `z.strictObject` refuses the whole record, and both
    /// refuse to honor it — which is what the cross-backend env contract
    /// requires.
    #[test]
    fn ignores_retired_prefixed_var_names() {
        let rows = parity_rows(ENV_RETIRED_FIXTURE, "retired");
        let mut vars: Vec<(&str, &str)> = rows
            .iter()
            .map(|row| {
                (
                    row["name"].as_str().expect("a name"),
                    row["value"].as_str().expect("a value"),
                )
            })
            .collect();
        // The canonical spelling stays honored beside every retired one.
        vars.push(("FUZ_ALLOWED_ORIGINS", "http://canonical.example"));
        let env = env_from(&vars);
        assert_eq!(
            (env.base.host.as_deref(), env.base.port),
            (None, None),
            "FUZ_FORGE_BIND_ADDR is retired"
        );
        assert_eq!(
            origin_strs(&env),
            ["http://canonical.example"],
            "FUZ_FORGE_ALLOWED_ORIGINS is retired; only canonical FUZ_ALLOWED_ORIGINS is honored"
        );
        assert_eq!(
            env.base.bootstrap_token_path, None,
            "FUZ_FORGE_BOOTSTRAP_TOKEN_PATH is retired"
        );
        assert_eq!(env.repo_path, None, "FUZ_FORGE_REPO_PATH is retired");
    }

    #[test]
    fn store_roots_prefer_explicit_override() {
        // When the explicit env vars are set, the effective roots use them
        // verbatim regardless of FUZ_FORGE_HOME / HOME (the home-based default
        // only applies when the override is unset).
        let env = env_from(&[
            ("FUZ_FORGE_FACT_STORE_PATH", "/explicit/facts"),
            ("FUZ_FORGE_REPO_STORE_PATH", "/explicit/repos"),
        ]);
        assert_eq!(env.fact_store_root(), PathBuf::from("/explicit/facts"));
        assert_eq!(env.repo_store_root(), PathBuf::from("/explicit/repos"));
    }

    /// `FUZ_FORGE_HOME` rides the `from_vars` seam like every other var, so the
    /// store roots it defaults follow an injected value with no global
    /// `std::env` mutation. Twin of the TS `fuz_forge_home(deps)`, which takes
    /// its env deps for the same reason.
    #[test]
    fn fuz_forge_home_is_injectable_and_roots_the_store_defaults() {
        let env = env_from(&[("FUZ_FORGE_HOME", "/injected/forge")]);
        assert_eq!(env.fuz_forge_home, PathBuf::from("/injected/forge"));
        assert_eq!(
            env.fact_store_root(),
            PathBuf::from("/injected/forge/facts")
        );
        assert_eq!(
            env.repo_store_root(),
            PathBuf::from("/injected/forge/repos")
        );

        // The override is tilde-expanded on the same rule as every other path.
        if let Ok(home) = fuz_sys::home_dir() {
            let tilde = env_from(&[("FUZ_FORGE_HOME", "~/forge_home")]);
            assert_eq!(tilde.fuz_forge_home, home.join("forge_home"));
        }

        // An explicit store path still wins over the home-based default.
        let overridden = env_from(&[
            ("FUZ_FORGE_HOME", "/injected/forge"),
            ("FUZ_FORGE_REPO_STORE_PATH", "/explicit/repos"),
        ]);
        assert_eq!(
            overridden.repo_store_root(),
            PathBuf::from("/explicit/repos")
        );
        assert_eq!(
            overridden.fact_store_root(),
            PathBuf::from("/injected/forge/facts"),
            "the un-overridden root still follows the injected home"
        );
    }

    /// Unset — and, like the TS twin's truthiness check on the override, an
    /// exported-but-empty `FUZ_FORGE_HOME` — falls back to the expanded
    /// [`DEFAULT_FUZ_FORGE_HOME`], never to the process cwd.
    #[test]
    fn fuz_forge_home_defaults_to_the_expanded_dot_dir() {
        let expected = fuz_sys::expand_tilde(DEFAULT_FUZ_FORGE_HOME);
        assert_eq!(env_from(&[]).fuz_forge_home, expected);
        assert_eq!(env_from(&[("FUZ_FORGE_HOME", "")]).fuz_forge_home, expected);
        assert_eq!(
            env_from(&[]).repo_store_root(),
            expected.join("repos"),
            "the default home roots the store defaults"
        );
    }

    #[test]
    fn store_paths_expand_a_leading_tilde() {
        // Twin of the TS `resolve_tilde` (`src/lib/runtime/path.ts`), pinned on
        // the same four shapes its own suite pins: `~/rest` and bare `~` expand
        // against `$HOME`; `~user` and a bare relative path are verbatim. A
        // store path taken verbatim would put a `~/…` value in a literal `~`
        // directory under the daemon's cwd.
        //
        // The no-home rows (unset with no passwd entry, empty, relative — all
        // leaving the path verbatim) need an injected home, so they are pinned
        // upstream in fuz_sys's resolve_home_dir / expand_tilde_checked tests
        // rather than here — this suite reads the process environment.
        let Ok(home) = fuz_sys::home_dir() else {
            return; // no usable home: expand_tilde leaves the path verbatim
        };
        let env = env_from(&[
            ("FUZ_FORGE_FACT_STORE_PATH", "~/forge_facts"),
            ("FUZ_FORGE_REPO_STORE_PATH", "~"),
            ("FUZ_BOOTSTRAP_TOKEN_PATH", "~/bt"),
        ]);
        assert_eq!(env.fact_store_root(), home.join("forge_facts"));
        assert_eq!(env.repo_store_root(), home);
        assert_eq!(env.base.bootstrap_token_path, Some(home.join("bt")));

        // `~user` and relative paths are NOT expanded — same rule on both sides.
        let verbatim = env_from(&[
            ("FUZ_FORGE_FACT_STORE_PATH", "~other/facts"),
            ("FUZ_FORGE_REPO_STORE_PATH", "relative/repos"),
        ]);
        assert_eq!(
            verbatim.fact_store_root(),
            PathBuf::from("~other/facts"),
            "`~user` must not expand"
        );
        assert_eq!(
            verbatim.repo_store_root(),
            PathBuf::from("relative/repos"),
            "a relative path must not expand"
        );
    }

    #[test]
    fn bind_addr_defaults_when_host_and_port_unset() {
        assert_eq!(
            env_from(&[]).base.bind_addr(DEFAULT_ADDR).unwrap(),
            DEFAULT_ADDR
        );
    }

    #[test]
    fn partial_bind_fills_missing_half_from_default_addr() {
        let env = env_from(&[("PORT", "12345")]);
        assert_eq!(
            env.base.bind_addr(DEFAULT_ADDR).unwrap(),
            SocketAddr::new(DEFAULT_ADDR.ip(), 12345)
        );
    }

    #[test]
    fn missing_or_empty_allowed_origins_hard_fails() {
        // Fail-loud: an absent or blank allowlist refuses the boot. Calls
        // `from_vars` directly (not `env_from`, which injects a baseline).
        let absent = FuzForgeEnv::from_vars(&|_| None).unwrap_err();
        assert!(
            absent.to_string().contains("FUZ_ALLOWED_ORIGINS"),
            "absent allowlist must hard-fail naming FUZ_ALLOWED_ORIGINS, got: {absent}"
        );
        let empty =
            FuzForgeEnv::from_vars(&|k| (k == "FUZ_ALLOWED_ORIGINS").then(|| "  , ".to_string()))
                .unwrap_err();
        assert!(
            empty.to_string().contains("FUZ_ALLOWED_ORIGINS"),
            "whitespace-only allowlist must hard-fail, got: {empty}"
        );
    }

    #[test]
    fn a_malformed_allowed_origin_hard_fails_naming_the_entry() {
        let err = FuzForgeEnv::from_vars(&|k| {
            (k == "FUZ_ALLOWED_ORIGINS").then(|| "https://forge.example,null".to_string())
        })
        .unwrap_err()
        .to_string();
        assert!(err.contains("FUZ_ALLOWED_ORIGINS: "), "{err}");
        assert!(err.contains("entry 2"), "{err}");
    }

    /// The allowlist's entries as written.
    fn origin_strs(env: &FuzForgeEnv) -> Vec<&str> {
        env.base
            .allowed_origins
            .patterns()
            .iter()
            .map(fuz_http::OriginPattern::as_str)
            .collect()
    }

    #[test]
    fn malformed_trusted_proxies_hard_fails() {
        // Fail-loud: a malformed proxy list must refuse boot, not warn-and-
        // ignore — a silently-dropped list records the proxy IP (not the
        // client) in rate-limit keys and `audit_log.ip`.
        let err = FuzForgeEnv::from_vars(&|k| match k {
            "FUZ_ALLOWED_ORIGINS" => Some("http://localhost".to_string()),
            "FUZ_FORGE_TRUSTED_PROXIES" => Some("not-an-ip".to_string()),
            _ => None,
        })
        .unwrap_err();
        assert!(
            err.to_string().contains("FUZ_FORGE_TRUSTED_PROXIES"),
            "malformed proxy list must hard-fail naming the var, got: {err}"
        );
    }

    #[test]
    fn trusted_proxies_unset_defaults_to_loopback() {
        // Unset / empty → the loopback default (127.0.0.1 + ::1), NOT an empty
        // set — so a forge behind its own nginx resolves the real client out of
        // `X-Forwarded-For` rather than attributing every request to the
        // loopback hop. Matches the TS twin's hardcoded `trusted_proxies`
        // (`server.ts`).
        assert_eq!(
            env_from(&[]).base.trusted_proxies.len(),
            2,
            "unset must default to loopback {{127.0.0.1, ::1}}, not an empty set",
        );
        // An explicit value overrides the default.
        let explicit = env_from(&[("FUZ_FORGE_TRUSTED_PROXIES", "10.0.0.0/8")]);
        assert_eq!(explicit.base.trusted_proxies.len(), 1);
        // A value that parses empty (`,`) is the explicit opt-out — back to no
        // XFF trust. The middleware still mounts (`router::compose` layers it
        // for any set); it then keys on the TCP peer, so the opt-out narrows
        // trust without unsetting `ClientIp`.
        let opted_out = env_from(&[("FUZ_FORGE_TRUSTED_PROXIES", ",")]);
        assert!(
            opted_out.base.trusted_proxies.is_empty(),
            "`,` must parse to an explicit empty opt-out",
        );
    }
}
