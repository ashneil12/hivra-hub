//! The messages between the Hub and this helper. JSON objects, one command or event each, carried over the helper's
//! XPC service (see xpc.rs). The helper opens no socket and does not read commands from stdin.
//!
//! Hub to helper: `{"op":"start"}` once, then `{"op":"stop"}` to finish. The helper dropping the connection also
//! means stop.
//! Helper to Hub: `ready` after the microphone and recogniser run, or `refused` with one reason code; then `heard`
//! for each partial result and one `final` (with `error` when the recogniser failed) before the helper exits.
//!
//! Every message is admitted only when its peer met the code requirement (see [`decide`]). A message that did not
//! is refused before any permission is asked. Stdout carries a line only when no XPC peer is attached: the switched-off
//! refusal, and the smoke test. That is not a command channel.
//!
//! Off macOS only the protocol and its tests are built, so the items the macOS recogniser uses are unused there.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

#[cfg(test)]
use std::io::BufRead;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// The most text one utterance may carry. The webview caps it too (src/features/sessions/model/dictation.ts).
pub const MAX_TEXT_CHARS: usize = 4000;
/// The longest line either side may send. A longer line is refused, so a runaway writer cannot grow the buffer.
pub const MAX_LINE_BYTES: usize = 64 * 1024;
/// The longest one dictation may run, enforced here as well as by the Hub.
pub const MAX_SESSION: Duration = Duration::from_secs(300);
/// No recognised words for this long ends the dictation, enforced here as well as by the Hub.
pub const SILENCE_LIMIT: Duration = Duration::from_secs(30);
/// Whether this build may open the microphone at all. The XPC service and its per-message peer requirement are in
/// place (xpc.rs), but this stays off until the one live check: the owner taps Allow once on a real build. There is
/// no setting, environment variable or flag that turns this on.
pub const DICTATION_ENABLED: bool = false;

/// The same switch as [`DICTATION_ENABLED`], read at runtime so the listener code stays in the build to be checked.
/// Nothing else can turn it on: there is no setting and no environment variable.
pub fn dictation_enabled() -> bool {
    DICTATION_ENABLED
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Command {
    Start,
    Stop,
}

/// What the XPC service and the recogniser's callbacks send to the session.
#[derive(Debug, PartialEq, Eq)]
pub enum Input {
    Cmd(Command),
    /// The Hub dropped the connection. The helper stops at once.
    Closed,
    /// The recogniser delivered its final result or an error. Nothing more will come.
    Done,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "ev", rename_all = "lowercase")]
pub enum Event {
    Ready,
    /// `reason` is one of: denied, not_on_device, no_microphone, not_here.
    Refused {
        reason: &'static str,
    },
    Heard {
        text: String,
    },
    Final {
        text: String,
        error: bool,
    },
}

/// A line that could not be read: it was longer than MAX_LINE_BYTES without a newline.
/// The live path is an XPC message, capped with the same constant. This reader stays for the test.
#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub struct LineTooLong;

pub fn parse_command(line: &str) -> Option<Command> {
    serde_json::from_str(line.trim()).ok()
}

/// Reads one line into `buf` (newline included when present). `Ok(false)` at end of input, `Err` when the line
/// passes MAX_LINE_BYTES.
#[cfg(test)]
pub fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    buf: &mut Vec<u8>,
) -> Result<bool, LineTooLong> {
    buf.clear();
    let read = std::io::Read::take(reader.by_ref(), MAX_LINE_BYTES as u64 + 1)
        .read_until(b'\n', buf)
        .unwrap_or(0);
    if read == 0 {
        return Ok(false);
    }
    if buf.len() > MAX_LINE_BYTES {
        return Err(LineTooLong);
    }
    Ok(true)
}

/// One event as a single JSON line, newline included.
pub fn encode(event: &Event) -> String {
    let mut line = serde_json::to_string(event)
        .unwrap_or_else(|_| "{\"ev\":\"refused\",\"reason\":\"not_here\"}".into());
    line.push('\n');
    line
}

/// Trimmed, and cut to MAX_TEXT_CHARS characters (never bytes, so no character is split).
pub fn cap(text: &str) -> String {
    text.trim().chars().take(MAX_TEXT_CHARS).collect()
}

/// Whether the dictation has gone on too long, or has had no recognised words for too long.
pub fn over_limit(started: Instant, last_words: Instant, now: Instant) -> bool {
    now.saturating_duration_since(started) >= MAX_SESSION
        || now.saturating_duration_since(last_words) >= SILENCE_LIMIT
}

/// Whether macOS names `pid` as its own responsible process. A helper started without disclaim has its launcher
/// (or the Hub) responsible for it, and that refuses (LOW 4). An unknown answer refuses too.
pub fn is_own_responsible(pid: i32, responsible: Option<i32>) -> bool {
    responsible == Some(pid)
}

/// The daily Hub. A peer signed as anything else, including a dev slot, is not the Hub.
pub const HUB_PEER_IDENTIFIER: &str = "com.ash.monocode-hub";
/// The Mach service the launchd agent advertises. The Hub connects to this; it does not spawn the helper.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MACH_SERVICE: &str = "com.ash.monocode-hub.dictation";

