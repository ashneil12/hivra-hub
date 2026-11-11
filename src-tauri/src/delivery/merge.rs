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
//!
//! A pull request that touches a security path (neverMerge.json's `securityPaths`) or carries a park label merges only
//! with a security review for its exact head (WP-203): the findings, run record and coverage ledger the review command
//! writes under `<git common dir>/hivra-security-review/<head>/`. The gate reads those files; it refuses a missing,
//! stale, uncovered or same-builder review, and any confirmed high or critical finding. A needs_validation record
//! becomes one open decision in the Inbox and does not block.

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

/// The lead tick's list of park and never-merge labels (src/features/leadTick/model/neverMerge.json). The tick reads the
/// same file, so the two can't drift apart.
const NEVER_MERGE_JSON: &str = include_str!("../../../src/features/leadTick/model/neverMerge.json");

#[derive(Deserialize)]
struct NeverMergeList {
    labels: Vec<String>,
    #[serde(default, rename = "securityPaths")]
    security_paths: Vec<String>,
}

/// The paths that make a change security-sensitive (the same list the ship helper reads).
pub fn security_paths() -> Vec<String> {
    let list: NeverMergeList =
        serde_json::from_str(NEVER_MERGE_JSON).expect("neverMerge.json is valid JSON");
    list.security_paths
}

/// A glob as the ship helper reads it: `**` any path, `*` within one folder name, `?` one character.
pub fn glob_match(pattern: &str, path: &str) -> bool {
    // Both sides fold the way the floor folds names (NFKC, lower case), so a case or width change can't slip past.
    let pattern = super::protected::fold_path(pattern);
    let path = super::protected::fold_path(path);
    fn go(p: &[u8], s: &[u8]) -> bool {
        match p.first() {
            None => s.is_empty(),
            Some(b'*') if p.get(1) == Some(&b'*') => {
                let rest = &p[2..];
                let rest = if rest.first() == Some(&b'/') {
                    &rest[1..]
                } else {
                    rest
                };
                (0..=s.len()).any(|i| go(rest, &s[i..]))
            }
            Some(b'*') => {
                let rest = &p[1..];
                let mut i = 0;
                loop {
                    if go(rest, &s[i..]) {
                        return true;
                    }
                    if i >= s.len() || s[i] == b'/' {
                        return false;
                    }
                    i += 1;
                }
            }
            Some(b'?') => !s.is_empty() && s[0] != b'/' && go(&p[1..], &s[1..]),
            Some(&c) => s.first() == Some(&c) && go(&p[1..], &s[1..]),
        }
    }
    go(pattern.as_bytes(), path.as_bytes())
}

/// The changed files the security gate judges: the floor's own reader (the compare answer between the base and head
/// commits of the first read), judged against that read's file count. A short, capped, empty or unreadable list is
/// unread, and the gate refuses.
fn gate_files(gh: &dyn Github, repo: &str, read: &PrRead) -> super::protected::ChangedFiles {
    let Some(base) = read.base_tip.clone() else {
        return super::protected::ChangedFiles::Unread {
            reason: "GitHub didn't say where the base branch is now.".into(),
        };
    };
    let head = read.detail.head_sha.clone().unwrap_or_default();
    let listed = super::protected::changed_files_between(gh, repo, &base, &head);
    super::protected::judge(listed, read.changed_files)
}

/// The security gate's answer for one merge.
#[derive(Debug, PartialEq, Eq)]
enum SecurityGate {
    /// Not security-sensitive, or reviewed and clean.
    Pass,
    Refuse(String),
    /// The gate can't decide yet (the files can't be read, or a question about the review is open). The merge is held
    /// for an answer and never merged: the gate runs before any approval, so a tap can't merge past it.
    Hold(String),
}

/// The pull request and its head that the gate judges.
struct GateTarget<'a> {
    repo: &'a str,
    number: u64,
    head: &'a str,
    project: Option<&'a str>,
    labels: &'a [String],
    /// The CLIs installed and signed in, for choosing a reviewer the app starts (empty: none can be chosen).
    present: &'a [crate::crew::resolve::Presence],
}

