//! The macOS side of the helper: the gate, the microphone and speech permissions, the on-device recogniser and the
//! audio tap.
//!
//! The recogniser delivers its results on its own serial queue, not the main queue. The main thread only pumps a run
//! loop so a permission dialog can appear (`pump_dialogs`). The dictation and the XPC service run on a worker, so a
//! stop is read even while a result is still pending.

use std::cell::Cell;
use std::ffi::CString;
use std::panic::AssertUnwindSafe;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::exception;
use objc2::msg_send;
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::sel;
use objc2_foundation::NSString;

use crate::protocol::{self, cap, emit, over_limit, Command, Event, Input};

// The Speech and AVFoundation frameworks provide the recogniser, the audio engine and the microphone prompt.
#[link(name = "Speech", kind = "framework")]
extern "C" {}
#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}
extern "C" {
    /// A new serial queue. `attr` null means serial. The queue lives for the process; it is not released.
    fn dispatch_queue_create(
        label: *const libc::c_char,
        attr: *const libc::c_void,
    ) -> *mut libc::c_void;
    /// `dispatch_get_main_queue()` is a macro for this symbol. Taking its address is the main queue.
    static _dispatch_main_q: u8;
    /// Copies `block` before it returns, so the caller may drop its own copy. Only the test posts a job; a live
    /// result is delivered by Speech because `setQueue:` points at this queue.
    #[cfg(test)]
    fn dispatch_async(queue: *mut libc::c_void, block: *mut libc::c_void);
}

/// The recogniser's queue, as a pointer-sized integer so it can sit in a `OnceLock` (a raw pointer is not `Send`).
static RECOGNISER_QUEUE: OnceLock<usize> = OnceLock::new();

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

/// Pumps the main thread's run loop so a permission dialog can appear. Recogniser results are not delivered here.
/// Never returns: the service thread ends the process.
pub fn pump_dialogs() -> ! {
    core_foundation::runloop::CFRunLoop::run_current();
    std::process::exit(0);
}

/// The private serial queue the recogniser delivers on. Not the main queue. Null if it could not be created.
fn recogniser_queue() -> *mut libc::c_void {
    let bits = *RECOGNISER_QUEUE.get_or_init(|| {
        let Ok(label) = CString::new("com.ash.monocode-hub.dictation.recogniser") else {
            return 0;
        };
        unsafe { dispatch_queue_create(label.as_ptr(), ptr::null()) as usize }
    });
    bits as *mut libc::c_void
}

fn main_dispatch_queue() -> *mut libc::c_void {
    std::ptr::addr_of!(_dispatch_main_q).cast_mut().cast()
}

/// Runs `job` on the recogniser queue. Does nothing if that queue is missing or is the main queue, so a result can
/// never be posted onto the thread that pumps dialogs. The live handler is not posted from here: Speech calls it
/// because the recogniser's queue was set.
#[cfg(test)]
fn post_on_recogniser(job: impl FnOnce() + Send + 'static) {
    let queue = recogniser_queue();
    if queue.is_null() || std::ptr::eq(queue, main_dispatch_queue()) {
        return;
    }
    let slot = Mutex::new(Some(job));
    let block = RcBlock::new(move || {
        if let Some(job) = slot.lock().ok().and_then(|mut guard| guard.take()) {
            job();
        }
    });
    unsafe { dispatch_async(queue, RcBlock::as_ptr(&block).cast()) };
}

/// Points the recogniser at its own queue. A missing `setQueue:`, a null queue, or the main queue refuses the start.
/// Called before the audio engine exists, so a refusal never opens the microphone.
fn install_recogniser_queue(recognizer: &AnyObject) -> Result<(), &'static str> {
    let selector = sel!(setQueue:);
    let responds: Bool = unsafe { msg_send![recognizer, respondsToSelector: selector] };
    if !responds.as_bool() {
        return Err("not_here");
    }
    let queue = recogniser_queue();
    if queue.is_null() || std::ptr::eq(queue, main_dispatch_queue()) {
        return Err("not_here");
    }
    if guard(|| unsafe {
        let _: () = msg_send![recognizer, setQueue: queue];
    })
    .is_err()
    {
        return Err("not_here");
    }
    Ok(())
}

