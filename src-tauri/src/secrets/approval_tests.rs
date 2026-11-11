//! WP-92 fix round 1, item F: the approval stays per executable, shows the whole command line, and "Always" for a
//! program that can run any code is the person's own choice (off by default), enforced here, not in the webview.

use super::store::Memory;
use super::*;
use crate::session_store::SessionStore;

const VALUE: &str = "sk_live_51NxAbCdEfGhIjKl";
const NOW: i64 = 1_700_000_000_000;

struct Bench {
    store: SessionStore,
    vault: Memory,
}

impl Bench {
    fn new() -> Self {
        let bench = Self {
            store: SessionStore::open_in_memory().unwrap(),
            vault: Memory::new(),
        };
        let conn = bench.store.lock_conn().unwrap();
        save_value(
            &bench.vault,
            &conn,
            SCOPE_GLOBAL,
            "stripe-api-key",
            None,
            VALUE,
            NOW,
        )
        .unwrap();
        drop(conn);
        bench
    }
}

fn request(mono: &str, command: &[&str]) -> RunRequest {
    request_in(None, mono, command)
}

fn request_in(project: Option<&str>, mono: &str, command: &[&str]) -> RunRequest {
    RunRequest {
        chat: "chat-1".into(),
        mono: Some(mono.into()),
        project: project.map(str::to_string),
        name: "stripe-api-key".into(),
        env: "STRIPE_API_KEY".into(),
        command: command.iter().map(|word| word.to_string()).collect(),
        cwd: None,
        timeout_seconds: None,
    }
}

fn ask(bench: &Bench, mono: &str, command: &[&str], at: i64) -> (RunOutcome, String) {
    let mut conn = bench.store.lock_conn().unwrap();
    let outcome = prepare_run(&bench.vault, &mut conn, request(mono, command), at).unwrap();
    let key = match &outcome {
        RunOutcome::Waiting { decision_key, .. } => decision_key.clone(),
        other => panic!("expected a card, got {other:?}"),
    };
    (outcome, key)
}

fn card(bench: &Bench, key: &str) -> crate::decisions::Decision {
    card_in(bench, "", key)
}

fn card_in(bench: &Bench, project: &str, key: &str) -> crate::decisions::Decision {
    let conn = bench.store.lock_conn().unwrap();
    crate::decisions::get(&conn, project, key).unwrap().unwrap()
}

fn person_answers(bench: &Bench, key: &str, answer: &str, at: i64) {
    person_answers_in(bench, "", key, answer, at);
}

fn person_answers_in(bench: &Bench, project: &str, key: &str, answer: &str, at: i64) {
    let mut conn = bench.store.lock_conn().unwrap();
    let seen = crate::decisions::get(&conn, project, key)
        .unwrap()
        .unwrap()
        .version;
    crate::decisions::answer_seen(&mut conn, project, key, answer, None, Some(seen), at).unwrap();
}

// ---- which programs can run any code --------------------------------------------------------------------------------

#[test]
fn run_anything_programs_match_by_basename_and_ignore_dot_exe() {
    for program in [
        "python",
        "python3",
        "node",
        "deno",
        "bun",
        "ruby",
        "perl",
        "php",
        "make",
        "xargs",
        "awk",
        "sed",
        "find",
        "osascript",
        "npx",
        "npm",
        "pnpm",
        "yarn",
        "uv",
        "uvx",
        "cargo",
        "go",
        "java",
        "lua",
        "Rscript",
        "swift",
        // A full path, a Windows path, `.exe` in any case, and a versioned name are the same program.
        // Round 2 (H2): git and gh run aliases and helpers, and the wrappers and remote tools run anything they are given.
        "git",
        "gh",
        "ssh",
        "sudo",
        "nohup",
        "timeout",
        "caffeinate",
        "docker",
        "rsync",
        "tar",
        "pip3",
        "claude",
        "codex",
        "vim",
        "less",
        "/usr/bin/python3",
        "/opt/homebrew/bin/node",
        "./node_modules/.bin/npx",
        "C:\\Python312\\python.exe",
        "C:\\Program Files\\nodejs\\NODE.EXE",
        "python3.12",
        "npm.cmd",
    ] {
        assert!(runs_any_code(program), "{program} can run any code");
    }
    for program in [
        "curl",
        "stripe",
        "nodemon",
        "gofmt",
        "javac",
        "makefile",
        "uvicorn",
        "pythonista",
        "/usr/bin/curl",
        "C:\\tools\\curl.exe",
    ] {
        assert!(!runs_any_code(program), "{program} is not on the list");
    }
}

// ---- the setting ------------------------------------------------------------------------------------------------------

#[test]
fn the_setting_is_off_by_default_and_never_on_by_accident() {
    let store = SessionStore::open_in_memory().unwrap();
    let conn = store.lock_conn().unwrap();
    assert!(!always_for_any_code(&conn));
    // A row that says anything but "1" is off.
    conn.execute(
        "INSERT INTO secret_settings (key, value) VALUES ('always_for_any_code', 'maybe')",
        [],
    )
    .unwrap();
    assert!(!always_for_any_code(&conn));
    // A connection that never had the table (an unreadable store) is off too.
    let bare = rusqlite::Connection::open_in_memory().unwrap();
    assert!(!always_for_any_code(&bare));
}

