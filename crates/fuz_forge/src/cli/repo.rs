//! `fuzf repo list|create|view|clone|log|show|refs|resync` — browse and manage
//! forge-hosted repos via the forge's JSON-RPC endpoint.
//!
//! Human output is plain (no ANSI, ISO timestamps); `--json` echoes the raw RPC
//! result (full server shape), except `repo list` which applies its
//! client-side `--limit` first.

use std::process::Command;

use argh::FromArgs;
use base64::Engine as _;
use base64::prelude::BASE64_STANDARD;
use serde_json::{Map, Value, json};

use crate::CliError;
use crate::cli::print_json;
use crate::client::{ClientError, ForgeClient};
use crate::format::{
    DASH, SHORT_HASH_LEN, fit_column, format_sha_paren, format_ts, render_kv_block, short,
};
use crate::output::{
    RepoCommitOutput, RepoEnvelope, RepoListOutput, RepoLogOutput, RepoRefsOutput, RepoResyncOutput,
};
use crate::repo_id::{lookup_params, parse_slug, resolve_repo_id_or_slug};

/// Browse + manage forge repos (list|create|view|clone|log|show|refs|resync).
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "repo")]
pub struct Repo {
    #[argh(subcommand)]
    pub nested: RepoSub,
}

#[derive(FromArgs, Debug)]
#[argh(subcommand)]
pub enum RepoSub {
    List(ListRepos),
    Create(CreateRepo),
    View(ViewRepo),
    Clone(CloneRepo),
    Log(LogRepo),
    Show(ShowRepo),
    Refs(RefsRepo),
    Resync(ResyncRepo),
}

/// List forge-hosted repos.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "list")]
pub struct ListRepos {
    /// filter to slugs starting with this prefix (case-sensitive)
    #[argh(option)]
    pub slug_prefix: Option<String>,
    /// filter to repos pushed since this UTC ISO 8601 datetime
    /// (2026-01-01T00:00:00Z); other spellings are refused, unlike `repo log
    /// --since`, which takes git approxidate
    #[argh(option)]
    pub since: Option<String>,
    /// max results (client-side)
    #[argh(option)]
    pub limit: Option<usize>,
    /// output as JSON
    #[argh(switch)]
    pub json: bool,
}

/// Create a forge-hosted repo.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "create")]
pub struct CreateRepo {
    /// repo slug (org/repo)
    #[argh(positional)]
    pub slug: String,
    /// default branch name (default: main)
    #[argh(option)]
    pub default_branch: Option<String>,
    /// one-shot upstream URL to clone --bare from at create time (absolute
    /// http(s), no credentials; the server refuses loopback / link-local /
    /// private-range hosts unless its operator opted in)
    #[argh(option)]
    pub seed_from: Option<String>,
    /// output as JSON
    #[argh(switch)]
    pub json: bool,
}

/// Show single-repo metadata.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "view")]
pub struct ViewRepo {
    /// repo id or slug
    #[argh(positional)]
    pub id_or_slug: String,
    /// open the admin page in the default browser
    #[argh(switch)]
    pub web: bool,
    /// output as JSON
    #[argh(switch)]
    pub json: bool,
}

/// Print a clone URL (or run `git clone` with --exec).
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "clone")]
pub struct CloneRepo {
    /// repo id or slug
    #[argh(positional)]
    pub id_or_slug: String,
    /// run `git clone` instead of printing the URL
    #[argh(switch)]
    pub exec: bool,
    /// with --exec, authenticate the clone with your API token (handed to git
    /// through its environment, never the URL or `.git/config`)
    #[argh(switch)]
    pub with_auth: bool,
}

/// Paginated commit log for a forge-hosted repo.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "log")]
pub struct LogRepo {
    /// repo id or slug
    #[argh(positional)]
    pub id_or_slug: String,
    /// ref to log (defaults to the repo's default branch)
    #[argh(option)]
    pub r#ref: Option<String>,
    /// filter by author (regex)
    #[argh(option)]
    pub author: Option<String>,
    /// filter to commits since (e.g. 7d, "2 weeks ago")
    #[argh(option)]
    pub since: Option<String>,
    /// limit to commits touching this path
    #[argh(option)]
    pub path: Option<String>,
    /// continue after this SHA (pagination)
    #[argh(option)]
    pub cursor: Option<String>,
    /// max commits per page (1-200; the server rejects anything outside)
    #[argh(option, default = "50")]
    pub limit: u32,
    /// output as JSON
    #[argh(switch)]
    pub json: bool,
}

