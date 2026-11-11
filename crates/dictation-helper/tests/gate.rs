//! HIGH 1 (round 3): the built helper refuses a start before any permission is asked for or the microphone opens.
//!
//! Dictation is switched off in this build, so the helper writes one refusal and exits. It reads no command from
//! stdin and it does not listen on XPC. No permission prompt can appear, because the helper never reaches the
//! permission code.

#![cfg(target_os = "macos")]

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[test]
fn a_start_is_refused_before_any_permission_is_asked_for() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_monocode-dictation"))
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
    assert_eq!(
        lines,
        vec!["{\"ev\":\"refused\",\"reason\":\"not_here\"}".to_string()],
        "the helper answers one refusal and says nothing else"
    );
}
