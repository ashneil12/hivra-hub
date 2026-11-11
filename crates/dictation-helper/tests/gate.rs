//! HIGH 1 (round 3): the built helper refuses a start before any permission is asked for or the microphone opens.
//!
//! This runs the real binary the way the Hub or any other process would: a start line on stdin, then the answer on
//! stdout. Dictation is switched off in this build, so the answer is a refusal and nothing else. No permission
//! prompt can appear, because the helper never reaches the permission code.

#![cfg(target_os = "macos")]

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
fn a_start_is_refused_before_any_permission_is_asked_for() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_monocode-dictation"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the helper starts");
    let mut stdin = child.stdin.take().expect("stdin");
    writeln!(stdin, "{{\"op\":\"start\"}}").expect("the start line is written");
    drop(stdin);
    let lines: Vec<String> = BufReader::new(child.stdout.take().expect("stdout"))
        .lines()
        .map_while(Result::ok)
        .collect();
    let _ = child.wait();
    assert_eq!(
        lines,
        vec!["{\"ev\":\"refused\",\"reason\":\"not_here\"}".to_string()],
        "the helper answers one refusal and says nothing else"
    );
}