/// The code requirement every message's peer must meet: the Hub's identifier, an Apple-issued anchor
/// (`anchor apple generic`, so the Hub's Developer ID or Apple Development certificate matches; `anchor apple`
/// would only match Apple's own binaries), and the helper's own Team ID. None when `team` is not a Team ID, which
/// refuses every peer.
pub fn hub_peer_requirement(team: &str) -> Option<String> {
    let team_ok = team.len() == 10
        && team
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    if !team_ok {
        return None;
    }
    Some(format!(
        "identifier \"{HUB_PEER_IDENTIFIER}\" and anchor apple generic and certificate leaf[subject.OU] = \"{team}\""
    ))
}

/// What one message may do. A peer that fails the requirement is refused before any permission is asked and before
/// the microphone opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// The peer failed the requirement, or the message is not one we act on. No permission, no microphone.
    Refuse,
    /// A start from a peer that meets the requirement. Permission may be asked. The microphone stays closed until
    /// the prompt ends without a stop.
    Begin,
    /// A stop. During the prompt this keeps the microphone closed.
    Stop,
}

/// Decides one message from the peer-requirement result (true only when the check said the peer meets it) and the
/// command. `prompting` is true while a permission prompt from an earlier start is still up. A peer that fails the
/// requirement is refused, whatever the command, and that refusal is the last thing the helper does with it.
pub fn decide(meets_requirement: bool, command: Option<Command>, prompting: bool) -> Decision {
    if !meets_requirement {
        return Decision::Refuse;
    }
    match command {
        Some(Command::Start) if !prompting => Decision::Begin,
        Some(Command::Stop) => Decision::Stop,
        Some(Command::Start) | None => Decision::Refuse,
    }
}

/// The command to hand to the session for one message line, or None when the message is refused. None means the
/// session is not told, so it never asks for permission and never opens the microphone.
pub fn accepted_command(meets_requirement: bool, line: &str) -> Option<Command> {
    match decide(meets_requirement, parse_command(line), false) {
        Decision::Begin => Some(Command::Start),
        Decision::Stop => Some(Command::Stop),
        Decision::Refuse => None,
    }
}

/// Whether the microphone may open once the permission prompt has ended. A stop that arrived during the prompt
/// keeps it closed (M1).
pub fn mic_may_open(stopped_during_prompt: bool) -> bool {
    !stopped_during_prompt
}

/// Where a session's events go. The XPC service sets this to the peer connection. With none set, events are written
/// to stdout, which is the switched-off refusal and the smoke test, not a command channel.
type LineSink = Arc<dyn Fn(&str) + Send + Sync>;
static LINE_SINK: Mutex<Option<LineSink>> = Mutex::new(None);

pub fn set_line_sink(sink: LineSink) {
    if let Ok(mut slot) = LINE_SINK.lock() {
        *slot = Some(sink);
    }
}

