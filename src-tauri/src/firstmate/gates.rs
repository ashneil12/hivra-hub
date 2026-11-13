//! Hivra WP-40: completion and verdict gates (docs/hivra/SPEC.md section 4 step 6, docs/hivra/work/WP-40-gates.md).
//!
//! A worker saying "done" is a claim. When a delegated worker reports done, the app runs the brief's gates in code, on
//! the worker's own copy, before its report settles:
//!
//! | Gate | Passes when | Can't run when |
//! | --- | --- | --- |
//! | `diff` | something changed since the copy was made (commits or files) | the copy isn't a git checkout |
//! | `checks` | the project's checks (`.monocode/project.json` `verify.checks`, else its Check action), or the ones the brief names, all pass | the project file isn't imported, or declares no checks |
//! | `committed` | nothing is left uncommitted | the copy isn't a git checkout |
//! | `ratchet` | the changed files hold no fewer tests than before | the copy isn't a git checkout |
//! | `routes` | the project's routes script (`gates.rs`, kept where workers can't edit it) passes | the project has none (then it isn't added) |
//!
//! The first mate picks a brief's gates from that set (`delegate_task` `gates`, `code`); a code brief always gets `diff`
//! and `checks`, plus the project's defaults (`verify.gates`); the routes check is always on where a project has one.
//! Then a cheap model reads the brief's definition of done, the worker's report and the diff, and answers met, not met
//! (with why) or unsure.
//!
//! The verdict, in order: any gate failed, a fact gap (WP-145), or the model said not met: **failed** (the worker gets
//! one fix round, then its first mate hears it failed). Fact gaps are a failed check, a test that went stale after a
//! later edit, a pass claim with no run after the last code edit, an open to-do, or an edited package no test reached.
//! Docs-only edits are not coverage gaps. The model is not asked when a gap is already there. A gate that couldn't run,
//! or a model that was unsure or didn't answer: **unsure**, never passed; its first mate decides (`task_accept`).
//! Everything passed and the brief was met: **passed**. The verdict goes on
//! the delegation row (`gate_verdict`, read by `derive_status`), and the evidence (commands, exit codes, output tails, the
//! model's answer) is kept per round in `firstmate_gates`, beside the row.
//!
//! WP-249 (`done_check`): the report is read as a list of claims, and code checks them against the diff before any model
//! does (a false "only touched" claim, scope creep, a weakened test, debris, an outward action Ash didn't ask for). Any
//! finding fails the round. The model then gets the claims, the code's findings and the diff, never the report's own
//! wording, and answers VERIFIED, VERIFIED WITH CAVEATS or REFUTED with a row per claim. The round keeps a fingerprint of
//! the copy's files (`tree`); accepting an unsure verdict or delivering the copy re-reads it, and a change since voids
//! the verdict (`verdict_tree_holds`).
//!
//! SC-3a (`testing_mode`): the gates are chosen from what the copy changed and the project's testing mode (Settings > Crew),
//! not from whether the brief said `code`. A task that changed nothing and stored no plan settles as before; any other gets
//! the mode's gates (`gates_for`): `at-ship` (the default) runs `diff` and `committed` and the code's findings and passes as
//! "Built, not tested yet", `off` runs `diff` and `committed` and passes as "Not tested", `light` and `full` add `checks`,
//! `ratchet`, the brief's own plan and the verdict model. A step that exited cleanly and ran zero tests could not run
//! (`zero_tests_is_not_a_pass`), and accepting an unsure result needs a reason (`decide`).
//!
//! Ideas from Puppetmaster's gates (`require_diff`, `command`, `committed`, `ratchet`; MIT) and Raven's "finished is not
//! succeeded" verdict gate (Apache-2.0, ideas only). No code is vendored.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::done_check::{self, ChangedFile, ClaimRow, ClaimStatus, CodeFinding};
use super::status::GateVerdict;
use super::testing_mode::{self, ModePlan};

/// The longest output tail kept per command.
pub const OUTPUT_MAX: usize = 2_000;
/// The rounds of evidence kept per delegation (the first try, the fix round, and a few redoes).
const ROUNDS_KEPT: usize = 6;
/// How much of the report and the diff the verdict model reads.
const REPORT_MAX: usize = 6_000;
const DIFF_MAX: usize = 12_000;
/// WP-249: the changed files whose text the code checks read, and the largest one read.
const FILES_READ_MAX: usize = 400;
const FILE_READ_MAX: usize = 256_000;
/// The verdict model's whole call.
pub const VERDICT_TIMEOUT: Duration = Duration::from_secs(120);

// ---- the fixed set ----------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum GateKind {
    Diff,
    Checks,
    Committed,
    Ratchet,
    Routes,
}

impl GateKind {
    pub fn parse(word: &str) -> Option<GateKind> {
        match word.trim() {
            "diff" => Some(GateKind::Diff),
            "checks" => Some(GateKind::Checks),
            "committed" => Some(GateKind::Committed),
            "ratchet" => Some(GateKind::Ratchet),
            "routes" => Some(GateKind::Routes),
            _ => None,
        }
    }

    /// The gate's name in a sentence.
    pub fn name(self) -> &'static str {
        match self {
            GateKind::Diff => "Change made",
            GateKind::Checks => "Project checks",
            GateKind::Committed => "Work committed",
            GateKind::Ratchet => "Tests kept",
            GateKind::Routes => "Routes check",
        }
    }
}

/// A brief's gates, chosen by its first mate (or the project's defaults), kept until its worker reports.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GatePlan {
    pub gates: Vec<GateKind>,
    /// Ids of the project's own checks or actions the `checks` gate runs; empty means the project's checks.
    #[serde(default)]
    pub checks: Vec<String>,
}

/// What the first mate asked for on `delegate_task`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInput {
    #[serde(default)]
    pub gates: Option<Vec<String>>,
    #[serde(default)]
    pub checks: Vec<String>,
    /// The brief changes code: it gets `diff` and `checks` whatever else is named.
    #[serde(default)]
    pub code: bool,
}

/// The brief's gates. Named ones are kept; a code brief (or one naming any gate but `routes`, which only code needs) gets
/// `diff` and `checks`, and the project's defaults when it named none. Unknown words are refused in plain words.
pub fn resolve_plan(input: &PlanInput, project_defaults: &[String]) -> Result<GatePlan, String> {
    let mut gates = Vec::new();
    for word in input.gates.iter().flatten() {
        let Some(kind) = GateKind::parse(word) else {
            return Err(format!(
                "\"{word}\" isn't a gate. Use diff, checks, committed, ratchet or routes."
            ));
        };
        gates.push(kind);
    }
    let code =
        input.code || gates.iter().any(|g| *g != GateKind::Routes) || !input.checks.is_empty();
    if code {
        if input.gates.as_ref().is_none_or(|named| named.is_empty()) {
            gates.extend(project_defaults.iter().filter_map(|w| GateKind::parse(w)));
        }
        gates.extend([GateKind::Diff, GateKind::Checks]);
    }
    gates.sort();
    gates.dedup();
    let mut checks: Vec<String> = input
        .checks
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    checks.dedup();
    if checks.len() > 20 || checks.iter().any(|c| c.len() > 60) {
        return Err("Name at most 20 checks, by their ids in the project's file.".into());
    }
    Ok(GatePlan { gates, checks })
}

// ---- results ------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Passed,
    Failed,
    /// It couldn't run. Never a pass.
    NotRun,
    /// WP-81: the delivery gate runs this check once, before GitHub. Not a pass and not a failure.
    Held,
}

impl Outcome {
    fn word(self) -> &'static str {
        match self {
            Outcome::Passed => "passed",
            Outcome::Failed => "failed",
            Outcome::NotRun => "not run",
            Outcome::Held => "run by no-mistakes",
        }
    }

    /// Any failure fails; then anything that couldn't run; a round that only handed its checks to
    /// no-mistakes is not run; else a pass. Nothing at all is not run. A held check does not block
    /// a round whose other gates passed.
    pub fn aggregate(outcomes: impl IntoIterator<Item = Outcome>) -> Outcome {
        let all: Vec<Outcome> = outcomes.into_iter().collect();
        if all.contains(&Outcome::Failed) {
            Outcome::Failed
        } else if all.contains(&Outcome::NotRun)
            || all.iter().all(|outcome| *outcome == Outcome::Held)
        {
            // An empty list is all-held, so it is not run. A held check beside a pass does not block.
            Outcome::NotRun
        } else {
            Outcome::Passed
        }
    }
}

/// One command a gate ran, as evidence.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandEvidence {
    pub command: String,
    pub outcome: Outcome,
    pub exit_code: Option<i32>,
    /// The end of what it printed.
    pub output: String,
    pub seconds: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GateResult {
    pub gate: GateKind,
    pub outcome: Outcome,
    /// Plain words: what it found, or why it couldn't run.
    pub detail: String,
    pub evidence: Vec<CommandEvidence>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Answer {
    Met,
    NotMet,
    Unsure,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerdictResult {
    pub answer: Answer,
    pub why: String,
    /// What the model said, cut short, as evidence.
    pub said: String,
    /// WP-249: the model's verdict word, when it gave one of the three.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<DoneLabel>,
    /// WP-249: the model's row per claim.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub claims: Vec<ClaimRow>,
    /// WP-249: the problems the model found, one plain line each.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub frauds: Vec<String>,
}

impl VerdictResult {
    fn plain(answer: Answer, why: impl Into<String>, said: String) -> VerdictResult {
        VerdictResult {
            answer,
            why: why.into(),
            said,
            label: None,
            claims: Vec::new(),
            frauds: Vec::new(),
        }
    }
}

/// WP-249: the three answers to "is this done?".
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DoneLabel {
    Verified,
    VerifiedWithCaveats,
    Refuted,
}

impl DoneLabel {
    pub fn word(self) -> &'static str {
        match self {
            DoneLabel::Verified => "VERIFIED",
            DoneLabel::VerifiedWithCaveats => "VERIFIED WITH CAVEATS",
            DoneLabel::Refuted => "REFUTED",
        }
    }
}

/// The gates' word on a round: what goes on the row as `gate_verdict`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict {
    Passed,
    Failed,
    Unsure,
}

