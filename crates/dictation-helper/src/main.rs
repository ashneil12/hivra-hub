//! MonoCode Dictation: the helper app that holds the microphone for the Hub's composer dictation (WP-131b).
//!
//! launchd runs this binary as an SMAppService agent (the Hub registers the plist; it does not spawn the helper).
//! macOS charges the microphone and speech requests to this app. Dictation is switched off in this build
//! (protocol::DICTATION_ENABLED), so the helper refuses every start before it asks for a permission or opens the
//! microphone, and it does not listen on XPC. When it is on, the helper is an XPC Mach service that checks every
//! message's peer against a code requirement before anything else (xpc.rs). It recognises speech on the device only
//! (`requiresOnDeviceRecognition`) and enforces its own 300 s and 30 s-silence limits. It opens no socket and reads
//! no commands from stdin. One dictation per process: it exits when the recogniser finishes, when the Hub says stop
//! or drops the connection, or when a limit is reached.

mod protocol;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
mod xpc;

#[cfg(all(target_os = "macos", feature = "smoke"))]
use std::sync::mpsc;

fn main() {
    // The smoke build recognises a recorded file and never opens the microphone. It is not shipped.
    #[cfg(all(target_os = "macos", feature = "smoke"))]
    {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            mac::run(tx, rx);
            std::process::exit(0);
        });
        mac::park_main();
    }
    if !protocol::dictation_enabled() {
        // No XPC listener, no stdin, no permission. One refusal line, then the process ends.
        protocol::emit(&protocol::Event::Refused { reason: "not_here" });
        return;
    }
    #[cfg(target_os = "macos")]
    {
        // The recogniser delivers on the main queue, so the main thread runs that queue and the service runs on a
        // worker. The worker ends the process when the dictation is done.
        std::thread::spawn(|| {
            xpc::serve();
            std::process::exit(0);
        });
        mac::park_main();
    }
    #[cfg(not(target_os = "macos"))]
    {
        protocol::emit(&protocol::Event::Refused { reason: "not_here" });
    }
}