/// No record for this head: the review is already running (hold), or it failed (refuse), or the app starts it now to a
/// builder other than the author, and holds until it settles.
fn launch_or_wait(
    conn: &mut rusqlite::Connection,
    repo: &str,
    number: u64,
    head: &str,
    present: &[crate::crew::resolve::Presence],
    now: i64,
) -> Result<SecurityGate, String> {
    let short = head.chars().take(12).collect::<String>();
    if let Some(running) = super::review::running_for(conn, repo, number, head)? {
        if now.saturating_sub(running.run_started_at) > super::review::STUCK_AFTER_MS {
            return Ok(SecurityGate::Hold(format!(
                "Security review stuck for PR #{number} (head {short}): it has run longer than an hour. The merge is held; it never passes on the clock."
            )));
        }
        return Ok(SecurityGate::Hold(format!(
            "Security review running for PR #{number} (head {short}). The merge waits for its answer."
        )));
    }
    let Some(author) = super::review::author_of(conn, repo, number)? else {
        return Ok(SecurityGate::Refuse(format!(
            "{repo}#{number} is security-sensitive, and its author is not recorded, so no review can be started for head {short}."
        )));
    };
    // Never use: the crew's "never use" list lands with PR #194, which is not in this tree yet. Until it does, only the
    // author is excluded here, and the list passed in is empty.
    let Some(reviewer) = super::review::pick_reviewer(&author, present, &[]) else {
        return Ok(SecurityGate::Refuse(format!(
            "{repo}#{number} is security-sensitive, and no builder other than its author ({author}) is signed in to review head {short}."
        )));
    };
    let row = super::review::start(conn, repo, number, head, &author, &reviewer, now)?;
    Ok(SecurityGate::Hold(format!(
        "Security review running for PR #{number} ({reviewer}, head {short}). The merge waits for its answer. Review delegation {}.",
        row.id
    )))
}

/// The security gate (WP-203) for one head. The review is the app's record (delivery/review.rs), written from a
/// review delegation the app ran: a checkout folder is never read. A change that needs a review and has none recorded
/// for its head is refused; a recorded review must cover every changed file, have no confirmed high or critical
/// finding, and, when it has candidates that need validation, wait for the person's answer to them.
fn security_gate(
    conn: &mut rusqlite::Connection,
    changed: super::protected::ChangedFiles,
    target: GateTarget<'_>,
    now: i64,
) -> Result<SecurityGate, String> {
    let GateTarget {
        repo,
        number,
        head,
        project,
        labels,
        present,
    } = target;
    let files = match changed {
        super::protected::ChangedFiles::Listed(files) => files,
        super::protected::ChangedFiles::Unread { reason } => {
            return Ok(SecurityGate::Hold(format!(
                "{repo}#{number}'s changed files couldn't be read, so Hivra can't tell whether it needs a security review: {reason} Nothing was merged."
            )))
        }
    };
    let paths = security_paths();
    let sensitive = park_label(labels).is_some()
        || files
            .iter()
            .any(|file| paths.iter().any(|pattern| glob_match(pattern, file)));
    if !sensitive {
        return Ok(SecurityGate::Pass);
    }
    let short = head.chars().take(12).collect::<String>();
    let Some(record) = super::review::lookup(conn, repo, number, head)? else {
        return launch_or_wait(conn, repo, number, head, present, now);
    };
    if record.status != "recorded" {
        return Ok(SecurityGate::Refuse(format!(
            "The security review for head {short} doesn't count: {}",
            record.reason.as_deref().unwrap_or("it was refused")
        )));
    }
    let uncovered: Vec<&str> = files
        .iter()
        .map(String::as_str)
        .filter(|file| !record.files.iter().any(|covered| covered == file))
        .collect();
    if !uncovered.is_empty() {
        return Ok(SecurityGate::Refuse(format!(
            "The security review for head {short} does not cover every changed file; not covered: {}.",
            uncovered.join(", ")
        )));
    }
    if let Some(blocking) = &record.blocking {
        return Ok(SecurityGate::Refuse(format!(
            "A confirmed {blocking} finding is open on head {short}."
        )));
    }
    // Every recorded review waits for the person's word on this head, clean or not: a pass is never the only gate (round 4
    // MED-3). The answer must come from the person (decisions::person_only refuses any other answerer, and the gate checks
    // who answered before it passes).
    let Some(project) = project else {
        return Ok(SecurityGate::Refuse(format!(
            "{repo}#{number} is security-sensitive, and no project is known to ask the person about head {short}."
        )));
    };
    let key = crate::decisions::security_decision_key(repo, number, head);
    // A clean record is one reviewer's own report. Approve is the only other check, and only when nothing is waiting.
    // Candidates take a different option, so an Approve from a clean card cannot pass a head that still has them.
    let (question, options, accept) = if record.pending.is_empty() {
        (
            format!(
                "One reviewer reported PR #{number} (head {short}) as a pass. That report is the reviewer's own word. Your Approve is the only other check. Approve the merge, or hold it."
            ),
            vec!["Approve".to_string(), "Hold the merge".to_string()],
            "Approve",
        )
    } else {
        (
            format!(
                "Security review of PR #{number} (head {short}): {} candidate{} need validation: {}. \"Looked at it\" lets it merge; \"Hold the merge\" keeps it from merging.",
                record.pending.len(),
                if record.pending.len() == 1 { "" } else { "s" },
                record.pending.join("; "),
            ),
            vec!["Looked at it".to_string(), "Hold the merge".to_string()],
            "Looked at it",
        )
    };
    // Ask every time. A chat's question under this key is replaced, and an answer that is no longer one of the options
    // is cleared. save() would have left both in place.
    crate::decisions::ask(
        conn,
        crate::decisions::AskInput {
            asked_by: "gate".into(),
            asked_by_mono: None,
            project: Some(project.to_string()),
            key: key.clone(),
            question: question.clone(),
            options,
            recommended: None,
            task_ids: Vec::new(),
        },
        now,
    )?;
    let Some(decision) = crate::decisions::get(conn, project, &key)? else {
        return Ok(SecurityGate::Hold(question));
    };
    let by_person = matches!(
        decision.answered_by.as_deref(),
        Some("person") | Some("user")
    );
    let from_gate = crate::decisions::fold_key(&decision.asked_by) == "gate";
    if decision.state != crate::decisions::ANSWERED || !by_person || !from_gate {
        return Ok(SecurityGate::Hold(question));
    }
    match decision.answer.as_deref() {
        Some(word) if word == accept => Ok(SecurityGate::Pass),
        Some("Hold the merge") => Ok(SecurityGate::Refuse(format!(
            "The person held the merge of head {short}."
        ))),
        _ => Ok(SecurityGate::Hold(question)),
    }
}

