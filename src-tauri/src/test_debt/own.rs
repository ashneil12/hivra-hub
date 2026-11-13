//! PT-5: whose failing test is it? The rule that keeps a task from using the test debt list to hide a failure it caused.
//!
//! A failing test is **the task's own** when
//! - its file is one the task added or changed (a Rust test is in a `#[cfg(test)]` block of a source file the task changed, or in
//!   that file's `tests.rs` / `_tests.rs`), or
//! - its file covers a source file the task changed: the same folder (a `tests`, `test` or `__tests__` folder beside it counts)
//!   and the same name once `.test`, `.spec`, `_test`, `test_` are taken off (`a.ts` and `a.test.ts`, `a.go` and `a_test.go`,
//!   `a.py` and `test_a.py`), or
//! - the test file imports a file the task changed, or
//! - we cannot tell which file it is in. Not knowing is never "not its own": the unknown goes the safe way, which is the way it
//!   went before this rule, the task fails for it.
//!
//! Anything else is another task's, or an old break, and goes to the list.

use std::sync::OnceLock;

use regex::Regex;

use crate::test_summary::{Failure, Runner};

/// One failing test, with where it lives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failing {
    pub runner: String,
    /// The file the runner named (or a Rust module's file), forward slashes. Empty when it could not be told.
    pub file: String,
    pub name: String,
    pub message: String,
    /// The check that ran it: a `run_checks` step id or the command the worker typed.
    pub command: String,
}

impl Failing {
    pub fn id(&self) -> String {
        super::doc::test_id(&self.runner, &self.file, &self.name)
    }
}

pub fn runner_word(runner: Runner) -> &'static str {
    match runner {
        Runner::Vitest => "vitest",
        Runner::Cargo => "cargo",
        Runner::Nextest => "nextest",
        Runner::NodeTest => "node",
        Runner::Pytest => "pytest",
        Runner::Go => "go",
        Runner::Playwright => "playwright",
    }
}

/// A runner from the shape of a test's name, for a log that is gone and a name that is all that is left.
pub fn guess_runner(name: &str) -> &'static str {
    let name = name.trim();
    if name.contains(" › ") {
        "playwright"
    } else if let Some((first, _)) = name.split_once(" > ") {
        if has_source_extension(first) {
            "vitest"
        } else {
            "unknown"
        }
    } else if let Some((first, _)) = name.split_once("::") {
        if first.ends_with(".py") {
            "pytest"
        } else {
            "cargo"
        }
    } else {
        "unknown"
    }
}

