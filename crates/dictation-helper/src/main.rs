//! MonoCode Dictation: the helper app that holds the microphone for the Hub's composer dictation (WP-131b).
//!
//! The Hub starts this binary with responsibility disclaimed, so macOS charges the microphone and speech requests to
//! this app, not to the Hub or to anything the Hub starts. It recognises speech on the device only
//! (`requiresOnDeviceRecognition`) and talks to the Hub over stdin and stdout (see protocol.rs). It opens no socket.
//! One dictation per process: it starts when the Hub says so, and exits when the recogniser finishes, when the Hub
//! says stop, or when the Hub closes stdin.

mod protocol;

use std::io::BufRead;
use std::sync::mpsc;

use protocol::Input;

fn main() {
    let (tx, rx) = mpsc::channel::<Input>();
    let stdin_tx = tx.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if let Some(command) = protocol::parse_command(&line) {
                if stdin_tx.send(Input::Cmd(command)).is_err() {
                    return;
                }
            }
        }
        let _ = stdin_tx.send(Input::Closed);
    });
    #[cfg(target_os = "macos")]
    mac::run(tx, rx);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (tx, rx);
        protocol::emit(&protocol::Event::Refused { reason: "not_here" });
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::Cell;
    use std::panic::AssertUnwindSafe;
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use block2::RcBlock;
    use objc2::exception;
    use objc2::msg_send;
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSString;

    use crate::protocol::{cap, emit, Command, Event, Input};

    // The Speech and AVFoundation frameworks provide the recogniser, the audio engine and the microphone prompt.
    #[link(name = "Speech", kind = "framework")]
    extern "C" {}
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    /// AVMediaTypeAudio ("soun"), AVAuthorizationStatusNotDetermined (0) and AVAuthorizationStatusAuthorized (3).
    const MEDIA_TYPE_AUDIO: &str = "soun";
    const AV_NOT_DETERMINED: isize = 0;
    const AV_AUTHORIZED: isize = 3;
    /// SFSpeechRecognizerAuthorizationStatusNotDetermined (0) and Authorized (3).
    const SPEECH_NOT_DETERMINED: isize = 0;
    const SPEECH_AUTHORIZED: isize = 3;
    /// A prompt left unanswered this long counts as a no.
    const PROMPT_WAIT: Duration = Duration::from_secs(600);
    /// After a stop, how long the recogniser may take to deliver its last result.
    const FINISH_WAIT: Duration = Duration::from_secs(5);

    /// Runs one dictation from the Hub's start to the end of its results.
    pub fn run(tx: Sender<Input>, rx: Receiver<Input>) {
        match rx.recv() {
            Ok(Input::Cmd(Command::Start)) => {}
            _ => return,
        }
        if let Err(reason) = authorize() {
            emit(&Event::Refused { reason });
            return;
        }
        let session = match Session::start(tx) {
            Ok(session) => session,
            Err(reason) => {
                emit(&Event::Refused { reason });
                return;
            }
        };
        emit(&Event::Ready);
        session.wait(rx);
    }

    /// Runs a call that may raise an Objective-C exception. A raise becomes Err instead of aborting the helper.
    fn guard<R>(call: impl FnOnce() -> R) -> Result<R, ()> {
        exception::catch(AssertUnwindSafe(call)).map_err(|_| ())
    }

    fn microphone_status() -> isize {
        let Some(class) = AnyClass::get(c"AVCaptureDevice") else {
            return -1;
        };
        let media = NSString::from_str(MEDIA_TYPE_AUDIO);
        unsafe { msg_send![class, authorizationStatusForMediaType: &*media] }
    }

    fn speech_status() -> isize {
        let Some(class) = AnyClass::get(c"SFSpeechRecognizer") else {
            return -1;
        };
        unsafe { msg_send![class, authorizationStatus] }
    }

    /// Asks for the microphone. The answer arrives on the returned channel, from a system queue.
    fn request_microphone() -> Option<Receiver<bool>> {
        let class = AnyClass::get(c"AVCaptureDevice")?;
        let (tx, rx) = mpsc::channel::<bool>();
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        let media = NSString::from_str(MEDIA_TYPE_AUDIO);
        unsafe {
            let _: () =
                msg_send![class, requestAccessForMediaType: &*media, completionHandler: &*handler];
        }
        Some(rx)
    }

    fn request_speech() -> Option<Receiver<isize>> {
        let class = AnyClass::get(c"SFSpeechRecognizer")?;
        let (tx, rx) = mpsc::channel::<isize>();
        let handler = RcBlock::new(move |status: isize| {
            let _ = tx.send(status);
        });
        unsafe {
            let _: () = msg_send![class, requestAuthorization: &*handler];
        }
        Some(rx)
    }

    fn wait<T>(rx: Receiver<T>) -> Option<T> {
        rx.recv_timeout(PROMPT_WAIT).ok()
    }

    /// The microphone and speech permissions, asked for in turn. A refusal names what was refused.
    fn authorize() -> Result<(), &'static str> {
        if AnyClass::get(c"SFSpeechRecognizer").is_none()
            || AnyClass::get(c"AVAudioEngine").is_none()
        {
            return Err("not_here");
        }
        match microphone_status() {
            AV_AUTHORIZED => {}
            AV_NOT_DETERMINED => {
                if request_microphone().and_then(wait) != Some(true) {
                    return Err("denied");
                }
            }
            _ => return Err("denied"),
        }
        match speech_status() {
            SPEECH_AUTHORIZED => {}
            SPEECH_NOT_DETERMINED => {
                if request_speech().and_then(wait) != Some(SPEECH_AUTHORIZED) {
                    return Err("denied");
                }
            }
            _ => return Err("denied"),
        }
        Ok(())
    }

    /// The live recogniser, request, engine and tap. The recogniser is kept for the whole session: a recogniser that
    /// is dropped while it listens stops delivering results.
    struct Session {
        recognizer: Retained<AnyObject>,
        request: Retained<AnyObject>,
        engine: Retained<AnyObject>,
        input: Retained<AnyObject>,
        task: Option<Retained<AnyObject>>,
        halted: Cell<bool>,
    }

    impl Session {
        fn start(tx: Sender<Input>) -> Result<Self, &'static str> {
            let recognizer = guard(build_recognizer).ok().flatten().ok_or("not_here")?;
            let available: Bool = unsafe { msg_send![&*recognizer, isAvailable] };
            if !available.as_bool() {
                return Err("not_here");
            }
            // The words never leave this Mac: a recogniser that would need a server refuses the start.
            let on_device: Bool = unsafe { msg_send![&*recognizer, supportsOnDeviceRecognition] };
            if !on_device.as_bool() {
                return Err("not_on_device");
            }

            let request_class =
                AnyClass::get(c"SFSpeechAudioBufferRecognitionRequest").ok_or("not_here")?;
            let request: Retained<AnyObject> = unsafe { msg_send![request_class, new] };
            unsafe {
                let _: () = msg_send![&*request, setShouldReportPartialResults: Bool::YES];
                let _: () = msg_send![&*request, setRequiresOnDeviceRecognition: Bool::YES];
            }

            let engine_class = AnyClass::get(c"AVAudioEngine").ok_or("not_here")?;
            let engine: Retained<AnyObject> = unsafe { msg_send![engine_class, new] };
            let input: Retained<AnyObject> = unsafe { msg_send![&*engine, inputNode] };
            let format: Retained<AnyObject> =
                guard(|| unsafe { msg_send![&*input, outputFormatForBus: 0usize] })
                    .map_err(|_| "no_microphone")?;
            // No input channel or no sample rate means there is no microphone to hear. The tap would raise on it.
            let channels: u32 = unsafe { msg_send![&*format, channelCount] };
            let rate: f64 = unsafe { msg_send![&*format, sampleRate] };
            if channels == 0 || rate.is_nan() || rate <= 0.0 {
                return Err("no_microphone");
            }

            // The audio thread appends each buffer to the request. Appending is thread-safe by Apple's contract.
            let tap_request = request.clone();
            let tap = RcBlock::new(move |buffer: *mut AnyObject, _when: *mut AnyObject| {
                if let Some(buffer) = unsafe { buffer.as_ref() } {
                    unsafe {
                        let _: () = msg_send![&*tap_request, appendAudioPCMBuffer: buffer];
                    }
                }
            });
            let installed = guard(|| unsafe {
                let _: () = msg_send![&*input, installTapOnBus: 0usize, bufferSize: 1024u32, format: &*format, block: &*tap];
            });
            if installed.is_err() {
                return Err("no_microphone");
            }
            if guard(|| unsafe {
                let _: () = msg_send![&*engine, prepare];
            })
            .is_err()
            {
                remove_tap(&input);
                return Err("no_microphone");
            }
            let started = guard(|| {
                let mut error: *mut AnyObject = ptr::null_mut();
                let ok: Bool = unsafe { msg_send![&*engine, startAndReturnError: &mut error] };
                ok.as_bool()
            });
            if started != Ok(true) {
                remove_tap(&input);
                return Err("no_microphone");
            }

            // Results arrive on a Speech queue. Each partial is shown; the final one (or an error) ends the session.
            let finished = Arc::new(AtomicBool::new(false));
            let result_finished = finished.clone();
            let result_handler =
                RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
                    let (text, is_final) = match unsafe { result.as_ref() } {
                        Some(result) => result_text(result),
                        None => (String::new(), false),
                    };
                    let failed = !error.is_null();
                    if failed || is_final {
                        if !result_finished.swap(true, Ordering::SeqCst) {
                            emit(&Event::Final {
                                text: cap(&text),
                                error: failed,
                            });
                        }
                        let _ = tx.send(Input::Done);
                    } else {
                        let text = cap(&text);
                        if !text.is_empty() {
                            emit(&Event::Heard { text });
                        }
                    }
                });
            let task: Option<Retained<AnyObject>> = unsafe {
                msg_send![&*recognizer, recognitionTaskWithRequest: &*request, resultHandler: &*result_handler]
            };

            Ok(Self {
                recognizer,
                request,
                engine,
                input,
                task,
                halted: Cell::new(false),
            })
        }

        /// Runs until the Hub stops us, closes stdin, or the recogniser finishes. A stop waits a little for the last
        /// result, so the words heard so far are not lost.
        fn wait(self, rx: Receiver<Input>) {
            let mut stop_by: Option<Instant> = None;
            loop {
                let next = match stop_by {
                    None => rx.recv().ok(),
                    Some(deadline) => rx
                        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .ok(),
                };
                match next {
                    Some(Input::Cmd(Command::Start)) => {}
                    Some(Input::Cmd(Command::Stop)) => {
                        if stop_by.is_none() {
                            self.halt();
                            stop_by = Some(Instant::now() + FINISH_WAIT);
                        }
                    }
                    Some(Input::Closed) | Some(Input::Done) | None => break,
                }
            }
            self.halt();
            // The recogniser, request, engine and task are released by the process exiting, after the last result.
            let _ = (&self.recognizer, &self.task);
        }

        /// Stops the audio and tells the recogniser there is no more. Runs once.
        fn halt(&self) {
            if self.halted.replace(true) {
                return;
            }
            let _ = guard(|| unsafe {
                let _: () = msg_send![&*self.engine, stop];
            });
            remove_tap(&self.input);
            let _ = guard(|| unsafe {
                let _: () = msg_send![&*self.request, endAudio];
            });
        }
    }

    fn build_recognizer() -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"SFSpeechRecognizer")?;
        unsafe {
            let allocated: Allocated<AnyObject> = msg_send![class, alloc];
            msg_send![allocated, init]
        }
    }

    fn remove_tap(input: &AnyObject) {
        let _ = guard(|| unsafe {
            let _: () = msg_send![input, removeTapOnBus: 0usize];
        });
    }

    /// The best transcription so far, and whether it is the final one.
    fn result_text(result: &AnyObject) -> (String, bool) {
        let transcription: *mut AnyObject = unsafe { msg_send![result, bestTranscription] };
        let text: Option<Retained<NSString>> = match unsafe { transcription.as_ref() } {
            Some(transcription) => unsafe { msg_send![transcription, formattedString] },
            None => None,
        };
        let is_final: Bool = unsafe { msg_send![result, isFinal] };
        (
            text.map(|s| s.to_string()).unwrap_or_default(),
            is_final.as_bool(),
        )
    }
}