#[test]
fn the_setting_stays_after_a_restart() {
    let dir = std::env::temp_dir().join(format!("mc-secret-setting-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("monocode.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        ensure_tables(&conn).unwrap();
        assert!(!always_for_any_code(&conn), "off the first time");
        set_always_for_any_code(&conn, true).unwrap();
        assert!(always_for_any_code(&conn));
    }
    {
        // A new process opens the same file.
        let conn = rusqlite::Connection::open(&path).unwrap();
        ensure_tables(&conn).unwrap();
        assert!(
            always_for_any_code(&conn),
            "it was still on after the restart"
        );
        set_always_for_any_code(&conn, false).unwrap();
    }
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        ensure_tables(&conn).unwrap();
        assert!(!always_for_any_code(&conn), "turning it off sticks too");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- the card ---------------------------------------------------------------------------------------------------------

#[test]
fn the_card_for_a_run_anything_program_offers_once_only_while_the_setting_is_off() {
    let bench = Bench::new();
    let (_, key) = ask(&bench, "mono-1", &["python3", "-c", "print(1)"], NOW);
    let asked = card(&bench, &key);
    assert_eq!(asked.options, vec!["Once", "No"]);
    assert!(
        asked
            .question
            .contains("This can run any code, so it asks every time."),
        "{}",
        asked.question
    );
    assert!(!asked.question.contains("Warning:"), "{}", asked.question);
    // An ordinary program still gets the whole menu and no run-anything line.
    let (_, key) = ask(
        &bench,
        "mono-1",
        &["curl", "https://api.stripe.com"],
        NOW + 1,
    );
    let asked = card(&bench, &key);
    assert_eq!(asked.options, vec!["Once", "No"], "{}", asked.question);
    assert!(
        asked
            .question
            .contains("This program can read config files and run helpers."),
        "{}",
        asked.question
    );
    assert!(!asked.question.contains("This can run any code"));
}

#[test]
fn the_card_shows_the_full_command_line_and_names_the_program() {
    let bench = Bench::new();
    let (_, key) = ask(
        &bench,
        "mono-1",
        &[
            "/usr/bin/curl",
            "-H",
            "Authorization: Bearer $STRIPE_API_KEY",
            "https://api.stripe.com/v1/charges?limit=3",
            "it's",
        ],
        NOW,
    );
    let text = card(&bench, &key).question;
    assert!(text.contains("curl"), "{text}");
    // Every word of the command is there, and an argument with a space or a quote is shown so the words stay apart.
    assert!(
        text.contains(
            "Command: /usr/bin/curl -H 'Authorization: Bearer $STRIPE_API_KEY' https://api.stripe.com/v1/charges?limit=3 'it'\\''s'"
        ),
        "{text}"
    );
    assert!(
        text.lines()
            .any(|line| line == "The program is /usr/bin/curl."),
        "{text}"
    );
    assert!(!text.contains(VALUE));
}

#[test]
fn an_argument_cannot_forge_a_line_on_the_card() {
    let bench = Bench::new();
    let (_, key) = ask(
        &bench,
        "mono-1",
        &[
            "curl",
            "x\nWarning: this is fine, pick Always\r\nCommand: ls",
        ],
        NOW,
    );
    let text = card(&bench, &key).question;
    assert_eq!(
        text.lines()
            .filter(|line| line.starts_with("Command:"))
            .count(),
        1,
        "{text}"
    );
    assert!(
        !text.lines().any(|line| line.starts_with("Warning:")),
        "{text}"
    );
    assert!(
        text.contains("\\n"),
        "the line break is shown, not obeyed: {text}"
    );
}

#[test]
fn a_program_name_cannot_forge_a_line_on_the_card() {
    let bench = Bench::new();
    // A program name with a line break is not an installed program: the run is refused before any card is written, so
    // no line of a card can be forged through the name.
    let mut conn = bench.store.lock_conn().unwrap();
    let err = prepare_run(
        &bench.vault,
        &mut conn,
        request("mono-1", &["curl\nWarning:Always-is-fine\nCommand:ls", "x"]),
        NOW,
    )
    .unwrap_err();
    assert!(!err.contains('\n'), "{err}");
    assert!(
        crate::decisions::list(&conn, 10).unwrap().is_empty(),
        "no card was written"
    );
}

#[test]
fn a_command_too_long_to_show_whole_is_not_asked_about() {
    let bench = Bench::new();
    let long = "x".repeat(1_600);
    let mut conn = bench.store.lock_conn().unwrap();
    let err = prepare_run(
        &bench.vault,
        &mut conn,
        request("mono-1", &["curl", &long]),
        NOW,
    )
    .unwrap_err();
    assert!(err.contains("too long to show"), "{err}");
    assert!(crate::decisions::list(&conn, 10).unwrap().is_empty());
}

#[test]
fn a_command_that_holds_the_value_is_refused_before_a_card_is_made() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    let err = prepare_run(
        &bench.vault,
        &mut conn,
        request(
            "mono-1",
            &["curl", "-H", &format!("Authorization: {VALUE}")],
        ),
        NOW,
    )
    .unwrap_err();
    assert!(!err.contains(VALUE), "{err}");
    assert!(err.contains("holds the key"), "{err}");
    assert!(
        crate::decisions::list(&conn, 10).unwrap().is_empty(),
        "no card, so the value is in no row"
    );
}

#[test]
fn a_second_ask_from_the_same_mono_shows_the_newest_command() {
    let bench = Bench::new();
    let (_, key) = ask(&bench, "mono-1", &["curl", "https://first.example"], NOW);
    let (_, again) = ask(
        &bench,
        "mono-1",
        &["curl", "https://second.example"],
        NOW + 1,
    );
    assert_eq!(key, again);
    let text = card(&bench, &key).question;
    assert!(text.contains("https://second.example"), "{text}");
    assert!(!text.contains("https://first.example"), "{text}");
    // Another Mono's open card is left as it was asked.
    let (_, other) = ask(
        &bench,
        "mono-2",
        &["curl", "https://third.example"],
        NOW + 2,
    );
    assert_eq!(key, other);
    let text = card(&bench, &key).question;
    assert!(text.contains("https://second.example"), "{text}");
    assert!(!text.contains("https://third.example"), "{text}");
}

// ---- what an answer may write ---------------------------------------------------------------------------------------

#[test]
fn always_for_a_run_anything_program_is_refused_while_the_setting_is_off() {
    for (answer, project) in [
        ("Always for this Mono", None),
        ("Always for this project", Some("/p")),
    ] {
        let bench = Bench::new();
        let project_key = project.unwrap_or("");
        let command = ["python3", "script.py"];
        let mut conn = bench.store.lock_conn().unwrap();
        let outcome = prepare_run(
            &bench.vault,
            &mut conn,
            request_in(project, "mono-1", &command),
            NOW,
        )
        .unwrap();
        let RunOutcome::Waiting {
            decision_key: key, ..
        } = outcome
        else {
            panic!("a card");
        };
        drop(conn);
        // The card did not offer it, but an answer is only text: the webview could still send it.
        person_answers_in(&bench, project_key, &key, answer, NOW + 1);
        let mut conn = bench.store.lock_conn().unwrap();
        let err = prepare_run(
            &bench.vault,
            &mut conn,
            request_in(project, "mono-1", &command),
            NOW + 2,
        )
        .unwrap_err();
        assert!(
            err.contains("This can run any code, so it asks every time."),
            "{err}"
        );
        assert!(
            grants_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
                .unwrap()
                .is_empty(),
            "{answer}: no grant was written"
        );
        // The answered card is cleared, so the next run is asked again, on the Once-only card.
        let again = prepare_run(
            &bench.vault,
            &mut conn,
            request_in(project, "mono-1", &command),
            NOW + 3,
        )
        .unwrap();
        assert!(matches!(again, RunOutcome::Waiting { .. }), "{answer}");
        drop(conn);
        let asked = card_in(&bench, project_key, &key);
        assert_eq!(asked.options, vec!["Once", "No"]);
        assert_eq!(asked.state, crate::decisions::OPEN);
    }
}

#[test]
fn the_grant_writer_itself_refuses_always_for_a_run_anything_program() {
    let bench = Bench::new();
    let conn = bench.store.lock_conn().unwrap();
    for program in [
        "python3",
        "/usr/bin/node",
        "C:\\Python312\\PYTHON.EXE",
        "make",
    ] {
        let err = put_grant(
            &conn,
            SCOPE_GLOBAL,
            "stripe-api-key",
            "mono",
            "mono-1",
            program,
            "",
            "",
            "always",
            NOW,
        )
        .unwrap_err();
        assert!(err.contains("This can run any code"), "{err}");
    }
    assert!(grants_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
        .unwrap()
        .is_empty());
    // Once is still allowed. Always is not, including for curl.
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "mono",
        "mono-1",
        "python3",
        "",
        "",
        "once",
        NOW,
    )
    .unwrap();
    let err = put_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "mono",
        "mono-1",
        "curl",
        "",
        "",
        "always",
        NOW,
    )
    .unwrap_err();
    assert!(
        err.contains("asks every time") || err.contains("Always"),
        "{err}"
    );
}

