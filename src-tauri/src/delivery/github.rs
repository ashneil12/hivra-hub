//! The GitHub side of delivery, as one seam: the real `gh` signed in as the user, or a stand-in in tests.
//!
//! Reads go through `pr_watch`'s one GraphQL read (checks with which are required, mergeability, head). Writes are plain
//! `gh` commands: `pr create`, `pr merge`, `run view --log-failed`. A dev copy may point `MONOCODE_PR_WATCH_GH` at a
//! stand-in, exactly as the PR watch does; the daily app never reads it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::pr_watch::bounded;
use crate::pr_watch::github::{self as pr_github, CliGh, PrRead, ReadError};

pub trait Github: Send + Sync {
    /// One read of a pull request: its state, head, checks and mergeability.
    fn read_pr(&self, repo: &str, number: u64) -> Result<PrRead, String>;
    /// `gh <args>` in `dir` (or wherever), its stdout on success, its error in words otherwise.
    fn run(&self, dir: Option<&Path>, args: &[String]) -> Result<String, String>;
}

pub struct CliGithub;

const GH_TIMEOUT: Duration = Duration::from_secs(120);

fn program() -> Option<PathBuf> {
    if crate::instance::kind() == crate::instance::Kind::Dev {
        if let Some(path) = std::env::var_os("MONOCODE_PR_WATCH_GH").filter(|p| !p.is_empty()) {
            return Some(PathBuf::from(path));
        }
    }
    crate::harness::resolve_gui_binary("gh")
}

impl Github for CliGithub {
    fn read_pr(&self, repo: &str, number: u64) -> Result<PrRead, String> {
        pr_github::read(&CliGh, repo, number).map_err(|e| match e {
            ReadError::RateLimited { .. } => {
                "GitHub's rate limit is used up for now; try again after it resets.".to_string()
            }
            ReadError::Failed(message) => message,
        })
    }

    fn run(&self, dir: Option<&Path>, args: &[String]) -> Result<String, String> {
        let program = program().ok_or_else(|| {
            "GitHub CLI (`gh`) is not installed, so Hivra can't open or merge pull requests."
                .to_string()
        })?;
        let mut command = super::child(program);
        command
            .args(args)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_PAGER", "cat")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("NO_COLOR", "1");
        if let Some(dir) = dir {
            command.current_dir(dir);
        }
        crate::harness::apply_gui_env(&mut command);
        let command = match delivery_gh_prefix() {
            Ok(prefix) => crate::agent_sandbox::under_wrap(command, prefix.as_deref()),
            Err(_) => std::process::Command::new("/nonexistent/monocode-sandbox-refused"),
        };
        let ran = bounded::run(command, GH_TIMEOUT).map_err(|failed| match failed {
            bounded::Failed::NotFound => {
                "GitHub CLI (`gh`) is not installed, so Hivra can't open or merge pull requests."
                    .to_string()
            }
            bounded::Failed::TimedOut => {
                format!("gh didn't answer within {}", bounded::words(GH_TIMEOUT))
            }
            bounded::Failed::Other(error) => error,
        })?;
        if ran.status.success() {
            return Ok(ran.stdout);
        }
        let detail = if ran.stderr.trim().is_empty() {
            ran.stdout
        } else {
            ran.stderr
        };
        Err(detail.trim().chars().take(600).collect())
    }
}

