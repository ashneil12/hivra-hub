//! Smoke test for the recogniser (MEDIUM 1): a recorded phrase is recognised on the device through
//! SFSpeechURLRecognitionRequest. No microphone is opened, and no permission prompt can appear: when speech
//! recognition is not already authorized, the helper refuses and the test skips, saying so.
//!
//! Run with: cargo test -p monocode-dictation --features smoke --test smoke

#![cfg(all(target_os = "macos", feature = "smoke"))]

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[test]
fn a_recorded_phrase_is_recognised_on_the_device_without_a_microphone() {
    let dir = std::env::temp_dir().join(format!("dictation-smoke-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let audio = dir.join("phrase.aiff");
    let said = Command::new("say")
        .arg("-o")
        .arg(&audio)
        .arg("hello from the dictation helper")
        .status()
        .expect("say makes the recorded phrase");
    assert!(said.success(), "say wrote the recording");

    let mut child = Command::new(env!("CARGO_BIN_EXE_monocode-dictation"))
        .env("MONOCODE_DICTATION_SMOKE_FILE", &audio)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the helper starts");
    let lines = BufReader::new(child.stdout.take().expect("stdout")).lines();
    let mut final_line = None;
    for line in lines.map_while(Result::ok) {
        if line.contains("\"ev\":\"refused\"") {
            eprintln!(
                "skipped: speech recognition is not authorized here ({line}); no prompt was shown"
            );
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        if line.contains("\"ev\":\"final\"") {
            final_line = Some(line);
            break;
        }
    }
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&dir);
    let heard = final_line.expect("the recogniser delivered a final result");
    assert!(
        heard.to_lowercase().contains("hello"),
        "the recogniser heard: {heard}"
    );
}
