//! WP-104: the same shell judgement as `src/features/autopilot/model/safeApproval.ts` (`safeCommand`).
//!
//! A check timer may run a command only when that function would allow it. This is a line-by-line port of the shell
//! half, not a second list: the names, the flags and the refusals stay the ones already written there. Do not add a
//! command here.

use std::sync::OnceLock;

use regex::Regex;

const SHELL_META: &[char] = &[';', '&', '|', '`', '$', '<', '>', '(', ')', '\n', '\r'];

fn is_plain(c: char) -> bool {
    matches!(c, 'A'..='Z' | 'a'..='z' | '0'..='9' | '_' | '-' | '.' | '/' | ':' | '=' | ',' | '@' | '%' | '+' | '~')
}

/// The words sh would pass. None when a quote is open or an unquoted character could expand.
pub fn shell_words(command: &str) -> Option<Vec<String>> {
    let chars: Vec<char> = command.chars().collect();
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\'' {
            let end = chars[i + 1..].iter().position(|ch| *ch == '\'')?;
            let end = i + 1 + end;
            word.extend(chars[i + 1..end].iter());
            in_word = true;
            i = end;
        } else if c == '"' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != '"' {
                if chars[j] == '\\'
                    && j + 1 < chars.len()
                    && (chars[j + 1] == '"' || chars[j + 1] == '\\')
                {
                    j += 1;
                }
                word.push(chars[j]);
                j += 1;
            }
            if j >= chars.len() {
                return None;
            }
            in_word = true;
            i = j;
        } else if c == '\\' {
            if i + 1 >= chars.len() {
                return None;
            }
            i += 1;
            word.push(chars[i]);
            in_word = true;
        } else if c == ' ' || c == '\t' {
            if in_word {
                words.push(std::mem::take(&mut word));
            }
            in_word = false;
        } else if is_plain(c) {
            word.push(c);
            in_word = true;
        } else {
            return None;
        }
        i += 1;
    }
    if in_word {
        words.push(word);
    }
    Some(words)
}

fn has(args: &[String], flags: &[&str]) -> bool {
    args.iter().any(|arg| {
        flags
            .iter()
            .any(|flag| arg == flag || arg.starts_with(&format!("{flag}=")))
    })
}

fn branch_flags() -> &'static Regex {
    static FLAGS: OnceLock<Regex> = OnceLock::new();
    FLAGS.get_or_init(|| {
        Regex::new(
            r"^(-a|--all|-r|--remotes|-v|-vv|--verbose|-l|--list|--show-current|--merged|--no-merged|--contains|--no-contains|--points-at|--sort(=.*)?|--format(=.*)?|--column|--no-column|--color(=.*)?|--no-color|--abbrev(=.*)?|--no-abbrev|-i|--ignore-case|--omit-empty)$",
        )
        .expect("branch flags")
    })
}

fn git_read(args: &[String]) -> Option<&'static str> {
    let Some(sub) = args.first() else {
        return Some("only git status, diff, log, show and branch run by themselves");
    };
    if !matches!(sub.as_str(), "status" | "diff" | "log" | "show" | "branch") {
        return Some("only git status, diff, log, show and branch run by themselves");
    }
    let rest = &args[1..];
    if has(rest, &["--output", "--ext-diff"]) {
        return Some("it writes a file or runs an outside diff");
    }
    if sub == "branch" {
        let flags: Vec<&str> = rest
            .iter()
            .filter(|arg| arg.starts_with('-'))
            .map(String::as_str)
            .collect();
        if flags.iter().any(|flag| !branch_flags().is_match(flag)) {
            return Some("git branch only lists by itself");
        }
        let query = [
            "-l",
            "--list",
            "--merged",
            "--no-merged",
            "--contains",
            "--no-contains",
            "--points-at",
        ];
        if rest.iter().any(|arg| !arg.starts_with('-'))
            && !flags.iter().any(|flag| query.contains(flag))
        {
            return Some("git branch only lists by itself");
        }
    }
    None
}