/// The first park or never-merge label on the pull request, as the tick names it (trimmed, lower case, spaces and
/// underscores as dashes).
pub fn park_label(labels: &[String]) -> Option<String> {
    let list: NeverMergeList =
        serde_json::from_str(NEVER_MERGE_JSON).expect("neverMerge.json is valid JSON");
    labels.iter().find_map(|label| {
        let key: String = label
            .trim()
            .to_lowercase()
            .split(|c: char| c.is_whitespace() || c == '_')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        list.labels.contains(&key).then(|| label.clone())
    })
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
    let shown: Vec<String> = hits
        .iter()
        .take(5)
        .map(|hit| super::protected::show(hit))
        .collect();
    if hits.len() > 5 {
        format!("{}, and {} more", shown.join(", "), hits.len() - 5)
    } else {
        shown.join(", ")
    }
}

/// The protected-path floor. Off, the decision is unchanged, so a project that has not turned the floor on
/// merges exactly as it did before. A refusal is unchanged: red still refuses. A pull request that would
/// otherwise merge needs the person's word when its files are unread or touch a protected path. One that
/// would ask (no checks, with the switch on) keeps its question and says what the floor found in it too.
pub(crate) fn floor_decision(
    shared: &Result<&super::protected::Shared, String>,
    decision: Decision,
    enabled: bool,
    files: &super::protected::ChangedFiles,
    extras: &[String],
    pr: &str,
) -> Decision {
    if !enabled {
        return decision;
    }
    if let Decision::Refuse(_) = &decision {
        return decision;
    }
    // A list that would not load holds the pull request: the floor cannot judge it, so the person decides.
    let shared = match shared {
        Ok(list) => *list,
        Err(error) => {
            return ask_with(
                decision,
                format!(
                    "{pr}'s protected-path list couldn't be loaded ({error}), so it needs your word to merge."
                ),
            )
        }
    };
    let paths = match files {
        super::protected::ChangedFiles::Unread { reason } => {
            let reason = reason.trim();
            let detail = if reason.is_empty() {
                String::new()
            } else {
                format!(" {reason}")
            };
            return ask_with(
                decision,
                format!(
                    "{pr}'s changed files couldn't be read, so it needs your word to merge.{detail}"
                ),
            );
        }
        super::protected::ChangedFiles::Listed(paths) => paths,
    };
    let hits = super::protected::protected_hits(Some(shared), paths, extras);
    if hits.is_empty() {
        return decision;
    }
    match decision {
        Decision::Ask(question) => Decision::Ask(format!(
            "{question} It also changes {}, which the protected-path floor holds, so it needs your word too.",
            named_files(&hits)
        )),
        _ => Decision::Ask(format!(
            "{pr} changes {}. It needs your word to merge.",
            named_files(&hits)
        )),
    }
}

/// The floor's ask, added to a question the switch already asks, or on its own.
fn ask_with(decision: Decision, ask: String) -> Decision {
    match decision {
        Decision::Ask(question) => Decision::Ask(format!("{question} {ask}")),
        _ => Decision::Ask(ask),
    }
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
    merge_with(store, gh, request, now, &[])
}

