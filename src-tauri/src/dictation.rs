//! WP-131b: desktop dictation for the composer draft.
//!
//! The person asks, the app explains, the person continues, and only then does the helper open the microphone.
//! The helper is `Contents/Helpers/MonoCode Dictation.app` (crates/dictation-helper). It holds the microphone and the
//! speech permissions, so the Hub never does, and nothing the Hub starts inherits them. The Hub starts the helper with
//! responsibility disclaimed (disclaim.rs), so macOS charges the request to the helper, and talks to it over stdin and
//! stdout. The words come back as `monocode:dictation` events. The webview writes them into the draft and never sends
//! it. Audio never leaves this Mac: the helper recognises on the device only.
//!
//! The Hub keeps the guards, so a helper that misbehaves cannot keep the microphone. A session stops when the window
//! that owns it is destroyed, hidden or starts loading a page, after `MAX_SESSION`, and after `SILENCE_LIMIT` with no
//! recognised words. A stop waits briefly for the helper's last result, then the helper is killed.
//!
//! Only a shipped build has the helper. A dev copy, a bundle without it, or a copy with disclaim switched off answers
//! "not available", so the composer hides the control.

// Off macOS the platform part is compiled out, so the shared bookkeeping below has no caller there.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Event carrying [`Chunk`] payloads to every window. The webview filters by session.
pub const EVENT: &str = "monocode:dictation";

// The texts below are the notes the webview shows (src/features/sessions/model/dictation.ts). The webview matches
// them by ending, so these must not be reworded on one side only.
const NOT_HERE: &str = "Dictation is off in this version of the app.";
const NOT_ON_DEVICE: &str =
    "This Mac would have to send audio away to transcribe, so dictation stays off.";
const NO_MICROPHONE: &str = "No microphone is available, so dictation did not start.";
const DENIED: &str =
    "Dictation needs the microphone and speech recognition. Turn them on in System Settings, then try again.";
const BUSY: &str = "Dictation is already on.";
const STOPPED: &str = "Dictation stopped. What was heard so far stays in the draft.";

/// The longest one session may run. Speech at a normal pace fills it in a few minutes.
pub const MAX_SESSION: Duration = Duration::from_secs(300);
/// No recognised words for this long ends the session.
pub const SILENCE_LIMIT: Duration = Duration::from_secs(30);
/// The most text one utterance may add (the webview caps it at the same length).
pub const MAX_UTTERANCE_CHARS: usize = 4000;
/// After a stop, how long the helper gets to deliver its last result before it is killed. The helper waits 5 s itself.
#[cfg(target_os = "macos")]
const FINISH_GRACE: Duration = Duration::from_secs(7);
/// How long a start waits for the helper's answer. A permission prompt can sit this long.
#[cfg(target_os = "macos")]
const READY_WAIT: Duration = Duration::from_secs(600);
/// How often the guard checks the owning window and the clock.
#[cfg(target_os = "macos")]
const WATCH_EVERY: Duration = Duration::from_millis(250);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Support {
    pub available: bool,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Chunk {
    pub session: u64,
    pub text: String,
    pub finished: bool,
    pub error: bool,
}

/// What the helper says, one JSON object per line (crates/dictation-helper/src/protocol.rs).
#[derive(Deserialize)]
#[serde(tag = "ev", rename_all = "lowercase")]
enum HelperEvent {
    Ready,
    Refused {
        reason: String,
    },
    Heard {
        text: String,
    },
    Final {
        #[serde(default)]
        text: String,
        #[serde(default)]
        error: bool,
    },
}

/// The note for a reason code from the helper. An unknown code is "not here", the safe answer.
fn note_for_reason(reason: &str) -> &'static str {
    match reason {
        "denied" => DENIED,
        "not_on_device" => NOT_ON_DEVICE,
        "no_microphone" => NO_MICROPHONE,
        _ => NOT_HERE,
    }
}

/// The text the person sees for a result: trimmed, and cut to MAX_UTTERANCE_CHARS characters.
fn clean(text: &str) -> String {
    text.trim().chars().take(MAX_UTTERANCE_CHARS).collect()
}

