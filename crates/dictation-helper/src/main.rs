//! MonoCode Dictation: the helper app that holds the microphone for the Hub's composer dictation (WP-131b).
//!
//! The Hub starts this binary with responsibility disclaimed, so macOS charges the microphone and speech requests to
//! this app, not to the Hub or to anything the Hub starts. Dictation is switched off in this build
//! (protocol::DICTATION_ENABLED), so the helper refuses every start before it asks for a permission or opens the
//! microphone. The check that will let the Hub's requests through is an XPC service with a per-message peer
//! requirement (not built yet; see protocol.rs). When it is on, the helper recognises speech on the device only
//! (`requiresOnDeviceRecognition`), enforces its own 300 s and 30 s-silence limits, and talks to the Hub over stdin
//! and stdout (see protocol.rs). It opens no socket. One dictation per process: it exits when the recogniser
//! finishes, when the Hub says stop or closes stdin, or when a limit is reached.

mod protocol;

#[cfg(target_os = "macos")]
mod mac;

use std::sync::mpsc::{self, Sender};

use protocol::{Input, LineTooLong};

fn main() {
    let (tx, rx) = mpsc::channel::<Input>();
    let stdin_tx = tx.clone();
    std::thread::spawn(move || read_stdin(stdin_tx));
    #[cfg(target_os = "macos")]
    {
        // The recogniser delivers on the main queue, so the main thread runs that queue and the dictation runs on a
        // worker. The worker ends the process when it is done.
        std::thread::spawn(move || {
            mac::run(tx, rx);
            std::process::exit(0);
        });
        mac::park_main();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (tx, rx);
        protocol::emit(&protocol::Event::Refused { reason: "not_here" });
    }
}

/// Reads the Hub's lines until stdin closes. A line over the limit ends the session, like a close.
fn read_stdin(tx: Sender<Input>) {
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let mut buf = Vec::new();
    loop {
        match protocol::read_bounded_line(&mut reader, &mut buf) {
            Ok(false) | Err(LineTooLong) => break,
            Ok(true) => {
                let Ok(line) = std::str::from_utf8(&buf) else {
                    continue;
                };
                if let Some(command) = protocol::parse_command(line) {
                    if tx.send(Input::Cmd(command)).is_err() {
                        return;
                    }
                }
            }
        }
    }
    let _ = tx.send(Input::Closed);
}