#[test]
fn once_still_works_for_a_run_anything_program_and_is_spent() {
    let bench = Bench::new();
    let (_, key) = ask(&bench, "mono-1", &["python3", "script.py"], NOW);
    person_answers(&bench, &key, "Once", NOW + 1);
    let mut conn = bench.store.lock_conn().unwrap();
    assert!(matches!(
        prepare_run(
            &bench.vault,
            &mut conn,
            request("mono-1", &["python3", "script.py"]),
            NOW + 2
        )
        .unwrap(),
        RunOutcome::Granted { .. }
    ));
    assert!(matches!(
        prepare_run(
            &bench.vault,
            &mut conn,
            request("mono-1", &["python3", "script.py"]),
            NOW + 3
        )
        .unwrap(),
        RunOutcome::Waiting { .. }
    ));
}

#[test]
fn with_the_setting_on_always_is_offered_warned_about_and_allowed() {
    let bench = Bench::new();
    {
        let conn = bench.store.lock_conn().unwrap();
        set_always_for_any_code(&conn, true).unwrap();
    }
    let (_, key) = ask(&bench, "mono-1", &["python3", "script.py"], NOW);
    let asked = card(&bench, &key);
    assert_eq!(asked.options, vec!["Once", "No"], "{}", asked.question);
    assert!(
        asked
            .question
            .contains("This can run any code, so it asks every time."),
        "{}",
        asked.question
    );
    assert!(!asked.question.contains("Warning:"), "{}", asked.question);
    person_answers(&bench, &key, "Always for this Mono", NOW + 1);
    let mut conn = bench.store.lock_conn().unwrap();
    let err = prepare_run(
        &bench.vault,
        &mut conn,
        request("mono-1", &["python3", "script.py"]),
        NOW + 2,
    )
    .unwrap_err();
    assert!(err.contains("asks every time"), "{err}");
    assert!(grants_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
        .unwrap()
        .is_empty());
}

