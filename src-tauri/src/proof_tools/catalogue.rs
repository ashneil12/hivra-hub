//! PT-1: the proof-tool catalogue. One data file, `src/features/proofTools/model/proofTools.json`, read by the webview
//! (`proofTools.ts`) and compiled in here the way `secretPatterns.json` is, so the two sides can never disagree about
//! which tools exist, what each one proves and how the app tells the project already has it.
//!
//! The catalogue is data, not code: how a tool "fits" a project (`detect`) and how the app tells the project already has it
//! (`installed`) are small typed rules (`Rule`) that `detect.rs` evaluates, and `run` is a command template whose
//! placeholders `command.rs` fills with arguments, never with text spliced into a shell line. Nothing in it is ever
//! installed by the app: `install` is what a worker the person agreed to would run, and it is only shown in a proposal.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::command;

/// The catalogue file, compiled in. The same file the webview imports.
pub const RAW: &str = include_str!("../../../src/features/proofTools/model/proofTools.json");

/// The most tools a catalogue may list, and the longest text in one entry: a bound, so a bad edit can't grow a prompt.
const TOOLS_MAX: usize = 64;
const TEXT_MAX: usize = 400;

/// The licences the catalogue may name (SPDX). A tool under another one is not added until someone has read its terms.
pub const KNOWN_LICENCES: [&str; 6] = [
    "MIT",
    "Apache-2.0",
    "MIT OR Apache-2.0",
    "MPL-2.0",
    "BSD-3-Clause",
    "LGPL-2.1-or-later",
];

/// A kind of project the app can recognise from files it reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stack {
    Node,
    Rust,
    Python,
    Openapi,
    Web,
}

/// What a tool does, which decides how its output is read and what a bad run means.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A library the project's own tests use (fast-check, proptest, Hypothesis). It has no runner of its own.
    Property,
    /// Plants bugs in the changed code and says which ones no test noticed.
    Mutation,
    /// Drives the app (Playwright, e2e).
    E2e,
    /// Exercises a running service from its API description.
    Api,
    /// Reads the code against rules (ast-grep, Semgrep).
    Pattern,
}

/// How a tool fits a project, or how the app tells the project already has it. Evaluated by `detect::eval`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Rule {
    /// The project is of this stack.
    Stack(Stack),
    AnyOf(Vec<Rule>),
    AllOf(Vec<Rule>),
    /// A package.json `dependencies` or `devDependencies` name, exactly.
    NpmDep(String),
    /// Any such name starting with this (`@fast-check/`).
    NpmDepPrefix(String),
    /// A Cargo.toml `[dev-dependencies]` name.
    CargoDevDep(String),
    /// A Python dependency named in pyproject.toml or a `requirements*.txt`.
    PyDep(String),
    /// A file in the project's root.
    File(String),
    /// Any file in the project's root whose name starts with this (`playwright.config.`).
    FilePrefix(String),
    /// Any file in the project (a bounded walk) whose name ends with this (`.e2e.ts`).
    AnyFileSuffix(String),
    /// A folder in the project's root.
    Dir(String),
    /// A program that answers: its argv, ending `--version`. Run through the sandboxed runner with a short timeout.
    Binary(Vec<String>),
}

/// A package a tool works with that is not the tool itself (a runner plugin, an MCP server). Shown with the tool.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Companion {
    pub name: String,
    pub repo: String,
    pub pinned: String,
}

/// One tool. Every field is read from the catalogue file and checked by `parse`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tool {
    pub id: String,
    pub name: String,
    /// The tool's source, https.
    pub repo: String,
    /// SPDX, one of `KNOWN_LICENCES`.
    pub licence: String,
    /// One plain line a person reads: what it shows.
    pub proves: String,
    /// One sentence on how a worker uses it in a task.
    pub how_to_use: String,
    pub stacks: Vec<Stack>,
    pub detect: Rule,
    pub installed: Rule,
    /// What a worker the person agreed to would run. Shown in a proposal; never run by the app.
    pub install: String,
    /// The command, with `{files} {ranges} {diff} {base} {schema} {baseUrl} {config} {out}` filled by the app. Absent for a
    /// property library: it has no runner of its own, so its properties run with (and are read from) the project's tests.
    pub run: Option<String>,
    /// More commands run after `run` when it passed (ast-grep's `test`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub run_also: Vec<String>,
    pub needs_model: bool,
    /// The version this was checked against.
    pub pinned: String,
    pub kind: Kind,
    /// Run only if the person already has it: never bundled, copied or installed by the app (Semgrep).
    pub external: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub also: Vec<Companion>,
}

