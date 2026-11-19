//! What the PR watch reads, as delivery events: CI red, CI green, merged, closed. `pr_watch` hands each read here
//! (one small hook in its `apply`); each event is kept in `delivery_events` for WP-11's classifier and moves its
//! delivery along:
//!
//! | Delivery | Event | Becomes |
//! | --- | --- | --- |
//! | checking | CI green | ready |
//! | checking | CI red | fixing (fix round 1: the worker gets the failing log, `fix_ask`) |
//! | fixing | CI green | ready |
//! | fixing | CI red | failed (one fix round only; then the first mate decides) |
//! | any open one | merged | merged |
//! | any open one | closed | closed |
//!
//! A plain PR delivery is ready when it opens; CI news is still recorded for it.

use rusqlite::{params, Connection};
use serde::Serialize;

use super::deliver::{self, CHECKING, CLOSED, FAILED, FIXING, MERGED, READY};
use super::github::Github;
use crate::pr_watch::eval::{gate, Change, Check, CheckStatus};
use crate::pr_watch::github::{PrRead, PrState};

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    CiRed,
    CiGreen,
    Merged,
    Closed,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::CiRed => "ci-red",
            Kind::CiGreen => "ci-green",
            Kind::Merged => "merged",
            Kind::Closed => "closed",
        }
    }
}

/// One classified piece of news, before it is stored: `detail` names the failing checks (with their links).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct News {
    pub kind: Kind,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: i64,
    pub repo: String,
    pub number: u64,
    pub kind: String,
    pub head_sha: Option<String>,
    pub detail: Option<String>,
    pub delivery_id: Option<String>,
    pub created_at: i64,
}