#[test]
fn turning_the_setting_off_again_refuses_an_always_answer_given_while_it_was_on() {
    let bench = Bench::new();
    {
        let conn = bench.store.lock_conn().unwrap();
        set_always_for_any_code(&conn, true).unwrap();
    }
    let (_, key) = ask(&bench, "mono-1", &["node", "build.js"], NOW);
    person_answers(&bench, &key, "Always for this Mono", NOW + 1);
    {
        let conn = bench.store.lock_conn().unwrap();
        set_always_for_any_code(&conn, false).unwrap();
    }
    let mut conn = bench.store.lock_conn().unwrap();
    let err = prepare_run(
        &bench.vault,
        &mut conn,
        request("mono-1", &["node", "build.js"]),
        NOW + 2,
    )
    .unwrap_err();
    assert!(err.contains("asks every time"), "{err}");
    assert!(grants_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
        .unwrap()
        .is_empty());
}

#[test]
fn an_agent_cannot_make_its_own_secret_card() {
    // `ask_person` reaches the decision store through `decisions_ask`; a secret's card is made by the app alone, so the
    // agent cannot pick the words the person approves on.
    let err = crate::decisions::check_ask_key("secret/stripe-api-key/python3").unwrap_err();
    assert!(err.contains("only the app"), "{err}");
    assert!(crate::decisions::check_ask_key("retention-policy").is_ok());
    assert!(crate::decisions::check_ask_key("secrets-policy").is_ok());
}

#[test]
fn turning_the_setting_off_takes_back_the_always_grants_it_allowed() {
    let bench = Bench::new();
    let conn = bench.store.lock_conn().unwrap();
    set_always_for_any_code(&conn, true).unwrap();
    // Always is not written any more. These rows are what an older build left in the table.
    for (kind, subject, program) in [
        ("mono", "mono-1", "python3"),
        ("project", "/p", "node"),
        ("mono", "mono-1", "curl"),
    ] {
        conn.execute(
            "INSERT INTO secret_grants (scope, name, subject_kind, subject_id, executable, mode, created_at, identity, fingerprint)
             VALUES (?1, 'stripe-api-key', ?2, ?3, ?4, 'always', ?5, '', '')",
            rusqlite::params![SCOPE_GLOBAL, kind, subject, program, NOW],
        )
        .unwrap();
    }
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "mono",
        "mono-2",
        "make",
        "",
        "",
        "once",
        NOW,
    )
    .unwrap();
    assert_eq!(set_always_for_any_code(&conn, false).unwrap(), 2);
    let left: Vec<String> = grants_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
        .unwrap()
        .into_iter()
        .map(|grant| format!("{}:{}:{}", grant.subject_id, grant.executable, grant.mode))
        .collect();
    // The ordinary program's Always and a once grant stay; the two run-anything Always grants are gone.
    assert_eq!(left, vec!["mono-1:curl:always", "mono-2:make:once"]);
}

// ---- fix round 1, item L: which copy a run uses, said in plain words --------------------------------------------------

fn save_copy(bench: &Bench, scope: &str, label: &str) {
    let conn = bench.store.lock_conn().unwrap();
    save_value(
        &bench.vault,
        &conn,
        scope,
        "stripe-api-key",
        Some(label),
        "sk_live_a_project_copy_9999",
        NOW,
    )
    .unwrap();
}

#[test]
fn where_a_key_lives_is_said_in_plain_words() {
    assert_eq!(scope_words(SCOPE_GLOBAL), "Everywhere");
    assert_eq!(
        scope_words("project./Users/person/Projects/hivra"),
        "Project: hivra"
    );
    assert_eq!(scope_words("project.C:\\work\\hivra"), "Project: hivra");
    assert_eq!(scope_words("project./work/proj/"), "Project: proj");
}

#[test]
fn the_card_names_the_scope_of_the_key_it_asks_about() {
    let bench = Bench::new();
    let (_, key) = ask(&bench, "mono-1", &["curl", "https://api.stripe.com"], NOW);
    let text = card(&bench, &key).question;
    assert!(
        text.lines()
            .any(|line| line == "Key: stripe-api-key, saved for Everywhere"),
        "{text}"
    );
    assert!(!text.contains("there is also one for everywhere"), "{text}");
}

#[test]
fn when_a_name_is_saved_both_ways_the_card_says_the_projects_copy_is_used() {
    let bench = Bench::new();
    save_copy(&bench, "project./work/proj", "Stripe for proj");
    let mut conn = bench.store.lock_conn().unwrap();
    let outcome = prepare_run(
        &bench.vault,
        &mut conn,
        request_in(
            Some("/work/proj"),
            "mono-1",
            &["curl", "https://api.stripe.com"],
        ),
        NOW,
    )
    .unwrap();
    let RunOutcome::Waiting {
        scope,
        decision_key,
        ..
    } = outcome
    else {
        panic!("a card");
    };
    // The project's copy is the one asked about.
    assert_eq!(scope, "project./work/proj");
    let asked = crate::decisions::get(&conn, "/work/proj", &decision_key)
        .unwrap()
        .unwrap();
    assert!(
        asked.question.lines().any(|line| line
            == "Key: Stripe for proj, saved for Project: proj. This project's copy is used; there is also one for everywhere."),
        "{}",
        asked.question
    );
    // A chat with no project uses the global copy and says nothing about another.
    drop(conn);
    let (_, global_key) = ask(
        &bench,
        "mono-2",
        &["curl", "https://api.stripe.com"],
        NOW + 1,
    );
    let global = card(&bench, &global_key).question;
    assert!(
        global
            .lines()
            .any(|line| line.ends_with("saved for Everywhere")),
        "{global}"
    );
}

