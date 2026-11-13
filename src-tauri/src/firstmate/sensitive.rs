//! PT-5: always-gated sensitive paths.
//!
//! A task whose changed files touch keys, permissions, the sandbox, billing, migrations, CI or installers gets the full checks
//! (the project's checks, the ratchet, the brief's own lines, the proof tools) and the running second checker at once, in every
//! testing mode but "No testing", even in "Test at ship" (`testing_mode::gates_for_with`, the `sensitive` flag beside `risky`).
//!
//! The list is the union of three, none of them trusted blindly:
//! - the built-in patterns, one JSON file the webview reads too (`src/features/delivery/model/sensitivePaths.json`), so the Settings
//!   line and this gate cannot disagree;
//! - the project's own protected paths (`delivery::settings`, "Also protect these paths"), read as the floor reads them: a plain
//!   path, anywhere in the tree;
//! - `docs/hivra/sensitive-paths.json` in the project's MAIN checkout (a JSON list of glob strings), when it has one. It is read
//!   from the main checkout, never from the task's own copy, so a task cannot loosen the list it is judged by; changing the file
//!   is itself sensitive.
//!
//! The glob rules (`sensitive_hit`), the same on every system:
//! - paths are compared the way the floor compares names: `\` is `/`, Unicode NFKC, lower case. `.` and empty parts go; `..` steps up;
//! - a path that steps above the project, or is absolute (`/x`, `C:\x`), is not a path inside the project and never matches;
//! - `**` as a whole part matches any number of folders, `*` any run of characters inside one part, `?` one character;
//! - a pattern with a `/` in it starts at the project root; one without (`.env*`) matches a name at any depth;
//! - a pattern that matches a folder matches everything under it;
//! - a pattern made only of wildcards (`*`, `**`, `?`), or with a `..` part, or with a control character, matches nothing, so the
//!   commonest typo cannot make every file sensitive. (A pattern with a literal in it, `*.*`, is taken at its word.)
//! - a name git printed in quotes (one with a `"` or a backslash in it) is read as the name it quotes;
//! - only a plain `..` is a parent step; a look-alike (`．．`, `.. `) is a folder name like any other.

use std::path::Path;
use std::sync::OnceLock;

use unicode_normalization::UnicodeNormalization;

/// The built-in patterns, grouped for the Settings screen. Read here as one flat list.
const BUILT_IN_JSON: &str =
    include_str!("../../../src/features/delivery/model/sensitivePaths.json");

/// The project's own list, relative to its main checkout.
pub const PROJECT_LIST: &str = "docs/hivra/sensitive-paths.json";
/// The most of the project's list read. A bigger file is not a list of globs.
const LIST_MAX_BYTES: u64 = 64 * 1024;
/// The most patterns taken from the project's list, and the longest one.
const PATTERNS_MAX: usize = 200;
const PATTERN_MAX_LEN: usize = 200;

#[derive(serde::Deserialize)]
struct BuiltIn {
    version: u32,
    groups: Vec<BuiltInGroup>,
}

#[derive(serde::Deserialize)]
struct BuiltInGroup {
    patterns: Vec<String>,
}

fn parse_built_in(json: &str) -> Vec<String> {
    match serde_json::from_str::<BuiltIn>(json) {
        Ok(list) if list.version == 1 => list
            .groups
            .into_iter()
            .flat_map(|group| group.patterns)
            .collect(),
        // A shared file that does not parse is a build-time mistake: the test below catches it.
        _ => Vec::new(),
    }
}

/// The built-in patterns, in the file's order.
pub fn built_in_patterns() -> Vec<String> {
    static LIST: OnceLock<Vec<String>> = OnceLock::new();
    LIST.get_or_init(|| parse_built_in(BUILT_IN_JSON)).clone()
}