pub fn emit(event: &Event) {
    use std::io::Write;
    let line = encode(event);
    let sink = LINE_SINK.lock().ok().and_then(|slot| slot.clone());
    if let Some(sink) = sink {
        sink(line.trim_end_matches('\n'));
        return;
    }
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(line.as_bytes());
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_and_stop_are_the_only_commands() {
        assert_eq!(parse_command(r#"{"op":"start"}"#), Some(Command::Start));
        assert_eq!(parse_command(" {\"op\":\"stop\"}\n"), Some(Command::Stop));
        assert_eq!(parse_command(r#"{"op":"quit"}"#), None);
        assert_eq!(parse_command("not json"), None);
        assert_eq!(parse_command(""), None);
    }

    #[test]
    fn events_are_one_json_line_with_the_fields_the_hub_reads() {
        assert_eq!(encode(&Event::Ready), "{\"ev\":\"ready\"}\n");
        assert_eq!(
            encode(&Event::Refused { reason: "denied" }),
            "{\"ev\":\"refused\",\"reason\":\"denied\"}\n"
        );
        assert_eq!(
            encode(&Event::Heard {
                text: "buy milk".into()
            }),
            "{\"ev\":\"heard\",\"text\":\"buy milk\"}\n"
        );
        assert_eq!(
            encode(&Event::Final {
                text: "x".into(),
                error: true
            }),
            "{\"ev\":\"final\",\"text\":\"x\",\"error\":true}\n"
        );
    }

    #[test]
    fn text_is_trimmed_and_capped_in_characters_not_bytes() {
        assert_eq!(cap("  hello  "), "hello");
        let long: String = "é".repeat(MAX_TEXT_CHARS + 10);
        let capped = cap(&long);
        assert_eq!(capped.chars().count(), MAX_TEXT_CHARS);
        assert!(capped.chars().all(|c| c == 'é'), "no character is split");
    }

    // LOW 4: a line is read only up to MAX_LINE_BYTES, and a longer one is refused.

    #[test]
    fn a_normal_line_is_read_and_a_runaway_line_is_refused() {
        let mut ok = std::io::Cursor::new(b"{\"op\":\"start\"}\n".to_vec());
        let mut buf = Vec::new();
        assert_eq!(read_bounded_line(&mut ok, &mut buf), Ok(true));
        assert_eq!(
            parse_command(std::str::from_utf8(&buf).unwrap()),
            Some(Command::Start)
        );
        assert_eq!(
            read_bounded_line(&mut ok, &mut buf),
            Ok(false),
            "then end of input"
        );

        let mut runaway = std::io::Cursor::new(vec![b'a'; MAX_LINE_BYTES + 10]);
        assert_eq!(read_bounded_line(&mut runaway, &mut buf), Err(LineTooLong));
        assert!(
            buf.len() <= MAX_LINE_BYTES + 1,
            "the buffer never grows past the limit"
        );
    }

    // HIGH 1: the helper's own limits, the same as the Hub's.

    #[test]
    fn the_helper_ends_a_dictation_at_the_maximum_length_and_after_the_silence_limit() {
        let start = Instant::now();
        assert!(!over_limit(start, start, start + Duration::from_secs(10)));
        assert!(
            over_limit(start, start, start + SILENCE_LIMIT),
            "30 s with no words"
        );
        assert!(
            over_limit(start, start + Duration::from_secs(280), start + MAX_SESSION),
            "300 s in all"
        );
        assert!(!over_limit(
            start,
            start + Duration::from_secs(20),
            start + Duration::from_secs(40)
        ));
        assert_eq!(MAX_SESSION, Duration::from_secs(300));
        assert_eq!(SILENCE_LIMIT, Duration::from_secs(30));
    }

    // LOW 4 (round 3): a helper is its own responsible process only when macOS names its own pid. A helper started
    // without disclaim names the process that started it, and refuses.

    #[test]
    fn a_helper_is_its_own_responsible_process_only_when_macos_names_it() {
        assert!(is_own_responsible(42, Some(42)));
        assert!(
            !is_own_responsible(42, Some(7)),
            "started without disclaim, another process is responsible"
        );
        assert!(!is_own_responsible(42, None), "an unknown answer refuses");
    }

    // HIGH 1: every message is checked. A peer that fails the requirement is refused before any permission.

    #[test]
    fn a_message_from_a_peer_that_fails_the_requirement_is_refused() {
        assert_eq!(
            decide(false, Some(Command::Start), false),
            Decision::Refuse,
            "a failing peer's start never reaches the permission prompt"
        );
        assert_eq!(
            decide(false, Some(Command::Stop), true),
            Decision::Refuse,
            "a failing peer is refused even mid-prompt"
        );
        assert_eq!(
            decide(false, None, false),
            Decision::Refuse,
            "a failing peer with no command is refused"
        );
    }

    #[test]
    fn a_message_from_a_peer_that_meets_the_requirement_is_admitted() {
        assert_eq!(decide(true, Some(Command::Start), false), Decision::Begin);
        assert_eq!(decide(true, Some(Command::Stop), false), Decision::Stop);
        assert_eq!(
            decide(true, Some(Command::Stop), true),
            Decision::Stop,
            "a valid peer can stop during the prompt"
        );
        assert_eq!(
            decide(true, None, false),
            Decision::Refuse,
            "a valid peer still cannot send a command we do not know"
        );
    }

    #[test]
    fn the_peer_requirement_names_the_hub_an_apple_anchor_and_the_helper_team() {
        assert_eq!(
            hub_peer_requirement("9SB4XNH8C5").as_deref(),
            Some(
                "identifier \"com.ash.monocode-hub\" and anchor apple generic and certificate leaf[subject.OU] = \"9SB4XNH8C5\""
            )
        );
        assert!(
            hub_peer_requirement("").is_none(),
            "no team means no requirement, so every peer is refused"
        );
        assert!(hub_peer_requirement("9SB4XNH8C5\" or true").is_none());
        assert!(hub_peer_requirement("short").is_none());
        assert_eq!(MACH_SERVICE, "com.ash.monocode-hub.dictation");
    }

    // M1: a stop while the permission prompt is up keeps the microphone closed.

    #[test]
    fn a_stop_during_the_prompt_keeps_the_microphone_closed() {
        assert!(
            !mic_may_open(true),
            "a stop during the prompt keeps the microphone closed"
        );
        assert!(
            mic_may_open(false),
            "a prompt that ends without a stop may open the microphone"
        );
    }

    #[test]
    fn a_start_line_from_a_failing_peer_is_not_handed_to_the_session() {
        assert_eq!(accepted_command(false, r#"{"op":"start"}"#), None);
        assert_eq!(
            accepted_command(true, r#"{"op":"start"}"#),
            Some(Command::Start)
        );
        assert_eq!(
            accepted_command(true, r#"{"op":"stop"}"#),
            Some(Command::Stop)
        );
        assert_eq!(accepted_command(true, "not json"), None);
        assert_eq!(accepted_command(true, ""), None);
    }
}
