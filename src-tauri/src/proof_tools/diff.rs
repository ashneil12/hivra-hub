//! PT-1: a change as the line ranges a tool is scoped to. StrykerJS has no git or diff option (`--mutate` takes
//! `path:startLine-endLine` ranges), and cargo-mutants reads a unified diff file, so the app turns the change it already
//! has (`git diff -U0`, plus each new untracked file) into the form each tool takes.
//!
//! The text read here is untrusted: a diff names files the project chose. Nothing in it is ever run or put in a shell
//! line (`command.rs` passes ranges and paths as arguments), and a path a tool would read as a pattern is left out and
//! said so, never quoted into a guess.

use std::collections::BTreeMap;

/// The most hunks read from one diff.
const HUNKS_MAX: usize = 5_000;
/// The most ranges handed to one Stryker run.
const RANGES_MAX: usize = 200;

/// A run of changed lines in one file: new-side, 1-based, both ends included.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub path: String,
    pub start: u32,
    pub end: u32,
}

/// `@@ -a,b +c,d @@`: the new side's start and count, and the old side's count (the lines the hunk body spends on removals).
fn header(line: &str) -> Option<(u32, u32, u32)> {
    fn span(text: &str) -> Option<(u32, u32)> {
        match text.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((text.parse().ok()?, 1)),
        }
    }
    let rest = line.strip_prefix("@@ ")?;
    let (spec, _) = rest.split_once(" @@")?;
    let mut parts = spec.split_whitespace();
    let old = parts.next()?.strip_prefix('-')?;
    let new = parts.next()?.strip_prefix('+')?;
    // A combined diff (`@@@`) has more than two ranges: not a diff this reads.
    if parts.next().is_some() {
        return None;
    }
    let (_, old_count) = span(old)?;
    let (start, count) = span(new)?;
    Some((start, count, old_count))
}