impl Verdict {
    pub fn stored(self) -> &'static str {
        match self {
            Verdict::Passed => GateVerdict::PASSED,
            Verdict::Failed => GateVerdict::FAILED,
            Verdict::Unsure => GateVerdict::UNSURE,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GateRecord {
    pub delegation_id: String,
    /// 1 for the first report, 2 for the fix round, and so on.
    pub round: u32,
    pub at: i64,
    pub verdict: Verdict,
    pub gates: Vec<GateResult>,
    /// None when a gate failed or couldn't run (the model isn't asked then).
    pub check: Option<VerdictResult>,
    /// One plain paragraph: what failed and why, or what passed. The worker reads it on a fix round; its first mate
    /// reads it in the report.
    pub summary: String,
    /// WP-249: VERIFIED, VERIFIED WITH CAVEATS or REFUTED; none when the round couldn't say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<DoneLabel>,
    /// WP-249: what the code found in the diff that the report's claims don't survive.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub findings: Vec<CodeFinding>,
    /// WP-249: each claim, what was observed, and whether it held.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub claims: Vec<ClaimRow>,
    /// WP-249: the fingerprint of the copy's files this round judged (`tree_fingerprint`), and the copy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkout: Option<String>,
    /// SC-3a: the project's testing mode this round ran under (`at-ship`, `light`, `full`, `off`). None for a round
    /// from before the modes, and for a task that changed nothing and stored no plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub testing_mode: Option<String>,
    /// SC-3a: what a pass says about how far the task was tested ("Built, not tested yet", "Not tested"). None when the
    /// task was tested as far as its mode asks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl GateRecord {
    /// Every problem the round named: the code's findings, then the model's.
    pub fn problems(&self) -> Vec<String> {
        let mut out: Vec<String> = self.findings.iter().map(CodeFinding::line).collect();
        if let Some(check) = &self.check {
            out.extend(check.frauds.iter().cloned());
        }
        out
    }
}

// ---- running them -------------------------------------------------------------------------------------------------------

/// The parts that need the app (or a fake in tests): the project's checks, its routes script and the verdict model.
pub trait Runners {
    /// Run the project's checks (or the named ones) in `checkout`. `Err`: there are none to run, in plain words.
    fn checks(
        &self,
        checkout: &Path,
        named: &[String],
        changed: &[String],
    ) -> Result<Vec<CommandEvidence>, String>;
    /// The project's routes script on `checkout`: `None` when the project has none.
    fn routes(&self, checkout: &Path) -> Option<CommandEvidence>;
    /// One short completion: the verdict model's reply to `prompt`, or why there is none.
    fn verdict(&self, prompt: &str) -> Result<String, String>;
}

/// Everything a round reads.
pub struct RoundInput<'a> {
    pub delegation_id: &'a str,
    pub round: u32,
    pub checkout: &'a Path,
    pub plan: &'a GatePlan,
    pub brief: &'a str,
    pub done_when: &'a str,
    pub report: &'a str,
    pub now: i64,
    /// WP-81: the delivery gate runs this brief's project checks, so the checks gate does not.
    pub gate_owns_checks: bool,
    /// WP-145: this turn's checks, edits and to-dos. Absent means the fact layer does not run.
    pub facts: Option<&'a super::fact_gaps::FactTurn>,
    /// SC-3a: the project's testing mode, chosen from the diff (`testing_mode::gates_for`). `plan` is its gates. Absent
    /// is the round as it was before the modes: every finding, every fact gap, the verdict model.
    pub mode: Option<&'a ModePlan>,
}

pub fn run_round(input: &RoundInput, runners: &dyn Runners) -> GateRecord {
    let repo = Repo::open(input.checkout);
    let mut gates = Vec::new();
    for gate in &input.plan.gates {
        let result = match gate {
            GateKind::Diff => diff_gate(&repo),
            GateKind::Checks => checks_gate(
                &repo,
                input.checkout,
                &input.plan.checks,
                runners,
                input.gate_owns_checks,
            ),
            GateKind::Committed => committed_gate(&repo),
            GateKind::Ratchet => ratchet_gate(&repo),
            // Run below for every brief whose project has one.
            GateKind::Routes => continue,
        };
        gates.push(result);
    }
    // The routes check is the project's, never the brief's to leave out.
    match runners.routes(input.checkout) {
        Some(run) => gates.push(GateResult {
            gate: GateKind::Routes,
            outcome: run.outcome,
            detail: match run.outcome {
                Outcome::Passed => "The project's routes check passed.".into(),
                Outcome::Failed => "The project's routes check failed.".into(),
                Outcome::NotRun | Outcome::Held => {
                    "The project's routes check couldn't run.".into()
                }
            },
            evidence: vec![run],
        }),
        None if input.plan.gates.contains(&GateKind::Routes) => gates.push(GateResult {
            gate: GateKind::Routes,
            outcome: Outcome::NotRun,
            detail: "This project has no routes check.".into(),
            evidence: Vec::new(),
        }),
        None => {}
    }
    let overall = Outcome::aggregate(gates.iter().map(|g| g.outcome));
    // SC-3a: what the project's testing mode asks of this round. No mode is the round as it was before the modes:
    // every finding, every fact gap and the verdict model.
    let run_findings = input.mode.is_none_or(|mode| mode.run_findings);
    let run_verdict = input.mode.is_none_or(|mode| mode.run_verdict);
    // WP-145: a fact gap fails the claim. The model is not asked, and a gap is not "unsure".
    let gaps = input
        .facts
        .map(|turn| super::fact_gaps::done_gaps_in(turn, Some(input.checkout)))
        .unwrap_or_default();
    let gaps = match input.mode {
        Some(mode) => mode.fact_gap_filter.keep(gaps),
        None => gaps,
    };
    // WP-249: the report's claims against the diff, in code, before any model.
    let claims = done_check::claims_of(input.report);
    let (files, unread) = if run_findings && repo.why_not.is_none() {
        match repo.changed_files() {
            Ok(files) => (files, None),
            Err(why) => (Vec::new(), Some(why)),
        }
    } else {
        (Vec::new(), None)
    };
    let findings = if run_findings {
        done_check::code_findings(input.brief, input.report, &claims, &files)
    } else {
        Vec::new()
    };
    let checks_run = match gates.iter().find(|gate| gate.gate == GateKind::Checks) {
        Some(gate) if gate.outcome == Outcome::Passed => done_check::ChecksRun::Passed,
        Some(gate) if gate.outcome == Outcome::Failed => done_check::ChecksRun::Failed,
        _ => done_check::ChecksRun::None,
    };
    let code_rows = done_check::code_rows(&claims, &findings, checks_run);
    let check =
        (run_verdict && gaps.is_empty() && (overall == Outcome::Passed || gates.is_empty()))
            .then(|| verdict_check(input, &repo, &gates, &claims, &findings, runners));
    let verdict = match (overall, gaps.is_empty(), check.as_ref().map(|c| c.answer)) {
        (Outcome::Failed, _, _) | (_, false, _) | (_, _, Some(Answer::NotMet)) => Verdict::Failed,
        _ if !findings.is_empty() => Verdict::Failed,
        // A checkout whose changed files couldn't be read had its claims checked by no one: never a pass.
        _ if unread.is_some() => Verdict::Unsure,
        (_, _, Some(Answer::Met)) => Verdict::Passed,
        // SC-3a: a mode with no verdict model passes on its gates alone: the task was built, and not tested.
        (Outcome::Passed, _, None) if !run_verdict => Verdict::Passed,
        _ => Verdict::Unsure,
    };
    let claims = merged_rows(code_rows, check.as_ref());
    let label = label_of(verdict, &findings, &claims, check.as_ref());
    // Nothing read a pass that no verdict model saw: it verified nothing.
    let label = if run_verdict || verdict != Verdict::Passed {
        label
    } else {
        None
    };
    let note = input
        .mode
        .and_then(|mode| mode.note)
        .filter(|_| verdict == Verdict::Passed);
    let mut summary = match note {
        Some(note) => built_summary(&gates, note),
        None => summary_of(
            &gates,
            check.as_ref(),
            verdict,
            &gaps,
            &findings,
            label,
            &claims,
        ),
    };
    if let Some(why) = &unread {
        summary.push_str(&format!(
            "\nThe report's claims couldn't be checked against the diff: {why}."
        ));
    }
    let tree = if repo.why_not.is_none() {
        tree_fingerprint(input.checkout).ok()
    } else {
        None
    };
    GateRecord {
        delegation_id: input.delegation_id.to_string(),
        round: input.round,
        at: input.now,
        verdict,
        gates,
        check,
        summary,
        label,
        findings,
        claims,
        tree,
        checkout: Some(input.checkout.to_string_lossy().into_owned()),
        testing_mode: input.mode.map(|mode| mode.mode.as_str().to_string()),
        note: note.map(str::to_string),
    }
}

/// SC-3a: the summary of a task that passed on its gates alone. The first line is what the task's row shows, so a pass
/// never reads as a bare Done: it says it was built and not tested.
fn built_summary(gates: &[GateResult], note: &str) -> String {
    let names: Vec<&str> = gates
        .iter()
        .filter(|gate| gate.outcome == Outcome::Passed)
        .map(|gate| gate.gate.name())
        .collect();
    if names.is_empty() {
        note.to_string()
    } else {
        format!("{note}\n{} passed.", names.join(", "))
    }
}

fn same_claim(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim().to_lowercase(), b.trim().to_lowercase());
    !a.is_empty() && !b.is_empty() && (a == b || a.contains(&b) || b.contains(&a))
}

