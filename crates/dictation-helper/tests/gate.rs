//! HIGH 1 (round 3): the built helper refuses a start before any permission is asked for or the microphone opens.
//!
//! This test starts the helper as a child, with HOME pointed at an empty temporary folder, so it cannot see a real
//! setting file. It writes one refusal and exits. It reads no command from stdin and it does not listen on XPC. No
//! permission prompt can appear, because the helper never reaches the permission code.

#![cfg(target_os = "macos")]

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[test]
fn a_start_is_refused_before_any_permission_is_asked_for() {
    let home = std::env::temp_dir().join(format!("dictation-gate-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("a temporary home");
    let mut child = Command::new(env!("CARGO_BIN_EXE_monocode-dictation"))
        .env("HOME", &home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the helper starts");
    let lines: Vec<String> = BufReader::new(child.stdout.take().expect("stdout"))
        .lines()
        .map_while(Result::ok)
        .collect();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&home);
    assert_eq!(
        lines,
        vec!["{\"ev\":\"refused\",\"reason\":\"not_here\"}".to_string()],
        "the helper answers one refusal and says nothing else"
    );
}
