//! The line protocol between the Hub and this helper. JSON lines only, over the helper's stdin and stdout. Nothing
//! else is written to either, and the helper opens no socket.
//!
//! Hub to helper: `{"op":"start"}` once, then `{"op":"stop"}` to finish. Closing stdin also means stop.
//! Helper to Hub: `ready` after the microphone and recogniser run, or `refused` with one reason code; then `heard`
//! for each partial result and one `final` (with `error` when the recogniser failed) before the helper exits.
//!
//! Off macOS only the protocol and its tests are built, so the items the macOS recogniser uses are unused there.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::io::BufRead;
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
/// The Hub's bundle identifier. The helper accepts only a parent signed with it.
pub const HUB_IDENTIFIER: &str = "com.ash.monocode-hub";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Command {
    Start,
    Stop,
}

/// What the stdin reader and the recogniser's callbacks send to the main thread.
#[derive(Debug, PartialEq, Eq)]
pub enum Input {
    Cmd(Command),
    /// The Hub closed stdin. The helper stops at once.
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
#[derive(Debug, PartialEq, Eq)]
pub struct LineTooLong;

pub fn parse_command(line: &str) -> Option<Command> {
    serde_json::from_str(line.trim()).ok()
}

/// Reads one line into `buf` (newline included when present). `Ok(false)` at end of input, `Err` when the line
/// passes MAX_LINE_BYTES.
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

/// The code requirement the parent must meet: the Hub's identifier, Apple-anchored, under this Team ID.
pub fn requirement_for(identifier: &str, team: &str) -> Result<String, &'static str> {
    let identifier_ok = !identifier.is_empty()
        && identifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    let team_ok = team.len() == 10
        && team
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    if !identifier_ok || !team_ok {
        return Err("not_here");
    }
    Ok(format!(
        "identifier \"{identifier}\" and anchor apple generic and certificate leaf[subject.OU] = \"{team}\""
    ))
}

pub fn emit(event: &Event) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(encode(event).as_bytes());
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

    // HIGH 1: the parent's requirement is built from the Hub's identifier and a validated Team ID.

    #[test]
    fn the_parent_requirement_names_the_hub_and_the_team() {
        let req = requirement_for(HUB_IDENTIFIER, "9SB4XNH8C5").unwrap();
        assert_eq!(
            req,
            "identifier \"com.ash.monocode-hub\" and anchor apple generic and certificate leaf[subject.OU] = \"9SB4XNH8C5\""
        );
    }

    #[test]
    fn a_requirement_cannot_be_widened_by_its_inputs() {
        assert!(requirement_for(HUB_IDENTIFIER, "9SB4XNH8C5\" or true").is_err());
        assert!(requirement_for("com.ash\" or true", "9SB4XNH8C5").is_err());
        assert!(requirement_for(HUB_IDENTIFIER, "short").is_err());
        assert!(requirement_for("", "9SB4XNH8C5").is_err());
    }
}
