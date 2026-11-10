//! The one merge path. Every caller (the Inbox's merge button, a first mate's `pr_merge`, a delivery) goes through
//! `merge`, which:
//!
//! 1. reads the pull request (its head, checks and mergeability) fresh from GitHub;
//! 2. refuses red or pending checks (the required ones, or every check when none is required, as the PR watch counts
//!    them), a draft, a conflict, and a closed or merged pull request;
//! 3. refuses while a decision on that work is open (a question on any task in its tree, or a WP-14
//!    decision in state open waiting on any of those tasks);
//! 4. merges with the person's word (their own tap, or an approval they gave for this exact head) or, when the project's
//!    "merge without asking" switch is on, without it, unless that project has turned the protected-path floor on and
//!    the diff touches a protected path or its file list could not be read; otherwise it asks and merges nothing;
//! 5. merges only the head it judged (`gh pr merge --match-head-commit`), and logs every attempt with who allowed it.
//!
//! A pull request with no checks at all needs the person's word even when the switch is on: no checks is not green.
//! When the project has turned the protected-path floor on (WP-158, off until then), the switch is not enough
//! for a diff that touches a protected path, or whose changed files could not be read. The person's word for
//! that exact head still merges it.
//!
//! Red is never merged (firstmate, `bin/fm-pr-merge.sh`).

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::github::Github;
use crate::delegations;
use crate::pr_watch::eval::{gate, Check, CheckStatus, Mergeability};
use crate::pr_watch::github::{split_repo, PrRead, PrState};
use crate::session_store::SessionStore;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    #[default]
    Merge,
    Squash,
    Rebase,
}

impl Method {
    /// The Inbox's pull request actions that merge.
    pub fn from_action(action: &str) -> Option<Method> {
        match action.trim() {
            "merge" => Some(Method::Merge),
            "squash" => Some(Method::Squash),
            "rebase" => Some(Method::Rebase),
            _ => None,
        }
    }

    fn flag(self) -> &'static str {
        match self {
            Method::Merge => "--merge",
            Method::Squash => "--squash",
            Method::Rebase => "--rebase",
        }
    }
}

/// Who asks for the merge.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Caller {
    /// The person, by their own tap in the app (`via` names the screen).
    Person { via: String },
    /// An agent (a first mate's chat), which never counts as the person's word.
    Agent { session: String },
}

impl Caller {
    fn label(&self) -> String {
        match self {
            Caller::Person { via } => format!("person ({via})"),
            Caller::Agent { session } => format!("agent {session}"),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    pub repo: String,
    pub number: u64,
    pub caller: Caller,
    /// The project folder, for its "merge without asking" switch. Found from the delivery when left out.
    /// An agent can't set it: its project comes only from the delivery, so it can't borrow another project's switch.
    #[serde(default)]
    pub project: Option<String>,
    /// The delegation the work came from, for its open decisions. Found from the delivery when left out.
    /// An agent can't set it either: the delivery names the delegation, so a request can't point at one with no question.
    #[serde(default)]
    pub delegation_id: Option<String>,
    #[serde(default)]
    pub method: Method,
}

/// What may allow a merge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Allow {
    /// The person's word: `by` says how they gave it.
    Person {
        by: String,
    },
    /// The project's "merge without asking" switch.
    Switch,
    Nobody,
}

/// What `decide` says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Merge {
        allowed_by: String,
    },
    Refuse(String),
    /// Needs the person's word for this head.
    Ask(String),
}

fn names(checks: &[&Check]) -> String {
    let mut list: Vec<&str> = checks.iter().map(|c| c.name.as_str()).take(5).collect();
    if checks.len() > 5 {
        list.push("…");
    }
    list.join(", ")
}

