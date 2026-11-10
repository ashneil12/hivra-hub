//! WP-131: desktop dictation for the composer draft.
//!
//! The person asks, the app explains, the person continues, and only then
//! does the microphone open. Words come from the Mac's on-device speech
//! recogniser and go to the webview as `monocode:dictation` events. The
//! webview writes them into the draft and never sends it. Audio never
//! leaves this Mac: a recogniser that cannot run on the device refuses the
//! start, so no audio is ever handed to a server.
//!
//! Only macOS has a recogniser. Windows and Linux return "not here", so the
//! composer hides the control there.

use serde::Serialize;
use tauri::AppHandle;

/// Event carrying [`Chunk`] payloads to every window. The webview filters by session.
#[cfg(target_os = "macos")]
pub const EVENT: &str = "monocode:dictation";

// The texts below are the exact notes the webview shows (src/features/sessions/model/dictation.ts).
// The webview matches them by ending, so these must not be reworded on one side only.
const NOT_HERE: &str = "Dictation in this version only runs on a Mac, and only on the device.";
#[cfg(any(target_os = "macos", test))]
const NOT_ON_DEVICE: &str =
    "This Mac would have to send audio away to transcribe, so dictation stays off.";
#[cfg(any(target_os = "macos", test))]
const NO_MICROPHONE: &str = "No microphone is available, so dictation did not start.";
#[cfg(any(target_os = "macos", test))]
const DENIED: &str =
    "Dictation needs the microphone and speech recognition. Turn them on in System Settings, then try again.";
#[cfg(any(target_os = "macos", test))]
const BUSY: &str = "Dictation is already on.";
#[cfg(any(target_os = "macos", test))]
const STOPPED: &str = "Dictation stopped. What was heard so far stays in the draft.";

/// How long a stop waits for the recogniser's last result before the words heard so far are released.
#[cfg(target_os = "macos")]
const FINISH_GRACE: std::time::Duration = std::time::Duration::from_secs(4);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Support {
    pub available: bool,
    pub reason: String,
}

#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Chunk {
    pub session: u64,
    pub text: String,
    pub finished: bool,
    pub error: bool,
}

/// Refuses a start unless the recogniser works on this device without a server.
#[cfg(any(target_os = "macos", test))]
fn require_on_device(supports_on_device: bool) -> Result<(), &'static str> {
    if supports_on_device {
        Ok(())
    } else {
        Err(NOT_ON_DEVICE)
    }
}

/// The text the person sees for a chunk: trimmed, and empty stays empty.
#[cfg(any(target_os = "macos", test))]
fn clean(text: &str) -> String {
    text.trim().to_string()
}

/// Session bookkeeping, kept free of Objective-C so it can be tested.
/// One dictation at a time. A slot is reserved before the permission prompt,
/// so a second press while the prompt is up is refused, not queued.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug)]
struct Slot<L> {
    id: u64,
    last_text: String,
    /// None while the permission prompt is up or the recogniser is still being built.
    live: Option<L>,
    /// A stop has been asked for. The engine is halted and the last result is awaited.
    ending: bool,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug)]
struct Sessions<L> {
    next: u64,
    current: Option<Slot<L>>,
}

/// What the caller must send to the webview, and what it must tear down.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug)]
struct Heard<L> {
    chunk: Chunk,
    release: Option<L>,
}

#[cfg(any(target_os = "macos", test))]
impl<L: Clone> Sessions<L> {
    const fn new() -> Self {
        Self {
            next: 1,
            current: None,
        }
    }

