//! PT-1: a catalogue command template filled with arguments, never with text spliced into a shell line.
//!
//! The action runner takes a SHELL STRING (`/bin/sh -c`, or `cmd /C` on Windows). A file name, a line range or a base
//! revision is untrusted text (spaces, quotes, `;`, `$(x)`, a leading `-`, a `..`), so none of it is ever put in that
//! string. Every dynamic value goes in the child's environment as `MONOCODE_PROOF_<n>` and the command names it as a
//! double-quoted `"$MONOCODE_PROOF_<n>"` (`"%MONOCODE_PROOF_<n>%"` for `cmd`): the shell expands a quoted variable to one
//! word and reads nothing in it. Only the template's own fixed words, which passed `literal_ok`, appear in the string.
//!
//! Template language (checked by `check_template`, so a catalogue edit that sneaks in a shell operator is refused):
//! words are split on single spaces. A word is fixed text from `[A-Za-z0-9_@./:=+,-]` mixed with placeholders and
//! optionally wrapped in double quotes (the quotes only group; they are dropped). Placeholders: `{files}` (a word of its
//! own: one argument per file), `{ranges}` (one argument: the ranges joined with commas), `{diff}`, `{base}`, `{schema}`,
//! `{baseUrl}`, `{config}`, `{out}` (one argument each).
//!
//! `npx` never downloads a tool: `--no-install` is put after it, so a project that has the tool in its devDependencies
//! runs it and a worktree without `node_modules` fails to start instead of fetching a package off the network.

/// The most files `{files}` expands to. More is "too many to pass as arguments", not a silent cut.
pub const FILES_MAX: usize = 200;
/// A template is shorter than this many characters.
const TEMPLATE_MAX: usize = 300;
/// A fixed word is at most this long.
const WORD_MAX: usize = 120;
/// The longest single value put in the environment (the ranges of a big change are one value).
const VALUE_MAX: usize = 32_768;
/// How much of one word `Prepared::shown` keeps.
const SHOWN_WORD_MAX: usize = 80;

/// A fixed word's characters: nothing a shell or `cmd` reads as an operator, a glob, a variable or a quote.
fn literal_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '@' | '.' | '/' | ':' | '=' | '+' | ',' | '-')
}

/// Whether `word` is plain fixed text: non-empty, at most 120 characters, only `[A-Za-z0-9_@./:=+,-]`.
pub fn literal_ok(word: &str) -> bool {
    !word.is_empty() && word.chars().count() <= WORD_MAX && word.chars().all(literal_char)
}

/// What a placeholder in a template stands for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hole {
    Files,
    Ranges,
    Diff,
    Base,
    Schema,
    BaseUrl,
    Config,
    Out,
}

impl Hole {
    fn parse(name: &str) -> Option<Hole> {
        Some(match name {
            "files" => Hole::Files,
            "ranges" => Hole::Ranges,
            "diff" => Hole::Diff,
            "base" => Hole::Base,
            "schema" => Hole::Schema,
            "baseUrl" => Hole::BaseUrl,
            "config" => Hole::Config,
            "out" => Hole::Out,
            _ => return None,
        })
    }