/// Show a single commit + unified diff.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "show")]
pub struct ShowRepo {
    /// repo id or slug
    #[argh(positional)]
    pub id_or_slug: String,
    /// commit SHA
    #[argh(positional)]
    pub sha: String,
    /// output as JSON
    #[argh(switch)]
    pub json: bool,
}

/// List branches + tags for a forge-hosted repo.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "refs")]
pub struct RefsRepo {
    /// repo id or slug
    #[argh(positional)]
    pub id_or_slug: String,
    /// output as JSON
    #[argh(switch)]
    pub json: bool,
}

/// Re-read the on-disk default-branch tip into the cell.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "resync")]
pub struct ResyncRepo {
    /// repo id or slug
    #[argh(positional)]
    pub id_or_slug: String,
    /// confirm the resync
    #[argh(switch, short = 'y')]
    pub yes: bool,
    /// output as JSON
    #[argh(switch)]
    pub json: bool,
}

pub async fn cmd_repo(args: Repo) -> Result<(), CliError> {
    match args.nested {
        RepoSub::List(a) => cmd_list(a).await,
        RepoSub::Create(a) => cmd_create(a).await,
        RepoSub::View(a) => cmd_view(a).await,
        RepoSub::Clone(a) => cmd_clone(a).await,
        RepoSub::Log(a) => cmd_log(a).await,
        RepoSub::Show(a) => cmd_show(a).await,
        RepoSub::Refs(a) => cmd_refs(a).await,
        RepoSub::Resync(a) => cmd_resync(a).await,
    }
}

/// Deserialize a raw RPC value into a typed output.
fn typed<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, CliError> {
    serde_json::from_value(value)
        .map_err(ClientError::Decode)
        .map_err(CliError::from)
}

/// Insert `key: value` into `map` when `value` is `Some`; a `None` is omitted
/// from the params object entirely.
fn insert_opt(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(v) = value {
        map.insert(key.to_string(), json!(v));
    }
}

async fn cmd_list(args: ListRepos) -> Result<(), CliError> {
    let client = ForgeClient::connect()?;

    let mut params = Map::new();
    insert_opt(&mut params, "slug_prefix", args.slug_prefix.as_deref());
    insert_opt(&mut params, "since", args.since.as_deref());

    let mut value: Value = client
        .rpc("fuz_forge_repo_list", Value::Object(params))
        .await?;

    // Apply the client-side --limit to the raw `repos` array in place, so
    // `--json` stays a lossless echo of the wire shape (parity with the other
    // repo `--json` paths). Deserializing for the human render sees the limit.
    if let Some(n) = args.limit
        && let Some(arr) = value.get_mut("repos").and_then(Value::as_array_mut)
    {
        arr.truncate(n);
    }

    if args.json {
        print_json(&value)?;
        return Ok(());
    }

    let repos = typed::<RepoListOutput>(value)?.repos;
    if repos.is_empty() {
        println!("No repos.");
        return Ok(());
    }

    println!("{:<40} {:<14} {:<12} LAST PUSH", "SLUG", "BRANCH", "HEAD");
    for repo in &repos {
        let slug = fit_column(&repo.slug, 40);
        let branch = fit_column(&repo.default_branch, 14);
        let head = repo.head_sha.as_deref().map_or_else(
            || format!("{DASH:<12}"),
            |s| format!("{:<12}", short(s, SHORT_HASH_LEN)),
        );
        let last = repo.last_pushed_at.as_deref().unwrap_or("never");
        println!("{slug} {branch} {head} {last}");
    }
    let n = repos.len();
    println!("\n{n} repo{}", if n == 1 { "" } else { "s" });
    Ok(())
}

