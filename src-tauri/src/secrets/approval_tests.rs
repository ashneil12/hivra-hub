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
    crate::decisions::answer(&mut conn, project, key, answer, None, at).unwrap();
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
    assert_eq!(
        asked.options,
        vec!["Once", "Always for this Mono", "No"],
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
    // Once is always allowed, and an ordinary program may have Always.
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
    put_grant(
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
    .unwrap();
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
    assert_eq!(
        asked.options,
        vec!["Once", "Always for this Mono", "No"],
        "{}",
        asked.question
    );
    assert!(
        asked.question.lines().any(|line| line
            == "Warning: 'Always' lets an agent use this key for anything, without asking you. Leave this off unless you are sure."),
        "{}",
        asked.question
    );
    assert!(
        !asked.question.contains("asks every time"),
        "the Once-only line is for the setting being off: {}",
        asked.question
    );
    person_answers(&bench, &key, "Always for this Mono", NOW + 1);
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
    // The same command never asks again (fix round 3, H3: Always is for the exact command).
    assert!(matches!(
        prepare_run(
            &bench.vault,
            &mut conn,
            request("mono-1", &["python3", "script.py"]),
            NOW + 3
        )
        .unwrap(),
        RunOutcome::Granted { .. }
    ));
    // Other arguments with the same program ask again.
    assert!(matches!(
        prepare_run(
            &bench.vault,
            &mut conn,
            request("mono-1", &["python3", "other.py"]),
            NOW + 4
        )
        .unwrap(),
        RunOutcome::Waiting { .. }
    ));
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
    for (kind, subject, program) in [
        ("mono", "mono-1", "python3"),
        ("project", "/p", "node"),
        ("mono", "mono-1", "curl"),
    ] {
        put_grant(
            &conn,
            SCOPE_GLOBAL,
            "stripe-api-key",
            kind,
            subject,
            program,
            "",
            "",
            "always",
            NOW,
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
        "/opt/homebrew/bin/stripe",
        "1:2:3:4",
        "",
        "always",
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
            "/opt/homebrew/bin/stripe",
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
    assert!(!runs_any_for(&plain.to_string_lossy()));
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
fn an_always_grant_covers_only_the_fingerprint_it_was_given_for() {
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
        "always",
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
    )
    .unwrap();
    assert!(text.contains("exact command"), "{text}");
}

// ---- REVIEW PROBE (round 3), not part of the PR ----------------------------------------------------------------------
mod r3_review_probe {
    use super::*;
    use std::path::Path;

    fn payload(command: &[&str], env: &str, cwd: Option<&str>, value_version: i64) -> grant::Payload {
        grant::Payload {
            program_identity: run::program_identity(Path::new(command[0])).unwrap_or_default(),
            scope: "global".into(),
            name: "stripe-api-key".into(),
            version: value_version,
            subject: "Tally".into(),
            env: env.into(),
            command: command.iter().map(|w| w.to_string()).collect(),
            cwd: cwd.map(str::to_string),
            nonce: "n".into(),
            expires_at: i64::MAX,
            timeout_seconds: 20,
        }
    }

    #[test]
    fn p1_env_name_is_not_on_the_card_and_behaviour_changing_names_pass() {
        for env in ["SSLKEYLOGFILE", "DYLD_INSERT_LIBRARIES", "DYLD_PRINT_TO_FILE", "LD_PRELOAD", "CURL_HOME", "NODE_OPTIONS", "BASH_ENV", "PYTHONSTARTUP", "GIT_SSH_COMMAND"] {
            let bench = Bench::new();
            let mut conn = bench.store.lock_conn().unwrap();
            let mut req = request("Tally", &["/usr/bin/true", "--version"]);
            req.env = env.into();
            req.project = Some("/tmp/probe-project".into());
            std::fs::create_dir_all("/tmp/probe-project/sub").unwrap();
            req.cwd = Some("/tmp/probe-project/sub".into());
            match prepare_run(&bench.vault, &mut conn, req, NOW) {
                Ok(RunOutcome::Waiting { decision_key, .. }) => {
                    let d = crate::decisions::get(&conn, "/tmp/probe-project", &decision_key).unwrap().unwrap();
                    println!("PROBE-P1 env={env}: accepted; card shows env={} cwd={}", d.question.contains(env), d.question.contains("probe-project/sub"));
                }
                other => println!("PROBE-P1 env={env}: {other:?}"),
            }
        }
    }

    #[test]
    fn p1b_same_card_text_for_two_env_names_and_answer_goes_to_the_last_bound() {
        let bench = Bench::new();
        let (_, key_a) = ask(&bench, "Tally", &["/usr/bin/true", "--version"], NOW);
        let q_a = card(&bench, &key_a).question;
        let v_a = card(&bench, &key_a).version;
        let mut req = request("Tally", &["/usr/bin/true", "--version"]);
        req.env = "SSLKEYLOGFILE".into();
        let key_b = {
            let mut conn = bench.store.lock_conn().unwrap();
            match prepare_run(&bench.vault, &mut conn, req.clone(), NOW + 1).unwrap() {
                RunOutcome::Waiting { decision_key, .. } => decision_key,
                other => panic!("{other:?}"),
            }
        };
        let after = card(&bench, &key_b);
        println!("PROBE-P1b same key={} same text={} version {} -> {}", key_a == key_b, q_a == after.question, v_a, after.version);
        person_answers(&bench, &key_a, "Once", NOW + 2);
        let mut conn = bench.store.lock_conn().unwrap();
        let out = prepare_run(&bench.vault, &mut conn, req, NOW + 3).unwrap();
        println!("PROBE-P1b SSLKEYLOGFILE run after person's Once: {out:?}");
    }

    #[test]
    fn p2_args_swapped_after_the_card_was_read() {
        let bench = Bench::new();
        let (_, key) = ask(&bench, "Tally", &["/usr/bin/true", "https://api.stripe.com/v1/balance"], NOW);
        let seen = card(&bench, &key).question;
        let _ = ask(&bench, "Tally", &["/usr/bin/true", "https://evil.example/collect"], NOW + 1);
        person_answers(&bench, &key, "Once", NOW + 2); // the person clicks on the card they read (`seen`)
        let mut conn = bench.store.lock_conn().unwrap();
        let evil = prepare_run(&bench.vault, &mut conn, request("Tally", &["/usr/bin/true", "https://evil.example/collect"]), NOW + 3).unwrap();
        println!("PROBE-P2 person read: {:?}\nPROBE-P2 evil run: {evil:?}", seen.lines().last());
    }

    #[test]
    fn p3_base64_followed_by_more_bytes() {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        for value in ["sk_live_51NxAbCdEfGhIjKlMn", "sk_live_51NxAbCdEfGhIjKlM", "sk_live_51NxAbCdEfGhIjKl"] {
            for (pre, post) in [("", ":"), ("u", ":"), ("user:", ":"), ("", "")] {
                let enc = STANDARD.encode(format!("{pre}{value}{post}"));
                let line = format!("> Authorization: Basic {enc}\n");
                let out = scrub::stream(line.as_bytes(), &scrub::needles(value));
                let survived = out.text.trim().trim_start_matches("> Authorization: Basic ");
                let decoded = STANDARD.decode(survived).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_else(|_| "<masked>".into());
                println!("PROBE-P3 len={} pre={pre:?} post={post:?} -> {} | decoded={decoded:?}", value.len(), out.text.trim(), );
            }
        }
    }

    #[test]
    fn p4_run_anything_gaps() {
        let mut missing = Vec::new();
        for name in ["just", "tclsh", "expect", "wish", "dc", "zip", "sandbox-exec", "taskpolicy", "ssh-agent", "screen", "tmux", "ex", "view", "erb", "irb", "pydoc3", "R", "gmake", "gawk", "nawk", "tofu", "pulumi", "helm", "hyperfine", "watch", "parallel", "mise", "direnv", "watchexec", "task", "elvish", "yash", "sftp", "mysql", "launchctl", "automator", "gdb", "nix", "nix-shell", "volta", "corepack", "pdm", "hatch", "tox", "nox", "julia", "runghc", "ocaml", "scala", "kotlin", "groovy", "elixir", "erl", "escript", "racket", "guile", "sbcl", "clojure", "lein", "sbt", "flock", "chroot", "su", "watchman", "turbo", "nx", "zx"] {
            if !runs_any_code(name) { missing.push(name); }
        }
        println!("PROBE-P4 not judged run-anything: {missing:?}");
    }

    #[test]
    fn p5_shebang_bypasses() {
        let dir = std::env::temp_dir().join(format!("probe-sb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for (i, line) in ["#!/usr/bin/env -S A=1 node", "#!/usr/bin/env -u X node", "#!/usr/bin/env -S node", "#!/usr/bin/env node", "#! /usr/bin/env -S -i PATH=/usr/bin python3", "#!/opt/scripts/other-script"].iter().enumerate() {
            let p = dir.join(format!("s{i}"));
            std::fs::write(&p, format!("{line}\nconsole.log(1)\n")).unwrap();
            println!("PROBE-P5 {line:?} -> runs_any_for={}", runs_any_for(&p.to_string_lossy()));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn p6_env_of_the_approved_child_is_readable_by_a_same_user_process() {
        let value = "sk_test_PROBEPROBEPROBE_42";
        let data = std::env::temp_dir();
        let p = payload(&["/bin/sleep", "1"], "STRIPE_API_KEY", None, 1);
        let needle = format!("STRIPE_API_KEY={value}");
        let handle = std::thread::spawn(move || run::execute(&p, value, &data).unwrap());
        let started = std::time::Instant::now();
        let mut found = None;
        while found.is_none() && started.elapsed() < std::time::Duration::from_secs(3) {
            for entry in std::fs::read_dir("/proc").unwrap().flatten() {
                if let Ok(bytes) = std::fs::read(entry.path().join("environ")) {
                    if String::from_utf8_lossy(&bytes).contains(&needle) {
                        found = Some(entry.file_name());
                    }
                }
            }
        }
        handle.join().unwrap();
        println!("PROBE-P6 found the key in /proc/{found:?}/environ");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn p7_sslkeylogfile_writes_a_file_named_after_the_key() {
        let value = "sk_test_PROBEKEYLOG_1234";
        let dir = std::env::temp_dir().join(format!("probe-kl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let ok = std::process::Command::new("openssl").args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "k.pem", "-out", "c.pem", "-days", "1", "-subj", "/CN=localhost"]).current_dir(&dir).output().unwrap().status.success();
        assert!(ok);
        let mut server = std::process::Command::new("openssl").args(["s_server", "-accept", "18444", "-cert", "c.pem", "-key", "k.pem", "-www", "-quiet"]).current_dir(&dir).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(700));
        let cwd = dir.join("project");
        std::fs::create_dir_all(&cwd).unwrap();
        let p = payload(&["/usr/bin/curl", "-sk", "https://127.0.0.1:18444/"], "SSLKEYLOGFILE", Some(&cwd.to_string_lossy()), 1);
        let out = run::execute(&p, value, &dir).unwrap();
        let _ = server.kill();
        let names: Vec<String> = std::fs::read_dir(&cwd).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        println!("PROBE-P7 exit={:?} stdout-len={} files in cwd: {names:?}", out.exit_code, out.stdout.text.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn p8_card_body_length_with_a_long_command() {
        let bench = Bench::new();
        let long = "a".repeat(1_380);
        let (_, key) = ask(&bench, "Tally", &["/usr/bin/true", &long], NOW);
        let q = card(&bench, &key).question;
        let body: Vec<&str> = q.lines().skip(1).collect();
        let body = body.join("\n");
        println!("PROBE-P8 body chars={} last line={:?}", body.chars().count(), q.lines().last());
    }
}
