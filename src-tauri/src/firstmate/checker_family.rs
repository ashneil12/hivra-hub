//! SC-5: which agent CLI and model reads a finished task's claims when the running checker runs, and how each CLI is
//! started for one tool-free answer (docs/specs/shipping-confidence-gap-spec.md section 4d.2 and 4d.4).
//!
//! The checker should not share the worker's blind spots, so by default it comes from a different model family than the
//! worker's: a Claude worker is checked by a non-Claude CLI the person has signed in (the provider probe
//! `crew::live_presence` says which), and any other worker by Claude. The rule is the app's own setting
//! (`checker_family_rule`, kept in the app's database, never read from a project's files): `different` (the default) or
//! `any`. When only the worker's own family is signed in the checker is a different model of that family, and the task's
//! row says so ("Checked by the same family: only Claude is signed in."). Nothing falls back silently.
//!
//! Only CLIs that can be started for one answer with no tools are checkers (`checker_runner`): Claude, Codex and Grok. Any
//! other CLI is never picked, and says why.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::crew::resolve::Presence;

/// The key of the rule in the app's `checker_settings` table.
pub const RULE_KEY: &str = "checker_family_rule";

/// What the person asked of the checker's family.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FamilyRule {
    /// A model from another family than the worker's, when one is signed in.
    #[default]
    Different,
    /// The strongest checker signed in, whatever the worker used.
    Any,
}

impl FamilyRule {
    pub fn word(self) -> &'static str {
        match self {
            FamilyRule::Different => "different",
            FamilyRule::Any => "any",
        }
    }

    /// A stored or sent word. Anything this build doesn't know is not a rule.
    pub fn parse(word: &str) -> Option<FamilyRule> {
        match word.trim().to_ascii_lowercase().as_str() {
            "different" => Some(FamilyRule::Different),
            "any" => Some(FamilyRule::Any),
            _ => None,
        }
    }
}

// ---- the setting --------------------------------------------------------------------------------------------------------

/// The app's checker settings: a key and a value, beside the app's other settings tables.
pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS checker_settings (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );",
    )
}

/// The rule. A missing row, an unreadable table or a word this build doesn't know (a newer build wrote it) is the
/// default, `different`: the stricter one.
pub fn rule_of(conn: &Connection) -> FamilyRule {
    let stored: Option<String> = ensure_tables(conn)
        .ok()
        .and_then(|_| {
            conn.query_row(
                "SELECT value FROM checker_settings WHERE key = ?1",
                params![RULE_KEY],
                |row| row.get(0),
            )
            .optional()
            .ok()
        })
        .flatten();
    stored
        .as_deref()
        .and_then(FamilyRule::parse)
        .unwrap_or_default()
}

/// Sets the rule. The person's latest choice wins: it is one value written whole, not changed from a value read earlier.
pub fn set_rule(conn: &Connection, rule: FamilyRule) -> Result<(), String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO checker_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![RULE_KEY, rule.word()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The rule, for the Settings screen.
#[tauri::command(async)]
pub fn checker_family_rule_get(
    store: tauri::State<'_, crate::session_store::SessionStore>,
) -> Result<FamilyRule, String> {
    Ok(rule_of(&*store.lock_conn()?))
}

/// Sets the rule from a word the webview sent. A word this build doesn't know is refused, never stored.
#[tauri::command(async)]
pub fn checker_family_rule_set(
    store: tauri::State<'_, crate::session_store::SessionStore>,
    rule: String,
) -> Result<FamilyRule, String> {
    let rule = FamilyRule::parse(&rule).ok_or("The rule is \"different\" or \"any\".")?;
    set_rule(&*store.lock_conn()?, rule)?;
    Ok(rule)
}

// ---- families -----------------------------------------------------------------------------------------------------------

/// Who trained the model behind a CLI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    Anthropic,
    OpenAi,
    Xai,
    /// A CLI that hosts many models, or one this build doesn't know. It is never taken to share a family with another.
    Unknown,
}

