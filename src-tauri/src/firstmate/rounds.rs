//! SC-5: the round cap and the rethink (docs/specs/shipping-confidence-gap-spec.md section 4d.4).
//!
//! Until now a failed round went back to the worker once, and a second failure ended the task with the raw findings. The
//! same kind of finding could come back every round with nothing looking at that. Now a task keeps a small ledger of its
//! rounds (on its gate records), and what happens after a failed round comes from it:
//!
//! | Failed rounds so far | What happens |
//! | --- | --- |
//! | 1 | The findings go back to the worker, numbered, so it can dismiss one on a named ground (`dismissals`). |
//! | 2 | The raw findings stop. One step on the strongest model of the checker's family reads the brief, the findings of both rounds and the diff, and answers REWRITE (a new brief built around the one rule the work keeps breaking, stated in its first line, sent to the worker as the next round) or UP (a two-line summary to the first mate as a new turn). |
//! | the next failure after that | One decision in Needs you: what keeps failing, and the choice of sending it back once more, accepting it as it is, or stopping it. |
//!
//! The method (two failed rounds, then a stronger model that rewrites the brief around a stated rule or hands the work up, and
//! a ledger) is from wp-orchestration's round handling, which keeps it in prose; the code and the wording are Hivra's own.
//! A rethink that can't run (no checker signed in, a call that fails, an answer that can't be read) hands the work up with
//! the findings the code has: an unreachable model is not a verdict on the task.

use serde::{Deserialize, Serialize};

use super::checker::CheckerRecord;
use super::dismissals::Dismissed;
use super::gates::{self, GateRecord, Runners, Verdict};

/// A task's failed rounds before the raw findings stop going back and a rethink runs.
pub const FAILED_BEFORE_RETHINK: usize = 2;
/// The rows of the ledger kept on a record.
const LEDGER_KEPT: usize = 8;
/// The problems kept per row, and the longest one.
const PROBLEMS_PER_ROW: usize = 8;
const PROBLEM_MAX: usize = 240;
/// The longest brief, summary line and rule a rethink may give back.
const BRIEF_MAX: usize = 6_000;
const LINE_MAX: usize = 300;

/// The choices the person is given when a task has failed past its rethink.
pub const PERSON_OPTIONS: [&str; 3] = ["Send it back once more", "Accept it as it is", "Stop it"];

/// What the app does after a failed round.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StepKind {
    /// The numbered findings go back to the worker.
    SendBack,
    /// A new brief goes to the worker as the next round.
    Rewrite,
    /// A two-line summary goes to the first mate as a new turn.
    Up,
    /// One decision goes to the person, in Needs you.
    Person,
}

/// What `next_step` decides before a rethink has answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    SendBack,
    Rethink,
    Person,
}

/// What to do after a failed round. `failed` counts the failed rounds on the task, this one included; `rethought` is
/// whether a rethink already answered. Any failure after a rethink goes to the person, however few rounds came before.
pub fn next_step(failed: usize, rethought: bool) -> Step {
    if rethought {
        Step::Person
    } else if failed >= FAILED_BEFORE_RETHINK {
        Step::Rethink
    } else {
        Step::SendBack
    }
}

// ---- the ledger ----------------------------------------------------------------------------------------------------------

/// One round of a task, as the ledger keeps it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerRow {
    pub round: u32,
    pub at: i64,
    pub verdict: Verdict,
    /// What the round found, one plain line each, in the order the worker was shown them.
    #[serde(default)]
    pub problems: Vec<String>,
    /// What the app did next. None: nothing (a pass, or an unsure round).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<StepKind>,
}

/// A task's rounds, oldest first.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ledger {
    pub rows: Vec<LedgerRow>,
}

fn clip(text: &str, max: usize) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

/// The row a record makes.
pub fn row_of(record: &GateRecord) -> LedgerRow {
    LedgerRow {
        round: record.round,
        at: record.at,
        verdict: record.verdict,
        problems: record
            .problems()
            .iter()
            .take(PROBLEMS_PER_ROW)
            .map(|problem| clip(problem, PROBLEM_MAX))
            .collect(),
        step: None,
    }
}

