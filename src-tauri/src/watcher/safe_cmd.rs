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

fn npm_scripts() -> &'static Regex {
    static SCRIPTS: OnceLock<Regex> = OnceLock::new();
    SCRIPTS.get_or_init(|| {
        Regex::new(r"^(test|check|lint|build)(:[A-Za-z0-9_.-]+)?$").expect("npm scripts")
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

fn npm_script(args: &[String]) -> Option<&'static str> {
    let first = args.first().map(String::as_str).unwrap_or("");
    let second = args.get(1).map(String::as_str);
    let after: Vec<&str> = if first == "test" {
        args.iter().skip(1).map(String::as_str).collect()
    } else {
        args.iter().skip(2).map(String::as_str).collect()
    };
    let named = first == "test"
        || (first == "run" && second.is_some_and(|name| npm_scripts().is_match(name)));
    if !named {
        return Some("only npm test and npm run check, lint or build run by themselves");
    }
    if !after.is_empty() && after[0] != "--" {
        return Some("npm options don't run by themselves");
    }
    None
}

fn cargo_read(args: &[String]) -> Option<&'static str> {
    let Some(sub) = args.first() else {
        return Some("only cargo test, check, clippy and fmt --check run by themselves");
    };
    if !matches!(sub.as_str(), "test" | "check" | "clippy" | "fmt") {
        return Some("only cargo test, check, clippy and fmt --check run by themselves");
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

fn node_test(args: &[String]) -> Option<&'static str> {
    if !args.iter().any(|arg| arg == "--test") {
        return Some("only node --test runs by itself");
    }
    if has(
        args,
        &[
            "-e",
            "--eval",
            "-p",
            "--print",
            "-r",
            "--require",
            "--import",
            "--loader",
            "--experimental-loader",
            "-i",
            "--interactive",
            "--env-file",
            "--inspect",
            "--inspect-brk",
        ],
    ) {
        return Some("that node option doesn't run by itself");
    }
    None
}

fn rg_read(args: &[String]) -> Option<&'static str> {
    if has(args, &["--pre", "--pre-glob", "--hostname-bin"]) {
        Some("rg --pre runs a program")
    } else {
        None
    }
}

/// None when autopilot would run this by itself. The reason otherwise. Same answers as `safeCommand`.
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
        "npm" => npm_script(args),
        "cargo" => cargo_read(args),
        "node" => node_test(args),
        "rg" => rg_read(args),
        "grep" | "ls" | "cat" | "head" | "tail" | "wc" | "pwd" => None,
        other => {
            return Some(format!(
                "{other} isn't a read, test or build autopilot runs by itself"
            ))
        }
    };
    why.map(str::to_string)
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
        return Err("it isn't a read, test or build autopilot runs by itself".into());
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
            "cargo fmt --check",
            "cargo fmt --all --check",
            "node --test scripts/hub-dev.test.mjs",
            "node --test 'scripts/**/*.test.mjs'",
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