async fn cmd_create(args: CreateRepo) -> Result<(), CliError> {
    let slug = parse_slug(&args.slug)?;
    let client = ForgeClient::connect()?;

    let mut params = Map::new();
    params.insert("slug".to_string(), json!(slug));
    insert_opt(
        &mut params,
        "default_branch",
        args.default_branch.as_deref(),
    );
    insert_opt(&mut params, "seed_from", args.seed_from.as_deref());

    let value: Value = client
        .rpc("fuz_forge_repo_create", Value::Object(params))
        .await?;
    if args.json {
        print_json(&value)?;
        return Ok(());
    }
    let repo = typed::<RepoEnvelope>(value)?.repo;
    render_kv_block(&[
        ("id", repo.id),
        ("slug", repo.slug),
        ("name", repo.name),
        ("default_branch", repo.default_branch),
        (
            "seed_from",
            repo.seed_from.unwrap_or_else(|| DASH.to_string()),
        ),
        (
            "seed_completed_at",
            format_ts(repo.seed_completed_at.as_deref()),
        ),
        ("created_at", format_ts(Some(&repo.created_at))),
    ]);
    Ok(())
}

/// Open `url` in the platform browser, falling back to printing it when the
/// opener can't be spawned or exits non-zero. The opener is a compile-time
/// choice (`open` on macOS, `xdg-open` elsewhere) rather than an env-var guess,
/// which misclassified macOS sessions that happened to set `DISPLAY`.
fn open_in_browser(url: &str) {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    if !Command::new(opener)
        .arg(url)
        .status()
        .is_ok_and(|s| s.success())
    {
        println!("{url}");
    }
}

async fn cmd_view(args: ViewRepo) -> Result<(), CliError> {
    let lookup = resolve_repo_id_or_slug(&args.id_or_slug)?;
    let client = ForgeClient::connect()?;

    let value: Value = client
        .rpc("fuz_forge_repo_get", lookup_params(&lookup))
        .await?;
    let repo = typed::<RepoEnvelope>(value.clone())?.repo;

    if args.web {
        let url = format!("{}/admin/repos/{}", client.base_url(), repo.id);
        open_in_browser(&url);
        return Ok(());
    }

    if args.json {
        print_json(&value)?;
        return Ok(());
    }

    let last_pushed_by = match (&repo.last_pushed_by, &repo.last_push_username) {
        (Some(id), Some(user)) => format!("{id} ({user})"),
        (Some(id), None) => id.clone(),
        _ => DASH.to_string(),
    };
    render_kv_block(&[
        ("id", repo.id),
        ("slug", repo.slug),
        ("default_branch", repo.default_branch),
        ("head_sha", format_sha_paren(repo.head_sha.as_deref())),
        ("last_pushed_at", format_ts(repo.last_pushed_at.as_deref())),
        ("last_pushed_by", last_pushed_by),
        (
            "seed_from",
            repo.seed_from.unwrap_or_else(|| DASH.to_string()),
        ),
        (
            "seed_completed_at",
            format_ts(repo.seed_completed_at.as_deref()),
        ),
        ("created_at", format_ts(Some(&repo.created_at))),
        ("updated_at", format_ts(Some(&repo.updated_at))),
    ]);
    Ok(())
}

async fn cmd_clone(args: CloneRepo) -> Result<(), CliError> {
    if args.with_auth && !args.exec {
        // A printed credential lands in scrollback, pipes and logs, and a
        // pasted one in git's argv and `.git/config`, so the token is only
        // ever handed to a `git` this process runs.
        return Err(CliError::Usage(
            "--with-auth needs --exec: the token is handed to git through its environment, \
             never printed. Without --exec, clone the printed URL and give your username \
             and API token when git asks"
                .to_owned(),
        ));
    }
    let lookup = resolve_repo_id_or_slug(&args.id_or_slug)?;
    let client = ForgeClient::connect()?;

    let value: Value = client
        .rpc("fuz_forge_repo_get", lookup_params(&lookup))
        .await?;
    let repo = typed::<RepoEnvelope>(value)?.repo;

    let bare_url = format!("{}/{}.git", client.base_url(), repo.slug);
    if !args.exec {
        println!("{bare_url}");
        return Ok(());
    }
    let auth_env = if args.with_auth {
        let username = client.account_username().await?;
        let existing_count = std::env::var("GIT_CONFIG_COUNT").ok();
        clone_auth_env(
            existing_count.as_deref(),
            &bare_url,
            &username,
            client.token(),
        )
        .map_err(CliError::Usage)?
    } else {
        Vec::new()
    };
    let status = git_clone_command(&bare_url, &auth_env).status();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(CliError::Command(format!(
            "git clone exited with status {}",
            s.code().unwrap_or(1)
        ))),
        Err(e) => Err(ClientError::Io(e).into()),
    }
}

