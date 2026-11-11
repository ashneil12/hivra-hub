//! What changed on a watched pull request since the last read: the pure part of the watch.
//!
//! Ported from T3 Code's `evaluatePullRequestWatch` (apps/server/src/orchestration-v2/pullRequestWatch.ts).
//! Copyright (c) 2026 T3 Tools Inc. MIT License: permission is hereby granted, free of charge, to any person obtaining
//! a copy of this software and associated documentation files, to deal in the Software without restriction, subject to
//! including this copyright and permission notice; the software is provided "as is", without warranty of any kind.
//!
//! One change from T3: when the pull request has required checks, only a **required** check failing wakes the owner
//! (Ash's rule: "a required check failing, all required checks passing"). Without required checks every check counts,
//! as in T3.

use serde::{Deserialize, Serialize};

/// Wakes in a row that bring only comments. Check, conflict or push news resets the count, so this only stops a chatty
/// bot looping an agent that is replying to it.
pub const WAKE_LIMIT: u32 = 10;

/// What the watch remembers between reads (T3's `ThreadPullRequestWatch`). Every field defaults, so an older stored
/// memo reads with the new ones unset (WP-202: unset means unknown, and blocks nothing).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Memo {
    pub started_at: String,
    pub head_sha: Option<String>,
    /// The gate's failed checks already told.
    pub failed_checks: Vec<String>,
    pub passed: bool,
    /// The gate that passed when it was told.
    pub passed_checks: Vec<String>,
    /// Remarks up to this time were told (or came before the watch).
    pub remarks_through: String,
    /// Remarks at exactly `remarks_through` that were told, so a late one with the same second still counts.
    pub remark_ids: Vec<String>,
    pub conflicting: bool,
    /// Comment-only wakes in a row.
    pub wakes: u32,
    /// The base branch's tip the watch last judged (WP-202). A move from it is news when it touches the pull request.
    pub base_sha: Option<String>,
    /// The pull request's own changed files, read once per head: (head, files, cut short) (WP-202).
    pub pr_files: Option<(String, Vec<String>, bool)>,
    /// How far behind main the head was, read once per head and base: (head, base, commits) (WP-202).
    pub behind_at: Option<(String, String, u32)>,
    /// Base news already told, as "behind <head> <base>" or "dirty <head> <base>" (WP-202, the newest kept).
    pub told_base: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckStatus {
    Pending,
    Success,
    Failure,
    Cancelled,
    /// Finished, but it needs someone: the owner hears about it.
    ActionRequired,
    Skipped,
    Neutral,
}

