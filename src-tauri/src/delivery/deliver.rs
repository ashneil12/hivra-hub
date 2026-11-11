//! A finished worker's change, delivered the way its project says (settings.rs), recorded as one row.
//!
//! | Mode | What happens | Row state |
//! | --- | --- | --- |
//! | local | `land.rs` puts the change into the project; nothing is pushed or committed | `landed`, or `conflict` |
//! | PR | the worker's branch is pushed and a pull request opened (brief and report in its body) | `ready` |
//! | checked PR | as PR; ready only once its checks are green (events.rs moves it on) | `checking`, then `ready`, `fixing` or `failed` |
//!
//! Later, from the PR watch: `merged` or `closed`. A PR mode needs committed work: uncommitted changes in the worker's
//! copy are refused, not pushed half.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::github::Github;
use super::settings::{self, Mode};
use crate::delegations;
use crate::firstmate::report::{self, CheckOutcome, WorkerReport};
use crate::session_store::SessionStore;

pub const LANDED: &str = "landed";
pub const CONFLICT: &str = "conflict";
pub const READY: &str = "ready";
pub const CHECKING: &str = "checking";
pub const FIXING: &str = "fixing";
pub const FAILED: &str = "failed";
pub const MERGED: &str = "merged";
pub const CLOSED: &str = "closed";

/// The longest brief or report a pull request body carries.
const BODY_PART_MAX: usize = 20_000;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverInput {
    /// The project's main checkout.
    pub project: String,
    /// The worker's own copy.
    pub checkout: String,
    #[serde(default)]
    pub delegation_id: Option<String>,
    /// The pull request's title; the delegation's title, else the branch, when left out.
    #[serde(default)]
    pub title: Option<String>,
    /// The brief; the delegation's when left out.
    #[serde(default)]
    pub brief: Option<String>,
    /// The worker's final report as it wrote it; the delegation's result when left out.
    #[serde(default)]
    pub report: Option<String>,
    /// The base branch; the remote's default when left out.
    #[serde(default)]
    pub base: Option<String>,
    /// WP-84: research and design documents to link from the pull request. Empty for a straight build.
    #[serde(default)]
    pub phase_docs: Vec<PhaseLink>,
}

/// One phase document named in a pull request body.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseLink {
    pub title: String,
    pub href: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub id: String,
    pub delegation_id: Option<String>,
    pub project: String,
    pub checkout: Option<String>,
    pub mode: String,
    pub state: String,
    pub repo: Option<String>,
    pub number: Option<u64>,
    pub url: Option<String>,
    pub branch: Option<String>,
    pub fix_rounds: i64,
    /// What happened, in words (the landing, the push, a red check's log).
    pub detail: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