fn checks_detail(checks: &[&Check]) -> String {
    checks
        .iter()
        .map(|check| match &check.url {
            Some(url) => format!("{} ({url})", check.name),
            None => check.name.clone(),
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// The pull request's current checks, as one piece of news. Pending checks, and a pull request
/// with no checks, are not news: it stays "checking" until something is actually green or red.
pub fn current(read: &PrRead) -> Option<News> {
    match read.state {
        PrState::Merged => Some(News {
            kind: Kind::Merged,
            detail: read.merge_sha.clone(),
        }),
        PrState::Closed => Some(News {
            kind: Kind::Closed,
            detail: None,
        }),
        PrState::Open => {
            let (checks, _) = gate(&read.detail.checks);
            let red: Vec<&Check> = checks
                .iter()
                .copied()
                .filter(|c| c.status.failed())
                .collect();
            if !red.is_empty() {
                return Some(News {
                    kind: Kind::CiRed,
                    detail: Some(checks_detail(&red)),
                });
            }
            if checks.is_empty() || checks.iter().any(|c| c.status == CheckStatus::Pending) {
                return None;
            }
            Some(News {
                kind: Kind::CiGreen,
                detail: None,
            })
        }
    }
}

fn settles(kind: Kind) -> bool {
    matches!(
        kind,
        Kind::CiRed | Kind::CiGreen | Kind::Merged | Kind::Closed
    )
}

/// A checked delivery's first look. The PR watch's later reads only report what changed, and its
/// first read is stored as already told, so a pull request that is already green or red would
/// otherwise stay "checking" forever.
pub fn include_current(news: &mut Vec<News>, read: &PrRead, state: &str) {
    if state != CHECKING || news.iter().any(|item| settles(item.kind)) {
        return;
    }
    if let Some(item) = current(read) {
        news.push(item);
    }
}

/// Applies [`current`] to a delivery that is still checking. Later reads go through [`include_current`].
pub fn note_current(
    conn: &Connection,
    repo: &str,
    number: u64,
    read: &PrRead,
    now: i64,
) -> Result<Vec<String>, String> {
    let Some(delivery) = deliver::by_pr(conn, repo, number)? else {
        return Ok(Vec::new());
    };
    let mut news = Vec::new();
    include_current(&mut news, read, &delivery.state);
    if news.is_empty() {
        return Ok(Vec::new());
    }
    record(
        conn,
        repo,
        number,
        read.detail.head_sha.as_deref(),
        &news,
        now,
    )
}

/// What one read says that delivery cares about. `changes` is the PR watch's report for an open pull request (none
/// when it merged or closed).
pub fn classify(read: &PrRead, changes: Option<&[Change]>) -> Vec<News> {
    match read.state {
        PrState::Merged => {
            return vec![News {
                kind: Kind::Merged,
                detail: read.merge_sha.clone(),
            }]
        }
        PrState::Closed => {
            return vec![News {
                kind: Kind::Closed,
                detail: None,
            }]
        }
        PrState::Open => {}
    }
    let mut news = Vec::new();
    for change in changes.unwrap_or_default() {
        match change {
            Change::ChecksFailed(checks) => news.push(News {
                kind: Kind::CiRed,
                detail: Some(checks_detail(&checks.iter().collect::<Vec<_>>())),
            }),
            Change::ChecksPassed { .. } => news.push(News {
                kind: Kind::CiGreen,
                detail: None,
            }),
            Change::Remarks(_)
            | Change::Conflicting
            | Change::BaseMoved { .. }
            | Change::Behind { .. } => {}
        }
    }
    news
}

/// The state a delivery moves to on `kind`, with its fix rounds; none when it stays.
pub fn next(state: &str, fix_rounds: i64, kind: Kind) -> Option<(&'static str, i64)> {
    let settled = matches!(state, MERGED | CLOSED);
    match kind {
        Kind::Merged if !settled => Some((MERGED, fix_rounds)),
        Kind::Closed if !settled => Some((CLOSED, fix_rounds)),
        Kind::CiGreen if matches!(state, CHECKING | FIXING) => Some((READY, fix_rounds)),
        Kind::CiRed if state == CHECKING && fix_rounds == 0 => Some((FIXING, 1)),
        Kind::CiRed if matches!(state, CHECKING | FIXING) => Some((FAILED, fix_rounds)),
        _ => None,
    }
}

/// Stores the news and moves the pull request's delivery along. Returns the ids of deliveries that changed.
pub fn record(
    conn: &Connection,
    repo: &str,
    number: u64,
    head_sha: Option<&str>,
    news: &[News],
    now: i64,
) -> Result<Vec<String>, String> {
    let repo = repo.to_ascii_lowercase();
    let mut changed = Vec::new();
    for item in news {
        let delivery = deliver::by_pr(conn, &repo, number)?;
        conn.execute(
            "INSERT INTO delivery_events (repo, number, kind, head_sha, detail, delivery_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                repo,
                number as i64,
                item.kind.as_str(),
                head_sha,
                item.detail,
                delivery.as_ref().map(|d| d.id.clone()),
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        let Some(delivery) = delivery else { continue };
        // WP-81: a pull request from the local check is repaired by that check, not by a fix crew.
        if item.kind == Kind::CiRed && deliver::through_gate(conn, &repo, number) {
            continue;
        }
        if let Some((state, rounds)) = next(&delivery.state, delivery.fix_rounds, item.kind) {
            let detail = match (item.kind, state) {
                (Kind::CiRed, FIXING) => Some(format!(
                    "Checks failed: {}. The worker gets one fix round with the log.",
                    item.detail.as_deref().unwrap_or("")
                )),
                (Kind::CiRed, _) => Some(format!(
                    "Checks failed again after the fix round: {}. Its first mate decides what next.",
                    item.detail.as_deref().unwrap_or("")
                )),
                (Kind::CiGreen, _) => Some("Its checks are green: ready for review.".into()),
                (Kind::Merged, _) => Some("Merged.".into()),
                (Kind::Closed, _) => Some("Closed without merging.".into()),
            };
            // The state we read is part of the write, so a later result that already moved the row is kept.
            if deliver::move_state(
                conn,
                &delivery.id,
                &delivery.state,
                delivery.fix_rounds,
                state,
                rounds,
                detail.as_deref(),
                now,
            )? {
                changed.push(delivery.id);
            }
        }
    }
    Ok(changed)
}

/// The events WP-11's classifier hasn't taken yet, oldest first.
pub fn open(conn: &Connection) -> Result<Vec<Event>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, repo, number, kind, head_sha, detail, delivery_id, created_at FROM delivery_events
             WHERE consumed_at IS NULL ORDER BY id LIMIT 500",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(Event {
                id: row.get(0)?,
                repo: row.get(1)?,
                number: row.get::<_, i64>(2)? as u64,
                kind: row.get(3)?,
                head_sha: row.get(4)?,
                detail: row.get(5)?,
                delivery_id: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn consume(conn: &Connection, ids: &[i64], now: i64) -> Result<usize, String> {
    let mut count = 0;
    for id in ids {
        count += conn
            .execute(
                "UPDATE delivery_events SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL",
                params![id, now],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(count)
}

/// The run id in a GitHub Actions link (`.../actions/runs/<id>/job/<job>`).
pub fn run_id(url: &str) -> Option<&str> {
    let rest = url.split("/actions/runs/").nth(1)?;
    let id = rest.split('/').next()?;
    (!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())).then_some(id)
}

const LOG_MAX: usize = 4_000;

/// The fix round's message for the worker: which checks failed, and the tail of each failing run's log
/// (`gh run view --log-failed`). Reads GitHub; call it outside any database lock.
pub fn fix_ask(gh: &dyn Github, repo: &str, number: u64) -> Result<String, String> {
    let read = gh.read_pr(repo, number)?;
    let (checks, _) = gate(&read.detail.checks);
    let red: Vec<_> = checks.into_iter().filter(|c| c.status.failed()).collect();
    if red.is_empty() {
        return Err(format!("{repo}#{number} has no failing checks now."));
    }
    let mut ask = format!(
        "[Hivra fix round] Checks failed on {repo}#{number}. This is your one fix round: fix what the log shows, run \
         the check yourself, commit and push to the same branch, then report again. If it is not something you can \
         fix, say so in your report.\n"
    );
    let mut seen = Vec::new();
    for check in red {
        ask.push_str(&format!("\n### {}\n", check.name));
        if let Some(url) = &check.url {
            ask.push_str(&format!("{url}\n"));
            if let Some(id) = run_id(url).filter(|id| !seen.contains(&id.to_string())) {
                seen.push(id.to_string());
                let args: Vec<String> = ["run", "view", id, "--repo", repo, "--log-failed"]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                if let Ok(log) = gh.run(None, &args) {
                    let tail: String = {
                        let chars: Vec<char> = log.chars().collect();
                        chars[chars.len().saturating_sub(LOG_MAX)..]
                            .iter()
                            .collect()
                    };
                    ask.push_str(&format!("```\n{}\n```\n", tail.trim()));
                }
            }
        }
    }
    Ok(ask)
}

// SC-6: property tests on the delivery event transitions (spec 4i).
#[cfg(test)]
#[path = "events_prop_tests.rs"]
mod prop_tests;