impl Tool {
    /// The question a first mate's proposal puts to the person: "Add <name> to catch <proves, lowercased>?". The first
    /// letter is lowercased unless the word is an acronym (`API`), and the closing full stop goes.
    pub fn question(&self) -> String {
        let proves = self.proves.trim().trim_end_matches('.');
        let mut chars = proves.chars();
        let lowered = match (chars.next(), chars.next()) {
            (Some(_), Some(second)) if second.is_uppercase() => proves.to_string(),
            (Some(first), _) => first.to_lowercase().chain(proves.chars().skip(1)).collect(),
            (None, _) => String::new(),
        };
        format!("Add {} to catch {}?", self.name, lowered)
    }
}

/// A proposal's decision key starts with this (`proof-tools/<tool id>/<folder tag>`, built by `offers::decision_key`).
pub const DECISION_PREFIX: &str = "proof-tools/";
/// The two answers a proposal offers, in the words the person sees.
pub const ANSWER_ADD: &str = "Add it";
pub const ANSWER_NOT_NOW: &str = "Not now";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    version: u32,
    tools: Vec<Tool>,
}

fn plain_text(label: &str, text: &str) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is empty"));
    }
    if trimmed.chars().count() > TEXT_MAX || trimmed.chars().any(char::is_control) {
        return Err(format!("{label} is too long or has a control character"));
    }
    Ok(())
}

fn https(label: &str, url: &str) -> Result<(), String> {
    if !url.starts_with("https://") || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("{label} is not an https address"));
    }
    Ok(())
}

fn rule_ok(rule: &Rule, stacks: &[Stack], depth: usize) -> Result<(), String> {
    if depth > 6 {
        return Err("a rule is nested too deep".into());
    }
    match rule {
        Rule::Stack(stack) => {
            if !stacks.contains(stack) {
                return Err(format!(
                    "a rule names the {stack:?} stack the tool doesn't list"
                ));
            }
        }
        Rule::AnyOf(rules) | Rule::AllOf(rules) => {
            if rules.is_empty() {
                return Err("a rule lists nothing".into());
            }
            for rule in rules {
                rule_ok(rule, stacks, depth + 1)?;
            }
        }
        // A package name the app only compares with (`@fast-check/vitest` has a slash).
        Rule::NpmDep(name)
        | Rule::NpmDepPrefix(name)
        | Rule::CargoDevDep(name)
        | Rule::PyDep(name) => {
            if name.is_empty()
                || name.chars().count() > 80
                || name.contains('\\')
                || name.chars().any(|c| c.is_control() || c.is_whitespace())
            {
                return Err(format!(
                    "a rule has a name the app won't compare with: {name:?}"
                ));
            }
        }
        // A file or folder name the app opens in the project's root: no separator, no `..`, nothing odd.
        Rule::File(name) | Rule::FilePrefix(name) | Rule::AnyFileSuffix(name) | Rule::Dir(name) => {
            if name.is_empty()
                || name.chars().count() > 80
                || name.contains(['/', '\\'])
                || name.contains("..")
                || name.chars().any(|c| c.is_control() || c.is_whitespace())
            {
                return Err(format!("a rule has a name the app won't open: {name:?}"));
            }
        }
        Rule::Binary(argv) => {
            if argv.len() < 2
                || argv.len() > 4
                || argv.last().map(String::as_str) != Some("--version")
                || argv.iter().any(|word| !command::literal_ok(word))
            {
                return Err("a binary rule must be a plain argv ending --version".into());
            }
        }
    }
    Ok(())
}

fn tool_ok(tool: &Tool) -> Result<(), String> {
    let id = &tool.id;
    if id.is_empty()
        || id.len() > 40
        || !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || id.starts_with('-')
    {
        return Err(format!("tool id {id:?} is not a short lower-case slug"));
    }
    let at = |what: &str| format!("{id}: {what}");
    plain_text("name", &tool.name).map_err(|e| at(&e))?;
    plain_text("proves", &tool.proves).map_err(|e| at(&e))?;
    plain_text("howToUse", &tool.how_to_use).map_err(|e| at(&e))?;
    plain_text("install", &tool.install).map_err(|e| at(&e))?;
    plain_text("pinned", &tool.pinned).map_err(|e| at(&e))?;
    https("repo", &tool.repo).map_err(|e| at(&e))?;
    if !KNOWN_LICENCES.contains(&tool.licence.as_str()) {
        return Err(at(&format!(
            "licence {:?} is not one the catalogue knows",
            tool.licence
        )));
    }
    if tool.stacks.is_empty() {
        return Err(at("it lists no stack"));
    }
    rule_ok(&tool.detect, &tool.stacks, 0).map_err(|e| at(&e))?;
    rule_ok(&tool.installed, &tool.stacks, 0).map_err(|e| at(&e))?;
    match (&tool.run, tool.kind) {
        (None, Kind::Property) => {
            if !tool.run_also.is_empty() {
                return Err(at("a property library has no commands to run after"));
            }
        }
        (None, _) => return Err(at("only a property library may have no run command")),
        (Some(_), Kind::Property) => return Err(at("a property library has no runner of its own")),
        (Some(run), _) => {
            command::check_template(run).map_err(|e| at(&e))?;
            for also in &tool.run_also {
                command::check_template(also).map_err(|e| at(&e))?;
            }
        }
    }
    for companion in &tool.also {
        plain_text("a companion's name", &companion.name).map_err(|e| at(&e))?;
        plain_text("a companion's version", &companion.pinned).map_err(|e| at(&e))?;
        https("a companion's repo", &companion.repo).map_err(|e| at(&e))?;
    }
    Ok(())
}

