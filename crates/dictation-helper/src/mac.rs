//! The macOS side of the helper: the gate, the microphone and speech permissions, the on-device recogniser and the
//! audio tap.
//!
//! The recogniser delivers its results on the main dispatch queue. So the main thread runs that queue (`park_main`),
//! and the dictation runs on a worker thread (main.rs). The worker never blocks the main thread.

use std::cell::Cell;
use std::ffi::CString;
use std::panic::AssertUnwindSafe;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::exception;
use objc2::msg_send;
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2_foundation::NSString;

use crate::protocol::{self, cap, emit, over_limit, Command, Event, Input};

// The Speech and AVFoundation frameworks provide the recogniser, the audio engine and the microphone prompt.
#[link(name = "Speech", kind = "framework")]
extern "C" {}
#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}
extern "C" {
    /// libdispatch: runs the main queue on the calling thread, which must be the main thread. Never returns.
    fn dispatch_main() -> !;
}

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
/// How often the worker checks the limits while it waits for the Hub.
const POLL: Duration = Duration::from_millis(250);

/// Parks the main thread on the main dispatch queue, where the recogniser delivers its results. Never returns.
pub fn park_main() -> ! {
    unsafe { dispatch_main() }
}

/// What the helper checks before any permission is asked for or the microphone opens. Dictation is off in this build
/// (protocol::DICTATION_ENABLED), so this refuses every start. Once it is on, the helper must also be its own
/// responsible process: started without disclaim, macOS names the launcher, and the helper refuses (LOW 4).
fn gate() -> Result<(), &'static str> {
    if !protocol::DICTATION_ENABLED {
        return Err("not_here");
    }
    let me = unsafe { libc::getpid() };
    if protocol::is_own_responsible(me, responsible_pid(me)) {
        Ok(())
    } else {
        Err("not_here")
    }
}

/// The Mac's responsible process for `pid`, from the same private symbol the Hub's launcher uses (disclaim.rs).
/// None when the symbol is missing, which makes the gate refuse.
fn responsible_pid(pid: libc::pid_t) -> Option<libc::pid_t> {
    type ResponsibleFor = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
    let name = CString::new("responsibility_get_pid_responsible_for_pid").ok()?;
    let found = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    if found.is_null() {
        return None;
    }
    let function: ResponsibleFor = unsafe { std::mem::transmute(found) };
    let responsible = unsafe { function(pid) };
    (responsible > 0).then_some(responsible)
}

/// Runs one dictation from the Hub's start to the end of its results.
pub fn run(tx: Sender<Input>, rx: Receiver<Input>) {
    if let Some(path) = smoke_path() {
        smoke_file(&path, tx);
        return;
    }
    // LOW 3: the smoke build never opens the microphone. Without a recording to read, it refuses.
    if cfg!(feature = "smoke") {
        emit(&Event::Refused { reason: "not_here" });
        return;
    }
    if let Err(reason) = gate() {
        emit(&Event::Refused { reason });
        return;
    }
    match rx.recv() {
        Ok(Input::Cmd(Command::Start)) => {}
        _ => return,
    }
    if let Err(reason) = authorize() {
        emit(&Event::Refused { reason });
        return;
    }
    // M1: the Hub may stop, or close stdin, while a permission prompt is up. Then the microphone stays closed.
    if matches!(
        rx.try_recv(),
        Ok(Input::Closed) | Ok(Input::Cmd(Command::Stop))
    ) {
        return;
    }
    let started = Instant::now();
    let words = Arc::new(Mutex::new(started));
    let session = match Session::start(tx, words.clone()) {
        Ok(session) => session,
        Err(reason) => {
            emit(&Event::Refused { reason });
            return;
        }
    };
    emit(&Event::Ready);
    session.wait(rx, started, words);
}

/// The recorded file the smoke test recognises. Only a build with the `smoke` feature reads it.
#[cfg(feature = "smoke")]
fn smoke_path() -> Option<std::ffi::OsString> {
    std::env::var_os("MONOCODE_DICTATION_SMOKE_FILE")
}

#[cfg(not(feature = "smoke"))]
fn smoke_path() -> Option<std::ffi::OsString> {
    None
}