/// A path git wrote in C-style quotes: `"caf\303\251/\"q\".ts"`. `None` when it isn't closed or has an escape git never writes.
fn unquote(text: &str) -> Option<String> {
    let mut bytes = text.strip_prefix('"')?.bytes().peekable();
    let mut out: Vec<u8> = Vec::new();
    loop {
        match bytes.next()? {
            b'"' => break,
            b'\\' => match bytes.next()? {
                escaped @ (b'"' | b'\\') => out.push(escaped),
                b't' => out.push(b'\t'),
                b'n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b'a' => out.push(7),
                b'b' => out.push(8),
                b'f' => out.push(12),
                b'v' => out.push(11),
                digit @ b'0'..=b'7' => {
                    let mut value = u32::from(digit - b'0');
                    for _ in 0..2 {
                        match bytes.peek() {
                            Some(&next) if (b'0'..=b'7').contains(&next) => {
                                value = value * 8 + u32::from(next - b'0');
                                bytes.next();
                            }
                            _ => break,
                        }
                    }
                    out.push(u8::try_from(value).ok()?);
                }
                _ => return None,
            },
            byte => out.push(byte),
        }
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// The new path on a `+++ ` line, or `None` for a deleted file (`/dev/null`) and for a line this can't read.
fn new_path(rest: &str) -> Option<String> {
    let rest = rest.trim_end_matches('\r');
    let path = if rest.starts_with('"') {
        unquote(rest)?
    } else {
        // Git adds a TAB (and for some tools a timestamp) after a name with a space in it.
        rest.split('\t').next().unwrap_or("").to_string()
    };
    if path.is_empty() || path == "/dev/null" {
        return None;
    }
    let path = path.strip_prefix("b/").unwrap_or(&path).to_string();
    (!path.is_empty()).then_some(path)
}

/// The changed ranges of a `git diff -U0 --no-color --no-renames` text, in the order the diff lists them. A deleted
/// file, a binary file and a pure deletion (no new line) have none. CRLF, garbage and a cut-off diff read as far as they
/// go and never panic; at most 5000 hunks are read.
pub fn hunks(unified: &str) -> Vec<Hunk> {
    let mut out: Vec<Hunk> = Vec::new();
    let mut path: Option<String> = None;
    // Lines of the current hunk's body still to come: a removed line `-- x` shows as `--- x`, so a `---` or `+++` inside
    // a body is content, not a file header.
    let mut old_left = 0u32;
    let mut new_left = 0u32;
    for raw in unified.lines() {
        let line = raw.trim_end_matches('\r');
        if old_left > 0 || new_left > 0 {
            match line.as_bytes().first() {
                Some(b'-') => {
                    old_left = old_left.saturating_sub(1);
                    continue;
                }
                Some(b'+') => {
                    new_left = new_left.saturating_sub(1);
                    continue;
                }
                Some(b' ') => {
                    old_left = old_left.saturating_sub(1);
                    new_left = new_left.saturating_sub(1);
                    continue;
                }
                Some(b'\\') => continue,
                // Not a body line: the hunk was shorter than its header said. Read this line as a header.
                _ => {
                    old_left = 0;
                    new_left = 0;
                }
            }
        }
        if line.starts_with("diff --git ") {
            path = None;
        } else if let Some(rest) = line.strip_prefix("+++ ") {
            path = new_path(rest);
        } else if line.starts_with("@@ ") {
            let Some((start, count, old)) = header(line) else {
                continue;
            };
            old_left = old;
            new_left = count;
            if count == 0 || start == 0 || out.len() >= HUNKS_MAX {
                continue;
            }
            if let Some(path) = &path {
                out.push(Hunk {
                    path: path.clone(),
                    start,
                    end: start.saturating_add(count - 1),
                });
            }
        }
    }
    out
}

/// Whether a path is a test: `*.test.*`, `*.spec.*`, `*.e2e.*`, `*_test.*`, `test_*.py`, `conftest.py`, or anything under
/// a `tests`, `test`, `__tests__`, `spec`, `specs` or `e2e` folder. Case is ignored and both separators count.
pub fn is_test_path(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_lowercase();
    let mut parts: Vec<&str> = lower.split('/').filter(|part| !part.is_empty()).collect();
    let Some(name) = parts.pop() else {
        return false;
    };
    if parts.iter().any(|dir| {
        matches!(
            *dir,
            "tests" | "test" | "__tests__" | "spec" | "specs" | "e2e"
        )
    }) {
        return true;
    }
    name.contains(".test.")
        || name.contains(".spec.")
        || name.contains(".e2e.")
        || name.contains("_test.")
        || name.contains("_spec.")
        || (name.starts_with("test_") && name.ends_with(".py"))
        || name == "conftest.py"
}

/// A JavaScript or TypeScript source file a mutation tester may change: not a test, not a declaration file.
pub fn is_js_source(path: &str) -> bool {
    let lower = path.to_lowercase();
    const EXTENSIONS: [&str; 8] = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
    EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
        && !(lower.ends_with(".d.ts") || lower.ends_with(".d.mts") || lower.ends_with(".d.cts"))
        && !is_test_path(path)
}

/// A file a person sees in a web app: components, markup and styles, not tests.
pub fn is_ui_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    const EXTENSIONS: [&str; 10] = [
        ".tsx", ".jsx", ".vue", ".svelte", ".astro", ".html", ".css", ".scss", ".sass", ".less",
    ];
    EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) && !is_test_path(path)
}

/// The ranges Stryker is scoped to, and the paths it was not (each with why).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Ranges {
    pub ranges: Vec<String>,
    pub skipped: Vec<String>,
}

/// Why Stryker can't be given this path: it reads `--mutate` as a comma list of glob patterns. A plain space is an ordinary
/// character of a name (it travels as one argument, never in the shell line); any other whitespace is not.
fn pattern_like(path: &str) -> bool {
    path.starts_with('-')
        || path.chars().any(|c| {
            matches!(c, ',' | '*' | '?' | '[' | ']' | '{' | '}' | '!' | '(' | ')')
                || (c.is_whitespace() && c != ' ')
                || c.is_control()
        })
}

/// `path:start-end` for each changed run of lines in a JavaScript or TypeScript source file (a single line is
/// `path:7-7`). Runs that touch or overlap in one file are merged. A path Stryker would read as a pattern is left out and
/// named in `skipped`, as is everything past 200 ranges. Sorted by path, then line.
pub fn stryker_ranges(hunks: &[Hunk]) -> Ranges {
    let mut by_path: BTreeMap<&str, Vec<(u32, u32)>> = BTreeMap::new();
    for hunk in hunks
        .iter()
        .filter(|hunk| is_js_source(&hunk.path) && hunk.start >= 1 && hunk.end >= hunk.start)
    {
        by_path
            .entry(hunk.path.as_str())
            .or_default()
            .push((hunk.start, hunk.end));
    }
    let mut found = Ranges::default();
    let mut all: Vec<String> = Vec::new();
    for (path, mut spans) in by_path {
        if pattern_like(path) {
            found.skipped.push(format!(
                "{path}: its name has a character Stryker would read as a pattern or a list, so its changed lines weren't mutated"
            ));
            continue;
        }
        spans.sort_unstable();
        let mut merged: Vec<(u32, u32)> = Vec::new();
        for (start, end) in spans {
            match merged.last_mut() {
                Some(last) if start <= last.1.saturating_add(1) => last.1 = last.1.max(end),
                _ => merged.push((start, end)),
            }
        }
        all.extend(
            merged
                .into_iter()
                .map(|(start, end)| format!("{path}:{start}-{end}")),
        );
    }
    if all.len() > RANGES_MAX {
        let extra = all.len() - RANGES_MAX;
        all.truncate(RANGES_MAX);
        found.skipped.push(format!(
            "{extra} more changed ranges weren't mutated (the limit is {RANGES_MAX})"
        ));
    }
    found.ranges = all;
    found
}

