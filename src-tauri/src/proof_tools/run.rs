//! PT-1: running the proof tools a project already has over a change.
//!
//! Everything goes through the SAME sandboxed runner the project's checks and a brief's check lines use (`Env::run` is
//! `verify_stage::run_proof_line`, which is `run_command_with` with the environment cleared down to the allow-list). The
//! runner takes a shell string, so no file name, range or URL is ever put in it: `command::prepare` names each one as a quoted
//! environment word. Scratch files (a diff for cargo-mutants, a tool's own output folder) live in a folder outside the
//! project and are removed after the run, each only after it is proved to be inside that folder.
//!
//! A run is trimmed to what a person acts on (`trim`): failures, survivors, findings. Zero tests run, a timeout, a tool
//! error or a service that didn't answer is "could not run", never a pass. A tool with nothing to read in this change (no
//! changed line in a file it reads) is "did not run", which is neither.

use std::path::{Path, PathBuf};

use crate::firstmate::brief_checks::{Ended, RawRun};

use super::command::{self, Fill, Prepared};
use super::detect::{self, Detection, Probe};
use super::{diff, trim, Kind, Outcome, Pick, Scope, TestRun, Tool, ToolRun};

/// How long a tool may run before it is stopped and counts as "could not run".
pub const MUTATION_SECONDS: u64 = 30 * 60;
pub const E2E_SECONDS: u64 = 15 * 60;
pub const API_SECONDS: u64 = 10 * 60;
pub const PATTERN_SECONDS: u64 = 5 * 60;
/// A version probe (`cargo mutants --version`).
pub const PROBE_SECONDS: u64 = 20;
/// The largest untracked file turned into diff lines, and how many.
const NEW_FILE_MAX_BYTES: u64 = 200_000;
const NEW_FILES_MAX: usize = 200;

pub fn timeout_of(kind: Kind) -> u64 {
    match kind {
        Kind::Property | Kind::Pattern => PATTERN_SECONDS,
        Kind::Mutation => MUTATION_SECONDS,
        Kind::E2e => E2E_SECONDS,
        Kind::Api => API_SECONDS,
    }
}

/// What a run needs from the app. The real one is `AppEnv`; tests use a fake.
pub trait Env {
    /// Whether a program answers (`cargo mutants --version`): through the sandboxed runner, with a short timeout. A failure
    /// to start, a timeout or a non-zero exit is "no".
    fn probe(&self, argv: &[String]) -> bool;
    /// One prepared command, in the folder the tools run in, under the sandbox. `id` names the run.
    fn run(&self, id: &str, name: &str, prepared: &Prepared, timeout_seconds: u64) -> RawRun;
    /// A folder outside the project for a diff and a tool's own output. Absent: tools that need one could not run.
    fn scratch(&self) -> Option<PathBuf>;
}

struct EnvProbe<'a>(&'a dyn Env);

impl Probe for EnvProbe<'_> {
    fn available(&self, argv: &[String]) -> bool {
        self.0.probe(argv)
    }
}

/// Which tools fit `root` and which it has, asking `env` to probe programs.
pub fn detect_in(root: &Path, env: &dyn Env) -> Detection {
    detect::detect(root, &EnvProbe(env))
}

// ---- the change ---------------------------------------------------------------------------------------------------------

fn git_text(dir: &Path, args: &[&str]) -> String {
    match crate::firstmate::gates::git(dir, args) {
        Ok((true, out, _)) => String::from_utf8_lossy(&out).into_owned(),
        _ => String::new(),
    }
}

/// New files git doesn't ignore, as diffs that add every line, so a tool scoped by a diff sees them. A file that is too
/// large, isn't text or is a link adds nothing.
fn untracked_diff(dir: &Path) -> String {
    let listed = git_text(dir, &["ls-files", "--others", "--exclude-standard"]);
    let mut out = String::new();
    for path in listed
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('"'))
        .take(NEW_FILES_MAX)
    {
        let full = dir.join(path);
        let Ok(meta) = std::fs::symlink_metadata(&full) else {
            continue;
        };
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > NEW_FILE_MAX_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&full) else {
            continue;
        };
        if bytes.contains(&0) {
            continue;
        }
        if let Ok(text) = String::from_utf8(bytes) {
            out.push_str(&diff::untracked_as_diff(path, &text));
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    out
}

