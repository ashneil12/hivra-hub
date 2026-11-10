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

/// A visual reply's shell (WP-130), network off: the same policy as its guest, plus the sandbox. The inner srcdoc
/// guest inherits it, so nothing in the frame can load from outside data: and blob:. Kept equal to `visualFrameCsp`
/// in src/features/sessions/model/visualReply.ts by a unit test there.
pub const VISUAL_CSP: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; \
    style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; \
    form-action 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'";
/// The same reply after the person allowed the network for it: https and wss only, never plain http or ws, so a plain
/// http server, `file:` and the app's own http schemes stay shut. https still names localhost and the LAN (a known
/// limit, recorded in the WP doc and shown to the person as a note). Still no remote script, frame, form or navigation.
pub const VISUAL_NETWORK_CSP: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; \
    style-src 'unsafe-inline'; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; \
    connect-src https: wss:; form-action 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; \
    base-uri 'none'";
/// Keys a visual reply's frame must start with, so its documents stay apart from pages.
pub const VISUAL_KEY_PREFIX: &str = "visual-";
/// The largest visual frame document (3.2 MiB). A reply at the source cap (512 KiB, quotes escaped to `&quot;`) fits
/// with room for the shell and helpers. Kept equal to `VISUAL_FRAME_MAX_BYTES` in visualReply.ts (a unit test there).
pub const VISUAL_MAX_BYTES: usize = 3_355_443;

/// Which policy a stored document is served with. Set by the command that stored it, never by the key alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramePolicy {
    Page,
    Visual,
    VisualNetwork,
}

impl FramePolicy {
    fn csp(self) -> &'static str {
        match self {
            Self::Page => PAGE_CSP,
            Self::Visual => VISUAL_CSP,
            Self::VisualNetwork => VISUAL_NETWORK_CSP,
        }
    }

    fn is_visual(self) -> bool {
        !matches!(self, Self::Page)
    }
}

#[derive(Default)]
pub struct PageFrames(Mutex<VecDeque<(String, String, FramePolicy)>>);

pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

impl PageFrames {
    pub fn put(&self, key: &str, html: String) -> Result<(), String> {
        self.put_with(key, html, FramePolicy::Page)
    }

    /// Pages and visual replies each keep up to `MAX_FRAMES`, so a long chat of replies never pushes out a page.
    pub fn put_with(&self, key: &str, html: String, policy: FramePolicy) -> Result<(), String> {
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
        frames.retain(|(k, _, _)| k != key);
        frames.push_back((key.to_string(), html, policy));
        while frames
            .iter()
            .filter(|(_, _, p)| p.is_visual() == policy.is_visual())
            .count()
            > MAX_FRAMES
        {
            if let Some(at) = frames
                .iter()
                .position(|(_, _, p)| p.is_visual() == policy.is_visual())
            {
                frames.remove(at);
            }
        }
        Ok(())
    }

    /// Removes one document; true when it was there.
    pub fn remove(&self, key: &str) -> bool {
        let Ok(mut frames) = self.0.lock() else {
            return false;
        };
        let before = frames.len();
        frames.retain(|(k, _, _)| k != key);
        frames.len() != before
    }

    pub fn get(&self, key: &str) -> Option<(String, FramePolicy)> {
        let frames = self.0.lock().ok()?;
        frames
            .iter()
            .find(|(k, _, _)| k == key)
            .map(|(_, html, policy)| (html.clone(), *policy))
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

/// WP-130: a visual reply's shell. In the app a srcdoc frame inherits the app's policy, so the reply's script never
/// ran; the frame loads `page-<key>` instead, served with the visual policy the person chose for that reply.
#[tauri::command]
pub fn visual_frame_put(
    frames: State<'_, PageFrames>,
    key: String,
    html: String,
    network: bool,
) -> Result<String, String> {
    put_visual(&frames, &key, html, network)
}

fn put_visual(
    frames: &PageFrames,
    key: &str,
    html: String,
    network: bool,
) -> Result<String, String> {
    if !key.starts_with(VISUAL_KEY_PREFIX) || !valid_key(key) {
        return Err("That visual reply frame key isn't valid.".into());
    }
    if html.len() > VISUAL_MAX_BYTES {
        return Err("That reply is too big to show.".into());
    }
    let policy = if network {
        FramePolicy::VisualNetwork
    } else {
        FramePolicy::Visual
    };
    frames.put_with(key, html, policy)?;
    Ok(format!("{PATH_PREFIX}{key}"))
}

/// WP-130: the frame was replaced or unmounted, so its document leaves the store. Only a visual reply's key.
#[tauri::command]
pub fn visual_frame_drop(frames: State<'_, PageFrames>, key: String) -> Result<(), String> {
    drop_visual(&frames, &key)
}

fn drop_visual(frames: &PageFrames, key: &str) -> Result<(), String> {
    if !key.starts_with(VISUAL_KEY_PREFIX) || !valid_key(key) {
        return Err("That visual reply frame key isn't valid.".into());
    }
    frames.remove(key);
    Ok(())
}

pub fn serve(frames: Option<&PageFrames>, key: &str) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap_or_default()
    };
    let Some((html, policy)) = frames.filter(|_| valid_key(key)).and_then(|f| f.get(key)) else {
        return not_found();
    };
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", policy.csp())
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

