//! The main window's size and place across a relaunch, in logical points (r65, PM's r63 run).
//!
//! tauri-plugin-window-state saves physical pixels and checks them against monitors in physical pixels. With a 1x
//! external display beside a 2x built-in one those spaces disagree on macOS: a window saved at 1512x949 on the external
//! display came back at the default 1280x800 on the built-in one. So the plugin keeps maximized and fullscreen only,
//! and this file keeps the frame in points, which is what Cocoa places windows in.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};
use tauri_plugin_window_state::StateFlags;

const FILE: &str = "window-frame.json";
const MAIN: &str = "main";
/// The smallest window tauri.conf.json allows.
const MIN_W: f64 = 800.0;
const MIN_H: f64 = 520.0;
/// How much of the title bar must land on a screen for the saved place to be used.
const GRAB: f64 = 80.0;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What the window-state plugin still restores: never size or position (this file does), never decorations (the
/// overlay title bar is set in code) and never visibility (a quit-while-hidden must not open hidden).
pub fn plugin_flags() -> StateFlags {
    StateFlags::MAXIMIZED | StateFlags::FULLSCREEN
}

/// Where a saved frame goes on the screens there are now: as saved when its title bar is on a screen, otherwise its
/// size alone on the first screen (the OS keeps its default place). Never larger than that screen, never smaller than
/// the window's minimum.
pub fn place(saved: Frame, screens: &[Frame]) -> (Option<(f64, f64)>, (f64, f64)) {
    let on = screens.iter().find(|s| {
        let left = saved.x.max(s.x);
        let right = (saved.x + saved.width).min(s.x + s.width);
        let top = saved.y;
        right - left >= GRAB.min(saved.width) && top >= s.y && top < s.y + s.height
    });
    let screen = on.or(screens.first());
    let (mut w, mut h) = (saved.width.max(MIN_W), saved.height.max(MIN_H));
    if let Some(s) = screen {
        w = w.min(s.width.max(MIN_W));
        h = h.min(s.height.max(MIN_H));
    }
    (on.map(|_| (saved.x, saved.y)), (w, h))
}

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

fn screens(window: &WebviewWindow) -> Vec<Frame> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let scale = m.scale_factor();
            let p = m.position().to_logical::<f64>(scale);
            let s = m.size().to_logical::<f64>(scale);
            Frame {
                x: p.x,
                y: p.y,
                width: s.width,
                height: s.height,
            }
        })
        .collect()
}

/// Put the main window back where it was. A missing or unreadable file leaves the config's default.
pub fn restore(app: &AppHandle) {
    let (Some(window), Some(file)) = (app.get_webview_window(MAIN), path(app)) else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(file) else {
        // First launch on this version: only the plugin's file is there, so it puts the window back as before.
        use tauri_plugin_window_state::WindowExt;
        let _ = window.restore_state(StateFlags::SIZE | StateFlags::POSITION);
        return;
    };
    let Ok(saved) = serde_json::from_str::<Frame>(&raw) else {
        return;
    };
    if !(saved.width.is_finite()
        && saved.height.is_finite()
        && saved.x.is_finite()
        && saved.y.is_finite())
    {
        return;
    }
    let (at, (w, h)) = place(saved, &screens(&window));
    let _ = window.set_size(LogicalSize::new(w, h));
    if let Some((x, y)) = at {
        let _ = window.set_position(LogicalPosition::new(x, y));
    }
}

/// Save the main window's frame in points. Skipped while maximized or fullscreen (the plugin keeps those, and the
/// frame under them is the one worth keeping) or hidden or minimized.
pub fn save(app: &AppHandle) {
    let (Some(window), Some(file)) = (app.get_webview_window(MAIN), path(app)) else {
        return;
    };
    if window.is_maximized().unwrap_or(false)
        || window.is_fullscreen().unwrap_or(false)
        || window.is_minimized().unwrap_or(false)
        || !window.is_visible().unwrap_or(true)
    {
        return;
    }
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let p = pos.to_logical::<f64>(scale);
    let s = size.to_logical::<f64>(scale);
    let frame = Frame {
        x: p.x,
        y: p.y,
        width: s.width,
        height: s.height,
    };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(&frame) {
        let _ = std::fs::write(file, json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUILT_IN: Frame = Frame {
        x: 0.0,
        y: 0.0,
        width: 1512.0,
        height: 982.0,
    };
    const EXTERNAL: Frame = Frame {
        x: 1512.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };

    #[test]
    fn a_window_saved_on_the_external_display_comes_back_there_at_its_size() {
        let saved = Frame {
            x: 1512.0,
            y: 30.0,
            width: 1512.0,
            height: 949.0,
        };
        assert_eq!(
            place(saved, &[BUILT_IN, EXTERNAL]),
            (Some((1512.0, 30.0)), (1512.0, 949.0))
        );
    }

    #[test]
    fn with_that_display_gone_it_keeps_its_size_and_the_os_picks_the_place() {
        let saved = Frame {
            x: 1512.0,
            y: 30.0,
            width: 1400.0,
            height: 900.0,
        };
        assert_eq!(place(saved, &[BUILT_IN]), (None, (1400.0, 900.0)));
    }

    #[test]
    fn never_bigger_than_the_screen_nor_smaller_than_the_minimum() {
        let big = Frame {
            x: 10.0,
            y: 30.0,
            width: 3000.0,
            height: 2000.0,
        };
        assert_eq!(place(big, &[BUILT_IN]).1, (1512.0, 982.0));
        let tiny = Frame {
            x: 10.0,
            y: 30.0,
            width: 100.0,
            height: 100.0,
        };
        assert_eq!(place(tiny, &[BUILT_IN]).1, (MIN_W, MIN_H));
    }

    #[test]
    fn the_plugin_no_longer_owns_size_place_decorations_or_visibility() {
        let flags = plugin_flags();
        for f in [
            StateFlags::SIZE,
            StateFlags::POSITION,
            StateFlags::DECORATIONS,
            StateFlags::VISIBLE,
        ] {
            assert!(!flags.contains(f));
        }
        assert!(flags.contains(StateFlags::MAXIMIZED));
    }
}