    fn begin(&mut self) -> Result<u64, &'static str> {
        if self.current.is_some() {
            return Err(BUSY);
        }
        let id = self.next;
        self.next += 1;
        self.current = Some(Slot {
            id,
            last_text: String::new(),
            live: None,
            ending: false,
        });
        Ok(id)
    }

    /// A start that failed before it went live frees the slot.
    fn abort(&mut self, id: u64) {
        if self.current.as_ref().is_some_and(|slot| slot.id == id) {
            self.current = None;
        }
    }

    /// Hands back the live recogniser when the session was stopped during the prompt, so the caller tears it down.
    fn install(&mut self, id: u64, live: L) -> Result<(), L> {
        match self.current.as_mut() {
            Some(slot) if slot.id == id && !slot.ending => {
                slot.live = Some(live);
                Ok(())
            }
            _ => Err(live),
        }
    }

    #[cfg(target_os = "macos")]
    fn live(&self, id: u64) -> Option<L> {
        self.current
            .as_ref()
            .filter(|slot| slot.id == id)
            .and_then(|slot| slot.live.clone())
    }

    /// True when this call started the stop. A stop for an old or unknown session does nothing.
    fn begin_stop(&mut self, id: u64) -> bool {
        match self.current.as_mut() {
            Some(slot) if slot.id == id && !slot.ending => {
                slot.ending = true;
                true
            }
            _ => false,
        }
    }

    /// A recogniser result for `id`. Results for any other session are dropped.
    fn heard(&mut self, id: u64, text: &str, finished: bool, error: bool) -> Option<Heard<L>> {
        let slot = self.current.as_mut().filter(|slot| slot.id == id)?;
        let text = clean(text);
        if !text.is_empty() {
            slot.last_text = text.clone();
        }
        if !finished && !error {
            if text.is_empty() {
                return None;
            }
            return Some(Heard {
                chunk: Chunk {
                    session: id,
                    text,
                    finished: false,
                    error: false,
                },
                release: None,
            });
        }
        let kept = slot.last_text.clone();
        let release = slot.live.clone();
        self.current = None;
        // An error keeps what was heard. The webview shows the stopped note and the words stay.
        let text = if error && text.is_empty() { kept } else { text };
        Some(Heard {
            chunk: Chunk {
                session: id,
                text,
                finished: true,
                error,
            },
            release,
        })
    }

    /// The grace period after a stop ran out: release what was heard so far.
    fn expire(&mut self, id: u64) -> Option<Heard<L>> {
        let slot = self
            .current
            .as_ref()
            .filter(|slot| slot.id == id && slot.ending)?;
        let text = slot.last_text.clone();
        let release = slot.live.clone();
        self.current = None;
        Some(Heard {
            chunk: Chunk {
                session: id,
                text,
                finished: true,
                error: false,
            },
            release,
        })
    }
}

#[cfg(target_os = "macos")]
static SESSIONS: std::sync::Mutex<Sessions<platform::Live>> =
    std::sync::Mutex::new(Sessions::new());

#[cfg(target_os = "macos")]
fn sessions() -> std::sync::MutexGuard<'static, Sessions<platform::Live>> {
    SESSIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
pub fn dictation_support() -> Support {
    platform::support()
}

/// Opens the microphone. Called only after the person has pressed Dictate and then Continue.
#[tauri::command]
pub async fn dictation_start(app: AppHandle) -> Result<u64, String> {
    #[cfg(target_os = "macos")]
    {
        let id = sessions().begin().map_err(str::to_string)?;
        if let Err(message) = platform::authorize().await {
            sessions().abort(id);
            return Err(message.to_string());
        }
        match platform::build(&app, id) {
            Ok(()) => Ok(id),
            Err(message) => {
                sessions().abort(id);
                Err(message.to_string())
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(NOT_HERE.to_string())
    }
}

/// Stops listening for `session`. The last words are still delivered as a finished chunk.
#[tauri::command]
pub fn dictation_stop(app: AppHandle, session: u64) {
    #[cfg(target_os = "macos")]
    platform::stop(&app, session);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, session);
    }
}