fn has_source_extension(path: &str) -> bool {
    const EXTENSIONS: [&str; 10] = [
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".rs",
    ];
    let lower = path.trim().to_lowercase();
    EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// A path with forward slashes, no leading `./`, no empty or `.` segments.
pub fn norm(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/")
}

/// Whether two paths name one file: equal, or one is the other's tail at a folder boundary (Playwright prints a path relative
/// to its test folder). Matching more than it should only makes more tests "the task's own", the safe way.
pub fn same_file(a: &str, b: &str) -> bool {
    let (a, b) = (norm(a), norm(b));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b || a.ends_with(&format!("/{b}")) || b.ends_with(&format!("/{a}"))
}

fn playwright_file(name: &str) -> String {
    // `[chromium] › tests/browser/a.spec.ts:7:5 › title`
    let mut parts = name.split(" › ");
    let _project = parts.next();
    let Some(located) = parts.next() else {
        return String::new();
    };
    // `file:line:col`, `file:line` or `file`: the digits after the last two colons are a place, not part of the path (a Windows
    // drive's colon is followed by a backslash, never by digits only).
    let mut file = located.trim();
    for _ in 0..2 {
        match file.rsplit_once(':') {
            Some((rest, tail)) if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => {
                file = rest;
            }
            _ => break,
        }
    }
    norm(file)
}

/// The file a failing test is in, as far as its name says. Empty when it cannot be told.
pub fn file_of(runner: &str, name: &str, rust_files: &[String]) -> String {
    match runner {
        "vitest" => match name.split_once(" > ") {
            Some((file, _)) if has_source_extension(file) => norm(file),
            _ => String::new(),
        },
        "pytest" => match name.split_once("::") {
            Some((file, _)) if has_source_extension(file) => norm(file),
            _ => String::new(),
        },
        "playwright" => playwright_file(name),
        "cargo" | "nextest" => rust_module(name)
            .and_then(|module| rust_file_for(&module, rust_files))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// A Rust test's module path: `a::b::tests::works` (or nextest's `crate a::b::tests::works`) is `[a, b]`.
fn rust_module(name: &str) -> Option<Vec<String>> {
    let token = name.split_whitespace().last()?;
    let mut parts: Vec<String> = token.split("::").map(str::to_string).collect();
    if parts.len() < 2 {
        return None;
    }
    parts.pop();
    while parts
        .last()
        .is_some_and(|part| part == "tests" || part == "test")
    {
        parts.pop();
    }
    (!parts.is_empty()).then_some(parts)
}

/// A source file's module path: the segments after its last `src` folder; `mod`, `lib` and `main` are the folder itself and a
/// `tests` or `_tests` file belongs to the module it tests. Empty for a crate root.
fn rust_path(path: &str) -> Option<(Vec<String>, bool)> {
    let path = norm(path);
    let stem = path.strip_suffix(".rs")?;
    let mut parts: Vec<&str> = stem.split('/').collect();
    let at = parts.iter().rposition(|part| *part == "src")?;
    parts.drain(..=at);
    let mut module: Vec<String> = parts.iter().map(|p| (*p).to_string()).collect();
    let mut is_mod = false;
    match module.last().map(String::as_str) {
        Some("mod") => {
            module.pop();
            is_mod = true;
        }
        Some("lib") | Some("main") if module.len() == 1 => {
            module.pop();
            is_mod = true;
        }
        _ => {}
    }
    if module.last().is_some_and(|last| last == "tests") {
        module.pop();
    } else if let Some(last) = module.last_mut() {
        if let Some(base) = last.strip_suffix("_tests") {
            *last = base.to_string();
        }
    }
    Some((module, is_mod))
}

fn rust_file_for(module: &[String], rust_files: &[String]) -> Option<String> {
    rust_files
        .iter()
        .find(|file| {
            rust_path(file).is_some_and(|(path, _)| path == module)
                && !norm(file).ends_with("/tests.rs")
                && !norm(file).ends_with("_tests.rs")
        })
        .or_else(|| {
            rust_files
                .iter()
                .find(|file| rust_path(file).is_some_and(|(path, _)| path == module))
        })
        .map(|file| norm(file))
}

/// A Rust file under a `tests` folder that is not in a `src` tree: an integration test crate.
fn is_rust_integration_test(path: &str) -> bool {
    let path = norm(path);
    path.ends_with(".rs")
        && rust_path(&path).is_none()
        && path.split('/').any(|part| part == "tests")
}

/// A Rust test is the task's own when a source file the task changed holds its module (or the module's `tests.rs`).
fn rust_own(name: &str, changed: &[String]) -> bool {
    let Some(module) = rust_module(name) else {
        // A test at the crate root, or an integration test: no module says which file, so it is not shown to be another task's.
        return true;
    };
    changed.iter().any(|path| {
        let Some((path_module, is_mod)) = rust_path(path) else {
            return false;
        };
        if path_module.is_empty() {
            return false;
        }
        if is_mod {
            module == path_module
        } else {
            // The changed file's module, or a module nested in it (an inline `mod` inside that file).
            module.len() >= path_module.len() && module[..path_module.len()] == path_module[..]
        }
    })
}

fn split_dir(path: &str) -> (String, String) {
    let path = norm(path);
    match path.rsplit_once('/') {
        Some((dir, base)) => (dir.to_string(), base.to_string()),
        None => (String::new(), path),
    }
}

/// The folder a test's source lives in: a `tests`, `test`, `spec` or `__tests__` folder is its parent's.
fn source_dir(dir: &str) -> String {
    let (parent, last) = match dir.rsplit_once('/') {
        Some((parent, last)) => (parent.to_string(), last),
        None => (String::new(), dir),
    };
    if matches!(last, "tests" | "test" | "spec" | "specs" | "__tests__") {
        parent
    } else {
        dir.to_string()
    }
}

/// A file's name with its extension, `.test` / `.spec` and `_test` / `test_` taken off.
fn bare_stem(base: &str) -> String {
    let stem = match base.rsplit_once('.') {
        Some((stem, _ext)) if !stem.is_empty() => stem,
        _ => base,
    };
    let stem = stem
        .strip_suffix(".test")
        .or_else(|| stem.strip_suffix(".spec"))
        .or_else(|| stem.strip_suffix("_test"))
        .or_else(|| stem.strip_suffix("_spec"))
        .or_else(|| stem.strip_prefix("test_"))
        .unwrap_or(stem);
    stem.to_lowercase()
}

/// Whether `test` is the test file of `source`: the same folder and the same name.
pub fn covers(test: &str, source: &str) -> bool {
    let (test_dir, test_base) = split_dir(test);
    let (source_dir_path, source_base) = split_dir(source);
    if test_base.is_empty() || source_base.is_empty() {
        return false;
    }
    let (a, b) = (bare_stem(&test_base), bare_stem(&source_base));
    !a.is_empty()
        && a == b
        && (source_dir(&test_dir) == source_dir(&source_dir_path) || test_dir == source_dir_path)
}

fn import_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"["'](\.{1,2}/[^"'\n\r]+)["']"#).expect("an import pattern"))
}

fn strip_ext(path: &str) -> String {
    for ext in [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] {
        if let Some(stem) = path.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    path.to_string()
}

/// `dir` joined with a relative `spec`, with `..` folded. `None` when it climbs out of the repository.
fn join_relative(dir: &str, spec: &str) -> Option<String> {
    let mut parts: Vec<&str> = if dir.is_empty() {
        Vec::new()
    } else {
        dir.split('/').collect()
    };
    for piece in spec.split('/') {
        match piece {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

/// The relative specs (`./x`, `../y/z`) a file's text imports, mocks or requires, without their extensions.
fn import_specs(text: &str) -> Vec<String> {
    import_re()
        .captures_iter(text)
        .map(|capture| strip_ext(capture[1].trim_end_matches('/')))
        .collect()
}

/// The tracked file a resolved import names: with a script extension, or as a folder's index.
fn tracked_import(resolved: &str, tracked: &std::collections::HashSet<String>) -> Option<String> {
    const EXTENSIONS: [&str; 8] = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
    EXTENSIONS
        .iter()
        .map(|ext| format!("{resolved}{ext}"))
        .chain(
            EXTENSIONS
                .iter()
                .map(|ext| format!("{resolved}/index{ext}")),
        )
        .find(|path| tracked.contains(path))
}

/// Whether the test file imports a changed file, directly or through one file it imports: a test of a component fails when the model
/// the component imports changed. Two steps and no more: a cut that deep is where the list is for.
fn imports_changed_deep(
    text: &str,
    test_file: &str,
    changed: &[String],
    tracked: &[String],
    read: &dyn Fn(&str) -> Option<String>,
) -> bool {
    if imports_changed(text, test_file, changed) {
        return true;
    }
    // A repository too big to index here is judged by the direct imports alone.
    if tracked.is_empty() || tracked.len() > 50_000 {
        return false;
    }
    let known: std::collections::HashSet<String> = tracked.iter().map(|path| norm(path)).collect();
    let (dir, _) = split_dir(test_file);
    for spec in import_specs(text).into_iter().take(40) {
        let Some(resolved) = join_relative(&dir, &spec) else {
            continue;
        };
        let Some(file) = tracked_import(&resolved, &known) else {
            continue;
        };
        if read(&file).is_some_and(|inner| imports_changed(&inner, &file, changed)) {
            return true;
        }
    }
    false
}

/// Whether the test file's text imports (or mocks, or requires) a file in `changed`.
pub fn imports_changed(text: &str, test_file: &str, changed: &[String]) -> bool {
    let (dir, _) = split_dir(test_file);
    let changed: Vec<String> = changed
        .iter()
        .map(|path| {
            let path = norm(path);
            let stem = strip_ext(&path);
            stem.strip_suffix("/index")
                .map(str::to_string)
                .unwrap_or(stem)
        })
        .collect();
    import_re().captures_iter(text).any(|capture| {
        let spec = strip_ext(capture[1].trim_end_matches('/'));
        let Some(resolved) = join_relative(&dir, &spec) else {
            return false;
        };
        changed.contains(&resolved)
    })
}

/// The tracked file a name refers to: the path itself, else the one tracked file it is the tail of.
pub fn resolve_tracked<'a>(file: &str, tracked: &'a [String]) -> Option<&'a String> {
    let wanted = norm(file);
    if wanted.is_empty() {
        return None;
    }
    if let Some(exact) = tracked.iter().find(|path| norm(path) == wanted) {
        return Some(exact);
    }
    let tail = format!("/{wanted}");
    let mut hits = tracked.iter().filter(|path| norm(path).ends_with(&tail));
    let first = hits.next()?;
    hits.next().is_none().then_some(first)
}

/// Whether this failing test is the task's own. `changed` are the paths the task's copy changed (checkout-relative); `tracked`
/// the repository's files, for finding a test file that was printed relative to a test folder; `read` reads a tracked file.
pub fn is_own(
    failing: &Failing,
    changed: &[String],
    tracked: &[String],
    read: &dyn Fn(&str) -> Option<String>,
) -> bool {
    if matches!(failing.runner.as_str(), "cargo" | "nextest") {
        if rust_own(&failing.name, changed) {
            return true;
        }
        // An integration test file (a `tests` folder with no `src` above it) names no module a failing test can be matched to: when
        // the task changed one, and this test lives in no source file we know of, it may be that file's own.
        return failing.file.trim().is_empty()
            && changed.iter().any(|path| is_rust_integration_test(path));
    }
    if failing.file.trim().is_empty() {
        return true;
    }
    if changed.iter().any(|path| same_file(&failing.file, path)) {
        return true;
    }
    let resolved = resolve_tracked(&failing.file, tracked)
        .map(String::as_str)
        .unwrap_or(failing.file.as_str());
    if changed
        .iter()
        .any(|path| covers(&failing.file, path) || covers(resolved, path))
    {
        return true;
    }
    read(resolved).is_some_and(|text| imports_changed_deep(&text, resolved, changed, tracked, read))
}

/// The failing tests of one run, with files and runners filled in.
pub fn from_failures(
    runner: Option<Runner>,
    command: &str,
    failures: &[Failure],
    rust_files: &[String],
) -> Vec<Failing> {
    failures
        .iter()
        .map(|failure| {
            // The summary's runner is the last one in the output; a log that ran two runners names tests of both. Keep it when the
            // name reads as that runner's, else read the name's own shape.
            let known = runner.map(runner_word);
            let fits = |word: &str| {
                !file_of(word, &failure.name, rust_files).is_empty()
                    || (matches!(word, "cargo" | "nextest") && rust_module(&failure.name).is_some())
            };
            let word = match known {
                Some(word) if fits(word) => word,
                _ => match guess_runner(&failure.name) {
                    "unknown" => known.unwrap_or("unknown"),
                    guessed => guessed,
                },
            };
            Failing {
                runner: word.to_string(),
                file: file_of(word, &failure.name, rust_files),
                name: failure.name.clone(),
                message: failure.message.clone(),
                command: command.to_string(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failing(runner: &str, file: &str, name: &str) -> Failing {
        Failing {
            runner: runner.into(),
            file: file.into(),
            name: name.into(),
            message: String::new(),
            command: "affected".into(),
        }
    }

    fn own(f: &Failing, changed: &[&str]) -> bool {
        let changed: Vec<String> = changed.iter().map(|s| (*s).to_string()).collect();
        is_own(f, &changed, &[], &|_| None)
    }

    #[test]
    fn a_test_file_the_task_added_or_changed_is_its_own() {
        let f = failing("vitest", "src/x/other.test.ts", "suite > t");
        assert!(own(&f, &["src/x/other.test.ts"]));
        assert!(!own(&f, &["src/y/unrelated.ts"]));
    }

    #[test]
    fn a_test_that_covers_a_changed_source_file_is_its_own() {
        // The hide-a-failure case at the rule's level: the task changed src/a.ts and src/a.test.ts fails.
        let f = failing("vitest", "src/a.test.ts", "works");
        assert!(own(&f, &["src/a.ts"]));
        assert!(own(&f, &["src/a.tsx"]));
        assert!(!own(&f, &["src/b.ts"]));
        assert!(!own(&f, &["lib/a.ts"]), "another folder is another file");
    }

    #[test]
    fn the_name_rule_reads_every_runners_test_naming() {
        assert!(covers("src/a.spec.ts", "src/a.ts"));
        assert!(covers("pkg/a_test.go", "pkg/a.go"));
        assert!(covers("tests/test_a.py", "a.py"));
        assert!(covers("src/__tests__/a.test.ts", "src/a.ts"));
        assert!(covers("src/tests/a.test.ts", "src/a.ts"));
        assert!(covers("src/A.test.ts", "src/a.ts"), "case does not matter");
        assert!(!covers("src/ab.test.ts", "src/a.ts"));
        assert!(!covers("src/a.test.ts", "other/a.ts"));
        assert!(!covers("", "a.ts"));
    }

    #[test]
    fn a_test_that_imports_a_changed_file_is_its_own() {
        let f = failing("vitest", "src/features/x/panel.test.ts", "t");
        let changed = vec!["src/features/x/model/totals.ts".to_string()];
        let text = r#"import { totals } from "./model/totals";"#;
        let read = |_: &str| Some(text.to_string());
        assert!(is_own(&f, &changed, &[], &read));
        let elsewhere = r#"import { other } from "./model/other";"#;
        let read = |_: &str| Some(elsewhere.to_string());
        assert!(!is_own(&f, &changed, &[], &read));
        // A mock, a dynamic import, `..` and an index file count too.
        for text in [
            r#"vi.mock("./model/totals")"#,
            r#"const m = await import('./model/totals.ts')"#,
            r#"const m = require("../x/model/totals.js")"#,
        ] {
            let read = |_: &str| Some(text.to_string());
            assert!(is_own(&f, &changed, &[], &read), "{text}");
        }
        let index = vec!["src/features/x/model/index.ts".to_string()];
        let read = |_: &str| Some(r#"import x from "./model""#.to_string());
        assert!(is_own(&f, &index, &[], &read));
    }

    #[test]
    fn a_test_of_a_component_is_the_tasks_own_when_the_model_the_component_imports_changed() {
        let tracked = vec![
            "src/features/x/panel.test.ts".to_string(),
            "src/features/x/panel.ts".to_string(),
            "src/features/x/model/totals.ts".to_string(),
            "src/features/x/other.ts".to_string(),
        ];
        let f = failing("vitest", "src/features/x/panel.test.ts", "t");
        let files = |path: &str| -> Option<String> {
            match path {
                "src/features/x/panel.test.ts" => {
                    Some(r#"import { Panel } from "./panel";"#.to_string())
                }
                "src/features/x/panel.ts" => {
                    Some(r#"import { totals } from "./model/totals";"#.to_string())
                }
                "src/features/x/other.ts" => Some("export const o = 1;".to_string()),
                _ => None,
            }
        };
        // Two steps: the test imports the panel, the panel imports the changed model.
        assert!(is_own(
            &f,
            &["src/features/x/model/totals.ts".to_string()],
            &tracked,
            &files
        ));
        // A change the panel does not reach is not it.
        assert!(!is_own(
            &f,
            &["src/features/x/other.ts".to_string()],
            &tracked,
            &files
        ));
        // And the same chain with nothing tracked is judged by the direct imports alone.
        assert!(!is_own(
            &f,
            &["src/features/x/model/totals.ts".to_string()],
            &[],
            &files
        ));
    }

    #[test]
    fn an_unreadable_test_file_is_not_shown_to_be_foreign_by_its_text_but_by_the_other_rules() {
        let f = failing("vitest", "src/features/x/panel.test.ts", "t");
        assert!(!is_own(&f, &["src/other.ts".into()], &[], &|_| None));
    }

    #[test]
    fn a_test_whose_file_is_unknown_is_the_tasks_own_never_the_lists() {
        for runner in ["go", "node", "unknown", "vitest"] {
            assert!(
                own(&failing(runner, "", "TestSomething"), &["src/a.ts"]),
                "{runner}"
            );
        }
    }

    #[test]
    fn a_path_with_windows_separators_dots_and_a_playwright_test_folder_is_matched() {
        let f = failing("playwright", "browser/a.spec.ts", "title");
        assert!(
            own(&f, &["tests/browser/a.spec.ts"]),
            "printed relative to the test folder"
        );
        let f = failing("vitest", "src\\a.test.ts", "t");
        assert!(own(&f, &["src/a.ts"]));
        assert!(own(&f, &["./src/a.test.ts"]));
    }

    #[test]
    fn a_path_that_climbs_out_of_the_repository_matches_nothing() {
        let changed = vec!["src/a.ts".to_string()];
        assert!(!imports_changed(
            r#"import x from "../../../a""#,
            "src/a.test.ts",
            &changed
        ));
        assert!(!own(
            &failing("vitest", "../../a.test.ts", "t"),
            &["src/other.ts"]
        ));
    }

    #[test]
    fn rust_tests_are_the_tasks_own_when_their_module_is_in_a_changed_source_file() {
        let changed = |paths: &[&str]| paths.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        let t = failing("cargo", "", "firstmate::gates::tests::works");
        // A #[cfg(test)] block in a source file the task changed.
        assert!(is_own(
            &t,
            &changed(&["src-tauri/src/firstmate/gates.rs"]),
            &[],
            &|_| None
        ));
        // Its separate tests file.
        assert!(is_own(
            &t,
            &changed(&["src-tauri/src/firstmate/gates/tests.rs"]),
            &[],
            &|_| None
        ));
        assert!(is_own(
            &t,
            &changed(&["src-tauri/src/firstmate/gates_tests.rs"]),
            &[],
            &|_| None
        ));
        // A sibling module, a parent's mod.rs and another crate's file are not it.
        assert!(!is_own(
            &t,
            &changed(&["src-tauri/src/firstmate/fact_gaps.rs"]),
            &[],
            &|_| None
        ));
        assert!(!is_own(
            &t,
            &changed(&["src-tauri/src/firstmate/mod.rs"]),
            &[],
            &|_| None
        ));
        assert!(!is_own(
            &t,
            &changed(&["src-tauri/src/lib.rs"]),
            &[],
            &|_| None
        ));
        // A module nested in the changed file.
        let nested = failing("cargo", "", "firstmate::gates::review_r5::works");
        assert!(is_own(
            &nested,
            &changed(&["src-tauri/src/firstmate/gates.rs"]),
            &[],
            &|_| None
        ));
        // A mod.rs owns its own tests.
        let direct = failing("cargo", "", "firstmate::tests::works");
        assert!(is_own(
            &direct,
            &changed(&["src-tauri/src/firstmate/mod.rs"]),
            &[],
            &|_| None
        ));
        // Windows separators.
        assert!(is_own(
            &t,
            &changed(&["src-tauri\\src\\firstmate\\gates.rs"]),
            &[],
            &|_| None
        ));
        // A test with no module is not shown to be another task's.
        assert!(is_own(
            &failing("cargo", "", "works"),
            &changed(&["src/x.rs"]),
            &[],
            &|_| None
        ));
    }

    #[test]
    fn a_nextest_name_is_read_from_its_last_word() {
        let t = failing("nextest", "", "monocode-hub firstmate::gates::tests::works");
        assert!(own(&t, &["src-tauri/src/firstmate/gates.rs"]));
        assert!(!own(&t, &["src-tauri/src/firstmate/checker.rs"]));
    }

    #[test]
    fn files_are_read_from_each_runners_names() {
        let rust = vec![
            "src-tauri/src/firstmate/gates.rs".to_string(),
            "src-tauri/src/firstmate/gates/tests.rs".to_string(),
            "src-tauri/src/firstmate/mod.rs".to_string(),
        ];
        assert_eq!(
            file_of("vitest", "src/a.test.ts > suite > works", &[]),
            "src/a.test.ts"
        );
        assert_eq!(file_of("vitest", "just a name", &[]), "");
        assert_eq!(
            file_of("pytest", "tests/test_a.py::TestX::test_y", &[]),
            "tests/test_a.py"
        );
        assert_eq!(
            file_of(
                "playwright",
                "[chromium] › tests/browser/a.spec.ts:12:5 › title",
                &[]
            ),
            "tests/browser/a.spec.ts"
        );
        assert_eq!(
            file_of("playwright", "[webkit] › a.spec.ts:7:5 › a › b", &[]),
            "a.spec.ts"
        );
        assert_eq!(
            file_of("cargo", "firstmate::gates::tests::works", &rust),
            "src-tauri/src/firstmate/gates.rs",
            "the source file, not its tests file"
        );
        assert_eq!(
            file_of("cargo", "firstmate::mod_x::tests::works", &rust),
            ""
        );
        assert_eq!(file_of("go", "TestX", &[]), "");
    }

    #[test]
    fn a_runner_is_guessed_from_a_name_when_the_log_is_gone() {
        assert_eq!(guess_runner("[chromium] › a.spec.ts:1:1 › t"), "playwright");
        assert_eq!(guess_runner("src/a.test.ts > t"), "vitest");
        assert_eq!(guess_runner("tests/test_a.py::test_x"), "pytest");
        assert_eq!(guess_runner("firstmate::gates::tests::works"), "cargo");
        assert_eq!(guess_runner("some words"), "unknown");
    }

    #[test]
    fn a_test_file_printed_relative_to_a_test_folder_is_found_among_the_tracked_files() {
        let tracked = vec![
            "tests/browser/a.spec.ts".to_string(),
            "tests/other/b.spec.ts".to_string(),
            "tests/one/c.spec.ts".to_string(),
            "tests/two/c.spec.ts".to_string(),
        ];
        assert_eq!(
            resolve_tracked("browser/a.spec.ts", &tracked).map(String::as_str),
            Some("tests/browser/a.spec.ts")
        );
        assert_eq!(
            resolve_tracked("c.spec.ts", &tracked),
            None,
            "two files with that tail: not guessed"
        );
        assert_eq!(resolve_tracked("", &tracked), None);
    }

    #[test]
    fn a_rust_test_in_a_changed_integration_test_file_is_the_tasks_own() {
        let changed = vec!["src-tauri/tests/api.rs".to_string()];
        // A nested module of the integration crate: no source file holds it.
        let t = failing("cargo", "", "api_mod::works");
        assert!(is_own(&t, &changed, &[], &|_| None));
        // Unrelated changes do not make it the task's.
        assert!(!is_own(
            &t,
            &["src-tauri/src/lib.rs".to_string()],
            &[],
            &|_| None
        ));
        // A test that does live in a known source file is judged by that file.
        let known = failing(
            "cargo",
            "src-tauri/src/firstmate/gates.rs",
            "firstmate::gates::tests::works",
        );
        assert!(!is_own(&known, &changed, &[], &|_| None));
    }

    #[test]
    fn output_that_ran_two_runners_reads_each_name_by_its_own_shape() {
        // The summary says playwright (the last one), but a vitest failure from earlier in the same output keeps its file.
        let failures = vec![
            Failure {
                name: "src/other.test.ts > suite > works".into(),
                message: String::new(),
            },
            Failure {
                name: "[chromium] › tests/browser/a.spec.ts:3:1 › title".into(),
                message: String::new(),
            },
        ];
        let got = from_failures(Some(Runner::Playwright), "npm test", &failures, &[]);
        assert_eq!(
            (got[0].runner.as_str(), got[0].file.as_str()),
            ("vitest", "src/other.test.ts")
        );
        assert_eq!(
            (got[1].runner.as_str(), got[1].file.as_str()),
            ("playwright", "tests/browser/a.spec.ts")
        );
        // A foreign vitest failure is then foreign, not "unknown, so its own".
        assert!(!is_own(
            &got[0],
            &["src/feature.ts".to_string()],
            &[],
            &|_| None
        ));
        // A name with no shape of its own keeps the runner the summary gave.
        let go = from_failures(
            Some(Runner::Go),
            "go test",
            &[Failure {
                name: "TestSomething".into(),
                message: String::new(),
            }],
            &[],
        );
        assert_eq!(go[0].runner, "go");
    }

    #[test]
    fn from_failures_fills_in_runner_and_file() {
        let failures = vec![Failure {
            name: "src/a.test.ts > suite > works".into(),
            message: "expected".into(),
        }];
        let got = from_failures(Some(Runner::Vitest), "affected", &failures, &[]);
        assert_eq!(got[0].runner, "vitest");
        assert_eq!(got[0].file, "src/a.test.ts");
        assert_eq!(got[0].command, "affected");
        let guessed = from_failures(None, "npm test", &failures, &[]);
        assert_eq!(guessed[0].runner, "vitest");
    }
}
