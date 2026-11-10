//! WP-92: the scrub rule, exactly.
//!
//! Before any command output reaches a model, every needle below is replaced with `[secret removed]`, longest needle
//! first, using plain string search: a regex or replacement built from the value would let a value with regex
//! metacharacters change the pattern, or panic on an invalid one.
//!
//! 1. the raw value; 2. the value with trailing CR/LF trimmed; 3. its JSON-escaped form (serde_json's escaping);
//! 4. percent-encoded with upper-case hex; 5. percent-encoded with lower-case hex; 6. form-encoded (`+` for a space);
//!    7 to 10. base64 standard with and without padding, URL-safe with and without; 11 to 12. hex lower and upper case;
//!    13. its NFC and NFD forms (a Mac terminal prints NFD); 14. for a multi-line value, each line of 8 or more
//!    characters on its own (a PEM printed line by line).
//!
//! Afterwards the shared `secretPatterns.json` scrubber runs over the result. Each stream is capped at 256 KiB with
//! `[output cut]`. Finally the result is scanned again for every needle; if any survives, the stream is replaced whole.
//!
//! This is a second line of defence, not the first: a command can print the value under an encoding not on that list
//! (gzip, base32, double base64, ROT13), one character at a time, split across lines, or write it somewhere else. The
//! first line is that only an executable the person approved ever gets the value at all.

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use unicode_normalization::UnicodeNormalization;

pub const MARKER: &str = "[secret removed]";
/// One stream stops here.
pub const STREAM_CAP: usize = 256 * 1024;
pub const CUT_MARKER: &str = "[output cut]";
pub const DROPPED: &str = "The output looked like it held the secret, so it was not returned.";
/// Every needle here is at least this long, because a saved value is at least 8 characters.
pub const MIN_NEEDLE: usize = 8;

/// Percent-encode every byte outside RFC 3986's unreserved set.
pub(crate) fn percent(text: &str, upper: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => {
                let hex = format!("{byte:02x}");
                out.push('%');
                if upper {
                    out.push_str(&hex.to_ascii_uppercase())
                } else {
                    out.push_str(&hex)
                }
            }
        }
    }
    out
}

/// `application/x-www-form-urlencoded`: spaces become `+`, everything else is percent-encoded.
fn form(text: &str) -> String {
    percent(text, true).replace("%20", "+")
}

pub(crate) fn hex(text: &str, upper: bool) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for byte in text.as_bytes() {
        let pair = format!("{byte:02x}");
        let pair = if upper {
            pair.to_ascii_uppercase()
        } else {
            pair
        };
        out.push_str(&pair);
    }
    out
}

fn json_escaped(text: &str) -> String {
    let quoted = serde_json::to_string(text).unwrap_or_else(|_| format!("{text:?}"));
    // serde_json always yields the surrounding quotes; the escaped body is the needle.
    quoted
        .strip_prefix('"')
        .and_then(|body| body.strip_suffix('"'))
        .unwrap_or(&quoted)
        .to_string()
}

fn trimmed(value: &str) -> &str {
    value.trim_end_matches(['\r', '\n'])
}

/// Every needle for one value, longest first, each at least [`MIN_NEEDLE`] characters.
pub fn needles(value: &str) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    let trimmed_value = trimmed(value);
    let mut list: Vec<String> = vec![
        value.to_string(),
        trimmed_value.to_string(),
        json_escaped(value),
        percent(value, true),
        percent(value, false),
        form(value),
        STANDARD.encode(value.as_bytes()),
        STANDARD_NO_PAD.encode(value.as_bytes()),
        URL_SAFE.encode(value.as_bytes()),
        URL_SAFE_NO_PAD.encode(value.as_bytes()),
        hex(value, false),
        hex(value, true),
        value.nfc().collect(),
        value.nfd().collect(),
    ];
    if value.contains('\n') {
        for line in value.split('\n') {
            let line = line.trim_end_matches('\r');
            if line.chars().count() >= MIN_NEEDLE {
                list.push(line.to_string());
            }
        }
    }
    // Longest first, so a value inside another is hidden whole. Identical needles are kept once.
    list.sort_by_key(|needle| std::cmp::Reverse(needle.len()));
    list.dedup();
    list.retain(|needle| needle.chars().count() >= MIN_NEEDLE);
    list
}

/// Whether `text` still holds `needle`, by plain search.
pub fn holds(text: &str, needle: &str) -> bool {
    !needle.is_empty() && text.contains(needle)
}

