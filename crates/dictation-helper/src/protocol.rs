//! The line protocol between the Hub and this helper. JSON lines only, over the helper's stdin and stdout. Nothing
//! else is written to either, and the helper opens no socket.
//!
//! Hub to helper: `{"op":"start"}` once, then `{"op":"stop"}` to finish. Closing stdin also means stop.
//! Helper to Hub: `ready` after the microphone and recogniser run, or `refused` with one reason code; then `heard`
//! for each partial result and one `final` (with `error` when the recogniser failed) before the helper exits.

use serde::{Deserialize, Serialize};

/// The most text one utterance may carry. The webview caps it too (src/features/sessions/model/dictation.ts).
pub const MAX_TEXT_CHARS: usize = 4000;

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

pub fn parse_command(line: &str) -> Option<Command> {
    serde_json::from_str(line.trim()).ok()
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

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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
}