impl CheckStatus {
    pub fn failed(self) -> bool {
        matches!(
            self,
            CheckStatus::Failure | CheckStatus::Cancelled | CheckStatus::ActionRequired
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    pub status: CheckStatus,
    pub url: Option<String>,
    pub required: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mergeability {
    Mergeable,
    Conflicting,
    /// GitHub is still working it out (after a push).
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemarkKind {
    Comment,
    Review,
    ReviewComment,
}

/// A comment, a review or a review comment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remark {
    pub id: String,
    pub kind: RemarkKind,
    pub author: Option<String>,
    pub body: String,
    pub created_at: String,
    pub edited_at: Option<String>,
    pub url: Option<String>,
    pub path: Option<String>,
    /// APPROVED, CHANGES_REQUESTED, COMMENTED (reviews only).
    pub review_state: Option<String>,
}

impl Remark {
    fn active_at(&self) -> &str {
        self.edited_at.as_deref().unwrap_or(&self.created_at)
    }
}

/// What one read says, as the evaluator needs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Detail {
    pub head_sha: Option<String>,
    pub checks: Vec<Check>,
    pub mergeability: Mergeability,
    /// Who `gh` is signed in as: their own remarks never wake them.
    pub viewer: Option<String>,
    pub author: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    ChecksFailed(Vec<Check>),
    ChecksPassed {
        count: usize,
        required: bool,
    },
    Remarks(Vec<Remark>),
    Conflicting,
    /// Main moved to `to` and changed `files` this pull request touches (WP-202). `cut_short`: the base compare
    /// listed only part of its files. `pull_cut`: the pull request's own file list was short. Either one leaves
    /// the overlap unknown, and `files` may be empty.
    BaseMoved {
        to: String,
        files: Vec<String>,
        cut_short: bool,
        pull_cut: bool,
    },
    /// The branch is behind main (WP-202): `commits` when GitHub counted them.
    Behind {
        commits: Option<u32>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub changes: Vec<Change>,
    pub next: Memo,
    /// The comment-only wake limit was reached: the watch ends after this wake.
    pub exhausted: bool,
}

/// Milliseconds since the epoch of an ISO 8601 time; 0 for one that doesn't parse.
pub fn millis(iso: &str) -> i64 {
    time::OffsetDateTime::parse(iso, &time::format_description::well_known::Rfc3339)
        .map(|t| (t.unix_timestamp_nanos() / 1_000_000) as i64)
        .unwrap_or(0)
}

/// The checks that decide: the required ones, or every check when none is required.
pub fn gate(checks: &[Check]) -> (Vec<&Check>, bool) {
    let required: Vec<&Check> = checks.iter().filter(|c| c.required).collect();
    if required.is_empty() {
        (checks.iter().collect(), false)
    } else {
        (required, true)
    }
}

pub fn evaluate(watch: &Memo, detail: &Detail, remarks: Option<&[Remark]>) -> Report {
    let mut changes = Vec::new();
    let head_sha = detail.head_sha.clone();
    let head_moved = head_sha != watch.head_sha;

    // An empty list keeps the last state: a host can answer with one when its check read fails.
    let mut failed_checks = if head_moved {
        Vec::new()
    } else {
        watch.failed_checks.clone()
    };
    let mut passed = !head_moved && watch.passed;
    let mut passed_checks = if head_moved {
        Vec::new()
    } else {
        watch.passed_checks.clone()
    };
    if !detail.checks.is_empty() {
        let (gate, required) = gate(&detail.checks);
        let failed: Vec<&Check> = gate.iter().copied().filter(|c| c.status.failed()).collect();
        let newly: Vec<Check> = failed
            .iter()
            .filter(|c| !failed_checks.contains(&c.name))
            .map(|c| (*c).clone())
            .collect();
        if !newly.is_empty() {
            changes.push(Change::ChecksFailed(newly));
        }
        failed_checks = failed.iter().map(|c| c.name.clone()).collect();

        let passed_now = gate
            .iter()
            .all(|c| c.status != CheckStatus::Pending && !c.status.failed());
        let names: Vec<String> = gate.iter().map(|c| c.name.clone()).collect();
        let told = if passed && passed_checks.is_empty() {
            names.clone()
        } else {
            passed_checks.clone()
        };
        // A required job created and finished between two reads is never seen pending. Without required checks, any
        // check counts, and advisory bots keep adding passed ones: no wake.
        let grew = required && names.iter().any(|name| !told.contains(name));
        if passed_now && (!passed || grew) {
            changes.push(Change::ChecksPassed {
                count: gate.len(),
                required,
            });
        }
        passed = passed_now;
        passed_checks = if passed_now { names } else { Vec::new() };
    }

    let own = detail
        .viewer
        .as_deref()
        .or(detail.author.as_deref())
        .map(str::to_lowercase);
    let through = millis(&watch.remarks_through);
    // GitHub times are per second, so remarks at the boundary time are told apart by id.
    let fresh: Vec<Remark> = remarks
        .unwrap_or(&[])
        .iter()
        .filter(|r| {
            let at = millis(r.active_at());
            (at > through || (at == through && !watch.remark_ids.contains(&r.id)))
                && r.author.as_deref().map(str::to_lowercase) != own
        })
        .cloned()
        .collect();
    let latest = fresh
        .iter()
        .map(|r| millis(r.active_at()))
        .fold(through, i64::max);
    let at_latest: Vec<&Remark> = fresh
        .iter()
        .filter(|r| millis(r.active_at()) == latest)
        .collect();
    let (remarks_through, remark_ids) = if latest == through {
        let mut ids = watch.remark_ids.clone();
        ids.extend(at_latest.iter().map(|r| r.id.clone()));
        (watch.remarks_through.clone(), ids)
    } else {
        (
            at_latest[0].active_at().to_string(),
            at_latest.iter().map(|r| r.id.clone()).collect(),
        )
    };
    if !fresh.is_empty() {
        changes.push(Change::Remarks(fresh));
    }

    if detail.mergeability == Mergeability::Conflicting && !watch.conflicting {
        changes.push(Change::Conflicting);
    }
    // Unknown is GitHub still computing after a push; only a clean answer clears a conflict.
    let conflicting = match detail.mergeability {
        Mergeability::Unknown => watch.conflicting,
        other => other == Mergeability::Conflicting,
    };

    let comments_only =
        !changes.is_empty() && changes.iter().all(|c| matches!(c, Change::Remarks(_)));
    let progress = head_moved || (!changes.is_empty() && !comments_only);
    let wakes = if progress { 0 } else { watch.wakes } + u32::from(comments_only);
    Report {
        changes,
        next: Memo {
            started_at: watch.started_at.clone(),
            head_sha,
            failed_checks,
            passed,
            passed_checks,
            remarks_through,
            remark_ids,
            conflicting,
            wakes,
            // The base fields are not this read's to change: they carry over, and `base::news` settles them.
            ..watch.clone()
        },
        exhausted: comments_only && wakes >= WAKE_LIMIT,
    }
}

/// The memo a new watch starts from: everything the pull request shows now counts as told, so registering never wakes
/// the owner about what it can already see (the registration's answer tells it instead). Comments up to the newest one
/// now count as told too, by GitHub's own clock, so a slow local clock can't hide a later one.
pub fn baseline(started_at: &str, detail: &Detail, remarks: &[Remark]) -> Memo {
    let start = Memo {
        started_at: started_at.to_string(),
        remarks_through: "1970-01-01T00:00:00Z".into(),
        ..Memo::default()
    };
    let mut next = evaluate(&start, detail, Some(remarks)).next;
    // The owner's own remarks are not in the evaluation; the newest of all is the line.
    if let Some(newest) = remarks.iter().max_by_key(|r| millis(r.active_at())) {
        let at = millis(newest.active_at());
        if at > millis(&next.remarks_through) {
            next.remarks_through = newest.active_at().to_string();
            next.remark_ids = remarks
                .iter()
                .filter(|r| millis(r.active_at()) == at)
                .map(|r| r.id.clone())
                .collect();
        }
    }
    next.wakes = 0;
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    const STARTED: &str = "2026-10-02T12:00:00.000Z";

    fn watch() -> Memo {
        Memo {
            started_at: STARTED.into(),
            remarks_through: STARTED.into(),
            ..Memo::default()
        }
    }

    fn check(name: &str, status: CheckStatus) -> Check {
        Check {
            name: name.into(),
            status,
            url: Some(format!("https://ci.example/{name}")),
            required: false,
        }
    }

    fn required(name: &str, status: CheckStatus) -> Check {
        Check {
            required: true,
            ..check(name, status)
        }
    }

    fn detail(checks: Vec<Check>) -> Detail {
        Detail {
            head_sha: Some("aaaaaaaaaa".into()),
            checks,
            mergeability: Mergeability::Mergeable,
            viewer: Some("agent-user".into()),
            author: Some("agent-user".into()),
        }
    }

    fn base() -> Detail {
        detail(vec![
            check("lint", CheckStatus::Success),
            check("test", CheckStatus::Pending),
        ])
    }

    fn remark(login: &str, created_at: &str, body: &str) -> Remark {
        Remark {
            id: format!("{login}-{created_at}"),
            kind: RemarkKind::ReviewComment,
            author: Some(login.into()),
            body: body.into(),
            created_at: created_at.into(),
            edited_at: None,
            url: Some(format!("https://github.com/o/r/pull/1#{login}")),
            path: Some("src/index.ts".into()),
            review_state: None,
        }
    }

    use CheckStatus::{Failure, Pending, Success};

    #[test]
    fn reports_each_failure_at_once_even_while_another_check_never_finishes() {
        let bot = check("CodeRabbit", Pending);
        let first = detail(vec![
            check("lint", Failure),
            check("test", Pending),
            bot.clone(),
        ]);
        let lint = evaluate(&watch(), &first, Some(&[]));
        assert_eq!(
            lint.changes,
            vec![Change::ChecksFailed(vec![check("lint", Failure)])]
        );
        assert!(evaluate(&lint.next, &first, Some(&[])).changes.is_empty());

        let second = detail(vec![check("lint", Failure), check("test", Failure), bot]);
        let test = evaluate(&lint.next, &second, Some(&[]));
        assert_eq!(
            test.changes,
            vec![Change::ChecksFailed(vec![check("test", Failure)])]
        );

        let rerun = evaluate(&test.next, &first, Some(&[]));
        assert_eq!(evaluate(&rerun.next, &second, Some(&[])).changes.len(), 1);

        let pushed = Detail {
            head_sha: Some("bbbbbbbbbb".into()),
            ..second
        };
        assert_eq!(evaluate(&test.next, &pushed, Some(&[])).changes.len(), 1);
    }

    #[test]
    fn with_required_checks_only_a_required_failure_wakes() {
        let advisory = detail(vec![
            required("build", Pending),
            check("coverage-bot", Failure),
        ]);
        let quiet = evaluate(&watch(), &advisory, Some(&[]));
        assert!(quiet.changes.is_empty(), "{:?}", quiet.changes);
        let red = detail(vec![
            required("build", Failure),
            check("coverage-bot", Failure),
        ]);
        assert_eq!(
            evaluate(&quiet.next, &red, Some(&[])).changes,
            vec![Change::ChecksFailed(vec![required("build", Failure)])]
        );
    }

    #[test]
    fn reports_passed_once_the_required_checks_pass_whatever_the_others_do() {
        let green = detail(vec![
            required("test", Success),
            required("lint", Success),
            check("bot", Pending),
        ]);
        let passed = evaluate(&watch(), &green, Some(&[]));
        assert_eq!(
            passed.changes,
            vec![Change::ChecksPassed {
                count: 2,
                required: true
            }]
        );
        assert!(evaluate(&passed.next, &green, Some(&[])).changes.is_empty());

        let plain = detail(vec![check("test", Success), check("bot", Pending)]);
        assert!(evaluate(&watch(), &plain, Some(&[])).changes.is_empty());
    }

    #[test]
    fn reports_passed_again_when_a_required_check_shows_up_already_passed() {
        let tests = detail(vec![
            required("Tests", Success),
            check("Smoke Tests", Pending),
        ]);
        let first = evaluate(&watch(), &tests, Some(&[]));
        assert_eq!(
            first.changes,
            vec![Change::ChecksPassed {
                count: 1,
                required: true
            }]
        );
        let gated = detail(vec![
            required("Tests", Success),
            check("Smoke Tests", Success),
            required("Smoke Tests Gate", Success),
        ]);
        let second = evaluate(&first.next, &gated, Some(&[]));
        assert_eq!(
            second.changes,
            vec![Change::ChecksPassed {
                count: 2,
                required: true
            }]
        );
        assert!(evaluate(&second.next, &gated, Some(&[])).changes.is_empty());

        let pending = detail(vec![
            required("Tests", Success),
            required("Smoke Tests Gate", Pending),
        ]);
        let waiting = evaluate(&first.next, &pending, Some(&[]));
        assert!(waiting.changes.is_empty());
        assert_eq!(
            evaluate(&waiting.next, &gated, Some(&[])).changes,
            vec![Change::ChecksPassed {
                count: 2,
                required: true
            }]
        );
    }

    #[test]
    fn does_not_report_passed_again_for_a_new_passed_check_where_none_is_required() {
        let first = evaluate(&watch(), &detail(vec![check("test", Success)]), Some(&[]));
        assert_eq!(
            first.changes,
            vec![Change::ChecksPassed {
                count: 1,
                required: false
            }]
        );
        let both = detail(vec![check("test", Success), check("lint", Success)]);
        assert!(evaluate(&first.next, &both, Some(&[])).changes.is_empty());
    }

    #[test]
    fn does_not_wake_a_watch_saved_before_passed_checks_were_recorded() {
        let green = detail(vec![required("test", Success)]);
        let told = Memo {
            head_sha: Some("aaaaaaaaaa".into()),
            passed: true,
            ..watch()
        };
        let saved = evaluate(&told, &green, Some(&[]));
        assert!(saved.changes.is_empty());
        assert_eq!(saved.next.passed_checks, vec!["test".to_string()]);
    }

    #[test]
    fn keeps_remarks_for_a_later_pass_when_the_conversation_was_not_read_whole() {
        let comments = [remark(
            "reviewer",
            "2026-10-02T12:06:00Z",
            "Please rename this.",
        )];
        let partial = evaluate(&watch(), &base(), None);
        assert!(partial.changes.is_empty());
        assert!(matches!(
            evaluate(&partial.next, &base(), Some(&comments)).changes[0],
            Change::Remarks(_)
        ));
    }

    #[test]
    fn reports_a_remark_that_shows_up_late_with_the_same_time_as_a_reported_one() {
        let first = remark("reviewer", "2026-10-02T12:06:00Z", "Please rename this.");
        let late = Remark {
            id: "late".into(),
            ..remark("bot", "2026-10-02T12:06:00Z", "Please rename this.")
        };
        let reported = evaluate(&watch(), &base(), Some(std::slice::from_ref(&first)));
        let again = evaluate(
            &reported.next,
            &base(),
            Some(&[first.clone(), late.clone()]),
        );
        assert_eq!(again.changes, vec![Change::Remarks(vec![late])]);
        assert_eq!(again.next.remark_ids, vec![first.id, "late".to_string()]);
    }

    #[test]
    fn reports_edits_after_the_watermark_once_and_counts_them_toward_the_wake_limit() {
        let old = remark(
            "greptile[bot]",
            "2026-10-02T11:00:00Z",
            "Please rename this.",
        );
        let watching = Memo {
            head_sha: Some("aaaaaaaaaa".into()),
            remark_ids: vec![old.id.clone()],
            wakes: WAKE_LIMIT - 1,
            ..watch()
        };
        assert!(
            evaluate(&watching, &base(), Some(std::slice::from_ref(&old)))
                .changes
                .is_empty()
        );
        let edited = Remark {
            edited_at: Some("2026-10-02T12:06:00Z".into()),
            ..old.clone()
        };
        let report = evaluate(&watching, &base(), Some(std::slice::from_ref(&edited)));
        assert_eq!(report.changes, vec![Change::Remarks(vec![edited.clone()])]);
        assert_eq!(report.next.remarks_through, "2026-10-02T12:06:00Z");
        assert_eq!(report.next.remark_ids, vec![old.id.clone()]);
        assert!(report.exhausted);
        assert!(
            evaluate(&report.next, &base(), Some(std::slice::from_ref(&edited)))
                .changes
                .is_empty()
        );
        let late = Remark {
            id: "late".into(),
            ..edited.clone()
        };
        assert_eq!(
            evaluate(&report.next, &base(), Some(&[edited, late.clone()])).changes,
            vec![Change::Remarks(vec![late])]
        );
    }

    #[test]
    fn does_not_treat_a_failed_check_read_as_a_rerun() {
        let failed = detail(vec![check("lint", Failure)]);
        let reported = evaluate(&watch(), &failed, Some(&[]));
        assert_eq!(reported.changes.len(), 1);
        let unreadable = evaluate(&reported.next, &detail(vec![]), Some(&[]));
        assert!(evaluate(&unreadable.next, &failed, Some(&[]))
            .changes
            .is_empty());
    }

    #[test]
    fn wakes_for_the_pull_requests_author_when_the_agent_is_someone_else() {
        let contributor = Detail {
            author: Some("contributor".into()),
            ..base()
        };
        let reply = remark("contributor", "2026-10-02T12:06:00Z", "Thanks");
        assert_eq!(
            evaluate(&watch(), &contributor, Some(std::slice::from_ref(&reply))).changes,
            vec![Change::Remarks(vec![reply.clone()])]
        );
        let no_viewer = Detail {
            viewer: None,
            ..contributor
        };
        assert!(evaluate(&watch(), &no_viewer, Some(&[reply]))
            .changes
            .is_empty());
    }

    #[test]
    fn reports_remarks_from_others_once_and_never_the_agents_own() {
        let comments = [
            remark(
                "agent-user",
                "2026-10-02T12:05:00Z",
                "Fixed in the latest push.",
            ),
            remark(
                "macroscope-app[bot]",
                "2026-10-02T12:06:00Z",
                "Please rename this.",
            ),
            remark("reviewer", "2026-10-02T11:00:00Z", "Older than the watch."),
        ];
        let report = evaluate(&watch(), &base(), Some(&comments));
        assert_eq!(
            report.changes,
            vec![Change::Remarks(vec![comments[1].clone()])]
        );
        assert_eq!(report.next.remarks_through, "2026-10-02T12:06:00Z");
        assert!(evaluate(&report.next, &base(), Some(&comments))
            .changes
            .is_empty());
    }

    #[test]
    fn reports_a_conflict_once_until_the_branch_is_clean_again() {
        let conflicting = Detail {
            mergeability: Mergeability::Conflicting,
            ..base()
        };
        let first = evaluate(&watch(), &conflicting, Some(&[]));
        assert_eq!(first.changes, vec![Change::Conflicting]);
        let recomputing = evaluate(
            &first.next,
            &Detail {
                mergeability: Mergeability::Unknown,
                ..base()
            },
            Some(&[]),
        );
        assert!(evaluate(&recomputing.next, &conflicting, Some(&[]))
            .changes
            .is_empty());
        let clean = evaluate(&first.next, &base(), Some(&[]));
        assert_eq!(
            evaluate(&clean.next, &conflicting, Some(&[])).changes,
            vec![Change::Conflicting]
        );
    }

    #[test]
    fn does_not_spend_the_comment_wake_limit_on_check_results() {
        let tired = Memo {
            head_sha: Some("aaaaaaaaaa".into()),
            wakes: WAKE_LIMIT - 1,
            ..watch()
        };
        let result = evaluate(&tired, &detail(vec![check("lint", Failure)]), Some(&[]));
        assert!(!result.exhausted);
        assert_eq!(result.next.wakes, 0);
    }

    #[test]
    fn stops_after_the_wake_limit_unless_the_head_moves() {
        let comments = [remark(
            "reviewer",
            "2026-10-02T12:10:00Z",
            "Please rename this.",
        )];
        let tired = Memo {
            head_sha: Some("aaaaaaaaaa".into()),
            wakes: WAKE_LIMIT - 1,
            ..watch()
        };
        assert!(evaluate(&tired, &base(), Some(&comments)).exhausted);
        let pushed = evaluate(
            &tired,
            &Detail {
                head_sha: Some("cccccccccc".into()),
                ..base()
            },
            Some(&comments),
        );
        assert!(!pushed.exhausted);
        assert_eq!(pushed.next.wakes, 1);
    }

    #[test]
    fn a_baseline_counts_what_is_there_now_as_told() {
        let now = detail(vec![required("build", Failure), required("lint", Pending)]);
        let comments = [
            remark("reviewer", "2026-10-02T11:00:00Z", "Old"),
            remark("agent-user", "2026-10-02T11:30:00Z", "Mine, newest"),
        ];
        let memo = baseline(STARTED, &now, &comments);
        assert_eq!(memo.failed_checks, vec!["build".to_string()]);
        assert_eq!(memo.remarks_through, "2026-10-02T11:30:00Z");
        assert_eq!(memo.wakes, 0);
        // Nothing new: no wake. A reviewer's later comment wakes.
        assert!(evaluate(&memo, &now, Some(&comments)).changes.is_empty());
        let later = remark("reviewer", "2026-10-02T11:31:00Z", "New");
        let mut more = comments.to_vec();
        more.push(later.clone());
        assert_eq!(
            evaluate(&memo, &now, Some(&more)).changes,
            vec![Change::Remarks(vec![later])]
        );
    }
}