// Round 2 (C1, in step with safeApproval.ts): tests and builds run code the chat may have just written, so only
// cargo fmt --check runs by itself.
fn cargo_read(args: &[String]) -> Option<&'static str> {
    let Some(sub) = args.first() else {
        return Some("only cargo fmt --check runs by itself; cargo test, check, clippy and build run code, so they wait for Ash");
    };
    if sub.as_str() != "fmt" {
        return Some("only cargo fmt --check runs by itself; cargo test, check, clippy and build run code, so they wait for Ash");
    }
    let rest = &args[1..];
    if sub == "fmt" && !rest.iter().any(|arg| arg == "--check") {
        return Some("cargo fmt rewrites files unless it is --check");
    }
    if has(
        rest,
        &[
            "--config",
            "--manifest-path",
            "--target-dir",
            "--artifact-dir",
            "--out-dir",
            "--fix",
            "--allow-dirty",
            "--allow-staged",
            "--emit",
        ],
    ) || rest.iter().any(|arg| arg.starts_with("-Z"))
    {
        return Some("that cargo option doesn't run by itself");
    }
    None
}

/// Round 2 (WP-101 low): the words a read names that could reach a login store, a folder outside the chat's own, or
/// files a search's ignore rules hide. A relative path below the folder passes; an absolute or home path, a climb
/// (`..`), a hidden name (`.env`, `.ssh`, `.git`), a credential-shaped name and a glob in a search are held. The full
/// check is credentialPaths.ts (run when a check is set from the app); this is the same rule for the words a timer holds.
fn names_login_or_outside(head: &str, args: &[String]) -> Option<&'static str> {
    const HELD: &str = "it names a login store, a folder outside the chat's own, or files the ignore rules hide, so it waits for Ash";
    let search = matches!(head, "rg" | "grep" | "ag" | "fd" | "find");
    let mut pattern_seen = false;
    for arg in args {
        // A flag's words: its value after `=`, and a path glued on with no space from its first slash (`-f/Users/me/.netrc`,
        // which the shell hands to the program as one word). Round 3, item 5: the glued form was skipped before.
        let mut words: Vec<&str> = Vec::new();
        if arg.starts_with('-') {
            if let Some((_, value)) = arg.split_once('=') {
                words.push(value);
            }
            if let Some(at) = arg.find('/') {
                words.push(&arg[at..]);
            }
        } else {
            words.push(arg.as_str());
        }
        for word in words {
            if search && word.contains(['*', '?', '[']) {
                return Some(HELD);
            }
            // A search's first bare word is its pattern, as grep reads it; a word with a dot, a slash, a tilde or a
            // backslash is a path, so it is read as one.
            if search && head != "find" && !pattern_seen && !word.contains(['.', '/', '~', '\\']) {
                pattern_seen = true;
                continue;
            }
            let climbs_or_hides = word
                .split(['/', '\\', ':'])
                .any(|part| part == ".." || (part.len() > 1 && part.starts_with('.')));
            let rooted = word.starts_with(['~', '/', '\\']) || is_drive_path(word);
            // Round 3: the shared config list (agentConfigPaths.json) and brace lists that name a folder outside. A word that
            // is not ASCII is held here: this side has no Unicode folding, so it cannot tell a spelling it would miss.
            let segments: Vec<&str> = word.split(['/', '\\']).collect();
            if rooted
                || climbs_or_hides
                || credential_name(word)
                || !word.is_ascii()
                || braces_outside(word)
                || protected_config(&segments)
            {
                return Some(HELD);
            }
        }
    }
    None
}

/// The shared list of agent and tool configs, read at build time from the same file the TypeScript approval check imports
/// (src/shared/security/agentConfigPaths.json), so the two lists cannot drift (review round 3, item 1).
const PROTECTED_JSON: &str = include_str!("../../../src/shared/security/agentConfigPaths.json");

