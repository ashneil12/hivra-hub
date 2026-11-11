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
//! Ideas from Puppetmaster's gates (`require_diff`, `command`, `committed`, `ratchet`; MIT) and Raven's "finished is not
//! succeeded" verdict gate (Apache-2.0, ideas only). No code is vendored.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::status::GateVerdict;

/// The longest output tail kept per command.
pub const OUTPUT_MAX: usize = 2_000;
/// The rounds of evidence kept per delegation (the first try, the fix round, and a few redoes).
const ROUNDS_KEPT: usize = 6;
/// How much of the report and the diff the verdict model reads.
const REPORT_MAX: usize = 6_000;
const DIFF_MAX: usize = 12_000;
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
    // WP-145: a fact gap fails the claim. The model is not asked, and a gap is not "unsure".
    let gaps = input
        .facts
        .map(super::fact_gaps::done_gaps)
        .unwrap_or_default();
    let check = (gaps.is_empty() && (overall == Outcome::Passed || gates.is_empty()))
        .then(|| verdict_check(input, &repo, &gates, runners));
    let verdict = match (overall, gaps.is_empty(), check.as_ref().map(|c| c.answer)) {
        (Outcome::Failed, _, _) | (_, false, _) | (_, _, Some(Answer::NotMet)) => Verdict::Failed,
        (_, _, Some(Answer::Met)) => Verdict::Passed,
        _ => Verdict::Unsure,
    };
    let summary = summary_of(&gates, check.as_ref(), verdict, &gaps);
    GateRecord {
        delegation_id: input.delegation_id.to_string(),
        round: input.round,
        at: input.now,
        verdict,
        gates,
        check,
        summary,
    }
}

