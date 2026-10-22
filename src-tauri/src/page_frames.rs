//! Bespoke Pages (src/features/pages) run in a sandboxed frame. A `srcdoc` frame inherits the app's own content
//! security policy (`script-src 'self'`), so in the real app its helper and the page's own script never ran: the
//! page showed its static headings and nothing else (C3 live, 22 Oct: "Needs you" and "Everyone else" empty while
//! the hub had 5 needs). Html artifacts already avoid this by loading from the app's frame scheme with their own
//! policy; a page does the same: the app hands its document here, and the frame loads
//! `monoartifact://localhost/page-<key>`, served with the page's own policy (no network, no forms, no frames).
use std::collections::VecDeque;
use std::sync::Mutex;

use tauri::State;

/// The path prefix under the frame scheme (`artifacts::HTML_SCHEME`) that serves page documents.
pub const PATH_PREFIX: &str = "page-";
/// Documents kept at once (each open page frame is one; the oldest goes first).
const MAX_FRAMES: usize = 48;
/// A page's html is at most 200,000 characters (Ash OS checks it); its css, js and the helper fit well under this.
const MAX_BYTES: usize = 4 * 1024 * 1024;
/// The page's own policy, the same as the srcdoc's meta policy plus the sandbox (even if opened outside a frame).
pub const PAGE_CSP: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; \
    style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; \
    frame-src 'none'; base-uri 'none'";

#[derive(Default)]
pub struct PageFrames(Mutex<VecDeque<(String, String)>>);

pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

impl PageFrames {
    pub fn put(&self, key: &str, html: String) -> Result<(), String> {
        if !valid_key(key) {
            return Err("That page frame key isn't valid.".into());
        }
        if html.len() > MAX_BYTES {
            return Err("That page is too big to show.".into());
        }
        let mut frames = self
            .0
            .lock()
            .map_err(|_| "The page frames are unavailable.".to_string())?;
        frames.retain(|(k, _)| k != key);
        frames.push_back((key.to_string(), html));
        while frames.len() > MAX_FRAMES {
            frames.pop_front();
        }
        Ok(())
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let frames = self.0.lock().ok()?;
        frames
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, html)| html.clone())
    }
}

/// The app hands a page's whole document (built by `bespokeSrcdoc`); the frame then loads `page-<key>`.
#[tauri::command]
pub fn page_frame_put(
    frames: State<'_, PageFrames>,
    key: String,
    html: String,
) -> Result<String, String> {
    frames.put(&key, html)?;
    Ok(format!("{PATH_PREFIX}{key}"))
}

pub fn serve(frames: Option<&PageFrames>, key: &str) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap_or_default()
    };
    let Some(html) = frames.filter(|_| valid_key(key)).and_then(|f| f.get(key)) else {
        return not_found();
    };
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", PAGE_CSP)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(html.into_bytes())
        .unwrap_or_else(|_| not_found())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_document_is_served_with_its_own_sandboxed_policy() {
        let frames = PageFrames::default();
        frames.put("abc-1", "<p>hi</p>".into()).unwrap();
        let res = serve(Some(&frames), "abc-1");
        assert_eq!(res.status(), 200);
        let csp = res
            .headers()
            .get("Content-Security-Policy")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.starts_with("sandbox allow-scripts;"));
        assert!(csp.contains("script-src 'unsafe-inline'"));
        assert!(csp.contains("connect-src 'none'"));
        assert_eq!(res.body(), b"<p>hi</p>");
    }

    #[test]
    fn unknown_or_bad_keys_are_not_found_and_old_frames_make_room() {
        let frames = PageFrames::default();
        assert_eq!(serve(Some(&frames), "nope").status(), 404);
        assert!(frames.put("../x", "x".into()).is_err());
        assert_eq!(serve(None, "abc").status(), 404);
        for i in 0..(MAX_FRAMES + 5) {
            frames.put(&format!("k{i}"), "x".into()).unwrap();
        }
        assert_eq!(serve(Some(&frames), "k0").status(), 404);
        assert_eq!(
            serve(Some(&frames), &format!("k{}", MAX_FRAMES + 4)).status(),
            200
        );
        assert!(frames.put("big", "x".repeat(MAX_BYTES + 1)).is_err());
    }
}