struct ProtectedList {
    files: Vec<String>,
    dirs: Vec<String>,
    suffixes: Vec<Vec<String>>,
}

fn protected_list() -> &'static ProtectedList {
    static LIST: OnceLock<ProtectedList> = OnceLock::new();
    LIST.get_or_init(|| {
        let value: serde_json::Value =
            serde_json::from_str(PROTECTED_JSON).expect("agentConfigPaths.json parses");
        let names = |key: &str| -> Vec<String> {
            value[key]
                .as_array()
                .expect("a list of names")
                .iter()
                .map(|name| fold_segment(name.as_str().expect("a name")))
                .collect()
        };
        ProtectedList {
            files: names("files"),
            dirs: names("dirs"),
            suffixes: value["pathSuffixes"]
                .as_array()
                .expect("pathSuffixes")
                .iter()
                .map(|suffix| {
                    suffix
                        .as_str()
                        .expect("a suffix")
                        .split('/')
                        .map(fold_segment)
                        .collect()
                })
                .collect(),
        }
    })
}

/// A segment folded as the TypeScript side folds it, for the ASCII names this side reads: lower case, trailing dots and
/// spaces dropped (`.codex.` is `.codex`).
fn fold_segment(part: &str) -> String {
    part.to_ascii_lowercase()
        .trim_end_matches([' ', '.'])
        .to_string()
}

/// Whether the segments of a path name a protected config: a folder in the list, a file in the list, or a listed suffix.
/// The dot rule is not here: a read's own dot-named file is ordinary, as in safeApproval.ts's read words.
fn protected_config(segments: &[&str]) -> bool {
    let list = protected_list();
    let folded: Vec<String> = segments
        .iter()
        .filter(|part| !part.is_empty())
        .map(|part| fold_segment(part))
        .collect();
    let Some(last) = folded.last() else {
        return false;
    };
    if folded.iter().any(|part| list.dirs.contains(part)) || list.files.contains(last) {
        return true;
    }
    list.suffixes.iter().any(|suffix| {
        folded.len() >= suffix.len() && folded[folded.len() - suffix.len()..] == suffix[..]
    })
}

/// A brace list with a slash or a climb inside it (`{/etc,src}`, `{../..,src}`), which a shell expands before the command
/// runs (round 3, item 5).
fn braces_outside(word: &str) -> bool {
    let mut rest = word;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            return false;
        };
        let inner = &after[..close];
        if inner.contains('/') || inner.contains("..") {
            return true;
        }
        rest = &after[close + 1..];
    }
    false
}

fn is_drive_path(word: &str) -> bool {
    let bytes = word.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

/// A file name that is a login store whatever folder holds it: the key and token stems, key and certificate
/// extensions, and the SSH and cloud key names. Mirrors the common cases of credentialName (credentialPaths.ts).
fn credential_name(word: &str) -> bool {
    let name = word
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, ext),
        _ => (name.as_str(), ""),
    };
    [
        "id_rsa",
        "id_ed25519",
        "id_ecdsa",
        "id_dsa",
        "service-account",
        "terraform.tfstate",
        "kubeconfig",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
        || [
            "credential",
            "credentials",
            "secret",
            "secrets",
            "token",
            "tokens",
            "password",
            "passwords",
            "passwd",
        ]
        .contains(&stem)
        || ["key", "pem", "p12", "pfx", "jks", "keystore", "tfvars"].contains(&ext)
}

fn rg_read(args: &[String]) -> Option<&'static str> {
    if has(args, &["--pre", "--pre-glob", "--hostname-bin"]) {
        Some("rg --pre runs a program")
    } else {
        None
    }
}