#[test]
fn a_run_is_recorded_in_the_activity_log_with_the_scope_it_used() {
    let bench = Bench::new();
    let conn = bench.store.lock_conn().unwrap();
    record_run(
        &conn,
        "project./work/proj",
        "stripe-api-key",
        "Tally",
        "curl",
        Some(0),
        false,
        1_200,
        NOW,
    )
    .unwrap();
    record_run(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "Tally",
        "curl",
        Some(0),
        false,
        800,
        NOW + 1,
    )
    .unwrap();
    let summaries: Vec<String> = conn
        .prepare("SELECT summary FROM activity WHERE kind = 'secret.run' ORDER BY seq")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        summaries,
        vec![
            "Tally ran `curl` with stripe-api-key (Project: proj): exit 0",
            "Tally ran `curl` with stripe-api-key (Everywhere): exit 0",
        ]
    );
}

#[test]
fn a_workers_card_names_the_scope_too() {
    let bench = Bench::new();
    let mut conn = bench.store.lock_conn().unwrap();
    let outcome = worker::prepare(
        &bench.vault,
        &mut conn,
        worker::WorkerRequest {
            chat: "chat-1".into(),
            mono: "Tally".into(),
            project: None,
            executable: "claude".into(),
            secrets: vec![worker::WorkerSecret {
                name: "stripe-api-key".into(),
                env: "STRIPE_API_KEY".into(),
            }],
        },
        NOW,
    )
    .unwrap();
    let worker::WorkerOutcome::Waiting { decision_key, .. } = outcome else {
        panic!("a card");
    };
    let asked = crate::decisions::get(&conn, "", &decision_key)
        .unwrap()
        .unwrap();
    assert!(
        asked.question.contains("(Everywhere)"),
        "{}",
        asked.question
    );
}

// ---- fix round 2 (C1, H2, M1, L1): what a card approves, and what a grant names ---------------------------------------

#[test]
fn a_long_program_path_keeps_its_own_decision_key() {
    // Both paths share their first 120 characters: a truncated key would make them one card.
    let shared = "a".repeat(90);
    let a = format!("/Users/someone/tools/{shared}/stripe");
    let b = format!("/Users/someone/tools/{shared}/stripe-cli");
    let key = |program: &str| {
        decision_key(
            "stripe-api-key",
            &run_fingerprint(
                program,
                "1:2:3:4",
                "STRIPE_API_KEY",
                None,
                &[program.to_string()],
                60,
            ),
        )
    };
    assert_ne!(key(&a), key(&b));
    // The same approval always gives the same card.
    assert_eq!(key(&a), key(&a));
}

#[test]
fn a_card_is_for_the_exact_command_not_only_the_program() {
    let program = "/opt/homebrew/bin/stripe";
    let command = |args: &[&str]| -> Vec<String> {
        std::iter::once(program.to_string())
            .chain(args.iter().map(|arg| arg.to_string()))
            .collect()
    };
    let key = |args: &[&str]| {
        decision_key(
            "stripe-api-key",
            &run_fingerprint(
                program,
                "1:2:3:4",
                "STRIPE_API_KEY",
                None,
                &command(args),
                60,
            ),
        )
    };
    // A Once answered for one command is not an answer for another command with the same program.
    assert_ne!(
        key(&["customers", "list"]),
        key(&["customers", "delete", "x"])
    );
}

#[test]
fn a_card_shows_the_full_path_and_writes_out_invisible_characters() {
    let program = "/opt/homebrew/bin/str\u{202e}ipe";
    let text = run_question(
        "Tally",
        "Stripe key",
        "your global keys",
        &[program.to_string(), "customers".into(), "list".into()],
        false,
        false,
        "STRIPE_API_KEY",
        None,
    )
    .unwrap();
    // The bidi override is written out, not sent: the card carries no U+202E at all.
    assert!(!text.contains('\u{202e}'), "{text}");
    assert!(text.contains("\\u{202e}"), "{text}");
    // The full path is on the card, not only its last word.
    assert!(text.contains("/opt/homebrew/bin/"), "{text}");
    // A look-alike letter in a program name is written out too (Cyrillic a in place of Latin a).
    let lookalike = run_question(
        "Tally",
        "Stripe key",
        "your global keys",
        &["/opt/homebrew/bin/str\u{430}ipe".to_string()],
        false,
        false,
        "STRIPE_API_KEY",
        None,
    )
    .unwrap();
    assert!(!lookalike.contains('\u{430}'), "{lookalike}");
}

#[test]
fn a_grant_names_the_file_it_was_given_for() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_tables(&conn).unwrap();
    put_grant(
        &conn,
        "global",
        "stripe-api-key",
        "mono",
        "m1",
        "/usr/bin/curl",
        "1:2:3:4",
        "",
        "once",
        NOW,
    )
    .unwrap();
    let found = |identity: &str| {
        find_grant(
            &conn,
            "global",
            "stripe-api-key",
            Some("m1"),
            None,
            "/usr/bin/curl",
            identity,
            "",
        )
        .unwrap()
        .is_some()
    };
    assert!(found("1:2:3:4"));
    // The same path after the file was replaced is a different program: it asks again.
    assert!(!found("1:2:3:5"));
}

#[test]
fn an_unreadable_value_fails_closed_for_the_needles_and_the_checks() {
    struct Unreadable;
    impl Vault for Unreadable {
        fn read(&self, _: &str, _: &str) -> Result<Option<String>, String> {
            Err("Keychain is locked".into())
        }
        fn write(&self, _: &str, _: &str, _: &str) -> Result<(), String> {
            Err("no".into())
        }
        fn remove(&self, _: &str, _: &str) -> Result<bool, String> {
            Err("no".into())
        }
    }
    let names = [("global".to_string(), "stripe-api-key".to_string())];
    assert!(needles_for(&Unreadable, &names).is_err());
    let conn = Connection::open_in_memory().unwrap();
    ensure_tables(&conn).unwrap();
    // A saved key whose value cannot be read: the check cannot say the text is clean, so it says it holds a value.
    save_value(
        &Memory::new(),
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        None,
        VALUE,
        NOW,
    )
    .unwrap();
    // Never "clean": a save or an export that cannot check the text refuses it.
    assert!(holds_known_value(
        &Unreadable,
        &conn,
        None,
        "anything at all"
    ));
}