/// A project's protected paths ("Also protect these paths") as patterns. The floor reads those as plain paths: a name, or a run of
/// folders, anywhere in the tree, a folder meaning everything under it. One that has a `*`, `?`, `[`, a `..` or a leading slash or
/// drive letter matches nothing there, and matches nothing here.
pub fn extra_patterns(protected_extra: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in protected_extra {
        let text = raw.trim().replace('\\', "/");
        let text = text.trim_end_matches('/');
        if text.is_empty() || text.contains(['*', '?', '[']) {
            continue;
        }
        let Some(parts) = path_segments(text) else {
            continue;
        };
        // `path_segments` resolved `..`: a path that needed it was not a plain path.
        if text.split('/').any(|part| part.trim() == "..") || parts.is_empty() {
            continue;
        }
        let glob = format!("**/{text}");
        if !out.contains(&glob) {
            out.push(glob);
        }
    }
    out
}

fn plain_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
}

/// The globs in a project's list file. Untrusted: anything that is not a JSON array of strings is no list, an entry that is not a
/// usable glob is skipped, and there is a cap on how many are taken.
pub fn parse_list(text: &str) -> Vec<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Ok(serde_json::Value::Array(values)) = serde_json::from_str::<serde_json::Value>(text)
    else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let Some(text) = value.as_str() else {
            continue;
        };
        let text = text.trim();
        if text.is_empty()
            || text.chars().count() > PATTERN_MAX_LEN
            || text.chars().any(char::is_control)
            || out.iter().any(|have| have == text)
        {
            continue;
        }
        out.push(text.to_string());
        if out.len() >= PATTERNS_MAX {
            break;
        }
    }
    out
}

/// The patterns in `<project>/docs/hivra/sensitive-paths.json`. Absent, a link, not a file, too big, not valid UTF-8 text of a JSON
/// list: none.
pub fn project_list_patterns(project: &Path) -> Vec<String> {
    let path = project
        .join("docs")
        .join("hivra")
        .join("sensitive-paths.json");
    if !plain_file(&path) {
        return Vec::new();
    }
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() <= LIST_MAX_BYTES => {}
        _ => return Vec::new(),
    }
    match std::fs::read(&path) {
        Ok(bytes) => parse_list(&String::from_utf8_lossy(&bytes)),
        Err(_) => Vec::new(),
    }
}

/// Every pattern a project's tasks are judged by: the built-in ones, the project's protected paths, the project's list file (when
/// `project` is given), and the list file itself, so loosening the list is a change that is checked.
pub fn patterns_for(project: Option<&Path>, protected_extra: &[String]) -> Vec<String> {
    let mut out = built_in_patterns();
    out.push(PROJECT_LIST.to_string());
    out.extend(extra_patterns(protected_extra));
    if let Some(project) = project {
        out.extend(project_list_patterns(project));
    }
    let mut seen: Vec<String> = Vec::new();
    out.retain(|pattern| {
        if seen.contains(pattern) {
            false
        } else {
            seen.push(pattern.clone());
            true
        }
    });
    out
}

/// Whether a task's changed files touch a sensitive path. The cheap lists first; the project's list file is read, from its main
/// checkout, only when they found nothing. A copy that is not a linked checkout reads the list from itself.
pub fn touches_sensitive_path(
    changed: &[String],
    checkout: &Path,
    protected_extra: &[String],
) -> bool {
    if !sensitive_hit(changed, &patterns_for(None, protected_extra)).is_empty() {
        return true;
    }
    let main =
        crate::project_file::main_checkout(checkout).unwrap_or_else(|_| checkout.to_path_buf());
    !sensitive_hit(changed, &project_list_patterns(&main)).is_empty()
}

// ---- the matcher -----------------------------------------------------------------------------------------------------------

/// One name, compared the way the floor compares them: NFKC, lower case, the long s, and no trailing dots or spaces (Windows drops
/// them). A name that is nothing but dots and spaces is kept as it is.
fn fold_name(name: &str) -> String {
    let nfkc: String = name.nfkc().collect();
    let lower = nfkc.to_lowercase().replace('\u{17f}', "s");
    let trimmed = lower.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        lower
    } else {
        trimmed.to_string()
    }
}

