//! WP-254: an agent looks at its visual reply before the person does.
//!
//! The idea is Up.computer's (MIT, docs/user/html-renders.md: "agents check their work with screenshots from a small
//! headless browser"); the code is Hivra's. The webview builds the page with the same locked policy a visual reply gets
//! (visualReply.ts `visualPreviewDocument`: no network, no navigation, plus a note of every script error). Here it is
//! drawn by a Chrome-family browser already on the Mac, headless, in a throwaway profile, with every host name made to
//! fail and no proxy, so even a page that slipped past the policy reaches nothing. Two runs: one screenshot, one copy of
//! the page after its scripts ran, where the errors are read back. No window ever opens.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use tauri::Manager;

/// Same cap as a visual reply's framed document (visualReply.ts VISUAL_FRAME_MAX_BYTES).
const MAX_DOCUMENT_BYTES: usize = 3_355_443;
const RUN_LIMIT: Duration = Duration::from_secs(30);
/// Screenshots older than this are cleared on the next preview.
const KEEP_FOR: Duration = Duration::from_secs(60 * 60);
const ERRORS_ATTRIBUTE: &str = "data-hivra-preview-errors=\"";

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// The PNG, for the agent's own file reader.
    pub screenshot: String,
    pub errors: Vec<String>,
    pub browser: String,
}

#[cfg(target_os = "macos")]
const APP_BROWSERS: &[&str] = &[
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];
#[cfg(not(target_os = "macos"))]
const APP_BROWSERS: &[&str] = &[];

const PATH_BROWSERS: &[&str] = &[
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
];

/// A Chrome-family browser: the Mac's apps first (also under ~/Applications), then one on PATH.
pub fn find_browser(home: Option<&Path>, path_var: Option<&str>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for app in APP_BROWSERS {
        candidates.push(PathBuf::from(app));
        if let Some(home) = home {
            candidates.push(home.join(app.trim_start_matches('/')));
        }
    }
    for dir in path_var
        .map(|p| std::env::split_paths(p).collect::<Vec<_>>())
        .unwrap_or_default()
    {
        for name in PATH_BROWSERS {
            candidates.push(dir.join(name));
        }
    }
    candidates.into_iter().find(|c| c.is_file())
}

fn base_args(profile: &Path) -> Vec<String> {
    vec![
        "--headless=new".into(),
        "--disable-gpu".into(),
        "--hide-scrollbars".into(),
        "--mute-audio".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-extensions".into(),
        "--disable-sync".into(),
        "--disable-background-networking".into(),
        "--disable-component-update".into(),
        "--disable-default-apps".into(),
        "--no-pings".into(),
        // Every host name fails and no proxy is used: the page's policy already says no network; this is the second lock.
        "--host-resolver-rules=MAP * ~NOTFOUND".into(),
        "--no-proxy-server".into(),
        format!("--user-data-dir={}", profile.display()),
        "--window-size=1000,800".into(),
        // Lets timers and a short animation run before the picture is taken.
        "--virtual-time-budget=2000".into(),
    ]
}

/// Runs the browser to the end or stops it at `limit`; stdout when it finished.
fn run(browser: &Path, args: &[String], limit: Duration) -> Result<String, String> {
    let mut child = Command::new(browser)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't start the browser for the preview: {e}"))?;
    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(out) = stdout.as_mut() {
            use std::io::Read;
            let _ = out.read_to_string(&mut text);
        }
        text
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The preview took too long and was stopped.".into());
            }
        }
    }
    Ok(reader.join().unwrap_or_default())
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in text.bytes() {
        if byte == b'=' {
            break;
        }
        let value = TABLE.iter().position(|c| *c == byte)? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// The errors the page noted, from the page as it stood after its scripts ran. At most 20, each cut to 500 characters.
pub fn errors_from_dom(dom: &str) -> Vec<String> {
    let Some(start) = dom
        .find(ERRORS_ATTRIBUTE)
        .map(|at| at + ERRORS_ATTRIBUTE.len())
    else {
        return Vec::new();
    };
    let encoded: String = dom[start..].chars().take_while(|c| *c != '"').collect();
    base64_decode(&encoded)
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .take(20)
        .map(|e| e.chars().take(500).collect())
        .collect()
}

fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > KEEP_FOR);
        if old {
            let path = entry.path();
            if path.is_dir() {
                let _ = fs::remove_dir_all(path);
            } else {
                let _ = fs::remove_file(path);
            }
        }
    }
}

