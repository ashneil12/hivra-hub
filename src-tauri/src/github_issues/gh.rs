// Reads labelled issues and pull requests through `gh`. The arguments follow the Inbox
// (`formatGithubQuery` in src/features/inbox/model/githubTasks.ts, and `git_github_work_items_for`):
// `--state all`, a kind qualifier, and a label search. The search also names open and
// closed, because a search that omits the state does not return a closed issue or a
// merged pull request. Nothing here writes to GitHub.
//
// A dev copy uses `MONOCODE_PR_WATCH_GH` and never the real account. The daily app ignores it.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

use super::rules::{self, GhChoice};

const GH_TIMEOUT: Duration = Duration::from_secs(60);

/// One read asks for this many rows. GitHub's search will not return more than 1000,
/// and a page of exactly this many may still be missing a labelled item.
pub const LIST_LIMIT: usize = 1000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub number: i64,
    pub title: String,
    pub description: String,
    pub kind: String,
    pub state: String,
    pub labels: Vec<String>,
    /// GitHub login of whoever opened it. Empty when the row didn't say.
    pub author: String,
}

/// A row `gh` returned that we will not sync and will not treat as "label removed".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unread {
    pub number: Option<i64>,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ItemRead {
    Item(Snapshot),
    /// Orbit ignores an issue event whose payload is actually a pull request.
    Ignored,
    Unreadable(Unread),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PullView {
    pub number: i64,
    pub state: String,
    pub title: String,
    pub url: String,
}

pub trait IssuesGh {
    fn list(&mut self, kind: &str, repo: &str, search: &str) -> Result<String, String>;
    fn view_pr(&mut self, repo: &str, number: i64) -> Result<String, String>;
    fn view_repo(&mut self, cwd: &str) -> Result<String, String>;
    /// `gh api user` → `.login`. A failure is not a login.
    fn current_login(&mut self) -> Result<String, String>;
    /// `gh api repos/{owner}/{repo}/collaborators/{login}/permission` → `.permission`.
    fn collaborator_permission(&mut self, repo: &str, login: &str) -> Result<String, String>;
}

/// `gh issue list` / `gh pr list`, matching the Inbox's flags. `kind` is `issue` or `pr`.
pub fn list_args(kind: &str, repo: &str, search: &str) -> Vec<String> {
    let gh_kind = if kind == "pr" || kind == "pull_request" {
        "pr"
    } else {
        "issue"
    };
    let fields = if gh_kind == "pr" {
        "number,title,body,state,author,labels,mergedAt"
    } else {
        "number,title,body,state,author,labels"
    };
    vec![
        gh_kind.to_string(),
        "list".into(),
        "--state".into(),
        "all".into(),
        "--limit".into(),
        LIST_LIMIT.to_string(),
        "--repo".into(),
        repo.to_string(),
        "--json".into(),
        fields.into(),
        "--search".into(),
        search.to_string(),
    ]
}

pub fn view_pr_args(repo: &str, number: i64) -> Vec<String> {
    vec![
        "pr".into(),
        "view".into(),
        number.to_string(),
        "--repo".into(),
        repo.into(),
        "--json".into(),
        "state,mergedAt,title,url".into(),
    ]
}

/// List JSON from `gh`. One bad row is skipped; a body that isn't a list is a failed read.
pub fn parse_list(json: &str, listed_kind: &str) -> Result<Vec<ItemRead>, String> {
    let value: Value =
        serde_json::from_str(json).map_err(|_| "GitHub didn't return a list.".to_string())?;
    let Some(rows) = value.as_array() else {
        return Err("GitHub didn't return a list.".into());
    };
    let kind = if listed_kind == "pr" || listed_kind == "pull_request" {
        "pull_request"
    } else {
        "issue"
    };
    Ok(rows.iter().map(|row| read_item(row, kind)).collect())
}

fn read_item(row: &Value, kind: &str) -> ItemRead {
    // An issue list entry that is really a pull request shares the number and is ignored.
    if kind == "issue" && row.get("pull_request").is_some_and(Value::is_object) {
        return ItemRead::Ignored;
    }
    let Some(number) = row.get("number").and_then(Value::as_i64) else {
        return ItemRead::Unreadable(Unread {
            number: None,
            kind: kind.to_string(),
        });
    };
    if number <= 0 {
        return ItemRead::Unreadable(Unread {
            number: None,
            kind: kind.to_string(),
        });
    }
    let Some(labels) = row.get("labels").and_then(Value::as_array) else {
        return ItemRead::Unreadable(Unread {
            number: Some(number),
            kind: kind.to_string(),
        });
    };
    let labels = labels
        .iter()
        .filter_map(|label| label.get("name").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let title = row
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let description = row
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let state = github_state(kind, row);
    ItemRead::Item(Snapshot {
        number,
        title,
        description,
        kind: kind.to_string(),
        state,
        labels,
        author: author_of(row),
    })
}

/// `author.login`, then a string `author`, then `user.login`. Missing is empty, not unreadable.
fn author_of(row: &Value) -> String {
    login_value(row.get("author"))
        .or_else(|| login_value(row.get("user")))
        .unwrap_or_default()
}

fn login_value(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Object(_) => value
            .get("login")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

/// Pull requests: `merged` when GitHub says so (the bool, or `mergedAt`). Otherwise closed or open.
fn github_state(kind: &str, row: &Value) -> String {
    let merged = kind == "pull_request"
        && (row.get("merged").and_then(Value::as_bool) == Some(true)
            || row.get("mergedAt").is_some_and(|value| !value.is_null()));
    if merged {
        return "merged".into();
    }
    match row.get("state").and_then(Value::as_str).unwrap_or("") {
        "CLOSED" | "closed" => "closed".into(),
        "MERGED" | "merged" => {
            if kind == "pull_request" {
                "merged".into()
            } else {
                "closed".into()
            }
        }
        _ => "open".into(),
    }
}

pub fn parse_pull_view(json: &str, number: i64) -> Result<PullView, String> {
    let row: Value = serde_json::from_str(json)
        .map_err(|_| "GitHub didn't return the pull request.".to_string())?;
    let state = github_state("pull_request", &row);
    let title = row
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let url = row
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(PullView {
        number,
        state,
        title,
        url,
    })
}

pub fn parse_login(json: &str) -> Result<String, String> {
    let row: Value =
        serde_json::from_str(json).map_err(|_| "Couldn't read the GitHub login.".to_string())?;
    let login = row.get("login").and_then(Value::as_str).unwrap_or("");
    if rules::login_ok(login) {
        Ok(login.to_string())
    } else {
        Err("Couldn't read the GitHub login.".into())
    }
}

pub fn parse_permission(json: &str) -> Result<String, String> {
    let row: Value =
        serde_json::from_str(json).map_err(|_| "Couldn't read that permission.".to_string())?;
    let permission = row.get("permission").and_then(Value::as_str).unwrap_or("");
    if permission.is_empty() {
        return Err("Couldn't read that permission.".into());
    }
    Ok(permission.to_string())
}

pub fn parse_repo(json: &str) -> Result<String, String> {
    let row: Value = serde_json::from_str(json)
        .map_err(|_| "Couldn't read this project's GitHub repo.".to_string())?;
    let name = row
        .get("nameWithOwner")
        .and_then(Value::as_str)
        .ok_or_else(|| "Couldn't read this project's GitHub repo.".to_string())?;
    rules::repo_ok(name)
}

/// The installed `gh`, or a dev copy's stand-in. The environment is the delivery allow-list.
pub struct CliGh;

impl CliGh {
    fn program() -> Result<PathBuf, String> {
        let stand_in = std::env::var("MONOCODE_PR_WATCH_GH").ok();
        match rules::choose_gh(crate::instance::kind(), stand_in.as_deref()) {
            GhChoice::StandIn(path) => Ok(PathBuf::from(path)),
            GhChoice::Installed => crate::harness::resolve_gui_binary("gh")
                .ok_or_else(|| "GitHub CLI (gh) is not installed.".to_string()),
            GhChoice::DevWithoutStandIn => {
                Err("This dev copy has no gh stand-in, so it doesn't read GitHub.".into())
            }
        }
    }

    fn run(&self, cwd: Option<&str>, args: &[String]) -> Result<String, String> {
        let mut command = crate::delivery::child(Self::program()?);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        command.args(args);
        command.env("GH_PROMPT_DISABLED", "1");
        command.env("GH_PAGER", "cat");
        command.env("GIT_TERMINAL_PROMPT", "0");
        command.env("NO_COLOR", "1");
        // The issue poll runs gh in a project folder. Contain it the same way as a project action.
        let command = match issue_sandbox_prefix() {
            Ok(prefix) => crate::agent_sandbox::under_wrap(command, prefix.as_deref()),
            Err(_) => std::process::Command::new("/nonexistent/monocode-sandbox-refused"),
        };
        let ran =
            crate::pr_watch::bounded::run(command, GH_TIMEOUT).map_err(|error| match error {
                crate::pr_watch::bounded::Failed::TimedOut => {
                    "GitHub didn't answer in time.".to_string()
                }
                crate::pr_watch::bounded::Failed::NotFound => {
                    "GitHub CLI (gh) is not installed.".to_string()
                }
                crate::pr_watch::bounded::Failed::Other(text) => text,
            })?;
        if !ran.status.success() {
            let detail = ran.stderr.trim();
            if detail.is_empty() {
                return Err("GitHub didn't answer.".into());
            }
            return Err(detail.to_string());
        }
        Ok(ran.stdout)
    }
}

/// Prefix for the issue poll's `gh`, or nothing when the sandbox is off.
/// Unit tests stay plain so they never read the real data folder. A profile that cannot be built refuses the start.
fn issue_sandbox_prefix() -> Result<Option<Vec<std::ffi::OsString>>, String> {
    #[cfg(test)]
    {
        Ok(None)
    }
    #[cfg(not(test))]
    {
        let data = crate::instance::data_dir(&crate::instance::current().identifier);
        crate::agent_sandbox::action_wrap(data.as_deref(), &[])
    }
}

impl IssuesGh for CliGh {
    fn list(&mut self, kind: &str, repo: &str, search: &str) -> Result<String, String> {
        let args = list_args(kind, repo, search);
        self.run(None, &args)
    }

    fn view_pr(&mut self, repo: &str, number: i64) -> Result<String, String> {
        let args = view_pr_args(repo, number);
        self.run(None, &args)
    }

    fn view_repo(&mut self, cwd: &str) -> Result<String, String> {
        let args = vec![
            "repo".into(),
            "view".into(),
            "--json".into(),
            "nameWithOwner".into(),
        ];
        self.run(Some(cwd), &args)
    }

    fn current_login(&mut self) -> Result<String, String> {
        let json = self.run(None, &["api".into(), "user".into()])?;
        parse_login(&json)
    }

    fn collaborator_permission(&mut self, repo: &str, login: &str) -> Result<String, String> {
        let repo = rules::repo_ok(repo)?;
        if !rules::login_ok(login) {
            return Err("That login can't be checked.".into());
        }
        let path = format!("repos/{repo}/collaborators/{login}/permission");
        let json = self.run(None, &["api".into(), path])?;
        parse_permission(&json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_author_is_a_login_and_a_missing_one_is_still_an_item() {
        let with_author = serde_json::json!({
            "number": 1, "title": "T", "body": "", "state": "OPEN", "labels": [],
            "author": { "login": "Ada" }
        });
        match read_item(&with_author, "issue") {
            ItemRead::Item(item) => assert_eq!(item.author, "Ada"),
            other => panic!("{other:?}"),
        }
        let with_user = serde_json::json!({
            "number": 2, "title": "T", "body": "", "state": "OPEN", "labels": [],
            "user": { "login": "bob" }
        });
        match read_item(&with_user, "issue") {
            ItemRead::Item(item) => assert_eq!(item.author, "bob"),
            other => panic!("{other:?}"),
        }
        let as_text = serde_json::json!({
            "number": 3, "title": "T", "body": "", "state": "OPEN", "labels": [],
            "author": "cara"
        });
        match read_item(&as_text, "issue") {
            ItemRead::Item(item) => assert_eq!(item.author, "cara"),
            other => panic!("{other:?}"),
        }
        let missing = serde_json::json!({
            "number": 4, "title": "T", "state": "OPEN", "labels": []
        });
        match read_item(&missing, "issue") {
            ItemRead::Item(item) => assert_eq!(item.author, ""),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_login_or_permission_that_does_not_parse_is_a_failure() {
        assert!(parse_login(r#"{"login":"ash"}"#).is_ok());
        assert!(parse_login(r#"{"login":"../ash"}"#).is_err());
        assert!(parse_login("not json").is_err());
        assert_eq!(
            parse_permission(r#"{"permission":"write"}"#).unwrap(),
            "write"
        );
        assert!(parse_permission(r#"{}"#).is_err());
        assert!(parse_permission("not json").is_err());
    }
}