/// The scope of a checkout's change since `base` (or HEAD): committed or not, and new files git doesn't ignore. `changed` is
/// the file list the caller already read (`Repo::changed`).
pub fn scope_of(dir: &Path, base: Option<&str>, changed: &[String]) -> Scope {
    let from = base.unwrap_or("HEAD");
    let mut text = git_text(
        dir,
        &[
            "diff",
            "-U0",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            from,
            "--",
        ],
    );
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&untracked_diff(dir));
    Scope {
        base: base.map(str::to_string),
        changed: changed.to_vec(),
        diff: text,
    }
}

/// The scope of a commit range of a project's main checkout (the ship check): `from` is the base commit, or the empty tree
/// when the range reaches the first commit (then there is no `{base}`).
pub fn scope_of_range(
    main: &Path,
    base: Option<&str>,
    from: &str,
    to: &str,
    changed: &[String],
) -> Scope {
    let text = git_text(
        main,
        &[
            "diff",
            "-U0",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            from,
            to,
            "--",
        ],
    );
    Scope {
        base: base.map(str::to_string),
        changed: changed.to_vec(),
        diff: text,
    }
}

// ---- one run -------------------------------------------------------------------------------------------------------------

fn plain(tool: &'static Tool, outcome: Outcome, detail: impl Into<String>) -> ToolRun {
    ToolRun {
        tool,
        outcome,
        detail: detail.into(),
        lines: Vec::new(),
        command: None,
        tail: None,
        seconds: 0.0,
    }
}

/// Why a run can't start (a hole nothing fills), or that it has nothing to do.
enum Skip {
    NothingToDo(String),
    CouldNot(String),
}

impl Skip {
    fn run(self, tool: &'static Tool) -> ToolRun {
        match self {
            Skip::NothingToDo(why) => plain(tool, Outcome::NotRun, why),
            Skip::CouldNot(why) => plain(tool, Outcome::CouldNotRun, why),
        }
    }
}

/// A folder made for one run, removed when it is dropped, and only if it is still inside the scratch base.
struct Scratch {
    base: PathBuf,
    dir: PathBuf,
}