/// Draws `document` into `<dir>/<id>.png` and reads back its errors.
pub fn render(
    browser: &Path,
    document: &str,
    dir: &Path,
    id: &str,
    limit: Duration,
) -> Result<Preview, String> {
    if document.len() > MAX_DOCUMENT_BYTES {
        return Err("That page is too big to preview.".into());
    }
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Bad preview id.".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    prune(dir);
    let page = dir.join(format!("{id}.html"));
    let png = dir.join(format!("{id}.png"));
    let profile = dir.join(format!("{id}-profile"));
    fs::write(&page, document).map_err(|e| e.to_string())?;
    let url = format!("file://{}", page.display());
    let mut shot = base_args(&profile);
    shot.push(format!("--screenshot={}", png.display()));
    shot.push(url.clone());
    let outcome = run(browser, &shot, limit).and_then(|_| {
        let mut dump = base_args(&profile);
        dump.push("--dump-dom".into());
        dump.push(url);
        run(browser, &dump, limit)
    });
    let _ = fs::remove_dir_all(&profile);
    let _ = fs::remove_file(&page);
    let dom = outcome?;
    if !png.is_file() {
        return Err("The browser didn't draw the page.".into());
    }
    Ok(Preview {
        screenshot: png.to_string_lossy().into_owned(),
        errors: errors_from_dom(&dom),
        browser: browser
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn visual_preview(app: tauri::AppHandle, document: String) -> Result<Preview, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("visual-previews");
    let path = std::env::var("PATH").ok();
    let browser = find_browser(dirs::home_dir().as_deref(), path.as_deref()).ok_or(
        "No Chrome, Chromium, Edge or Brave on this Mac to draw the preview. Send the visual reply without one.",
    )?;
    let id = format!(
        "{}",
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    tauri::async_runtime::spawn_blocking(move || render(&browser, &document, &dir, &id, RUN_LIMIT))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_read_back_from_the_page() {
        // ["boom","Blocked by the sandbox: connect-src"] in base64.
        let json = r#"["boom","Blocked by the sandbox: connect-src"]"#;
        let encoded = encode(json.as_bytes());
        let dom = format!("<html {ERRORS_ATTRIBUTE}{encoded}\"><body></body></html>");
        assert_eq!(
            errors_from_dom(&dom),
            vec!["boom", "Blocked by the sandbox: connect-src"]
        );
        assert!(errors_from_dom("<html><body></body></html>").is_empty());
        assert!(errors_from_dom(&format!("<html {ERRORS_ATTRIBUTE}!!!\">")).is_empty());
    }

    fn encode(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = (chunk[0] as u32) << 16
                | (*chunk.get(1).unwrap_or(&0) as u32) << 8
                | *chunk.get(2).unwrap_or(&0) as u32;
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    #[test]
    fn bad_ids_and_huge_pages_are_refused_before_anything_runs() {
        let dir = std::env::temp_dir();
        let browser = Path::new("/nonexistent/browser");
        assert!(render(browser, "x", &dir, "../up", Duration::from_secs(1)).is_err());
        let huge = "x".repeat(MAX_DOCUMENT_BYTES + 1);
        assert!(render(browser, &huge, &dir, "ok", Duration::from_secs(1)).is_err());
    }

    #[test]
    fn the_browser_is_found_on_path() {
        let dir = std::env::temp_dir().join(format!("hivra-wp254-find-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(find_browser(None, dir.to_str()), None);
        fs::write(dir.join("chromium"), "").unwrap();
        assert_eq!(find_browser(None, dir.to_str()), Some(dir.join("chromium")));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A real render, with the browser `HIVRA_TEST_PREVIEW_BROWSER` names (on Linux, Playwright's
    /// chrome-headless-shell; a full Chrome under a container's root can hang). Skipped when it is unset.
    #[test]
    fn a_real_browser_draws_the_page_and_reports_its_errors_and_blocked_fetches() {
        let Some(browser) = std::env::var_os("HIVRA_TEST_PREVIEW_BROWSER").map(PathBuf::from)
        else {
            eprintln!("HIVRA_TEST_PREVIEW_BROWSER unset; skipped");
            return;
        };
        let dir = std::env::temp_dir().join(format!("hivra-wp254-real-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // A container's root can't use the browser's own sandbox; a Mac never needs this.
        #[cfg(unix)]
        let browser = {
            use std::os::unix::fs::PermissionsExt;
            let wrapper = dir.join("browser");
            fs::write(
                &wrapper,
                format!(
                    "#!/bin/sh\nexec '{}' --no-sandbox \"$@\"\n",
                    browser.display()
                ),
            )
            .unwrap();
            fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
            wrapper
        };
        let collector = r#"<script>(function(){var l=[];function n(t){l.push(String(t));document.documentElement.setAttribute("data-hivra-preview-errors",btoa(unescape(encodeURIComponent(JSON.stringify(l)))));}window.addEventListener("error",function(e){n(e.message||"Error")},true);document.addEventListener("securitypolicyviolation",function(e){n("Blocked by the sandbox: "+e.violatedDirective)});})();</script>"#;
        let doc = format!(
            "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'\">{collector}</head><body><h1>Hi</h1><script>fetch('https://example.com/x').catch(function(){{}});missing();</script></body></html>"
        );
        let preview = render(&browser, &doc, &dir, "real", Duration::from_secs(60)).unwrap();
        assert!(Path::new(&preview.screenshot).is_file());
        assert!(
            preview.errors.iter().any(|e| e.contains("missing")),
            "{:?}",
            preview.errors
        );
        assert!(
            preview.errors.iter().any(|e| e.contains("connect-src")),
            "{:?}",
            preview.errors
        );
        // Nothing of the run is left but the picture.
        assert!(!dir.join("real.html").exists());
        assert!(!dir.join("real-profile").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