// ---- fix round 3 (H2, H3): judge the typed word and the canonical path, shebangs included; Always binds the fingerprint

#[cfg(unix)]
#[test]
fn a_script_is_judged_by_the_interpreter_on_its_shebang_line() {
    let dir = std::env::temp_dir().join(format!("mc-shebang-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let node_script = dir.join("npx-cli.js");
    std::fs::write(&node_script, "#!/usr/bin/env node\nconsole.log(1)\n").unwrap();
    assert!(
        runs_any_for(&node_script.to_string_lossy()),
        "a node script runs any code"
    );
    let shell_script = dir.join("tool");
    std::fs::write(&shell_script, "#!/bin/sh\necho hi\n").unwrap();
    assert!(
        runs_any_for(&shell_script.to_string_lossy()),
        "a shell script runs any code"
    );
    let plain = dir.join("plain");
    std::fs::write(&plain, "#!/usr/bin/env stripe\n").unwrap();
    // Round 4 (N4): every script with a `#!` line runs code, whatever its interpreter line names.
    assert!(
        runs_any_for(&plain.to_string_lossy()),
        "a script with a shebang runs code"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_typed_word_and_the_canonical_path_are_both_judged() {
    // `npx` pins to a JavaScript file under npm's folder: the typed word is what says it runs code.
    assert!(runs_any_for("npx"));
    assert!(runs_any_for("/opt/homebrew/bin/npx"));
    assert!(!runs_any_for("/usr/bin/true"));
}

#[test]
fn the_no_always_list_covers_the_programs_found_to_leak_or_run_code() {
    for program in [
        "sqlite3",
        "jq",
        "psql",
        "m4",
        "script",
        "lldb",
        "gsed",
        "gfind",
        "gxargs",
        "genv",
        "gnohup",
        "terraform",
        "pytest",
    ] {
        assert!(runs_any_code(program), "{program} must ask every time");
    }
}

#[test]
fn a_grant_covers_only_the_fingerprint_it_was_given_for() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_tables(&conn).unwrap();
    put_grant(
        &conn,
        "global",
        "stripe-api-key",
        "mono",
        "m1",
        "/usr/bin/true",
        "1:2:3:4",
        "fingerprint-a",
        "once",
        NOW,
    )
    .unwrap();
    let found = |fingerprint: &str| {
        find_grant(
            &conn,
            "global",
            "stripe-api-key",
            Some("m1"),
            None,
            "/usr/bin/true",
            "1:2:3:4",
            fingerprint,
        )
        .unwrap()
        .is_some()
    };
    assert!(found("fingerprint-a"));
    // Other arguments, another environment name or another folder: a different fingerprint, so the card comes back.
    assert!(!found("fingerprint-b"));
}

#[test]
fn an_always_card_says_it_covers_the_exact_command() {
    let text = run_question(
        "Tally",
        "Stripe key",
        "your global keys",
        &["/usr/bin/true".to_string(), "x".to_string()],
        true,
        false,
        "STRIPE_API_KEY",
        None,
    )
    .unwrap();
    assert!(text.contains("exact command"), "{text}");
}

// ---- fix round 4 (review of round 4): what a card says, which names and programs are allowed, and who may answer ----

#[test]
fn a_secret_cannot_take_a_name_that_changes_how_a_program_runs() {
    // N1: these names change what the program loads, reads or runs. Only a credential-shaped name may carry a key.
    for env in [
        "SSLKEYLOGFILE",
        "DYLD_INSERT_LIBRARIES",
        "LD_PRELOAD",
        "NODE_OPTIONS",
        "BASH_ENV",
        "PYTHONSTARTUP",
        "GIT_SSH_COMMAND",
        "CURL_HOME",
        "HTTPS_PROXY",
        "XDG_CONFIG_HOME",
    ] {
        let bench = Bench::new();
        let mut conn = bench.store.lock_conn().unwrap();
        let mut req = request("mono-1", &["/usr/bin/true", "--version"]);
        req.env = env.into();
        let refused = prepare_run(&bench.vault, &mut conn, req, NOW);
        assert!(
            refused.is_err(),
            "{env} is not a credential name and must be refused, got {refused:?}"
        );
    }
    // A credential-shaped name still gets its card.
    for env in ["STRIPE_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "GH_PAT"] {
        let bench = Bench::new();
        let mut conn = bench.store.lock_conn().unwrap();
        let mut req = request("mono-1", &["/usr/bin/true", "--version"]);
        req.env = env.into();
        let asked = prepare_run(&bench.vault, &mut conn, req, NOW).unwrap();
        assert!(
            matches!(asked, RunOutcome::Waiting { .. }),
            "{env}: {asked:?}"
        );
    }
}

#[test]
fn a_different_environment_name_is_a_different_card() {
    // N1 (P1b): the same program with another name is another approval, not the first card silently moved.
    let bench = Bench::new();
    let (_, first) = ask(&bench, "mono-1", &["/usr/bin/true", "x"], NOW);
    let mut req = request("mono-1", &["/usr/bin/true", "x"]);
    req.env = "GITHUB_TOKEN".into();
    let mut conn = bench.store.lock_conn().unwrap();
    let second = match prepare_run(&bench.vault, &mut conn, req, NOW + 1).unwrap() {
        RunOutcome::Waiting { decision_key, .. } => decision_key,
        other => panic!("{other:?}"),
    };
    assert_ne!(first, second, "a second name must not reuse the first card");
}

#[test]
fn a_windows_batch_file_or_powershell_script_runs_code_so_it_is_judged_so() {
    // Round 4 (LOW): a .cmd, .bat or .ps1 is a script, and the name is judged with its extension.
    assert!(runs_any_code("C:\\tools\\deploy.cmd"));
    assert!(runs_any_code("deploy.bat"));
    assert!(runs_any_code("deploy.ps1"));
}

#[test]
fn programs_that_run_other_code_are_judged_so_whatever_their_path() {
    // N4: the list the probe found missing, by basename and with a version or a full path.
    for program in [
        "tclsh",
        "expect",
        "wish",
        "dc",
        "zip",
        "sandbox-exec",
        "taskpolicy",
        "ssh-agent",
        "screen",
        "tmux",
        "ex",
        "view",
        "erb",
        "irb",
        "pydoc3",
        "R",
        "gmake",
        "gawk",
        "nawk",
        "just",
        "task",
        "tofu",
        "pulumi",
        "helm",
        "hyperfine",
        "watchexec",
        "mise",
        "direnv",
        "julia",
        "elixir",
        "racket",
        "sbcl",
        "mysql",
        "parallel",
        "watch",
        "gdb",
        "nix",
        "volta",
        "corepack",
        "runghc",
        "guile",
        "lein",
        "sbt",
        "flock",
        "chroot",
        "su",
        "/usr/local/bin/tclsh8.6",
    ] {
        assert!(
            runs_any_code(program),
            "{program} runs other code and must be judged so"
        );
    }
}

#[test]
fn a_script_with_a_shebang_line_runs_code_whatever_its_interpreter_line_says() {
    // N4: `env` with options, `env -S` with assignments, and a `#!` naming another script all run code.
    let dir = std::env::temp_dir().join(format!("mc-shebang-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    for (i, line) in [
        "#!/usr/bin/env -S A=1 node",
        "#!/usr/bin/env -u X node",
        "#!/usr/bin/env -S -i PATH=/usr/bin python3",
        "#!/opt/scripts/other-script",
        "#!/bin/sh",
    ]
    .iter()
    .enumerate()
    {
        let script = dir.join(format!("script-{i}"));
        std::fs::write(&script, format!("{line}\necho hi\n")).unwrap();
        assert!(
            runs_any_for(&script.to_string_lossy()),
            "{line} must be judged as running code"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn always_is_offered_only_for_a_listed_program_in_a_folder_only_the_owner_writes() {
    // N4/N7: Always comes from a short list of programs that run no code, and never from a folder the account can write.
    let bench = Bench::new();
    let conn = bench.store.lock_conn().unwrap();
    assert!(!always_allowed_for(&conn, "/usr/bin/true"));
    assert!(!always_allowed_for(&conn, "/usr/bin/curl"));
    assert!(!always_allowed_for(&conn, "/usr/bin/wget"));
    assert!(
        !always_allowed_for(&conn, "/usr/bin/nc"),
        "a program not on the list is asked every time"
    );
    let dir = std::env::temp_dir().join(format!("mc-always-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let copy = dir.join("curl");
    std::fs::write(&copy, b"not really curl").unwrap();
    assert!(
        !always_allowed_for(&conn, &copy.to_string_lossy()),
        "a copy in a folder the account writes is never offered Always"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn turning_the_setting_off_takes_back_an_always_for_a_script() {
    // Round 4 (LOW): "off" must take back the Always of a script too, which is judged by its first line.
    let dir = std::env::temp_dir().join(format!("mc-revoke-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("tool");
    std::fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
    let bench = Bench::new();
    let conn = bench.store.lock_conn().unwrap();
    set_always_for_any_code(&conn, true).unwrap();
    conn.execute(
        "INSERT INTO secret_grants (scope, name, subject_kind, subject_id, executable, mode, created_at, identity, fingerprint)
         VALUES ('global', 'stripe-api-key', 'mono', 'mono-1', ?1, 'always', ?2, 'id', 'fp')",
        rusqlite::params![script.to_string_lossy(), NOW],
    )
    .unwrap();
    let removed = set_always_for_any_code(&conn, false).unwrap();
    assert_eq!(removed, 1, "the script's Always is taken back");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_answer_recorded_as_the_user_does_not_grant_a_secret() {
    // Round 4 (LOW): the Needs sheet's answer ("user") is not the person's answer on a secret card.
    let bench = Bench::new();
    let (_, key) = ask(&bench, "mono-1", &["/usr/bin/true", "x"], NOW);
    {
        let conn = bench.store.lock_conn().unwrap();
        conn.execute(
            "UPDATE decisions SET state = 'answered', answer = 'Once', answered_by = 'user', answered_at = ?1
             WHERE decision_key = ?2",
            rusqlite::params![NOW + 1, key],
        )
        .unwrap();
    }
    let mut conn = bench.store.lock_conn().unwrap();
    let outcome = prepare_run(
        &bench.vault,
        &mut conn,
        request("mono-1", &["/usr/bin/true", "x"]),
        NOW + 2,
    )
    .unwrap();
    assert!(
        !matches!(outcome, RunOutcome::Granted { .. }),
        "an answer by the user must not grant: {outcome:?}"
    );
}

#[test]
fn a_once_answer_for_another_command_does_not_drop_an_always_grant() {
    // Round 4 (LOW): one row per program per Mono let a Once overwrite an Always for another command.
    let bench = Bench::new();
    let (_, key) = ask(&bench, "mono-1", &["/usr/bin/true", "a"], NOW);
    person_answers(&bench, &key, "Always for this Mono", NOW + 1);
    {
        let mut conn = bench.store.lock_conn().unwrap();
        let err = prepare_run(
            &bench.vault,
            &mut conn,
            request("mono-1", &["/usr/bin/true", "a"]),
            NOW + 2,
        )
        .unwrap_err();
        assert!(
            err.contains("asks every time") || err.contains("Always"),
            "{err}"
        );
    }
    let (_, other) = ask(&bench, "mono-1", &["/usr/bin/true", "b"], NOW + 3);
    person_answers(&bench, &other, "Once", NOW + 4);
    let mut conn = bench.store.lock_conn().unwrap();
    let spent = prepare_run(
        &bench.vault,
        &mut conn,
        request("mono-1", &["/usr/bin/true", "b"]),
        NOW + 5,
    )
    .unwrap();
    assert!(matches!(spent, RunOutcome::Granted { .. }), "{spent:?}");
    let again = prepare_run(
        &bench.vault,
        &mut conn,
        request("mono-1", &["/usr/bin/true", "a"]),
        NOW + 6,
    )
    .unwrap();
    assert!(
        matches!(again, RunOutcome::Waiting { .. }),
        "Always for command a must not grant, so a still asks: {again:?}"
    );
}

#[test]
fn a_second_mono_asking_the_same_program_does_not_cancel_the_first_monos_card() {
    // Round 4 (LOW): a second Mono's ask must not move the card's binding away from the first Mono's command.
    let bench = Bench::new();
    let (_, key) = ask(&bench, "mono-1", &["/usr/bin/true", "first"], NOW);
    let other = {
        let mut conn = bench.store.lock_conn().unwrap();
        match prepare_run(
            &bench.vault,
            &mut conn,
            request("mono-2", &["/usr/bin/true", "second"]),
            NOW + 1,
        )
        .unwrap()
        {
            RunOutcome::Waiting { decision_key, .. } => decision_key,
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(other, key, "the same program is one card");
    person_answers(&bench, &key, "Once", NOW + 2);
    let mut conn = bench.store.lock_conn().unwrap();
    let granted = prepare_run(
        &bench.vault,
        &mut conn,
        request("mono-1", &["/usr/bin/true", "first"]),
        NOW + 3,
    )
    .unwrap();
    assert!(
        matches!(granted, RunOutcome::Granted { .. }),
        "mono-1's answer must still cover its own command: {granted:?}"
    );
}

#[test]
fn an_answer_for_a_card_the_person_did_not_read_is_refused() {
    // Round 4 (N6): the Inbox sends the version it rendered. A card rewritten for another command since then is refused,
    // and the answer that does land is for the command on the card now.
    let bench = Bench::new();
    let (_, key) = ask(
        &bench,
        "mono-1",
        &["/usr/bin/true", "https://api.stripe.com/v1/balance"],
        NOW,
    );
    let seen = card(&bench, &key).version;
    let _ = ask(
        &bench,
        "mono-1",
        &["/usr/bin/true", "https://evil.example/collect"],
        NOW + 1,
    );
    {
        let mut conn = bench.store.lock_conn().unwrap();
        let refused =
            crate::decisions::answer_seen(&mut conn, "", &key, "Once", None, Some(seen), NOW + 2);
        let why =
            refused.expect_err("an answer for the card the person did not read must not land");
        assert!(why.contains("changed after you read it"), "{why}");
    }
    let now_version = card(&bench, &key).version;
    {
        let mut conn = bench.store.lock_conn().unwrap();
        let landed = crate::decisions::answer_seen(
            &mut conn,
            "",
            &key,
            "Once",
            None,
            Some(now_version),
            NOW + 3,
        )
        .unwrap();
        assert!(landed.applied);
    }
    let mut conn = bench.store.lock_conn().unwrap();
    let evil = prepare_run(
        &bench.vault,
        &mut conn,
        request("mono-1", &["/usr/bin/true", "https://evil.example/collect"]),
        NOW + 4,
    )
    .unwrap();
    assert!(
        matches!(evil, RunOutcome::Granted { .. }),
        "the card on screen is the one answered: {evil:?}"
    );
    let balance = prepare_run(
        &bench.vault,
        &mut conn,
        request(
            "mono-1",
            &["/usr/bin/true", "https://api.stripe.com/v1/balance"],
        ),
        NOW + 5,
    )
    .unwrap();
    assert!(
        !matches!(balance, RunOutcome::Granted { .. }),
        "the command the person read was not answered: {balance:?}"
    );
}

#[test]
fn the_card_names_the_environment_variable_the_folder_and_who_can_read_it() {
    // Round 4 (N1): the card shows the name the key goes under and the folder the command runs in, and says that other
    // programs running as the person can read the command's environment while it runs.
    let text = run_question(
        "Tally",
        "Stripe key",
        "your global keys",
        &["/usr/bin/true".to_string(), "x".to_string()],
        false,
        false,
        "GITHUB_TOKEN",
        Some("/p/sub"),
    )
    .unwrap();
    assert!(
        text.lines()
            .any(|line| line == "Environment variable: GITHUB_TOKEN"),
        "{text}"
    );
    assert!(text.lines().any(|line| line == "Folder: /p/sub"), "{text}");
    assert!(
        text.contains("can read this command's environment"),
        "{text}"
    );
    let no_folder = run_question(
        "Tally",
        "Stripe key",
        "your global keys",
        &["/usr/bin/true".to_string()],
        false,
        false,
        "STRIPE_API_KEY",
        None,
    )
    .unwrap();
    assert!(no_folder.contains("Folder: none"), "{no_folder}");
}