/// The family of a worker's CLI and model id (`claude:sonnet-5`, `codex:gpt-5`, `opencode:anthropic/claude-…`). A CLI that
/// hosts other vendors' models is read from the model id; one it can't read is `Unknown`.
pub fn family_of(cli: &str, model: &str) -> Family {
    match cli.trim().to_ascii_lowercase().as_str() {
        "claude" => return Family::Anthropic,
        "codex" => return Family::OpenAi,
        "grok" => return Family::Xai,
        _ => {}
    }
    let model = model.to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|word| model.contains(word));
    if has(&["claude", "anthropic", "opus", "sonnet", "haiku", "fable"]) {
        Family::Anthropic
    } else if has(&["gpt", "openai", "codex", "o3", "o4"]) {
        Family::OpenAi
    } else if has(&["grok", "xai"]) {
        Family::Xai
    } else {
        Family::Unknown
    }
}

/// The CLIs that can be started for one tool-free answer, best checker first.
const CHECKERS: [&str; 3] = ["claude", "codex", "grok"];

fn display_name(cli: &str) -> &str {
    match cli {
        "claude" => "Claude",
        "codex" => "Codex",
        "grok" => "Grok",
        other => other,
    }
}

/// The worker's CLI and model, as its chat recorded them. Empty when the chat is gone.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Worker {
    pub cli: String,
    pub model: String,
}

/// The checker chosen for one task: which CLI, which model, and what to say about it on the task's row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pick {
    pub cli: String,
    /// The model the checker runs on. Empty: the CLI's own default.
    pub model: String,
    /// The strongest model of this CLI that is signed in, for the rethink step (`rounds`). Empty: the CLI's own default.
    pub strong_model: String,
    /// "Checked by the same family: only Claude is signed in." Present only when the rule couldn't be kept.
    pub note: Option<String>,
}

impl Pick {
    /// The CLI's name as a person says it: `Claude`, `Codex`.
    pub fn name(&self) -> String {
        display_name(&self.cli).to_string()
    }

    /// The checker as one plain phrase: `Codex`, or `Claude (opus)`.
    pub fn label(&self) -> String {
        if self.model.is_empty() {
            self.name()
        } else {
            format!("{} ({})", self.name(), self.model)
        }
    }
}

/// The Claude model a same-family check runs on: Opus when the worker ran on anything else, Sonnet when it ran on Opus.
fn other_claude_model(worker_model: &str) -> &'static str {
    if worker_model.to_ascii_lowercase().contains("opus") {
        "sonnet"
    } else {
        "opus"
    }
}

fn pick_of(cli: &str, model: &str, note: Option<String>) -> Pick {
    Pick {
        cli: cli.to_string(),
        model: model.to_string(),
        strong_model: if cli == "claude" { "opus" } else { "" }.to_string(),
        note,
    }
}

/// The checker for a worker, from the rule and the CLIs the provider probe says are installed and signed in. `Err` says in
/// plain words why there is none: the round then says it could not run, never that it passed.
pub fn pick(rule: FamilyRule, worker: &Worker, present: &[Presence]) -> Result<Pick, String> {
    let usable: Vec<&str> = CHECKERS
        .iter()
        .copied()
        .filter(|cli| {
            present
                .iter()
                .any(|row| row.cli == *cli && row.installed && row.signed_in)
        })
        .collect();
    if usable.is_empty() {
        return Err(
            "No checker is available: Claude, Codex or Grok must be installed and signed in."
                .into(),
        );
    }
    let worker_family = family_of(&worker.cli, &worker.model);
    // A worker whose engine wasn't recorded is taken to be the default one, Claude, and the row says so.
    let (worker_family, unknown_engine) = if worker.cli.trim().is_empty() {
        (Family::Anthropic, true)
    } else {
        (worker_family, false)
    };
    if rule == FamilyRule::Any {
        let cli = usable[0];
        let model = if cli == "claude" { "opus" } else { "" };
        return Ok(pick_of(cli, model, None));
    }
    // A different family, in the order of CHECKERS.
    if let Some(cli) = usable.iter().copied().find(|cli| {
        let family = family_of(cli, "");
        family != worker_family || worker_family == Family::Unknown
    }) {
        let model = if cli == "claude" { "sonnet" } else { "" };
        let note = unknown_engine.then(|| {
            "The worker's engine wasn't recorded, so it was taken to be Claude and the checker is another family."
                .to_string()
        });
        return Ok(pick_of(cli, model, note));
    }
    // Only the worker's own family is signed in: a different model of it, and the row says so. Never silent.
    let cli = usable[0];
    let name = display_name(cli);
    if cli == "claude" {
        let model = other_claude_model(&worker.model);
        return Ok(pick_of(
            cli,
            model,
            Some(format!(
                "Checked by the same family: only {name} is signed in."
            )),
        ));
    }
    Ok(pick_of(
        cli,
        "",
        Some(format!(
            "Checked by the same family: only {name} is signed in. It has no other model here, so the checker is the same model."
        )),
    ))
}