/// A name git printed in quotes (it quotes one with a `"`, a backslash or a control character in it): the C-style escapes undone, the
/// quotes gone. A string that is not wrapped in quotes is returned as it is.
fn unquote_git(raw: &str) -> std::borrow::Cow<'_, str> {
    let Some(inner) = raw
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    else {
        return std::borrow::Cow::Borrowed(raw);
    };
    let mut bytes: Vec<u8> = Vec::with_capacity(inner.len());
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            let mut buf = [0u8; 4];
            bytes.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            continue;
        }
        match chars.next() {
            Some('t') => bytes.push(b'\t'),
            Some('n') => bytes.push(b'\n'),
            Some('r') => bytes.push(b'\r'),
            Some('a') => bytes.push(7),
            Some('b') => bytes.push(8),
            Some('f') => bytes.push(12),
            Some('v') => bytes.push(11),
            Some(digit @ '0'..='7') => {
                // `\303\251`: one to three octal digits, one byte.
                let mut value = digit.to_digit(8).unwrap_or(0);
                for _ in 0..2 {
                    match chars.peek().and_then(|d| d.to_digit(8)) {
                        Some(next) => {
                            value = value * 8 + next;
                            chars.next();
                        }
                        None => break,
                    }
                }
                bytes.push((value & 0xff) as u8);
            }
            // `\"` and `\\`, and any other escaped character, is that character.
            Some(other) => {
                let mut buf = [0u8; 4];
                bytes.extend_from_slice(other.encode_utf8(&mut buf).as_bytes());
            }
            None => bytes.push(b'\\'),
        }
    }
    std::borrow::Cow::Owned(String::from_utf8_lossy(&bytes).into_owned())
}

/// Whether `text` (slashes only) starts with a drive letter and a colon that is then a separator or the end: `C:/x`, `C:`. A folder
/// named `a:secret` is a relative name, not a drive.
fn is_drive_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes.len() == 2 || bytes[2] == b'/')
}

/// A repo path as folded names, `..` resolved. `None` when it is not a path inside the project: absolute, a drive path, with a NUL, or
/// stepping above the project. Nothing left is not a path either. Only a plain `..` is a parent step: git never reports one, and a
/// look-alike (`．．`, `.. `) is a real folder name, so it stays a name and the folders around it still count.
fn path_segments(raw: &str) -> Option<Vec<String>> {
    if raw.contains('\0') {
        return None;
    }
    let unquoted = unquote_git(raw);
    let slashed = unquoted.replace('\\', "/");
    if slashed.starts_with('/') || is_drive_path(&slashed) {
        return None;
    }
    let mut out: Vec<String> = Vec::new();
    for part in slashed.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                out.pop()?;
                continue;
            }
            _ => {}
        }
        out.push(fold_name(part));
    }
    (!out.is_empty()).then_some(out)
}

enum Part {
    /// A whole `**`: any number of folders, none included.
    Any,
    Glob(Vec<char>),
}

fn compile(pattern: &str) -> Option<Vec<Part>> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return None;
    }
    let slashed = trimmed.replace('\\', "/");
    // A slash anywhere but the end starts the pattern at the project root.
    let anchored = slashed.trim_end_matches('/').contains('/');
    let mut parts: Vec<Part> = Vec::new();
    let mut literal = false;
    for raw in slashed.split('/') {
        let nfkc: String = raw.nfkc().collect();
        let bare = nfkc.trim_end_matches(' ');
        match bare {
            "" | "." => continue,
            ".." => return None,
            "**" => {
                if !matches!(parts.last(), Some(Part::Any)) {
                    parts.push(Part::Any);
                }
            }
            _ => {
                let folded = fold_name(raw);
                literal |= folded.chars().any(|c| c != '*' && c != '?');
                parts.push(Part::Glob(folded.chars().collect()));
            }
        }
    }
    if !literal {
        return None;
    }
    if !anchored && !matches!(parts.first(), Some(Part::Any)) {
        parts.insert(0, Part::Any);
    }
    Some(parts)
}

