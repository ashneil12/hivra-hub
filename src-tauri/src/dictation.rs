//! WP-131b: desktop dictation for the composer draft.
//!
//! The person asks, the app explains, the person continues, and only then does the helper open the microphone.
//! The helper is `Contents/Helpers/MonoCode Dictation.app` (crates/dictation-helper). It holds the microphone and the
//! speech permissions, so the Hub never does. launchd runs it as an SMAppService agent. The Hub registers that agent
//! only while dictation is switched on, and it talks to the helper over the agent's XPC Mach service, never by
//! spawning it. The words come back as `monocode:dictation` events. The webview writes them into the draft and never
//! sends it. Audio never leaves this Mac: the helper recognises on the device only.
//!
//! The Hub keeps the guards, so a helper that misbehaves cannot keep the microphone. A session stops when the window
//! that owns it is destroyed, hidden or starts loading a page, after `MAX_SESSION`, and after `SILENCE_LIMIT` with no
//! recognised words. A stop tells the helper to finish, then cancels the connection.
//!
//! Only a shipped build has the helper. A dev copy, or a bundle without it, answers "not available", so the composer
//! hides the control. The setting stays off until its file says on. Turning it on registers the helper; turning it
//! off unregisters it and stops any session. A dev copy saves the setting and does not register.

// Off macOS the platform part is compiled out, so the shared bookkeeping below has no caller there.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::path::{Component, Path};
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
/// Kill switch for this build. True lets the saved setting decide. False keeps dictation off even when the file says
/// on. The file itself is missing until someone turns dictation on, and a missing file is off.
pub const ENABLED: bool = true;
/// The file in the app's data folder. The helper reads the same name from the daily Hub's application-support folder.
pub const SETTING_FILE: &str = "dictation-enabled";

/// True only for the exact word `on`, after trimming. Anything else, including a missing file, is off.
pub fn setting_word_on(text: Option<&str>) -> bool {
    text.is_some_and(|text| text.trim() == "on")
}

/// The kill switch and the setting both have to allow it.
pub fn allows_dictation(kill_switch: bool, text: Option<&str>) -> bool {
    kill_switch && setting_word_on(text)
}

/// What turning the setting does to the helper agent. A copy that is not the daily Hub, or that has no helper, leaves
/// the agent alone. It never registers, and it never unregisters an agent that belongs to the daily app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentChange {
    Register,
    Unregister,
    Leave,
}

pub fn agent_change(kill_switch: bool, setting_on: bool, host: bool) -> AgentChange {
    if !host {
        return AgentChange::Leave;
    }
    if allows_dictation(kill_switch, setting_on.then_some("on")) {
        AgentChange::Register
    } else {
        AgentChange::Unregister
    }
}

/// What applying a save does. `wrote` is whether the file landed. Turning off stops a session even when the write
/// failed. Turning on does not register when the write failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettingPlan {
    pub wrote: bool,
    pub stop: bool,
    pub agent: AgentChange,
}

pub fn plan_setting(kill_switch: bool, requested_on: bool, wrote: bool, host: bool) -> SettingPlan {
    if !requested_on {
        SettingPlan {
            wrote,
            stop: true,
            agent: agent_change(kill_switch, false, host),
        }
    } else if !wrote {
        SettingPlan {
            wrote: false,
            stop: false,
            agent: AgentChange::Leave,
        }
    } else {
        SettingPlan {
            wrote: true,
            stop: false,
            agent: agent_change(kill_switch, true, host),
        }
    }
}

fn setting_dir_ok(data_dir: &Path) -> bool {
    !data_dir.as_os_str().is_empty()
        && data_dir.is_dir()
        && !data_dir
            .components()
            .any(|component| matches!(component, Component::ParentDir))
}

/// The setting file, only when it stays inside `data_dir`.
fn setting_path(data_dir: &Path) -> Option<std::path::PathBuf> {
    if !setting_dir_ok(data_dir) {
        return None;
    }
    let path = data_dir.join(SETTING_FILE);
    (path.parent() == Some(data_dir)
        && path.file_name().and_then(|name| name.to_str()) == Some(SETTING_FILE))
    .then_some(path)
}