/// The decision, from what GitHub shows now, whether a decision on the work is open, and who allows it. Pure.
pub fn decide(read: &PrRead, open_decision: Option<&str>, allow: &Allow) -> Decision {
    let pr = format!("{}#{}", read.repo, read.number);
    match read.state {
        PrState::Merged => return Decision::Refuse(format!("{pr} is already merged.")),
        PrState::Closed => return Decision::Refuse(format!("{pr} is closed.")),
        PrState::Open => {}
    }
    if read.draft {
        return Decision::Refuse(format!("{pr} is a draft; mark it ready first."));
    }
    if read.detail.head_sha.is_none() {
        return Decision::Refuse(format!("{pr}'s head commit couldn't be read."));
    }
    if read.detail.mergeability == Mergeability::Conflicting {
        return Decision::Refuse(format!(
            "{pr} conflicts with its base; bring it up to date first."
        ));
    }
    let (checks, required) = gate(&read.detail.checks);
    let which = if required { "required " } else { "" };
    let red: Vec<&Check> = checks
        .iter()
        .copied()
        .filter(|c| c.status.failed())
        .collect();
    if !red.is_empty() {
        return Decision::Refuse(format!(
            "{pr} has {which}checks that failed ({}). Red is never merged.",
            names(&red)
        ));
    }
    let pending: Vec<&Check> = checks
        .iter()
        .copied()
        .filter(|c| c.status == CheckStatus::Pending)
        .collect();
    if !pending.is_empty() {
        return Decision::Refuse(format!(
            "{pr} has {which}checks still running ({}). It merges only once they pass.",
            names(&pending)
        ));
    }
    if let Some(question) = open_decision {
        return Decision::Refuse(format!(
            "A decision on this work is still open: {question}. It merges once that is answered."
        ));
    }
    let no_checks = checks.is_empty();
    match allow {
        Allow::Person { by } => Decision::Merge {
            allowed_by: by.clone(),
        },
        Allow::Switch if no_checks => Decision::Ask(format!(
            "{pr} has no checks, so it needs your word to merge even with \"merge without asking\" on."
        )),
        Allow::Switch => Decision::Merge {
            allowed_by: "project setting: merge without asking".into(),
        },
        Allow::Nobody => Decision::Ask(format!(
            "{pr} is green{}. Merge it?",
            if no_checks { " (it has no checks)" } else { "" }
        )),
    }
}

fn named_files(hits: &[String]) -> String {
    let shown: Vec<&str> = hits.iter().take(5).map(String::as_str).collect();
    if hits.len() > 5 {
        format!("{}, and {} more", shown.join(", "), hits.len() - 5)
    } else {
        shown.join(", ")
    }
}

/// The protected-path floor. Off, the decision is unchanged, so a project that has not turned the floor on
/// merges exactly as it did before. A decision that is not a merge is unchanged too: red still refuses, and
/// a pull request with no checks still asks for the no-checks reason.
pub(crate) fn floor_decision(
    decision: Decision,
    enabled: bool,
    files: &super::protected::ChangedFiles,
    extras: &[String],
    pr: &str,
) -> Decision {
    if !enabled {
        return decision;
    }
    let Decision::Merge { .. } = &decision else {
        return decision;
    };
    let paths = match files {
        super::protected::ChangedFiles::Unread { reason } => {
            let reason = reason.trim();
            let detail = if reason.is_empty() {
                String::new()
            } else {
                format!(" {reason}")
            };
            return Decision::Ask(format!(
                "{pr}'s changed files couldn't be read, so it needs your word to merge.{detail}"
            ));
        }
        super::protected::ChangedFiles::Listed(paths) => paths,
    };
    let hits = super::protected::protected_hits(paths, extras);
    if hits.is_empty() {
        return decision;
    }
    Decision::Ask(format!(
        "{pr} changes {}. It needs your word to merge.",
        named_files(&hits)
    ))
}

