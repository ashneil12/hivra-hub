//! The main window is always shown at a usable size after launch, whatever a later startup step does.
//!
//! Seen on 15 Oct: launched while the Mac's screen was locked, the main window came up 145x117 points (below the
//! configured 800x520 minimum) and nothing ever brought it back to size. This checks the launch windows ("main" and
//! the "window-N" ones the user opened, never the hidden background-session windows) shortly after start, a few
//! times, and again whenever one gains focus (the first click after unlocking): hidden → shown, too small → the
//! configured size, centred. What it saw and did is appended to the app's log folder (`window.log`).

use std::io::Write;
use std::time::Duration;

use tauri::{LogicalSize, Manager, Runtime, WebviewWindow};

/// A window the user should be looking at after launch.
pub fn is_launch_window(label: &str) -> bool {
    label == "main" || label.starts_with("window-")
}

#[derive(Debug, PartialEq, Eq)]
pub enum Fix {
    None,
    Show,
    Resize,
    ShowAndResize,
}

/// What a launch window needs. A minimised window is the user's choice and is left alone.
pub fn fix_for(visible: bool, minimized: bool, width: f64, height: f64, min: (f64, f64)) -> Fix {
    if minimized {
        return Fix::None;
    }
    let small = width < min.0 || height < min.1;
    match (visible, small) {
        (true, false) => Fix::None,
        (false, false) => Fix::Show,
        (true, true) => Fix::Resize,
        (false, true) => Fix::ShowAndResize,
    }
}

fn configured<R: Runtime>(app: &tauri::AppHandle<R>) -> ((f64, f64), (f64, f64)) {
    let main = app.config().app.windows.iter().find(|w| w.label == "main");
    let size = main.map(|w| (w.width, w.height)).unwrap_or((1280.0, 800.0));
    let min = main
        .map(|w| (w.min_width.unwrap_or(800.0), w.min_height.unwrap_or(520.0)))
        .unwrap_or((800.0, 520.0));
    (size, min)
}

fn log<R: Runtime>(app: &tauri::AppHandle<R>, line: &str) {
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("window.log"))
    {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "{stamp} {line}");
    }
}

/// Check one window now and put it right.
pub fn check<R: Runtime>(app: &tauri::AppHandle<R>, window: &WebviewWindow<R>, why: &str) {
    if !is_launch_window(window.label()) {
        return;
    }
    let (size, min) = configured(app);
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let scale = window.scale_factor().unwrap_or(1.0);
    let (w, h) = window
        .inner_size()
        .map(|s| (f64::from(s.width) / scale, f64::from(s.height) / scale))
        .unwrap_or((0.0, 0.0));
    let fix = fix_for(visible, minimized, w, h, min);
    log(
        app,
        &format!(
            "{why}: {} visible={visible} minimized={minimized} size={w:.0}x{h:.0} -> {fix:?}",
            window.label()
        ),
    );
    if matches!(fix, Fix::Resize | Fix::ShowAndResize) {
        let _ = window.set_size(LogicalSize::new(size.0, size.1));
        let _ = window.center();
    }
    if matches!(fix, Fix::Show | Fix::ShowAndResize) {
        let _ = window.unminimize();
        let _ = window.show();
    }
}

fn check_all<R: Runtime>(app: &tauri::AppHandle<R>, why: &str) {
    for window in app.webview_windows().into_values() {
        check(app, &window, why);
    }
}

/// After launch: check now and a few times over the first seconds (later startup steps run then).
pub fn start<R: Runtime>(app: tauri::AppHandle<R>) {
    check_all(&app, "ready");
    std::thread::spawn(move || {
        for (i, wait) in [500u64, 1500, 3000, 10_000].into_iter().enumerate() {
            std::thread::sleep(Duration::from_millis(wait));
            let handle = app.clone();
            let _ = app
                .run_on_main_thread(move || check_all(&handle, &format!("after launch {}", i + 1)));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: (f64, f64) = (800.0, 520.0);

    #[test]
    fn a_tiny_window_is_put_back_to_size_and_a_hidden_one_is_shown() {
        assert_eq!(fix_for(true, false, 145.0, 117.0, MIN), Fix::Resize);
        assert_eq!(fix_for(false, false, 145.0, 117.0, MIN), Fix::ShowAndResize);
        assert_eq!(fix_for(false, false, 1280.0, 800.0, MIN), Fix::Show);
        assert_eq!(fix_for(true, false, 1280.0, 800.0, MIN), Fix::None);
        assert_eq!(fix_for(true, false, 800.0, 520.0, MIN), Fix::None);
        assert_eq!(fix_for(true, false, 799.0, 600.0, MIN), Fix::Resize);
    }

    #[test]
    fn a_window_the_user_minimised_is_left_alone() {
        assert_eq!(fix_for(false, true, 145.0, 117.0, MIN), Fix::None);
    }

    #[test]
    fn only_the_launch_windows_are_touched() {
        assert!(is_launch_window("main"));
        assert!(is_launch_window("window-3"));
        for other in [
            "quick-session-1a2b",
            "quick-composer",
            "quick-composer-git",
            "mono-chat-frank",
            "mono-chat",
        ] {
            assert!(!is_launch_window(other), "{other}");
        }
    }
}
