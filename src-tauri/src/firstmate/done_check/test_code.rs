//! SC-3a: test code that lives inside source files, and the tests in it (docs/specs/shipping-confidence-gap-spec.md,
//! "Also checked: are test files watched?").
//!
//! `done_check` reads a Rust source file's `#[cfg(test)]` blocks as test code, so a test hollowed out in the file it
//! sits in is seen like one in a `_tests.rs` file, and compares each existing test's assertions before and after. The
//! ratchet (`gates::count_tests`) counts the Rust tests that run, so an `#[ignore]`d test is not one.
//!
//! This is a line-and-bracket reader, not a parser: it knows strings, raw strings, characters and comments well enough
//! to match braces and parentheses, and nothing else.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

use super::is_assert_line;

// ---- reading brackets past strings and comments -----------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Lang {
    Rust,
    /// JavaScript and TypeScript.
    Script,
    Go,
}

fn is_ident(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// The index after the closing `quote` of the string that opens at `start` (a backslash skips the next byte). The end of
/// the text when it never closes.
fn skip_quoted(b: &[u8], start: usize, quote: u8) -> usize {
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            c if c == quote => return i + 1,
            _ => i += 1,
        }
    }
    b.len()
}

/// A Rust `'`: a character (`'x'`, `'\n'`, `'{'`) is skipped whole, a lifetime (`'a`) only its tick.
fn skip_rust_tick(b: &[u8], i: usize) -> usize {
    match b.get(i + 1) {
        Some(b'\\') => {
            // `'\''`, `'\n'`, `'\u{1F600}'`: the escaped byte comes first, so the closing tick is looked for after it.
            let mut j = i + 3;
            while j < b.len() && b[j] != b'\'' {
                j += 1;
            }
            (j + 1).min(b.len())
        }
        Some(c) if *c >= 0x80 => {
            // A character outside ASCII: its tick comes within four bytes.
            let mut j = i + 2;
            while j < b.len() && j < i + 6 && b[j] != b'\'' {
                j += 1;
            }
            if b.get(j) == Some(&b'\'') {
                j + 1
            } else {
                i + 1
            }
        }
        Some(_) if b.get(i + 2) == Some(&b'\'') => i + 3,
        _ => i + 1,
    }
}

/// `r"..."`, `r#"..."#` and `br"..."` open at `i`, and `i` is not the end of a word like `for`.
fn raw_string_start(b: &[u8], i: usize) -> bool {
    if b[i] != b'r' {
        return false;
    }
    if i > 0 && is_ident(b[i - 1]) && !(b[i - 1] == b'b' && (i < 2 || !is_ident(b[i - 2]))) {
        return false;
    }
    let mut j = i + 1;
    while b.get(j) == Some(&b'#') {
        j += 1;
    }
    b.get(j) == Some(&b'"')
}

fn skip_raw_string(b: &[u8], i: usize) -> usize {
    let mut j = i + 1;
    let mut hashes = 0;
    while b.get(j) == Some(&b'#') {
        hashes += 1;
        j += 1;
    }
    j += 1; // the opening quote
    while j < b.len() {
        let end = j + 1 + hashes;
        if b[j] == b'"' && end <= b.len() && b[j + 1..end].iter().all(|c| *c == b'#') {
            return end;
        }
        j += 1;
    }
    b.len()
}

/// The index after a string, character or comment that opens at `i`, or none when `i` is something else.
fn skip_literal(b: &[u8], i: usize, lang: Lang) -> Option<usize> {
    match b[i] {
        b'/' if b.get(i + 1) == Some(&b'/') => {
            let mut j = i;
            while j < b.len() && b[j] != b'\n' {
                j += 1;
            }
            Some(j)
        }
        b'/' if b.get(i + 1) == Some(&b'*') => {
            let (mut nest, mut j) = (1, i + 2);
            while j < b.len() && nest > 0 {
                if lang == Lang::Rust && b[j] == b'/' && b.get(j + 1) == Some(&b'*') {
                    nest += 1;
                    j += 2;
                } else if b[j] == b'*' && b.get(j + 1) == Some(&b'/') {
                    nest -= 1;
                    j += 2;
                } else {
                    j += 1;
                }
            }
            Some(j.min(b.len()))
        }
        b'"' => Some(skip_quoted(b, i, b'"')),
        b'`' if lang != Lang::Rust => Some(skip_quoted(b, i, b'`')),
        b'\'' => Some(match lang {
            Lang::Rust => skip_rust_tick(b, i),
            _ => skip_quoted(b, i, b'\''),
        }),
        b'r' if lang == Lang::Rust && raw_string_start(b, i) => Some(skip_raw_string(b, i)),
        _ => None,
    }
}