/// Session bookkeeping, kept free of processes and windows so the guards can be tested. One dictation at a time.
/// A slot is reserved before the helper starts, so a second press while the prompt is up is refused, not queued.
#[derive(Debug)]
struct Slot<L> {
    id: u64,
    /// The label of the window that asked. Its page going away ends the session.
    owner: String,
    started: Instant,
    /// When the last recognised words arrived (or the start, before any).
    last_words: Instant,
    last_text: String,
    /// None until the helper answers ready.
    live: Option<L>,
    /// A stop has been asked for. The helper is told, and its last result is awaited.
    ending: bool,
}

#[derive(Debug)]
struct Sessions<L> {
    next: u64,
    current: Option<Slot<L>>,
}

/// What the caller must send to the webview, and what it must tear down.
#[derive(Debug)]
struct Heard<L> {
    chunk: Chunk,
    release: Option<L>,
}

impl<L: Clone> Sessions<L> {
    const fn new() -> Self {
        Self {
            next: 1,
            current: None,
        }
    }

    fn begin(&mut self, owner: &str, now: Instant) -> Result<u64, &'static str> {
        if self.current.is_some() {
            return Err(BUSY);
        }
        let id = self.next;
        self.next += 1;
        self.current = Some(Slot {
            id,
            owner: owner.to_string(),
            started: now,
            last_words: now,
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

    /// Hands back the helper when the session was stopped during the prompt, so the caller tears it down.
    fn install(&mut self, id: u64, live: L) -> Result<(), L> {
        match self.current.as_mut() {
            Some(slot) if slot.id == id && !slot.ending => {
                slot.live = Some(live);
                Ok(())
            }
            _ => Err(live),
        }
    }

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

    /// The id of the running session the window `owner` holds, if any.
    fn owned_by(&self, owner: &str) -> Option<u64> {
        self.current
            .as_ref()
            .filter(|slot| slot.owner == owner && !slot.ending)
            .map(|slot| slot.id)
    }

    fn is_current(&self, id: u64) -> bool {
        self.current.as_ref().is_some_and(|slot| slot.id == id)
    }

    fn is_ending(&self, id: u64) -> bool {
        self.current
            .as_ref()
            .is_some_and(|slot| slot.id == id && slot.ending)
    }

    /// True when the running session has gone on too long, or has had no words for too long, and is not already
    /// stopping.
    fn due(&self, now: Instant) -> bool {
        self.current.as_ref().is_some_and(|slot| {
            !slot.ending
                && (now.saturating_duration_since(slot.started) >= MAX_SESSION
                    || now.saturating_duration_since(slot.last_words) >= SILENCE_LIMIT)
        })
    }

    /// A partial result for `id`. Results for any other session are dropped, and an empty one is not sent.
    fn heard(&mut self, id: u64, text: &str, now: Instant) -> Option<Chunk> {
        let slot = self.current.as_mut().filter(|slot| slot.id == id)?;
        let text = clean(text);
        if text.is_empty() {
            return None;
        }
        slot.last_text = text.clone();
        slot.last_words = now;
        Some(Chunk {
            session: id,
            text,
            finished: false,
            error: false,
        })
    }

    /// The helper's final result (or its error) for `id`. The slot is freed. A late one is dropped.
    fn finish(&mut self, id: u64, text: &str, error: bool) -> Option<Heard<L>> {
        let slot = self.current.as_ref().filter(|slot| slot.id == id)?;
        let text = clean(text);
        let kept = if text.is_empty() {
            slot.last_text.clone()
        } else {
            text
        };
        let release = slot.live.clone();
        self.current = None;
        Some(Heard {
            chunk: Chunk {
                session: id,
                text: kept,
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

fn emit(app: &AppHandle, chunk: Chunk) {
    use tauri::Emitter;
    let _ = app.emit(EVENT, chunk);
}

#[tauri::command]
pub fn dictation_support(app: AppHandle) -> Support {
    #[cfg(target_os = "macos")]
    {
        platform::support(&app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Support {
            available: false,
            reason: NOT_HERE.to_string(),
        }
    }
}

/// Opens the microphone through the helper. Called only after the person has pressed Dictate and then Continue.
#[tauri::command]
pub async fn dictation_start(app: AppHandle, webview: tauri::Webview) -> Result<u64, String> {
    #[cfg(target_os = "macos")]
    {
        platform::start(app, webview.label().to_string())
            .await
            .map_err(str::to_string)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, webview);
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

/// The window `label` is gone (destroyed) or is loading a page: a dictation it owns cannot go on.
pub fn window_lost(app: &AppHandle, label: &str) {
    #[cfg(target_os = "macos")]
    platform::stop_owned_by(app, label);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label);
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::io::{BufRead, BufReader, Write};
    use std::path::PathBuf;
    use std::process::{Child, ChildStdin, ChildStdout, Stdio};
    use std::sync::mpsc::{self, Sender};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use tauri::{AppHandle, Manager};

    use super::{
        emit, note_for_reason, sessions, Heard, HelperEvent, Support, DENIED, FINISH_GRACE, NOT_HERE,
        READY_WAIT, STOPPED, WATCH_EVERY,
    };
    use crate::disclaim;

    /// The helper inside the bundle this Hub runs from, or None when this copy has none (a dev copy, or a bundle
    /// built without it).
    pub fn helper_path() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let macos = exe.parent()?;
        if macos.file_name()? != "MacOS" {
            return None;
        }
        let path = macos
            .parent()?
            .join("Helpers/MonoCode Dictation.app/Contents/MacOS/monocode-dictation");
        path.is_file().then_some(path)
    }

    /// The helper to run and the launcher that starts it disclaimed. Without both, dictation is off: a helper the Hub
    /// started itself would be charged to the Hub.
    fn launch_plan(app: &AppHandle) -> Result<(PathBuf, PathBuf), &'static str> {
        let helper = helper_path().ok_or(NOT_HERE)?;
        let data_dir = app.path().app_data_dir().ok();
        let launcher =
            disclaim::launcher_for(helper.as_os_str(), data_dir.as_deref()).ok_or(NOT_HERE)?;
        Ok((helper, launcher))
    }

    pub fn support(app: &AppHandle) -> Support {
        match launch_plan(app) {
            Ok(_) => Support {
                available: true,
                reason: String::new(),
            },
            Err(reason) => Support {
                available: false,
                reason: reason.to_string(),
            },
        }
    }

    /// The helper process of one session. Killing it, or closing its stdin, is how it stops.
    pub struct Helper {
        child: Mutex<Child>,
        stdin: Mutex<Option<ChildStdin>>,
    }

    #[derive(Clone)]
    pub struct Live(Arc<Helper>);

    impl Live {
        fn send_line(&self, line: &str) {
            if let Ok(mut stdin) = self.0.stdin.lock() {
                if let Some(stdin) = stdin.as_mut() {
                    let _ = writeln!(stdin, "{line}").and_then(|()| stdin.flush());
                }
            }
        }

        /// Kills the helper and reaps it. Safe to call more than once.
        fn stop_child(&self) {
            if let Ok(mut stdin) = self.0.stdin.lock() {
                stdin.take();
            }
            if let Ok(mut child) = self.0.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    enum Answer {
        Ready,
        Refused(&'static str),
    }

    pub async fn start(app: AppHandle, owner: String) -> Result<u64, &'static str> {
        let (helper, launcher) = launch_plan(&app)?;
        let id = sessions().begin(&owner, Instant::now())?;
        let mut cmd = disclaim::command(helper.as_os_str(), Some(&launcher));
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(_) => {
                sessions().abort(id);
                return Err(NOT_HERE);
            }
        };
        let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            sessions().abort(id);
            return Err(NOT_HERE);
        };
        if writeln!(stdin, "{{\"op\":\"start\"}}")
            .and_then(|()| stdin.flush())
            .is_err()
        {
            let _ = child.kill();
            let _ = child.wait();
            sessions().abort(id);
            return Err(NOT_HERE);
        }
        let live = Live(Arc::new(Helper {
            child: Mutex::new(child),
            stdin: Mutex::new(Some(stdin)),
        }));
        let (answer_tx, answer_rx) = mpsc::channel::<Answer>();
        spawn_reader(app.clone(), id, stdout, answer_tx, live.clone());
        let answer =
            tauri::async_runtime::spawn_blocking(move || answer_rx.recv_timeout(READY_WAIT).ok())
                .await
                .ok()
                .flatten();
        match answer {
            Some(Answer::Ready) => match sessions().install(id, live.clone()) {
                Ok(()) => {
                    spawn_watch(app, id, owner);
                    Ok(id)
                }
                Err(late) => {
                    // The person stopped while the prompt was up. The helper that came late is stopped at once.
                    late.stop_child();
                    Err(STOPPED)
                }
            },
            Some(Answer::Refused(note)) => {
                sessions().abort(id);
                live.stop_child();
                Err(note)
            }
            None => {
                sessions().abort(id);
                live.stop_child();
                Err(DENIED)
            }
        }
    }

    /// Reads the helper's lines until it finishes. Its words reach the webview as they arrive.
    fn spawn_reader(
        app: AppHandle,
        id: u64,
        stdout: ChildStdout,
        answers: Sender<Answer>,
        live: Live,
    ) {
        std::thread::spawn(move || {
            let mut answers = Some(answers);
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(event) = serde_json::from_str::<HelperEvent>(&line) else {
                    continue;
                };
                match event {
                    HelperEvent::Ready => reply(&mut answers, Answer::Ready),
                    HelperEvent::Refused { reason } => {
                        reply(&mut answers, Answer::Refused(note_for_reason(&reason)));
                    }
                    HelperEvent::Heard { text } => {
                        let chunk = sessions().heard(id, &text, Instant::now());
                        if let Some(chunk) = chunk {
                            emit(&app, chunk);
                        }
                    }
                    HelperEvent::Final { text, error } => {
                        let heard = sessions().finish(id, &text, error);
                        finish_and_emit(&app, heard);
                        break;
                    }
                }
            }
            // The helper went away. Anything still waiting on it gets the not-here note, and the words heard stay.
            reply(&mut answers, Answer::Refused(NOT_HERE));
            let heard = sessions().finish(id, "", true);
            finish_and_emit(&app, heard);
            live.stop_child();
        });
    }

    fn reply(answers: &mut Option<Sender<Answer>>, answer: Answer) {
        if let Some(tx) = answers.take() {
            let _ = tx.send(answer);
        }
    }

    fn finish_and_emit(app: &AppHandle, heard: Option<Heard<Live>>) {
        if let Some(Heard { chunk, release }) = heard {
            if let Some(live) = release {
                live.stop_child();
            }
            emit(app, chunk);
        }
    }

    /// Asks the helper to finish. The words heard so far are released after the grace period, even if the helper
    /// never answers.
    pub fn stop(app: &AppHandle, id: u64) {
        let (live, begun) = {
            let mut guard = sessions();
            let begun = guard.begin_stop(id);
            (guard.live(id), begun)
        };
        if !begun {
            return;
        }
        if let Some(live) = &live {
            live.send_line("{\"op\":\"stop\"}");
        }
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(FINISH_GRACE);
            let released = sessions().expire(id);
            finish_and_emit(&app, released);
        });
    }

    /// Ends the session `label` owns, if it has one.
    pub fn stop_owned_by(app: &AppHandle, label: &str) {
        let id = sessions().owned_by(label);
        if let Some(id) = id {
            stop(app, id);
        }
    }

    /// The guards for one session: the owning window must stay on screen, and the session must not run past its
    /// length or its silence limit. Any of them stops it.
    fn spawn_watch(app: AppHandle, id: u64, owner: String) {
        std::thread::spawn(move || loop {
            std::thread::sleep(WATCH_EVERY);
            let (current, ending, due) = {
                let guard = sessions();
                (
                    guard.is_current(id),
                    guard.is_ending(id),
                    guard.due(Instant::now()),
                )
            };
            if !current || ending {
                return;
            }
            // The window is read without holding the session lock: its calls run on the main thread.
            let visible = app
                .get_webview_window(&owner)
                .map(|window| window.is_visible().unwrap_or(false))
                .unwrap_or(false);
            if due || !visible {
                stop(&app, id);
                return;
            }
        });
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn a_copy_outside_a_bundle_has_no_helper() {
            // The test binary runs from target/..., never from a bundle with a Helpers folder.
            assert!(super::helper_path().is_none());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn a_second_start_while_one_is_running_is_refused_not_queued() {
        let mut s: Sessions<()> = Sessions::new();
        let first = s.begin("main", t0()).expect("first start");
        assert_eq!(s.begin("main", t0()), Err(BUSY));
        s.abort(first);
        assert!(
            s.begin("main", t0()).is_ok(),
            "an aborted start frees the slot"
        );
    }

    #[test]
    fn a_start_that_fails_before_it_goes_live_frees_the_slot_and_ids_do_not_repeat() {
        let mut s: Sessions<()> = Sessions::new();
        let first = s.begin("main", t0()).unwrap();
        s.abort(first);
        let second = s.begin("main", t0()).unwrap();
        assert_ne!(first, second);
        s.abort(first);
        assert_eq!(
            s.begin("main", t0()),
            Err(BUSY),
            "aborting an old id must not free the new slot"
        );
    }

    #[test]
    fn stale_results_and_stops_are_ignored() {
        let mut s: Sessions<()> = Sessions::new();
        let id = s.begin("main", t0()).unwrap();
        s.install(id, ()).unwrap();
        assert!(
            s.heard(id + 7, "other", t0()).is_none(),
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
        let id = s.begin("main", t0()).unwrap();
        s.install(id, ()).unwrap();
        assert!(s.heard(id, "   ", t0()).is_none());
        let chunk = s.heard(id, "  buy milk  ", t0()).unwrap();
        assert_eq!(
            chunk,
            Chunk {
                session: id,
                text: "buy milk".into(),
                finished: false,
                error: false
            }
        );
    }

    #[test]
    fn a_final_result_releases_the_session_and_a_late_one_is_dropped() {
        let mut s: Sessions<()> = Sessions::new();
        let id = s.begin("main", t0()).unwrap();
        s.install(id, ()).unwrap();
        let done = s.finish(id, "Buy milk.", false).unwrap();
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
        assert!(s.finish(id, "late", false).is_none());
        assert!(
            s.begin("main", t0()).is_ok(),
            "the slot is free after the final result"
        );
    }

    #[test]
    fn an_error_keeps_the_words_already_heard() {
        let mut s: Sessions<()> = Sessions::new();
        let id = s.begin("main", t0()).unwrap();
        s.install(id, ()).unwrap();
        s.heard(id, "half a sentence", t0());
        let failed = s.finish(id, "", true).unwrap();
        assert_eq!(failed.chunk.text, "half a sentence");
        assert!(failed.chunk.error && failed.chunk.finished);
    }

    #[test]
    fn a_stop_during_the_permission_prompt_tears_down_the_late_helper() {
        let mut s: Sessions<u8> = Sessions::new();
        let id = s.begin("main", t0()).unwrap();
        assert!(s.begin_stop(id), "a stop during the prompt is accepted");
        assert_eq!(
            s.install(id, 9),
            Err(9),
            "the helper that arrives late is handed back"
        );
    }

    #[test]
    fn the_grace_period_releases_what_was_heard() {
        let mut s: Sessions<()> = Sessions::new();
        let id = s.begin("main", t0()).unwrap();
        s.install(id, ()).unwrap();
        s.heard(id, "kept", t0());
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

    // Guards: the owning window, the maximum length and the silence limit.

    #[test]
    fn a_session_belongs_to_the_window_that_started_it() {
        let mut s: Sessions<()> = Sessions::new();
        let id = s.begin("main", t0()).unwrap();
        assert_eq!(s.owned_by("main"), Some(id));
        assert_eq!(
            s.owned_by("mono-2"),
            None,
            "another window's destruction does not stop it"
        );
        s.begin_stop(id);
        assert_eq!(
            s.owned_by("main"),
            None,
            "a session already stopping is not stopped twice"
        );
    }

    #[test]
    fn a_session_is_due_at_the_maximum_length_and_not_before() {
        let mut s: Sessions<()> = Sessions::new();
        let start = t0();
        let id = s.begin("main", start).unwrap();
        s.install(id, ()).unwrap();
        let mut now = start;
        // Keep the words coming, so only the length can end it.
        for _ in 0..(MAX_SESSION.as_secs() / 10 - 1) {
            now += Duration::from_secs(10);
            s.heard(id, "word", now);
        }
        assert!(!s.due(now), "just under the maximum length");
        assert!(
            s.due(start + MAX_SESSION),
            "at the maximum length the session is due"
        );
    }

    #[test]
    fn a_session_is_due_after_the_silence_limit_with_no_words() {
        let mut s: Sessions<()> = Sessions::new();
        let start = t0();
        let id = s.begin("main", start).unwrap();
        s.install(id, ()).unwrap();
        assert!(!s.due(start + SILENCE_LIMIT - Duration::from_secs(1)));
        assert!(
            s.due(start + SILENCE_LIMIT),
            "no words for the silence limit ends it"
        );
        // A word resets the silence clock.
        let word_at = start + Duration::from_secs(20);
        s.heard(id, "hello", word_at);
        assert!(!s.due(word_at + SILENCE_LIMIT - Duration::from_secs(1)));
        assert!(s.due(word_at + SILENCE_LIMIT));
    }

    #[test]
    fn a_session_that_is_stopping_is_not_due_again() {
        let mut s: Sessions<()> = Sessions::new();
        let start = t0();
        let id = s.begin("main", start).unwrap();
        s.install(id, ()).unwrap();
        assert!(s.due(start + MAX_SESSION));
        s.begin_stop(id);
        assert!(
            !s.due(start + MAX_SESSION),
            "a stop already under way is not repeated"
        );
    }

    #[test]
    fn results_are_trimmed_and_capped_in_characters() {
        assert_eq!(clean("  hello  "), "hello");
        let long: String = "é".repeat(MAX_UTTERANCE_CHARS + 10);
        let capped = clean(&long);
        assert_eq!(capped.chars().count(), MAX_UTTERANCE_CHARS);
        assert!(capped.chars().all(|c| c == 'é'), "no character is split");
    }

    #[test]
    fn every_helper_reason_maps_to_the_note_the_webview_knows() {
        assert_eq!(note_for_reason("denied"), DENIED);
        assert_eq!(note_for_reason("not_on_device"), NOT_ON_DEVICE);
        assert_eq!(note_for_reason("no_microphone"), NO_MICROPHONE);
        assert_eq!(note_for_reason("not_here"), NOT_HERE);
        assert_eq!(
            note_for_reason("something new"),
            NOT_HERE,
            "an unknown reason is not here"
        );
    }

    #[test]
    fn the_helper_lines_parse_into_the_events_the_hub_acts_on() {
        assert!(matches!(
            serde_json::from_str::<HelperEvent>(r#"{"ev":"ready"}"#),
            Ok(HelperEvent::Ready)
        ));
        assert!(matches!(
            serde_json::from_str::<HelperEvent>(r#"{"ev":"refused","reason":"denied"}"#),
            Ok(HelperEvent::Refused { .. })
        ));
        assert!(matches!(
            serde_json::from_str::<HelperEvent>(r#"{"ev":"heard","text":"hi"}"#),
            Ok(HelperEvent::Heard { .. })
        ));
        assert!(matches!(
            serde_json::from_str::<HelperEvent>(r#"{"ev":"final","text":"x","error":true}"#),
            Ok(HelperEvent::Final { error: true, .. })
        ));
        assert!(serde_json::from_str::<HelperEvent>(r#"{"ev":"open-socket"}"#).is_err());
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

    #[test]
    fn the_main_app_asks_for_no_microphone_or_speech_recognition() {
        // The main app must never be able to open the microphone: no usage strings, no audio-input entitlement.
        // The helper carries them (crates/dictation-helper/bundle).
        let info = include_str!("../Info.plist");
        let entitlements = include_str!("../Entitlements.plist");
        assert!(!info.contains("NSMicrophoneUsageDescription"));
        assert!(!info.contains("NSSpeechRecognitionUsageDescription"));
        assert!(!entitlements.contains("com.apple.security.device.audio-input"));
    }

    #[test]
    fn the_helper_is_started_through_the_disclaim_launcher() {
        // A helper the Hub started itself would be charged to the Hub, so the launch goes through the launcher.
        let cmd = crate::disclaim::command(
            std::ffi::OsStr::new("/x/MonoCode Dictation.app/Contents/MacOS/monocode-dictation"),
            Some(std::path::Path::new("/x/monocode")),
        );
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args.first().and_then(|a| a.to_str()), Some("disclaim-exec"));
    }
}