/// The file's text, when it can be read. None is off.
pub fn read_setting_text(data_dir: &Path) -> Option<String> {
    let path = setting_path(data_dir)?;
    std::fs::read_to_string(path).ok()
}

pub fn read_setting_on(data_dir: &Path) -> bool {
    setting_word_on(read_setting_text(data_dir).as_deref())
}

/// Writes `on` or `off` by renaming a temp file in the same folder, so a reader never sees a torn word.
pub fn write_setting_file(data_dir: &Path, on: bool) -> bool {
    let Some(path) = setting_path(data_dir) else {
        return false;
    };
    let tmp = data_dir.join(format!(".{SETTING_FILE}.{}.tmp", std::process::id()));
    if tmp.parent() != Some(data_dir) {
        return false;
    }
    let word = if on { "on" } else { "off" };
    if std::fs::write(&tmp, word).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    true
}
/// After a stop, how long the helper gets to deliver its last result before it is killed. The helper waits 5 s itself.
#[cfg(target_os = "macos")]
const FINISH_GRACE: Duration = Duration::from_secs(7);
/// How long a start waits for the helper's answer. A permission prompt can sit this long.
#[cfg(all(target_os = "macos", not(test)))]
const READY_WAIT: Duration = Duration::from_secs(600);
/// How often the guard checks the owning window and the clock.
#[cfg(all(target_os = "macos", not(test)))]
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

/// What the caller must send to the webview, and what it must tear down. The chunk goes to the window that owns the
/// session only (LOW 4): a transcript is never sent to another window.
#[derive(Debug)]
struct Heard<L> {
    owner: String,
    chunk: Chunk,
    release: Option<L>,
}

/// The longest line the Hub reads from the helper (LOW 4): a longer one ends the session.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MAX_LINE_BYTES: usize = 64 * 1024;