/// The index of the bracket that closes the one at `open_at` (`{`, `(` or `[`), past strings and comments.
fn matching_end(text: &str, open_at: usize, lang: Lang) -> Option<usize> {
    let b = text.as_bytes();
    let open = *b.get(open_at)?;
    let close = match open {
        b'{' => b'}',
        b'(' => b')',
        b'[' => b']',
        _ => return None,
    };
    let (mut depth, mut i) = (0usize, open_at);
    while i < b.len() {
        if let Some(next) = skip_literal(b, i, lang) {
            i = next.max(i + 1);
            continue;
        }
        if b[i] == open {
            depth += 1;
        } else if b[i] == close {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// The first `{` or `;` at or after `from` that is not inside a string, a comment, parentheses or brackets: where an
/// item's body opens, or where its declaration ends.
fn first_open_or_semicolon(b: &[u8], from: usize, lang: Lang) -> Option<(usize, u8)> {
    let (mut depth, mut i) = (0usize, from);
    while i < b.len() {
        if let Some(next) = skip_literal(b, i, lang) {
            i = next.max(i + 1);
            continue;
        }
        match b[i] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth = depth.saturating_sub(1),
            b'{' if depth == 0 => return Some((i, b'{')),
            b';' if depth == 0 => return Some((i, b';')),
            _ => {}
        }
        i += 1;
    }
    None
}

// ---- `#[cfg(test)]` ---------------------------------------------------------------------------------------------------

/// One `#[cfg(test)]` item: from its attribute to its closing brace (a block) or its semicolon (a declaration).
struct CfgTest {
    start: usize,
    end: usize,
    block: bool,
}

fn cfg_test_items(text: &str) -> Vec<CfgTest> {
    const ATTR: &str = "#[cfg(test)]";
    let b = text.as_bytes();
    let mut out = Vec::new();
    let (mut offset, mut resume) = (0, 0);
    for line in text.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        if line_start < resume {
            continue;
        }
        let trimmed = line.trim_start();
        if !trimmed.starts_with(ATTR) {
            continue;
        }
        let start = line_start + (line.len() - trimmed.len());
        match first_open_or_semicolon(b, start + ATTR.len(), Lang::Rust) {
            Some((open, b'{')) => {
                // A block that never closes is read to the end of the file.
                let end =
                    matching_end(text, open, Lang::Rust).map_or(text.len(), |close| close + 1);
                out.push(CfgTest {
                    start,
                    end,
                    block: true,
                });
                resume = end;
            }
            Some((semicolon, _)) => {
                out.push(CfgTest {
                    start,
                    end: semicolon + 1,
                    block: false,
                });
                resume = semicolon + 1;
            }
            None => {}
        }
    }
    out
}

/// The text of every `#[cfg(test)]` block in a Rust source file, each from its attribute to its closing brace, joined
/// by newlines. A `#[cfg(test)]` that only declares a module in another file (`mod tests;`, with or without
/// `#[path = "..."]`) holds none: that file is a test file of its own (`declared_test_files`).
pub fn rust_test_blocks(text: &str) -> String {
    cfg_test_items(text)
        .iter()
        .filter(|item| item.block)
        .map(|item| &text[item.start..item.end])
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_ignore_attr(line: &str) -> bool {
    line.starts_with("#[ignore") || (line.starts_with("#[cfg_attr(") && line.contains("ignore"))
}

/// The Rust tests in `text` that run: a `#[test]` or `#[tokio::test]` fn with no `#[ignore]` (with or without a
/// reason) among its attributes, whichever side of `#[test]` it sits.
pub fn count_active_rust_tests(text: &str) -> usize {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let in_run = |line: &str| line.starts_with("#[") || line.starts_with("//") || line.is_empty();
    let (mut count, mut i) = (0, 0);
    while i < lines.len() {
        if !in_run(lines[i]) {
            i += 1;
            continue;
        }
        // An attribute run: attributes, comments and blank lines, up to the item they belong to.
        let (mut test, mut ignored) = (false, false);
        let mut j = i;
        while j < lines.len() && in_run(lines[j]) {
            test |= lines[j].starts_with("#[test]") || lines[j].starts_with("#[tokio::test");
            ignored |= is_ignore_attr(lines[j]);
            j += 1;
        }
        if test && !ignored {
            count += 1;
        }
        i = j;
    }
    count
}

/// `a/b/../c.rs` as `a/c.rs`: separators folded to `/`, `.` dropped and `..` taken out with the folder before it.
fn joined(dir: &str, target: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for segment in dir.split(['/', '\\']).chain(target.split(['/', '\\'])) {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// The files a Rust source declares as its tests with `#[cfg(test)] #[path = "x.rs"] mod name;`, as paths from the
/// project root with `/` separators. `path` is where the declaring file sits.
pub fn declared_test_files(path: &str, text: &str) -> Vec<String> {
    static PATH_ATTR: OnceLock<Regex> = OnceLock::new();
    let attr = PATH_ATTR.get_or_init(|| {
        Regex::new(r#"#\[path\s*=\s*"([^"]+)"\s*\]"#).expect("a valid path attribute pattern")
    });
    let normal = path.replace('\\', "/");
    let dir = normal.rsplit_once('/').map_or("", |(dir, _)| dir);
    cfg_test_items(text)
        .iter()
        .filter(|item| !item.block)
        .filter_map(|item| {
            let target = attr.captures(&text[item.start..item.end])?;
            Some(joined(dir, &target[1]))
        })
        .collect()
}

// ---- tests, and what they assert --------------------------------------------------------------------------------------

/// One test: its name and its assertions, each as one normalized statement.
struct Case {
    name: String,
    statements: Vec<String>,
}

/// How many brackets a line opens more than it closes, past quoted text.
fn bracket_depth(line: &str) -> i32 {
    let chars: Vec<char> = line.chars().collect();
    let (mut depth, mut i) = (0, 0);
    while i < chars.len() {
        match chars[i] {
            '"' | '`' => {
                let quote = chars[i];
                i += 1;
                while i < chars.len() && chars[i] != quote {
                    i += if chars[i] == '\\' { 2 } else { 1 };
                }
            }
            // A tick with no partner on the line is a lifetime, not a quote.
            '\'' if chars[i + 1..].contains(&'\'') => {
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    i += if chars[i] == '\\' { 2 } else { 1 };
                }
            }
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    depth
}

/// The line without a trailing `//` comment.
fn without_comment(line: &str) -> &str {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'/' && b.get(i + 1) == Some(&b'/') {
            return &line[..i];
        }
        match b[i] {
            b'"' | b'`' => i = skip_quoted(b, i, b[i]),
            _ => i += 1,
        }
    }
    line
}

/// An assertion with its whitespace, trailing comma and semicolon taken out, so a reformat is not a change.
fn normalized(statement: &str) -> String {
    static OPENS: OnceLock<Regex> = OnceLock::new();
    static CLOSES: OnceLock<Regex> = OnceLock::new();
    static TRAILING: OnceLock<Regex> = OnceLock::new();
    let opens = OPENS.get_or_init(|| Regex::new(r"([(\[{])\s+").expect("a valid pattern"));
    let closes = CLOSES.get_or_init(|| Regex::new(r"\s+([)\]}])").expect("a valid pattern"));
    let trailing = TRAILING.get_or_init(|| Regex::new(r",\s*([)\]}])").expect("a valid pattern"));
    // Quoted text is what an assertion expects, so it is set aside whole and put back: only the code around it is
    // tidied. A placeholder holds no space or bracket for the tidying to touch.
    let (code, quoted) = set_aside_strings(statement);
    let one_line = code.split_whitespace().collect::<Vec<_>>().join(" ");
    let spaced = opens.replace_all(&one_line, "$1");
    let spaced = closes.replace_all(&spaced, "$1");
    let spaced = trailing.replace_all(&spaced, "$1");
    let mut out = spaced.trim_end_matches(';').trim().to_string();
    for (n, text) in quoted.iter().enumerate() {
        out = out.replace(&format!("\u{1}{n}\u{1}"), text);
    }
    out
}

/// The statement with each string literal replaced by a numbered placeholder, and the literals in order.
fn set_aside_strings(statement: &str) -> (String, Vec<String>) {
    let chars: Vec<char> = statement.chars().collect();
    let (mut code, mut quoted) = (String::new(), Vec::new());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let closes_later = || chars[i + 1..].contains(&c);
        if c == '"' || c == '`' || (c == '\'' && closes_later()) {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != c {
                j += if chars[j] == '\\' { 2 } else { 1 };
            }
            let end = (j + 1).min(chars.len());
            quoted.push(chars[i..end].iter().collect());
            code.push_str(&format!("\u{1}{}\u{1}", quoted.len() - 1));
            i = end;
        } else {
            code.push(c);
            i += 1;
        }
    }
    (code, quoted)
}

/// The assertions in a test's body: each line holding one, with the lines it carries on over (open brackets, or a
/// chained `.call()` on the next line).
fn assertion_statements(body: &str) -> Vec<String> {
    let lines: Vec<&str> = body.lines().map(without_comment).collect();
    let (mut out, mut i) = (Vec::new(), 0);
    while i < lines.len() {
        if !is_assert_line(lines[i]) {
            i += 1;
            continue;
        }
        let mut statement = lines[i].trim().to_string();
        let mut depth = bracket_depth(lines[i]);
        let mut j = i + 1;
        while j < lines.len() && j < i + 12 && (depth > 0 || lines[j].trim_start().starts_with('.'))
        {
            statement.push(' ');
            statement.push_str(lines[j].trim());
            depth += bracket_depth(lines[j]);
            j += 1;
        }
        out.push(normalized(&statement));
        i = j;
    }
    out
}

fn rust_cases(text: &str) -> Vec<Case> {
    static FN_NAME: OnceLock<Regex> = OnceLock::new();
    let fn_name = FN_NAME.get_or_init(|| {
        Regex::new(r"^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)")
            .expect("a valid fn pattern")
    });
    let b = text.as_bytes();
    let (mut out, mut pending) = (Vec::new(), false);
    let (mut offset, mut resume) = (0, 0);
    for line in text.split_inclusive('\n') {
        let start = offset;
        offset += line.len();
        if start < resume {
            continue;
        }
        let trimmed = line.trim();
        if trimmed.starts_with("#[test]") || trimmed.starts_with("#[tokio::test") {
            pending = true;
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with("#[") || trimmed.starts_with("//") {
            continue;
        }
        if !std::mem::take(&mut pending) {
            continue;
        }
        let Some(name) = fn_name.captures(trimmed).map(|caps| caps[1].to_string()) else {
            continue;
        };
        if let Some((open, b'{')) = first_open_or_semicolon(b, start, Lang::Rust) {
            if let Some(close) = matching_end(text, open, Lang::Rust) {
                out.push(Case {
                    name,
                    statements: assertion_statements(&text[open..=close]),
                });
                resume = close + 1;
            }
        }
    }
    out
}

fn script_cases(text: &str) -> Vec<Case> {
    static HEAD: OnceLock<Regex> = OnceLock::new();
    let head = HEAD.get_or_init(|| {
        Regex::new(r#"(?m)^[ \t]*(?:it|test)(?:\.(?:only|concurrent))?\s*\(\s*(["'`])"#)
            .expect("a valid test-head pattern")
    });
    let b = text.as_bytes();
    let mut out = Vec::new();
    for caps in head.captures_iter(text) {
        let Some(whole) = caps.get(0) else {
            continue;
        };
        let quote_at = whole.end() - 1;
        let Some(open) = text[whole.start()..quote_at]
            .find('(')
            .map(|at| whole.start() + at)
        else {
            continue;
        };
        let title_end = skip_quoted(b, quote_at, b[quote_at]);
        let Some(close) = matching_end(text, open, Lang::Script) else {
            continue;
        };
        if title_end > close {
            continue;
        }
        out.push(Case {
            name: text[quote_at + 1..title_end.saturating_sub(1).max(quote_at + 1)].to_string(),
            // After the title, so a title that says "assert" is not an assertion.
            statements: assertion_statements(&text[title_end..=close]),
        });
    }
    out
}

fn python_cases(text: &str) -> Vec<Case> {
    static DEF: OnceLock<Regex> = OnceLock::new();
    let def = DEF.get_or_init(|| {
        Regex::new(r"^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(").expect("a valid def pattern")
    });
    let indent_of = |line: &str| line.chars().take_while(|c| c.is_whitespace()).count();
    let lines: Vec<&str> = text.lines().collect();
    let (mut out, mut i) = (Vec::new(), 0);
    while i < lines.len() {
        let Some(caps) = def.captures(lines[i]) else {
            i += 1;
            continue;
        };
        let indent = caps[1].chars().count();
        let mut j = i + 1;
        while j < lines.len() && (lines[j].trim().is_empty() || indent_of(lines[j]) > indent) {
            j += 1;
        }
        out.push(Case {
            name: caps[2].to_string(),
            statements: assertion_statements(&lines[i + 1..j].join("\n")),
        });
        i = j;
    }
    out
}

fn go_cases(text: &str) -> Vec<Case> {
    static HEAD: OnceLock<Regex> = OnceLock::new();
    let head = HEAD
        .get_or_init(|| Regex::new(r"(?m)^func\s+(Test\w*)\s*\(").expect("a valid func pattern"));
    let b = text.as_bytes();
    let mut out = Vec::new();
    for caps in head.captures_iter(text) {
        let Some(whole) = caps.get(0) else {
            continue;
        };
        if let Some((open, b'{')) = first_open_or_semicolon(b, whole.start(), Lang::Go) {
            if let Some(close) = matching_end(text, open, Lang::Go) {
                out.push(Case {
                    name: caps[1].to_string(),
                    statements: assertion_statements(&text[open..=close]),
                });
            }
        }
    }
    out
}

fn cases_of(path: &str, text: &str) -> Vec<Case> {
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "rs" => rust_cases(text),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => script_cases(text),
        "py" => python_cases(text),
        "go" => go_cases(text),
        _ => Vec::new(),
    }
}

/// What `a` holds that `b` doesn't, counting repeats.
fn left_over(a: &[String], b: &[String]) -> Vec<String> {
    let mut have: HashMap<&str, usize> = HashMap::new();
    for item in b {
        *have.entry(item.as_str()).or_default() += 1;
    }
    let mut out = Vec::new();
    for item in a {
        match have.get_mut(item.as_str()) {
            Some(count) if *count > 0 => *count -= 1,
            _ => out.push(item.clone()),
        }
    }
    out
}

/// The tests that exist in both `before` and `after` and whose assertions changed: some assertion is gone and a
/// different one is there. A new test, a test with more assertions and a reformatted one are not. By file kind
/// (`path`): Rust `#[test]` fns, JS and TS `it(` and `test(` titles, Python `def test_` and Go `func Test`.
pub fn changed_assertions(path: &str, before: &str, after: &str) -> Vec<String> {
    let (was, now) = (cases_of(path, before), cases_of(path, after));
    let mut paired: HashMap<&str, usize> = HashMap::new();
    let mut out = Vec::new();
    for case in &was {
        // The same name twice is paired in order.
        let nth = paired.entry(case.name.as_str()).or_default();
        let twin = now.iter().filter(|other| other.name == case.name).nth(*nth);
        *nth += 1;
        let Some(twin) = twin else {
            continue;
        };
        if !left_over(&case.statements, &twin.statements).is_empty()
            && !left_over(&twin.statements, &case.statements).is_empty()
        {
            out.push(case.name.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- #[cfg(test)] blocks ----------------------------------------------------------------------------------------

    #[test]
    fn an_inline_test_block_is_test_code_and_the_rest_of_the_file_is_not() {
        let src = "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn adds() {\n        assert_eq!(add(1, 2), 3);\n    }\n}\n\npub fn later() {}\n";
        let blocks = rust_test_blocks(src);
        assert!(blocks.contains("#[cfg(test)]"), "{blocks}");
        assert!(blocks.contains("assert_eq!(add(1, 2), 3);"), "{blocks}");
        assert!(!blocks.contains("pub fn add"), "{blocks}");
        assert!(!blocks.contains("pub fn later"), "{blocks}");
    }

    #[test]
    fn a_file_with_no_test_block_or_only_a_declaration_has_none() {
        assert_eq!(rust_test_blocks("pub fn a() {}\n"), "");
        assert_eq!(rust_test_blocks(""), "");
        let declared = "pub fn a() {}\n\n#[cfg(test)]\n#[path = \"a_tests.rs\"]\nmod tests;\n";
        assert_eq!(rust_test_blocks(declared), "");
        assert_eq!(rust_test_blocks("#[cfg(test)]\nmod tests;\n"), "");
        assert_eq!(rust_test_blocks("#[cfg(test)]\nuse std::fmt;\n"), "");
    }

    #[test]
    fn braces_in_strings_chars_comments_and_raw_strings_do_not_end_a_block() {
        let src = r##"fn real() {}

#[cfg(test)]
mod tests {
    #[test]
    fn braces() {
        let open = '{';
        let quote = '"';
        let text = "} not the end {";
        let raw = r#"}}} "still" in the string {{{"#;
        // a comment with a } in it
        /* and a { block comment } */
        assert_eq!(text.len(), 15);
    }
}

fn after_the_block() {}
"##;
        let blocks = rust_test_blocks(src);
        assert!(blocks.contains("assert_eq!(text.len(), 15);"), "{blocks}");
        assert!(!blocks.contains("fn real"), "{blocks}");
        assert!(!blocks.contains("after_the_block"), "{blocks}");
    }

    #[test]
    fn lifetimes_are_not_taken_for_characters() {
        let src = "#[cfg(test)]\nmod tests {\n    fn pick<'a>(x: &'a str) -> &'a str { x }\n    #[test]\n    fn t() { assert_eq!(pick(\"a\"), \"a\"); }\n}\nfn outside() {}\n";
        let blocks = rust_test_blocks(src);
        assert!(
            blocks.contains("assert_eq!(pick(\"a\"), \"a\");"),
            "{blocks}"
        );
        assert!(!blocks.contains("fn outside"), "{blocks}");
    }

    #[test]
    fn two_blocks_and_a_block_on_one_line_are_both_read() {
        let src = "fn a() {}\n#[cfg(test)] mod one { #[test] fn x() { assert!(true); } }\nfn b() {}\n#[cfg(test)]\nfn helper() { assert!(false); }\nfn c() {}\n";
        let blocks = rust_test_blocks(src);
        assert!(blocks.contains("mod one"), "{blocks}");
        assert!(blocks.contains("fn helper"), "{blocks}");
        assert!(!blocks.contains("fn a()"), "{blocks}");
        assert!(!blocks.contains("fn b()"), "{blocks}");
        assert!(!blocks.contains("fn c()"), "{blocks}");
    }

    #[test]
    fn a_block_that_never_closes_takes_the_rest_of_the_file() {
        let blocks = rust_test_blocks("fn a() {}\n#[cfg(test)]\nmod tests {\n    fn x() {\n");
        assert!(blocks.contains("fn x()"), "{blocks}");
        assert!(!blocks.contains("fn a()"), "{blocks}");
    }

    #[test]
    fn crlf_and_unicode_are_read_as_text() {
        let src = "fn é() {}\r\n#[cfg(test)]\r\nmod tests {\r\n    #[test]\r\n    fn ünï() { assert_eq!(1, 1); }\r\n}\r\nfn tail() {}\r\n";
        let blocks = rust_test_blocks(src);
        assert!(blocks.contains("fn ünï()"), "{blocks}");
        assert!(!blocks.contains("fn tail"), "{blocks}");
    }

    // ---- tests that run ---------------------------------------------------------------------------------------------

    #[test]
    fn an_ignored_test_is_not_a_test_that_runs() {
        let src = "#[test]\nfn one() {}\n\n#[test]\n#[ignore]\nfn two() {}\n\n#[test]\n#[ignore = \"slow\"]\nfn three() {}\n\n#[ignore]\n#[test]\nfn four() {}\n\n#[tokio::test]\nasync fn five() {}\n\n#[tokio::test(flavor = \"multi_thread\")]\n#[ignore = \"needs the network\"]\nasync fn six() {}\n";
        assert_eq!(count_active_rust_tests(src), 2);
    }

    #[test]
    fn counting_tests_keeps_its_old_answers() {
        assert_eq!(
            count_active_rust_tests("#[test]\nfn a() {}\n    #[tokio::test]\n"),
            2
        );
        assert_eq!(count_active_rust_tests(""), 0);
        assert_eq!(count_active_rust_tests("fn a() {}\n"), 0);
        // Indented tests inside a module, with a doc comment and another attribute between.
        let nested = "mod tests {\n    /// does a thing\n    #[test]\n    #[should_panic]\n    fn a() {}\n\n    #[test]\n    fn b() {}\n}\n";
        assert_eq!(count_active_rust_tests(nested), 2);
        // A commented-out test is not one, and neither is an ignored one that a comment sits above.
        assert_eq!(count_active_rust_tests("// #[test]\nfn a() {}\n"), 0);
        assert_eq!(
            count_active_rust_tests("#[test]\n// slow, run by hand\n#[ignore]\nfn a() {}\n"),
            0
        );
        assert_eq!(
            count_active_rust_tests("#[test]\n#[cfg_attr(windows, ignore)]\nfn a() {}\n"),
            0
        );
    }

    // ---- files that are tests by declaration ------------------------------------------------------------------------

    #[test]
    fn a_declared_test_file_is_found_from_its_path_attribute() {
        let src = "#[cfg(test)]\n#[path = \"gates_tests.rs\"]\nmod tests;\n\n#[cfg(test)]\n#[path = \"../shared/helpers.rs\"]\nmod helpers;\n\n#[path = \"not_test.rs\"]\nmod not_test;\n";
        assert_eq!(
            declared_test_files("src-tauri/src/firstmate/gates.rs", src),
            vec![
                "src-tauri/src/firstmate/gates_tests.rs".to_string(),
                "src-tauri/src/shared/helpers.rs".to_string(),
            ]
        );
        assert_eq!(
            declared_test_files("lib.rs", "#[cfg(test)]\n#[path = \"t.rs\"]\nmod t;\n"),
            vec!["t.rs".to_string()]
        );
        assert!(declared_test_files("a.rs", "#[cfg(test)]\nmod tests;\n").is_empty());
        assert!(declared_test_files("a.rs", "").is_empty());
        // Windows separators are folded to `/`.
        assert_eq!(
            declared_test_files(
                "src\\a.rs",
                "#[cfg(test)]\n#[path = \"a_tests.rs\"]\nmod t;\n"
            ),
            vec!["src/a_tests.rs".to_string()]
        );
    }

    // ---- tests whose assertions changed -----------------------------------------------------------------------------

    #[test]
    fn a_changed_expected_value_in_a_rust_test_is_found_by_the_tests_name() {
        let before = "#[test]\nfn adds() {\n    assert_eq!(add(1, 2), 3);\n}\n\n#[test]\nfn subtracts() {\n    assert_eq!(sub(3, 2), 1);\n}\n";
        let after = "#[test]\nfn adds() {\n    assert_eq!(add(1, 2), 4);\n}\n\n#[test]\nfn subtracts() {\n    assert_eq!(sub(3, 2), 1);\n}\n";
        assert_eq!(
            changed_assertions("src/math.rs", before, after),
            vec!["adds".to_string()]
        );
        assert!(changed_assertions("src/math.rs", before, before).is_empty());
    }

    #[test]
    fn a_new_test_more_assertions_or_a_reformat_are_not_a_change() {
        let before = "#[test]\nfn adds() {\n    assert_eq!(add(1, 2), 3);\n}\n";
        // A new test beside it.
        let new_test =
            format!("{before}\n#[test]\nfn fresh() {{\n    assert_eq!(add(2, 2), 4);\n}}\n");
        assert!(changed_assertions("a.rs", before, &new_test).is_empty());
        // More assertions in the same test.
        let more = "#[test]\nfn adds() {\n    assert_eq!(add(1, 2), 3);\n    assert_eq!(add(2, 2), 4);\n}\n";
        assert!(changed_assertions("a.rs", before, more).is_empty());
        // The same assertion broken over lines, with a trailing comma, and a comment edit.
        let reformatted = "#[test]\nfn adds() {\n    // sums two numbers\n    assert_eq!(\n        add(1, 2),\n        3,\n    );\n}\n";
        assert!(changed_assertions("a.rs", before, reformatted).is_empty());
        // Setup changed, assertions not.
        let setup = "#[test]\nfn adds() {\n    let x = 1;\n    assert_eq!(add(1, 2), 3);\n}\n";
        assert!(changed_assertions("a.rs", before, setup).is_empty());
        // An assertion only removed is the count rule's finding, not this one.
        let fewer = "#[test]\nfn adds() {\n}\n";
        assert!(changed_assertions("a.rs", before, fewer).is_empty());
    }

    #[test]
    fn a_multi_line_assertion_with_a_changed_value_is_found() {
        let before = "#[test]\nfn builds() {\n    assert_eq!(\n        build(1),\n        Thing { a: 1 }\n    );\n}\n";
        let after = "#[test]\nfn builds() {\n    assert_eq!(\n        build(1),\n        Thing { a: 2 }\n    );\n}\n";
        assert_eq!(
            changed_assertions("a.rs", before, after),
            vec!["builds".to_string()]
        );
    }

    #[test]
    fn a_weaker_assertion_for_the_same_check_is_a_change() {
        let before = "#[test]\nfn finds() {\n    assert_eq!(find(\"a\"), Some(1));\n}\n";
        let after = "#[test]\nfn finds() {\n    assert!(find(\"a\").is_some());\n}\n";
        assert_eq!(
            changed_assertions("a.rs", before, after),
            vec!["finds".to_string()]
        );
    }

    #[test]
    fn a_tests_name_with_assert_in_it_is_not_an_assertion() {
        let before = "#[test]\nfn asserts_the_sum() {\n    let x = 1;\n}\n";
        let after = "#[test]\nfn asserts_the_sum() {\n    let x = 2;\n}\n";
        assert!(changed_assertions("a.rs", before, after).is_empty());
    }

    #[test]
    fn braces_in_a_tests_strings_do_not_cut_its_body_short() {
        let before =
            "#[test]\nfn text() {\n    let s = \"}\";\n    assert_eq!(render(s), \"{}\");\n}\n";
        let after =
            "#[test]\nfn text() {\n    let s = \"}\";\n    assert_eq!(render(s), \"{ }\");\n}\n";
        assert_eq!(
            changed_assertions("a.rs", before, after),
            vec!["text".to_string()]
        );
    }

    #[test]
    fn spaces_inside_an_expected_string_are_part_of_what_it_checks() {
        let before = "#[test]\nfn pads() {\n    assert_eq!(pad(\"a\"), \"a  b\");\n}\n";
        let after = "#[test]\nfn pads() {\n    assert_eq!(pad(\"a\"), \"a b\");\n}\n";
        assert_eq!(
            changed_assertions("a.rs", before, after),
            vec!["pads".to_string()]
        );
        // The same string with the code around it respaced is not a change.
        let respaced = "#[test]\nfn pads() {\n    assert_eq!( pad( \"a\" ),   \"a  b\" );\n}\n";
        assert!(changed_assertions("a.rs", before, respaced).is_empty());
    }

    #[test]
    fn typescript_tests_are_found_by_their_titles() {
        let before = "describe(\"sum\", () => {\n  it(\"adds\", () => {\n    expect(add(1, 2)).toBe(3);\n  });\n\n  test(\"subtracts\", () => {\n    expect(sub(3, 2)).toBe(1);\n  });\n});\n";
        let after = "describe(\"sum\", () => {\n  it(\"adds\", () => {\n    expect(add(1, 2)).toBe(4);\n  });\n\n  test(\"subtracts\", () => {\n    expect(sub(3, 2)).toBe(1);\n  });\n});\n";
        assert_eq!(
            changed_assertions("src/sum.test.ts", before, after),
            vec!["adds".to_string()]
        );
        // One line, a title that says "assert", a chained call over two lines.
        let before = "it('asserts the sum', () => expect(add(1, 2)).toBe(3));\nit(\"chains\", () => {\n  expect(add(1, 2))\n    .toBe(3);\n});\n";
        let after = "it('asserts the sum', () => expect(add(1, 2)).toBe(3));\nit(\"chains\", () => {\n  expect(add(1, 2))\n    .toBe(5);\n});\n";
        assert_eq!(
            changed_assertions("a.spec.tsx", before, after),
            vec!["chains".to_string()]
        );
        // A renamed assertion helper in the same test, and `it.skip`, are not read as a change in another test.
        let skipped = "it.skip(\"later\", () => { expect(1).toBe(1); });\n";
        assert!(changed_assertions(
            "a.test.js",
            skipped,
            "it.skip(\"later\", () => { expect(1).toBe(2); });\n"
        )
        .is_empty());
    }

    #[test]
    fn python_and_go_tests_are_found_by_their_names() {
        let before = "def test_sum():\n    assert add(1, 2) == 3\n\n\ndef test_other():\n    assert add(2, 2) == 4\n";
        let after = "def test_sum():\n    assert add(1, 2) == 4\n\n\ndef test_other():\n    assert add(2, 2) == 4\n";
        assert_eq!(
            changed_assertions("tests/test_sum.py", before, after),
            vec!["test_sum".to_string()]
        );
        let before = "func TestSum(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Errorf(\"want 3\")\n\t}\n}\n";
        let after = "func TestSum(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Errorf(\"want 4\")\n\t}\n}\n";
        assert_eq!(
            changed_assertions("sum_test.go", before, after),
            vec!["TestSum".to_string()]
        );
    }

    #[test]
    fn the_same_title_twice_is_paired_in_order_and_other_files_are_not_read() {
        let before =
            "it(\"x\", () => { expect(1).toBe(1); });\nit(\"x\", () => { expect(2).toBe(2); });\n";
        let after =
            "it(\"x\", () => { expect(1).toBe(1); });\nit(\"x\", () => { expect(2).toBe(3); });\n";
        assert_eq!(
            changed_assertions("a.test.ts", before, after),
            vec!["x".to_string()]
        );
        assert!(changed_assertions("README.md", before, after).is_empty());
        assert!(changed_assertions("a.test.ts", "", "").is_empty());
    }
}