const COLUMNS: &str =
    "id, delegation_id, project, checkout, mode, state, repo, number, url, branch, fix_rounds, \
                       detail, created_at, updated_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<Delivery> {
    Ok(Delivery {
        id: row.get(0)?,
        delegation_id: row.get(1)?,
        project: row.get(2)?,
        checkout: row.get(3)?,
        mode: row.get(4)?,
        state: row.get(5)?,
        repo: row.get(6)?,
        number: row.get::<_, Option<i64>>(7)?.map(|n| n as u64),
        url: row.get(8)?,
        branch: row.get(9)?,
        fix_rounds: row.get(10)?,
        detail: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Delivery>, String> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM work_deliveries WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The newest delivery of a pull request.
pub fn by_pr(conn: &Connection, repo: &str, number: u64) -> Result<Option<Delivery>, String> {
    conn.query_row(
        &format!(
            "SELECT {COLUMNS} FROM work_deliveries WHERE repo = ?1 AND number = ?2 \
             ORDER BY created_at DESC, rowid DESC LIMIT 1"
        ),
        params![repo.to_ascii_lowercase(), number as i64],
        from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// True when this pull request was opened by the local check (WP-81). False when the column or the
/// row is missing: a missing check is not a reason to skip the fix crew.
pub fn through_gate(conn: &Connection, repo: &str, number: u64) -> bool {
    conn.query_row(
        "SELECT gate FROM work_deliveries WHERE repo = ?1 AND number = ?2 \
         ORDER BY created_at DESC, rowid DESC LIMIT 1",
        params![repo.to_ascii_lowercase(), number as i64],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or(0)
        != 0
}

pub(crate) fn mark_gate(conn: &Connection, id: &str) -> Result<(), String> {
    let updated = conn
        .execute("UPDATE work_deliveries SET gate = 1 WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        return Err("The delivery wasn't recorded, so the check wasn't linked.".into());
    }
    Ok(())
}

pub(crate) fn delete_row(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM work_deliveries WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list(conn: &Connection, project: Option<&str>) -> Result<Vec<Delivery>, String> {
    let key = project.map(settings::key);
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM work_deliveries WHERE ?1 IS NULL OR project = ?1 \
             ORDER BY created_at DESC, rowid DESC LIMIT 200"
        ))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([key], from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn insert(conn: &Connection, d: &Delivery) -> Result<(), String> {
    conn.execute(
        &format!("INSERT INTO work_deliveries ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"),
        params![
            d.id,
            d.delegation_id,
            d.project,
            d.checkout,
            d.mode,
            d.state,
            d.repo,
            d.number.map(|n| n as i64),
            d.url,
            d.branch,
            d.fix_rounds,
            d.detail,
            d.created_at,
            d.updated_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Moves a delivery only when it is still in `from_state` with `from_rounds`. False when a newer
/// write already moved it: the caller keeps that newer state.
#[allow(clippy::too_many_arguments)]
pub(crate) fn move_state(
    conn: &Connection,
    id: &str,
    from_state: &str,
    from_rounds: i64,
    state: &str,
    fix_rounds: i64,
    detail: Option<&str>,
    now: i64,
) -> Result<bool, String> {
    let updated = conn
        .execute(
            "UPDATE work_deliveries SET state = ?2, fix_rounds = ?3, detail = COALESCE(?4, detail), updated_at = ?5
             WHERE id = ?1 AND state = ?6 AND fix_rounds = ?7",
            params![id, state, fix_rounds, detail, now, from_state, from_rounds],
        )
        .map_err(|e| e.to_string())?;
    Ok(updated == 1)
}

pub(crate) fn set_state(
    conn: &Connection,
    id: &str,
    state: &str,
    fix_rounds: i64,
    detail: Option<&str>,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE work_deliveries SET state = ?2, fix_rounds = ?3, detail = COALESCE(?4, detail), updated_at = ?5
         WHERE id = ?1",
        params![id, state, fix_rounds, detail, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn announce(app: &AppHandle, ids: &[String]) {
    if !ids.is_empty() {
        let _ = app.emit(super::CHANGED, serde_json::json!({ "ids": ids }));
    }
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = super::child("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("git couldn't start: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr)
            .trim()
            .chars()
            .take(600)
            .collect())
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.trim().to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!(
        "{}\n\n… (cut; the rest is in the delegation)",
        kept.trim_end()
    )
}

/// The pull request's body: the brief, then the worker's report as evidence, with its opinion of its own work kept
/// apart and labelled as that. A straight build uses this and nothing else.
pub fn pr_body(mode: Mode, brief: Option<&str>, report_text: Option<&str>) -> String {
    let mut body = String::new();
    if let Some(brief) = brief.filter(|b| !b.trim().is_empty()) {
        body.push_str("## Brief\n\n");
        body.push_str(&clip(brief, BODY_PART_MAX));
        body.push_str("\n\n");
    }
    let parsed: WorkerReport = report::parse(report_text.unwrap_or(""));
    body.push_str("## Worker's report\n\n");
    match &parsed.summary {
        Some(summary) => body.push_str(&format!("{summary}\n\n")),
        None if report_text.is_some_and(|t| !t.trim().is_empty()) => {
            body.push_str(&clip(report_text.unwrap_or(""), BODY_PART_MAX));
            body.push_str("\n\n");
        }
        None => body.push_str("The worker left no report.\n\n"),
    }
    if !parsed.files_changed.is_empty() {
        body.push_str("**Files changed**\n\n");
        for file in &parsed.files_changed {
            body.push_str(&format!("- `{file}`\n"));
        }
        body.push('\n');
    }
    if !parsed.checks.is_empty() {
        body.push_str("**Checks the worker ran**\n\n");
        for check in &parsed.checks {
            let outcome = match check.outcome {
                CheckOutcome::Passed => "passed",
                CheckOutcome::Failed => "failed",
                CheckOutcome::NotRun => "not run",
            };
            let detail = check
                .detail
                .as_deref()
                .map(|d| format!(" ({d})"))
                .unwrap_or_default();
            body.push_str(&format!("- `{}`: {outcome}{detail}\n", check.command));
        }
        body.push('\n');
    }
    if !parsed.evidence.is_empty() {
        body.push_str("**Evidence**\n\n");
        for item in &parsed.evidence {
            body.push_str(&format!("- {item}\n"));
        }
        body.push('\n');
    }
    if !parsed.open_questions.is_empty() {
        body.push_str("**Open questions**\n\n");
        for item in &parsed.open_questions {
            body.push_str(&format!("- {item}\n"));
        }
        body.push('\n');
    }
    if !parsed.self_assessment.is_empty() {
        body.push_str("**The worker's own view (not evidence)**\n\n");
        for item in &parsed.self_assessment {
            body.push_str(&format!("- {item}\n"));
        }
        body.push('\n');
    }
    body.push_str(&format!(
        "---\nOpened by Hivra ({}). It merges only through Hivra's merge path: never red, and with your word unless \
         this project merges without asking.\n",
        match mode {
            Mode::CheckedPr => "checked PR: ready once its checks are green",
            _ => "PR",
        }
    ));
    body
}

/// As `pr_body`, plus links to the phase documents when a phased task has them.
/// An empty list, or links that cannot be written safely, is `pr_body` unchanged.
pub fn pr_body_with(
    mode: Mode,
    brief: Option<&str>,
    report_text: Option<&str>,
    phases: &[PhaseLink],
) -> String {
    let body = pr_body(mode, brief, report_text);
    let mut section = String::new();
    for phase in phases {
        let title = phase
            .title
            .replace(['\n', '\r', '[', ']'], " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let href = phase.href.trim();
        if title.is_empty()
            || href.is_empty()
            || href
                .chars()
                .any(|c| c.is_whitespace() || c == '(' || c == ')')
        {
            continue;
        }
        if section.is_empty() {
            section.push_str("## Phase documents\n\n");
        }
        section.push_str(&format!("- [{title}]({href})\n"));
    }
    if section.is_empty() {
        return body;
    }
    section.push('\n');
    // The Hivra footer is always last. The links go in front of it.
    const FOOTER: &str = "---\nOpened by Hivra (";
    match body.rfind(FOOTER) {
        Some(at) => {
            let mut linked = body;
            linked.insert_str(at, &section);
            linked
        }
        None => body + &section,
    }
}

/// `owner/name/pull/<n>` from what `gh pr create` printed (or the "already exists" error, which names it too).
pub fn pr_from_output(text: &str) -> Option<(String, u64)> {
    text.split_whitespace().find_map(|word| {
        let rest = word.trim().strip_prefix("https://github.com/")?;
        let mut parts = rest.trim_end_matches('/').split('/');
        let (owner, name, pull, number) =
            (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
        (pull == "pull")
            .then(|| number.parse().ok())
            .flatten()
            .map(|n| (format!("{owner}/{name}").to_ascii_lowercase(), n))
    })
}

/// `refs/heads/main` and `main` are the same branch. Anything else is kept, so a caller can't
/// hide the base by spelling it as a full ref.
fn short_ref(name: &str) -> &str {
    let name = name.trim();
    name.strip_prefix("refs/heads/").unwrap_or(name)
}

fn default_base(checkout: &Path, remote: &str) -> String {
    git(
        checkout,
        &[
            "symbolic-ref",
            "--short",
            &format!("refs/remotes/{remote}/HEAD"),
        ],
    )
    .ok()
    .and_then(|r| r.split_once('/').map(|(_, b)| b.to_string()))
    .filter(|b| !b.is_empty())
    .unwrap_or_else(|| "main".into())
}

/// Who pushed. The person asked, from Deliver. A worker's chat did the push when
/// the work was delegated; otherwise the Mono, the first mate, or the app.
fn deliver_actor(row: Option<&delegations::Delegation>) -> crate::activity::Who {
    let Some(row) = row else {
        return crate::activity::Who::app();
    };
    if !row.child_session.is_empty() {
        return crate::activity::Who::worker(row.child_session.clone(), "");
    }
    if let Some(mono) = row.owner_mono.as_deref().filter(|mono| !mono.is_empty()) {
        return crate::activity::Who::mono(mono, "");
    }
    if !row.owner_session.is_empty() {
        return crate::activity::Who::first_mate(row.owner_session.clone(), "");
    }
    crate::activity::Who::app()
}

/// Delivers by the project's mode (module docs). Nothing is recorded when it refuses.
pub fn deliver(
    store: &SessionStore,
    gh: &dyn Github,
    mut input: DeliverInput,
    now: i64,
) -> Result<Delivery, String> {
    let project_key = settings::key(&input.project);
    let project = Path::new(&project_key).to_path_buf();
    let checkout = crate::fs::canonical(crate::fs::expand_home(input.checkout.trim()))
        .map_err(|e| format!("The worker's copy can't be opened: {e}"))?;
    if checkout == project {
        return Err(
            "The worker worked in the project's main checkout, so there is no copy to deliver."
                .into(),
        );
    }
    let row = match &input.delegation_id {
        Some(id) => delegations::tree(&*store.lock_conn()?, id)?
            .into_iter()
            .find(|row| &row.id == id),
        None => None,
    };
    if let Some(row) = &row {
        input.brief = input.brief.or_else(|| row.brief.clone());
        input.report = input.report.or_else(|| row.result.clone());
        input.title = input.title.or_else(|| row.title.clone());
    }
    // WP-81: the gate uses the crew's goal. The delivery row itself is unchanged.
    let gate_goal = row.as_ref().and_then(|row| row.goal.clone());
    let gate_owner = row.as_ref().map(|row| row.owner_session.clone());
    let gate_child = row.as_ref().map(|row| row.child_session.clone());
    let stored = settings::get(&*store.lock_conn()?, &project_key)?;
    let probe = settings::probe(&project, gh);
    let effective = settings::effective(stored, &probe);
    let mut delivery = Delivery {
        id: format!("dlv_{}", uuid::Uuid::new_v4().simple()),
        delegation_id: input.delegation_id.clone(),
        project: project_key.clone(),
        checkout: Some(checkout.to_string_lossy().into_owned()),
        mode: effective.mode.as_str().into(),
        state: String::new(),
        repo: None,
        number: None,
        url: None,
        branch: None,
        fix_rounds: 0,
        detail: None,
        created_at: now,
        updated_at: now,
    };
    let mut gated = false;
    match effective.mode {
        Mode::Local => {
            let landing = crate::land::land(&checkout, &project)?;
            delivery.state = if landing.outcome == "conflict" {
                CONFLICT
            } else {
                LANDED
            }
            .into();
            delivery.detail = Some(match landing.outcome.as_str() {
                "landed" => format!(
                    "Landed in the project (not committed): {}",
                    landing.files.join(", ")
                ),
                "already" => "The project already had these changes.".into(),
                "nothing" => "The worker changed no files.".into(),
                _ => format!(
                    "Not landed: it clashes with the project in {}. {}",
                    landing.files.join(", "),
                    landing.why
                ),
            });
        }
        Mode::Pr | Mode::CheckedPr => {
            // WP-81: with the check on, no-mistakes opens the pull request, so a missing GitHub sign-in is not a refusal.
            let gate_on = crate::delivery_gate::enabled(&*store.lock_conn()?, &project_key)?;
            if !gate_on {
                if let Some(why) = effective.blocked {
                    return Err(why);
                }
            }
            let remote = probe.remote.clone().unwrap_or_else(|| "origin".into());
            let repo = probe.github_repo.clone().unwrap_or_default();
            let branch = git(&checkout, &["rev-parse", "--abbrev-ref", "HEAD"])?;
            if branch == "HEAD" || branch.is_empty() {
                return Err(
                    "The worker's copy isn't on a branch, so there is nothing to push.".into(),
                );
            }
            let dirty = git(
                &checkout,
                &["status", "--porcelain", "--untracked-files=normal"],
            )?;
            if !dirty.is_empty() {
                return Err(format!(
                    "The worker left uncommitted changes in {}; a pull request carries commits only. Have it commit \
                     its work, then deliver again.",
                    checkout.display()
                ));
            }
            let default_branch = default_base(&checkout, &remote);
            let base = input
                .base
                .clone()
                .filter(|b| !b.trim().is_empty())
                .unwrap_or_else(|| default_branch.clone());
            // Pushing the base, or the remote's default, updates that branch directly and never
            // goes through the merge path. A worker's own branch is the only thing a PR mode pushes.
            let branch_name = short_ref(&branch);
            let base_name = short_ref(&base);
            let default_name = short_ref(&default_branch);
            if branch_name == base_name || branch_name == default_name {
                let which = if branch_name == base_name {
                    format!("the base branch ({base_name})")
                } else {
                    format!("the remote's default branch ({default_name})")
                };
                return Err(format!(
                    "{branch_name} is {which}, so delivering it would push onto {branch_name} and skip the merge path. Deliver from the worker's own branch."
                ));
            }
            let ahead = git(
                &checkout,
                &["rev-list", "--count", &format!("{remote}/{base}..HEAD")],
            )
            .or_else(|_| {
                git(
                    &checkout,
                    &["rev-list", "--count", &format!("{base}..HEAD")],
                )
            })
            .unwrap_or_default();
            if ahead == "0" {
                return Err(format!(
                    "{branch} has no commits beyond {base}, so there is nothing to deliver."
                ));
            }
            if gate_on {
                gated = true;
                let body = pr_body_with(
                    effective.mode,
                    input.brief.as_deref(),
                    input.report.as_deref(),
                    &input.phase_docs,
                );
                let title = input
                    .title
                    .clone()
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| branch.clone());
                let title: String = title
                    .lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(200)
                    .collect();
                // WP-200: the checked branch pushes and opens the pull request itself, so the guard runs first.
                crate::commit_guard::gate_outgoing_to(&checkout, &remote)
                    .map_err(|e| format!("Pushing {branch} refused: {e}"))?;
                let filled = crate::delivery_gate::fill(
                    store,
                    crate::delivery_gate::FillInput {
                        project: project_key.clone(),
                        checkout: checkout.clone(),
                        delegation_id: input.delegation_id.clone(),
                        goal: gate_goal.clone(),
                        brief: input.brief.clone(),
                        title,
                        body,
                        owner_session: gate_owner.clone(),
                        child_session: gate_child.clone(),
                        branch: branch.clone(),
                        now,
                    },
                )?;
                delivery.url = filled.url;
                delivery.repo = filled.repo;
                delivery.number = filled.number;
                // WP-77: a pull request opened through the gate stays linked to its task too.
                if let (Some(id), Some(repo), Some(number)) = (
                    delivery.delegation_id.clone(),
                    delivery.repo.clone(),
                    delivery.number,
                ) {
                    if let Ok(number) = i64::try_from(number) {
                        if let Ok(conn) = store.lock_conn() {
                            let _ = crate::github_issues::link_opened_pr(
                                &conn,
                                &id,
                                &repo,
                                number,
                                delivery.url.as_deref(),
                                now,
                            );
                        }
                    }
                }
                delivery.branch = Some(branch.clone());
                delivery.state = if filled.state == "passed" && effective.mode != Mode::CheckedPr {
                    READY
                } else {
                    CHECKING
                }
                .into();
                delivery.detail = filled.detail;
            } else {
                crate::commit_guard::gate_outgoing_to(&checkout, &remote)
                    .map_err(|e| format!("Pushing {branch} refused: {e}"))?;
                git(
                    &checkout,
                    &[
                        "push",
                        "--set-upstream",
                        &remote,
                        &format!("HEAD:refs/heads/{branch}"),
                    ],
                )
                .map_err(|e| format!("Pushing {branch} failed: {e}"))?;
                // WP-78: the push landed. A pull request that fails afterwards does not undo this line.
                if let Ok(conn) = store.lock_conn() {
                    crate::activity::note(
                        &conn,
                        crate::activity::PUSH,
                        &deliver_actor(row.as_ref()),
                        &crate::activity::Who::person(),
                        &project_key,
                        &branch,
                        &format!("Pushed {branch}."),
                        "",
                        now,
                    );
                }
                let body = pr_body_with(
                    effective.mode,
                    input.brief.as_deref(),
                    input.report.as_deref(),
                    &input.phase_docs,
                );
                let body_file =
                    std::env::temp_dir().join(format!("hivra-pr-body-{}.md", delivery.id));
                std::fs::write(&body_file, body).map_err(|e| e.to_string())?;
                let title = input
                    .title
                    .clone()
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| branch.clone());
                let title: String = title
                    .lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(200)
                    .collect();
                crate::commit_guard::gate_outgoing_to(&checkout, &remote)?;
                let created = gh.run(
                    Some(&checkout),
                    &[
                        "pr".into(),
                        "create".into(),
                        "--repo".into(),
                        repo.clone(),
                        "--head".into(),
                        branch.clone(),
                        "--base".into(),
                        base.clone(),
                        "--title".into(),
                        title,
                        "--body-file".into(),
                        body_file.to_string_lossy().into_owned(),
                    ],
                );
                let _ = std::fs::remove_file(&body_file);
                let printed = match created {
                    Ok(out) => out,
                    Err(error) if error.contains("already exists") => error,
                    Err(error) => {
                        return Err(format!("The pull request couldn't be opened: {error}"))
                    }
                };
                let (pr_repo, number) = pr_from_output(&printed).ok_or_else(|| {
                    format!(
                        "The pull request was opened, but its address couldn't be read: {printed}"
                    )
                })?;
                delivery.url = Some(format!("https://github.com/{pr_repo}/pull/{number}"));
                // WP-78: the pull request has an address, including one that was already open.
                if let Ok(conn) = store.lock_conn() {
                    crate::activity::note(
                        &conn,
                        crate::activity::PULL_REQUEST,
                        &deliver_actor(row.as_ref()),
                        &crate::activity::Who::person(),
                        &project_key,
                        &format!("{pr_repo}#{number}"),
                        &format!("Opened a pull request into {base}."),
                        delivery.url.as_deref().unwrap_or(""),
                        now,
                    );
                }
                // WP-77: the pull request the crew opens stays linked to its task. Merge completes it on the next read.
                if let Some(id) = delivery.delegation_id.clone() {
                    if let Ok(number) = i64::try_from(number) {
                        if let Ok(conn) = store.lock_conn() {
                            let _ = crate::github_issues::link_opened_pr(
                                &conn,
                                &id,
                                &pr_repo,
                                number,
                                delivery.url.as_deref(),
                                now,
                            );
                        }
                    }
                }
                delivery.repo = Some(pr_repo);
                delivery.number = Some(number);
                delivery.branch = Some(branch.clone());
                delivery.state = if effective.mode == Mode::CheckedPr {
                    CHECKING
                } else {
                    READY
                }
                .into();
                delivery.detail = Some(format!(
                    "Pushed {branch} and opened a pull request into {base}."
                ));
            }
        }
    }
    insert(&*store.lock_conn()?, &delivery)?;
    if gated {
        let marked = {
            let conn = store.lock_conn()?;
            mark_gate(&conn, &delivery.id)
        };
        if let Err(error) = marked {
            let conn = store.lock_conn()?;
            let _ = delete_row(&conn, &delivery.id);
            return Err(error);
        }
    }
    Ok(delivery)
}

/// The owner a delivered pull request's watch wakes: the chat that delegated the work.
pub fn owner_of(conn: &Connection, delivery: &Delivery) -> Result<Option<String>, String> {
    let Some(id) = &delivery.delegation_id else {
        return Ok(None);
    };
    Ok(delegations::tree(conn, id)?
        .into_iter()
        .find(|row| &row.id == id)
        .map(|row| row.owner_session))
}

#[cfg(test)]
mod phase_docs {
    use super::{pr_body, pr_body_with, PhaseLink};
    use crate::delivery::settings::Mode;

    #[test]
    fn a_phased_pull_request_links_its_documents_and_a_plain_one_does_not() {
        let plain = pr_body(Mode::Pr, Some("Fix it."), None);
        let same = pr_body_with(Mode::Pr, Some("Fix it."), None, &[]);
        assert_eq!(plain, same);
        assert!(!plain.contains("Phase documents"));
        let linked = pr_body_with(
            Mode::Pr,
            Some("Fix it."),
            None,
            &[
                PhaseLink {
                    title: "Research".into(),
                    href: "02-research.md".into(),
                },
                PhaseLink {
                    title: "Design".into(),
                    href: "03-design.md".into(),
                },
                PhaseLink {
                    title: " ".into(),
                    href: "nope.md".into(),
                },
            ],
        );
        assert!(linked.contains("[Research](02-research.md)"), "{linked}");
        assert!(linked.contains("[Design](03-design.md)"), "{linked}");
        assert!(!linked.contains("nope.md"), "{linked}");
        assert!(linked.contains("## Brief"), "{linked}");
    }
}