/// What the helper checks before any permission is asked for or the microphone opens. The setting has to say on, and
/// the helper must be its own responsible process: a helper launchd started is; one started as a child of something
/// else is not (LOW 4). A test build does not read the setting file, so this refuses there.
pub(crate) fn gate() -> Result<(), &'static str> {
    if !protocol::dictation_enabled() {
        return Err("not_here");
    }
    let me = unsafe { libc::getpid() };
    if protocol::is_own_responsible(me, responsible_pid(me)) {
        Ok(())
    } else {
        Err("not_here")
    }
}

/// The setting file in the Hub's application-support folder, read only by a real helper. A test build does not call
/// this, so a test cannot read the daily app's folder. None when this process is not the helper bundle, the home is
/// empty or walks upwards, or the file cannot be read. A missing file is off.
#[cfg(not(test))]
pub(crate) fn saved_setting_text() -> Option<String> {
    let bundle_id = current_bundle_id()?;
    let hub = protocol::hub_id_from_helper_bundle(&bundle_id)?;
    let home = std::env::var_os("HOME")?;
    let home = std::path::PathBuf::from(home);
    if home.as_os_str().is_empty()
        || home
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return None;
    }
    let path = home
        .join("Library")
        .join("Application Support")
        .join(hub)
        .join(protocol::SETTING_FILE);
    if path.file_name().and_then(|name| name.to_str()) != Some(protocol::SETTING_FILE) {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// This process's bundle identifier, when it has one. A raw test binary has none.
#[cfg(not(test))]
fn current_bundle_id() -> Option<String> {
    let class = AnyClass::get(c"NSBundle")?;
    let bundle: *mut AnyObject = unsafe { msg_send![class, mainBundle] };
    let bundle = unsafe { bundle.as_ref() }?;
    let identifier: Option<Retained<NSString>> = unsafe { msg_send![bundle, bundleIdentifier] };
    identifier
        .map(|text| text.to_string())
        .filter(|text| !text.is_empty())
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
    // M1: the Hub may stop, or drop the connection, while a permission prompt is up. Then the microphone stays
    // closed. mic_may_open is the same rule the unit test pins.
    let stopped_during_prompt = matches!(
        rx.try_recv(),
        Ok(Input::Closed) | Ok(Input::Cmd(Command::Stop))
    );
    if !protocol::mic_may_open(stopped_during_prompt) {
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
    // Same queue as a live session. Smoke never opens the microphone, and it does not park the main thread.
    if install_recogniser_queue(&recognizer).is_err() {
        emit(&Event::Refused { reason: "not_here" });
        return;
    }
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
        // Before the audio engine exists, so a missing queue never opens the microphone.
        install_recogniser_queue(&recognizer)?;

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

        // Results arrive on the recogniser queue, not the main queue. Each partial is shown and counts as words for
        // the silence limit; the final one (or an error) ends the session. A stop is read on this thread, so it is
        // not stuck behind a result that is still running.
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

    // HIGH 1 (round 3): the helper does not trust its parent. A test build does not read the setting file, so the gate
    // refuses before any permission is asked for, whoever started the helper.
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

    // M1: a result runs on the recogniser's own queue. The session thread reads a stop while that result is still
    // pending. This does not open the microphone, ask for speech, or touch the recogniser class.
    #[test]
    fn a_stop_is_handled_while_a_result_is_pending() {
        let pending = Arc::new(AtomicBool::new(true));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let flag = pending.clone();
        post_on_recogniser(move || {
            let _ = entered_tx.send(());
            let _ = release_rx.recv();
            flag.store(false, Ordering::SeqCst);
        });
        entered_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the result started on the recogniser queue");
        let (cmd_tx, cmd_rx) = mpsc::channel();
        cmd_tx.send(Input::Cmd(Command::Stop)).unwrap();
        let handled = std::thread::spawn(move || {
            matches!(
                cmd_rx.recv_timeout(Duration::from_secs(2)),
                Ok(Input::Cmd(Command::Stop))
            )
        });
        assert!(
            handled.join().unwrap(),
            "a stop is handled while the result is still pending"
        );
        assert!(
            pending.load(Ordering::SeqCst),
            "the result was still pending when the stop was handled"
        );
        release_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while pending.load(Ordering::SeqCst) {
            assert!(
                Instant::now() < deadline,
                "the pending result never finished"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn the_recogniser_queue_is_not_the_main_queue() {
        let queue = recogniser_queue();
        assert!(!queue.is_null());
        assert!(!std::ptr::eq(queue, main_dispatch_queue()));
    }
}