/// A unified diff that adds the whole of a new file, so a tool that reads a diff (cargo-mutants' `--in-diff`) sees a file
/// `git diff` leaves out because it is untracked. Empty for an empty file and for a path with a line break in it.
pub fn untracked_as_diff(path: &str, text: &str) -> String {
    if text.is_empty() || path.is_empty() || path.contains(['\n', '\r']) {
        return String::new();
    }
    let count = text.lines().count();
    if count == 0 {
        return String::new();
    }
    // Git ends a name with a space in it with a TAB.
    let tab = if path.chars().any(char::is_whitespace) {
        "\t"
    } else {
        ""
    };
    let mut out = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}{tab}\n@@ -0,0 +1,{count} @@\n"
    );
    for line in text.lines() {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hunk(path: &str, start: u32, end: u32) -> Hunk {
        Hunk {
            path: path.into(),
            start,
            end,
        }
    }

    const THREE_HUNKS: &str = "\
diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3 +3,2 @@ export function f() {
-  return 1;
+  return 2;
+  // more
@@ -10,2 +11,0 @@ x
-gone
-gone2
@@ -20,0 +20,3 @@
+new1
+new2
+new3
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-x
+y
";

    #[test]
    fn three_hunks_across_two_files_become_their_new_side_ranges() {
        assert_eq!(
            hunks(THREE_HUNKS),
            vec![
                hunk("src/a.ts", 3, 4),
                hunk("src/a.ts", 20, 22),
                hunk("src/b.ts", 1, 1)
            ]
        );
    }

    #[test]
    fn a_pure_deletion_has_no_new_line_and_so_no_range() {
        let diff = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -5,2 +4,0 @@\n-a\n-b\n";
        assert!(hunks(diff).is_empty());
    }

    #[test]
    fn a_file_renamed_away_is_a_deletion_and_its_new_name_is_an_addition() {
        let diff = "\
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+a
+b
";
        assert_eq!(hunks(diff), vec![hunk("new.ts", 1, 2)]);
    }

    #[test]
    fn a_path_with_a_space_loses_the_tab_git_adds() {
        let diff = "diff --git a/my dir/a b.ts b/my dir/a b.ts\n--- a/my dir/a b.ts\t\n+++ b/my dir/a b.ts\t\n@@ -1 +1 @@\n-x\n+y\n";
        assert_eq!(hunks(diff), vec![hunk("my dir/a b.ts", 1, 1)]);
    }

    #[test]
    fn a_quoted_path_with_octal_unicode_and_escaped_quotes_is_read_back() {
        let diff = r#"diff --git "a/caf\303\251/\"q\".ts" "b/caf\303\251/\"q\".ts"
--- "a/caf\303\251/\"q\".ts"
+++ "b/caf\303\251/\"q\".ts"
@@ -2 +2,3 @@
-x
+y
+z
+w
"#;
        assert_eq!(hunks(diff), vec![hunk("café/\"q\".ts", 2, 4)]);
        assert_eq!(unquote(r#""a\tb\\c""#).as_deref(), Some("a\tb\\c"));
        assert_eq!(unquote("\"never closed"), None);
        assert_eq!(unquote(r#""bad \q""#), None);
        assert_eq!(unquote(r#""\777""#), None);
    }

    #[test]
    fn crlf_line_endings_and_a_header_without_a_count_read_the_same() {
        let diff = THREE_HUNKS.replace('\n', "\r\n");
        assert_eq!(hunks(&diff), hunks(THREE_HUNKS));
        // `+7` is one line, `+7,1` is one line.
        let bare = "+++ b/x.ts\n@@ -7 +7 @@\n-a\n+b\n@@ -9 +9,1 @@\n-a\n+b\n";
        assert_eq!(hunks(bare), vec![hunk("x.ts", 7, 7), hunk("x.ts", 9, 9)]);
    }

    #[test]
    fn a_line_that_looks_like_a_file_header_inside_a_hunk_is_content() {
        let diff = "\
diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -4,2 +4,2 @@
--- foo
-bar
+++ baz
++qux
@@ -9 +9 @@
-x
+y
";
        assert_eq!(hunks(diff), vec![hunk("a.ts", 4, 5), hunk("a.ts", 9, 9)]);
    }

    #[test]
    fn a_binary_file_and_a_no_newline_marker_add_nothing() {
        let diff = "diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\ndiff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n";
        assert_eq!(hunks(diff), vec![hunk("y.ts", 1, 1)]);
    }

    #[test]
    fn empty_and_garbage_input_gives_no_hunks_and_never_panics() {
        assert!(hunks("").is_empty());
        assert!(hunks("\n\n\n").is_empty());
        assert!(hunks("random words\n@@ nonsense @@\n+++ \n--- \n@@ -x +y @@\n").is_empty());
        // A hunk before any file, one that is cut off, a combined diff and huge numbers.
        assert!(hunks("@@ -1 +1 @@\n-a\n+b\n").is_empty());
        assert!(hunks("+++ b/x.ts\n@@ -1,5 +1,5 @@\n").len() == 1);
        assert!(hunks("+++ b/x.ts\n@@@ -1 -2 +1 @@@\n").is_empty());
        assert_eq!(
            hunks("+++ b/x.ts\n@@ -1 +4294967295,4294967295 @@\n"),
            vec![hunk("x.ts", u32::MAX, u32::MAX)]
        );
        assert!(hunks("+++ \"b/unterminated\n@@ -1 +1 @@\n").is_empty());
    }

    #[test]
    fn at_most_five_thousand_hunks_are_read() {
        let mut diff = String::from("+++ b/x.ts\n");
        for n in 1..=6_000 {
            diff.push_str(&format!("@@ -{n} +{n} @@\n-a\n+b\n"));
        }
        assert_eq!(hunks(&diff).len(), HUNKS_MAX);
    }

    // ---- paths ---------------------------------------------------------------------------------------------------------------

    #[test]
    fn tests_are_told_by_name_and_by_folder_whatever_the_case_or_separator() {
        for test in [
            "src/a.test.ts",
            "src/a.spec.tsx",
            "src/a_test.go",
            "tests/helper.ts",
            "src/__tests__/a.ts",
            "SRC\\Tests\\A.ts",
            "pkg/test_models.py",
            "pkg/conftest.py",
            "web/e2e/login.ts",
            "flows/login.e2e.ts",
            "spec/a.js",
        ] {
            assert!(is_test_path(test), "{test}");
        }
        for source in [
            "src/a.ts",
            "src/latest.ts",
            "src/contest.ts",
            "src/testing.ts",
            "",
            "/",
        ] {
            assert!(!is_test_path(source), "{source}");
        }
    }

    #[test]
    fn javascript_sources_exclude_tests_declarations_and_other_languages() {
        for yes in [
            "a.ts",
            "src/a.tsx",
            "a.JS",
            "a.jsx",
            "a.mjs",
            "a.cjs",
            "a.mts",
            "a.cts",
        ] {
            assert!(is_js_source(yes), "{yes}");
        }
        for no in [
            "a.d.ts",
            "a.d.mts",
            "a.test.ts",
            "tests/a.ts",
            "a.rs",
            "a.json",
            "a.css",
            "a",
        ] {
            assert!(!is_js_source(no), "{no}");
        }
    }

    #[test]
    fn ui_files_are_components_markup_and_styles_but_not_their_tests() {
        for yes in [
            "a.tsx",
            "a.vue",
            "a.svelte",
            "a.astro",
            "index.html",
            "a.css",
            "a.scss",
            "a.sass",
            "a.less",
            "src/Button.JSX",
        ] {
            assert!(is_ui_path(yes), "{yes}");
        }
        for no in ["a.ts", "a.rs", "a.test.tsx", "tests/a.css", "a.md"] {
            assert!(!is_ui_path(no), "{no}");
        }
    }

    // ---- Stryker ranges ------------------------------------------------------------------------------------------------------

    #[test]
    fn stryker_gets_one_range_per_changed_run_of_a_source_file_and_none_for_tests() {
        let found = stryker_ranges(&hunks(THREE_HUNKS));
        assert_eq!(
            found.ranges,
            ["src/a.ts:3-4", "src/a.ts:20-22", "src/b.ts:1-1"]
        );
        assert!(found.skipped.is_empty());
        let with_tests = [
            hunk("src/a.test.ts", 1, 9),
            hunk("src/a.d.ts", 1, 9),
            hunk("src/a.rs", 1, 9),
            hunk("src/a.ts", 7, 7),
        ];
        assert_eq!(stryker_ranges(&with_tests).ranges, ["src/a.ts:7-7"]);
    }

    #[test]
    fn touching_and_overlapping_runs_of_one_file_are_merged() {
        let found = stryker_ranges(&[
            hunk("a.ts", 10, 12),
            hunk("a.ts", 1, 3),
            hunk("a.ts", 4, 4),
            hunk("a.ts", 11, 15),
            hunk("a.ts", 20, 20),
            hunk("b.ts", 2, 2),
        ]);
        assert_eq!(
            found.ranges,
            ["a.ts:1-4", "a.ts:10-15", "a.ts:20-20", "b.ts:2-2"]
        );
    }

    #[test]
    fn a_path_stryker_would_read_as_a_pattern_is_left_out_and_said_so() {
        let found = stryker_ranges(&[
            hunk("ok.ts", 1, 1),
            hunk("a,b.ts", 1, 1),
            hunk("star*.ts", 1, 1),
            hunk("pages/[id].tsx", 1, 1),
            hunk("{x}.ts", 1, 1),
            hunk("-flag.ts", 1, 1),
            hunk("a b.ts", 1, 1),
            hunk("tab\there.ts", 1, 1),
            hunk("bang!.ts", 1, 1),
        ]);
        // A space is an ordinary character of a name; a tab, a comma and the glob characters are not.
        assert_eq!(found.ranges, ["a b.ts:1-1", "ok.ts:1-1"]);
        assert_eq!(found.skipped.len(), 7);
        for why in &found.skipped {
            assert!(why.contains("Stryker would read as a pattern"), "{why}");
        }
        assert!(found.skipped.iter().any(|why| why.starts_with("a,b.ts:")));
    }

    #[test]
    fn past_two_hundred_ranges_the_rest_are_named_not_silently_dropped() {
        let many: Vec<Hunk> = (0..205)
            .map(|n| hunk(&format!("f{n:03}.ts"), 1, 1))
            .collect();
        let found = stryker_ranges(&many);
        assert_eq!(found.ranges.len(), RANGES_MAX);
        assert_eq!(found.ranges[0], "f000.ts:1-1");
        assert_eq!(
            found.skipped,
            ["5 more changed ranges weren't mutated (the limit is 200)"]
        );
    }

    #[test]
    fn a_degenerate_hunk_is_not_a_range() {
        let found = stryker_ranges(&[hunk("a.ts", 0, 3), hunk("a.ts", 5, 4)]);
        assert!(found.ranges.is_empty() && found.skipped.is_empty());
        assert_eq!(stryker_ranges(&[]), Ranges::default());
    }

    // ---- new files -----------------------------------------------------------------------------------------------------------

    #[test]
    fn a_new_untracked_file_becomes_a_diff_that_adds_every_line() {
        let text = untracked_as_diff("src/new.rs", "a\nb\nc\n");
        assert_eq!(
            text,
            "diff --git a/src/new.rs b/src/new.rs\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.rs\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n"
        );
        assert_eq!(hunks(&text), vec![hunk("src/new.rs", 1, 3)]);
        // No trailing newline, CRLF, and a single line.
        assert_eq!(
            hunks(&untracked_as_diff("x.rs", "a\r\nb")),
            vec![hunk("x.rs", 1, 2)]
        );
        assert_eq!(
            hunks(&untracked_as_diff("x.rs", "only")),
            vec![hunk("x.rs", 1, 1)]
        );
    }

    #[test]
    fn a_new_file_with_a_space_in_its_name_keeps_the_tab_and_reads_back() {
        let text = untracked_as_diff("my dir/a b.rs", "x\n");
        assert!(text.contains("+++ b/my dir/a b.rs\t\n"), "{text:?}");
        assert_eq!(hunks(&text), vec![hunk("my dir/a b.rs", 1, 1)]);
    }

    #[test]
    fn an_empty_file_or_an_unwritable_name_makes_no_diff() {
        assert_eq!(untracked_as_diff("a.rs", ""), "");
        assert_eq!(untracked_as_diff("", "x"), "");
        assert_eq!(untracked_as_diff("a\nb.rs", "x"), "");
        assert_eq!(untracked_as_diff("a\rb.rs", "x"), "");
    }
}