/// Reads one line into `buf`. `Ok(false)` at end of input; `Err` when the line passes MAX_LINE_BYTES without a newline.
/// The live path is an XPC message, which is capped with the same constant. This reader stays for the test.
#[cfg(test)]
fn read_capped_line<R: std::io::BufRead>(reader: &mut R, buf: &mut Vec<u8>) -> Result<bool, ()> {
    use std::io::BufRead;
    buf.clear();
    let read = std::io::Read::take(reader.by_ref(), MAX_LINE_BYTES as u64 + 1)
        .read_until(b'\n', buf)
        .unwrap_or(0);
    if read == 0 {
        return Ok(false);
    }
    if buf.len() > MAX_LINE_BYTES {
        return Err(());
    }
    Ok(true)
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

    /// Hands back the helper when the session was stopped during the prompt, so the caller tears it down. The limits
    /// count from `now`, when the helper is ready (LOW 2): a permission prompt is not dictation time.
    fn install(&mut self, id: u64, live: L, now: Instant) -> Result<(), L> {
        match self.current.as_mut() {
            Some(slot) if slot.id == id && !slot.ending => {
                slot.live = Some(live);
                slot.started = now;
                slot.last_words = now;
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

    /// The session that is still listening, if any. One that is already stopping is not stopped again.
    fn running_id(&self) -> Option<u64> {
        self.current
            .as_ref()
            .filter(|slot| !slot.ending)
            .map(|slot| slot.id)
    }

    /// The id of the running session the window `owner` holds, if any.
    fn owned_by(&self, owner: &str) -> Option<u64> {
        self.current
            .as_ref()
            .filter(|slot| slot.owner == owner && !slot.ending)
            .map(|slot| slot.id)
    }

    #[cfg(not(test))]
    fn is_current(&self, id: u64) -> bool {
        self.current.as_ref().is_some_and(|slot| slot.id == id)
    }

    #[cfg(not(test))]
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
        let owner = slot.owner.clone();
        self.current = None;
        Some(Heard {
            owner,
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
        let owner = slot.owner.clone();
        self.current = None;
        Some(Heard {
            owner,
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

/// Sends a chunk to the window that owns the session only (LOW 4), never to every window.
fn emit(app: &AppHandle, owner: &str, chunk: Chunk) {
    use tauri::Emitter;
    let _ = app.emit_to(owner, EVENT, chunk);
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

/// Whether dictation is on. Missing, unreadable and any word other than `on` are off. Off outside macOS.
#[tauri::command]
pub fn dictation_setting(app: AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        platform::setting_on(&app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        false
    }
}

/// Saves the setting. Off stops a running session and, on the daily Hub, unregisters the helper. On registers it
/// only after the file is written, and only on the daily Hub. A dev copy saves and does not register.
#[tauri::command]
pub fn dictation_set_setting(app: AppHandle, on: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        platform::set_setting(&app, on)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, on);
        false
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

/// The daily Hub's identifier. Only this identity launches the helper (LOW 1).
pub const HUB_IDENTIFIER: &str = "com.ash.monocode-hub";

/// The LaunchAgent plist inside the Hub bundle (`Contents/Library/LaunchAgents/<name>`). SMAppService registers
/// that name. The plist names the helper bundle; the Hub does not spawn it.
pub const AGENT_PLIST_NAME: &str = "com.ash.monocode-hub.dictation.plist";
/// `BundleProgram` in that plist, relative to the app bundle. The path the brief requires.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const HELPER_BUNDLE_PROGRAM: &str = "Contents/Helpers/MonoCode Dictation.app";
/// Where the plist lives inside the bundle. The bundle script places the file; the tests pin this string.
#[allow(dead_code)]
pub const LAUNCH_AGENTS_DIR: &str = "Contents/Library/LaunchAgents";
/// The Mach service the launch agent advertises. The Hub connects to this. It does not spawn the helper.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MACH_SERVICE: &str = "com.ash.monocode-hub.dictation";

/// The XPC client and the real registrar. Absent from the test build, so a test cannot open the service or call
/// SMAppService.
#[cfg(all(target_os = "macos", not(test)))]
mod xpc;

/// Registers and unregisters the helper agent. The real one calls SMAppService. Tests pass a fake, so nothing
/// here touches launchd.
pub trait AgentControl {
    fn register_agent(&mut self, plist_name: &str);
    fn unregister_agent(&mut self, plist_name: &str);
}

/// Follows the dictation switch. On registers the agent. Off unregisters it. Nothing else is registered.
pub fn follow_switch(enabled: bool, agent: &mut impl AgentControl) {
    if enabled {
        agent.register_agent(AGENT_PLIST_NAME);
    } else {
        agent.unregister_agent(AGENT_PLIST_NAME);
    }
}

/// The requirement a helper must meet to be launched: its identifier (the Hub's, plus `.dictation`), Apple-anchored,
/// under the Hub's Team ID. None when either input is not a plain identifier or a Team ID.
pub fn helper_requirement(hub_identifier: &str, team: &str) -> Option<String> {
    let plain = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    };
    let team_ok = team.len() == 10
        && team
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    if !plain(hub_identifier) || !team_ok {
        return None;
    }
    Some(format!(
        "identifier \"{hub_identifier}.dictation\" and anchor apple generic and certificate leaf[subject.OU] = \"{team}\""
    ))
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::PathBuf;
    #[cfg(not(test))]
    use std::sync::mpsc::{self, Receiver, Sender};
    #[cfg(not(test))]
    use std::sync::Arc;
    #[cfg(not(test))]
    use std::time::Instant;

    use tauri::AppHandle;
    use tauri::Manager;

    use super::{emit, sessions, Heard, Support, FINISH_GRACE, HUB_IDENTIFIER, NOT_HERE};
    #[cfg(not(test))]
    use super::{note_for_reason, HelperEvent, DENIED, READY_WAIT, STOPPED, WATCH_EVERY};

    /// The helper inside the bundle this Hub runs from, or None when this copy has none (a dev copy, or a bundle
    /// built without it).
    pub fn helper_path() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let macos = exe.parent()?;
        if macos.file_name()? != "MacOS" {
            return None;
        }
        let bundle = macos.parent()?.parent()?;
        let path = bundle
            .join(super::HELPER_BUNDLE_PROGRAM)
            .join("Contents/MacOS/monocode-dictation");
        path.is_file().then_some(path)
    }

    /// Whether this copy may connect to the helper. The Hub does not spawn it: launchd does, once the agent is
    /// registered. A dev copy, a bundle without the helper, or a helper signed for someone else is not available.
    fn launch_plan(app: &AppHandle) -> Result<(), &'static str> {
        // Off until the setting file says on. No helper is found, checked or connected to while it is off.
        if !setting_on(app) {
            return Err(NOT_HERE);
        }
        let helper = helper_path().ok_or(NOT_HERE)?;
        // Only the daily Hub connects, and only to a helper signed for this Hub (its identifier, and this app's
        // Team ID). A helper copied in from elsewhere is not used.
        if app.config().identifier != HUB_IDENTIFIER
            || !helper_is_signed_for_hub(&helper, HUB_IDENTIFIER)
        {
            return Err(NOT_HERE);
        }
        Ok(())
    }

    /// LOW 1 / MED 1: the helper is signed under this Hub's Team ID with the helper's identifier. The Team ID comes from
    /// this Hub's own code; the helper's bundle is checked against the requirement in process.
    fn helper_is_signed_for_hub(helper: &std::path::Path, hub_identifier: &str) -> bool {
        let Some(helper_bundle) = helper
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        else {
            return false;
        };
        let Some(team) = own_team_id() else {
            return false;
        };
        let Some(requirement) = super::helper_requirement(hub_identifier, &team) else {
            return false;
        };
        signed_as(helper_bundle, &requirement)
    }

    /// Whether the code at `path` meets `requirement`. Security.framework checks it in process: no tool runs and no
    /// output is read. A missing, unsigned or differently signed path refuses.
    pub fn signed_as(path: &std::path::Path, requirement: &str) -> bool {
        use core_foundation::url::CFURL;
        use security_framework::os::macos::code_signing::{Flags, SecRequirement, SecStaticCode};
        let Ok(requirement) = requirement.parse::<SecRequirement>() else {
            return false;
        };
        let Some(url) = CFURL::from_path(path, path.is_dir()) else {
            return false;
        };
        SecStaticCode::from_path(&url, Flags::NONE)
            .and_then(|code| code.check_validity(Flags::NONE, &requirement))
            .is_ok()
    }

    /// `kSecCSSigningInformation`: the flag that asks for the signing details (the Team ID among them).
    const SEC_CS_SIGNING_INFORMATION: u32 = 1 << 1;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecCodeInfoTeamIdentifier: core_foundation::string::CFStringRef;
        fn SecCodeCopySigningInformation(
            code: *const std::ffi::c_void,
            flags: u32,
            information: *mut *const std::ffi::c_void,
        ) -> i32;
    }
    extern "C" {
        fn CFDictionaryGetValue(
            dict: *const std::ffi::c_void,
            key: *const std::ffi::c_void,
        ) -> *const std::ffi::c_void;
        fn CFRelease(value: *const std::ffi::c_void);
    }

    /// The Team ID the code making this call is signed under, from its own signing information. None when it can't
    /// be read, as for an unsigned or ad-hoc build.
    fn own_team_id() -> Option<String> {
        use core_foundation::base::TCFType;
        use core_foundation::string::{CFString, CFStringRef};
        use security_framework::os::macos::code_signing::{Flags, SecCode};
        use std::ffi::c_void;
        let code = SecCode::for_self(Flags::NONE).ok()?;
        let mut info: *const c_void = std::ptr::null();
        let status = unsafe {
            SecCodeCopySigningInformation(
                code.as_concrete_TypeRef() as *const c_void,
                SEC_CS_SIGNING_INFORMATION,
                &mut info,
            )
        };
        if status != 0 || info.is_null() {
            return None;
        }
        let key = unsafe { kSecCodeInfoTeamIdentifier };
        let value = unsafe { CFDictionaryGetValue(info, key as *const c_void) };
        let team = (!value.is_null())
            .then(|| unsafe { CFString::wrap_under_get_rule(value as CFStringRef) }.to_string());
        unsafe { CFRelease(info) };
        team
    }

    /// The setting, from this copy's own data folder. A missing folder or file is off.
    pub fn setting_on(app: &AppHandle) -> bool {
        app.path()
            .app_data_dir()
            .ok()
            .is_some_and(|dir| super::ENABLED && super::read_setting_on(&dir))
    }

    /// True only for the daily Hub when the helper is in the bundle. A dev copy and a test build are not.
    fn host_may_register(app: &AppHandle) -> bool {
        app.config().identifier == HUB_IDENTIFIER && helper_path().is_some()
    }

    /// Writes the setting, then follows [`super::plan_setting`]. The real registrar is not in the test build.
    pub fn set_setting(app: &AppHandle, on: bool) -> bool {
        let dir = app.path().app_data_dir().ok();
        let wrote = dir
            .as_deref()
            .is_some_and(|dir| super::write_setting_file(dir, on));
        let plan = super::plan_setting(super::ENABLED, on, wrote, host_may_register(app));
        if plan.stop {
            if let Some(id) = sessions().running_id() {
                stop(app, id);
            }
        }
        #[cfg(not(test))]
        match plan.agent {
            super::AgentChange::Register => super::xpc::apply_switch(true),
            super::AgentChange::Unregister => super::xpc::apply_switch(false),
            super::AgentChange::Leave => {}
        }
        dir.as_deref()
            .is_some_and(|dir| super::ENABLED && super::read_setting_on(dir))
    }

    pub fn support(app: &AppHandle) -> Support {
        // The real registrar. A test build does not call it, so a test never registers or unregisters an agent.
        // A dev copy is not the host, so it does not register or unregister either.
        #[cfg(not(test))]
        if host_may_register(app) {
            super::xpc::apply_switch(setting_on(app));
        }
        match launch_plan(app) {
            Ok(()) => Support {
                available: true,
                reason: String::new(),
            },
            Err(reason) => Support {
                available: false,
                reason: reason.to_string(),
            },
        }
    }

    /// The helper connection of one session. Cancelling it is how the session stops.
    #[cfg(not(test))]
    pub struct Helper {
        link: super::xpc::Link,
    }

    #[cfg(not(test))]
    #[derive(Clone)]
    pub struct Live(Arc<Helper>);

    /// A test build has no connection to cancel. Nothing here opens the Mach service.
    #[cfg(test)]
    #[derive(Clone)]
    pub struct Live;

    impl Live {
        #[cfg(not(test))]
        fn send_line(&self, line: &str) {
            let _ = self.0.link.send_line(line);
        }

        #[cfg(test)]
        fn send_line(&self, line: &str) {
            let _ = line;
        }

        /// Cancels the helper connection. Safe to call more than once.
        #[cfg(not(test))]
        fn stop_child(&self) {
            self.0.link.cancel();
        }

        #[cfg(test)]
        fn stop_child(&self) {}
    }

    #[cfg(not(test))]
    enum Answer {
        Ready,
        Refused(&'static str),
    }

    pub async fn start(app: AppHandle, owner: String) -> Result<u64, &'static str> {
        launch_plan(&app)?;
        // A test build never connects. The real connection is compiled out, so this cannot open the Mach service.
        #[cfg(test)]
        {
            let _ = (app, owner);
            Err(NOT_HERE)
        }
        #[cfg(not(test))]
        connect_session(app, owner).await
    }

    /// Connects to the helper and reads until it finishes. Not compiled into a test.
    #[cfg(not(test))]
    async fn connect_session(app: AppHandle, owner: String) -> Result<u64, &'static str> {
        let id = sessions().begin(&owner, Instant::now())?;
        let (link, lines) = match open_link() {
            Ok(open) => open,
            Err(()) => {
                sessions().abort(id);
                return Err(NOT_HERE);
            }
        };
        let live = Live(Arc::new(Helper { link }));
        if !live.0.link.send_line("{\"op\":\"start\"}") {
            live.stop_child();
            sessions().abort(id);
            return Err(NOT_HERE);
        }
        let (answer_tx, answer_rx) = mpsc::channel::<Answer>();
        spawn_reader(
            app.clone(),
            owner.clone(),
            id,
            lines,
            answer_tx,
            live.clone(),
        );
        let answer =
            tauri::async_runtime::spawn_blocking(move || answer_rx.recv_timeout(READY_WAIT).ok())
                .await
                .ok()
                .flatten();
        match answer {
            Some(Answer::Ready) => match sessions().install(id, live.clone(), Instant::now()) {
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

    /// The signed helper's requirement, then the connection. None of this runs in a test.
    #[cfg(not(test))]
    fn open_link() -> Result<(super::xpc::Link, Receiver<super::xpc::Incoming>), ()> {
        let Some(team) = own_team_id() else {
            return Err(());
        };
        let Some(requirement) = super::helper_requirement(HUB_IDENTIFIER, &team) else {
            return Err(());
        };
        super::xpc::connect(&requirement)
    }

    /// Reads the helper's lines until it finishes. Its words reach the webview as they arrive.
    #[cfg(not(test))]
    fn spawn_reader(
        app: AppHandle,
        owner: String,
        id: u64,
        lines: Receiver<super::xpc::Incoming>,
        answers: Sender<Answer>,
        live: Live,
    ) {
        std::thread::spawn(move || {
            let mut answers = Some(answers);
            while let Ok(incoming) = lines.recv() {
                let super::xpc::Incoming::Text(line) = incoming else {
                    break;
                };
                let Ok(event) = serde_json::from_str::<HelperEvent>(line.trim()) else {
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
                            emit(&app, &owner, chunk);
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

    #[cfg(not(test))]
    fn reply(answers: &mut Option<Sender<Answer>>, answer: Answer) {
        if let Some(tx) = answers.take() {
            let _ = tx.send(answer);
        }
    }

    fn finish_and_emit(app: &AppHandle, heard: Option<Heard<Live>>) {
        if let Some(Heard {
            owner,
            chunk,
            release,
        }) = heard
        {
            if let Some(live) = release {
                live.stop_child();
            }
            emit(app, &owner, chunk);
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
    #[cfg(not(test))]
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

        // MED 1 (round 3): the helper's signature is checked in process with Security.framework, never through codesign.
        // Apple's own ls is the positive case: a matching requirement passes, a mismatch and a missing file refuse.

        #[test]
        fn the_helper_signature_is_checked_in_process() {
            let ls = std::path::Path::new("/bin/ls");
            assert!(super::signed_as(
                ls,
                "identifier \"com.apple.ls\" and anchor apple"
            ));
            assert!(!super::signed_as(
                ls,
                "identifier \"com.ash.monocode-hub.dictation\" and anchor apple generic and certificate leaf[subject.OU] = \"9SB4XNH8C5\""
            ));
            assert!(!super::signed_as(
                std::path::Path::new("/no/such/helper"),
                "identifier \"com.apple.ls\" and anchor apple"
            ));
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
        s.install(id, (), t0()).unwrap();
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

    // LOW 2 (round 3): a permission prompt can sit for minutes before the helper is ready. The 300 s and 30 s limits
    // count from ready, not from the start of the request.
    #[test]
    fn the_limits_count_from_ready_not_from_the_start_of_the_prompt() {
        let mut s: Sessions<()> = Sessions::new();
        let begun = t0();
        let id = s.begin("main", begun).unwrap();
        let ready = begun + Duration::from_secs(400);
        s.install(id, (), ready).unwrap();
        assert!(
            !s.due(ready + Duration::from_secs(10)),
            "a prompt's wait is not dictation time"
        );
        assert!(s.due(ready + MAX_SESSION));
    }

    #[test]
    fn partials_are_sent_and_empty_partials_are_not() {
        let mut s: Sessions<()> = Sessions::new();
        let id = s.begin("main", t0()).unwrap();
        s.install(id, (), t0()).unwrap();
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
        s.install(id, (), t0()).unwrap();
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
        s.install(id, (), t0()).unwrap();
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
            s.install(id, 9, t0()),
            Err(9),
            "the helper that arrives late is handed back"
        );
    }

    #[test]
    fn the_grace_period_releases_what_was_heard() {
        let mut s: Sessions<()> = Sessions::new();
        let id = s.begin("main", t0()).unwrap();
        s.install(id, (), t0()).unwrap();
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
        // Ready at the start: the limits count from the same instant here.
        s.install(id, (), start).unwrap();
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
        // Ready at the start: the limits count from the same instant here.
        s.install(id, (), start).unwrap();
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
        s.install(id, (), t0()).unwrap();
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
            Ok(HelperEvent::Refused { reason }) if reason == "denied"
        ));
        assert!(matches!(
            serde_json::from_str::<HelperEvent>(r#"{"ev":"heard","text":"hi"}"#),
            Ok(HelperEvent::Heard { text }) if text == "hi"
        ));
        assert!(matches!(
            serde_json::from_str::<HelperEvent>(
                r#"{"ev":"final","text":"x","error":true}"#
            ),
            Ok(HelperEvent::Final { text, error: true }) if text == "x"
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
    fn the_hub_connects_over_the_mach_service_and_does_not_spawn_the_helper() {
        // The old path started a child. This one names the service launchd advertises and the helper's identity.
        assert_eq!(MACH_SERVICE, "com.ash.monocode-hub.dictation");
        let requirement = helper_requirement(HUB_IDENTIFIER, "9SB4XNH8C5").expect("requirement");
        assert!(
            requirement.starts_with("identifier \"com.ash.monocode-hub.dictation\""),
            "the requirement names the helper, so a different process cannot answer"
        );
        assert!(requirement.contains("anchor apple generic"));
        assert!(
            !requirement.contains("disclaim"),
            "the Hub does not launch the helper"
        );
    }

    // The kill switch lets the setting decide. A missing file stays off. Flipping ENABLED off fails this test.

    #[test]
    fn dictation_follows_the_setting_and_stays_off_until_the_file_says_on() {
        assert!(
            std::hint::black_box(ENABLED),
            "the build lets the setting decide"
        );
        assert!(!allows_dictation(ENABLED, None));
        assert!(!allows_dictation(ENABLED, Some("")));
        assert!(!allows_dictation(ENABLED, Some("ON")));
        assert!(!allows_dictation(ENABLED, Some("true")));
        assert!(!allows_dictation(ENABLED, Some("on\nno")));
        assert!(allows_dictation(ENABLED, Some("on")));
        assert!(allows_dictation(ENABLED, Some("on\n")));
        assert!(allows_dictation(ENABLED, Some("  on  ")));
        assert!(!allows_dictation(false, Some("on")));
        assert_eq!(agent_change(true, true, false), AgentChange::Leave);
        assert_eq!(agent_change(true, false, true), AgentChange::Unregister);
        assert_eq!(agent_change(false, true, true), AgentChange::Unregister);
        assert_eq!(agent_change(true, true, true), AgentChange::Register);
        let off = plan_setting(true, false, false, true);
        assert!(
            off.stop,
            "turning off stops a session even when the write fails"
        );
        assert_eq!(off.agent, AgentChange::Unregister);
        let failed_on = plan_setting(true, true, false, true);
        assert!(!failed_on.stop);
        assert_eq!(
            failed_on.agent,
            AgentChange::Leave,
            "a failed write does not register"
        );
        let on = plan_setting(true, true, true, false);
        assert_eq!(on.agent, AgentChange::Leave, "a dev copy does not register");

        let mut sessions: Sessions<()> = Sessions::new();
        assert!(sessions.running_id().is_none());
        let id = sessions.begin("main", Instant::now()).expect("start");
        assert_eq!(sessions.running_id(), Some(id));
        assert!(sessions.begin_stop(id));
        assert!(sessions.running_id().is_none());

        let root =
            std::env::temp_dir().join(format!("hub-dictation-setting-{}", std::process::id()));
        let dir = root.join("data");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&dir).expect("setting dir");
        assert!(!read_setting_on(&dir), "a missing file is off");
        assert!(write_setting_file(&dir, true));
        assert_eq!(
            std::fs::read_to_string(dir.join(SETTING_FILE)).unwrap(),
            "on"
        );
        assert!(read_setting_on(&dir));
        assert!(write_setting_file(&dir, false));
        assert_eq!(
            std::fs::read_to_string(dir.join(SETTING_FILE)).unwrap(),
            "off"
        );
        assert!(!read_setting_on(&dir));
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(SETTING_FILE)]);
        std::fs::write(dir.join(SETTING_FILE), "on\nno").unwrap();
        assert!(!read_setting_on(&dir));
        std::fs::write(dir.join(SETTING_FILE), "  on  ").unwrap();
        assert!(read_setting_on(&dir));
        assert!(!write_setting_file(&dir.join(".."), true));
        assert!(
            !root.join(SETTING_FILE).exists(),
            "a path that walks up is not written"
        );
        assert!(!write_setting_file(Path::new(""), true));
        assert!(!write_setting_file(&root.join("missing"), true));
        let _ = std::fs::remove_dir_all(&root);
    }

    // The helper is an SMAppService agent. The switch registers it; switching off unregisters it. A fake registrar
    // stands in, so this test never calls SMAppService or launchd.

    #[test]
    fn register_and_unregister_follow_the_switch() {
        struct Fake {
            calls: Vec<(&'static str, String)>,
        }
        impl AgentControl for Fake {
            fn register_agent(&mut self, plist_name: &str) {
                self.calls.push(("register", plist_name.to_string()));
            }
            fn unregister_agent(&mut self, plist_name: &str) {
                self.calls.push(("unregister", plist_name.to_string()));
            }
        }
        let mut fake = Fake { calls: Vec::new() };
        follow_switch(true, &mut fake);
        assert_eq!(
            fake.calls,
            vec![("register", AGENT_PLIST_NAME.to_string())],
            "switching dictation on registers the helper agent and nothing else"
        );
        follow_switch(false, &mut fake);
        assert_eq!(
            fake.calls,
            vec![
                ("register", AGENT_PLIST_NAME.to_string()),
                ("unregister", AGENT_PLIST_NAME.to_string()),
            ],
            "switching dictation off unregisters it"
        );
        assert_eq!(
            HELPER_BUNDLE_PROGRAM,
            "Contents/Helpers/MonoCode Dictation.app"
        );
        assert_eq!(LAUNCH_AGENTS_DIR, "Contents/Library/LaunchAgents");
    }

    #[test]
    fn the_helper_requirement_names_the_helper_identifier_and_the_team() {
        assert_eq!(
            helper_requirement(HUB_IDENTIFIER, "9SB4XNH8C5").as_deref(),
            Some("identifier \"com.ash.monocode-hub.dictation\" and anchor apple generic and certificate leaf[subject.OU] = \"9SB4XNH8C5\"")
        );
        assert!(helper_requirement(HUB_IDENTIFIER, "9SB4XNH8C5\" or true").is_none());
        assert!(helper_requirement("com.ash\" or true", "9SB4XNH8C5").is_none());
        assert!(
            helper_requirement(HUB_IDENTIFIER, "").is_none(),
            "an unsigned or unknown team gets no helper"
        );
    }

    // LOW 4: a line from the helper is read only up to MAX_LINE_BYTES, and a longer one ends the session.

    #[test]
    fn a_runaway_line_from_the_helper_is_refused_not_buffered() {
        let mut ok = std::io::Cursor::new(b"{\"ev\":\"ready\"}\n".to_vec());
        let mut buf = Vec::new();
        assert_eq!(read_capped_line(&mut ok, &mut buf), Ok(true));
        assert_eq!(read_capped_line(&mut ok, &mut buf), Ok(false));
        let mut runaway = std::io::Cursor::new(vec![b'x'; MAX_LINE_BYTES + 1]);
        assert_eq!(read_capped_line(&mut runaway, &mut buf), Err(()));
        assert!(buf.len() <= MAX_LINE_BYTES + 1);
    }

    // LOW 4: the session's words go to its owner window only.

    #[test]
    fn a_finished_session_reports_its_owner_so_its_words_go_only_there() {
        let mut s: Sessions<()> = Sessions::new();
        let id = s.begin("mono-2", t0()).unwrap();
        s.install(id, (), t0()).unwrap();
        assert_eq!(s.finish(id, "done", false).unwrap().owner, "mono-2");
    }
}