/// The one merge path (module docs), with the CLIs installed and signed in, so the security gate can start a review to a
/// builder other than the author. `present` empty means none can be chosen: a gate that needs a review then refuses.
pub fn merge_with(
    store: &SessionStore,
    gh: &dyn Github,
    request: MergeRequest,
    now: i64,
    present: &[crate::crew::resolve::Presence],
) -> Result<MergeOutcome, String> {
    let repo = repo_key(&request.repo)?;
    let number = request.number;
    if number == 0 {
        return Err("number must be the pull request's number".into());
    }
    // The protected-path list is loaded before the store lock is taken. A list that will not load is an error value
    // the floor turns into an ask, never a panic while the lock is held.
    let shared = super::protected::shared_list();
    let read = gh.read_pr(&repo, number);
    // The changed files are read before the database is held (the same rule as the pull request read above).
    let changed = match &read {
        Ok(read) => gate_files(gh, &repo, read),
        Err(error) => super::protected::ChangedFiles::Unread {
            reason: error.clone(),
        },
    };
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
    // The lead tick (an agent) never merges a security park, whatever this head was approved for. Read fresh from GitHub.
    if matches!(request.caller, Caller::Agent { .. }) {
        if let Some(label) = park_label(&read.labels) {
            let reason = format!("{repo}#{number} is labelled {label}: an agent never merges it.");
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
    }
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
    let target = GateTarget {
        repo: &repo,
        number,
        head: &head,
        project: project.as_deref(),
        labels: &read.labels,
        present,
    };
    let held = match security_gate(&mut conn, changed, target, now)? {
        SecurityGate::Pass => None,
        SecurityGate::Hold(question) => Some(question),
        SecurityGate::Refuse(reason) => {
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
    };
    // The pull request must still be on the branch the delivery pushed. A head pointed at another branch is not the
    // work the delivery judged, so it is refused. The delivery row is the only record of that branch.
    // The check is the floor's: with the floor off the project decides exactly as before.
    let floor_on = stored.as_ref().is_some_and(|row| row.protect_paths);
    let decided = match delivery.as_ref().and_then(|row| row.branch.as_deref()) {
        Some(expected) if floor_on && expected != read.head_ref => Decision::Refuse(format!(
            "{repo}#{number} is on the branch {}, but its delivery pushed {}. Nothing was merged.",
            super::protected::show(&read.head_ref),
            super::protected::show(expected),
        )),
        _ => decide(&read, open.as_deref(), &allow),
    };
    // WP-158: only the switch consults the floor, and only once the project has turned it on. That covers a green
    // merge and the no-checks question the switch still asks, so the question can name a protected file. The
    // person's own tap, and an approval of this exact head, are already their word.
    let consult = matches!(allow, Allow::Switch)
        && stored.as_ref().is_some_and(|row| row.protect_paths)
        && !matches!(decided, Decision::Refuse(_));
    let decision = if consult {
        let extras = stored
            .as_ref()
            .map(|row| row.protected_extra.clone())
            .unwrap_or_default();
        drop(conn);
        // The list is for the base branch's current tip and the head this read saw. Without a tip there is nothing to pin it to.
        let files = match read.base_tip.clone() {
            None => super::protected::ChangedFiles::Unread {
                reason: "GitHub didn't say where the base branch is now.".into(),
            },
            Some(base) => {
                let listed = super::protected::changed_files_between(gh, &repo, &base, &head);
                let again = gh.read_pr(&repo, number);
                // The second read carries changedFiles and the base. The list is the whole diff only when
                // both are unchanged, the count matches, and the head has not moved.
                match again {
                    Ok(again) if again.detail.head_sha.as_deref() != Some(head.as_str()) => {
                        super::protected::ChangedFiles::Unread {
                            reason: "the pull request's head changed while its files were read"
                                .into(),
                        }
                    }
                    Ok(again) if again.base_tip.as_deref() != Some(base.as_str()) => {
                        super::protected::ChangedFiles::Unread {
                            reason: "the pull request's base changed while its files were read"
                                .into(),
                        }
                    }
                    Ok(again) => super::protected::judge(listed, again.changed_files),
                    Err(error) => super::protected::ChangedFiles::Unread { reason: error },
                }
            }
        };
        conn = store.lock_conn()?;
        // A decision opened while the files were read (another window, the person) stops the merge too.
        // The check above ran before that read.
        let opened_meanwhile = match &delegation {
            Some(id) => open_decision(&conn, id)?,
            None => None,
        };
        match opened_meanwhile {
            Some(question) => Decision::Refuse(format!(
                "A decision on this work is still open: {question}. It merges once that is answered."
            )),
            None => floor_decision(
                &shared,
                decided,
                true,
                &files,
                &extras,
                &format!("{repo}#{number}"),
            ),
        }
    } else {
        decided
    };
    // A held gate asks, unless the checks already refuse: a refusal stands, and nothing merges on a hold.
    let decision = match (held, decision) {
        (Some(question), Decision::Merge { .. } | Decision::Ask(_)) => Decision::Ask(question),
        (_, decision) => decision,
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