/// Smoke test (feature `smoke`): recognises a recorded file with SFSpeechURLRecognitionRequest. No microphone is
/// opened. If speech recognition is not already authorized it refuses without asking, so no prompt can appear.
fn smoke_file(path: &std::ffi::OsStr, tx: Sender<Input>) {
    if speech_status() != SPEECH_AUTHORIZED {
        emit(&Event::Refused { reason: "denied" });
        return;
    }
    let Some(recognizer) = guard(build_recognizer).ok().flatten() else {
        emit(&Event::Refused { reason: "not_here" });
        return;
    };
    let Some(path) = path.to_str() else {
        emit(&Event::Refused { reason: "not_here" });
        return;
    };
    let Some(url_class) = AnyClass::get(c"NSURL") else {
        emit(&Event::Refused { reason: "not_here" });
        return;
    };
    let Some(request_class) = AnyClass::get(c"SFSpeechURLRecognitionRequest") else {
        emit(&Event::Refused { reason: "not_here" });
        return;
    };
    let file = NSString::from_str(path);
    let url: Retained<AnyObject> = unsafe { msg_send![url_class, fileURLWithPath: &*file] };
    let allocated: Allocated<AnyObject> = unsafe { msg_send![request_class, alloc] };
    let request: Option<Retained<AnyObject>> = unsafe { msg_send![allocated, initWithURL: &*url] };
    let Some(request) = request else {
        emit(&Event::Refused { reason: "not_here" });
        return;
    };
    unsafe {
        let _: () = msg_send![&*request, setRequiresOnDeviceRecognition: Bool::YES];
        let _: () = msg_send![&*request, setShouldReportPartialResults: Bool::NO];
    }
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let handler = RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
        let (text, is_final) = match unsafe { result.as_ref() } {
            Some(result) => result_text(result),
            None => (String::new(), false),
        };
        let failed = !error.is_null();
        if failed || is_final {
            emit(&Event::Final {
                text: cap(&text),
                error: failed,
            });
            let _ = done_tx.send(());
        }
    });
    let task: Option<Retained<AnyObject>> = unsafe {
        msg_send![&*recognizer, recognitionTaskWithRequest: &*request, resultHandler: &*handler]
    };
    // The recogniser, its request and its task stay alive until the result arrives.
    let _keep = (&recognizer, &request, &task);
    let _ = done_rx.recv_timeout(Duration::from_secs(120));
    drop(tx);
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
    if AnyClass::get(c"SFSpeechRecognizer").is_none() || AnyClass::get(c"AVAudioEngine").is_none() {
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

/// The live recogniser, request, engine and tap. The recogniser is kept for the whole session: a recogniser that is
/// dropped while it listens stops delivering results.
struct Session {
    recognizer: Retained<AnyObject>,
    request: Retained<AnyObject>,
    engine: Retained<AnyObject>,
    input: Retained<AnyObject>,
    task: Option<Retained<AnyObject>>,
    halted: Cell<bool>,
}

impl Session {
    fn start(tx: Sender<Input>, words: Arc<Mutex<Instant>>) -> Result<Self, &'static str> {
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

        // Results arrive on the main queue. Each partial is shown and counts as words for the silence limit; the
        // final one (or an error) ends the session.
        let finished = Arc::new(AtomicBool::new(false));
        let result_finished = finished.clone();
        let result_handler = RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
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
                    if let Ok(mut last) = words.lock() {
                        *last = Instant::now();
                    }
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

    /// Runs until the Hub stops us, closes stdin, the recogniser finishes, or a limit is reached. A stop (or a limit)
    /// waits a little for the last result, so the words heard so far are not lost.
    fn wait(self, rx: Receiver<Input>, started: Instant, words: Arc<Mutex<Instant>>) {
        let mut stop_by: Option<Instant> = None;
        loop {
            let now = Instant::now();
            let timeout = match stop_by {
                None => POLL,
                Some(deadline) => deadline.saturating_duration_since(now).min(POLL),
            };
            match rx.recv_timeout(timeout) {
                Ok(Input::Cmd(Command::Start)) => {}
                Ok(Input::Cmd(Command::Stop)) => {
                    if stop_by.is_none() {
                        self.halt();
                        stop_by = Some(Instant::now() + FINISH_WAIT);
                    }
                }
                Ok(Input::Closed) | Ok(Input::Done) => break,
                Err(RecvTimeoutError::Timeout) => {
                    let now = Instant::now();
                    match stop_by {
                        Some(deadline) if now >= deadline => break,
                        Some(_) => {}
                        None => {
                            let last = words.lock().map(|last| *last).unwrap_or(started);
                            if over_limit(started, last, now) {
                                self.halt();
                                stop_by = Some(now + FINISH_WAIT);
                            }
                        }
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_raised_objective_c_exception_becomes_an_error_not_an_abort() {
        use objc2::exception::{throw, Exception};
        use objc2_foundation::NSException;
        let name = NSString::from_str("NSInvalidArgumentException");
        let reason = NSString::from_str("probe");
        let raised: Retained<NSException> =
            unsafe { NSException::exceptionWithName_reason_userInfo(&name, Some(&reason), None) };
        // Foundation's NSException and objc2's Exception are the same Objective-C object.
        let raised: Retained<Exception> = unsafe { Retained::cast_unchecked(raised) };
        assert!(guard(|| -> u8 { throw(raised) }).is_err());
    }

    #[test]
    fn a_call_that_returns_is_passed_through() {
        assert_eq!(guard(|| 7u8), Ok(7));
    }

    // HIGH 1 (round 3): the helper does not trust its parent. While dictation is off in this build, the gate refuses
    // before any permission is asked for, whoever started the helper.
    #[test]
    fn the_gate_refuses_before_any_prompt_while_dictation_is_off() {
        assert_eq!(gate(), Err("not_here"));
    }

    // LOW 4 (round 3): a plain child is not its own responsible process, so the gate would refuse it. The test
    // process stands in for a helper started without disclaim.
    #[test]
    fn a_plain_child_is_not_its_own_responsible_process() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("1")
            .spawn()
            .expect("sleep starts");
        let pid = child.id() as libc::pid_t;
        std::thread::sleep(Duration::from_millis(200));
        let responsible = responsible_pid(pid);
        let _ = child.kill();
        let _ = child.wait();
        assert!(!protocol::is_own_responsible(pid, responsible));
    }
}