/// `*` and `?` inside one name.
fn glob_name(pattern: &[char], name: &[char]) -> bool {
    let (mut p, mut s) = (0, 0);
    let mut star: Option<usize> = None;
    let mut mark = 0;
    while s < name.len() {
        // A `*` in the pattern is always the wildcard, even where the name has a literal `*`.
        if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            mark = s;
            p += 1;
        } else if p < pattern.len() && (pattern[p] == '?' || pattern[p] == name[s]) {
            p += 1;
            s += 1;
        } else if let Some(at) = star {
            p = at + 1;
            mark += 1;
            s = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

/// Whether the pattern matches the path or a folder it sits in: the whole pattern must match a leading run of at least one name.
fn matches_path(parts: &[Part], path: &[String]) -> bool {
    fn go(
        parts: &[Part],
        path: &[Vec<char>],
        i: usize,
        j: usize,
        memo: &mut Vec<Vec<Option<bool>>>,
    ) -> bool {
        if i == parts.len() {
            return j >= 1;
        }
        if let Some(known) = memo[i][j] {
            return known;
        }
        let found = match &parts[i] {
            Part::Any => {
                go(parts, path, i + 1, j, memo)
                    || (j < path.len() && go(parts, path, i, j + 1, memo))
            }
            Part::Glob(glob) => {
                j < path.len() && glob_name(glob, &path[j]) && go(parts, path, i + 1, j + 1, memo)
            }
        };
        memo[i][j] = Some(found);
        found
    }
    let chars: Vec<Vec<char>> = path.iter().map(|name| name.chars().collect()).collect();
    let mut memo = vec![vec![None; chars.len() + 1]; parts.len() + 1];
    go(parts, &chars, 0, 0, &mut memo)
}

/// The changed paths that match a sensitive pattern, as they were given and each once, in order. Pure. See the module docs for the glob rules.
pub fn sensitive_hit(changed: &[String], patterns: &[String]) -> Vec<String> {
    let compiled: Vec<Vec<Part>> = patterns.iter().filter_map(|p| compile(p)).collect();
    if compiled.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<String> = Vec::new();
    for path in changed {
        let Some(names) = path_segments(path) else {
            continue;
        };
        if compiled.iter().any(|parts| matches_path(parts, &names)) && !hits.contains(path) {
            hits.push(path.clone());
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_debt::testing::Temp;

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn hit(path: &str) -> bool {
        !sensitive_hit(&list(&[path]), &built_in_patterns()).is_empty()
    }

    fn hit_with(path: &str, patterns: &[&str]) -> bool {
        !sensitive_hit(&list(&[path]), &list(patterns)).is_empty()
    }

    // ---- the built-in list ------------------------------------------------------------------------------------------------

    #[test]
    fn the_built_in_list_is_the_seven_groups_the_settings_line_names() {
        assert_eq!(
            built_in_patterns(),
            list(&[
                "**/*secret*",
                "**/*.pem",
                "**/*.key",
                ".env*",
                "**/auth/**",
                "**/permissions/**",
                "**/*permission*",
                "**/sandbox/**",
                "**/*sandbox*",
                "**/billing/**",
                "**/credits/**",
                "**/*payment*",
                "**/migrations/**",
                "**/*.sql",
                ".github/**",
                "**/release*",
                "**/*.release.*",
                "**/install*",
                "**/updater/**",
                "**/*updater*",
            ])
        );
        // A file that does not parse is no list, never a panic.
        assert!(parse_built_in("not json").is_empty());
        assert!(parse_built_in(r#"{"version":2,"groups":[]}"#).is_empty());
    }

    #[test]
    fn keys_and_secrets_are_sensitive_at_any_depth() {
        for path in [
            ".env",
            ".env.local",
            "config/.env.production",
            "src/my_secret_store.ts",
            "secrets/readme.md",
            "deploy/server.pem",
            "id.key",
            "a/b/c/tls.KEY",
        ] {
            assert!(hit(path), "{path}");
        }
        for path in [
            "environment.ts",
            "src/env.ts",
            "src/monkey.ts",
            "keys/readme.md",
            "src/app.ts",
        ] {
            assert!(!hit(path), "{path}");
        }
    }

    #[test]
    fn auth_permissions_and_the_sandbox_are_sensitive() {
        for path in [
            "src/features/auth/login.ts",
            "auth/index.ts",
            "src-tauri/src/permissions/mod.rs",
            "src/permissions.ts",
            "src/model/tool-permission.ts",
            "src-tauri/src/sandbox/profile.rs",
            "src/sandbox.ts",
            "crates/x/src/my_sandbox_rules.rs",
        ] {
            assert!(hit(path), "{path}");
        }
        for path in [
            "src/author/x.ts",
            "src/oauth/x.ts",
            "src/authentic.ts",
            "src/box/x.ts",
        ] {
            assert!(!hit(path), "{path}");
        }
    }

    #[test]
    fn billing_migrations_ci_and_installers_are_sensitive() {
        for path in [
            "src/billing/plan.ts",
            "server/credits/ledger.rs",
            "src/payment.ts",
            "db/migrations/001_init.sql",
            "schema.sql",
            ".github/workflows/ci.yml",
            "scripts/release.sh",
            "release-notes.md",
            "build/app.release.json",
            "scripts/install.sh",
            "src/installer/main.rs",
            "src-tauri/src/updater/mod.rs",
            "src/autoupdater.ts",
        ] {
            assert!(hit(path), "{path}");
        }
        for path in [
            "src/sql.ts",
            "src/prerelease.ts",
            "src/reinstall.ts",
            "src/.github/x.yml",
            "src/features/tally/model/sum.ts",
            "README.md",
        ] {
            assert!(!hit(path), "{path}");
        }
    }

    // ---- the rules ---------------------------------------------------------------------------------------------------------

    #[test]
    fn case_and_width_do_not_matter_on_either_side() {
        assert!(hit("SRC/Auth/Login.TS"));
        assert!(hit("Deploy/KEYS/Server.PEM"));
        assert!(hit_with("src/auth/x.ts", &["**/AUTH/**"]));
        // NFKC: a fullwidth letter is the letter.
        assert!(hit("src/\u{ff41}uth/x.ts"));
    }

    #[test]
    fn windows_separators_read_as_slashes() {
        assert!(hit("src\\auth\\login.ts"));
        assert!(hit(".github\\workflows\\ci.yml"));
        assert!(hit_with("src/billing/x.ts", &["src\\billing\\**"]));
        assert!(!hit("src\\features\\tally\\sum.ts"));
    }

    #[test]
    fn a_dot_dot_path_never_matches_outside_the_project() {
        // Steps up out of the project: not a path in it, so never a match, however the pattern is written.
        for path in [
            "../auth/x.ts",
            "src/../../auth/x.ts",
            "../.github/workflows/ci.yml",
            "a/../../b/billing/x.ts",
            "..\\auth\\x.ts",
        ] {
            assert!(!hit(path), "{path}");
            assert!(
                !hit_with(path, &["**", "**/auth/**", "auth/**", "*"]),
                "{path}"
            );
        }
        // Stays inside: judged by where it lands.
        assert!(hit("src/../.github/workflows/ci.yml"));
        assert!(hit("src/a/../auth/x.ts"));
        assert!(!hit("src/auth/../ok.ts"));
        assert!(hit("./src/auth/./x.ts"));
        assert!(hit("src//auth//x.ts"));
    }

    #[test]
    fn an_absolute_or_drive_path_is_not_a_project_path() {
        assert!(!hit("/etc/auth/x.conf"));
        assert!(!hit("C:\\auth\\x.ts"));
        assert!(!hit("c:/billing/x.ts"));
        assert!(!hit("\\\\server\\share\\auth\\x.ts"));
        assert!(!hit("src/auth/x\0.ts"));
        // A folder whose name has a colon after one letter is a relative name, not a drive.
        assert!(hit("a:secret/x.ts"));
        assert!(
            !hit("c:billing/x.ts"),
            "the folder is `c:billing`, not `billing`"
        );
        assert!(!hit("c:/x/billing/y.ts"), "a drive path");
        assert!(!hit("pkg/a:auth/x.ts"));
        assert!(hit("pkg/a:/auth/x.ts"));
    }

    #[test]
    fn a_look_alike_of_dot_dot_is_a_folder_name_not_a_parent_step() {
        // A real parent step would take `auth` away and let these through; a folder named like one does not.
        for path in [
            "src/auth/\u{ff0e}\u{ff0e}/x.ts",
            "src/auth/.. /x.ts",
            "src/auth/\u{ff0e}\u{ff0e} /x.ts",
            "\u{ff0e}\u{ff0e}/auth/x.ts",
        ] {
            assert!(hit(path), "{path}");
        }
        // ...and a plain one still is.
        assert!(!hit("src/auth/../ok.ts"));
    }

    #[test]
    fn a_name_git_printed_in_quotes_is_read_as_the_name_it_quotes() {
        for quoted in [
            // a quote in the name
            "\"my\\\"secret.pem\"",
            // a backslash in the name
            "\"keys\\\\id.pem\"",
            // two octal bytes for \u{e9}, then a folder
            "\"caf\\303\\251/auth/x.ts\"",
            // a tab and a newline
            "\"a\\tb/auth/c\\nd.ts\"",
        ] {
            assert!(hit(quoted), "{quoted}");
        }
        assert!(!hit("\"plain/ok.ts\""));
        assert!(!hit("\"caf\\303\\251/ok.ts\""));
        // Not wrapped in quotes: as it is. A lone quote stays a character of the name (`"auth` is not `auth`).
        assert!(!hit("\"auth/x.ts"));
        assert!(hit("\"auth/auth/x.ts"));
        assert!(!hit("\""));
        assert!(!hit("\"\""));
        assert_eq!(unquote_git("\"a\\\"b\"").as_ref(), "a\"b");
        assert_eq!(unquote_git("\"caf\\303\\251\"").as_ref(), "caf\u{e9}");
        assert_eq!(unquote_git("plain").as_ref(), "plain");
    }

    #[test]
    fn a_star_in_a_file_name_does_not_hide_it_from_a_wildcard() {
        assert!(hit("a/*x.pem"));
        assert!(hit("a/*secret*.txt"));
        assert!(hit("*.pem"));
        assert!(hit_with("a/*b", &["a/*b"]));
        assert!(!hit("a/*x.txt"));
    }

    #[test]
    fn spaces_and_unicode_in_names_are_fine() {
        assert!(!hit("My Notes/\u{e9}tude.ts"));
        assert!(hit("My Notes/auth/\u{e9}tude.ts"));
        assert!(hit("My Notes/my secret plan.md"));
        // Windows drops a trailing dot or space from a name: `auth.` is `auth`.
        assert!(hit("src/auth./x.ts"));
        assert!(hit("src/auth /x.ts"));
    }

    #[test]
    fn a_pattern_with_a_slash_starts_at_the_root_and_one_without_matches_any_depth() {
        assert!(hit_with(".github/workflows/ci.yml", &[".github/**"]));
        assert!(!hit_with("pkg/.github/workflows/ci.yml", &[".github/**"]));
        assert!(hit_with("pkg/.github/workflows/ci.yml", &["**/.github/**"]));
        assert!(hit_with("pkg/.env.local", &[".env*"]));
        assert!(hit_with("src/legacy/old.rs", &["legacy"]));
        assert!(hit_with("src/legacy/old.rs", &["legacy/"]));
        assert!(!hit_with("src/legacy2/old.rs", &["legacy"]));
        // A pattern that names a folder takes everything under it; one that names a file takes that file.
        assert!(hit_with("docs/hivra/sensitive-paths.json", &["docs/hivra"]));
        assert!(hit_with(
            "docs/hivra/sensitive-paths.json",
            &["docs/hivra/sensitive-paths.json"]
        ));
        assert!(!hit_with("docs/hivra2/x.json", &["docs/hivra"]));
        // `*` stays inside one name; `?` is one character.
        assert!(!hit_with("a/b/c.ts", &["a/*.ts"]));
        assert!(hit_with("a/c.ts", &["a/*.ts"]));
        assert!(hit_with("a/c1.ts", &["a/c?.ts"]));
        assert!(!hit_with("a/c12.ts", &["a/c?.ts"]));
        // `**` takes none, one or many folders.
        assert!(hit_with("a/z.ts", &["a/**/z.ts"]));
        assert!(hit_with("a/b/c/z.ts", &["a/**/z.ts"]));
    }

    #[test]
    fn a_pattern_that_could_match_everything_or_cannot_be_read_matches_nothing() {
        for pattern in [
            "*",
            "**",
            "**/*",
            "?",
            "/",
            "",
            "   ",
            "../auth/**",
            "auth/../**",
            "a\u{7}b",
        ] {
            assert!(!hit_with("src/auth/x.ts", &[pattern]), "{pattern:?}");
            assert!(!hit_with("x", &[pattern]), "{pattern:?}");
        }
    }

    #[test]
    fn nothing_changed_nothing_listed_or_a_repeated_path_is_still_judged_once() {
        assert!(sensitive_hit(&[], &built_in_patterns()).is_empty());
        assert!(sensitive_hit(&list(&["src/auth/x.ts"]), &[]).is_empty());
        let got = sensitive_hit(
            &list(&["src/auth/x.ts", "README.md", "src/auth/x.ts", "db/a.sql"]),
            &built_in_patterns(),
        );
        assert_eq!(got, list(&["src/auth/x.ts", "db/a.sql"]));
        // The path comes back as it was given, not folded.
        let got = sensitive_hit(&list(&["SRC\\Auth\\X.ts"]), &built_in_patterns());
        assert_eq!(got, list(&["SRC\\Auth\\X.ts"]));
    }

    #[test]
    fn a_long_pattern_against_a_long_path_does_not_blow_up() {
        let path = vec!["a"; 300].join("/") + "/auth/x.ts";
        let nasty = ["**/a*a*a*a*a*a*b/**", "**/**/**/**/x.ts"];
        assert!(hit_with(&path, &nasty));
        assert!(!hit_with(
            &vec!["a"; 300].join("/"),
            &["**/a*a*a*a*a*a*b/**"]
        ));
    }

    // ---- the project's own protected paths ---------------------------------------------------------------------------------

    #[test]
    fn a_projects_protected_paths_become_patterns_the_floor_would_have_read_the_same_way() {
        let got = extra_patterns(&list(&[
            "billing/",
            "config/app.json",
            "  legacy  ",
            "win\\path\\x.ts",
            "*",
            "src/*.ts",
            "../outside",
            "a/../b",
            "/abs/path",
            "C:\\x",
            "",
            "billing/",
        ]));
        assert_eq!(
            got,
            list(&[
                "**/billing",
                "**/config/app.json",
                "**/legacy",
                "**/win/path/x.ts"
            ])
        );
        let patterns = patterns_for(None, &list(&["config/app.json"]));
        assert!(hit_with_all("pkg/config/app.json", &patterns));
        assert!(!hit_with_all("pkg/config/other.json", &patterns));
        assert!(hit_with_all("config\\APP.json", &patterns));
    }

    fn hit_with_all(path: &str, patterns: &[String]) -> bool {
        !sensitive_hit(&list(&[path]), patterns).is_empty()
    }

    #[test]
    fn the_list_file_is_itself_a_sensitive_path_and_the_patterns_have_no_repeats() {
        let patterns = patterns_for(None, &list(&["billing/", "billing"]));
        assert!(hit_with_all("docs/hivra/sensitive-paths.json", &patterns));
        let mut sorted = patterns.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), patterns.len(), "{patterns:?}");
    }

    // ---- the project's list file -------------------------------------------------------------------------------------------

    fn project_with(text: &[u8]) -> Temp {
        let project = Temp::new();
        let dir = project.path().join("docs").join("hivra");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sensitive-paths.json"), text).unwrap();
        project
    }

    #[test]
    fn a_missing_list_file_is_no_list() {
        let project = Temp::new();
        assert!(project_list_patterns(project.path()).is_empty());
        assert_eq!(
            patterns_for(Some(project.path()), &[]),
            patterns_for(None, &[])
        );
    }

    #[test]
    fn the_list_file_adds_its_globs() {
        let project = project_with(br#"["config/prod/**", "**/*.tfvars", "  vault/  "]"#);
        assert_eq!(
            project_list_patterns(project.path()),
            list(&["config/prod/**", "**/*.tfvars", "vault/"])
        );
        let patterns = patterns_for(Some(project.path()), &[]);
        assert!(hit_with_all("config/prod/db.yml", &patterns));
        assert!(hit_with_all("infra/vars.tfvars", &patterns));
        assert!(hit_with_all("vault/x", &patterns));
        assert!(!hit_with_all("config/dev/db.yml", &patterns));
    }

    #[test]
    fn a_list_file_that_is_not_a_list_of_strings_is_read_defensively() {
        let long = "x".repeat(300);
        let cases: Vec<(String, Vec<String>)> = vec![
            ("not json".into(), vec![]),
            ("".into(), vec![]),
            ("{\"paths\": [\"a/**\"]}".into(), vec![]),
            ("\"a/**\"".into(), vec![]),
            ("null".into(), vec![]),
            (
                "[1, null, {\"a\": 1}, [\"b\"], \"ok/**\"]".into(),
                list(&["ok/**"]),
            ),
            (
                "[\"\", \"   \", \"a\\u0007b\", \"keep/**\", \"keep/**\"]".into(),
                list(&["keep/**"]),
            ),
            (format!("[\"{long}\", \"short/**\"]"), list(&["short/**"])),
            // A byte order mark and Windows line ends.
            (
                "\u{feff}[\r\n  \"win/**\",\r\n  \"two/**\"\r\n]\r\n".into(),
                list(&["win/**", "two/**"]),
            ),
        ];
        for (text, want) in cases {
            assert_eq!(parse_list(&text), want, "{text:?}");
        }
        let many: Vec<String> = (0..PATTERNS_MAX + 50)
            .map(|n| format!("\"dir{n}/**\""))
            .collect();
        assert_eq!(
            parse_list(&format!("[{}]", many.join(","))).len(),
            PATTERNS_MAX
        );
    }

    #[test]
    fn a_list_file_that_is_too_big_a_folder_or_a_link_is_no_list() {
        let big = format!("[\"a/**\"{}]", ", \"b/**\"".repeat(10_000));
        assert!(big.len() as u64 > LIST_MAX_BYTES);
        assert!(project_list_patterns(project_with(big.as_bytes()).path()).is_empty());
        // Not valid UTF-8: the bytes that are, are read; the JSON around them decides.
        assert!(project_list_patterns(project_with(&[0xff, 0xfe, 0x00]).path()).is_empty());
        // A folder with the file's name.
        let project = Temp::new();
        std::fs::create_dir_all(project.path().join("docs/hivra/sensitive-paths.json")).unwrap();
        assert!(project_list_patterns(project.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_place_of_the_list_file_is_not_followed() {
        let project = Temp::new();
        let outside = Temp::new();
        std::fs::write(outside.path().join("real.json"), "[\"leak/**\"]").unwrap();
        let dir = project.path().join("docs").join("hivra");
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("real.json"),
            dir.join("sensitive-paths.json"),
        )
        .unwrap();
        assert!(project_list_patterns(project.path()).is_empty());
    }

    #[test]
    fn a_change_is_sensitive_by_the_built_in_list_the_projects_paths_or_its_list_file() {
        let project = project_with(br#"["config/prod/**"]"#);
        let at = |changed: &[&str], extra: &[&str]| {
            touches_sensitive_path(&list(changed), project.path(), &list(extra))
        };
        assert!(at(&["src/auth/login.ts"], &[]));
        assert!(at(&["config/prod/db.yml"], &[]));
        assert!(at(&["src/legacy/old.rs"], &["legacy/"]));
        assert!(!at(&["src/features/tally/sum.ts"], &["legacy/"]));
        assert!(!at(&[], &[]));
        // Changing the list is itself sensitive.
        assert!(at(&["docs/hivra/sensitive-paths.json"], &[]));
    }
}