/// Prefix for delivery's `gh`, or nothing when the sandbox is off.
/// Unit tests stay plain. A profile that cannot be built refuses the start.
fn delivery_gh_prefix() -> Result<Option<Vec<std::ffi::OsString>>, String> {
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

/// Whether `gh` is signed in to github.com (`gh auth status` exits 0).
pub fn signed_in(gh: &dyn Github) -> bool {
    gh.run(
        None,
        &[
            "auth".into(),
            "status".into(),
            "--hostname".into(),
            "github.com".into(),
        ],
    )
    .is_ok()
}

#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::sync::Mutex;

    /// A stand-in for `gh`: pull request reads come from `reads` (the last one repeats), `pr create` answers with
    /// `created`, and every command is kept in `runs`. `fail` makes commands starting with that word fail.
    pub struct FakeGithub {
        pub reads: Mutex<Vec<PrRead>>,
        pub runs: Mutex<Vec<Vec<String>>>,
        /// The body file of each `pr create`, read while it existed.
        pub bodies: Mutex<Vec<String>>,
        pub created: String,
        pub signed_in: bool,
        pub fail: Mutex<Vec<String>>,
        pub failed_log: String,
        /// `gh api <path>` answers (WP-202): the first key the path contains answers, every time.
        /// A `--jq` call is not one of these. That call is the changed-file list, and a compare body is JSON.
        pub apis: Vec<(String, String)>,
        /// `gh api --jq` answer for the changed-file list. None falls through to an empty success.
        pub files: Mutex<Option<Result<String, String>>>,
    }

    impl FakeGithub {
        pub fn new(mut reads: Vec<PrRead>) -> Self {
            // A pull request with one harmless changed file, unless a test sets its own list: the security gate and
            // the floor refuse to merge a list they cannot read.
            for read in &mut reads {
                read.changed_files.get_or_insert(1);
            }
            Self {
                reads: Mutex::new(reads),
                runs: Mutex::new(Vec::new()),
                bodies: Mutex::new(Vec::new()),
                created: "https://github.com/acme/web/pull/7\n".into(),
                signed_in: true,
                fail: Mutex::new(Vec::new()),
                failed_log: "build\tRun tests\terror: expected 2, got 3".into(),
                apis: Vec::new(),
                files: Mutex::new(Some(Ok("README.md\n".into()))),
            }
        }

        pub fn with_api(mut self, key: &str, json: &str) -> Self {
            self.apis.push((key.to_string(), json.to_string()));
            self
        }

        /// A merge-base answer for tests that never set one. Appended last, so a key registered
        /// earlier still wins. `run` does not invent this.
        pub fn steady(self) -> Self {
            self.with_api(
                "per_page=1",
                &format!(
                    r#"{{"status":"identical","ahead_by":0,"behind_by":0,"merge_base_commit":{{"sha":"{}"}},"files":[]}}"#,
                    "ba5e".repeat(10)
                ),
            )
        }

        pub fn ran(&self, first: &str, second: &str) -> Vec<Vec<String>> {
            self.runs
                .lock()
                .unwrap()
                .iter()
                .filter(|r| {
                    r.first().map(String::as_str) == Some(first)
                        && r.get(1).map(String::as_str) == Some(second)
                })
                .cloned()
                .collect()
        }
    }

    impl Github for FakeGithub {
        fn read_pr(&self, _repo: &str, _number: u64) -> Result<PrRead, String> {
            let mut reads = self.reads.lock().unwrap();
            match reads.len() {
                0 => Err("no pull request recorded".into()),
                1 => Ok(reads[0].clone()),
                _ => Ok(reads.remove(0)),
            }
        }

        fn run(&self, _dir: Option<&Path>, args: &[String]) -> Result<String, String> {
            self.runs.lock().unwrap().push(args.to_vec());
            if self
                .fail
                .lock()
                .unwrap()
                .iter()
                .any(|f| args.first() == Some(f) || args.get(1) == Some(f))
            {
                return Err(format!("gh {} failed", args.join(" ")));
            }
            if args.first().map(String::as_str) == Some("api") {
                let path = args.get(1).map(String::as_str).unwrap_or("");
                // The security gate lists files with `--jq`, which prints paths. A compare stub is JSON for the
                // base hold (its path is the same compare with a query string). The first matching key must not
                // answer the file list: the gate rejects a JSON body, and a harmless pull request would be held.
                let file_list = args.iter().any(|arg| arg == "--jq");
                let stub = if file_list {
                    None
                } else {
                    self.apis
                        .iter()
                        .find(|(key, _)| path.contains(key.as_str()))
                };
                if let Some((_, json)) = stub {
                    return Ok(json.clone());
                }
                if let Some(result) = self.files.lock().unwrap().clone() {
                    return result;
                }
            }
            match (
                args.first().map(String::as_str),
                args.get(1).map(String::as_str),
            ) {
                (Some("auth"), _) if !self.signed_in => Err("not logged in".into()),
                (Some("pr"), Some("create")) => {
                    if let Some(i) = args.iter().position(|a| a == "--body-file") {
                        let body = std::fs::read_to_string(&args[i + 1]).unwrap_or_default();
                        self.bodies.lock().unwrap().push(body);
                    }
                    Ok(self.created.clone())
                }
                (Some("run"), Some("view")) => Ok(self.failed_log.clone()),
                _ => Ok(String::new()),
            }
        }
    }
}