    fn csp_of(res: &tauri::http::Response<Vec<u8>>) -> String {
        res.headers()
            .get("Content-Security-Policy")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn a_visual_reply_is_served_with_the_policy_its_person_chose() {
        let frames = PageFrames::default();
        assert_eq!(
            put_visual(&frames, "visual-ab12-0", "<p>a</p>".into(), false).unwrap(),
            "page-visual-ab12-0"
        );
        put_visual(&frames, "visual-ab12-1", "<p>b</p>".into(), true).unwrap();
        let locked = csp_of(&serve(Some(&frames), "visual-ab12-0"));
        assert_eq!(locked, VISUAL_CSP);
        assert!(locked.starts_with("sandbox allow-scripts;"));
        assert!(locked.contains("connect-src 'none'"));
        assert!(!locked.contains("https:"));
        let open = csp_of(&serve(Some(&frames), "visual-ab12-1"));
        assert_eq!(open, VISUAL_NETWORK_CSP);
        assert!(open.contains("connect-src https: wss:"));
        for csp in [&locked, &open] {
            assert!(!csp.contains("http:") && !csp.contains("ws:") && !csp.contains("localhost"));
            assert!(csp.contains("frame-src 'none'") && csp.contains("form-action 'none'"));
            assert!(!csp.contains("allow-same-origin"));
        }
        // A page keeps the page policy even when its key looks like a reply's.
        frames.put("visual-page", "<p>p</p>".into()).unwrap();
        assert_eq!(csp_of(&serve(Some(&frames), "visual-page")), PAGE_CSP);
        // A reply key must say it is one, and bad keys stay out.
        assert!(put_visual(&frames, "pg-1", "x".into(), true).is_err());
        assert!(put_visual(&frames, "visual-../x", "x".into(), true).is_err());
    }

    #[test]
    fn many_visual_replies_do_not_push_out_a_page() {
        let frames = PageFrames::default();
        frames.put("pg-1", "page".into()).unwrap();
        for i in 0..(MAX_FRAMES + 5) {
            put_visual(&frames, &format!("visual-r-{i}"), "x".into(), false).unwrap();
        }
        assert_eq!(serve(Some(&frames), "pg-1").status(), 200);
        assert_eq!(serve(Some(&frames), "visual-r-0").status(), 404);
        assert_eq!(
            serve(Some(&frames), &format!("visual-r-{}", MAX_FRAMES + 4)).status(),
            200
        );
    }

    #[test]
    fn a_visual_reply_over_the_frame_cap_is_refused() {
        let frames = PageFrames::default();
        assert_eq!(VISUAL_MAX_BYTES, 3_355_443);
        assert!(put_visual(
            &frames,
            "visual-big-0",
            "x".repeat(VISUAL_MAX_BYTES + 1),
            false
        )
        .is_err());
        assert_eq!(serve(Some(&frames), "visual-big-0").status(), 404);
        assert!(put_visual(&frames, "visual-big-1", "x".repeat(VISUAL_MAX_BYTES), false).is_ok());
    }

    #[test]
    fn a_replaced_or_unmounted_visual_frame_leaves_the_store_and_a_page_stays() {
        let frames = PageFrames::default();
        put_visual(&frames, "visual-gone-0", "<p>x</p>".into(), false).unwrap();
        assert_eq!(serve(Some(&frames), "visual-gone-0").status(), 200);
        drop_visual(&frames, "visual-gone-0").unwrap();
        assert_eq!(serve(Some(&frames), "visual-gone-0").status(), 404);
        frames.put("pg-keep", "page".into()).unwrap();
        assert!(drop_visual(&frames, "pg-keep").is_err());
        assert!(drop_visual(&frames, "visual-../x").is_err());
        assert_eq!(serve(Some(&frames), "pg-keep").status(), 200);
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