/// The tools in a catalogue file, checked. Any entry that isn't right refuses the whole file, so a half-read catalogue
/// never reaches a gate.
pub fn parse(raw: &str) -> Result<Vec<Tool>, String> {
    let file: File =
        serde_json::from_str(raw).map_err(|e| format!("the catalogue can't be read: {e}"))?;
    if file.version != 1 {
        return Err("the catalogue is a version this build can't read".into());
    }
    if file.tools.is_empty() || file.tools.len() > TOOLS_MAX {
        return Err("the catalogue lists no tools, or too many".into());
    }
    let mut seen = BTreeSet::new();
    for tool in &file.tools {
        tool_ok(tool)?;
        if !seen.insert(tool.id.clone()) {
            return Err(format!("{}: listed twice", tool.id));
        }
    }
    Ok(file.tools)
}

/// Every tool in the compiled-in catalogue. A catalogue that can't be read (a test makes sure it can) is empty, which
/// means no tool is offered or run, never a guess.
pub fn tools() -> &'static [Tool] {
    static TOOLS: OnceLock<Vec<Tool>> = OnceLock::new();
    TOOLS.get_or_init(|| parse(RAW).unwrap_or_default())
}

/// One tool by id.
pub fn find(id: &str) -> Option<&'static Tool> {
    tools().iter().find(|tool| tool.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_compiled_in_catalogue_parses_and_lists_every_tool_once() {
        let tools = parse(RAW).expect("the catalogue parses");
        let ids: Vec<&str> = tools.iter().map(|tool| tool.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "fast-check",
                "stryker",
                "proptest",
                "cargo-mutants",
                "hypothesis",
                "mutmut",
                "schemathesis",
                "ast-grep",
                "semgrep",
                "playwright",
                "e2e"
            ]
        );
        assert_eq!(tools.len(), super::tools().len());
    }

    #[test]
    fn every_entry_has_a_known_licence_an_https_repo_and_every_field() {
        for tool in tools() {
            assert!(
                KNOWN_LICENCES.contains(&tool.licence.as_str()),
                "{}",
                tool.id
            );
            assert!(tool.repo.starts_with("https://"), "{}", tool.id);
            assert!(
                !tool.name.is_empty() && !tool.proves.is_empty(),
                "{}",
                tool.id
            );
            assert!(
                !tool.how_to_use.is_empty() && !tool.install.is_empty(),
                "{}",
                tool.id
            );
            assert!(
                !tool.pinned.is_empty() && !tool.stacks.is_empty(),
                "{}",
                tool.id
            );
            for companion in &tool.also {
                assert!(companion.repo.starts_with("https://"), "{}", tool.id);
            }
        }
    }

    #[test]
    fn the_registry_facts_of_13_november_are_what_the_catalogue_says() {
        let fact = |id: &str| find(id).unwrap_or_else(|| panic!("{id} is in the catalogue"));
        let check = |id: &str, licence: &str, pinned: &str, repo: &str| {
            let tool = fact(id);
            assert_eq!(tool.licence, licence, "{id}");
            assert_eq!(tool.pinned, pinned, "{id}");
            assert_eq!(tool.repo, repo, "{id}");
        };
        check(
            "fast-check",
            "MIT",
            "4.10.2",
            "https://github.com/dubzzz/fast-check",
        );
        check(
            "stryker",
            "Apache-2.0",
            "10.1.1",
            "https://github.com/stryker-mutator/stryker-js",
        );
        check(
            "proptest",
            "MIT OR Apache-2.0",
            "1.12.0",
            "https://github.com/proptest-rs/proptest",
        );
        check(
            "cargo-mutants",
            "MIT",
            "27.1.0",
            "https://github.com/sourcefrog/cargo-mutants",
        );
        check(
            "hypothesis",
            "MPL-2.0",
            "6.170.15",
            "https://github.com/HypothesisWorks/hypothesis",
        );
        check(
            "mutmut",
            "BSD-3-Clause",
            "3.8.1",
            "https://github.com/boxed/mutmut",
        );
        check(
            "schemathesis",
            "MIT",
            "4.33.4",
            "https://github.com/schemathesis/schemathesis",
        );
        check(
            "ast-grep",
            "MIT",
            "0.51.2",
            "https://github.com/ast-grep/ast-grep",
        );
        check(
            "semgrep",
            "LGPL-2.1-or-later",
            "1.185.0",
            "https://github.com/semgrep/semgrep",
        );
        check(
            "playwright",
            "Apache-2.0",
            "1.65.0",
            "https://github.com/microsoft/playwright",
        );
        check(
            "e2e",
            "Apache-2.0",
            "0.23.0",
            "https://github.com/e2e-inc/e2e",
        );
        assert!(
            fact("semgrep").external,
            "Semgrep runs as an external tool only"
        );
        assert!(tools().iter().filter(|tool| tool.external).count() == 1);
        assert!(
            tools().iter().all(|tool| !tool.needs_model),
            "a strict-cache replay needs no model"
        );
    }

    #[test]
    fn only_a_property_library_has_no_run_command() {
        for tool in tools() {
            assert_eq!(
                tool.run.is_none(),
                tool.kind == Kind::Property,
                "{}",
                tool.id
            );
        }
    }

    #[test]
    fn semgrep_never_reaches_semgreps_servers_and_every_npx_run_is_left_to_the_runner_to_pin() {
        let semgrep = find("semgrep").unwrap();
        let run = semgrep.run.as_deref().unwrap();
        assert!(run.contains("--metrics=off"), "{run}");
        assert!(!run.contains("auto"), "never --config auto: {run}");
        assert!(run.contains("--config {config}"), "{run}");
    }

    #[test]
    fn a_catalogue_with_a_bad_entry_is_refused_whole() {
        let edit = |from: &str, to: &str| RAW.replacen(from, to, 1);
        let cases = [
            edit("\"licence\": \"MIT\"", "\"licence\": \"GPL-3.0-only\""),
            edit(
                "https://github.com/dubzzz/fast-check",
                "http://github.com/dubzzz/fast-check",
            ),
            edit("\"id\": \"stryker\"", "\"id\": \"fast-check\""),
            edit("\"version\": 1", "\"version\": 2"),
            edit("\"kind\": \"property\"", "\"kind\": \"mutation\""),
            edit("\"stacks\": [\"node\"]", "\"stacks\": []"),
            edit(
                "\"run\": \"mutmut run\"",
                "\"run\": \"mutmut run; rm -rf ~\"",
            ),
            edit(
                "[\"cargo\", \"mutants\", \"--version\"]",
                "[\"cargo\", \"mutants\"]",
            ),
            edit(
                "\"proves\": \"Properties",
                "\"unknownField\": 1, \"proves\": \"Properties",
            ),
        ];
        for (at, bad) in cases.iter().enumerate() {
            assert!(parse(bad).is_err(), "case {at} should be refused");
        }
        assert!(parse("[]").is_err());
        assert!(parse("").is_err());
    }

    #[test]
    fn the_proposal_asks_in_the_words_the_brief_gave() {
        let fast = find("fast-check").unwrap();
        assert_eq!(
            fast.question(),
            "Add fast-check to catch properties hold for generated inputs, not just the examples?"
        );
        // An acronym keeps its capitals.
        let api = find("schemathesis").unwrap();
        assert!(
            api.question()
                .starts_with("Add Schemathesis to catch the API answers"),
            "{}",
            api.question()
        );
        let mut shouting = api.clone();
        shouting.proves = "API answers match.".into();
        assert_eq!(
            shouting.question(),
            "Add Schemathesis to catch API answers match?"
        );
    }

    #[test]
    fn rules_only_name_stacks_the_tool_lists_and_names_the_app_can_compare() {
        let tool = find("fast-check").unwrap();
        let mut wrong_stack = tool.clone();
        wrong_stack.detect = Rule::Stack(Stack::Rust);
        assert!(tool_ok(&wrong_stack).is_err());
        let mut odd_name = tool.clone();
        odd_name.installed = Rule::File("../package.json".into());
        assert!(tool_ok(&odd_name).is_err());
        let mut deep = Rule::NpmDep("x".into());
        for _ in 0..8 {
            deep = Rule::AnyOf(vec![deep]);
        }
        let mut too_deep = tool.clone();
        too_deep.installed = deep;
        assert!(tool_ok(&too_deep).is_err());
    }
}