/// The code's rows, with the model's word on the ones code left open. The model never overturns code.
fn merged_rows(code: Vec<ClaimRow>, check: Option<&VerdictResult>) -> Vec<ClaimRow> {
    let model = check.map(|c| c.claims.as_slice()).unwrap_or_default();
    code.into_iter()
        .map(|row| {
            if row.status != ClaimStatus::Unverifiable {
                return row;
            }
            match model
                .iter()
                .find(|said| same_claim(&said.claim, &row.claim))
            {
                Some(said) => ClaimRow {
                    claim: row.claim,
                    observed: said.observed.clone(),
                    status: said.status,
                },
                None => row,
            }
        })
        .collect()
}

/// REFUTED when code or the model refuted anything; else the passed round's VERIFIED, with caveats when a claim is
/// left unverifiable; none for a round that couldn't say.
fn label_of(
    verdict: Verdict,
    findings: &[CodeFinding],
    rows: &[ClaimRow],
    check: Option<&VerdictResult>,
) -> Option<DoneLabel> {
    let refuted = !findings.is_empty()
        || rows.iter().any(|row| row.status == ClaimStatus::Refuted)
        || check.is_some_and(|c| c.answer == Answer::NotMet);
    if refuted {
        return Some(DoneLabel::Refuted);
    }
    if verdict != Verdict::Passed {
        return None;
    }
    let caveats = rows
        .iter()
        .any(|row| row.status == ClaimStatus::Unverifiable)
        || check.and_then(|c| c.label) == Some(DoneLabel::VerifiedWithCaveats);
    Some(if caveats {
        DoneLabel::VerifiedWithCaveats
    } else {
        DoneLabel::Verified
    })
}

fn summary_of(
    gates: &[GateResult],
    check: Option<&VerdictResult>,
    verdict: Verdict,
    gaps: &[String],
    findings: &[CodeFinding],
    label: Option<DoneLabel>,
    rows: &[ClaimRow],
) -> String {
    let mut lines = Vec::new();
    // The first line is what the task card and the inbox show.
    if !gaps.is_empty() {
        lines.push(super::fact_gaps::fact_summary(gaps));
    }
    if !findings.is_empty() {
        lines.push(format!(
            "REFUTED: the report's claims don't match the diff.\n{}",
            done_check::findings_text(findings)
        ));
    }
    for gate in gates {
        if gate.outcome != Outcome::Passed && gate.outcome != Outcome::Held {
            lines.push(format!(
                "{} {}: {}",
                gate.gate.name(),
                gate.outcome.word(),
                gate.detail
            ));
            for run in gate
                .evidence
                .iter()
                .filter(|r| r.outcome != Outcome::Passed)
            {
                if !run.output.is_empty() {
                    lines.push(format!("`{}` said:\n{}", run.command, run.output));
                }
            }
        }
    }
    match check {
        Some(c) if c.answer == Answer::NotMet => {
            lines.push(format!(
                "The brief's definition of done isn't met: {}",
                c.why
            ));
            for fraud in &c.frauds {
                lines.push(format!("- {fraud}"));
            }
        }
        Some(c) if c.answer == Answer::Unsure => lines.push(format!(
            "The quick check couldn't tell whether the brief was met: {}",
            c.why
        )),
        _ => {}
    }
    if verdict == Verdict::Passed {
        let names: Vec<&str> = gates
            .iter()
            .filter(|gate| gate.outcome == Outcome::Passed)
            .map(|gate| gate.gate.name())
            .collect();
        let lead = if names.is_empty() {
            "No gates to run".to_string()
        } else {
            format!("{} passed", names.join(", "))
        };
        let handoff = if gates.iter().any(|gate| gate.outcome == Outcome::Held) {
            " The no-mistakes layer runs the project's checks before GitHub."
        } else {
            ""
        };
        let caveats = if label == Some(DoneLabel::VerifiedWithCaveats) {
            let open: Vec<String> = rows
                .iter()
                .filter(|row| row.status == ClaimStatus::Unverifiable)
                .map(|row| format!("\n- unverifiable: {} ({})", row.claim, row.observed))
                .collect();
            format!(" Verified with caveats.{}", open.concat())
        } else {
            String::new()
        };
        return format!("{lead}; the quick check says the brief was met.{handoff}{caveats}");
    }
    lines.join("\n")
}

// ---- git ----------------------------------------------------------------------------------------------------------------

struct Repo {
    dir: PathBuf,
    /// Where the copy started: the merge base with the project's main checkout, or its own HEAD.
    base: Option<String>,
    why_not: Option<String>,
}

fn git(dir: &Path, args: &[&str]) -> Result<(bool, Vec<u8>, i32), String> {
    let mut cmd = crate::git_cmd::git();
    cmd.arg("-C")
        .arg(dir)
        .args(["-c", "core.quotepath=off"])
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    crate::hide_window_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("git could not run: {e}"))?;
    Ok((
        out.status.success(),
        out.stdout,
        out.status.code().unwrap_or(-1),
    ))
}

