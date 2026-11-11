//! One read of a pull request from GitHub, through the user's own `gh` (its login, its rate limit; nothing is stored
//! here). A read is one GraphQL call: the pull request, its head commit's checks (with which are required), its
//! comments, reviews and review comments, who `gh` is signed in as, and the rate limit left. A head commit with more
//! than 100 checks takes a few more calls for the rest. Reads only: nothing here writes to GitHub.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde_json::{json, Value};

use super::eval::{Check, CheckStatus, Detail, Mergeability, Remark, RemarkKind};

const CHECK_FIELDS: &str = "__typename \
  ... on CheckRun { name status conclusion detailsUrl startedAt completedAt isRequired(pullRequestNumber: $number) \
    checkSuite { workflowRun { workflow { name } } } } \
  ... on StatusContext { context state targetUrl createdAt isRequired(pullRequestNumber: $number) }";

const REMARK_FIELDS: &str = "id author { login } body createdAt lastEditedAt url";

fn pull_request_query() -> String {
    format!(
        "query($owner: String!, $name: String!, $number: Int!) {{ \
  viewer {{ login }} \
  rateLimit {{ remaining resetAt cost }} \
  repository(owner: $owner, name: $name) {{ nameWithOwner pullRequest(number: $number) {{ \
    number url title state isDraft merged mergedAt closedAt mergeCommit {{ oid }} changedFiles \
    headRefOid headRefName baseRefName baseRef {{ target {{ oid }} }} headRepository {{ nameWithOwner }} mergeable reviewDecision author {{ login }} \
    labels(first: 100) {{ nodes {{ name }} }} mergeStateStatus \
    commits(last: 1) {{ nodes {{ commit {{ oid statusCheckRollup {{ state contexts(first: 100) {{ totalCount \
      pageInfo {{ hasNextPage endCursor }} nodes {{ {CHECK_FIELDS} }} }} }} }} }} }} \
    comments(last: 50) {{ totalCount nodes {{ {REMARK_FIELDS} isMinimized }} }} \
    reviews(last: 30) {{ totalCount nodes {{ {REMARK_FIELDS} state submittedAt }} }} \
    reviewThreads(last: 30) {{ totalCount nodes {{ id path comments(last: 20) {{ totalCount \
      nodes {{ {REMARK_FIELDS} path isMinimized }} }} }} }} \
  }} }} }}"
    )
}

fn checks_page_query() -> String {
    format!(
        "query($owner: String!, $name: String!, $number: Int!, $after: String!) {{ \
  repository(owner: $owner, name: $name) {{ pullRequest(number: $number) {{ commits(last: 1) {{ nodes {{ commit {{ \
    statusCheckRollup {{ contexts(first: 100, after: $after) {{ pageInfo {{ hasNextPage endCursor }} \
      nodes {{ {CHECK_FIELDS} }} }} }} }} }} }} }} }} }}"
    )
}

/// Pages of checks after the first; a head commit with more is read as incomplete.
const MORE_CHECK_PAGES: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

/// Everything one read says.
#[derive(Clone, Debug, PartialEq)]
pub struct PrRead {
    pub repo: String,
    pub number: u64,
    pub url: String,
    pub title: String,
    pub state: PrState,
    pub draft: bool,
    pub merge_sha: Option<String>,
    pub merged_at: Option<String>,
    pub head_ref: String,
    pub base_ref: String,
    /// The base branch's current tip (`baseRef.target.oid`). `None` when GitHub shows no such branch.
    pub base_tip: Option<String>,
    /// The repository the head branch is in (`headRepository`); `None` when GitHub shows none (a deleted fork).
    pub head_repo: Option<String>,
    pub review_decision: Option<String>,
    /// GitHub's merge state (`mergeStateStatus`: BEHIND, DIRTY, CLEAN, ...). `None` when the read didn't say (WP-202).
    pub merge_state: Option<String>,
    /// The label names (the first 100). The lead tick never merges a pull request labelled security-park.
    pub labels: Vec<String>,
    pub detail: Detail,
    /// Comments, reviews and review comments, oldest first. `None` when the read could not see them all.
    pub remarks: Option<Vec<Remark>>,
    pub rate: Option<RateLimit>,
    /// How many files GitHub says this pull request changes (`changedFiles`). `None` when the read
    /// didn't say, which the merge floor treats as unread.
    pub changed_files: Option<u64>,
}