/// `git clone <url>` with `env` added to the inherited environment. The URL is
/// the bare one: a credential never reaches git's argv (readable by every
/// local user through `/proc/<pid>/cmdline`) or the clone's `.git/config`.
fn git_clone_command(url: &str, env: &[(String, String)]) -> Command {
    let mut command = Command::new("git");
    command
        .args(["clone", url])
        .envs(env.iter().map(|(k, v)| (k, v)));
    command
}

/// The environment that authenticates one `git clone` of `url`: git's
/// `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` one-shot
/// config, setting `http.<url>.extraHeader` to an `Authorization: Basic`
/// header — `<username>:<token>`, the token as the password, which is what the
/// forge's git smart-HTTP auth reads — and `http.<url>.followRedirects` to
/// `false`.
///
/// One-shot config applies to that one process tree and is never written to
/// the clone's `.git/config`. The URL-scoped key keeps the header off any
/// other remote, but git matches it once, against the URL it was given: after
/// following a redirect git re-bases the clone on the target and keeps adding
/// the header itself, so a redirect would hand the token to wherever it
/// points. Refusing redirects for the URL closes that — a redirecting forge
/// URL fails the clone instead, and the caller uses the final URL. The
/// environment of a running `git` is readable only by its own user (and root),
/// unlike its argv. An inherited `GIT_CONFIG_COUNT` is extended rather than
/// replaced, so the caller's own one-shot config still applies.
///
/// # Errors
///
/// Returns a usage message when the inherited `GIT_CONFIG_COUNT` is not a
/// count — git itself would refuse to run under it.
fn clone_auth_env(
    existing_count: Option<&str>,
    url: &str,
    username: &str,
    token: &str,
) -> Result<Vec<(String, String)>, String> {
    let index = match existing_count {
        None => 0,
        Some(raw) => raw
            .trim()
            .parse::<usize>()
            .map_err(|_| format!("GIT_CONFIG_COUNT is set to {raw:?}, which is not a count"))?,
    };
    let credentials = BASE64_STANDARD.encode(format!("{username}:{token}"));
    Ok(vec![
        ("GIT_CONFIG_COUNT".to_owned(), (index + 2).to_string()),
        (
            format!("GIT_CONFIG_KEY_{index}"),
            format!("http.{url}.extraHeader"),
        ),
        (
            format!("GIT_CONFIG_VALUE_{index}"),
            format!("Authorization: Basic {credentials}"),
        ),
        (
            format!("GIT_CONFIG_KEY_{}", index + 1),
            format!("http.{url}.followRedirects"),
        ),
        (
            format!("GIT_CONFIG_VALUE_{}", index + 1),
            "false".to_owned(),
        ),
    ])
}