fn text_of(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

impl Repo {
    fn open(dir: &Path) -> Repo {
        let fail = |why: &str| Repo {
            dir: dir.to_path_buf(),
            base: None,
            why_not: Some(why.to_string()),
        };
        let head = match git(dir, &["rev-parse", "--verify", "-q", "HEAD"]) {
            Ok((true, out, _)) => text_of(&out),
            Ok(_) => return fail("the worker's copy has no commit to compare with"),
            Err(_) => return fail("git isn't available"),
        };
        if head.is_empty() {
            return fail("the worker's copy isn't a git checkout");
        }
        // A copy of the project: compare with where it left the project's main checkout.
        let main_head = crate::project_file::main_checkout(dir)
            .ok()
            .filter(|main| crate::fs::canonical(dir).ok().as_deref() != Some(main.as_path()))
            .and_then(|main| match git(&main, &["rev-parse", "HEAD"]) {
                Ok((true, out, _)) => Some(text_of(&out)),
                _ => None,
            });
        let base = match main_head {
            Some(main) => match git(dir, &["merge-base", "HEAD", &main]) {
                Ok((true, out, _)) => text_of(&out),
                _ => head,
            },
            None => head,
        };
        Repo {
            dir: dir.to_path_buf(),
            base: Some(base),
            why_not: None,
        }
    }

    fn not_run(&self, gate: GateKind) -> Option<GateResult> {
        self.why_not.as_ref().map(|why| GateResult {
            gate,
            outcome: Outcome::NotRun,
            detail: format!("It couldn't run: {why}."),
            evidence: Vec::new(),
        })
    }

    /// Every file the copy changed since `base`: committed or not, and new files git doesn't ignore.
    fn changed(&self) -> Result<Vec<String>, String> {
        let base = self.base.as_deref().unwrap_or("HEAD");
        let (ok, tracked, _) = git(&self.dir, &["diff", "--name-only", base, "--"])?;
        if !ok {
            return Err("git couldn't compare the copy with where it started".into());
        }
        let (_, untracked, _) = git(&self.dir, &["ls-files", "--others", "--exclude-standard"])?;
        let mut files: Vec<String> = String::from_utf8_lossy(&tracked)
            .lines()
            .chain(String::from_utf8_lossy(&untracked).lines())
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect();
        files.sort();
        files.dedup();
        Ok(files)
    }

    /// WP-249: each changed file with its text before (at `base`) and now, for the code checks. A file too large or
    /// not text reads as empty, and past `FILES_READ_MAX` files only whether each exists is kept.
    fn changed_files(&self) -> Result<Vec<ChangedFile>, String> {
        let base = self.base.as_deref().unwrap_or("HEAD");
        let paths = self.changed()?;
        Ok(paths
            .into_iter()
            .enumerate()
            .map(|(index, path)| {
                let read = index < FILES_READ_MAX;
                let before = match git(&self.dir, &["cat-file", "blob", &format!("{base}:{path}")])
                {
                    Ok((true, out, _)) => Some(if read { file_text(&out) } else { String::new() }),
                    _ => None,
                };
                let after = std::fs::symlink_metadata(self.dir.join(&path))
                    .ok()
                    .filter(|meta| !meta.is_dir())
                    .map(|_| {
                        if read {
                            std::fs::read(self.dir.join(&path))
                                .map(|bytes| file_text(&bytes))
                                .unwrap_or_default()
                        } else {
                            String::new()
                        }
                    });
                ChangedFile {
                    path,
                    before,
                    after,
                }
            })
            .collect())
    }

    fn diff_text(&self) -> String {
        let base = self.base.as_deref().unwrap_or("HEAD");
        let stat = git(&self.dir, &["diff", "--stat", base, "--"])
            .map(|(_, out, _)| String::from_utf8_lossy(&out).to_string())
            .unwrap_or_default();
        let body = git(&self.dir, &["diff", base, "--"])
            .map(|(_, out, _)| String::from_utf8_lossy(&out).to_string())
            .unwrap_or_default();
        let new = git(&self.dir, &["ls-files", "--others", "--exclude-standard"])
            .map(|(_, out, _)| String::from_utf8_lossy(&out).to_string())
            .unwrap_or_default();
        let mut text = stat;
        if !new.trim().is_empty() {
            text.push_str("\nNew files:\n");
            text.push_str(&new);
        }
        text.push('\n');
        text.push_str(&body);
        head_of(&text, DIFF_MAX)
    }
}

/// A file's text for the code checks: empty when it is too large or not text.
fn file_text(bytes: &[u8]) -> String {
    if bytes.len() > FILE_READ_MAX || bytes.contains(&0) {
        return String::new();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// WP-249: a fingerprint of every file git would see in `dir` (tracked, and new files it doesn't ignore), by content.
/// Committing changes nothing here; editing, adding or removing a file does. Git lists the files and nothing else: no
/// filter, hook or fsmonitor of the worker's copy runs, and the files are read and hashed here.
pub fn tree_fingerprint(dir: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let (ok, out, _) = git(
        dir,
        &[
            "-c",
            "core.fsmonitor=false",
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )?;
    if !ok {
        return Err("git couldn't list the copy's files".into());
    }
    let mut paths: Vec<&[u8]> = out.split(|b| *b == 0).filter(|p| !p.is_empty()).collect();
    paths.sort();
    paths.dedup();
    let mut hash = Sha256::new();
    for raw in paths {
        let path = String::from_utf8_lossy(raw);
        hash.update(raw);
        hash.update([0]);
        let full = dir.join(path.as_ref());
        match std::fs::symlink_metadata(&full) {
            Err(_) => hash.update(b"gone\0"),
            Ok(meta) if meta.file_type().is_symlink() => {
                hash.update(b"link\0");
                let target = std::fs::read_link(&full).map_err(|e| format!("{path}: {e}"))?;
                hash.update(target.to_string_lossy().as_bytes());
            }
            Ok(meta) if meta.is_dir() => hash.update(b"folder\0"),
            Ok(meta) => {
                #[cfg(unix)]
                let exec = {
                    use std::os::unix::fs::PermissionsExt;
                    meta.permissions().mode() & 0o111 != 0
                };
                #[cfg(not(unix))]
                let exec = {
                    let _ = &meta;
                    false
                };
                hash.update(if exec { b"exec\0" } else { b"file\0" });
                let mut file = std::fs::File::open(&full).map_err(|e| format!("{path}: {e}"))?;
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    let n = file.read(&mut buf).map_err(|e| format!("{path}: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    hash.update(&buf[..n]);
                }
            }
        }
        hash.update([0]);
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

/// WP-249: the newest round's verdict (`newest`, from `records_of`) still holds only on the files it judged.
/// `checkout` is the copy being accepted or delivered (else the one the round read). No round, or a round from before
/// WP-249 that kept no fingerprint, is not re-read. Read the round under the database lock and call this after it,
/// since it reads every file of the copy.
pub fn verdict_tree_holds(
    newest: Option<&GateRecord>,
    checkout: Option<&Path>,
) -> Result<(), String> {
    let Some(record) = newest else {
        return Ok(());
    };
    let Some(tree) = record.tree.as_deref() else {
        return Ok(());
    };
    let dir = match (checkout, record.checkout.as_deref()) {
        (Some(dir), _) => dir.to_path_buf(),
        (None, Some(dir)) => PathBuf::from(dir),
        (None, None) => {
            return Err("The checked copy isn't known, so its verdict doesn't carry over. Run the checks again.".into())
        }
    };
    match tree_fingerprint(&dir) {
        Ok(now) if now == tree => Ok(()),
        Ok(now) => Err(format!(
            "The work changed after its check (checked {}, now {}), so that verdict no longer holds. Run the checks again \
             (the worker reports done again) before accepting or delivering it.",
            short_tree(tree),
            short_tree(&now)
        )),
        Err(why) => Err(format!(
            "The checked copy couldn't be read again ({why}), so its verdict doesn't carry over. Run the checks again."
        )),
    }
}

fn short_tree(tree: &str) -> &str {
    let hex = tree.strip_prefix("sha256:").unwrap_or(tree);
    &hex[..hex.len().min(12)]
}

fn evidence(command: String, ok: bool, code: i32, output: String) -> CommandEvidence {
    CommandEvidence {
        command,
        outcome: if ok { Outcome::Passed } else { Outcome::Failed },
        exit_code: Some(code),
        output: crate::gates::tail(&output, OUTPUT_MAX),
        seconds: 0.0,
    }
}

fn list_some(files: &[String]) -> String {
    let shown: Vec<&str> = files.iter().take(10).map(String::as_str).collect();
    let more = files.len().saturating_sub(shown.len());
    if more > 0 {
        format!("{} and {more} more", shown.join(", "))
    } else {
        shown.join(", ")
    }
}

fn diff_gate(repo: &Repo) -> GateResult {
    if let Some(not_run) = repo.not_run(GateKind::Diff) {
        return not_run;
    }
    let base = repo.base.clone().unwrap_or_default();
    let command = format!("git diff --name-only {}", short(&base));
    match repo.changed() {
        Ok(files) if files.is_empty() => GateResult {
            gate: GateKind::Diff,
            outcome: Outcome::Failed,
            detail: "Nothing changed in the worker's copy since it started.".into(),
            evidence: vec![evidence(command, false, 0, String::new())],
        },
        Ok(files) => GateResult {
            gate: GateKind::Diff,
            outcome: Outcome::Passed,
            detail: format!("{} file(s) changed: {}.", files.len(), list_some(&files)),
            evidence: vec![evidence(command, true, 0, files.join("\n"))],
        },
        Err(why) => GateResult {
            gate: GateKind::Diff,
            outcome: Outcome::NotRun,
            detail: format!("It couldn't run: {why}."),
            evidence: Vec::new(),
        },
    }
}

fn committed_gate(repo: &Repo) -> GateResult {
    if let Some(not_run) = repo.not_run(GateKind::Committed) {
        return not_run;
    }
    let command = "git status --porcelain".to_string();
    match git(
        &repo.dir,
        &["status", "--porcelain=v1", "--untracked-files=normal"],
    ) {
        Ok((true, out, code)) => {
            let left: Vec<String> = String::from_utf8_lossy(&out)
                .lines()
                .filter(|l| l.len() > 3)
                .map(|l| l[3..].to_string())
                .collect();
            if left.is_empty() {
                GateResult {
                    gate: GateKind::Committed,
                    outcome: Outcome::Passed,
                    detail: "Everything is committed.".into(),
                    evidence: vec![evidence(command, true, code, String::new())],
                }
            } else {
                GateResult {
                    gate: GateKind::Committed,
                    outcome: Outcome::Failed,
                    detail: format!(
                        "{} file(s) are left uncommitted: {}.",
                        left.len(),
                        list_some(&left)
                    ),
                    evidence: vec![evidence(command, false, code, left.join("\n"))],
                }
            }
        }
        _ => GateResult {
            gate: GateKind::Committed,
            outcome: Outcome::NotRun,
            detail: "It couldn't run: git couldn't read the copy's status.".into(),
            evidence: Vec::new(),
        },
    }
}

/// Test declarations in one file, by its kind: Rust `#[test]`, JS/TS `it(`/`test(`, Python `def test_`, Go `func Test`.
pub fn count_tests(path: &str, text: &str) -> usize {
    let ext = path.rsplit('.').next().unwrap_or("");
    // SC-3a: a Rust test marked `#[ignore]` does not run, so it is not a test.
    if ext == "rs" {
        return done_check::test_code::count_active_rust_tests(text);
    }
    text.lines()
        .map(str::trim_start)
        .filter(|line| match ext {
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => {
                ["it(", "test(", "it.", "test."].iter().any(|start| {
                    line.starts_with(start)
                        && !line.starts_with("it.todo")
                        && !line.starts_with("test.todo")
                        && !line.starts_with("it.skip")
                        && !line.starts_with("test.skip")
                })
            }
            "py" => line.starts_with("def test_") || line.starts_with("async def test_"),
            "go" => line.starts_with("func Test"),
            _ => false,
        })
        .count()
}

fn ratchet_gate(repo: &Repo) -> GateResult {
    if let Some(not_run) = repo.not_run(GateKind::Ratchet) {
        return not_run;
    }
    let base = repo.base.clone().unwrap_or_default();
    let files = match repo.changed() {
        Ok(files) => files,
        Err(why) => {
            return GateResult {
                gate: GateKind::Ratchet,
                outcome: Outcome::NotRun,
                detail: format!("It couldn't run: {why}."),
                evidence: Vec::new(),
            }
        }
    };
    let (mut before, mut after) = (0usize, 0usize);
    let mut dropped = Vec::new();
    for file in &files {
        let was = match git(&repo.dir, &["show", &format!("{base}:{file}")]) {
            Ok((true, out, _)) => count_tests(file, &String::from_utf8_lossy(&out)),
            _ => 0,
        };
        let now = std::fs::read(repo.dir.join(file))
            .map(|bytes| count_tests(file, &String::from_utf8_lossy(&bytes)))
            .unwrap_or(0);
        if now < was {
            dropped.push(format!("{file} {was}→{now}"));
        }
        before += was;
        after += now;
    }
    let output = format!("tests in the changed files: {before} before, {after} now");
    let command = format!("count tests in the changed files since {}", short(&base));
    if after < before {
        GateResult {
            gate: GateKind::Ratchet,
            outcome: Outcome::Failed,
            detail: format!(
                "The changed files hold fewer tests than before ({before} → {after}): {}.",
                dropped.join(", ")
            ),
            evidence: vec![evidence(command, false, 1, output)],
        }
    } else {
        GateResult {
            gate: GateKind::Ratchet,
            outcome: Outcome::Passed,
            detail: format!("No tests were lost ({before} → {after})."),
            evidence: vec![evidence(command, true, 0, output)],
        }
    }
}

fn checks_gate(
    repo: &Repo,
    checkout: &Path,
    named: &[String],
    runners: &dyn Runners,
    gate_owns_checks: bool,
) -> GateResult {
    // WP-81: with the delivery gate on, no-mistakes runs this command once at delivery.
    if gate_owns_checks {
        return GateResult {
            gate: GateKind::Checks,
            outcome: Outcome::Held,
            detail: "The no-mistakes layer runs this check before GitHub.".into(),
            evidence: Vec::new(),
        };
    }
    let changed = repo.changed().unwrap_or_default();
    match runners.checks(checkout, named, &changed) {
        Ok(runs) if runs.is_empty() => GateResult {
            gate: GateKind::Checks,
            outcome: Outcome::NotRun,
            detail: "It couldn't run: no checks were found to run.".into(),
            evidence: Vec::new(),
        },
        Ok(runs) => {
            // SC-3a: a step that exited cleanly and ran zero tests could not run.
            let runs: Vec<CommandEvidence> =
                runs.into_iter().map(zero_tests_is_not_a_pass).collect();
            let outcome = Outcome::aggregate(runs.iter().map(|r| r.outcome));
            let detail = match outcome {
                Outcome::Passed => format!("{} check(s) ran and passed.", runs.len()),
                Outcome::Failed => {
                    let failed: Vec<&str> = runs
                        .iter()
                        .filter(|r| r.outcome == Outcome::Failed)
                        .map(|r| r.command.as_str())
                        .collect();
                    format!("{} failed.", failed.join(", "))
                }
                Outcome::NotRun => {
                    let (empty, skipped): (Vec<&CommandEvidence>, Vec<&CommandEvidence>) = runs
                        .iter()
                        .filter(|r| r.outcome == Outcome::NotRun)
                        .partition(|r| r.output.starts_with(ZERO_TESTS));
                    let mut parts = Vec::new();
                    if !skipped.is_empty() {
                        let names: Vec<&str> = skipped.iter().map(|r| r.command.as_str()).collect();
                        parts.push(format!("{} couldn't run.", names.join(", ")));
                    }
                    if !empty.is_empty() {
                        let names: Vec<&str> = empty.iter().map(|r| r.command.as_str()).collect();
                        parts.push(format!("{} couldn't run: {ZERO_TESTS}.", names.join(", ")));
                    }
                    if parts.is_empty() {
                        parts.push("The checks couldn't run.".to_string());
                    }
                    parts.join(" ")
                }
                Outcome::Held => "The no-mistakes layer runs this check before GitHub.".into(),
            };
            GateResult {
                gate: GateKind::Checks,
                outcome,
                detail,
                evidence: runs,
            }
        }
        Err(why) => GateResult {
            gate: GateKind::Checks,
            outcome: Outcome::NotRun,
            detail: format!("It couldn't run: {why}"),
            evidence: Vec::new(),
        },
    }
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(10)]
}

/// The first `max` bytes of `text`, on a char boundary.
fn head_of(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (cut)", &text[..end])
}

// ---- the verdict check --------------------------------------------------------------------------------------------------

const VERDICT_RULES: &str = "You check whether a worker actually did what its brief asked. You get the brief, its \
definition of done, the claims the worker made (a list: its own story is left out on purpose), what the app's code \
already found, the checks the app ran, and the diff. The diff is the truth; a claim is not evidence, and you can run \
nothing. For each claim say verified (the diff shows it), refuted (the diff shows otherwise) or unverifiable (the diff \
can't show it). Then look for these problems: a fix that doesn't fix what the brief asks (false completion); a test \
added or changed so it passes on a wrong value, or weakened or skipped; files changed beyond what was claimed or \
asked (false scope, scope creep); leftover debug code or scratch files (debris); an outward action (push, pull \
request, post) the brief doesn't ask for. Answer with one line of JSON and nothing else: {\"verdict\": \"verified\" | \
\"verified-with-caveats\" | \"refuted\" | \"unsure\", \"why\": \"one plain sentence\", \"claims\": [{\"claim\": \"...\", \
\"observed\": \"...\", \"status\": \"verified\" | \"refuted\" | \"unverifiable\"}], \"frauds\": [\"one plain line \
per problem, starting with its name\"]}. Say refuted when any claim is refuted, any problem is found, or anything the \
definition of done asks for is missing or wrong in the diff; verified-with-caveats when nothing is refuted but a claim \
is unverifiable; verified only when the diff shows every claim and the definition of done; unsure when you can't tell \
from what you were given.";

/// WP-249: the model reads the claims (never the report's wording), the code's findings and the diff.
pub fn verdict_prompt(
    input: &RoundInput,
    diff: &str,
    gates: &[GateResult],
    claims: &[done_check::Claim],
    findings: &[CodeFinding],
) -> String {
    let checks: Vec<String> = gates
        .iter()
        .map(|g| format!("- {}: {} ({})", g.gate.name(), g.outcome.word(), g.detail))
        .collect();
    let mut checks_text = if checks.is_empty() {
        "- none".to_string()
    } else {
        checks.join("\n")
    };
    if gates.iter().any(|gate| gate.outcome == Outcome::Held) {
        checks_text.push_str(
            "\nThe no-mistakes layer runs the project's checks once before GitHub. That is expected, not a missing check.",
        );
    }
    format!(
        "{VERDICT_RULES}\n\n## Brief\n{}\n\n## Definition of done\n{}\n\n## Checks the app ran\n{}\n\n## The worker's claims\n{}\n\n## What the app's code found in the diff\n{}\n\n## Diff\n{}",
        head_of(input.brief.trim(), REPORT_MAX),
        input.done_when.trim(),
        checks_text,
        done_check::claims_text(claims),
        done_check::findings_text(findings),
        if diff.trim().is_empty() { "(no diff)" } else { diff },
    )
}

/// The model's reply as a verdict. Anything that isn't a clear verdict is unsure, never met, and a "verified" that
/// marks any claim refuted is read as refuted.
pub fn parse_verdict(said: &str) -> VerdictResult {
    let found = said
        .char_indices()
        .filter(|(_, c)| *c == '{')
        .find_map(|(start, _)| {
            let rest = &said[start..];
            let end = rest.rfind('}')?;
            serde_json::from_str::<Value>(&rest[..=end]).ok()
        });
    let said_short = crate::gates::tail(said, 500);
    let Some(value) = found else {
        return VerdictResult::plain(Answer::Unsure, "its answer couldn't be read", said_short);
    };
    let text = |value: &Value, max: usize| {
        value
            .as_str()
            .map(|w| w.trim().chars().take(max).collect::<String>())
            .filter(|w| !w.is_empty())
    };
    let why = value.get("why").and_then(|w| text(w, 400));
    let (mut answer, mut label) = match value
        .get("verdict")
        .and_then(Value::as_str)
        .map(|v| v.trim().to_ascii_lowercase().replace([' ', '_'], "-"))
        .as_deref()
    {
        Some("verified") => (Answer::Met, Some(DoneLabel::Verified)),
        Some("verified-with-caveats") => (Answer::Met, Some(DoneLabel::VerifiedWithCaveats)),
        Some("refuted") => (Answer::NotMet, Some(DoneLabel::Refuted)),
        Some("met") => (Answer::Met, None),
        Some("not-met") => (Answer::NotMet, None),
        _ => (Answer::Unsure, None),
    };
    let claims: Vec<ClaimRow> = value
        .get("claims")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(ClaimRow {
                        claim: text(row.get("claim")?, 300)?,
                        observed: row
                            .get("observed")
                            .and_then(|o| text(o, 300))
                            .unwrap_or_default(),
                        status: ClaimStatus::parse(row.get("status")?.as_str()?)?,
                    })
                })
                .take(12)
                .collect()
        })
        .unwrap_or_default();
    let frauds: Vec<String> = value
        .get("frauds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| text(item, 300))
                .take(8)
                .collect()
        })
        .unwrap_or_default();
    if answer == Answer::Met && claims.iter().any(|row| row.status == ClaimStatus::Refuted) {
        answer = Answer::NotMet;
        label = Some(DoneLabel::Refuted);
    }
    VerdictResult {
        answer,
        why: why.unwrap_or_else(|| match answer {
            Answer::Met => "it says the brief was met".into(),
            Answer::NotMet => "it gave no reason".into(),
            Answer::Unsure => "it couldn't tell".into(),
        }),
        said: said_short,
        label,
        claims,
        frauds,
    }
}

fn verdict_check(
    input: &RoundInput,
    repo: &Repo,
    gates: &[GateResult],
    claims: &[done_check::Claim],
    findings: &[CodeFinding],
    runners: &dyn Runners,
) -> VerdictResult {
    if input.done_when.trim().is_empty() {
        return VerdictResult::plain(
            Answer::Unsure,
            "the brief has no definition of done to check against",
            String::new(),
        );
    }
    let diff = if repo.why_not.is_none() {
        repo.diff_text()
    } else {
        String::new()
    };
    match runners.verdict(&verdict_prompt(input, &diff, gates, claims, findings)) {
        Ok(said) => parse_verdict(&said),
        Err(why) => VerdictResult::plain(
            Answer::Unsure,
            format!("the quick check didn't answer ({why})"),
            String::new(),
        ),
    }
}

// ---- storage ------------------------------------------------------------------------------------------------------------

/// A brief's plan and its rounds' evidence, one row per delegation, beside the `delegations` table.
pub fn ensure_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS firstmate_gates (
           delegation_id TEXT PRIMARY KEY,
           plan TEXT NOT NULL,
           records TEXT NOT NULL DEFAULT '[]',
           updated_at INTEGER NOT NULL
         );",
    )
    .map_err(|e| e.to_string())
}