/// Whether `text` holds any needle of this value.
pub fn holds_value(value: &str, text: &str) -> bool {
    needles(value).iter().any(|needle| holds(text, needle))
}

/// Replace every needle, longest first, then the shared pattern list.
pub fn mask(text: &str, needles: &[String]) -> String {
    let mut out = text.to_string();
    for needle in needles {
        if needle.is_empty() {
            continue;
        }
        out = out.replace(needle, MARKER);
    }
    crate::portable::scrubber().redact_text(&out).0
}

/// What one stream becomes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scrubbed {
    pub text: String,
    pub truncated: bool,
}

/// Cap, mask, run the shared scrubber, then rescan. A surviving needle drops the whole stream.
///
/// The order is mask first, cut second: a value straddling the cap would otherwise leave its first half in the
/// returned text.
pub fn stream(raw: &[u8], needles: &[String]) -> Scrubbed {
    let text = String::from_utf8_lossy(raw);
    let masked = mask(&text, needles);
    // Cut on the cap only after masking. A cut inside a multi-byte character takes the whole character with it.
    let truncated = masked.len() > STREAM_CAP;
    let mut out = if truncated {
        let mut end = STREAM_CAP;
        while end > 0 && !masked.is_char_boundary(end) {
            end -= 1;
        }
        masked[..end].to_string()
    } else {
        masked
    };
    if truncated && !out.ends_with(CUT_MARKER) {
        out.push('\n');
        out.push_str(CUT_MARKER);
    }
    let survives = needles.iter().any(|needle| holds(&out, needle));
    if survives {
        out = DROPPED.to_string();
    }
    Scrubbed {
        text: out,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALUE: &str = "sk_live_51NxAbCdEfGhIjKl";

    fn has(out: &str, needle: &str) -> bool {
        out.contains(needle)
    }

    #[test]
    fn every_encoded_form_of_the_value_is_removed() {
        let list = needles(VALUE);
        let forms = [
            VALUE.to_string(),
            percent(VALUE, true),
            percent(VALUE, false),
            form(VALUE),
            STANDARD.encode(VALUE.as_bytes()),
            STANDARD_NO_PAD.encode(VALUE.as_bytes()),
            URL_SAFE.encode(VALUE.as_bytes()),
            URL_SAFE_NO_PAD.encode(VALUE.as_bytes()),
            hex(VALUE, false),
            hex(VALUE, true),
            json_escaped(VALUE),
        ];
        for form in &forms {
            let out = mask(&format!("before {form} after"), &list);
            assert!(!has(&out, form), "{form} survived in {out}");
            assert!(out.contains(MARKER), "{out}");
        }
    }

    #[test]
    fn a_json_escaped_value_is_removed_from_a_json_line() {
        let value = "line one\nline two\"quoted\"";
        let list = needles(value);
        let line = serde_json::to_string(&serde_json::json!({ "note": value })).unwrap();
        let out = mask(&line, &list);
        assert!(!has(&out, "line one"));
        assert!(!has(&out, "quoted"));
        assert!(out.contains(MARKER));
    }

    #[test]
    fn percent_encoding_is_upper_and_lower_case_hex() {
        assert_eq!(percent("a b", true), "a%20b");
        assert_eq!(percent("é", true), "%C3%A9");
        assert_eq!(percent("é", false), "%c3%a9");
        assert_eq!(form("a b"), "a+b");
    }

    #[test]
    fn a_mac_terminal_prints_nfd_and_it_is_removed() {
        let value = "café-secret-key";
        let list = needles(value);
        let nfd: String = value.nfd().collect();
        assert_ne!(nfd, value, "the fixture must differ in composition");
        let out = mask(&format!("printed {nfd} here"), &list);
        assert!(!has(&out, &nfd));
        assert!(!has(&out, value));
    }

    #[test]
    fn a_multi_line_value_is_hidden_line_by_line() {
        let value = "-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\nKUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm\n-----END KEY-----";
        let list = needles(value);
        for line in value.split('\n').filter(|l| l.len() >= 8) {
            let out = mask(&format!("> {line}"), &list);
            assert!(!has(&out, line), "line survived: {line}");
        }
        let joined = value.replace('\n', " ");
        assert!(!has(&mask(&joined, &list), "MIIBOgIBAA"));
    }

    #[test]
    fn longest_first_hides_one_value_inside_another() {
        let list = needles("abcdefghijklmnop");
        let out = mask("abcdefghijklmnop and abcdefgh", &list);
        assert_eq!(out, "[secret removed] and abcdefgh");
    }

    #[test]
    fn a_value_with_regex_metacharacters_is_hidden_whole() {
        let value = r"a.*b[cd]+(ef)?$^|{}\";
        let out = mask(&format!("x{value}y"), &needles(value));
        assert!(!has(&out, value));
        assert!(out.contains(MARKER));
    }

    #[test]
    fn a_value_split_across_lines_is_a_known_limit() {
        // Printed as two halves, nothing on the list matches; asserted so the limit is visible, not guessed at.
        let value = "abcdefghijklmnop";
        let out = mask("abcd efgh ijkl mnop", &needles(value));
        assert!(!has(&out, MARKER));
        assert!(out.contains("abcd efgh"));
    }

    #[test]
    fn a_surviving_needle_drops_the_whole_stream() {
        // A needle equal to the marker itself cannot be replaced by anything else: replacing it writes it back, so the
        // rescan still finds it. That is the shape of a survival, and the stream must go rather than be returned.
        let mut list = needles(VALUE);
        list.push(MARKER.to_string());
        let out = stream(b"hello [secret removed] world", &list);
        assert_eq!(out.text, DROPPED);
    }

    #[test]
    fn a_value_straddling_the_cap_is_never_half_kept() {
        // Mask first, then cut: a value straddling the cap would otherwise leave its first half in the stream.
        let value = "sk_live_straddle_51NxAbCdEfGhIjKl";
        let list = needles(value);
        for start in [
            STREAM_CAP - 1,
            STREAM_CAP - value.len() / 2,
            STREAM_CAP - value.len(),
        ] {
            let mut raw = vec![b'x'; STREAM_CAP + value.len() + 10];
            raw[start..start + value.len()].copy_from_slice(value.as_bytes());
            let out = stream(&raw, &list);
            assert!(!out.text.contains(&value[..4]), "{start}: {out:?}");
            assert!(out.truncated, "{start}");
        }
        // Exactly at the cap: the whole value sits inside, and is masked even though nothing is cut.
        let mut raw = vec![b'x'; STREAM_CAP];
        let at = STREAM_CAP - value.len();
        raw[at..].copy_from_slice(value.as_bytes());
        let out = stream(&raw, &list);
        assert!(!out.text.contains(value), "{out:?}");
        assert!(!out.truncated);
        assert!(out.text.contains(MARKER));
        // An ordinary long line still truncates and says so.
        let out = stream(&vec![b'y'; STREAM_CAP + 5], &list);
        assert!(out.truncated);
        assert!(out.text.ends_with(CUT_MARKER));
    }

    #[test]
    fn the_stream_is_capped_and_says_so() {
        let value = VALUE;
        let list = needles(value);
        let big = vec![b'x'; STREAM_CAP + 100];
        let out = stream(&big, &list);
        assert!(out.truncated);
        assert!(out.text.ends_with(CUT_MARKER));
        assert!(out.text.len() <= STREAM_CAP + CUT_MARKER.len() + 1);
        let small = stream(b"ok", &list);
        assert!(!small.truncated);
        assert_eq!(small.text, "ok");
    }

    #[test]
    fn crlf_and_invalid_utf8_survive_lossily() {
        let list = needles(VALUE);
        let out = stream(b"line\r\n\xff\xfe end", &list);
        assert!(out.text.starts_with("line\r\n"));
        assert!(out.text.contains("end"));
        assert!(!out.truncated);
    }

    #[test]
    fn the_shared_pattern_scrubber_runs_after_the_needles() {
        // A GitHub token shape the person did not save here is still hidden by the shared list.
        let out = mask(
            "token ghp_0123456789abcdefghijklmnopqrstuvwxyz",
            &needles(VALUE),
        );
        assert!(!out.contains("ghp_0123456789abcdefghijklmnopqrstuvwxyz"));
    }

    #[test]
    fn needles_are_longest_first_and_never_shorter_than_eight() {
        let list = needles("abcdefgh\nxy\n123456789");
        for pair in list.windows(2) {
            assert!(pair[0].len() >= pair[1].len(), "{pair:?}");
        }
        assert!(list.iter().all(|n| n.chars().count() >= MIN_NEEDLE));
        assert!(list.iter().any(|n| n == "123456789"));
        assert!(!list.iter().any(|n| n == "xy"));
    }
}