impl Ledger {
    /// The ledger the newest of a task's earlier records carries. A task from before the ledger has none: its rows are read
    /// off the records themselves, so its earlier failures still count.
    pub fn carried(records: &[GateRecord]) -> Ledger {
        if let Some(rows) = records
            .iter()
            .rev()
            .map(|record| &record.extras.ledger)
            .find(|rows| !rows.is_empty())
        {
            return Ledger { rows: rows.clone() };
        }
        Ledger {
            rows: records.iter().map(row_of).collect(),
        }
    }

    /// Adds a round. A round already there under the same number (two windows ran it, or it was run again) is replaced,
    /// never counted twice. Only the newest rows are kept.
    pub fn push(&mut self, row: LedgerRow) {
        match self.rows.iter_mut().find(|have| have.round == row.round) {
            Some(have) => *have = row,
            None => self.rows.push(row),
        }
        self.rows.sort_by_key(|row| row.round);
        if self.rows.len() > LEDGER_KEPT {
            let extra = self.rows.len() - LEDGER_KEPT;
            self.rows.drain(..extra);
        }
    }

    /// The failed rounds. An unsure round is not one: it never used a fix round.
    pub fn failed(&self) -> usize {
        self.rows
            .iter()
            .filter(|row| row.verdict == Verdict::Failed)
            .count()
    }

    /// Whether a rethink already answered (a rewrite or a hand-up).
    pub fn rethought(&self) -> bool {
        self.rows
            .iter()
            .any(|row| matches!(row.step, Some(StepKind::Rewrite | StepKind::Up)))
    }

    /// The round whose findings the worker's next report answers: the newest that failed.
    pub fn last_problems(&self) -> Vec<String> {
        self.rows
            .iter()
            .rev()
            .find(|row| row.verdict == Verdict::Failed)
            .map(|row| row.problems.clone())
            .unwrap_or_default()
    }

    /// The rule a rewrite named, when one did.
    pub fn rule(&self, records: &[GateRecord]) -> Option<String> {
        records
            .iter()
            .rev()
            .filter_map(|record| record.extras.next.as_ref())
            .find(|next| next.kind == StepKind::Rewrite)
            .and_then(|next| next.rule.clone())
    }

    /// What the next round's checker and dismissals read of this task's past.
    pub fn history(&self, records: &[GateRecord]) -> RoundHistory {
        RoundHistory {
            last_problems: self.last_problems(),
            rule: self.rule(records),
        }
    }
}

/// What a round reads of the task's earlier rounds.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RoundHistory {
    /// The numbered findings of the round the worker is answering, in the order the worker was shown them: what a
    /// `Dismiss <n>:` line names (`dismissals`).
    pub last_problems: Vec<String>,
    /// The one rule a rewrite named, when the brief was rewritten around one.
    pub rule: Option<String>,
}

// ---- what the app does next ----------------------------------------------------------------------------------------------

/// What the app does after a failed round, and what it says.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NextStep {
    pub kind: StepKind,
    /// `Rewrite`: the message that goes to the worker (its new brief). `Up`: the two-line summary the first mate hears.
    /// `Person`: what the first mate is told while the person decides. `SendBack`: empty (the findings are the summary).
    #[serde(default)]
    pub text: String,
    /// `Rewrite`: the one rule the work keeps breaking, from the new brief's first line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    /// The model that decided it: `Claude (opus)`. None: the code did (a hand-up when no rethink could run).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    /// `Person`: the key of the decision in Needs you. None when it could not be raised.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
}

impl NextStep {
    pub fn send_back() -> NextStep {
        NextStep {
            kind: StepKind::SendBack,
            text: String::new(),
            rule: None,
            by: None,
            decision: None,
        }
    }
}

/// What a round adds to a record beyond the cheap check's: the running checker's part, the findings the worker dismissed,
/// the task's ledger and what happens next. It sits flat on the record's JSON.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoundExtras {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checker: Option<CheckerRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dismissed: Vec<Dismissed>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ledger: Vec<LedgerRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<NextStep>,
}

// ---- the rethink ---------------------------------------------------------------------------------------------------------

/// What the rethink answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rethink {
    /// A new brief, built around one rule. `rule` is its first line.
    Rewrite { rule: String, brief: String },
    /// Two plain lines for the first mate.
    Up { summary: String },
}