// ---- starting a CLI for one answer ---------------------------------------------------------------------------------------

/// What to start for one tool-free answer: the program, its arguments, the prompt (on stdin, or in a file in the scratch
/// folder when the CLI takes it from one) and where it runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OneShot {
    pub program: String,
    pub args: Vec<String>,
    /// The prompt, written to the child's stdin. None: the prompt is in `files`.
    pub stdin: Option<String>,
    /// Files to write in the scratch folder before starting: a name inside it and its text.
    pub files: Vec<(String, String)>,
}

/// The name of the prompt file for a CLI that reads its prompt from one.
const PROMPT_FILE: &str = "checker-prompt.txt";

/// How `cli` starts for one answer with no tools and nothing kept: the prompt goes in, the answer comes out on stdout.
/// `binary` is the resolved program, `model` empty for the CLI's own default, `scratch` the fresh folder it may write in.
///
/// - Claude: print mode with every tool removed, no MCP servers and no session kept (the same flags as the cheap check).
/// - Codex: `exec` with a read-only sandbox, no session kept and no approval prompts; it has no flag that removes its
///   tools, so the read-only sandbox and the app's sandbox around it are what keep it from changing anything.
/// - Grok: single-turn headless mode with the tools it may use named as none, one turn, no sub-agents and no web.
///
/// Any other CLI has no such mode here and is refused in plain words. Never a guess.
pub fn checker_runner(
    cli: &str,
    model: &str,
    binary: &str,
    scratch: &Path,
    prompt: &str,
) -> Result<OneShot, String> {
    let model = model.trim();
    let mut args: Vec<String> = Vec::new();
    match cli {
        "claude" => {
            args.push("-p".into());
            if !model.is_empty() {
                args.extend(["--model".into(), model.into()]);
            }
            args.extend(
                [
                    "--output-format",
                    "text",
                    "--tools",
                    "",
                    "--strict-mcp-config",
                    "--no-session-persistence",
                ]
                .map(String::from),
            );
            Ok(OneShot {
                program: binary.into(),
                args,
                stdin: Some(prompt.into()),
                files: Vec::new(),
            })
        }
        "codex" => {
            args.extend(
                [
                    "exec",
                    "--sandbox",
                    "read-only",
                    "--ephemeral",
                    "--skip-git-repo-check",
                    "--color",
                    "never",
                    "-c",
                    "approval_policy=\"never\"",
                ]
                .map(String::from),
            );
            if !model.is_empty() {
                args.extend(["-m".into(), model.into()]);
            }
            // `-` reads the instructions from stdin.
            args.push("-".into());
            Ok(OneShot {
                program: binary.into(),
                args,
                stdin: Some(prompt.into()),
                files: Vec::new(),
            })
        }
        "grok" => {
            args.extend(
                [
                    "--no-auto-update",
                    "--permission-mode",
                    "dontAsk",
                    "--max-turns",
                    "1",
                    "--no-subagents",
                    "--disable-web-search",
                    "--no-plan",
                    "--tools",
                    "",
                    "--output-format",
                    "plain",
                ]
                .map(String::from),
            );
            if !model.is_empty() {
                args.extend(["--model".into(), model.into()]);
            }
            let file = scratch.join(PROMPT_FILE);
            args.extend([
                "--prompt-file".into(),
                file.to_string_lossy().into_owned(),
            ]);
            Ok(OneShot {
                program: binary.into(),
                args,
                stdin: None,
                files: vec![(PROMPT_FILE.into(), prompt.into())],
            })
        }
        other => Err(format!(
            "{other} has no one-answer mode without tools in this build, so it is never used as a checker."
        )),
    }
}