/// None when autopilot would run this by itself. The reason otherwise. Same answers as `safeCommand`, plus the words a
/// read names in a login store (round 2).
/// An unreadable command is a reason, never an allow: `?` on the word list would invert that.
pub fn verdict(command: &str) -> Option<String> {
    if command.chars().any(|c| SHELL_META.contains(&c)) {
        return Some("it chains, substitutes or redirects".into());
    }
    let Some(words) = shell_words(command.trim()) else {
        return Some("it can't be read plainly (a wildcard or an open quote)".into());
    };
    if words.is_empty() {
        return Some("it can't be read plainly (a wildcard or an open quote)".into());
    }
    let args = &words[1..];
    let why = match words[0].as_str() {
        "git" => git_read(args),
        "cargo" => cargo_read(args),
        "rg" => rg_read(args),
        "grep" | "ls" | "cat" | "head" | "tail" | "wc" | "pwd" => None,
        other => {
            return Some(format!("{other} isn't a read autopilot runs by itself"));
        }
    };
    why.or_else(|| names_login_or_outside(&words[0], args))
        .map(str::to_string)
}

/// The words to exec, with no shell, when `verdict` allows the command.
pub fn argv(command: &str) -> Result<Vec<String>, String> {
    if let Some(why) = verdict(command) {
        return Err(why.to_string());
    }
    let words = shell_words(command.trim())
        .ok_or_else(|| "it can't be read plainly (a wildcard or an open quote)".to_string())?;
    let program = words.first().map(String::as_str).unwrap_or("");
    if program.is_empty() || program.contains('/') || program.contains('\\') {
        return Err("it isn't a read autopilot runs by itself".into());
    }
    Ok(words)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_words_as_sh_does() {
        assert_eq!(
            shell_words(r#"rg -n 'a b' "c\"d" e\ f"#).unwrap(),
            ["rg", "-n", "a b", "c\"d", "e f"]
        );
        assert!(shell_words("rg foo *").is_none());
        assert!(shell_words("cat 'x").is_none());
        // An unreadable command is refused, not allowed.
        assert!(verdict("cargo +nightly test").is_some());
        assert!(verdict("rg foo *").is_some());
    }

    #[test]
    fn the_safe_table_allows_these_and_no_others() {
        for command in [
            "git status",
            "git status --porcelain",
            "git diff HEAD~1 -- src/app.ts",
            "git log --oneline -20",
            "git show HEAD:src/app.ts",
            "git branch",
            "git branch -a -v",
            "git branch --list 'hub/*'",
            "git branch --contains abc123",
            "ls -la src",
            "cat README.md",
            "rg -n 'foo bar' src",
            "rg \"fn main\" src-tauri",
            "grep -rn TODO src",
            "head -50 src/app.ts",
            "wc -l src/app.ts",
            "pwd",
            "cargo fmt --check",
            "cargo fmt --all --check",
            "rg -n token src",
            "cat src/token_store.ts",
            "cat ./src/app.ts",
            "git show HEAD:src/app.ts",
        ] {
            assert!(
                verdict(command).is_none(),
                "{command} -> {:?}",
                verdict(command)
            );
        }
    }

    #[test]
    fn the_safe_table_refuses_these() {
        for command in [
            "git status; rm -rf ~/data",
            "git status && rm -rf ~/data",
            "git status || true",
            "git status & rm -rf ~/data",
            "echo cm0gLXJmIH4vZGF0YQ== | base64 -d | sh",
            "rg -n 'foo|bar' src",
            "cat $(echo ~/.ssh/id_rsa)",
            "cat `echo x`",
            "cat ${HOME}/x",
            "git log > out.txt",
            "cat < /etc/passwd",
            "git status\nrm -rf ~/data",
            "(rm -rf ~/data)",
            "python3 -c \"import shutil\"",
            "gh pr merge 12 --admin",
            "rm -rf build",
            "npx vitest run",
            // Round 2 (C1): a test or build runs code the chat may have just written, so it waits.
            "npm test",
            "npm test -- src/features/autopilot",
            "npm run check",
            "npm run lint",
            "npm run build",
            "npm run check:web",
            "cargo test",
            "cargo test -p monocode --lib autopilot",
            "cargo check --workspace",
            "cargo clippy --all-targets -- -D warnings",
            "node --test scripts/hub-dev.test.mjs",
            "node --test 'scripts/**/*.test.mjs'",
            // Round 2 (low): a login store or a folder outside the chat's own, named by a word a read may still allow.
            "cat ~/.netrc",
            "cat ~/.ssh/config",
            "cat /Users/me/.aws/credentials",
            "cat /etc/hosts",
            "cat .env",
            "cat ./config/.env.local",
            "cat ../secret.txt",
            "cat secrets/token.txt",
            "cat keys/server.pem",
            "cat id_rsa.pub",
            "cat .git/config",
            "rg -g '.env*' TOKEN",
            "rg -g .env TOKEN src",
            "grep -rn TODO ~/Projects",
            "git show HEAD:.env",
            "ls ~",
            "/usr/bin/git status",
            "CI=1 npm test",
            "git push origin main",
            "git checkout main",
            "git -C /elsewhere status",
            "rg --pre=sh foo",
            "rg --pre sh foo",
            "rg '--pre=sh' foo",
            "rg --p\\re=sh foo",
            "rg --hostname-bin=/tmp/x foo",
            "git diff --output=/Users/ash/.zshrc",
            "git log --ext-diff",
            "git branch -D main",
            "git branch --delete main",
            "git branch -f main HEAD~3",
            "git branch new-branch",
            "npm test --script-shell=/tmp/evil",
            "npm run check --prefix ../other",
            "npm run deploy",
            "npm install",
            "cargo fmt",
            "cargo test --config build.rustc-wrapper=/tmp/evil",
            "cargo clippy --fix --allow-dirty",
            "cargo test --manifest-path /elsewhere/Cargo.toml",
            "cargo +nightly test",
            "cargo run",
            "node -e 'require(\"fs\")'",
            "node --test --import=./evil.mjs",
            "node --test --require ./evil.js",
            "node scripts/anything.mjs",
            "rg foo *",
            "rg foo {--pre=sh,.}",
            "ls ^x",
            "cat 'unclosed",
        ] {
            assert!(verdict(command).is_some(), "{command} was allowed");
        }
    }
}

#[cfg(test)]
mod round3_tests {
    use super::*;

    // WP-101 review round 3. Each test is a case the TypeScript side (safeApproval.ts, credentialPaths.ts) already holds.

    #[test]
    fn the_shared_config_list_parses_and_names_the_configs() {
        let list = protected_list();
        assert!(list.files.contains(&"opencode.jsonc".to_string()));
        assert!(list.files.contains(&"bunfig.toml".to_string()));
        assert!(list.dirs.contains(&".omp".to_string()));
        assert!(list
            .suffixes
            .iter()
            .any(|suffix| suffix == &["config", "mise", "config.toml"].map(String::from).to_vec()));
    }

    #[test]
    fn a_timer_holds_the_tool_configs_by_name() {
        for command in [
            "cat opencode.jsonc",
            "cat ./mise.local.toml",
            "grep x lefthook-local.yml",
            "cat rust-toolchain.toml",
            "cat sub/bunfig.toml",
            "cat config/mise/config.toml",
            "ls .omp",
        ] {
            assert!(verdict(command).is_some(), "{command} should be held");
        }
    }

    #[test]
    fn a_glued_short_option_with_a_path_is_held() {
        assert!(verdict("rg -f/Users/me/x src").is_some());
        assert!(verdict("grep -f/etc/passwd README.md").is_some());
    }

    #[test]
    fn braces_naming_a_folder_outside_are_held() {
        assert!(verdict("cat '{/etc,src}/x'").is_some());
        assert!(verdict("ls '{../..,src}'").is_some());
    }

    #[test]
    fn a_word_that_is_not_ascii_is_held() {
        assert!(verdict("cat README-é.md").is_some());
    }

    #[test]
    fn a_plain_read_still_runs() {
        assert!(verdict("cat README.md").is_none());
        assert!(verdict("rg -n 'foo' src").is_none());
    }
}