#[cfg(target_os = "macos")]
fn emit(app: &AppHandle, chunk: Chunk) {
    use tauri::Emitter;
    let _ = app.emit(EVENT, chunk);
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{Support, NOT_HERE};

    pub fn support() -> Support {
        Support {
            available: false,
            reason: NOT_HERE.to_string(),
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ptr;
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSString;
    use tauri::AppHandle;

    use super::{
        emit, require_on_device, sessions, Heard, Support, DENIED, FINISH_GRACE, NOT_HERE,
        NO_MICROPHONE, STOPPED,
    };

    // The Speech and AVFoundation frameworks provide the recogniser, the audio engine and the microphone prompt.
    #[link(name = "Speech", kind = "framework")]
    extern "C" {}
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    /// AVMediaTypeAudio. Its value is the four-character code "soun".
    const MEDIA_TYPE_AUDIO: &str = "soun";
    /// AVAuthorizationStatusNotDetermined and AVAuthorizationStatusAuthorized.
    const AV_NOT_DETERMINED: isize = 0;
    const AV_AUTHORIZED: isize = 3;
    /// SFSpeechRecognizerAuthorizationStatusNotDetermined and ...Authorized.
    const SPEECH_NOT_DETERMINED: isize = 0;
    const SPEECH_AUTHORIZED: isize = 3;
    /// A permission prompt left unanswered this long counts as a no, so the slot is freed.
    const PROMPT_WAIT: Duration = Duration::from_secs(600);

    /// Objects the recogniser keeps. They are only messaged from the functions in this module and from
    /// the audio and result callbacks, and they are reached through the session lock.
    #[derive(Clone)]
    pub struct Live {
        engine: SendObject,
        input: SendObject,
        request: SendObject,
        task: Option<SendObject>,
        /// Set once the audio is halted, so the halt runs once even when a stop and a final result both reach it.
        halted: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    #[derive(Clone)]
    struct SendObject(std::sync::Arc<SendCell>);

    struct SendCell(Retained<AnyObject>);

    // SAFETY: the retained objects are only sent messages through the paths described on `Live`.
    unsafe impl Send for SendCell {}
    unsafe impl Sync for SendCell {}

    impl SendObject {
        fn new(object: Retained<AnyObject>) -> Self {
            Self(std::sync::Arc::new(SendCell(object)))
        }

        fn get(&self) -> &AnyObject {
            &self.0 .0
        }
    }

    pub fn support() -> Support {
        let available = AnyClass::get(c"SFSpeechRecognizer").is_some()
            && AnyClass::get(c"AVAudioEngine").is_some();
        if available {
            Support {
                available: true,
                reason: String::new(),
            }
        } else {
            Support {
                available: false,
                reason: NOT_HERE.to_string(),
            }
        }
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

    /// Asks the system for microphone access. The prompt's answer arrives on the returned channel.
    /// The Objective-C objects are released here, before any await, so the command future stays `Send`.
    fn request_microphone() -> Option<mpsc::Receiver<bool>> {
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

    fn request_speech() -> Option<mpsc::Receiver<isize>> {
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

    /// Asks for the microphone and speech permissions. Each prompt waits for the person's answer.
    pub async fn authorize() -> Result<(), &'static str> {
        if AnyClass::get(c"SFSpeechRecognizer").is_none()
            || AnyClass::get(c"AVAudioEngine").is_none()
        {
            return Err(NOT_HERE);
        }
        if microphone_status() == AV_NOT_DETERMINED {
            let answer = match request_microphone() {
                Some(rx) => wait(rx).await,
                None => None,
            };
            if answer != Some(true) {
                return Err(DENIED);
            }
        } else if microphone_status() != AV_AUTHORIZED {
            return Err(DENIED);
        }

        if speech_status() == SPEECH_NOT_DETERMINED {
            let answer = match request_speech() {
                Some(rx) => wait(rx).await,
                None => None,
            };
            if answer != Some(SPEECH_AUTHORIZED) {
                return Err(DENIED);
            }
        } else if speech_status() != SPEECH_AUTHORIZED {
            return Err(DENIED);
        }
        Ok(())
    }

    /// Completion handlers run on system queues. Only the channel crosses into the async runtime.
    async fn wait<T: Send + 'static>(rx: mpsc::Receiver<T>) -> Option<T> {
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(PROMPT_WAIT).ok())
            .await
            .ok()
            .flatten()
    }

    /// Builds the recogniser, the request and the audio tap, then starts them. Runs after `authorize`.
    pub fn build(app: &AppHandle, id: u64) -> Result<(), &'static str> {
        let recognizer_class = AnyClass::get(c"SFSpeechRecognizer").ok_or(NOT_HERE)?;
        let engine_class = AnyClass::get(c"AVAudioEngine").ok_or(NOT_HERE)?;
        let request_class =
            AnyClass::get(c"SFSpeechAudioBufferRecognitionRequest").ok_or(NOT_HERE)?;

        let recognizer: Option<Retained<AnyObject>> = unsafe {
            let allocated: Allocated<AnyObject> = msg_send![recognizer_class, alloc];
            msg_send![allocated, init]
        };
        let recognizer = recognizer.ok_or(NOT_HERE)?;
        let available: Bool = unsafe { msg_send![&*recognizer, isAvailable] };
        if !available.as_bool() {
            return Err(NOT_HERE);
        }
        let on_device: Bool = unsafe { msg_send![&*recognizer, supportsOnDeviceRecognition] };
        require_on_device(on_device.as_bool())?;

        let request: Retained<AnyObject> = unsafe { msg_send![request_class, new] };
        unsafe {
            let _: () = msg_send![&*request, setShouldReportPartialResults: Bool::YES];
            let _: () = msg_send![&*request, setRequiresOnDeviceRecognition: Bool::YES];
        }

        let engine: Retained<AnyObject> = unsafe { msg_send![engine_class, new] };
        let input: Retained<AnyObject> = unsafe { msg_send![&*engine, inputNode] };
        let format: Retained<AnyObject> = unsafe { msg_send![&*input, outputFormatForBus: 0usize] };
        let rate: f64 = unsafe { msg_send![&*format, sampleRate] };
        if rate.is_nan() || rate <= 0.0 {
            return Err(NO_MICROPHONE);
        }

        // The audio thread appends each buffer to the request. Appending is thread-safe by Apple's contract.
        let tap_request = SendObject::new(request.clone());
        let tap = RcBlock::new(move |buffer: *mut AnyObject, _when: *mut AnyObject| {
            if let Some(buffer) = unsafe { buffer.as_ref() } {
                unsafe {
                    let _: () = msg_send![tap_request.get(), appendAudioPCMBuffer: buffer];
                }
            }
        });
        unsafe {
            let _: () = msg_send![&*input, installTapOnBus: 0usize, bufferSize: 1024u32, format: &*format, block: &*tap];
            let _: () = msg_send![&*engine, prepare];
        }
        let mut error: *mut AnyObject = ptr::null_mut();
        let started: Bool = unsafe { msg_send![&*engine, startAndReturnError: &mut error] };
        if !started.as_bool() {
            unsafe {
                let _: () = msg_send![&*input, removeTapOnBus: 0usize];
            }
            return Err(NO_MICROPHONE);
        }

        // Results arrive on a Speech queue. Each one goes through the session lock, so a late result for an old
        // session is dropped there, not here.
        let app = app.clone();
        let result_handler = RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
            let (text, is_final) = match unsafe { result.as_ref() } {
                Some(result) => result_text(result),
                None => (String::new(), false),
            };
            let failed = !error.is_null();
            let heard = sessions().heard(id, &text, is_final || failed, failed);
            if let Some(Heard { chunk, release }) = heard {
                if let Some(live) = release {
                    teardown(&live, false);
                }
                emit(&app, chunk);
            }
        });
        let task: Option<Retained<AnyObject>> = unsafe {
            msg_send![&*recognizer, recognitionTaskWithRequest: &*request, resultHandler: &*result_handler]
        };

        let live = Live {
            engine: SendObject::new(engine),
            input: SendObject::new(input),
            request: SendObject::new(request),
            task: task.map(SendObject::new),
            halted: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        let outcome = sessions().install(id, live.clone());
        match outcome {
            Ok(()) => Ok(()),
            Err(late) => {
                // The person stopped while the prompt was up. Tear the new recogniser down at once.
                teardown(&late, true);
                Err(STOPPED)
            }
        }
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

    /// Halts the audio and asks the recogniser for its final result. The result comes back as a finished chunk.
    pub fn stop(app: &AppHandle, session: u64) {
        let (live, started) = {
            let mut guard = sessions();
            let started = guard.begin_stop(session);
            (guard.live(session), started)
        };
        if !started {
            return;
        }
        if let Some(live) = live {
            halt_audio(&live);
        }
        let app = app.clone();
        // If the final result never comes, release what was heard so far. A timeout is not a failure.
        std::thread::spawn(move || {
            std::thread::sleep(FINISH_GRACE);
            let released = sessions().expire(session);
            if let Some(Heard { chunk, release }) = released {
                if let Some(live) = release {
                    teardown(&live, true);
                }
                emit(&app, chunk);
            }
        });
    }

    fn halt_audio(live: &Live) {
        if live.halted.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        unsafe {
            let _: () = msg_send![live.engine.get(), stop];
            let _: () = msg_send![live.input.get(), removeTapOnBus: 0usize];
            let _: () = msg_send![live.request.get(), endAudio];
        }
    }

    /// Stops everything the session holds. Safe to call more than once.
    fn teardown(live: &Live, cancel_task: bool) {
        halt_audio(live);
        if cancel_task {
            if let Some(task) = &live.task {
                unsafe {
                    let _: () = msg_send![task.get(), cancel];
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_start_while_one_is_running_is_refused_not_queued() {
        let mut s: Sessions<()> = Sessions::new();
        let first = s.begin().expect("first start");
        assert_eq!(s.begin(), Err(BUSY));
        s.abort(first);
        assert!(s.begin().is_ok(), "an aborted start frees the slot");
    }

    #[test]
    fn a_start_that_fails_before_it_goes_live_frees_the_slot_and_ids_do_not_repeat() {
        let mut s: Sessions<()> = Sessions::new();
        let first = s.begin().unwrap();
        s.abort(first);
        let second = s.begin().unwrap();
        assert_ne!(first, second);
        s.abort(first);
        assert_eq!(
            s.begin(),
            Err(BUSY),
            "aborting an old id must not free the new slot"
        );
    }

    #[test]
    fn on_device_is_required_and_a_server_recogniser_is_refused() {
        assert_eq!(require_on_device(true), Ok(()));
        assert_eq!(require_on_device(false), Err(NOT_ON_DEVICE));
    }

    #[test]
    fn stale_results_and_stops_are_ignored() {
        let mut s: Sessions<()> = Sessions::new();
        let id = s.begin().unwrap();
        s.install(id, ()).unwrap();
        assert!(
            s.heard(id + 7, "other", false, false).is_none(),
            "a result for another session is dropped"
        );
        assert!(
            !s.begin_stop(id + 7),
            "a stop for another session does nothing"
        );
        assert!(s.begin_stop(id));
        assert!(
            !s.begin_stop(id),
            "a second stop does not start a second grace period"
        );
    }

    #[test]
    fn partials_are_sent_and_empty_partials_are_not() {
        let mut s: Sessions<()> = Sessions::new();
        let id = s.begin().unwrap();
        s.install(id, ()).unwrap();
        assert!(s.heard(id, "   ", false, false).is_none());
        let heard = s.heard(id, "  buy milk  ", false, false).unwrap();
        assert_eq!(
            heard.chunk,
            Chunk {
                session: id,
                text: "buy milk".into(),
                finished: false,
                error: false
            }
        );
        assert!(heard.release.is_none());
    }

    #[test]
    fn a_final_result_releases_the_session_and_a_late_one_is_dropped() {
        let mut s: Sessions<()> = Sessions::new();
        let id = s.begin().unwrap();
        s.install(id, ()).unwrap();
        let done = s.heard(id, "Buy milk.", true, false).unwrap();
        assert_eq!(
            done.chunk,
            Chunk {
                session: id,
                text: "Buy milk.".into(),
                finished: true,
                error: false
            }
        );
        assert!(done.release.is_some());
        assert!(s.heard(id, "late", true, false).is_none());
        assert!(s.begin().is_ok(), "the slot is free after the final result");
    }

    #[test]
    fn an_error_keeps_the_words_already_heard() {
        let mut s: Sessions<()> = Sessions::new();
        let id = s.begin().unwrap();
        s.install(id, ()).unwrap();
        s.heard(id, "half a sentence", false, false);
        let failed = s.heard(id, "", true, true).unwrap();
        assert_eq!(failed.chunk.text, "half a sentence");
        assert!(failed.chunk.error && failed.chunk.finished);
    }

    #[test]
    fn a_stop_during_the_permission_prompt_tears_down_the_late_recogniser() {
        let mut s: Sessions<u8> = Sessions::new();
        let id = s.begin().unwrap();
        assert!(s.begin_stop(id), "a stop during the prompt is accepted");
        assert_eq!(
            s.install(id, 9),
            Err(9),
            "the recogniser that arrives late is handed back"
        );
    }

    #[test]
    fn the_grace_period_releases_what_was_heard() {
        let mut s: Sessions<()> = Sessions::new();
        let id = s.begin().unwrap();
        s.install(id, ()).unwrap();
        s.heard(id, "kept", false, false);
        assert!(
            s.expire(id).is_none(),
            "no release until a stop was asked for"
        );
        s.begin_stop(id);
        let released = s.expire(id).unwrap();
        assert_eq!(released.chunk.text, "kept");
        assert!(released.chunk.finished);
        assert!(s.expire(id).is_none());
    }

    #[test]
    fn the_chunk_payload_has_exactly_the_keys_the_webview_reads() {
        let value = serde_json::to_value(Chunk {
            session: 3,
            text: "a".into(),
            finished: false,
            error: false,
        })
        .unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["error", "finished", "session", "text"]);
    }

    #[test]
    fn the_support_payload_is_camel_case_and_the_notes_carry_no_paths() {
        let value = serde_json::to_value(Support {
            available: false,
            reason: NOT_HERE.into(),
        })
        .unwrap();
        assert!(value.get("available").is_some() && value.get("reason").is_some());
        for note in [
            NOT_HERE,
            NOT_ON_DEVICE,
            NO_MICROPHONE,
            DENIED,
            BUSY,
            STOPPED,
        ] {
            assert!(!note.contains('/'), "no path in a note: {note}");
            assert!(
                !note.contains('\u{2013}') && !note.contains('\u{2014}'),
                "no dash in a note: {note}"
            );
        }
    }
}