// ---- the worker's engine and the environment a checker's CLI gets ---------------------------------------------------------

/// The CLI and model a task's worker ran on, from its chat (`sessions`), through the delegation's `child_session`. A chat
/// that is gone, or a row that can't be read, is an empty `Worker`: the pick then says it assumed the default engine.
pub fn worker_of(conn: &Connection, delegation_id: &str) -> Worker {
    let found: Option<(String, String)> = conn
        .query_row(
            "SELECT s.harness, s.model FROM delegations d JOIN sessions s ON s.id = d.child_session WHERE d.id = ?1",
            params![delegation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .ok()
        .flatten();
    found
        .map(|(cli, model)| Worker { cli, model })
        .unwrap_or_default()
}

/// The names a checker's CLI keeps from the app's environment: the places it finds its own sign-in, a proxy and
/// certificates, and the locale. Everything else, every other credential the app holds included, is dropped.
const ENV_KEPT: [&str; 22] = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "XAI_API_KEY",
    "GROK_CODE_XAI_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
];

/// What of `vars` a checker's CLI is started with.
pub fn allowed_env(
    vars: impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    vars.filter(|(name, _)| name.to_str().is_some_and(|name| ENV_KEPT.contains(&name)))
        .collect()
}

/// The folder a one-answer call runs in: fresh, empty, and a direct child of the temp folder, so it can be proved before it
/// is deleted.
const SCRATCH_PREFIX: &str = "monocode-checker-call-";

/// Deletes `path` only when it is a folder this module made: a direct child of the temp folder with its prefix.
fn remove_scratch(path: &Path) {
    let Ok(real) = crate::fs::canonical(path) else {
        return;
    };
    let Ok(temp) = crate::fs::canonical(std::env::temp_dir()) else {
        return;
    };
    let named = real
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(SCRATCH_PREFIX));
    if real.parent() == Some(temp.as_path()) && named {
        let _ = std::fs::remove_dir_all(real);
    }
}

