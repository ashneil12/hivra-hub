//! MonoCode Dictation: the helper app that holds the microphone for the Hub's composer dictation (WP-131b).
//!
//! launchd runs this binary as an SMAppService agent (the Hub registers the plist; it does not spawn the helper).
//! macOS charges the microphone and speech requests to this app. The helper refuses every start unless the build's
//! kill switch allows it and the Hub's setting file says on. Until then it asks for no permission, opens no
//! microphone, and does not listen on XPC. When it is on, the helper is an XPC Mach service that checks every
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
        mac::run(tx, rx);
        return;
    }
    if !protocol::dictation_enabled() {
        // No XPC listener, no stdin, no permission. One refusal line, then the process ends.
        protocol::emit(&protocol::Event::Refused { reason: "not_here" });
        return;
    }
    #[cfg(target_os = "macos")]
    {
        // The recogniser delivers on its own queue. This thread only pumps a run loop so a permission dialog can
        // appear. The service runs on a worker and ends the process when the dictation is done. A stop is read on
        // that worker, so a result that is still pending cannot block it.
        std::thread::spawn(|| {
            xpc::serve();
            std::process::exit(0);
        });
        mac::pump_dialogs();
    }
    #[cfg(not(target_os = "macos"))]
    {
        protocol::emit(&protocol::Event::Refused { reason: "not_here" });
    }
}