impl PrRead {
    /// Whether the head comes from outside `repo`: a fork (`Some(name)`), or a repository GitHub no longer shows
    /// (`Some(None)`). Anyone can open one, so its code is never checked out or run.
    pub fn fork(&self, repo: &str) -> Option<Option<String>> {
        let base = if self.repo.is_empty() {
            repo
        } else {
            &self.repo
        };
        match &self.head_repo {
            Some(head) if head.eq_ignore_ascii_case(base) => None,
            Some(head) => Some(Some(head.clone())),
            None => Some(None),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RateLimit {
    pub remaining: i64,
    /// Epoch ms.
    pub reset_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadError {
    /// GitHub's rate limit: wait, it isn't a failed read. `until` (epoch ms) when GitHub said.
    RateLimited { until: Option<i64> },
    /// Anything else, in the words to show: gh missing or signed out, no such pull request, the network.
    Failed(String),
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadError::RateLimited { .. } => write!(f, "GitHub's rate limit is used up for now"),
            ReadError::Failed(message) => f.write_str(message),
        }
    }
}

/// `gh api graphql`, as a seam: the real CLI, or recorded answers in tests.
pub trait Gh: Send + Sync {
    fn graphql(&self, query: &str, vars: &[(&str, String)]) -> Result<String, String>;
    /// `gh api <path>` for a REST path under `repos/` (WP-202). A seam that answers GraphQL only keeps the default, so
    /// nothing falls back to REST by accident.
    fn rest(&self, _path: &str) -> Result<String, String> {
        Err("REST reads aren't available here".into())
    }
}

/// The installed `gh`, signed in as the user. A dev copy may point `MONOCODE_PR_WATCH_GH` at a stand-in (the dev-slot
/// proof does); the daily app never reads it.
pub struct CliGh;

const GH_TIMEOUT: Duration = Duration::from_secs(60);

/// A REST path the installed `gh` may read. Under `repos/`, no spaces or flags, and no `.` or `..` segment.
/// `compare/a...b` is a real GitHub path: the three dots sit inside one segment, and that is allowed.
pub(crate) fn rest_path_allowed(path: &str) -> bool {
    path.starts_with("repos/")
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-?=&%,".contains(&b))
        && path.split('/').all(|segment| segment != "." && segment != "..")
}

impl CliGh {
    fn program() -> Option<PathBuf> {
        if crate::instance::kind() == crate::instance::Kind::Dev {
            if let Some(path) = std::env::var_os("MONOCODE_PR_WATCH_GH").filter(|p| !p.is_empty()) {
                return Some(PathBuf::from(path));
            }
        }
        crate::harness::resolve_gui_binary("gh")
    }
}

impl Gh for CliGh {
    fn rest(&self, path: &str) -> Result<String, String> {
        // A path is never a free command: under repos/, no traversal, no spaces, no flags.
        if !rest_path_allowed(path) {
            return Err("not a repository path".into());
        }
        let program = Self::program().ok_or_else(|| {
            "GitHub CLI (`gh`) is not installed, so MonoCode can't read pull requests.".to_string()
        })?;
        let mut command = Command::new(program);
        command
            .args(["api", path])
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_PAGER", "cat")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("NO_COLOR", "1");
        crate::harness::apply_gui_env(&mut command);
        run_with_timeout(command, GH_TIMEOUT)
    }

    fn graphql(&self, query: &str, vars: &[(&str, String)]) -> Result<String, String> {
        let program = Self::program().ok_or_else(|| {
            "GitHub CLI (`gh`) is not installed, so MonoCode can't read pull requests.".to_string()
        })?;
        let mut command = Command::new(program);
        command
            .args(graphql_args(query, vars))
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_PAGER", "cat")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("NO_COLOR", "1");
        crate::harness::apply_gui_env(&mut command);
        run_with_timeout(command, GH_TIMEOUT)
    }
}

/// The queries' variables that aren't `String!`: gh gets them typed (`-F`). Every other one goes raw (`-f`), so an owner
/// or repository named `123`, `true` or `null` stays a string.
const TYPED_VARS: &[&str] = &["number"];

/// `gh api graphql`'s arguments for a query and its variables.
fn graphql_args(query: &str, vars: &[(&str, String)]) -> Vec<String> {
    let mut args = vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("query={query}"),
    ];
    for (key, value) in vars {
        args.push(if TYPED_VARS.contains(key) { "-F" } else { "-f" }.into());
        args.push(format!("{key}={value}"));
    }
    args
}

/// Run `gh` to its end, or stop it after `timeout` (a hung network call must not stall every watch).
fn run_with_timeout(command: Command, timeout: Duration) -> Result<String, String> {
    let ran = super::bounded::run(command, timeout).map_err(|failed| match failed {
        super::bounded::Failed::NotFound => {
            "GitHub CLI (`gh`) is not installed, so MonoCode can't read pull requests.".to_string()
        }
        super::bounded::Failed::TimedOut => {
            format!("gh didn't answer within {}", super::bounded::words(timeout))
        }
        super::bounded::Failed::Other(error) => error,
    })?;
    if ran.status.success() {
        return Ok(ran.stdout);
    }
    // gh prints GraphQL errors on stderr; a partial answer may still carry `errors` on stdout.
    let detail = if ran.stderr.trim().is_empty() {
        ran.stdout
    } else {
        ran.stderr
    };
    Err(detail.trim().chars().take(600).collect())
}

fn rate_limited(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    (message.contains("rate limit")
        && (message.contains("exceeded") || message.contains("secondary")))
        || message.contains("abuse detection")
}

/// Split `owner/name`, checked the way GitHub names them.
pub fn split_repo(repo: &str) -> Option<(&str, &str)> {
    let (owner, name) = repo.trim().split_once('/')?;
    let ok = |part: &str, max: usize| {
        !part.is_empty()
            && part.len() <= max
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            && part != "."
            && part != ".."
    };
    (ok(owner, 39) && ok(name, 100)).then_some((owner, name))
}

/// One read: the pull request, then any further pages of checks.
pub fn read(gh: &dyn Gh, repo: &str, number: u64) -> Result<PrRead, ReadError> {
    let (owner, name) =
        split_repo(repo).ok_or_else(|| ReadError::Failed(format!("{repo} is not owner/name")))?;
    let vars = [
        ("owner", owner.to_string()),
        ("name", name.to_string()),
        ("number", number.to_string()),
    ];
    let json = match gh.graphql(&pull_request_query(), &vars) {
        Ok(json) => json,
        // WP-202: GraphQL's budget is its own. The same facts over REST keep the watch true; only when REST fails too
        // does the read pause like any rate limit.
        Err(error) if rate_limited(&error) => {
            return read_rest(gh, repo, number).map_err(|_| ReadError::RateLimited { until: None });
        }
        Err(error) => return Err(failure(&error)),
    };
    let mut read = parse(&json)?;
    let mut cursor = next_page(&json);
    let mut pages = 0;
    while let Some(after) = cursor.take() {
        if pages == MORE_CHECK_PAGES {
            break;
        }
        pages += 1;
        let mut page_vars = vars.to_vec();
        page_vars.push(("after", after));
        let page = gh
            .graphql(&checks_page_query(), &page_vars)
            .map_err(|error| failure(&error))?;
        let value: Value =
            serde_json::from_str(&page).map_err(|e| ReadError::Failed(e.to_string()))?;
        let contexts = rollup(&value).and_then(|r| r.get("contexts"));
        let more = contexts
            .and_then(|c| c.get("nodes"))
            .and_then(Value::as_array)
            .map(|nodes| nodes.iter().filter_map(check_of).collect::<Vec<_>>())
            .unwrap_or_default();
        read.detail.checks = dedupe(
            read.detail
                .checks
                .drain(..)
                .map(|c| (c, None))
                .chain(more)
                .collect(),
        );
        cursor = contexts.and_then(page_cursor);
    }
    Ok(read)
}

/// The same facts as the GraphQL read, over REST (WP-202). REST can't say which checks are required, so every check
/// counts; it reads no comments or reviews, so `remarks` is None and nothing is told as new. The base is main's branch
/// tip (`repos/{r}/branches/{base}`), never the pull request's recorded base; without it the base is None, which holds
/// a merge rather than passing one.
fn read_rest(gh: &dyn Gh, repo: &str, number: u64) -> Result<PrRead, String> {
    let (owner, name) = split_repo(repo).ok_or_else(|| format!("{repo} is not owner/name"))?;
    let pr = rest_json(gh, &format!("repos/{owner}/{name}/pulls/{number}"))?;
    let head_sha = pr
        .pointer("/head/sha")
        .and_then(Value::as_str)
        .map(str::to_string);
    let base_ref = pr
        .pointer("/base/ref")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let branch_tip = rest_json(gh, &format!("repos/{owner}/{name}/branches/{base_ref}"))
        .ok()
        .and_then(|branch| {
            branch
                .pointer("/commit/sha")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let get = |path: &str| gh.rest(path);
    let mut checks: Vec<(Check, Option<i64>)> = Vec::new();
    if let Some(sha) = head_sha.as_deref() {
        let runs = rest_pages(
            &get,
            &format!("repos/{owner}/{name}/commits/{sha}/check-runs"),
            "check_runs",
        )?;
        for run in &runs.items {
            let node = json!({
                "name": run.get("name"),
                "status": run.get("status"),
                "conclusion": run.get("conclusion"),
                "detailsUrl": run.get("html_url"),
                "startedAt": run.get("started_at"),
                "completedAt": run.get("completed_at"),
            });
            checks.extend(check_of(&node));
        }
        let statuses = rest_pages(
            &get,
            &format!("repos/{owner}/{name}/commits/{sha}/status"),
            "statuses",
        )?;
        for status in &statuses.items {
            let node = json!({
                "context": status.get("context"),
                "state": status.get("state"),
                "targetUrl": status.get("target_url"),
                "createdAt": status.get("created_at"),
            });
            checks.extend(check_of(&node));
        }
        // The combined state is GitHub's own word for all the statuses. If it says failure or pending and no listed
        // status agrees (a status past the listed pages), the check says so: a red or unfinished commit is never green.
        let total = statuses
            .first
            .get("total_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let combined = statuses
            .first
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("");
        if total > 0 {
            let listed_failed = checks.iter().any(|(c, _)| c.status.failed());
            let listed_pending = checks.iter().any(|(c, _)| c.status == CheckStatus::Pending);
            if matches!(combined, "failure" | "error") && !listed_failed {
                checks.push((
                    Check {
                        name: "combined commit status".into(),
                        status: CheckStatus::Failure,
                        url: None,
                        required: false,
                    },
                    None,
                ));
            }
            if combined == "pending" && !listed_pending {
                checks.push((
                    Check {
                        name: "combined commit status".into(),
                        status: CheckStatus::Pending,
                        url: None,
                        required: false,
                    },
                    None,
                ));
            }
        }
    }
    let merged = pr.get("merged").and_then(Value::as_bool) == Some(true);
    let state = if pr.get("state").and_then(Value::as_str) == Some("open") {
        PrState::Open
    } else if merged {
        PrState::Merged
    } else {
        PrState::Closed
    };
    let mergeability = match pr.get("mergeable").and_then(Value::as_bool) {
        Some(true) => Mergeability::Mergeable,
        Some(false) => Mergeability::Conflicting,
        None => Mergeability::Unknown,
    };
    Ok(PrRead {
        repo: format!("{owner}/{name}"),
        number,
        url: text(&pr, "html_url").unwrap_or_default(),
        title: text(&pr, "title").unwrap_or_default(),
        state,
        draft: pr.get("draft").and_then(Value::as_bool) == Some(true),
        merge_sha: if merged {
            text(&pr, "merge_commit_sha")
        } else {
            None
        },
        merged_at: text(&pr, "merged_at"),
        head_ref: pr
            .pointer("/head/ref")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        base_ref,
        base_tip: branch_tip,
        head_repo: pr
            .pointer("/head/repo/full_name")
            .and_then(Value::as_str)
            .map(str::to_string),
        review_decision: None,
        labels: items(&pr, "labels")
            .iter()
            .filter_map(|label| text(label, "name"))
            .collect(),
        detail: Detail {
            head_sha,
            checks: dedupe(checks),
            mergeability,
            viewer: None,
            author: pr
                .pointer("/user/login")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        merge_state: text(&pr, "mergeable_state").map(|state| state.to_ascii_uppercase()),
        changed_files: None,
        remarks: None,
        rate: None,
    })
}

/// Every item of a paged REST list, and the first page's object (for its counts and state). A list GitHub says is
/// longer than what came back is an error: the caller holds rather than judge a partial list.
pub struct Paged {
    pub items: Vec<Value>,
    pub first: Value,
}

const PER_PAGE: usize = 100;
const MAX_PAGES: usize = 10;

/// Read a REST list page by page (`per_page`, up to [`MAX_PAGES`]) until GitHub's `total_count` is met (WP-202 M2).
pub fn rest_pages(
    get: &dyn Fn(&str) -> Result<String, String>,
    path: &str,
    key: &str,
) -> Result<Paged, String> {
    let mut items: Vec<Value> = Vec::new();
    let mut total: Option<usize> = None;
    let mut first = Value::Null;
    let sep = if path.contains('?') { '&' } else { '?' };
    for page in 1..=MAX_PAGES {
        let json: Value = serde_json::from_str(&get(&format!(
            "{path}{sep}per_page={PER_PAGE}&page={page}"
        ))?)
        .map_err(|_| format!("GitHub's answer for {path} was not JSON"))?;
        if page == 1 {
            first = json.clone();
        }
        if total.is_none() {
            total = json
                .get("total_count")
                .and_then(Value::as_u64)
                .map(|n| n as usize);
        }
        let batch = json
            .get(key)
            .and_then(Value::as_array)
            .ok_or_else(|| format!("GitHub's answer for {path} has no {key} list"))?;
        let got = batch.len();
        items.extend(batch.iter().cloned());
        if got == 0 || total.is_some_and(|t| items.len() >= t) {
            break;
        }
    }
    match total {
        Some(t) if items.len() < t => Err(format!(
            "GitHub listed {} of {t} {key} for {path}, so the list is incomplete",
            items.len()
        )),
        None if items.len() >= PER_PAGE * MAX_PAGES => {
            Err(format!("{path} has too many {key} to read whole"))
        }
        _ => Ok(Paged { items, first }),
    }
}

fn rest_json(gh: &dyn Gh, path: &str) -> Result<Value, String> {
    let answer = gh.rest(path)?;
    serde_json::from_str(&answer).map_err(|_| format!("GitHub's answer for {path} was not JSON"))
}

fn failure(error: &str) -> ReadError {
    if rate_limited(error) {
        ReadError::RateLimited { until: None }
    } else {
        ReadError::Failed(error.to_string())
    }
}

fn rollup(value: &Value) -> Option<&Value> {
    value
        .pointer("/data/repository/pullRequest/commits/nodes/0/commit/statusCheckRollup")
        .filter(|v| !v.is_null())
}

fn page_cursor(contexts: &Value) -> Option<String> {
    let info = contexts.get("pageInfo")?;
    if info.get("hasNextPage").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    info.get("endCursor")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn next_page(json: &str) -> Option<String> {
    let value: Value = serde_json::from_str(json).ok()?;
    rollup(&value)?.get("contexts").and_then(page_cursor)
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
}

fn login(value: &Value) -> Option<String> {
    value
        .get("author")
        .and_then(|a| a.get("login"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// A check run or status context, with when it started (for telling re-runs of one name apart).
fn check_of(node: &Value) -> Option<(Check, Option<i64>)> {
    let status_context = node.get("__typename").and_then(Value::as_str) == Some("StatusContext")
        || (node.get("context").is_some() && node.get("name").is_none());
    let required = node.get("isRequired").and_then(Value::as_bool) == Some(true);
    if status_context {
        let name = text(node, "context")?;
        let status = match text(node, "state")
            .as_deref()
            .map(str::to_ascii_uppercase)
            .as_deref()
        {
            Some("SUCCESS") => CheckStatus::Success,
            Some("FAILURE") | Some("ERROR") => CheckStatus::Failure,
            _ => CheckStatus::Pending,
        };
        let at = text(node, "createdAt").map(|t| super::eval::millis(&t));
        return Some((
            Check {
                name,
                status,
                url: text(node, "targetUrl"),
                required,
            },
            at,
        ));
    }
    let job = text(node, "name")?;
    let workflow = node
        .pointer("/checkSuite/workflowRun/workflow/name")
        .and_then(Value::as_str)
        .filter(|w| !w.trim().is_empty());
    let name = match workflow {
        Some(workflow) if !job.starts_with(&format!("{workflow} / ")) => {
            format!("{workflow} / {job}")
        }
        _ => job,
    };
    let status = match text(node, "status")
        .as_deref()
        .map(str::to_ascii_uppercase)
        .as_deref()
    {
        Some("COMPLETED") | None => match text(node, "conclusion")
            .as_deref()
            .map(str::to_ascii_uppercase)
            .as_deref()
        {
            Some("SUCCESS") => CheckStatus::Success,
            Some("FAILURE") | Some("TIMED_OUT") | Some("STARTUP_FAILURE") => CheckStatus::Failure,
            Some("CANCELLED") => CheckStatus::Cancelled,
            Some("ACTION_REQUIRED") => CheckStatus::ActionRequired,
            Some("SKIPPED") => CheckStatus::Skipped,
            Some("NEUTRAL") | Some("STALE") => CheckStatus::Neutral,
            _ => CheckStatus::Pending,
        },
        _ => CheckStatus::Pending,
    };
    let at = text(node, "startedAt")
        .or_else(|| text(node, "completedAt"))
        .map(|t| super::eval::millis(&t));
    Some((
        Check {
            name,
            status,
            url: text(node, "detailsUrl"),
            required,
        },
        at,
    ))
}

/// One check per name: workflows that run on two events (or re-runs) list a name twice. The newest run wins; a name
/// required anywhere stays required.
fn dedupe(checks: Vec<(Check, Option<i64>)>) -> Vec<Check> {
    let mut out: Vec<(Check, Option<i64>)> = Vec::new();
    for (check, at) in checks {
        match out.iter_mut().find(|(c, _)| c.name == check.name) {
            Some((kept, kept_at)) => {
                let required = kept.required || check.required;
                if at.unwrap_or(0) >= kept_at.unwrap_or(0) {
                    *kept = check;
                    *kept_at = at;
                }
                kept.required = required;
            }
            None => out.push((check, at)),
        }
    }
    out.into_iter().map(|(c, _)| c).collect()
}

fn remark_of(node: &Value, kind: RemarkKind, fallback_path: Option<&str>) -> Option<Remark> {
    if node.get("isMinimized").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let id = text(node, "id")?;
    let body = node
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let created_at = if kind == RemarkKind::Review {
        text(node, "submittedAt").or_else(|| text(node, "createdAt"))?
    } else {
        text(node, "createdAt")?
    };
    let review_state = (kind == RemarkKind::Review)
        .then(|| text(node, "state"))
        .flatten();
    if kind == RemarkKind::Review {
        // A pending review isn't posted; a bare "commented" review only wraps its review comments, read on their own.
        match review_state.as_deref() {
            Some("PENDING") | None => return None,
            Some("COMMENTED") if body.trim().is_empty() => return None,
            _ => {}
        }
    }
    Some(Remark {
        id,
        kind,
        author: login(node),
        body,
        created_at,
        edited_at: text(node, "lastEditedAt"),
        url: text(node, "url"),
        path: text(node, "path").or_else(|| fallback_path.map(str::to_string)),
        review_state,
    })
}

/// A REST list (a plain array under `key`), where GraphQL wraps its lists in `nodes`.
fn items<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn nodes<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(|l| l.get("nodes"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// Parse the main read. GraphQL errors with no pull request are a failed read in GitHub's words.
pub fn parse(json: &str) -> Result<PrRead, ReadError> {
    let value: Value = serde_json::from_str(json)
        .map_err(|_| ReadError::Failed("GitHub's answer was not JSON".into()))?;
    let errors: Vec<String> = value
        .get("errors")
        .and_then(Value::as_array)
        .map(|errors| {
            errors
                .iter()
                .filter_map(|e| e.get("message").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let rate = value.pointer("/data/rateLimit").and_then(|r| {
        Some(RateLimit {
            remaining: r.get("remaining")?.as_i64()?,
            reset_at: super::eval::millis(r.get("resetAt")?.as_str()?),
        })
    });
    let Some(pr) = value
        .pointer("/data/repository/pullRequest")
        .filter(|p| !p.is_null())
    else {
        let message = errors
            .first()
            .cloned()
            .unwrap_or_else(|| "GitHub has no such pull request".into());
        if rate_limited(&message) {
            return Err(ReadError::RateLimited {
                until: rate.map(|r| r.reset_at),
            });
        }
        return Err(ReadError::Failed(message));
    };
    let repo = value
        .pointer("/data/repository/nameWithOwner")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let head_repo = pr
        .pointer("/headRepository/nameWithOwner")
        .and_then(Value::as_str)
        .map(str::to_string);
    let state = match text(pr, "state").as_deref() {
        Some("MERGED") => PrState::Merged,
        Some("CLOSED") => PrState::Closed,
        _ if pr.get("merged").and_then(Value::as_bool) == Some(true) => PrState::Merged,
        _ => PrState::Open,
    };
    let mergeability = match text(pr, "mergeable").as_deref() {
        Some("MERGEABLE") => Mergeability::Mergeable,
        Some("CONFLICTING") => Mergeability::Conflicting,
        _ => Mergeability::Unknown,
    };
    let commit = pr.pointer("/commits/nodes/0/commit");
    let head_sha = text(pr, "headRefOid").or_else(|| commit.and_then(|c| text(c, "oid")));
    let checks = commit
        .and_then(|c| c.get("statusCheckRollup"))
        .filter(|r| !r.is_null())
        .and_then(|r| r.pointer("/contexts/nodes"))
        .and_then(Value::as_array)
        .map(|nodes| dedupe(nodes.iter().filter_map(check_of).collect()))
        .unwrap_or_default();

    // The newest of each list is read (`last: N`), so a long conversation only leaves out old remarks, already told.
    let mut remarks = Vec::new();
    remarks.extend(
        nodes(pr, "comments")
            .iter()
            .filter_map(|n| remark_of(n, RemarkKind::Comment, None)),
    );
    remarks.extend(
        nodes(pr, "reviews")
            .iter()
            .filter_map(|n| remark_of(n, RemarkKind::Review, None)),
    );
    for thread in nodes(pr, "reviewThreads") {
        let path = thread.get("path").and_then(Value::as_str);
        let comments = nodes(thread, "comments");
        remarks.extend(
            comments
                .iter()
                .filter_map(|n| remark_of(n, RemarkKind::ReviewComment, path)),
        );
    }
    remarks.sort_by(|a, b| {
        super::eval::millis(&a.created_at)
            .cmp(&super::eval::millis(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(PrRead {
        repo,
        number: pr.get("number").and_then(Value::as_u64).unwrap_or(0),
        url: text(pr, "url").unwrap_or_default(),
        title: pr
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        state,
        draft: pr.get("isDraft").and_then(Value::as_bool) == Some(true),
        merge_sha: pr
            .pointer("/mergeCommit/oid")
            .and_then(Value::as_str)
            .map(str::to_string),
        merged_at: text(pr, "mergedAt"),
        head_ref: text(pr, "headRefName").unwrap_or_default(),
        base_ref: text(pr, "baseRefName").unwrap_or_default(),
        base_tip: pr
            .pointer("/baseRef/target/oid")
            .and_then(Value::as_str)
            .map(str::to_string),
        head_repo,
        review_decision: text(pr, "reviewDecision"),
        merge_state: text(pr, "mergeStateStatus"),
        labels: pr
            .pointer("/labels/nodes")
            .and_then(Value::as_array)
            .map(|nodes| {
                nodes
                    .iter()
                    .filter_map(|n| n.get("name").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        detail: Detail {
            head_sha,
            checks,
            mergeability,
            viewer: value
                .pointer("/data/viewer/login")
                .and_then(Value::as_str)
                .map(str::to_string),
            author: login(pr),
        },
        remarks: Some(remarks),
        rate,
        changed_files: pr.get("changedFiles").and_then(Value::as_u64),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A recorded read of cli/cli#14716 (20 Oct 2026, public, read-only): three required checks, all green, comments.
    pub const RECORDED_REQUIRED: &str = include_str!("fixtures/cli-cli-14716.json");
    /// A recorded read of cli/cli#14752: reviews and review threads.
    pub const RECORDED_REVIEWS: &str = include_str!("fixtures/cli-cli-14752.json");

    /// `gh`, answering from recorded JSON; every call is kept. REST paths answer from `rest`, by the first key the path
    /// contains (and keep answering: the same path can be read on every sweep).
    pub struct FakeGh {
        pub answers: Mutex<Vec<Result<String, String>>>,
        pub calls: Mutex<Vec<Vec<(String, String)>>>,
        pub rest: Vec<(String, Result<String, String>)>,
    }

    impl FakeGh {
        pub fn new(answers: Vec<Result<String, String>>) -> Self {
            Self {
                answers: Mutex::new(answers),
                calls: Mutex::new(Vec::new()),
                rest: Vec::new(),
            }
        }

        pub fn with_rest(mut self, key: &str, answer: &str) -> Self {
            self.rest.push((key.to_string(), Ok(answer.to_string())));
            self
        }
    }

    impl Gh for FakeGh {
        fn rest(&self, path: &str) -> Result<String, String> {
            if !rest_path_allowed(path) {
                return Err("not a repository path".into());
            }
            self.rest
                .iter()
                .find(|(key, _)| path.contains(key.as_str()))
                .map(|(_, answer)| answer.clone())
                .unwrap_or_else(|| Err(format!("no recorded REST answer for {path}")))
        }

        fn graphql(&self, _query: &str, vars: &[(&str, String)]) -> Result<String, String> {
            self.calls.lock().unwrap().push(
                vars.iter()
                    .map(|(k, v)| (k.to_string(), v.clone()))
                    .collect(),
            );
            let mut answers = self.answers.lock().unwrap();
            if answers.is_empty() {
                return Err("no more recorded answers".into());
            }
            answers.remove(0)
        }
    }

    #[test]
    fn a_recorded_read_gives_required_checks_comments_and_the_viewer() {
        let read = parse(RECORDED_REQUIRED).unwrap();
        assert_eq!(read.repo, "cli/cli");
        assert_eq!(read.number, 14716);
        assert_eq!(read.state, PrState::Open);
        assert_eq!(read.base_ref, "trunk");
        assert_eq!(read.detail.mergeability, Mergeability::Mergeable);
        assert_eq!(read.detail.viewer.as_deref(), Some("ashneil12"));
        assert_eq!(read.detail.author.as_deref(), Some("dependabot"));
        let required: Vec<&str> = read
            .detail
            .checks
            .iter()
            .filter(|c| c.required)
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(
            required,
            vec![
                "Unit and Integration Tests / build (ubuntu-latest)",
                "Unit and Integration Tests / build (windows-latest)",
                "Unit and Integration Tests / build (macos-latest)"
            ]
        );
        assert!(read
            .detail
            .checks
            .iter()
            .all(|c| !c.status.failed() && c.status != CheckStatus::Pending));
        // The minimized bot comment is left out.
        let remarks = read.remarks.unwrap();
        assert_eq!(remarks.len(), 2);
        assert_eq!(remarks[0].author.as_deref(), Some("williammartin"));
        assert!(read.rate.unwrap().remaining > 0);
    }

    #[test]
    fn reviews_and_review_threads_become_remarks_without_bare_comment_wrappers() {
        let read = parse(RECORDED_REVIEWS).unwrap();
        let remarks = read.remarks.unwrap();
        let reviews: Vec<&Remark> = remarks
            .iter()
            .filter(|r| r.kind == RemarkKind::Review)
            .collect();
        // Bare COMMENTED reviews (only wrapping thread comments) drop; the approval with no body stays.
        assert!(reviews
            .iter()
            .all(|r| !r.body.trim().is_empty() || r.review_state.as_deref() == Some("APPROVED")));
        assert!(reviews
            .iter()
            .any(|r| r.review_state.as_deref() == Some("APPROVED")));
        let thread = remarks
            .iter()
            .find(|r| r.kind == RemarkKind::ReviewComment)
            .unwrap();
        assert!(thread.path.is_some());
        // Oldest first.
        assert!(remarks
            .windows(2)
            .all(|w| super::super::eval::millis(&w[0].created_at)
                <= super::super::eval::millis(&w[1].created_at)));
    }

    #[test]
    fn re_runs_of_one_check_name_keep_the_newest() {
        let checks = dedupe(vec![
            (
                Check {
                    name: "build".into(),
                    status: CheckStatus::Failure,
                    url: None,
                    required: true,
                },
                Some(10),
            ),
            (
                Check {
                    name: "build".into(),
                    status: CheckStatus::Success,
                    url: None,
                    required: false,
                },
                Some(20),
            ),
        ]);
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].status, CheckStatus::Success);
        assert!(checks[0].required);
    }

    #[test]
    fn graphql_errors_and_rate_limits_read_as_such() {
        let missing = r#"{"data":{"viewer":{"login":"me"},"rateLimit":{"remaining":10,"resetAt":"2026-10-20T00:00:00Z","cost":1},"repository":null},"errors":[{"message":"Could not resolve to a Repository with the name 'o/r'."}]}"#;
        assert_eq!(
            parse(missing),
            Err(ReadError::Failed(
                "Could not resolve to a Repository with the name 'o/r'.".into()
            ))
        );
        let gh = FakeGh::new(vec![Err(
            "GraphQL: API rate limit exceeded for user ID 1.".into()
        )]);
        assert_eq!(
            read(&gh, "o/r", 1),
            Err(ReadError::RateLimited { until: None })
        );
        assert!(matches!(
            read(&gh, "not a repo", 1),
            Err(ReadError::Failed(_))
        ));
    }

    #[test]
    fn the_pull_request_labels_are_read_for_the_security_park_guard() {
        let mut json: Value = serde_json::from_str(RECORDED_REQUIRED).unwrap();
        json["data"]["repository"]["pullRequest"]["labels"] = serde_json::json!({
            "nodes": [{ "name": "security-park" }, { "name": "docs" }]
        });
        let gh = FakeGh::new(vec![Ok(json.to_string())]);
        let read = read(&gh, "cli/cli", 14716).unwrap();
        assert_eq!(
            read.labels,
            vec!["security-park".to_string(), "docs".to_string()]
        );
    }

    #[test]
    fn a_head_with_more_than_a_page_of_checks_reads_the_rest() {
        let mut first: Value = serde_json::from_str(RECORDED_REQUIRED).unwrap();
        let contexts = first
            .pointer_mut(
                "/data/repository/pullRequest/commits/nodes/0/commit/statusCheckRollup/contexts",
            )
            .unwrap();
        contexts["pageInfo"] = serde_json::json!({ "hasNextPage": true, "endCursor": "CUR1" });
        let page = serde_json::json!({ "data": { "repository": { "pullRequest": { "commits": { "nodes": [ { "commit": {
            "statusCheckRollup": { "contexts": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [
                { "__typename": "CheckRun", "name": "late-gate", "status": "COMPLETED", "conclusion": "FAILURE",
                  "detailsUrl": "https://ci.example/late", "isRequired": true, "checkSuite": null }
            ] } } } } ] } } } } });
        let gh = FakeGh::new(vec![Ok(first.to_string()), Ok(page.to_string())]);
        let read = read(&gh, "cli/cli", 14716).unwrap();
        let late = read
            .detail
            .checks
            .iter()
            .find(|c| c.name == "late-gate")
            .unwrap();
        assert!(late.required && late.status == CheckStatus::Failure);
        let calls = gh.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls[1].contains(&("after".to_string(), "CUR1".to_string())));
    }

    #[test]
    fn owner_and_name_go_to_gh_as_strings_and_only_the_number_typed() {
        // `-F` would send 123 as a number and true/null as JSON literals, and GitHub would refuse the String! variable.
        for odd in ["123", "true", "false", "null", "1e3"] {
            let args = graphql_args(
                "query",
                &[
                    ("owner", odd.to_string()),
                    ("name", odd.to_string()),
                    ("number", "7".to_string()),
                    ("after", odd.to_string()),
                ],
            );
            assert_eq!(
                args[4..],
                [
                    "-f".to_string(),
                    format!("owner={odd}"),
                    "-f".to_string(),
                    format!("name={odd}"),
                    "-F".to_string(),
                    "number=7".to_string(),
                    "-f".to_string(),
                    format!("after={odd}"),
                ],
                "{odd}"
            );
            assert_eq!(split_repo(&format!("{odd}/{odd}")), Some((odd, odd)));
        }
    }

    #[test]
    fn repo_names_are_checked() {
        assert_eq!(split_repo("ashneil12/hivra"), Some(("ashneil12", "hivra")));
        assert_eq!(split_repo("vercel/next.js"), Some(("vercel", "next.js")));
        assert_eq!(split_repo("a/b/c"), None);
        assert_eq!(split_repo("../x"), None);
        assert_eq!(split_repo("o/r; rm"), None);
    }

    const REST_PULL: &str = r#"{"number":7,"html_url":"https://github.com/acme/web/pull/7","title":"Fix the save bug",
      "state":"open","draft":false,"merged":false,"merge_commit_sha":null,"merged_at":null,"mergeable":true,
      "mergeable_state":"behind","head":{"sha":"h7h7h7h","ref":"work","repo":{"full_name":"acme/web"}},
      "base":{"ref":"main","sha":"b2b2b2b"},"labels":[{"name":"ready"}],"user":{"login":"ash"}}"#;
    const REST_RUNS: &str = r#"{"total_count":2,"check_runs":[
      {"name":"build","status":"completed","conclusion":"success","html_url":"https://github.com/acme/web/runs/1","started_at":"2026-11-01T10:00:00Z","completed_at":"2026-11-01T10:05:00Z"},
      {"name":"lint","status":"in_progress","conclusion":null,"html_url":"https://github.com/acme/web/runs/2","started_at":"2026-11-01T10:00:00Z","completed_at":null}]}"#;
    const REST_STATUS: &str = r#"{"state":"success","statuses":[]}"#;

    #[test]
    fn the_base_tip_and_merge_state_are_read_and_an_answer_without_them_blocks_nothing() {
        let old = parse(RECORDED_REQUIRED).unwrap();
        assert_eq!(
            old.base_tip, None,
            "an answer without the base reads as unknown"
        );
        assert_eq!(
            old.merge_state, None,
            "an answer without the merge state reads as unknown"
        );
        let mut value: Value = serde_json::from_str(RECORDED_REQUIRED).unwrap();
        value["data"]["repository"]["pullRequest"]["baseRef"] =
            json!({"target": {"oid": "b2b2b2b"}});
        value["data"]["repository"]["pullRequest"]["mergeStateStatus"] = json!("BEHIND");
        let read = parse(&value.to_string()).unwrap();
        assert_eq!(read.base_tip.as_deref(), Some("b2b2b2b"));
        assert_eq!(read.merge_state.as_deref(), Some("BEHIND"));
        assert_eq!(
            read.detail.checks, old.detail.checks,
            "the new fields change no check"
        );
    }

    #[test]
    fn a_graphql_rate_limit_reads_the_same_facts_over_rest() {
        let gh = FakeGh::new(vec![Err("API rate limit exceeded for user".into())])
            .with_rest("/pulls/7", REST_PULL)
            .with_rest(
                "/branches/main",
                r#"{"name":"main","commit":{"sha":"b2b2b2b"}}"#,
            )
            .with_rest("/check-runs", REST_RUNS)
            .with_rest("/status", REST_STATUS);
        let got = read(&gh, "acme/web", 7).unwrap();
        assert_eq!(got.state, PrState::Open);
        assert_eq!(got.repo, "acme/web");
        assert_eq!(got.head_ref, "work");
        assert_eq!(got.base_ref, "main");
        assert_eq!(got.base_tip.as_deref(), Some("b2b2b2b"));
        assert_eq!(got.merge_state.as_deref(), Some("BEHIND"));
        assert_eq!(got.labels, vec!["ready"]);
        assert_eq!(got.detail.head_sha.as_deref(), Some("h7h7h7h"));
        assert_eq!(got.detail.mergeability, Mergeability::Mergeable);
        assert_eq!(got.detail.author.as_deref(), Some("ash"));
        assert_eq!(
            got.remarks, None,
            "REST reads no comments: none are told as new"
        );
        let names: Vec<(&str, CheckStatus)> = got
            .detail
            .checks
            .iter()
            .map(|c| (c.name.as_str(), c.status))
            .collect();
        assert_eq!(
            names,
            vec![
                ("build", CheckStatus::Success),
                ("lint", CheckStatus::Pending)
            ]
        );
        assert!(
            got.detail.checks.iter().all(|c| !c.required),
            "REST can't say which checks are required, so every check counts"
        );
    }

    #[test]
    fn a_rest_read_that_fails_too_pauses_like_a_rate_limit() {
        let gh = FakeGh::new(vec![Err("API rate limit exceeded".into())]);
        assert_eq!(
            read(&gh, "acme/web", 7),
            Err(ReadError::RateLimited { until: None })
        );
    }

    /// r3 review HIGH: the sweep reads the base move and the behind count through paths
    /// `compare/{a}...{b}`. Those are repository paths. A segment that is `.` or `..` is not.
    /// The check is the pure function, not `CliGh::rest`: an allowed path would start `gh`.
    #[test]
    fn r3_review_the_installed_gh_lets_the_paths_the_base_reads_build_through() {
        let asked = Mutex::new(Vec::<String>::new());
        let record = |path: &str| -> Result<String, String> {
            asked.lock().unwrap().push(path.to_string());
            Err("recorded only".into())
        };
        let mut read = parse(RECORDED_REQUIRED).unwrap();
        read.base_tip = Some("b2b2b2b".into());
        assert!(read.detail.head_sha.is_some());
        let memo = crate::pr_watch::eval::Memo {
            base_sha: Some("b1b1b1b".into()),
            ..Default::default()
        };
        let _ = crate::pr_watch::base::facts(&record, "acme/web", 7, &memo, &read, false);
        let _ = crate::pr_watch::base::merge_base(&record, "acme/web", "b2b2b2b", "a1a1a1a");
        let paths = asked.into_inner().unwrap();
        assert!(paths.iter().any(|p| p.contains("/compare/")), "{paths:?}");
        for path in &paths {
            assert!(
                rest_path_allowed(path),
                "a path base.rs reads is not a repository path: {path}"
            );
        }
        assert!(!rest_path_allowed("repos/acme/web/../../user"));
        assert!(!rest_path_allowed("repos/./web/pulls/7"));
        assert!(!rest_path_allowed("user/keys"));
    }

    /// The same filter the installed `gh` uses. A compare path is allowed; a `..` segment is not.
    #[test]
    fn fake_gh_refuses_the_same_paths_the_installed_gh_refuses() {
        let gh = FakeGh::new(vec![]);
        assert_eq!(
            gh.rest("repos/acme/web/../../user"),
            Err("not a repository path".into())
        );
        assert_ne!(
            gh.rest("repos/acme/web/compare/b1b1b1b...b2b2b2b"),
            Err("not a repository path".into())
        );
    }

    #[test]
    fn rest_paths_are_limited_to_repository_paths() {
        assert!(CliGh.rest("user/keys").is_err());
        assert!(CliGh.rest("repos/acme/web/../../user").is_err());
        assert!(CliGh
            .rest("repos/acme/web/pulls/7 --method DELETE")
            .is_err());
    }

    #[test]
    fn r1_the_rest_fallback_reads_the_base_branch_tip_not_the_recorded_base() {
        let gh = FakeGh::new(vec![Err("API rate limit exceeded for user".into())])
            .with_rest("/pulls/7", REST_PULL)
            .with_rest("/check-runs", REST_RUNS)
            .with_rest("/status", REST_STATUS)
            .with_rest(
                "/branches/main",
                r#"{"name":"main","commit":{"sha":"b3b3b3b"}}"#,
            )
            .with_rest(
                "/git/ref/heads/main",
                r#"{"ref":"refs/heads/main","object":{"sha":"b3b3b3b","type":"commit"}}"#,
            );
        let got = read(&gh, "acme/web", 7).unwrap();
        assert_eq!(got.base_tip.as_deref(), Some("b3b3b3b"));
    }

    #[test]
    fn a_rest_list_is_read_page_by_page_until_githubs_total_is_met() {
        let page = |from: usize, to: usize| {
            json!({
                "total_count": 150,
                "check_runs": (from..to).map(|i| json!({ "name": format!("c{i}") })).collect::<Vec<_>>(),
            })
            .to_string()
        };
        let gh = FakeGh::new(vec![])
            .with_rest("&page=1", &page(0, 100))
            .with_rest("&page=2", &page(100, 150));
        let paged = rest_pages(
            &|p: &str| gh.rest(p),
            "repos/acme/web/commits/h/check-runs",
            "check_runs",
        )
        .unwrap();
        assert_eq!(
            paged.items.len(),
            150,
            "every page is read, not only the first 100"
        );
    }

    #[test]
    fn a_rest_list_that_stays_short_of_its_total_is_an_error_not_a_partial_answer() {
        let gh = FakeGh::new(vec![]).with_rest(
            "&page=",
            r#"{"total_count":150,"check_runs":[{"name":"c"}]}"#,
        );
        assert!(rest_pages(
            &|p: &str| gh.rest(p),
            "repos/acme/web/commits/h/check-runs",
            "check_runs"
        )
        .is_err());
    }

    #[test]
    fn a_failed_combined_status_that_no_listed_status_shows_is_not_green() {
        let gh = FakeGh::new(vec![Err("API rate limit exceeded".into())])
            .with_rest("/pulls/7", REST_PULL)
            .with_rest("/branches/main", r#"{"commit":{"sha":"b2b2b2b"}}"#)
            .with_rest("/check-runs", r#"{"total_count":0,"check_runs":[]}"#)
            .with_rest(
                "/status",
                r#"{"state":"failure","total_count":1,"statuses":[{"context":"ci/a","state":"success"}]}"#,
            );
        let got = read(&gh, "acme/web", 7).unwrap();
        assert!(
            got.detail.checks.iter().any(|c| c.status.failed()),
            "the combined state says failure: {:?}",
            got.detail.checks
        );
    }

    /// r2 check (M2 edges): exactly 100 is one page, 101 is two, and a total GitHub doesn't deliver is an error.
    #[test]
    fn r2_rest_pages_reads_the_page_edges_and_refuses_a_short_total() {
        let page = |total: usize, from: usize, to: usize| {
            json!({
                "total_count": total,
                "check_runs": (from..to).map(|i| json!({ "name": format!("c{i}") })).collect::<Vec<_>>(),
            })
            .to_string()
        };
        let path = "repos/acme/web/commits/h/check-runs";
        let gh = FakeGh::new(vec![]).with_rest("&page=1", &page(100, 0, 100));
        assert_eq!(
            rest_pages(&|p: &str| gh.rest(p), path, "check_runs")
                .unwrap()
                .items
                .len(),
            100
        );
        let gh = FakeGh::new(vec![])
            .with_rest("&page=1", &page(101, 0, 100))
            .with_rest("&page=2", &page(101, 100, 101));
        assert_eq!(
            rest_pages(&|p: &str| gh.rest(p), path, "check_runs")
                .unwrap()
                .items
                .len(),
            101
        );
        let gh = FakeGh::new(vec![])
            .with_rest("&page=1", &page(101, 0, 100))
            .with_rest("&page=2", &page(101, 0, 0));
        assert!(rest_pages(&|p: &str| gh.rest(p), path, "check_runs").is_err());
        // No total_count: read until an empty page.
        let gh = FakeGh::new(vec![])
            .with_rest("&page=1", r#"{"check_runs":[{"name":"a"}]}"#)
            .with_rest("&page=2", r#"{"check_runs":[]}"#);
        assert_eq!(
            rest_pages(&|p: &str| gh.rest(p), path, "check_runs")
                .unwrap()
                .items
                .len(),
            1
        );
    }
}