impl Scratch {
    fn make(env: &dyn Env) -> Result<Scratch, String> {
        let base = env.scratch().ok_or_else(|| {
            "there is no scratch folder outside the project to write to".to_string()
        })?;
        let dir = base.join(format!("proof-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("the scratch folder couldn't be made: {e}"))?;
        Ok(Scratch { base, dir })
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // Prove the folder is inside the base, and neither is a link, before anything is removed.
        let (Ok(base), Ok(dir)) = (
            crate::fs::canonical(&self.base),
            crate::fs::canonical(&self.dir),
        ) else {
            return;
        };
        let is_link =
            std::fs::symlink_metadata(&self.dir).is_ok_and(|meta| meta.file_type().is_symlink());
        if !is_link && dir != base && dir.starts_with(&base) {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

fn wants(tool: &Tool, hole: &str) -> bool {
    tool.run
        .iter()
        .chain(tool.run_also.iter())
        .any(|template| template.contains(hole))
}

/// The files a tool reads: changed paths that still exist as regular files in `root`.
fn existing_files(root: &Path, changed: &[String]) -> Vec<String> {
    changed
        .iter()
        .filter(|path| {
            let full = root.join(path);
            std::fs::symlink_metadata(&full)
                .is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink())
        })
        .cloned()
        .collect()
}

fn fill_for(
    tool: &'static Tool,
    root: &Path,
    scope: &Scope,
    scratch: &mut Option<Scratch>,
    env: &dyn Env,
) -> Result<Fill, Skip> {
    let mut fill = Fill::default();
    let hunks = diff::hunks(&scope.diff);
    if wants(tool, "{files}") {
        fill.files = existing_files(root, &scope.changed);
        if fill.files.is_empty() {
            return Err(Skip::NothingToDo(
                "no changed file is left for it to read".into(),
            ));
        }
    }
    if wants(tool, "{ranges}") {
        let found = diff::stryker_ranges(&hunks);
        if found.ranges.is_empty() {
            let mut why =
                "no changed line in a JavaScript or TypeScript source file (tests are left out)"
                    .to_string();
            if let Some(first) = found.skipped.first() {
                why.push_str(&format!("; {first}"));
            }
            return Err(Skip::NothingToDo(why));
        }
        fill.ranges = found.ranges;
    }
    if wants(tool, "{base}") {
        match &scope.base {
            Some(base) => fill.base = Some(base.clone()),
            None => {
                return Err(Skip::CouldNot(
                    "there is no earlier revision to compare the change with".into(),
                ))
            }
        }
    }
    if wants(tool, "{schema}") || wants(tool, "{baseUrl}") {
        let Some(schema) = detect::openapi_file(root) else {
            return Err(Skip::CouldNot("the project has no OpenAPI file".into()));
        };
        if wants(tool, "{baseUrl}") {
            match detect::declared_base_url(root, &schema) {
                Some(url) => fill.base_url = Some(url),
                None => {
                    return Err(Skip::CouldNot(
                        "the project declares no base URL on this computer for its API, so it wasn't pointed anywhere (one is never guessed)"
                            .into(),
                    ))
                }
            }
        }
        fill.schema = Some(schema);
    }
    if wants(tool, "{config}") {
        match detect::semgrep_config(root) {
            Some(config) => fill.config = Some(config),
            None => return Err(Skip::CouldNot("the project has no Semgrep config".into())),
        }
    }
    if wants(tool, "{diff}") {
        if !hunks.iter().any(|hunk| hunk.path.ends_with(".rs")) {
            return Err(Skip::NothingToDo("no changed Rust code".into()));
        }
        let made = Scratch::make(env).map_err(Skip::CouldNot)?;
        let file = made.dir.join("change.diff");
        std::fs::write(&file, scope.diff.as_bytes())
            .map_err(|e| Skip::CouldNot(format!("the diff couldn't be written for it: {e}")))?;
        fill.diff = Some(file.to_string_lossy().into_owned());
        *scratch = Some(made);
    }
    if wants(tool, "{out}") {
        if scratch.is_none() {
            *scratch = Some(Scratch::make(env).map_err(Skip::CouldNot)?);
        }
        if let Some(made) = scratch.as_ref() {
            let out = made.dir.join("out");
            std::fs::create_dir_all(&out)
                .map_err(|e| Skip::CouldNot(format!("its output folder couldn't be made: {e}")))?;
            fill.out = Some(out.to_string_lossy().into_owned());
        }
    }
    Ok(fill)
}

/// A tool's commands run in order and their results become one: the first ending that wasn't a clean exit (else a clean
/// one), and every output one after the other. A first command that never ended stops the rest.
fn merged(runs: Vec<RawRun>) -> RawRun {
    let mut ended = Ended::Exited(Some(0));
    let mut output = String::new();
    let mut seconds = 0.0;
    for run in runs {
        if ended == Ended::Exited(Some(0)) && run.ended != Ended::Exited(Some(0)) {
            ended = run.ended.clone();
        }
        if !output.is_empty() && !run.output.is_empty() {
            output.push('\n');
        }
        output.push_str(&run.output);
        seconds += run.seconds;
    }
    RawRun {
        ended,
        output,
        seconds,
    }
}

fn never_ended(ended: &Ended) -> bool {
    matches!(
        ended,
        Ended::NotStarted(_) | Ended::TimedOut | Ended::Stopped | Ended::Unfinished
    )
}

fn run_tool(
    tool: &'static Tool,
    root: &Path,
    scope: &Scope,
    tests: &[TestRun],
    env: &dyn Env,
) -> ToolRun {
    // A property library has no runner: its properties ran with the project's own tests.
    let Some(template) = tool.run.as_deref() else {
        let read = trim::property(tool, tests);
        return ToolRun {
            tool,
            outcome: read.outcome,
            detail: read.detail,
            lines: read.lines,
            command: None,
            tail: read.tail,
            seconds: 0.0,
        };
    };
    let mut scratch: Option<Scratch> = None;
    let fill = match fill_for(tool, root, scope, &mut scratch, env) {
        Ok(fill) => fill,
        Err(skip) => return skip.run(tool),
    };
    let mut raws: Vec<RawRun> = Vec::new();
    let mut shown: Option<String> = None;
    for (index, template) in std::iter::once(template)
        .chain(tool.run_also.iter().map(String::as_str))
        .enumerate()
    {
        let prepared = match command::prepare(template, &fill) {
            Ok(prepared) => prepared,
            Err(why) => return plain(tool, Outcome::CouldNotRun, why),
        };
        shown.get_or_insert_with(|| prepared.shown());
        let raw = env.run(
            &format!("{}-{index}", tool.id),
            &tool.name,
            &prepared,
            timeout_of(tool.kind),
        );
        let stop = never_ended(&raw.ended);
        raws.push(raw);
        if stop {
            break;
        }
    }
    let read = trim::interpret(tool, &merged(raws));
    drop(scratch);
    ToolRun {
        tool,
        outcome: read.outcome,
        detail: read.detail,
        lines: read.lines,
        command: shown,
        tail: read.tail,
        seconds: 0.0,
    }
}

fn picked(tool: &Tool, pick: Pick) -> bool {
    match pick {
        Pick::All => true,
        Pick::Replay => tool.kind == Kind::E2e && tool.run.is_some(),
    }
}

/// The installed, fitting tools of `detection`, run over `scope` in catalogue order. `tests` are the project's own test runs
/// of this round (where a property library's properties run). Nothing installed is an empty list: nothing reads as a pass.
pub fn run_installed(
    detection: &Detection,
    root: &Path,
    scope: &Scope,
    tests: &[TestRun],
    env: &dyn Env,
    pick: Pick,
) -> Vec<ToolRun> {
    detection
        .installed()
        .into_iter()
        .filter(|tool| picked(tool, pick))
        .map(|tool| {
            let started = std::time::Instant::now();
            let mut run = run_tool(tool, root, scope, tests, env);
            run.seconds = started.elapsed().as_secs_f64();
            run
        })
        .collect()
}

/// Detect, then run. See `run_installed`.
pub fn run_all(
    root: &Path,
    scope: &Scope,
    tests: &[TestRun],
    env: &dyn Env,
    pick: Pick,
) -> Vec<ToolRun> {
    let detection = detect_in(root, env);
    run_installed(&detection, root, scope, tests, env, pick)
}

// ---- reading the runs together -----------------------------------------------------------------------------------------

/// The outcome of a set of tool runs: any failure fails; else any tool that could not run could not; else a pass if one
/// really ran and passed. Every tool having nothing to do on this change is `NotRun`: neither a pass nor a problem.
pub fn combine(runs: &[ToolRun]) -> Outcome {
    if runs.iter().any(|run| run.outcome == Outcome::Failed) {
        Outcome::Failed
    } else if runs.iter().any(|run| run.outcome == Outcome::CouldNotRun) {
        Outcome::CouldNotRun
    } else if runs.iter().any(|run| run.outcome == Outcome::Passed) {
        Outcome::Passed
    } else {
        Outcome::NotRun
    }
}

/// One plain line per tool: "StrykerJS: 2 mutants survived".
pub fn summary(runs: &[ToolRun]) -> String {
    runs.iter()
        .map(|run| format!("{}: {}", run.tool.name, run.detail.trim_end_matches('.')))
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::Mutex;

    use super::*;
    use crate::firstmate::brief_checks::Ended;

    /// A temp folder that is removed when it goes.
    struct Tmp(PathBuf);

    impl Tmp {
        fn new(tag: &str) -> Tmp {
            let dir = std::env::temp_dir()
                .join(format!("monocode-proof-run-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn write(&self, rel: &str, text: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct FakeEnv {
        scratch: PathBuf,
        probes: HashSet<Vec<String>>,
        reply: Box<dyn Fn(&Prepared) -> RawRun + Send + Sync>,
        seen: Mutex<Vec<(String, Prepared, u64)>>,
    }

    impl FakeEnv {
        fn new(
            scratch: &Path,
            reply: impl Fn(&Prepared) -> RawRun + Send + Sync + 'static,
        ) -> FakeEnv {
            FakeEnv {
                scratch: scratch.to_path_buf(),
                probes: HashSet::new(),
                reply: Box::new(reply),
                seen: Mutex::new(Vec::new()),
            }
        }
        fn with_probe(mut self, argv: &[&str]) -> FakeEnv {
            self.probes
                .insert(argv.iter().map(|word| word.to_string()).collect());
            self
        }
        fn runs(&self) -> Vec<(String, Prepared, u64)> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl Env for FakeEnv {
        fn probe(&self, argv: &[String]) -> bool {
            self.probes.contains(argv)
        }
        fn run(&self, id: &str, _name: &str, prepared: &Prepared, timeout: u64) -> RawRun {
            self.seen
                .lock()
                .unwrap()
                .push((id.to_string(), prepared.clone(), timeout));
            (self.reply)(prepared)
        }
        fn scratch(&self) -> Option<PathBuf> {
            Some(self.scratch.clone())
        }
    }

    fn exited(code: i32, output: &str) -> RawRun {
        RawRun {
            ended: Ended::Exited(Some(code)),
            output: output.to_string(),
            seconds: 0.5,
        }
    }

    fn scope(changed: &[&str], diff: &str, base: Option<&str>) -> Scope {
        Scope {
            base: base.map(str::to_string),
            changed: changed.iter().map(|path| path.to_string()).collect(),
            diff: diff.to_string(),
        }
    }

    const JS_DIFF: &str = "diff --git a/src/a b.ts b/src/a b.ts\n--- a/src/a b.ts\n+++ b/src/a b.ts\t\n@@ -3,0 +4,2 @@\n+x\n+y\n";
    const RS_DIFF: &str = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -10,0 +11 @@\n+fn f() {}\n";

    fn stryker_project() -> Tmp {
        let tmp = Tmp::new("stryker");
        tmp.write(
            "package.json",
            r#"{"devDependencies":{"@stryker-mutator/core":"10.1.1"}}"#,
        );
        tmp.write("src/a b.ts", "x\n");
        tmp
    }

    #[test]
    fn a_surviving_mutant_fails_and_the_file_names_travel_in_the_environment_not_the_command() {
        let project = stryker_project();
        let scratch = Tmp::new("scratch");
        let log = "#1. [Survived] ConditionalExpression\nsrc/a b.ts:5:3\n-   if (a > b) {\n+   if (true) {\n";
        let env = FakeEnv::new(scratch.path(), move |_| exited(0, log));
        let runs = run_all(
            project.path(),
            &scope(&["src/a b.ts"], JS_DIFF, Some("abc")),
            &[],
            &env,
            Pick::All,
        );
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].tool.id, "stryker");
        assert_eq!(runs[0].outcome, Outcome::Failed, "{:?}", runs[0]);
        let seen = env.runs();
        assert_eq!(seen.len(), 1);
        let prepared = &seen[0].1;
        assert_eq!(prepared.argv[..3], ["npx", "--no-install", "stryker"]);
        assert!(
            prepared.argv.iter().any(|word| word == "src/a b.ts:4-5"),
            "{:?}",
            prepared.argv
        );
        assert!(!prepared.command.contains("a b.ts"), "{}", prepared.command);
        assert!(prepared
            .env
            .iter()
            .any(|(_, value)| value == "src/a b.ts:4-5"));
        assert_eq!(seen[0].2, MUTATION_SECONDS);
    }

    #[test]
    fn a_tool_with_no_changed_line_it_reads_did_not_run_and_is_not_a_pass() {
        let project = stryker_project();
        let scratch = Tmp::new("scratch");
        let env = FakeEnv::new(scratch.path(), |_| exited(0, ""));
        let docs = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n";
        let runs = run_all(
            project.path(),
            &scope(&["README.md"], docs, None),
            &[],
            &env,
            Pick::All,
        );
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].outcome, Outcome::NotRun);
        assert!(env.runs().is_empty(), "nothing was started");
        assert_eq!(
            combine(&runs),
            Outcome::NotRun,
            "nothing ran is never a pass"
        );
    }

    #[test]
    fn nothing_installed_runs_nothing_and_reads_as_nothing() {
        let project = Tmp::new("plain");
        project.write("package.json", r#"{"dependencies":{"left-pad":"1"}}"#);
        let scratch = Tmp::new("scratch");
        let env = FakeEnv::new(scratch.path(), |_| exited(0, ""));
        let runs = run_all(
            project.path(),
            &scope(&["a.ts"], JS_DIFF, None),
            &[],
            &env,
            Pick::All,
        );
        assert!(runs.is_empty());
        assert_eq!(combine(&runs), Outcome::NotRun);
    }

    #[test]
    fn cargo_mutants_gets_the_diff_and_an_output_folder_outside_the_project_and_both_are_cleaned_up(
    ) {
        let project = Tmp::new("rust");
        project.write(
            "Cargo.toml",
            "[package]\nname = \"x\"\nversion = \"0.1.0\"\n",
        );
        let scratch = Tmp::new("scratch");
        let log = "MISSED src/lib.rs:11:5: replace f -> () with () in 0.4s\n";
        let env = FakeEnv::new(scratch.path(), move |_| exited(2, log)).with_probe(&[
            "cargo",
            "mutants",
            "--version",
        ]);
        let runs = run_all(
            project.path(),
            &scope(&["src/lib.rs"], RS_DIFF, Some("abc")),
            &[],
            &env,
            Pick::All,
        );
        assert_eq!(runs.len(), 1, "{runs:?}");
        assert_eq!(runs[0].tool.id, "cargo-mutants");
        assert_eq!(runs[0].outcome, Outcome::Failed, "{:?}", runs[0]);
        let seen = env.runs();
        let prepared = &seen[0].1;
        let diff_at = prepared
            .argv
            .iter()
            .position(|word| word == "--in-diff")
            .unwrap()
            + 1;
        let diff_path = PathBuf::from(&prepared.argv[diff_at]);
        assert!(
            diff_path.starts_with(scratch.path()),
            "the diff is outside the project: {diff_path:?}"
        );
        assert!(
            !diff_path.exists(),
            "the scratch diff is removed after the run"
        );
        assert!(!project.path().join("mutants.out").exists());
        let out_at = prepared
            .argv
            .iter()
            .position(|word| word == "--output")
            .unwrap()
            + 1;
        assert!(PathBuf::from(&prepared.argv[out_at]).starts_with(scratch.path()));
        assert_eq!(
            std::fs::read_dir(scratch.path()).unwrap().count(),
            0,
            "scratch is left empty"
        );
    }

    #[test]
    fn cargo_mutants_on_a_change_with_no_rust_did_not_run() {
        let project = Tmp::new("rust-none");
        project.write(
            "Cargo.toml",
            "[package]\nname = \"x\"\nversion = \"0.1.0\"\n",
        );
        let scratch = Tmp::new("scratch");
        let env = FakeEnv::new(scratch.path(), |_| exited(0, "")).with_probe(&[
            "cargo",
            "mutants",
            "--version",
        ]);
        let runs = run_all(
            project.path(),
            &scope(&["a.ts"], JS_DIFF, Some("abc")),
            &[],
            &env,
            Pick::All,
        );
        assert_eq!(runs[0].outcome, Outcome::NotRun);
        assert!(env.runs().is_empty());
    }

    #[test]
    fn the_replay_pick_runs_only_the_end_to_end_tools() {
        let project = Tmp::new("web");
        project.write(
            "package.json",
            r#"{"devDependencies":{"vite":"6","@playwright/test":"1.65.0","@stryker-mutator/core":"10.1.1","fast-check":"4"}}"#,
        );
        project.write("playwright.config.ts", "export default {}\n");
        let scratch = Tmp::new("scratch");
        let env = FakeEnv::new(scratch.path(), |_| {
            exited(0, "Running 2 tests using 1 worker\n  2 passed (1.2s)\n")
        });
        let s = scope(&["src/a b.ts"], JS_DIFF, Some("main"));
        let replay = run_all(project.path(), &s, &[], &env, Pick::Replay);
        assert_eq!(
            replay
                .iter()
                .map(|run| run.tool.id.as_str())
                .collect::<Vec<_>>(),
            ["playwright"]
        );
        let seen = env.runs();
        assert_eq!(seen.len(), 1);
        assert!(
            seen[0]
                .1
                .argv
                .iter()
                .any(|word| word == "--only-changed=main"),
            "{:?}",
            seen[0].1.argv
        );
        let all = run_all(project.path(), &s, &[], &env, Pick::All);
        assert_eq!(
            all.iter()
                .map(|run| run.tool.id.as_str())
                .collect::<Vec<_>>(),
            ["fast-check", "stryker", "playwright"]
        );
    }

    #[test]
    fn a_property_library_is_read_from_the_projects_own_test_run_and_starts_nothing() {
        let project = Tmp::new("prop");
        project.write(
            "package.json",
            r#"{"devDependencies":{"fast-check":"4.10.2"}}"#,
        );
        let scratch = Tmp::new("scratch");
        let env = FakeEnv::new(scratch.path(), |_| exited(0, ""));
        let failing = TestRun {
            outcome: Outcome::Failed,
            output: " FAIL  src/a.test.ts > sum is commutative\nError: Property failed after 3 tests\n\n Test Files  1 failed (1)\n      Tests  1 failed | 4 passed (5)\n".into(),
        };
        let runs = run_all(
            project.path(),
            &scope(&["src/a.ts"], "", None),
            &[failing],
            &env,
            Pick::All,
        );
        assert_eq!(runs[0].tool.id, "fast-check");
        assert_eq!(runs[0].outcome, Outcome::Failed, "{:?}", runs[0]);
        assert!(
            env.runs().is_empty(),
            "a property library has no command of its own"
        );
        let none = run_all(
            project.path(),
            &scope(&["src/a.ts"], "", None),
            &[],
            &env,
            Pick::All,
        );
        assert_eq!(
            none[0].outcome,
            Outcome::CouldNotRun,
            "no test run means its properties weren't checked"
        );
    }

    #[test]
    fn schemathesis_with_no_declared_base_url_could_not_run_and_is_never_pointed_anywhere() {
        let project = Tmp::new("api");
        project.write(
            "openapi.yaml",
            "openapi: 3.0.0\nservers:\n  - url: https://api.example.com\n",
        );
        project.write("requirements.txt", "schemathesis==4.33.4\n");
        let scratch = Tmp::new("scratch");
        let env = FakeEnv::new(scratch.path(), |_| exited(0, ""));
        let runs = run_all(
            project.path(),
            &scope(&["app.py"], "", None),
            &[],
            &env,
            Pick::All,
        );
        let found = runs
            .iter()
            .find(|run| run.tool.id == "schemathesis")
            .expect("it is installed and fits");
        assert_eq!(found.outcome, Outcome::CouldNotRun);
        assert!(
            found.detail.contains("never guessed") || found.detail.contains("never"),
            "{}",
            found.detail
        );
        assert!(env.runs().is_empty());
        project.write(
            "openapi.yaml",
            "openapi: 3.0.0\nservers:\n  - url: http://localhost:8000\n",
        );
        let ran = run_all(
            project.path(),
            &scope(&["app.py"], "", None),
            &[],
            &env,
            Pick::All,
        );
        assert_eq!(
            ran.iter()
                .find(|run| run.tool.id == "schemathesis")
                .unwrap()
                .outcome,
            Outcome::Passed
        );
        let seen = env.runs();
        assert!(seen[0]
            .1
            .argv
            .iter()
            .any(|word| word == "http://localhost:8000"));
    }

    #[test]
    fn a_tools_extra_commands_run_after_it_and_their_outputs_read_as_one() {
        let project = Tmp::new("astgrep");
        project.write(
            "package.json",
            r#"{"devDependencies":{"@ast-grep/cli":"0.51.2"}}"#,
        );
        project.write("sgconfig.yml", "ruleDirs:\n  - rules\n");
        project.write("src/a.ts", "x\n");
        let scratch = Tmp::new("scratch");
        let env = FakeEnv::new(scratch.path(), |prepared| {
            if prepared.argv.iter().any(|word| word == "test") {
                exited(0, "Running 1 tests\ntest result: ok.\n")
            } else {
                exited(0, "")
            }
        });
        let runs = run_all(
            project.path(),
            &scope(&["src/a.ts"], "", None),
            &[],
            &env,
            Pick::All,
        );
        let found = runs.iter().find(|run| run.tool.id == "ast-grep").unwrap();
        assert_eq!(found.outcome, Outcome::Passed, "{found:?}");
        let ids: Vec<String> = env.runs().iter().map(|(id, _, _)| id.clone()).collect();
        assert_eq!(ids, ["ast-grep-0", "ast-grep-1"]);
    }

    #[test]
    fn a_first_command_that_never_started_stops_the_rest_and_could_not_run() {
        let project = Tmp::new("astgrep-stop");
        project.write(
            "package.json",
            r#"{"devDependencies":{"@ast-grep/cli":"0.51.2"}}"#,
        );
        project.write("sgconfig.yml", "ruleDirs:\n  - rules\n");
        project.write("src/a.ts", "x\n");
        let scratch = Tmp::new("scratch");
        let env = FakeEnv::new(scratch.path(), |_| {
            RawRun::not_started("the sandbox refused it")
        });
        let runs = run_all(
            project.path(),
            &scope(&["src/a.ts"], "", None),
            &[],
            &env,
            Pick::All,
        );
        let found = runs.iter().find(|run| run.tool.id == "ast-grep").unwrap();
        assert_eq!(found.outcome, Outcome::CouldNotRun);
        assert_eq!(env.runs().len(), 1);
    }

    #[test]
    fn combine_never_reads_a_could_not_run_or_nothing_as_a_pass() {
        let tool = super::super::catalogue::find("fast-check").unwrap();
        let of = |outcome| ToolRun {
            tool,
            outcome,
            detail: "x".into(),
            lines: vec![],
            command: None,
            tail: None,
            seconds: 0.0,
        };
        assert_eq!(combine(&[]), Outcome::NotRun);
        assert_eq!(
            combine(&[of(Outcome::Passed), of(Outcome::CouldNotRun)]),
            Outcome::CouldNotRun
        );
        assert_eq!(
            combine(&[of(Outcome::Passed), of(Outcome::NotRun)]),
            Outcome::Passed
        );
        assert_eq!(
            combine(&[of(Outcome::CouldNotRun), of(Outcome::Failed)]),
            Outcome::Failed
        );
        assert_eq!(combine(&[of(Outcome::NotRun)]), Outcome::NotRun);
    }

    #[test]
    fn scratch_is_removed_only_when_it_is_inside_its_base() {
        let base = Tmp::new("base");
        let outside = Tmp::new("outside");
        outside.write("keep.txt", "keep");
        {
            let made = Scratch {
                base: base.path().to_path_buf(),
                dir: outside.path().to_path_buf(),
            };
            drop(made);
        }
        assert!(
            outside.path().join("keep.txt").exists(),
            "a folder outside the base is never removed"
        );
        let env = FakeEnv::new(base.path(), |_| exited(0, ""));
        let dir = {
            let made = Scratch::make(&env).unwrap();
            let dir = made.dir.clone();
            assert!(dir.is_dir());
            dir
        };
        assert!(!dir.exists());
    }
}