/// An open question on the work: a question on any task in its tree, or a WP-14 decision (state open)
/// waiting on any of those tasks. A waiting list that isn't a list of ids is skipped, not an error.
pub fn open_decision(conn: &Connection, delegation_id: &str) -> Result<Option<String>, String> {
    let tree = delegations::tree(conn, delegation_id)?;
    if let Some(row) = tree.iter().find(|row| row.state == delegations::QUESTION) {
        return Ok(Some(
            row.pending_question
                .clone()
                .unwrap_or_else(|| "a task is waiting on an answer".into()),
        ));
    }
    if tree.is_empty() {
        return Ok(None);
    }
    let ids: Vec<&str> = tree.iter().map(|row| row.id.as_str()).collect();
    let mut statement = conn
        .prepare(
            "SELECT question, waiting FROM decisions WHERE state = ?1 ORDER BY created_at, rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![crate::decisions::OPEN], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (question, waiting) = row.map_err(|e| e.to_string())?;
        let listed: Vec<String> = serde_json::from_str(&waiting).unwrap_or_default();
        if listed.iter().any(|id| ids.contains(&id.as_str())) {
            return Ok(Some(question));
        }
    }
    Ok(None)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum MergeOutcome {
    Merged {
        head_sha: String,
        allowed_by: String,
    },
    Refused {
        reason: String,
    },
    /// Nothing merged: the person's word is needed for this head (they give it in the app).
    NeedsYou {
        head_sha: String,
        question: String,
    },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoggedMerge {
    pub repo: String,
    pub number: u64,
    pub head_sha: Option<String>,
    pub outcome: String,
    pub allowed_by: Option<String>,
    pub caller: String,
    pub reason: Option<String>,
    pub at: i64,
}

fn repo_key(repo: &str) -> Result<String, String> {
    let (owner, name) = split_repo(repo)
        .ok_or_else(|| "repo must be owner/name, like ashneil12/hivra".to_string())?;
    Ok(format!("{owner}/{name}").to_ascii_lowercase())
}

/// Who did the merge, and who asked. A person's tap is both. An agent who merged
/// after the person allowed this head was asked by the person. The project's
/// switch is a setting that agent already had, so they asked themselves.
fn activity_who(caller: &Caller, allowed_by: &str) -> (crate::activity::Who, crate::activity::Who) {
    match caller {
        Caller::Person { .. } => (
            crate::activity::Who::person(),
            crate::activity::Who::person(),
        ),
        Caller::Agent { session } => {
            let actor = crate::activity::Who::first_mate(session.clone(), "");
            let initiator = if allowed_by.starts_with("person") || allowed_by.contains("approved") {
                crate::activity::Who::person()
            } else {
                actor.clone()
            };
            (actor, initiator)
        }
    }
}

/// The person allows this pull request to merge at exactly this head.
pub fn approve(
    conn: &Connection,
    repo: &str,
    number: u64,
    head_sha: &str,
    by: &str,
    now: i64,
) -> Result<(), String> {
    let repo = repo_key(repo)?;
    if head_sha.trim().is_empty() {
        return Err("Which head? An approval is for one commit.".into());
    }
    conn.execute(
        "INSERT OR REPLACE INTO delivery_merge_approvals (repo, number, head_sha, approved_by, approved_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![repo, number as i64, head_sha.trim(), by, now],
    )
    .map_err(|e| e.to_string())?;
    // WP-78: the person allowed this head. Their name and the commit stay out of the line.
    crate::activity::note(
        conn,
        crate::activity::PERMISSION_GRANT,
        &crate::activity::Who::person(),
        &crate::activity::Who::person(),
        "",
        &format!("{repo}#{number}"),
        &format!("Allowed merge of {repo}#{number} at this head."),
        &format!("https://github.com/{repo}/pull/{number}"),
        now,
    );
    Ok(())
}

fn approval(
    conn: &Connection,
    repo: &str,
    number: u64,
    head: &str,
) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT approved_by FROM delivery_merge_approvals WHERE repo = ?1 AND number = ?2 AND head_sha = ?3",
        params![repo, number as i64, head],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
fn record(
    conn: &Connection,
    repo: &str,
    number: u64,
    head: Option<&str>,
    outcome: &str,
    allowed_by: Option<&str>,
    caller: &Caller,
    reason: Option<&str>,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO delivery_merges (repo, number, head_sha, outcome, allowed_by, caller, reason, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![repo, number as i64, head, outcome, allowed_by, caller.label(), reason, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn log(conn: &Connection, repo: &str, number: u64) -> Result<Vec<LoggedMerge>, String> {
    let repo = repo_key(repo)?;
    let mut statement = conn
        .prepare(
            "SELECT repo, number, head_sha, outcome, allowed_by, caller, reason, at FROM delivery_merges
             WHERE repo = ?1 AND number = ?2 ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![repo, number as i64], |row| {
            Ok(LoggedMerge {
                repo: row.get(0)?,
                number: row.get::<_, i64>(1)? as u64,
                head_sha: row.get(2)?,
                outcome: row.get(3)?,
                allowed_by: row.get(4)?,
                caller: row.get(5)?,
                reason: row.get(6)?,
                at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The one merge path (module docs). The database is not held while GitHub is read or written.
pub fn merge(
    store: &SessionStore,
    gh: &dyn Github,
    request: MergeRequest,
    now: i64,
) -> Result<MergeOutcome, String> {
    let repo = repo_key(&request.repo)?;
    let number = request.number;
    if number == 0 {
        return Err("number must be the pull request's number".into());
    }
    let read = gh.read_pr(&repo, number);
    let mut conn = store.lock_conn()?;
    let read = match read {
        Ok(read) => read,
        Err(error) => {
            let reason = format!("{repo}#{number} couldn't be read from GitHub: {error}");
            record(
                &conn,
                &repo,
                number,
                None,
                "refused",
                None,
                &request.caller,
                Some(&reason),
                now,
            )?;
            return Ok(MergeOutcome::Refused { reason });
        }
    };
    let head = read.detail.head_sha.clone().unwrap_or_default();
    let delivery = super::deliver::by_pr(&conn, &repo, number)?;
    // An agent doesn't get to name these. The delivery row is the only source, and with no row
    // there is no project switch and no delegation: the agent is asked unless this head was approved.
    let (delegation, project) = match &request.caller {
        Caller::Agent { .. } => (
            delivery.as_ref().and_then(|row| row.delegation_id.clone()),
            delivery.as_ref().map(|row| row.project.clone()),
        ),
        Caller::Person { .. } => (
            request
                .delegation_id
                .clone()
                .or_else(|| delivery.as_ref().and_then(|row| row.delegation_id.clone())),
            request
                .project
                .clone()
                .or_else(|| delivery.as_ref().map(|row| row.project.clone())),
        ),
    };
    let open = match &delegation {
        Some(id) => open_decision(&conn, id)?,
        None => None,
    };
    let stored = match project.as_deref() {
        Some(path) => Some(super::settings::get(&conn, path)?),
        None => None,
    };
    let allow = match &request.caller {
        Caller::Person { via } => Allow::Person {
            by: format!("person ({via})"),
        },
        Caller::Agent { .. } => match approval(&conn, &repo, number, &head)? {
            Some(by) => Allow::Person {
                by: format!("{by} (approved this head)"),
            },
            None if stored.as_ref().is_some_and(|row| row.merge_without_asking) => Allow::Switch,
            None => Allow::Nobody,
        },
    };
    let decided = decide(&read, open.as_deref(), &allow);
    // WP-158: only the switch consults the floor, and only once the project has turned it on.
    // The person's own tap, and an approval of this exact head, are already their word.
    let consult = matches!(allow, Allow::Switch)
        && stored.as_ref().is_some_and(|row| row.protect_paths)
        && matches!(decided, Decision::Merge { .. });
    let decision = if consult {
        let extras = stored
            .as_ref()
            .map(|row| row.protected_extra.clone())
            .unwrap_or_default();
        drop(conn);
        // The list is for the base and head commits this read saw. Without a base commit there is nothing to pin it to.
        let files = match read.base_sha.clone() {
            None => super::protected::ChangedFiles::Unread {
                reason: "GitHub didn't say which commit this pull request is based on.".into(),
            },
            Some(base) => {
                let listed = super::protected::changed_files_between(gh, &repo, &base, &head);
                let again = gh.read_pr(&repo, number);
                // The second read carries changedFiles and the base. The list is the whole diff only when
                // both are unchanged, the count matches, and the head has not moved.
                match again {
                    Ok(again) if again.detail.head_sha.as_deref() != Some(head.as_str()) => {
                        super::protected::ChangedFiles::Unread {
                            reason: "the pull request's head changed while its files were read".into(),
                        }
                    }
                    Ok(again) if again.base_sha.as_deref() != Some(base.as_str()) => {
                        super::protected::ChangedFiles::Unread {
                            reason: "the pull request's base changed while its files were read".into(),
                        }
                    }
                    Ok(again) => super::protected::judge(listed, again.changed_files),
                    Err(error) => super::protected::ChangedFiles::Unread { reason: error },
                }
            }
        };
        conn = store.lock_conn()?;
        floor_decision(decided, true, &files, &extras, &format!("{repo}#{number}"))
    } else {
        decided
    };
    let allowed_by = match decision {
        Decision::Refuse(reason) => {
            record(
                &conn,
                &repo,
                number,
                Some(&head),
                "refused",
                None,
                &request.caller,
                Some(&reason),
                now,
            )?;
            return Ok(MergeOutcome::Refused { reason });
        }
        Decision::Ask(question) => {
            record(
                &conn,
                &repo,
                number,
                Some(&head),
                "asked",
                None,
                &request.caller,
                Some(&question),
                now,
            )?;
            return Ok(MergeOutcome::NeedsYou {
                head_sha: head,
                question,
            });
        }
        Decision::Merge { allowed_by } => allowed_by,
    };
    drop(conn);
    let args: Vec<String> = [
        "pr",
        "merge",
        &number.to_string(),
        "--repo",
        &repo,
        request.method.flag(),
        "--match-head-commit",
        &head,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let ran = gh.run(None, &args);
    let conn = store.lock_conn()?;
    match ran {
        Ok(_) => {
            record(
                &conn,
                &repo,
                number,
                Some(&head),
                "merged",
                Some(&allowed_by),
                &request.caller,
                None,
                now,
            )?;
            // WP-78: one row for a merge that landed. An ask or a refusal stays in the delivery log only.
            let (actor, initiator) = activity_who(&request.caller, &allowed_by);
            crate::activity::note(
                &conn,
                crate::activity::MERGE,
                &actor,
                &initiator,
                project.as_deref().unwrap_or(""),
                &format!("{repo}#{number}"),
                &format!("Merged {repo}#{number}."),
                &format!("https://github.com/{repo}/pull/{number}"),
                now,
            );
            Ok(MergeOutcome::Merged {
                head_sha: head,
                allowed_by,
            })
        }
        Err(error) => {
            let reason = format!("GitHub didn't merge {repo}#{number}: {error}");
            record(
                &conn,
                &repo,
                number,
                Some(&head),
                "failed",
                Some(&allowed_by),
                &request.caller,
                Some(&reason),
                now,
            )?;
            Ok(MergeOutcome::Refused { reason })
        }
    }
}

/// The Inbox's merge button (fs.rs `git_github_pr_action`): the person's own tap, through the one path. An error when
/// it didn't merge, in words.
pub fn by_person(
    store: &SessionStore,
    gh: &dyn Github,
    repo: &str,
    number: u64,
    method: Method,
    via: &str,
    now: i64,
) -> Result<(), String> {
    match merge(
        store,
        gh,
        MergeRequest {
            repo: repo.into(),
            number,
            caller: Caller::Person { via: via.into() },
            project: None,
            delegation_id: None,
            method,
        },
        now,
    )? {
        MergeOutcome::Merged { .. } => Ok(()),
        MergeOutcome::Refused { reason } => Err(reason),
        MergeOutcome::NeedsYou { question, .. } => Err(question),
    }
}