pub fn save_plan(conn: &Connection, id: &str, plan: &GatePlan, now: i64) -> Result<(), String> {
    ensure_table(conn)?;
    let plan = serde_json::to_string(plan).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO firstmate_gates (delegation_id, plan, records, updated_at) VALUES (?1, ?2, '[]', ?3)
         ON CONFLICT(delegation_id) DO UPDATE SET plan = excluded.plan, updated_at = excluded.updated_at",
        params![id, plan, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn plan_of(conn: &Connection, id: &str) -> Result<Option<GatePlan>, String> {
    ensure_table(conn)?;
    let text: Option<String> = conn
        .query_row(
            "SELECT plan FROM firstmate_gates WHERE delegation_id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(text.and_then(|t| serde_json::from_str(&t).ok()))
}

pub fn records_of(conn: &Connection, id: &str) -> Result<Vec<GateRecord>, String> {
    ensure_table(conn)?;
    let text: Option<String> = conn
        .query_row(
            "SELECT records FROM firstmate_gates WHERE delegation_id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(text
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default())
}

pub fn push_record(conn: &Connection, record: &GateRecord) -> Result<(), String> {
    let mut records = records_of(conn, &record.delegation_id)?;
    records.push(record.clone());
    if records.len() > ROUNDS_KEPT {
        let extra = records.len() - ROUNDS_KEPT;
        records.drain(..extra);
    }
    let text = serde_json::to_string(&records).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE firstmate_gates SET records = ?2, updated_at = ?3 WHERE delegation_id = ?1",
        params![record.delegation_id, text, record.at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The next round's number: one more than the last kept.
pub fn next_round(conn: &Connection, id: &str) -> Result<u32, String> {
    Ok(records_of(conn, id)?.last().map(|r| r.round).unwrap_or(0) + 1)
}

/// The evidence as Markdown, for a PR body (WP-12) or the Crew tab (WP-15): the newest round of each delegation.
pub fn evidence_markdown(record: &GateRecord) -> String {
    let mut out = format!(
        "**Gates (round {}): {}**\n\n",
        record.round,
        match record.verdict {
            Verdict::Passed => "passed",
            Verdict::Failed => "failed",
            Verdict::Unsure => "its first mate decides",
        }
    );
    for gate in &record.gates {
        out.push_str(&format!(
            "- {} — {}: {}\n",
            gate.gate.name(),
            gate.outcome.word(),
            gate.detail
        ));
        for run in &gate.evidence {
            let code = run
                .exit_code
                .map(|c| format!("exit {c}"))
                .unwrap_or_else(|| "no exit code".into());
            out.push_str(&format!("  - `{}` ({code})\n", run.command));
            if run.outcome != Outcome::Passed && !run.output.is_empty() {
                let fence = if run.output.contains("```") {
                    "~~~~"
                } else {
                    "```"
                };
                out.push_str(&format!("\n{fence}text\n{}\n{fence}\n\n", run.output));
            }
        }
    }
    if let Some(label) = record.label {
        out.push_str(&format!("- Claims — {}\n", label.word()));
    }
    for problem in record.problems() {
        out.push_str(&format!("  - {problem}\n"));
    }
    if !record.claims.is_empty() {
        let cell = |text: &str| text.replace('|', "\\|").replace('\n', " ");
        out.push_str("\n| Claim | Observed | Status |\n| --- | --- | --- |\n");
        for row in &record.claims {
            out.push_str(&format!(
                "| {} | {} | {} |\n",
                cell(&row.claim),
                cell(&row.observed),
                row.status.word()
            ));
        }
        out.push('\n');
    }
    if let Some(check) = &record.check {
        out.push_str(&format!(
            "- Brief met — {}: {}\n",
            match check.answer {
                Answer::Met => "met",
                Answer::NotMet => "not met",
                Answer::Unsure => "unsure",
            },
            check.why
        ));
    }
    out
}

// ---- the app's runners --------------------------------------------------------------------------------------------------

/// The real runners: the project's trusted checks through the verify stage, the routes script from the app's data
/// folder, and Claude Code's cheapest model with no tools for the verdict.
pub struct AppRunners {
    pub app: tauri::AppHandle,
    pub project_id: Option<String>,
    pub signed_off: bool,
    /// The verdict model (WP-13's role model plugs in here); `haiku` until then.
    pub verdict_model: String,
}

fn step_evidence(step: crate::verify_stage::StepResult) -> CommandEvidence {
    use crate::verify_stage::Outcome as Step;
    let outcome = match step.outcome {
        Step::Passed => Outcome::Passed,
        Step::Failed => Outcome::Failed,
        Step::CouldNotExercise | Step::NotRun => Outcome::NotRun,
    };
    let exit_code = match outcome {
        Outcome::Passed => Some(0),
        _ => step
            .detail
            .split("exit ")
            .nth(1)
            .and_then(|rest| rest.trim_end_matches(')').trim().parse().ok()),
    };
    let log = step
        .log_path
        .as_deref()
        .and_then(|path| std::fs::read(path).ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
    let mut output = log
        .as_deref()
        .map(|text| crate::gates::tail(text, OUTPUT_MAX))
        .unwrap_or_else(|| step.detail.clone());
    // SC-3a: the whole log is read for the test count, not the tail kept as evidence: cargo's last summary is the
    // empty doc-tests, which would read a library that ran 500 tests as one that ran none.
    let mut outcome = outcome;
    if outcome == Outcome::Passed {
        if let Some(note) = log.as_deref().and_then(zero_tests_note) {
            outcome = Outcome::NotRun;
            output = format!("{note}\n{output}");
        }
    }
    CommandEvidence {
        command: step.name,
        outcome,
        exit_code,
        output,
        seconds: step.seconds,
    }
}

/// SC-3a: what a step says when it passed but its runner reports that no test ran.
const ZERO_TESTS: &str = "ran zero tests";

/// The first words of a step's output when its log shows no test ran: `ran zero tests`, then which runner said so.
/// `None` when the log holds no test summary (a build or a lint step) or tests ran.
fn zero_tests_note(log: &str) -> Option<String> {
    let found = crate::test_summary::parse(log)?;
    (found.total == 0).then(|| {
        format!(
            "{ZERO_TESTS}: {} reported {} passed, {} failed, {} skipped.",
            found.runner.name(),
            found.passed,
            found.failed,
            found.skipped
        )
    })
}

/// SC-3a: a step that exited cleanly but ran zero tests did not test anything. It could not run, and is never a pass.
/// A step that failed, one that couldn't run for another reason and one with no test summary keep their word. An
/// output `gates::tail` has cut (it starts with an ellipsis) is the end of a longer log, so a count read from it
/// isn't the run's: `step_evidence` has already read the whole log.
fn zero_tests_is_not_a_pass(mut run: CommandEvidence) -> CommandEvidence {
    if run.outcome != Outcome::Passed || run.output.starts_with('…') {
        return run;
    }
    if let Some(note) = zero_tests_note(&run.output) {
        run.outcome = Outcome::NotRun;
        run.output = format!("{note}\n{}", run.output);
    }
    run
}

impl Runners for AppRunners {
    fn checks(
        &self,
        checkout: &Path,
        named: &[String],
        changed: &[String],
    ) -> Result<Vec<CommandEvidence>, String> {
        use crate::project_file;
        let (main, checkout) = crate::project_actions::checkout_of_project(checkout)?;
        let data = project_file::data_dir(&self.app)?;
        let Some(file) = project_file::trusted_file(&data, &main) else {
            return Err(
                "this project's .monocode/project.json is missing or not imported (Settings > Worktrees), so it declares no checks."
                    .into(),
            );
        };
        let run = |id: &str, name: &str, command: &str, timeout: u64| {
            step_evidence(crate::verify_stage::run_check(
                &self.app, &main, &checkout, id, name, command, timeout,
            ))
        };
        if !named.is_empty() {
            return Ok(named
                .iter()
                .map(|id| {
                    if let Some(check) = file.verify.checks.iter().find(|c| &c.id == id) {
                        return run(
                            &check.id,
                            &check.name,
                            &check.command,
                            check.timeout_seconds(),
                        );
                    }
                    match file.actions.iter().find(|a| &a.id == id && !a.long_running) {
                        Some(action) => run(
                            &action.id,
                            &action.name,
                            &action.command,
                            action
                                .timeout_seconds()
                                .unwrap_or(project_file::DEFAULT_TIMEOUT_SECONDS),
                        ),
                        None => CommandEvidence {
                            command: id.clone(),
                            outcome: Outcome::NotRun,
                            exit_code: None,
                            output: format!("The project has no check or action called {id}."),
                            seconds: 0.0,
                        },
                    }
                })
                .collect());
        }
        if !file.verify.checks.is_empty() {
            // The checks for the folders the change touched, like the verify stage; all of them when none matched.
            let touched: Vec<_> = file
                .verify
                .checks
                .iter()
                .filter(|c| {
                    changed
                        .iter()
                        .any(|p| crate::verify_stage::in_folder(p, c.dir()))
                })
                .collect();
            let chosen = if touched.is_empty() {
                file.verify.checks.iter().collect()
            } else {
                touched
            };
            return Ok(chosen
                .into_iter()
                .map(|c| run(&c.id, &c.name, &c.command, c.timeout_seconds()))
                .collect());
        }
        match file
            .actions
            .iter()
            .find(|a| a.id == "check" && !a.long_running)
        {
            Some(action) => Ok(vec![run(
                &action.id,
                &action.name,
                &action.command,
                action
                    .timeout_seconds()
                    .unwrap_or(project_file::DEFAULT_TIMEOUT_SECONDS),
            )]),
            None => {
                Err("this project declares no checks (verify.checks or a Check action).".into())
            }
        }
    }

    fn routes(&self, checkout: &Path) -> Option<CommandEvidence> {
        use tauri::Manager;
        let project_id = self.project_id.as_deref()?;
        let dir = self.app.path().app_data_dir().ok()?.join("gates");
        let (config, script) = match crate::gates::gate_for(&dir, project_id) {
            Ok(Some(found)) => found,
            Ok(None) => return None,
            Err(why) => {
                return Some(CommandEvidence {
                    command: "routes check".into(),
                    outcome: Outcome::NotRun,
                    exit_code: None,
                    output: why,
                    seconds: 0.0,
                })
            }
        };
        let name = config.name.clone().unwrap_or_else(|| "Routes check".into());
        // WP-91: a worker's checkout may be a slot of the worktree pool.
        let pool_slots = crate::worktree_pool::slots_dir_for(&self.app);
        let checkout = match crate::gates::worker_checkout_in(
            &checkout.to_string_lossy(),
            pool_slots.as_deref(),
        ) {
            Ok(path) => path,
            Err(why) => {
                return Some(CommandEvidence {
                    command: name,
                    outcome: Outcome::NotRun,
                    exit_code: None,
                    output: why,
                    seconds: 0.0,
                })
            }
        };
        let items = if self.signed_off {
            config.sign_off.clone()
        } else {
            Vec::new()
        };
        let started = Instant::now();
        let data = self.app.path().app_data_dir().ok();
        let wrap = match crate::agent_sandbox::action_wrap(
            data.as_deref(),
            std::slice::from_ref(&checkout),
        ) {
            Ok(wrap) => wrap,
            Err(why) => {
                return Some(CommandEvidence {
                    command: name,
                    outcome: Outcome::NotRun,
                    exit_code: None,
                    output: why,
                    seconds: 0.0,
                })
            }
        };
        let (ok, output) = crate::gates::run_script(
            &script,
            &checkout,
            &items,
            crate::harness::login_shell_path(),
            crate::gates::GATE_TIMEOUT,
            wrap.as_deref(),
        );
        Some(CommandEvidence {
            command: name,
            outcome: if ok { Outcome::Passed } else { Outcome::Failed },
            exit_code: Some(if ok { 0 } else { 1 }),
            output,
            seconds: started.elapsed().as_secs_f64(),
        })
    }

    fn verdict(&self, prompt: &str) -> Result<String, String> {
        // WP-176 round 4: a verdict is an automated turn. It is refused over the spend limit before it runs, and its
        // call is noted in the ledger as an unpriced Claude call after it (gated_verdict, the same seam the tests drive).
        use tauri::Manager;
        let now = crate::spend_ledger::now_ms();
        crate::spend_ledger::gated_verdict(
            &|with| {
                let store = self.app.state::<SessionStore>();
                let conn = store.lock_conn()?;
                with(&conn)
            },
            self.project_id.as_deref(),
            now,
            || {
                let claude = crate::harness::harness_resolve_claude()?.path;
                claude_verdict(&claude, &self.verdict_model, prompt, VERDICT_TIMEOUT)
            },
        )
    }
}

/// One Claude Code turn with no tools and no MCP servers, the prompt on stdin, in an empty folder.
pub fn claude_verdict(
    binary: &str,
    model: &str,
    prompt: &str,
    timeout: Duration,
) -> Result<String, String> {
    let dir = std::env::temp_dir().join(format!(
        "monocode-verdict-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(binary);
    cmd.args([
        "-p",
        "--model",
        model,
        "--output-format",
        "text",
        "--tools",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
    ])
    .current_dir(&dir)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    crate::harness::apply_gui_env(&mut cmd);
    // The binary is the same Claude Code a worker can replace. Under the sandbox that replacement still cannot
    // reach the switch file or a secret. Tests do not call this: it would read the daily data folder.
    #[cfg(not(test))]
    {
        let data = crate::instance::data_dir(&crate::instance::current().identifier);
        match crate::agent_sandbox::action_wrap(data.as_deref(), &[]) {
            Ok(prefix) => {
                cmd = crate::agent_sandbox::under_wrap(cmd, prefix.as_deref());
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(error);
            }
        }
    }
    let result = (|| {
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Claude Code couldn't start: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes());
        }
        let mut out = child.stdout.take();
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(o) = out.as_mut() {
                let _ = o.read_to_string(&mut s);
            }
            s
        });
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() > timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("it ran past {} seconds", timeout.as_secs()));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(e) => return Err(e.to_string()),
            }
        };
        let said = reader.join().unwrap_or_default();
        if !status.success() {
            return Err(format!(
                "Claude Code exited with {}",
                status.code().unwrap_or(-1)
            ));
        }
        Ok(said)
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

// ---- commands -----------------------------------------------------------------------------------------------------------

use tauri::{AppHandle, Emitter, State};

use crate::delegations;
use crate::session_store::{now_millis, SessionStore};

/// The project's default gates for a code brief, from its imported project file.
fn project_defaults(app: &AppHandle, folder: Option<&str>) -> Vec<String> {
    let Some(folder) = folder else {
        return Vec::new();
    };
    let Ok(main) = crate::project_file::main_checkout(&crate::fs::expand_home(folder)) else {
        return Vec::new();
    };
    let Ok(data) = crate::project_file::data_dir(app) else {
        return Vec::new();
    };
    crate::project_file::trusted_file(&data, &main)
        .map(|file| file.verify.gates)
        .unwrap_or_default()
}

/// Checks a first mate's gate choice before anything starts; `Ok` carries the plan it resolves to.
#[tauri::command(async)]
pub fn firstmate_gates_resolve(
    app: AppHandle,
    input: PlanInput,
    folder: Option<String>,
) -> Result<GatePlan, String> {
    resolve_plan(&input, &project_defaults(&app, folder.as_deref()))
}

/// Keeps a started delegation's gates. An empty plan keeps nothing: its worker's report settles as before.
#[tauri::command(async)]
pub fn firstmate_gates_plan(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
    input: PlanInput,
    folder: Option<String>,
) -> Result<GatePlan, String> {
    let plan = resolve_plan(&input, &project_defaults(&app, folder.as_deref()))?;
    if !plan.gates.is_empty() {
        save_plan(&*store.lock_conn()?, &id, &plan, now_millis())?;
    }
    Ok(plan)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInput {
    pub delegation_id: String,
    pub checkout: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub signed_off: bool,
    #[serde(default)]
    pub report: String,
    /// WP-145: this turn's facts. A bad shape is read loosely and never fails the command.
    #[serde(default)]
    pub facts: Option<serde_json::Value>,
}

/// What a plan-less turn does with the facts the webview sent.
/// `firstmate_run_gates` is the only caller. A missing turn is not clean.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlanlessFacts {
    /// Facts are present and show no gap. A send-back may be cleared.
    Clear,
    /// The webview sent no facts. Do not clear a send-back and do not mark the row pending.
    Keep,
    /// The facts have a gap. Write the fact-only record.
    Gaps,
}

fn planless_facts(
    facts: Option<&super::fact_gaps::FactTurn>,
    checkout: Option<&std::path::Path>,
) -> PlanlessFacts {
    match facts {
        None => PlanlessFacts::Keep,
        Some(turn) if super::fact_gaps::done_gaps_in(turn, checkout).is_empty() => {
            PlanlessFacts::Clear
        }
        Some(_) => PlanlessFacts::Gaps,
    }
}

/// A failed record for fact gaps when the brief stored no plan, so the routes check stays where it is.
fn fact_only_record(
    delegation_id: &str,
    round: u32,
    now: i64,
    facts: &super::fact_gaps::FactTurn,
    checkout: Option<&std::path::Path>,
) -> Option<GateRecord> {
    let gaps = super::fact_gaps::done_gaps_in(facts, checkout);
    if gaps.is_empty() {
        return None;
    }
    Some(GateRecord {
        delegation_id: delegation_id.to_string(),
        round,
        at: now,
        verdict: Verdict::Failed,
        gates: Vec::new(),
        check: None,
        summary: super::fact_gaps::fact_summary(&gaps),
        label: None,
        findings: Vec::new(),
        claims: Vec::new(),
        tree: None,
        checkout: None,
        testing_mode: None,
        note: None,
    })
}

/// Runs a finished worker's gates and verdict check. `None`: its brief has no gates and the turn's facts show no
/// gap (the routes check alone runs as before, through `run_worker_gate`).
#[tauri::command]
pub async fn firstmate_run_gates(
    app: AppHandle,
    input: RunInput,
) -> Result<Option<GateRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let store = app.state::<SessionStore>();
        let facts = input
            .facts
            .as_ref()
            .map(super::fact_gaps::fact_turn_from_value);
        let (plan, row, gate_owns_checks, mode) = {
            let conn = store.lock_conn()?;
            let plan = plan_of(&conn, &input.delegation_id)?;
            let row = delegations::tree(&conn, &input.delegation_id)?
                .into_iter()
                .find(|r| r.id == input.delegation_id);
            let gate_owns_checks = row.as_ref().is_some_and(|row| {
                row.project.as_deref().is_some_and(|project| {
                    crate::delivery_gate::owns_project_checks(&conn, project, &input.delegation_id)
                })
            });
            // SC-3a: the project's testing mode, read with the plan so a change in another window can't split them.
            let mode = row
                .as_ref()
                .and_then(|row| row.project.as_deref())
                .map(|project| crate::delivery::settings::testing_mode_for(&conn, project))
                .unwrap_or_default();
            (plan, row, gate_owns_checks, mode)
        };
        let Some(row) = row else {
            return Ok(None);
        };
        let checkout = crate::fs::expand_home(&input.checkout);
        // SC-3a: the gates come from what the copy changed and the project's mode, not from whether the brief said
        // `code`. A copy that isn't a checkout has no diff to read; one whose diff couldn't be read is treated as
        // changed, so the gates run and say they couldn't rather than skip.
        let (changed, code_changed) = {
            let repo = Repo::open(&checkout);
            if repo.why_not.is_some() {
                (Vec::new(), false)
            } else {
                match repo.changed() {
                    Ok(files) => {
                        let code = testing_mode::code_changed(&files);
                        (files, code)
                    }
                    Err(_) => (Vec::new(), true),
                }
            }
        };
        let moded = testing_mode::gates_for(mode, plan.as_ref(), &changed, code_changed);
        // Nothing changed and no plan was stored (a research or answer task): the task settles as it always did.
        // Missing facts are not a clean turn: a send-back stays, and the row is not marked pending.
        // A present turn with no gap clears a send-back, or the delivered row stays failed.
        if moded.as_today {
            match planless_facts(facts.as_ref(), Some(checkout.as_path())) {
                PlanlessFacts::Clear => {
                    if row.gate_verdict.as_deref() == Some(GateVerdict::FAILED)
                        && super::status::sent_back_on(&row)
                    {
                        let change = delegations::set_gate_verdict(
                            &mut *store.lock_conn()?,
                            &row.id,
                            GateVerdict::PASSED,
                            "the later facts show no gap",
                            None,
                            now_millis(),
                        )?;
                        if change.applied {
                            let _ = app
                                .emit(delegations::CHANGED, serde_json::json!({ "ids": [row.id] }));
                            crate::tasks::emit_for_delegations(&app); // WP-70
                        }
                    }
                    return Ok(None);
                }
                PlanlessFacts::Keep => return Ok(None),
                PlanlessFacts::Gaps => {}
            }
        }
        let round = next_round(&*store.lock_conn()?, &row.id)?;
        // Pending while they run, so nothing reads the row as done in between.
        {
            let change = delegations::set_gate_verdict(
                &mut *store.lock_conn()?,
                &row.id,
                GateVerdict::PENDING,
                "checks are running",
                None,
                now_millis(),
            )?;
            if change.applied {
                let _ = app.emit(delegations::CHANGED, serde_json::json!({ "ids": [row.id] }));
                crate::tasks::emit_for_delegations(&app); // WP-70
            }
        }
        let runners = AppRunners {
            app: app.clone(),
            project_id: input.project_id.clone(),
            signed_off: input.signed_off,
            verdict_model: std::env::var("MONOCODE_VERDICT_MODEL")
                .ok()
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| "haiku".into()),
        };
        let now = now_millis();
        let record = if !moded.as_today {
            run_round(
                &RoundInput {
                    delegation_id: &row.id,
                    round,
                    checkout: &checkout,
                    plan: &moded.gate_plan(),
                    brief: row.brief.as_deref().unwrap_or(""),
                    done_when: row.goal.as_deref().unwrap_or(""),
                    report: &input.report,
                    now,
                    gate_owns_checks,
                    facts: facts.as_ref(),
                    mode: Some(&moded),
                },
                &runners,
            )
        } else {
            // Checked above: a task that changed nothing and stored no plan only reaches here when the facts have a gap.
            // A second empty read returns nothing rather than marking the row failed.
            let Some(turn) = facts.as_ref() else {
                return Ok(None);
            };
            let Some(record) =
                fact_only_record(&row.id, round, now, turn, Some(checkout.as_path()))
            else {
                return Ok(None);
            };
            record
        };
        let mut conn = store.lock_conn()?;
        push_record(&conn, &record)?;
        let change = delegations::set_gate_verdict(
            &mut conn,
            &row.id,
            record.verdict.stored(),
            &record.summary,
            None,
            now_millis(),
        )?;
        drop(conn);
        if change.applied {
            let _ = app.emit(delegations::CHANGED, serde_json::json!({ "ids": [row.id] }));
            crate::tasks::emit_for_delegations(&app); // WP-70
        }
        Ok(Some(record))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every kept round of a delegation's gates, oldest first, with the newest as Markdown for a PR body or the Crew tab.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateEvidence {
    pub plan: Option<GatePlan>,
    pub records: Vec<GateRecord>,
    pub markdown: Option<String>,
}

#[tauri::command(async)]
pub fn firstmate_gate_evidence(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<GateEvidence, String> {
    let conn = store.lock_conn()?;
    let records = records_of(&conn, &id)?;
    Ok(GateEvidence {
        plan: plan_of(&conn, &id)?,
        markdown: records.last().map(evidence_markdown),
        records,
    })
}

/// The first mate's call on an unsure verdict (`task_accept`): accepted is passed, refused is failed, with its reason.
#[tauri::command(async)]
pub fn firstmate_gates_decide(
    app: AppHandle,
    store: State<'_, SessionStore>,
    owner_session: String,
    id: String,
    accept: bool,
    reason: Option<String>,
) -> Result<delegations::Change, String> {
    // SC-3a: asked first, so a missing reason is refused before the whole copy is read again.
    reason_needed(accept, reason.as_deref())?;
    // WP-249: an accept is of the files that were checked; a later change voids the verdict.
    if accept {
        let newest = records_of(&*store.lock_conn()?, &id)?.pop();
        verdict_tree_holds(newest.as_ref(), None)?;
    }
    decide(
        &mut *store.lock_conn()?,
        &owner_session,
        &id,
        accept,
        reason.as_deref(),
        now_millis(),
    )
    .inspect(|change| {
        if change.applied {
            let _ = app.emit(delegations::CHANGED, serde_json::json!({ "ids": [id] }));
            crate::tasks::emit_for_delegations(&app); // WP-70
        }
    })
}

/// SC-3a: refusing a task and accepting one without a pass both say why, in every testing mode. A reason that is only
/// blanks is none.
fn reason_needed(accept: bool, reason: Option<&str>) -> Result<(), String> {
    if reason.is_some_and(|reason| !reason.trim().is_empty()) {
        return Ok(());
    }
    Err(if accept {
        "Say why you accept it without a pass (reason), in one plain line.".into()
    } else {
        "Say why it isn't done (reason), in one plain line.".into()
    })
}

pub fn decide(
    conn: &mut Connection,
    owner: &str,
    id: &str,
    accept: bool,
    reason: Option<&str>,
    now: i64,
) -> Result<delegations::Change, String> {
    let reason = reason.map(str::trim).filter(|r| !r.is_empty());
    reason_needed(accept, reason)?;
    let (verdict, summary) = if accept {
        (
            GateVerdict::PASSED,
            format!(
                "{}{}",
                super::status::ACCEPTED_LEAD,
                reason.map(|r| format!(": {r}")).unwrap_or_default()
            ),
        )
    } else {
        (
            GateVerdict::FAILED,
            format!("its first mate refused it: {}", reason.unwrap_or_default()),
        )
    };
    let change = delegations::set_gate_verdict(conn, id, verdict, &summary, Some(owner), now)?;
    if change.applied && accept {
        // SC-3a: an accept without a pass is on the record twice: the row's own log (the gates line, with the reason)
        // and the process log, so a run of them can be found afterwards. One line, cut short.
        let said: String = reason
            .unwrap_or_default()
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect();
        eprintln!("task {id} accepted without a pass by {owner}: {said}");
    }
    if !change.applied {
        return Err(match change.row {
            None => "There's no task with that id.".into(),
            Some(row) if row.owner_session != owner => "That task isn't one of yours.".into(),
            Some(_) => {
                "Only a finished task whose checks are waiting on you can be accepted or refused."
                    .into()
            }
        });
    }
    Ok(change)
}

#[cfg(test)]
#[path = "gates_tests.rs"]
mod tests;

/// Review r5 repro for PR #208 (WP-178). Red at a5bc60a97.
#[cfg(test)]
mod review_r5_repro {
    /// HIGH (new, H-E class): when a delegated worker reports done, the app runs the verdict gate by itself:
    /// `claude -p …` through `claude_verdict`, plain, outside the sandbox. The program is the same Claude Code the worker
    /// runs as, and its real file is writable from inside the sandbox: `~/.local/bin/claude` is a link into
    /// `~/.local/share/claude/versions/<v>` (only the link's own folder is denied), and an npm install lives under
    /// `/opt/homebrew/lib/node_modules` or `~/.claude/local`. The worker replaces that file, reports done, and the app
    /// runs it unwrapped. The seam is `agent_sandbox::under_wrap` (gates' own scripts already use it); a unit test cannot
    /// turn the sandbox on off macOS, so this reads the function.
    #[test]
    fn the_verdict_gate_runs_claude_under_the_agent_sandbox() {
        let source = include_str!("gates.rs");
        let start = source
            .find("pub fn claude_verdict(")
            .expect("claude_verdict");
        let end = source[start..]
            .find("\n}\n")
            .map(|end| start + end)
            .expect("end of claude_verdict");
        assert!(
            source[start..end].contains("agent_sandbox::"),
            "the verdict gate runs the worker's own Claude Code binary outside the sandbox"
        );
    }
}