    /// The sentence a person reads when the value isn't there.
    fn missing(self) -> &'static str {
        match self {
            Hole::Files => "there is no changed file to pass to it",
            Hole::Ranges => "there is no changed line in a file this tool reads",
            Hole::Diff => "there is no diff of the change to give it",
            Hole::Base => "there is no revision to compare with",
            Hole::Schema => "the project has no OpenAPI file to give it",
            Hole::BaseUrl => "the project declares no base URL for the service",
            Hole::Config => "the project has no rules file to give it",
            Hole::Out => "there is no folder to put its output in",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Part {
    Lit(String),
    Hole(Hole),
}

/// One template word: fixed text and placeholders, in order.
type Word = Vec<Part>;

/// The characters a template may never carry, named so the refusal says which.
const REFUSED: [char; 15] = [
    '\'', '$', '`', ';', '&', '|', '<', '>', '\\', '(', ')', '*', '?', '#', '~',
];

fn parse_word(word: &str) -> Result<Word, String> {
    let mut parts: Word = Vec::new();
    let mut literal = String::new();
    let mut quoted = false;
    let mut chars = word.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '{' => {
                let mut name = String::new();
                let mut closed = false;
                for inner in chars.by_ref() {
                    if inner == '}' {
                        closed = true;
                        break;
                    }
                    name.push(inner);
                }
                if !closed {
                    return Err("a placeholder is never closed".into());
                }
                let Some(hole) = Hole::parse(&name) else {
                    return Err(format!("{{{name}}} is not a placeholder the app fills"));
                };
                if !literal.is_empty() {
                    parts.push(Part::Lit(std::mem::take(&mut literal)));
                }
                parts.push(Part::Hole(hole));
            }
            '}' => return Err("a closing brace has no placeholder to close".into()),
            c if literal_char(c) => literal.push(c),
            c if REFUSED.contains(&c) || c == '!' => {
                return Err(format!("it has `{c}`, which a command here may not have"))
            }
            c if c.is_control() => return Err("it has a control character".into()),
            c => return Err(format!("it has `{c}`, which a command here may not have")),
        }
    }
    if quoted {
        return Err("a quotation mark is never closed".into());
    }
    if !literal.is_empty() {
        parts.push(Part::Lit(literal));
    }
    Ok(parts)
}

fn parse(template: &str) -> Result<Vec<Word>, String> {
    if template.trim().is_empty() {
        return Err("the command is empty".into());
    }
    if template.chars().count() >= TEMPLATE_MAX {
        return Err(format!(
            "the command is {TEMPLATE_MAX} characters or longer"
        ));
    }
    let mut words = Vec::new();
    for raw in template.split(' ') {
        if raw.is_empty() {
            return Err("the command has a doubled or stray space".into());
        }
        let word = parse_word(raw)?;
        if word.is_empty() {
            return Err("the command has an empty word".into());
        }
        if word.contains(&Part::Hole(Hole::Files)) && word.len() != 1 {
            return Err("{files} must be a word on its own".into());
        }
        words.push(word);
    }
    // The program is fixed text, and not one a shell reads as a variable assignment or an option.
    match words.first().map(Vec::as_slice) {
        Some([Part::Lit(program)]) if !program.contains('=') && !program.starts_with('-') => {}
        _ => return Err("the command must start with the program's own name".into()),
    }
    Ok(words)
}

/// Whether a catalogue command template is one the app may run: see the module notes for the language.
pub fn check_template(template: &str) -> Result<(), String> {
    parse(template).map(|_| ())
}

/// What the placeholders stand for, for one run. A value left empty is a value the run doesn't have.
#[derive(Default, Clone, Debug)]
pub struct Fill {
    pub files: Vec<String>,
    pub ranges: Vec<String>,
    pub diff: Option<String>,
    pub base: Option<String>,
    pub schema: Option<String>,
    pub base_url: Option<String>,
    pub config: Option<String>,
    pub out: Option<String>,
}

/// A command ready for the runner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prepared {
    /// What the program receives, one element per argument (for tests and for showing the person).
    pub argv: Vec<String>,
    /// The shell line: fixed words and quoted environment references only.
    pub command: String,
    /// The values the line names, `MONOCODE_PROOF_<n>` in order.
    pub env: Vec<(String, String)>,
}