async fn cmd_log(args: LogRepo) -> Result<(), CliError> {
    let client = ForgeClient::connect()?;
    let id = client.resolve_repo_id(&args.id_or_slug).await?;

    let mut params = Map::new();
    params.insert("id".to_string(), json!(id));
    params.insert("limit".to_string(), json!(args.limit));
    insert_opt(&mut params, "ref", args.r#ref.as_deref());
    insert_opt(&mut params, "author", args.author.as_deref());
    insert_opt(&mut params, "since", args.since.as_deref());
    insert_opt(&mut params, "path", args.path.as_deref());
    insert_opt(&mut params, "cursor", args.cursor.as_deref());

    let value: Value = client
        .rpc("fuz_forge_repo_log", Value::Object(params))
        .await?;
    if args.json {
        print_json(&value)?;
        return Ok(());
    }

    let out: RepoLogOutput = typed(value)?;
    if out.commits.is_empty() {
        println!("No commits.");
        return Ok(());
    }
    println!("log of {}", out.ref_name);
    println!();
    for commit in &out.commits {
        println!("  {}  {}", commit.short_sha, commit.subject);
        println!("         {} · {}", commit.author_name, commit.author_date);
    }
    if let Some(cursor) = &out.next_cursor {
        println!("\n--cursor {} for next page", short(cursor, SHORT_HASH_LEN));
    }
    Ok(())
}

async fn cmd_show(args: ShowRepo) -> Result<(), CliError> {
    let client = ForgeClient::connect()?;
    let id = client.resolve_repo_id(&args.id_or_slug).await?;

    let value: Value = client
        .rpc("fuz_forge_repo_commit", json!({"id": id, "sha": args.sha}))
        .await?;
    if args.json {
        print_json(&value)?;
        return Ok(());
    }

    let out: RepoCommitOutput = typed(value)?;
    let c = &out.commit;
    println!("commit {}", c.sha);
    if !c.parents.is_empty() {
        println!("Parents: {}", c.parents.join(" "));
    }
    println!(
        "Author:    {} <{}>  {}",
        c.author_name, c.author_email, c.author_date
    );
    if c.committer_name != c.author_name
        || c.committer_email != c.author_email
        || c.committer_date != c.author_date
    {
        println!(
            "Committer: {} <{}>  {}",
            c.committer_name, c.committer_email, c.committer_date
        );
    }
    println!();
    println!("    {}", c.subject);
    if !c.body.is_empty() {
        println!();
        for line in c.body.split('\n') {
            println!("    {line}");
        }
    }
    println!();
    if out.diff.truncated {
        println!(
            "(diff exceeded the size limit — fetch with `git show {}`)",
            c.sha
        );
    } else {
        println!("{}", out.diff.text);
    }
    Ok(())
}

async fn cmd_refs(args: RefsRepo) -> Result<(), CliError> {
    let client = ForgeClient::connect()?;
    let id = client.resolve_repo_id(&args.id_or_slug).await?;

    let value: Value = client.rpc("fuz_forge_repo_refs", json!({"id": id})).await?;
    if args.json {
        print_json(&value)?;
        return Ok(());
    }

    let out: RepoRefsOutput = typed(value)?;
    let mut branches = Vec::new();
    let mut tags = Vec::new();
    for r in &out.refs {
        if r.name.starts_with("refs/heads/") {
            branches.push(r);
        } else if r.name.starts_with("refs/tags/") {
            tags.push(r);
        }
    }

    let render_ref = |short_name: &str, sha: &str, date: &str, is_default: bool| {
        let default_chip = if is_default { " (default)" } else { "" };
        let date_part = if date.is_empty() {
            String::new()
        } else {
            format!("  {date}")
        };
        println!(
            "  {}  {short_name}{default_chip}{date_part}",
            short(sha, SHORT_HASH_LEN)
        );
    };

    if !branches.is_empty() {
        println!("BRANCHES");
        for b in &branches {
            let short_name = b.name.strip_prefix("refs/heads/").unwrap_or(&b.name);
            render_ref(
                short_name,
                &b.sha,
                &b.committer_date,
                short_name == out.default_branch,
            );
        }
    }
    if !tags.is_empty() {
        if !branches.is_empty() {
            println!();
        }
        println!("TAGS");
        for t in &tags {
            let short_name = t.name.strip_prefix("refs/tags/").unwrap_or(&t.name);
            render_ref(short_name, &t.sha, &t.committer_date, false);
        }
    }
    if branches.is_empty() && tags.is_empty() {
        println!("No refs.");
    }
    Ok(())
}

async fn cmd_resync(args: ResyncRepo) -> Result<(), CliError> {
    let lookup = resolve_repo_id_or_slug(&args.id_or_slug)?;
    let client = ForgeClient::connect()?;

    if !args.yes {
        println!(
            "Resync {} — re-read on-disk default-branch tip and update cell.head_sha.",
            args.id_or_slug
        );
        println!("Run with --yes to confirm.");
        return Err(CliError::Declined);
    }

    let value: Value = client
        .rpc("fuz_forge_repo_resync", lookup_params(&lookup))
        .await?;
    if args.json {
        print_json(&value)?;
        return Ok(());
    }

    let out: RepoResyncOutput = typed(value)?;
    let change = match (&out.previous_head_sha, &out.head_sha) {
        (prev, head) if prev == head => "unchanged",
        (_, None) => "now empty",
        (None, Some(_)) => "initialized",
        _ => "advanced",
    };
    render_kv_block(&[
        (
            "previous_head_sha",
            format_sha_paren(out.previous_head_sha.as_deref()),
        ),
        ("head_sha", format_sha_paren(out.head_sha.as_deref())),
        ("change", change.to_string()),
    ]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "http://127.0.0.1:4041/org/repo.git";
    const TOKEN: &str = "secret_fuz_token_abc";

    #[test]
    fn clone_auth_env_sets_a_url_scoped_basic_header_and_refuses_redirects() {
        let env = clone_auth_env(None, URL, "alice", TOKEN).expect("env");
        assert_eq!(
            env,
            vec![
                ("GIT_CONFIG_COUNT".to_owned(), "2".to_owned()),
                (
                    "GIT_CONFIG_KEY_0".to_owned(),
                    format!("http.{URL}.extraHeader")
                ),
                (
                    "GIT_CONFIG_VALUE_0".to_owned(),
                    format!(
                        "Authorization: Basic {}",
                        BASE64_STANDARD.encode(format!("alice:{TOKEN}"))
                    )
                ),
                (
                    "GIT_CONFIG_KEY_1".to_owned(),
                    format!("http.{URL}.followRedirects")
                ),
                ("GIT_CONFIG_VALUE_1".to_owned(), "false".to_owned()),
            ]
        );
    }

    #[test]
    fn clone_auth_env_extends_an_inherited_count() {
        let env = clone_auth_env(Some("2"), URL, "alice", TOKEN).expect("env");
        assert_eq!(env[0], ("GIT_CONFIG_COUNT".to_owned(), "4".to_owned()));
        assert_eq!(env[1].0, "GIT_CONFIG_KEY_2");
        assert_eq!(env[2].0, "GIT_CONFIG_VALUE_2");
        assert_eq!(env[3].0, "GIT_CONFIG_KEY_3");
        assert_eq!(env[4].0, "GIT_CONFIG_VALUE_3");
        assert!(clone_auth_env(Some("two"), URL, "alice", TOKEN).is_err());
    }

    #[test]
    fn git_clone_command_keeps_the_token_out_of_argv() {
        let env = clone_auth_env(None, URL, "alice", TOKEN).expect("env");
        let command = git_clone_command(URL, &env);
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, ["clone", URL]);
        let encoded = BASE64_STANDARD.encode(format!("alice:{TOKEN}"));
        for arg in &args {
            assert!(!arg.contains(TOKEN) && !arg.contains(&encoded), "{arg}");
        }
        let header = command
            .get_envs()
            .find(|(k, _)| *k == "GIT_CONFIG_VALUE_0")
            .and_then(|(_, v)| v)
            .expect("the header rides the env");
        assert!(header.to_string_lossy().contains(&encoded));
    }

    /// A scratch directory under the system temp dir, removed on drop (the
    /// workspace deliberately doesn't dep `tempfile`).
    struct ScratchDir(std::path::PathBuf);

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn git(cwd: &std::path::Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .status()
            .expect("spawn git (this test needs `git` on PATH)");
        assert!(status.success(), "git {args:?} failed");
    }

    /// Serve `bare` over git's dumb HTTP transport at `/org/repo.git/`,
    /// answering 401 to any request without `expected_auth` (`None` serves
    /// anyone). Returns the port and every `Authorization` value seen (empty
    /// string for none).
    fn serve_dumb_repo(
        bare: std::path::PathBuf,
        expected_auth: Option<String>,
    ) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{BufRead as _, BufReader, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let record = std::sync::Arc::clone(&seen);
        // Detached: the accept loop ends with the test process.
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                let mut auth = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':')
                        && name.eq_ignore_ascii_case("authorization")
                    {
                        value.trim().clone_into(&mut auth);
                    }
                }
                record.lock().expect("lock").push(auth.clone());
                let path = request_line.split(' ').nth(1).unwrap_or("/");
                let path = path.split('?').next().unwrap_or("/");
                let authorized = expected_auth.as_ref().is_none_or(|e| *e == auth);
                let body = if authorized {
                    path.strip_prefix("/org/repo.git/")
                        .and_then(|rel| std::fs::read(bare.join(rel)).ok())
                } else {
                    None
                };
                let head = match (&body, authorized) {
                    (Some(b), _) => format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n", b.len()),
                    (None, true) => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n".to_owned(),
                    (None, false) => "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"t\"\r\nContent-Length: 0\r\n".to_owned(),
                };
                let _ = stream.write_all(format!("{head}Connection: close\r\n\r\n").as_bytes());
                if let Some(b) = body {
                    let _ = stream.write_all(&b);
                }
            }
        });
        (port, seen)
    }

    /// A scratch dir holding `bare.git`, a one-commit bare repo prepared for
    /// git's dumb HTTP transport.
    fn seed_bare_repo(prefix: &str) -> (ScratchDir, std::path::PathBuf) {
        let scratch = ScratchDir(std::env::temp_dir().join(format!(
            "{prefix}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        )));
        let work = scratch.0.join("work");
        std::fs::create_dir_all(&work).expect("mkdir");
        git(&work, &["init", "-q", "-b", "main"]);
        git(&work, &["commit", "-q", "--allow-empty", "-m", "seed"]);
        git(&scratch.0, &["clone", "-q", "--bare", "work", "bare.git"]);
        let bare = scratch.0.join("bare.git");
        git(&bare, &["update-server-info"]);
        (scratch, bare)
    }

    /// The `--with-auth --exec` clone of `url` into `scratch`, isolated from
    /// the user's and system git config and never prompting.
    fn run_auth_clone(scratch: &ScratchDir, url: &str) -> Command {
        let env = clone_auth_env(None, url, "alice", TOKEN).expect("env");
        let mut command = git_clone_command(url, &env);
        command
            .current_dir(&scratch.0)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0");
        command
    }

    /// Answer every request with a 302 to the same path on `target_port`.
    fn serve_redirect(target_port: u16) -> u16 {
        use std::io::{BufRead as _, BufReader, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        // Detached: the accept loop ends with the test process.
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let path = request_line.split(' ').nth(1).unwrap_or("/");
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target_port}{path}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                );
            }
        });
        port
    }

    /// The real thing, against a real `git`: the clone authenticates from the
    /// env-borne header alone (the server refuses every request without it),
    /// and the token lands in neither the clone's `.git/config` nor its argv.
    #[test]
    fn with_auth_clones_through_the_header_and_persists_nothing() {
        let (scratch, bare) = seed_bare_repo("fuzf_clone_auth");
        let encoded = BASE64_STANDARD.encode(format!("alice:{TOKEN}"));
        let (port, seen) = serve_dumb_repo(bare, Some(format!("Basic {encoded}")));
        let url = format!("http://127.0.0.1:{port}/org/repo.git");
        let status = run_auth_clone(&scratch, &url)
            .status()
            .expect("spawn git clone");
        assert!(status.success(), "the authenticated clone failed");

        let seen = seen.lock().expect("lock");
        assert!(!seen.is_empty());
        assert!(
            seen.iter().all(|a| *a == format!("Basic {encoded}")),
            "every request carried the header: {seen:?}"
        );
        let config = std::fs::read_to_string(scratch.0.join("repo/.git/config")).expect("config");
        assert!(config.contains(&url), "origin is the bare URL");
        assert!(
            !config.contains(TOKEN) && !config.contains(&encoded),
            "nothing persisted: {config}"
        );
    }

    /// git matches `http.<url>.extraHeader` once, against the URL it was
    /// given. Following a redirect, curl drops the header from the redirected
    /// request itself, but once that succeeds git re-bases the clone on the
    /// target and adds the header to every later request — so the forge URL's
    /// redirect must fail the clone rather than hand the token to the target
    /// (here a different port serving the same repo to anyone).
    #[test]
    fn with_auth_refuses_a_redirect_and_the_target_never_sees_the_token() {
        let (scratch, bare) = seed_bare_repo("fuzf_clone_auth_redirect");
        let (target_port, seen) = serve_dumb_repo(bare, None);
        let origin_port = serve_redirect(target_port);
        let url = format!("http://127.0.0.1:{origin_port}/org/repo.git");
        let output = run_auth_clone(&scratch, &url)
            .output()
            .expect("spawn git clone");
        assert!(!output.status.success(), "the redirected clone must fail");
        let seen = seen.lock().expect("lock");
        assert!(
            seen.iter().all(String::is_empty),
            "the redirect target saw a credential: {seen:?}"
        );
    }
}