/// One tool-free answer from `cli` on `model` (empty: its default), the prompt in, the text out. The CLI starts in a fresh
/// empty folder with only the environment `allowed_env` keeps, and under the agent sandbox like the cheap check: the binary
/// is one a worker could have replaced, and under the sandbox that still can't reach a secret or the switch file. It is
/// killed at `timeout`. A timeout, a failed start or a non-zero exit is an error in plain words, which the round reads as
/// "could not run", never as a verdict.
pub fn checker_cli(
    cli: &str,
    model: &str,
    prompt: &str,
    timeout: std::time::Duration,
) -> Result<String, String> {
    use std::process::{Command, Stdio};
    let binary = match cli {
        "claude" => crate::harness::harness_resolve_claude()?.path,
        "codex" => crate::harness::harness_resolve_codex()?.path,
        "grok" => crate::harness::harness_resolve_grok()?.path,
        other => {
            // The same words `checker_runner` refuses with.
            return checker_runner(other, model, "", Path::new(""), prompt).map(|_| String::new());
        }
    };
    let scratch = std::env::temp_dir().join(format!(
        "{SCRATCH_PREFIX}{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let result = (|| {
        let one = checker_runner(cli, model, &binary, &scratch, prompt)?;
        for (name, text) in &one.files {
            std::fs::write(scratch.join(name), text)
                .map_err(|e| format!("the checker's prompt couldn't be written: {e}"))?;
        }
        let mut cmd = Command::new(&one.program);
        cmd.args(&one.args)
            .current_dir(&scratch)
            .stdin(if one.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear();
        for (name, value) in allowed_env(std::env::vars_os()) {
            cmd.env(name, value);
        }
        cmd.env("TMPDIR", &scratch);
        crate::harness::apply_gui_env(&mut cmd);
        // Tests do not start a CLI: it would read the daily data folder.
        #[cfg(not(test))]
        {
            let data = crate::instance::data_dir(&crate::instance::current().identifier);
            let prefix = crate::agent_sandbox::action_wrap(data.as_deref(), &[])?;
            cmd = crate::agent_sandbox::under_wrap(cmd, prefix.as_deref());
        }
        super::gates::run_child(cmd, one.stdin.as_deref(), timeout, display_name(cli))
    })();
    remove_scratch(&scratch);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn present(rows: &[(&str, bool, bool)]) -> Vec<Presence> {
        rows.iter()
            .map(|(cli, installed, signed_in)| Presence {
                cli: (*cli).to_string(),
                installed: *installed,
                signed_in: *signed_in,
            })
            .collect()
    }

    fn worker(cli: &str, model: &str) -> Worker {
        Worker {
            cli: cli.into(),
            model: model.into(),
        }
    }

    // ---- the pick ---------------------------------------------------------------------------------------------------

    #[test]
    fn a_claude_worker_with_codex_signed_in_is_checked_by_codex() {
        let got = pick(
            FamilyRule::Different,
            &worker("claude", "claude:sonnet-5"),
            &present(&[("claude", true, true), ("codex", true, true)]),
        )
        .unwrap();
        assert_eq!(got.cli, "codex");
        assert_eq!(got.note, None);
        assert_eq!(got.label(), "Codex");
    }

    #[test]
    fn a_claude_worker_with_nothing_else_signed_in_gets_a_different_claude_model_and_a_note_on_the_row(
    ) {
        let only_claude = present(&[
            ("claude", true, true),
            ("codex", true, false),
            ("grok", false, false),
        ]);
        // Sonnet worker, Opus checker.
        let got = pick(
            FamilyRule::Different,
            &worker("claude", "claude:sonnet-5"),
            &only_claude,
        )
        .unwrap();
        assert_eq!((got.cli.as_str(), got.model.as_str()), ("claude", "opus"));
        assert_eq!(
            got.note.as_deref(),
            Some("Checked by the same family: only Claude is signed in.")
        );
        // Opus worker, Sonnet checker.
        let got = pick(
            FamilyRule::Different,
            &worker("claude", "claude:opus-5-5"),
            &only_claude,
        )
        .unwrap();
        assert_eq!(got.model, "sonnet");
        assert!(got.note.is_some());
        // The cheap Haiku is for the cheap check only: a Haiku worker is checked on Opus.
        let got = pick(
            FamilyRule::Different,
            &worker("claude", "claude:haiku-4.5"),
            &only_claude,
        )
        .unwrap();
        assert_eq!(got.model, "opus");
    }

    #[test]
    fn a_codex_worker_is_checked_by_claude() {
        let got = pick(
            FamilyRule::Different,
            &worker("codex", "codex:gpt-5"),
            &present(&[("claude", true, true), ("codex", true, true)]),
        )
        .unwrap();
        assert_eq!(got.cli, "claude");
        assert_eq!(got.note, None);
        // A different-family Claude check runs on Sonnet, and its rethink step on Opus.
        assert_eq!(got.model, "sonnet");
        assert_eq!(got.strong_model, "opus");
    }

    #[test]
    fn a_codex_worker_with_only_codex_signed_in_says_the_checker_is_the_same_model() {
        let got = pick(
            FamilyRule::Different,
            &worker("codex", "codex:gpt-5"),
            &present(&[("claude", true, false), ("codex", true, true)]),
        )
        .unwrap();
        assert_eq!(got.cli, "codex");
        let note = got.note.unwrap();
        assert!(
            note.starts_with("Checked by the same family: only Codex is signed in."),
            "{note}"
        );
        assert!(note.contains("same model"), "{note}");
    }

    #[test]
    fn a_grok_worker_is_checked_by_claude_and_a_claude_worker_can_fall_to_grok_when_codex_is_not_signed_in(
    ) {
        let got = pick(
            FamilyRule::Different,
            &worker("grok", "grok:grok-4.6"),
            &present(&[("claude", true, true), ("grok", true, true)]),
        )
        .unwrap();
        assert_eq!(got.cli, "claude");
        let got = pick(
            FamilyRule::Different,
            &worker("claude", "claude:sonnet-5"),
            &present(&[
                ("claude", true, true),
                ("codex", true, false),
                ("grok", true, true),
            ]),
        )
        .unwrap();
        assert_eq!(got.cli, "grok");
        assert_eq!(got.note, None);
    }

    #[test]
    fn installed_but_signed_out_and_signed_in_but_missing_are_not_available() {
        let err = pick(
            FamilyRule::Different,
            &worker("claude", "claude:sonnet-5"),
            &present(&[("claude", true, false), ("codex", false, true)]),
        )
        .unwrap_err();
        assert!(err.contains("No checker is available"), "{err}");
        assert!(pick(FamilyRule::Different, &worker("claude", ""), &[]).is_err());
        // A CLI this build can't start for one answer is never a checker, however signed in it is.
        let err = pick(
            FamilyRule::Different,
            &worker("claude", "claude:sonnet-5"),
            &present(&[("opencode", true, true), ("pi", true, true)]),
        )
        .unwrap_err();
        assert!(err.contains("No checker is available"), "{err}");
    }

    #[test]
    fn a_worker_on_a_hosting_cli_is_read_by_its_model_and_an_unknown_one_matches_nothing() {
        assert_eq!(
            family_of("opencode", "opencode:anthropic/claude-sonnet-4.6"),
            Family::Anthropic
        );
        assert_eq!(family_of("opencode", "opencode:gpt-5.4"), Family::OpenAi);
        assert_eq!(family_of("opencode", "opencode:glm-5"), Family::Unknown);
        assert_eq!(family_of("CLAUDE", ""), Family::Anthropic);
        // A worker on an unknown model can be checked by anyone, Claude first.
        let got = pick(
            FamilyRule::Different,
            &worker("opencode", "opencode:glm-5"),
            &present(&[("claude", true, true), ("codex", true, true)]),
        )
        .unwrap();
        assert_eq!(got.cli, "claude");
        assert_eq!(got.note, None);
    }

    #[test]
    fn a_worker_whose_engine_was_not_recorded_is_taken_to_be_claude_and_the_row_says_so() {
        let got = pick(
            FamilyRule::Different,
            &Worker::default(),
            &present(&[("claude", true, true), ("codex", true, true)]),
        )
        .unwrap();
        assert_eq!(got.cli, "codex");
        assert!(got.note.unwrap().contains("wasn't recorded"));
    }

    #[test]
    fn any_takes_the_strongest_checker_signed_in_and_says_nothing() {
        let got = pick(
            FamilyRule::Any,
            &worker("claude", "claude:opus-5-5"),
            &present(&[("claude", true, true), ("codex", true, true)]),
        )
        .unwrap();
        assert_eq!((got.cli.as_str(), got.model.as_str()), ("claude", "opus"));
        assert_eq!(got.note, None);
    }

    // ---- the setting ------------------------------------------------------------------------------------------------

    #[test]
    fn the_rule_defaults_to_different_and_an_unknown_stored_word_is_the_default() {
        let conn = Connection::open_in_memory().unwrap();
        assert_eq!(rule_of(&conn), FamilyRule::Different);
        set_rule(&conn, FamilyRule::Any).unwrap();
        assert_eq!(rule_of(&conn), FamilyRule::Any);
        set_rule(&conn, FamilyRule::Different).unwrap();
        assert_eq!(rule_of(&conn), FamilyRule::Different);
        // A word a newer build wrote, or garbage, reads as the stricter default.
        for stored in ["same", "", "ANY ", "\u{0}"] {
            conn.execute(
                "UPDATE checker_settings SET value = ?1 WHERE key = ?2",
                params![stored, RULE_KEY],
            )
            .unwrap();
            let want = if stored.trim().eq_ignore_ascii_case("any") {
                FamilyRule::Any
            } else {
                FamilyRule::Different
            };
            assert_eq!(rule_of(&conn), want, "{stored:?}");
        }
        assert_eq!(FamilyRule::parse("Different"), Some(FamilyRule::Different));
        assert_eq!(FamilyRule::parse("same"), None);
    }

    #[test]
    fn two_writers_leave_one_whole_value_and_the_last_choice_wins() {
        let conn = Connection::open_in_memory().unwrap();
        set_rule(&conn, FamilyRule::Any).unwrap();
        set_rule(&conn, FamilyRule::Different).unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM checker_settings", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 1);
        assert_eq!(rule_of(&conn), FamilyRule::Different);
    }

    // ---- starting a CLI -------------------------------------------------------------------------------------------------

    fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    #[test]
    fn claude_starts_in_print_mode_with_no_tools_no_servers_and_no_session_and_the_prompt_on_stdin()
    {
        let scratch = Path::new("/tmp/scratch");
        let run = checker_runner("claude", "opus", "/bin/claude", scratch, "PROMPT").unwrap();
        assert_eq!(run.program, "/bin/claude");
        assert!(run.args.contains(&"-p".to_string()));
        assert!(has_pair(&run.args, "--model", "opus"));
        assert!(has_pair(&run.args, "--tools", ""));
        assert!(run.args.contains(&"--strict-mcp-config".to_string()));
        assert!(run.args.contains(&"--no-session-persistence".to_string()));
        assert!(has_pair(&run.args, "--output-format", "text"));
        assert_eq!(run.stdin.as_deref(), Some("PROMPT"));
        assert!(run.files.is_empty());
        // No model named is the CLI's own default.
        let run = checker_runner("claude", " ", "/bin/claude", scratch, "P").unwrap();
        assert!(!run.args.contains(&"--model".to_string()));
    }

    #[test]
    fn codex_starts_in_exec_mode_read_only_with_nothing_kept_and_the_prompt_on_stdin() {
        let run = checker_runner("codex", "", "/bin/codex", Path::new("/tmp/s"), "PROMPT").unwrap();
        assert_eq!(run.args.first().map(String::as_str), Some("exec"));
        assert!(has_pair(&run.args, "--sandbox", "read-only"));
        assert!(run.args.contains(&"--ephemeral".to_string()));
        assert!(has_pair(&run.args, "-c", "approval_policy=\"never\""));
        assert_eq!(run.args.last().map(String::as_str), Some("-"));
        assert_eq!(run.stdin.as_deref(), Some("PROMPT"));
        assert!(!run.args.contains(&"-m".to_string()));
        let run = checker_runner("codex", "gpt-5", "/bin/codex", Path::new("/tmp/s"), "P").unwrap();
        assert!(has_pair(&run.args, "-m", "gpt-5"));
        assert_eq!(run.args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn grok_starts_headless_for_one_turn_with_no_tools_and_the_prompt_in_a_file_in_the_scratch_folder(
    ) {
        let scratch = Path::new("/tmp/s");
        let run = checker_runner("grok", "", "/bin/grok", scratch, "PROMPT").unwrap();
        assert!(has_pair(&run.args, "--max-turns", "1"));
        assert!(has_pair(&run.args, "--tools", ""));
        assert!(has_pair(&run.args, "--permission-mode", "dontAsk"));
        assert!(run.args.contains(&"--no-subagents".to_string()));
        assert!(run.args.contains(&"--disable-web-search".to_string()));
        assert_eq!(run.stdin, None);
        assert_eq!(
            run.files,
            vec![("checker-prompt.txt".to_string(), "PROMPT".to_string())]
        );
        let file = scratch
            .join("checker-prompt.txt")
            .to_string_lossy()
            .into_owned();
        assert!(has_pair(&run.args, "--prompt-file", &file));
    }

    // ---- the worker's engine and the environment --------------------------------------------------------------------

    #[test]
    fn the_workers_engine_is_read_from_its_chat_and_a_missing_one_is_empty() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, harness TEXT NOT NULL, model TEXT NOT NULL);
             CREATE TABLE delegations (id TEXT PRIMARY KEY, child_session TEXT NOT NULL);
             INSERT INTO sessions VALUES ('chat-1', 'codex', 'codex:gpt-5');
             INSERT INTO delegations VALUES ('d-1', 'chat-1'), ('d-2', 'gone');",
        )
        .unwrap();
        assert_eq!(
            worker_of(&conn, "d-1"),
            Worker {
                cli: "codex".into(),
                model: "codex:gpt-5".into()
            }
        );
        // The chat was removed, the task is unknown, or the tables aren't there: nothing is guessed.
        assert_eq!(worker_of(&conn, "d-2"), Worker::default());
        assert_eq!(worker_of(&conn, "nope"), Worker::default());
        let bare = Connection::open_in_memory().unwrap();
        assert_eq!(worker_of(&bare, "d-1"), Worker::default());
    }

    #[test]
    fn a_checkers_cli_keeps_its_own_sign_in_and_none_of_the_apps_other_credentials() {
        use std::ffi::OsString;
        let vars = [
            ("HOME", "/Users/a"),
            ("CODEX_HOME", "/Users/a/.codex"),
            ("OPENAI_API_KEY", "sk-1"),
            ("HTTPS_PROXY", "http://proxy"),
            ("GITHUB_TOKEN", "ghp_x"),
            ("AWS_SECRET_ACCESS_KEY", "aws"),
            ("MONOCODE_APP_TOKEN", "t"),
            ("MONOCODE_CONTROL_PORT", "1"),
            ("SSH_AUTH_SOCK", "/tmp/agent"),
            ("npm_config_token", "n"),
        ];
        let kept = allowed_env(
            vars.iter()
                .map(|(k, v)| (OsString::from(k), OsString::from(v))),
        );
        let names: Vec<String> = kept
            .iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec!["HOME", "CODEX_HOME", "OPENAI_API_KEY", "HTTPS_PROXY"]
        );
        assert!(allowed_env(std::iter::empty()).is_empty());
    }

    #[test]
    fn only_a_call_folder_this_module_made_in_the_temp_folder_is_removed() {
        let temp = std::env::temp_dir();
        let mine = temp.join(format!("{SCRATCH_PREFIX}test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&mine).unwrap();
        remove_scratch(&mine);
        assert!(!mine.exists());
        // Another folder in the temp folder, a folder with the prefix somewhere else, and a link are left alone.
        let other = temp.join(format!("hivra-not-mine-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&other).unwrap();
        remove_scratch(&other);
        assert!(other.exists());
        let deep = other.join(format!("{SCRATCH_PREFIX}nested"));
        std::fs::create_dir_all(&deep).unwrap();
        remove_scratch(&deep);
        assert!(deep.exists());
        remove_scratch(&temp);
        assert!(temp.exists());
        remove_scratch(Path::new("/definitely/not/here"));
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn a_cli_without_a_one_answer_mode_is_refused_in_plain_words() {
        for cli in ["opencode", "gemini", "cursor", ""] {
            let err = checker_runner(cli, "", "/bin/x", Path::new("/tmp/s"), "P").unwrap_err();
            assert!(err.contains("never used as a checker"), "{cli}: {err}");
        }
        // And the ones that can be started are exactly the ones the pick may choose.
        for cli in CHECKERS {
            assert!(
                checker_runner(cli, "", "/bin/x", Path::new("/tmp/s"), "P").is_ok(),
                "{cli}"
            );
        }
    }
}