fn summary_of(
    gates: &[GateResult],
    check: Option<&VerdictResult>,
    verdict: Verdict,
    gaps: &[String],
) -> String {
    let mut lines = Vec::new();
    // The first line is what the task card and the inbox show.
    if !gaps.is_empty() {
        lines.push(super::fact_gaps::fact_summary(gaps));
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
        Some(c) if c.answer == Answer::NotMet => lines.push(format!(
            "The brief's definition of done isn't met: {}",
            c.why
        )),
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
        return format!("{lead}; the quick check says the brief was met.{handoff}");
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
    let mut cmd = Command::new("git");
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
    text.lines()
        .map(str::trim_start)
        .filter(|line| match ext {
            "rs" => line.starts_with("#[test]") || line.starts_with("#[tokio::test"),
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
                    let skipped: Vec<&str> = runs
                        .iter()
                        .filter(|r| r.outcome == Outcome::NotRun)
                        .map(|r| r.command.as_str())
                        .collect();
                    format!("{} couldn't run.", skipped.join(", "))
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
definition of done, the worker's report and the diff of what it changed. The report is a claim, not evidence; judge \
from the diff and the checks. Answer with one line of JSON and nothing else: {\"verdict\": \"met\" | \"not-met\" | \
\"unsure\", \"why\": \"one plain sentence\"}. Say not-met only when something the definition of done asks for is \
missing or wrong in the diff; say unsure when you can't tell from what you were given.";

pub fn verdict_prompt(input: &RoundInput, diff: &str, gates: &[GateResult]) -> String {
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
        "{VERDICT_RULES}\n\n## Brief\n{}\n\n## Definition of done\n{}\n\n## Checks the app ran\n{}\n\n## Worker's report\n{}\n\n## Diff\n{}",
        head_of(input.brief.trim(), REPORT_MAX),
        input.done_when.trim(),
        checks_text,
        head_of(input.report.trim(), REPORT_MAX),
        if diff.trim().is_empty() { "(no diff)" } else { diff },
    )
}

/// The model's reply as a verdict. Anything that isn't a clear met or not met is unsure, never met.
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
        return VerdictResult {
            answer: Answer::Unsure,
            why: "its answer couldn't be read".into(),
            said: said_short,
        };
    };
    let why = value
        .get("why")
        .and_then(Value::as_str)
        .map(|w| w.trim().chars().take(400).collect::<String>())
        .filter(|w| !w.is_empty());
    let answer = match value
        .get("verdict")
        .and_then(Value::as_str)
        .map(|v| v.trim().to_ascii_lowercase().replace([' ', '_'], "-"))
        .as_deref()
    {
        Some("met") => Answer::Met,
        Some("not-met") => Answer::NotMet,
        _ => Answer::Unsure,
    };
    VerdictResult {
        answer,
        why: why.unwrap_or_else(|| match answer {
            Answer::Met => "it says the brief was met".into(),
            Answer::NotMet => "it gave no reason".into(),
            Answer::Unsure => "it couldn't tell".into(),
        }),
        said: said_short,
    }
}

fn verdict_check(
    input: &RoundInput,
    repo: &Repo,
    gates: &[GateResult],
    runners: &dyn Runners,
) -> VerdictResult {
    if input.done_when.trim().is_empty() {
        return VerdictResult {
            answer: Answer::Unsure,
            why: "the brief has no definition of done to check against".into(),
            said: String::new(),
        };
    }
    let diff = if repo.why_not.is_none() {
        repo.diff_text()
    } else {
        String::new()
    };
    match runners.verdict(&verdict_prompt(input, &diff, gates)) {
        Ok(said) => parse_verdict(&said),
        Err(why) => VerdictResult {
            answer: Answer::Unsure,
            why: format!("the quick check didn't answer ({why})"),
            said: String::new(),
        },
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
    let output = step
        .log_path
        .as_deref()
        .and_then(|path| std::fs::read(path).ok())
        .map(|bytes| crate::gates::tail(&String::from_utf8_lossy(&bytes), OUTPUT_MAX))
        .unwrap_or_else(|| step.detail.clone());
    CommandEvidence {
        command: step.name,
        outcome,
        exit_code,
        output,
        seconds: step.seconds,
    }
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
        let (ok, output) = crate::gates::run_script(
            &script,
            &checkout,
            &items,
            crate::harness::login_shell_path(),
            crate::gates::GATE_TIMEOUT,
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
        let claude = crate::harness::harness_resolve_claude()?.path;
        claude_verdict(&claude, &self.verdict_model, prompt, VERDICT_TIMEOUT)
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

/// A failed record for fact gaps when the brief stored no plan, so the routes check stays where it is.
fn fact_only_record(
    delegation_id: &str,
    round: u32,
    now: i64,
    facts: &super::fact_gaps::FactTurn,
) -> Option<GateRecord> {
    let gaps = super::fact_gaps::done_gaps(facts);
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
        let (plan, row, gate_owns_checks) = {
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
            (plan, row, gate_owns_checks)
        };
        let Some(row) = row else {
            return Ok(None);
        };
        // No stored plan and nothing in the facts: the routes check still runs in the webview.
        if plan.is_none()
            && facts
                .as_ref()
                .is_none_or(|turn| super::fact_gaps::done_gaps(turn).is_empty())
        {
            return Ok(None);
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
        let checkout = crate::fs::expand_home(&input.checkout);
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
        let record = if let Some(plan) = &plan {
            run_round(
                &RoundInput {
                    delegation_id: &row.id,
                    round,
                    checkout: &checkout,
                    plan,
                    brief: row.brief.as_deref().unwrap_or(""),
                    done_when: row.goal.as_deref().unwrap_or(""),
                    report: &input.report,
                    now,
                    gate_owns_checks,
                    facts: facts.as_ref(),
                },
                &runners,
            )
        } else {
            // Checked above: a plan-less turn only reaches here when the facts have a gap.
            // A second empty read returns nothing rather than marking the row failed.
            let Some(turn) = facts.as_ref() else {
                return Ok(None);
            };
            let Some(record) = fact_only_record(&row.id, round, now, turn) else {
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

pub fn decide(
    conn: &mut Connection,
    owner: &str,
    id: &str,
    accept: bool,
    reason: Option<&str>,
    now: i64,
) -> Result<delegations::Change, String> {
    let reason = reason.map(str::trim).filter(|r| !r.is_empty());
    if !accept && reason.is_none() {
        return Err("Say why it isn't done (reason), in one plain line.".into());
    }
    let (verdict, summary) = if accept {
        (
            GateVerdict::PASSED,
            format!(
                "its first mate accepted it{}",
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