impl Prepared {
    /// The command as a person reads it: a word with a space, a quote or nothing in it is wrapped in double quotes, and a
    /// long word is cut with an ellipsis. This is for reading, never for running.
    pub fn shown(&self) -> String {
        self.argv
            .iter()
            .map(|word| {
                let cut: String = if word.chars().count() > SHOWN_WORD_MAX {
                    let mut kept: String = word.chars().take(SHOWN_WORD_MAX - 1).collect();
                    kept.push('…');
                    kept
                } else {
                    word.clone()
                };
                if cut.is_empty() || cut.chars().any(|c| !literal_char(c) && c != '…') {
                    format!("\"{}\"", cut.replace('"', "\\\""))
                } else {
                    cut
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Which shell reads the line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shell {
    /// `/bin/sh -c`.
    Sh,
    /// `cmd /C`.
    Cmd,
}

/// A value `cmd` can take inside `"%VAR%"` without reading anything in it: no control character and none of `"%&|<>^!`.
pub fn cmd_value_safe(value: &str) -> bool {
    !value
        .chars()
        .any(|c| c.is_control() || matches!(c, '"' | '%' | '&' | '|' | '<' | '>' | '^' | '!'))
}

/// A value the shell may be given: not empty, not huge, no NUL or line break, and for `cmd` also `cmd_value_safe`.
fn value_ok(value: &str, shell: Shell) -> bool {
    !value.is_empty()
        && value.len() <= VALUE_MAX
        && !value.contains(['\0', '\n', '\r'])
        && (shell == Shell::Sh || cmd_value_safe(value))
}

const UNSAFE: &str =
    "a file name or value has a character that can't be passed to the command safely";

fn env_name(index: usize) -> String {
    format!("MONOCODE_PROOF_{index}")
}

fn env_ref(shell: Shell, index: usize) -> String {
    match shell {
        Shell::Sh => format!("\"${}\"", env_name(index)),
        Shell::Cmd => format!("\"%{}%\"", env_name(index)),
    }
}

/// One value of a placeholder that stands for one argument.
fn single(hole: Hole, fill: &Fill) -> Result<String, String> {
    let given = |value: &Option<String>| {
        value
            .as_deref()
            .filter(|text| !text.is_empty())
            .map(str::to_string)
            .ok_or_else(|| hole.missing().to_string())
    };
    match hole {
        Hole::Ranges => {
            if fill.ranges.is_empty() {
                Err(hole.missing().into())
            } else {
                Ok(fill.ranges.join(","))
            }
        }
        Hole::Diff => given(&fill.diff),
        Hole::Base => given(&fill.base),
        Hole::Schema => given(&fill.schema),
        Hole::BaseUrl => given(&fill.base_url),
        Hole::Config => given(&fill.config),
        Hole::Out => given(&fill.out),
        // `{files}` is expanded by the caller, one word per file.
        Hole::Files => Err(hole.missing().into()),
    }
}

/// `npx` never downloads: `--no-install` goes right after it unless the template already said `--no-install` or `--no`.
fn pin_npx(argv: &mut Vec<String>, words: &mut Vec<String>) {
    if argv.first().map(String::as_str) == Some("npx")
        && !matches!(
            argv.get(1).map(String::as_str),
            Some("--no-install" | "--no")
        )
    {
        argv.insert(1, "--no-install".to_string());
        words.insert(1, "--no-install".to_string());
    }
}

/// `template` with its placeholders filled for `shell`. `Err` is one plain sentence on what the run is missing.
pub fn prepare_with(template: &str, fill: &Fill, shell: Shell) -> Result<Prepared, String> {
    let words = parse(template)?;
    let mut argv: Vec<String> = Vec::new();
    let mut line: Vec<String> = Vec::new();
    let mut env: Vec<(String, String)> = Vec::new();
    let put = |value: String, env: &mut Vec<(String, String)>| -> Result<String, String> {
        if !value_ok(&value, shell) {
            return Err(UNSAFE.to_string());
        }
        let index = env.len();
        env.push((env_name(index), value));
        Ok(env_ref(shell, index))
    };
    for word in &words {
        if word.as_slice() == [Part::Hole(Hole::Files)] {
            if fill.files.is_empty() {
                return Err(Hole::Files.missing().into());
            }
            if fill.files.len() > FILES_MAX {
                return Err(format!(
                    "there are {} changed files, too many to pass as arguments (the limit is {FILES_MAX})",
                    fill.files.len()
                ));
            }
            for file in &fill.files {
                line.push(put(file.clone(), &mut env)?);
                argv.push(file.clone());
            }
            continue;
        }
        let mut resolved = String::new();
        let mut text = String::new();
        for part in word {
            match part {
                Part::Lit(fixed) => {
                    resolved.push_str(fixed);
                    text.push_str(fixed);
                }
                Part::Hole(hole) => {
                    let value = single(*hole, fill)?;
                    resolved.push_str(&value);
                    text.push_str(&put(value, &mut env)?);
                }
            }
        }
        argv.push(resolved);
        line.push(text);
    }
    pin_npx(&mut argv, &mut line);
    Ok(Prepared {
        argv,
        command: line.join(" "),
        env,
    })
}

/// `template` filled for the shell this build runs commands with.
pub fn prepare(template: &str, fill: &Fill) -> Result<Prepared, String> {
    prepare_with(
        template,
        fill,
        if cfg!(windows) { Shell::Cmd } else { Shell::Sh },
    )
}

/// A fixed argv (a probe such as `cargo mutants --version`). A word that isn't plain fixed text goes through the
/// environment like any other value, so nothing is ever put in the line; one that can't be passed safely becomes empty.
pub fn prepare_argv(argv: &[&str]) -> Prepared {
    let shell = if cfg!(windows) { Shell::Cmd } else { Shell::Sh };
    let mut resolved: Vec<String> = Vec::new();
    let mut line: Vec<String> = Vec::new();
    let mut env: Vec<(String, String)> = Vec::new();
    for word in argv {
        if literal_ok(word) {
            resolved.push((*word).to_string());
            line.push((*word).to_string());
        } else if value_ok(word, shell) {
            line.push(env_ref(shell, env.len()));
            env.push((env_name(env.len()), (*word).to_string()));
            resolved.push((*word).to_string());
        } else {
            resolved.push(String::new());
            line.push("\"\"".to_string());
        }
    }
    pin_npx(&mut resolved, &mut line);
    Prepared {
        argv: resolved,
        command: line.join(" "),
        env,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proof_tools::catalogue;

    fn fill() -> Fill {
        Fill {
            files: vec!["a.ts".into(), "b.ts".into()],
            ranges: vec!["a.ts:1-2".into(), "b.ts:7-7".into()],
            diff: Some("/tmp/proof/change.diff".into()),
            base: Some("abc123".into()),
            schema: Some("openapi.yaml".into()),
            base_url: Some("http://127.0.0.1:8000".into()),
            config: Some(".semgrep.yml".into()),
            out: Some("/tmp/proof/out".into()),
        }
    }

    // ---- the template language -------------------------------------------------------------------------------------------

    #[test]
    fn a_fixed_word_is_plain_text_and_nothing_else() {
        assert!(literal_ok("--only-changed=main"));
        assert!(literal_ok("a@b/c.d:e+f,g-h_i"));
        assert!(!literal_ok(""));
        assert!(!literal_ok("a b"));
        assert!(!literal_ok("a;b"));
        assert!(!literal_ok("$HOME"));
        assert!(!literal_ok("ünï"));
        assert!(!literal_ok(&"a".repeat(121)));
        assert!(literal_ok(&"a".repeat(120)));
    }

    #[test]
    fn a_template_with_a_shell_operator_a_glob_or_an_unknown_placeholder_is_refused() {
        for bad in [
            "npx stryker run; rm -rf x",
            "cargo test | tee out",
            "cargo test > out",
            "cargo test && true",
            "echo $HOME",
            "echo `id`",
            "echo $(id)",
            "echo 'x'",
            "ls *.ts",
            "ls ?.ts",
            "echo a\\b",
            "echo ~",
            "echo #x",
            "echo !x",
            "tool {nothing}",
            "tool {files",
            "tool files}",
            "tool \"{ranges}",
            "tool a{files}",
            "tool {files}x",
            "tool  twice",
            "",
            "   ",
            "FOO=1 tool",
            "-tool run",
            "{files}",
            "tool a\nb",
            "tool a\tb",
        ] {
            assert!(check_template(bad).is_err(), "should be refused: {bad:?}");
        }
        assert!(check_template(&format!("tool {}", "a".repeat(300))).is_err());
    }

    #[test]
    fn a_template_with_quotes_around_a_placeholder_and_a_mixed_word_is_accepted() {
        for good in [
            "npx stryker run --mutate \"{ranges}\"",
            "npx playwright test --only-changed={base}",
            "cargo mutants --in-diff {diff} --baseline skip --timeout 300 --output {out}",
            "schemathesis run {schema} --url {baseUrl}",
            "ast-grep scan --json=stream {files}",
            "semgrep scan --metrics=off --error --json --config {config} --baseline-commit {base}",
            "mutmut run",
        ] {
            check_template(good).unwrap_or_else(|why| panic!("{good}: {why}"));
        }
    }

    // ---- filling it ---------------------------------------------------------------------------------------------------------

    #[test]
    fn ranges_are_one_comma_joined_argument_and_the_line_names_only_a_variable() {
        let ready =
            prepare_with("npx stryker run --mutate \"{ranges}\"", &fill(), Shell::Sh).unwrap();
        assert_eq!(
            ready.argv,
            [
                "npx",
                "--no-install",
                "stryker",
                "run",
                "--mutate",
                "a.ts:1-2,b.ts:7-7"
            ]
        );
        assert_eq!(
            ready.command,
            "npx --no-install stryker run --mutate \"$MONOCODE_PROOF_0\""
        );
        assert_eq!(
            ready.env,
            vec![(
                "MONOCODE_PROOF_0".to_string(),
                "a.ts:1-2,b.ts:7-7".to_string()
            )]
        );
        assert!(!ready.command.contains("a.ts"));
    }

    #[test]
    fn a_word_that_mixes_fixed_text_and_a_value_keeps_the_text_and_quotes_the_value() {
        let ready = prepare_with(
            "npx playwright test --only-changed={base}",
            &fill(),
            Shell::Sh,
        )
        .unwrap();
        assert_eq!(
            ready.argv,
            [
                "npx",
                "--no-install",
                "playwright",
                "test",
                "--only-changed=abc123"
            ]
        );
        assert_eq!(
            ready.command,
            "npx --no-install playwright test --only-changed=\"$MONOCODE_PROOF_0\""
        );
    }

    #[test]
    fn a_file_name_with_a_space_a_quote_a_semicolon_or_a_substitution_stays_one_argument() {
        let names = [
            "a b.ts",
            "say \"hi\".ts",
            "it's.ts",
            "x;y.ts",
            "$(touch pwned).ts",
            "`id`.ts",
            "ünï côdé.ts",
            "-rf",
            "../up/..x.ts",
            "*.ts",
            "a|b&c>d.ts",
        ];
        let all = Fill {
            files: names.iter().map(|name| name.to_string()).collect(),
            ..Fill::default()
        };
        for shell in [Shell::Sh, Shell::Cmd] {
            let files: Vec<String> = names
                .iter()
                .filter(|name| shell == Shell::Sh || cmd_value_safe(name))
                .map(|name| name.to_string())
                .collect();
            let fill = Fill {
                files: if shell == Shell::Sh {
                    all.files.clone()
                } else {
                    files
                },
                ..Fill::default()
            };
            let ready = prepare_with("ast-grep scan {files}", &fill, shell).unwrap();
            assert_eq!(&ready.argv[..2], ["ast-grep", "scan"]);
            assert_eq!(ready.argv[2..], fill.files[..]);
            assert_eq!(ready.env.len(), fill.files.len());
            for name in &fill.files {
                assert!(
                    !ready.command.contains(name.as_str()),
                    "{name} must not be in {}",
                    ready.command
                );
            }
        }
    }

    #[test]
    fn cmd_takes_percent_references_and_refuses_what_cmd_would_read() {
        let ready = prepare_with("ast-grep scan {files}", &fill(), Shell::Cmd).unwrap();
        assert_eq!(
            ready.command,
            "ast-grep scan \"%MONOCODE_PROOF_0%\" \"%MONOCODE_PROOF_1%\""
        );
        for bad in [
            "a\"b",
            "50%",
            "a&b",
            "a|b",
            "a<b",
            "a>b",
            "a^b",
            "wow!",
            "tab\tname",
        ] {
            assert!(!cmd_value_safe(bad), "{bad}");
            let one = Fill {
                files: vec![bad.to_string()],
                ..Fill::default()
            };
            assert!(
                prepare_with("ast-grep scan {files}", &one, Shell::Cmd).is_err(),
                "{bad}"
            );
        }
        assert!(cmd_value_safe("a b.ts") && cmd_value_safe("ünï.ts") && cmd_value_safe("x;y.ts"));
    }

    #[test]
    fn a_value_with_a_nul_or_a_line_break_is_refused_by_every_shell() {
        for bad in ["a\0b", "a\nb", "a\rb", ""] {
            let one = Fill {
                files: vec![bad.to_string()],
                ..Fill::default()
            };
            for shell in [Shell::Sh, Shell::Cmd] {
                let why = prepare_with("ast-grep scan {files}", &one, shell).unwrap_err();
                assert!(why.contains("safely"), "{bad:?}: {why}");
            }
        }
        let long = Fill {
            files: vec!["x".repeat(VALUE_MAX + 1)],
            ..Fill::default()
        };
        assert!(prepare_with("ast-grep scan {files}", &long, Shell::Sh).is_err());
    }

    #[test]
    fn a_run_missing_an_input_says_which_and_never_guesses_one() {
        let none = Fill::default();
        let cases = [
            ("ast-grep scan {files}", "no changed file"),
            ("npx stryker run --mutate \"{ranges}\"", "no changed line"),
            ("cargo mutants --in-diff {diff}", "no diff"),
            ("npx playwright test --only-changed={base}", "no revision"),
            ("schemathesis run {schema} --url x", "no OpenAPI file"),
            ("schemathesis run x --url {baseUrl}", "declares no base URL"),
            ("semgrep scan --config {config}", "no rules file"),
            ("cargo mutants --output {out}", "no folder"),
        ];
        for (template, words) in cases {
            let why = prepare_with(template, &none, Shell::Sh).unwrap_err();
            assert!(why.contains(words), "{template}: {why}");
        }
        // An empty string is no value at all.
        let empty = Fill {
            base_url: Some(String::new()),
            ..Fill::default()
        };
        assert!(prepare_with("schemathesis run x --url {baseUrl}", &empty, Shell::Sh).is_err());
    }

    #[test]
    fn more_than_the_file_limit_is_too_many_to_pass_not_a_silent_cut() {
        let many = Fill {
            files: (0..=FILES_MAX).map(|n| format!("f{n}.ts")).collect(),
            ..Fill::default()
        };
        let why = prepare_with("ast-grep scan {files}", &many, Shell::Sh).unwrap_err();
        assert!(
            why.contains("201 changed files") && why.contains("too many to pass"),
            "{why}"
        );
        let edge = Fill {
            files: (0..FILES_MAX).map(|n| format!("f{n}.ts")).collect(),
            ..Fill::default()
        };
        let ready = prepare_with("ast-grep scan {files}", &edge, Shell::Sh).unwrap();
        assert_eq!(ready.env.len(), FILES_MAX);
    }

    #[test]
    fn npx_never_downloads_a_tool() {
        let ready = prepare_with("npx e2e run --strict-cache", &fill(), Shell::Sh).unwrap();
        assert_eq!(ready.argv[..2], ["npx", "--no-install"]);
        assert_eq!(ready.command, "npx --no-install e2e run --strict-cache");
        // Said already: not doubled.
        let said = prepare_with("npx --no-install e2e run", &fill(), Shell::Sh).unwrap();
        assert_eq!(
            said.argv
                .iter()
                .filter(|word| *word == "--no-install")
                .count(),
            1
        );
        let no = prepare_with("npx --no e2e run", &fill(), Shell::Sh).unwrap();
        assert_eq!(no.argv[1], "--no");
        // A program that isn't npx is left as it is.
        let cargo = prepare_with("cargo mutants --version", &fill(), Shell::Sh).unwrap();
        assert_eq!(cargo.argv, ["cargo", "mutants", "--version"]);
        assert!(cargo.env.is_empty());
    }

    #[test]
    fn a_probe_is_a_fixed_argv_and_anything_odd_in_it_goes_through_the_environment() {
        let probe = prepare_argv(&["cargo", "mutants", "--version"]);
        assert_eq!(probe.command, "cargo mutants --version");
        assert!(probe.env.is_empty());
        let odd = prepare_argv(&["tool", "a b;c"]);
        assert_eq!(odd.argv, ["tool", "a b;c"]);
        assert!(!odd.command.contains("a b;c"));
        assert_eq!(odd.env.len(), 1);
        let bad = prepare_argv(&["tool", "a\nb"]);
        assert_eq!(bad.argv, ["tool", ""]);
        assert!(bad.env.is_empty());
        assert_eq!(
            prepare_argv(&["npx", "x"]).argv,
            ["npx", "--no-install", "x"]
        );
    }

    #[test]
    fn shown_reads_like_a_command_and_wraps_what_needs_it() {
        let ready = prepare_with(
            "ast-grep scan {files}",
            &Fill {
                files: vec!["a b.ts".into(), "say \"hi\".ts".into(), "plain.ts".into()],
                ..Fill::default()
            },
            Shell::Sh,
        )
        .unwrap();
        assert_eq!(
            ready.shown(),
            "ast-grep scan \"a b.ts\" \"say \\\"hi\\\".ts\" plain.ts"
        );
        let long = Prepared {
            argv: vec!["x".repeat(200)],
            command: String::new(),
            env: Vec::new(),
        };
        assert_eq!(long.shown().chars().count(), SHOWN_WORD_MAX);
        assert!(long.shown().ends_with('…'));
    }

    // ---- the catalogue ------------------------------------------------------------------------------------------------------

    #[test]
    fn every_catalogue_command_passes_the_template_check_and_prepares_with_a_full_fill() {
        let mut ran = 0;
        for tool in catalogue::tools() {
            for template in tool.run.iter().chain(tool.run_also.iter()) {
                check_template(template).unwrap_or_else(|why| panic!("{}: {why}", tool.id));
                for shell in [Shell::Sh, Shell::Cmd] {
                    let ready = prepare_with(template, &fill(), shell)
                        .unwrap_or_else(|why| panic!("{}: {why}", tool.id));
                    assert!(
                        !ready.argv.is_empty() && !ready.command.is_empty(),
                        "{}",
                        tool.id
                    );
                    if ready.argv[0] == "npx" {
                        assert_eq!(ready.argv[1], "--no-install", "{}", tool.id);
                    }
                    for (_, value) in &ready.env {
                        assert!(!ready.command.contains(value.as_str()), "{}", tool.id);
                    }
                }
                ran += 1;
            }
        }
        assert!(ran >= 8, "{ran} commands were checked");
    }

    #[test]
    fn the_catalogue_commands_build_the_argv_each_tool_documents() {
        let argv = |id: &str| {
            let tool = catalogue::find(id).unwrap();
            prepare_with(tool.run.as_deref().unwrap(), &fill(), Shell::Sh)
                .unwrap()
                .argv
        };
        assert_eq!(
            argv("stryker"),
            [
                "npx",
                "--no-install",
                "stryker",
                "run",
                "--mutate",
                "a.ts:1-2,b.ts:7-7"
            ]
        );
        assert_eq!(
            argv("cargo-mutants"),
            [
                "cargo",
                "mutants",
                "--in-diff",
                "/tmp/proof/change.diff",
                "--baseline",
                "skip",
                "--timeout",
                "300",
                "--output",
                "/tmp/proof/out"
            ]
        );
        assert_eq!(
            argv("schemathesis"),
            [
                "schemathesis",
                "run",
                "openapi.yaml",
                "--url",
                "http://127.0.0.1:8000"
            ]
        );
        assert_eq!(
            argv("semgrep"),
            [
                "semgrep",
                "scan",
                "--metrics=off",
                "--error",
                "--json",
                "--config",
                ".semgrep.yml",
                "--baseline-commit",
                "abc123"
            ]
        );
        assert_eq!(
            argv("ast-grep"),
            ["ast-grep", "scan", "--json=stream", "a.ts", "b.ts"]
        );
        assert_eq!(
            argv("playwright"),
            [
                "npx",
                "--no-install",
                "playwright",
                "test",
                "--only-changed=abc123"
            ]
        );
        assert_eq!(
            argv("e2e"),
            ["npx", "--no-install", "e2e", "run", "--strict-cache"]
        );
    }

    // ---- through a real shell ---------------------------------------------------------------------------------------------

    #[cfg(unix)]
    struct Scratch(std::path::PathBuf);

    #[cfg(unix)]
    impl Scratch {
        fn new() -> Scratch {
            use std::sync::atomic::{AtomicUsize, Ordering};
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "monocode-proof-command-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    #[cfg(unix)]
    impl Drop for Scratch {
        fn drop(&mut self) {
            // Only the folder this test made, under the temp folder, by its own prefix.
            if self.0.starts_with(std::env::temp_dir())
                && self.0.file_name().is_some_and(|name| {
                    name.to_string_lossy()
                        .starts_with("monocode-proof-command-")
                })
            {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[cfg(unix)]
    fn run_in(dir: &std::path::Path, ready: &Prepared) -> Vec<String> {
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&ready.command)
            .current_dir(dir)
            .envs(ready.env.iter().cloned())
            .output()
            .expect("sh runs");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[cfg(unix)]
    fn helper(dir: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("args.sh");
        std::fs::write(
            &path,
            "#!/bin/sh\nfor a in \"$@\"; do printf '<%s>\\n' \"$a\"; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_real_shell_hands_each_awkward_file_name_over_as_exactly_one_argument() {
        let scratch = Scratch::new();
        helper(&scratch.0);
        let names = [
            "a b.ts",
            "say \"hi\".ts",
            "it's.ts",
            "x;y.ts",
            "$(touch pwned).ts",
            "`touch pwned2`.ts",
            "ünï côdé.ts",
            "-rf",
            "../up/..x.ts",
            "*.ts",
            "a|b&c>d.ts",
            "  spaced  ",
        ];
        let fill = Fill {
            files: names.iter().map(|name| name.to_string()).collect(),
            ..Fill::default()
        };
        let ready = prepare_with("./args.sh {files}", &fill, Shell::Sh).unwrap();
        let got = run_in(&scratch.0, &ready);
        let want: Vec<String> = names.iter().map(|name| format!("<{name}>")).collect();
        assert_eq!(got, want);
        assert!(!scratch.0.join("pwned").exists() && !scratch.0.join("pwned2").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_real_shell_reads_a_mixed_word_and_a_comma_joined_range_as_one_argument_each() {
        let scratch = Scratch::new();
        helper(&scratch.0);
        let fill = Fill {
            base: Some("main branch; echo hi".into()),
            ranges: vec!["a b.ts:1-2".into(), "c;d.ts:3-3".into()],
            ..Fill::default()
        };
        let ready = prepare_with(
            "./args.sh --only-changed={base} \"{ranges}\"",
            &fill,
            Shell::Sh,
        )
        .unwrap();
        assert_eq!(
            run_in(&scratch.0, &ready),
            [
                "<--only-changed=main branch; echo hi>",
                "<a b.ts:1-2,c;d.ts:3-3>"
            ]
        );
    }
}