/// The rethink's prompt: the brief, what both rounds found and the diff, and what to answer.
pub fn rethink_prompt(brief: &str, done_when: &str, ledger: &Ledger, diff: &str) -> String {
    let rounds: Vec<String> = ledger
        .rows
        .iter()
        .filter(|row| row.verdict == Verdict::Failed)
        .map(|row| {
            let problems = if row.problems.is_empty() {
                "- (a gate failed; no finding was written)".to_string()
            } else {
                row.problems
                    .iter()
                    .map(|problem| format!("- {problem}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            format!("Round {}:\n{problems}", row.round)
        })
        .collect();
    format!(
        "A worker's task has failed the checker twice. You are the rethink step, on the strongest model, and you have no tools. \
         Read the brief, what both rounds found and the diff, and find the ONE rule the work keeps breaking. Then answer with \
         REWRITE or UP on the first line, and nothing before it.\n\n\
         REWRITE: then a new brief for the worker, built around that one rule, stated in the new brief's first line. After it: \
         what to do, the definition of done, and what not to repeat. Do not paste the raw findings.\n\
         UP: then exactly two lines for the first mate: what keeps failing, and what you suggest. Use UP when the brief itself is \
         wrong or contradicts itself, when the work needs a decision that is not the worker's, or when no rule explains the \
         failures.\n\n\
         ## Brief\n{}\n\n## Definition of done\n{}\n\n## What the failed rounds found\n{}\n\n## Diff\n{}",
        gates::head_of(brief.trim(), BRIEF_MAX),
        done_when.trim(),
        if rounds.is_empty() {
            "(nothing was recorded)".to_string()
        } else {
            rounds.join("\n\n")
        },
        if diff.trim().is_empty() {
            "(no diff)"
        } else {
            diff
        },
    )
}

/// The word a line starts with, with the marks a model puts round it taken off: `**REWRITE**:`, `# Up`, `` `UP` ``.
fn first_word(line: &str) -> (String, &str) {
    let line = line.trim().trim_start_matches(['#', '*', '`', '>', ' ']);
    let end = line
        .find(|c: char| !c.is_ascii_alphabetic())
        .unwrap_or(line.len());
    let (word, rest) = line.split_at(end);
    (word.to_ascii_uppercase(), rest)
}

/// The rethink's answer: REWRITE or UP on the first non-empty line, then the body. A first line that is neither, or a body
/// with nothing in it, is no answer (`None`): the caller hands the work up with what the code has.
pub fn parse_rethink(said: &str) -> Option<Rethink> {
    let mut lines = said.lines().skip_while(|line| line.trim().is_empty());
    let first = lines.next()?;
    let (word, rest) = first_word(first);
    if word != "REWRITE" && word != "UP" {
        return None;
    }
    // What follows the word on its own line, after any mark, is the body's first line.
    let rest = rest
        .trim_start_matches(|c: char| c.is_whitespace() || matches!(c, ':' | '-' | '*' | '`' | '.'))
        .trim_end_matches(['*', '`']);
    let mut body: Vec<&str> = Vec::new();
    if !rest.trim().is_empty() {
        body.push(rest.trim());
    }
    body.extend(lines);
    let body: Vec<&str> = {
        // Leading blank lines are not the body.
        let start = body.iter().position(|l| !l.trim().is_empty())?;
        body[start..].to_vec()
    };
    if word == "UP" {
        let summary: Vec<String> = body
            .iter()
            .map(|line| clip(line.trim_start_matches(['-', '*', ' ']), LINE_MAX))
            .filter(|line| !line.is_empty())
            .take(2)
            .collect();
        if summary.is_empty() {
            return None;
        }
        return Some(Rethink::Up {
            summary: summary.join("\n"),
        });
    }
    let brief = gates::head_of(body.join("\n").trim(), BRIEF_MAX);
    let rule_line = body.iter().find(|line| !line.trim().is_empty())?;
    let rule = clip(
        rule_line
            .trim()
            .trim_start_matches(['#', '*', ' '])
            .trim_start_matches("Rule:")
            .trim_start_matches("rule:")
            .trim(),
        LINE_MAX,
    );
    if rule.is_empty() {
        return None;
    }
    Some(Rethink::Rewrite { rule, brief })
}

/// What the worker is sent as its next round after a rewrite.
pub fn rewrite_message(brief: &str) -> String {
    format!(
        "[MonoCode check] The same kind of problem failed two rounds in a row, so the raw findings stop here. A stronger model read \
         both rounds and rewrote your brief around the one rule your work keeps breaking: it is the first line below. Work from \
         this brief now. It runs from outside your copy, so the checks can't be edited to pass. Then report done again, ending with \
         your self-review as before.\n\n{brief}"
    )
}

/// What the first mate hears as a new turn after a hand-up.
pub fn up_message(summary: &str, rounds: usize) -> String {
    format!(
        "The checker failed this task {rounds} times and a stronger model handed it to you instead of sending the findings back \
         again:\n{summary}"
    )
}

/// A hand-up the code writes when no rethink could run: what failed, and what the rounds kept finding.
pub fn up_by_code(ledger: &Ledger, why: &str) -> String {
    let last = ledger
        .rows
        .iter()
        .rev()
        .find(|row| row.verdict == Verdict::Failed && !row.problems.is_empty());
    let kept = last
        .map(|row| clip(&row.problems.join(" "), LINE_MAX))
        .unwrap_or_else(|| "no finding was written".to_string());
    format!(
        "It failed {} rounds, and the rethink step couldn't run ({}).\nThe last round found: {kept}",
        ledger.failed(),
        clip(why, 120)
    )
}

/// What the first mate is told while a decision waits for the person.
pub fn person_note(question: &str) -> String {
    format!(
        "The task failed again after its rethink, so it is the person's call, not yours: a decision is open in Needs you \
         (\"{}\"). Don't accept or refuse it yet; you will hear their answer.",
        clip(question, 160)
    )
}

/// The question the person is asked: what keeps failing, in one paragraph.
pub fn person_question(title: &str, ledger: &Ledger) -> String {
    let kept = ledger
        .rows
        .iter()
        .rev()
        .find(|row| row.verdict == Verdict::Failed && !row.problems.is_empty())
        .map(|row| clip(&row.problems.join(" "), 400))
        .unwrap_or_else(|| "the checker gave no written finding".to_string());
    let title = clip(title, 80);
    format!(
        "\"{title}\" has failed the checker {} times, even after its brief was rewritten. What keeps failing: {kept} \
         What should happen?",
        ledger.failed()
    )
}

/// The key of a task's person decision: one per failed round, so a second ask after "send it back once more" is a new
/// decision, and the same ask twice is one.
pub fn decision_key(delegation_id: &str, round: u32) -> String {
    format!("checker/{delegation_id}/r{round}")
}

/// Raises the one decision in Needs you for a task that failed again after its rethink, and says what the first mate is told
/// meanwhile. The key holds the task and the round, so the same round asked twice is one decision and a later round (after
/// "send it back once more" failed too) is a new one. The first mate is the asker, so the person's answer reaches it as a
/// new turn; a chat below a first mate can't ask, and the decision is then filed by the gate and nobody is told the answer.
/// A task with no project has nowhere to file a decision: the first mate is told to ask the person itself. Whatever fails,
/// the first mate is told in plain words and the task is never settled as failed behind the person's back.
pub fn raise_decision(
    conn: &mut rusqlite::Connection,
    row: &crate::delegations::Delegation,
    round: u32,
    ledger: &Ledger,
    now: i64,
) -> NextStep {
    let question = person_question(row.title.as_deref().unwrap_or("This task"), ledger);
    let key = decision_key(&row.id, round);
    let unfiled = |why: &str| {
        NextStep {
        kind: StepKind::Person,
        text: format!(
            "The task failed again after its rethink, so it is the person's call, not yours. No decision could be filed in \
             Needs you ({why}): ask the person yourself, and don't accept or refuse it before they answer. {question}"
        ),
        rule: None,
        by: None,
        decision: None,
    }
    };
    let Some(project) = row
        .project
        .clone()
        .filter(|project| !project.trim().is_empty())
    else {
        return unfiled("it has no project");
    };
    let can_ask =
        crate::delegations::depth_above(conn, &row.owner_session).is_ok_and(|depth| depth == 0);
    let asked = crate::decisions::ask(
        conn,
        crate::decisions::AskInput {
            asked_by: if can_ask {
                row.owner_session.clone()
            } else {
                "gate".to_string()
            },
            asked_by_mono: row.owner_mono.clone(),
            project: Some(project),
            key: key.clone(),
            question: question.clone(),
            options: PERSON_OPTIONS
                .iter()
                .map(|option| option.to_string())
                .collect(),
            recommended: None,
            task_ids: Vec::new(),
            keys: Vec::new(),
            force: false,
            reason: None,
        },
        now,
    );
    match asked {
        Ok(_) => NextStep {
            kind: StepKind::Person,
            text: person_note(&question),
            rule: None,
            by: None,
            decision: Some(key),
        },
        Err(why) => unfiled(&clip(&why, 160)),
    }
}

/// What the app does after `record` failed (or didn't), from the task's earlier rounds. The rethink's model call runs here
/// when this is the second failure; its answer, or why it could not answer, becomes the step. The person's decision is not
/// raised here (it needs the store): the step says `Person` and the caller raises it (`raise_decision`).
pub struct Planned {
    pub ledger: Ledger,
    pub next: Option<NextStep>,
}

#[allow(clippy::too_many_arguments)]
pub fn plan_next(
    record: &GateRecord,
    prior: &[GateRecord],
    delegation_id: &str,
    brief: &str,
    done_when: &str,
    diff: &str,
    runners: &dyn Runners,
) -> Planned {
    let mut ledger = Ledger::carried(prior);
    ledger.push(row_of(record));
    if record.verdict != Verdict::Failed {
        return Planned { ledger, next: None };
    }
    let next = match next_step(ledger.failed(), ledger.rethought()) {
        Step::SendBack => NextStep::send_back(),
        Step::Person => NextStep {
            kind: StepKind::Person,
            text: String::new(),
            rule: None,
            by: None,
            decision: None,
        },
        Step::Rethink => rethink(&ledger, delegation_id, brief, done_when, diff, runners),
    };
    if let Some(row) = ledger.rows.iter_mut().find(|row| row.round == record.round) {
        row.step = Some(next.kind);
    }
    Planned {
        ledger,
        next: Some(next),
    }
}

#[cfg(test)]
#[path = "rounds_tests.rs"]
mod tests;

/// The rethink step: one call on the strongest model of the checker's family. Whatever goes wrong, the work is handed up.
fn rethink(
    ledger: &Ledger,
    delegation_id: &str,
    brief: &str,
    done_when: &str,
    diff: &str,
    runners: &dyn Runners,
) -> NextStep {
    let rounds = ledger.failed();
    // No rethink could answer: the first mate gets what the code knows, in plain words, and not a verdict on the task.
    let hand_up = |why: &str, by: Option<String>| {
        NextStep {
        kind: StepKind::Up,
        text: format!(
            "The checker failed this task {rounds} times, so its raw findings stop going back to the worker.\n{}",
            up_by_code(ledger, why)
        ),
        rule: None,
        by,
        decision: None,
    }
    };
    let pick = match runners.checker_pick(delegation_id) {
        Ok(pick) => pick,
        Err(why) => return hand_up(&why, None),
    };
    let by = Some(format!("{} (the strongest model)", pick.name()));
    let prompt = rethink_prompt(brief, done_when, ledger, diff);
    let said = match runners.checker_model(&prompt, &pick.cli, &pick.strong_model) {
        Ok(said) => said,
        Err(why) => return hand_up(&why, by),
    };
    match parse_rethink(&said) {
        Some(Rethink::Rewrite { rule, brief }) => NextStep {
            kind: StepKind::Rewrite,
            text: rewrite_message(&brief),
            rule: Some(rule),
            by,
            decision: None,
        },
        Some(Rethink::Up { summary }) => NextStep {
            kind: StepKind::Up,
            text: up_message(&summary, rounds),
            rule: None,
            by,
            decision: None,
        },
        None => hand_up("its answer couldn't be read", by),
    }
}
