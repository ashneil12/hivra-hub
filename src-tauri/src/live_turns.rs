//! Which chats are mid-turn, as every workspace window currently sees them.
//!
//! `Session.busy` lives in the webview that started the turn. Other windows
//! load the same chat from the store with `busy: false`, so the rail looked
//! idle there. Each window reports its own busy ids; this process-level union
//! is what every window reads, including one opened while a turn is already
//! going.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

pub const CHANGED: &str = "monocode:live-turns";
const MAX_IDS_PER_WINDOW: usize = 500;
const MAX_ID_LEN: usize = 128;

#[derive(Default)]
pub struct LiveTurns {
    by_window: Mutex<HashMap<String, HashSet<String>>>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveTurnsPayload {
    pub session_ids: Vec<String>,
}

fn sorted_union(by_window: &HashMap<String, HashSet<String>>) -> Vec<String> {
    let mut ids: Vec<String> = by_window.values().flatten().cloned().collect();
    ids.sort();
    ids.dedup();
    ids
}

fn accepted_ids(ids: impl IntoIterator<Item = String>) -> HashSet<String> {
    let mut next: HashSet<String> = ids
        .into_iter()
        .filter(|id| !id.is_empty() && id.len() <= MAX_ID_LEN)
        .collect();
    if next.len() > MAX_IDS_PER_WINDOW {
        next = next.into_iter().take(MAX_IDS_PER_WINDOW).collect();
    }
    next
}

impl LiveTurns {
    /// Set this window's mid-turn chats. `Some` when the union changed.
    pub fn set_window(
        &self,
        label: &str,
        ids: impl IntoIterator<Item = String>,
    ) -> Option<Vec<String>> {
        if label.is_empty() {
            return None;
        }
        let next = accepted_ids(ids);
        let mut map = self.by_window.lock().unwrap_or_else(|e| e.into_inner());
        let before = sorted_union(&map);
        if next.is_empty() {
            map.remove(label);
        } else {
            map.insert(label.to_string(), next);
        }
        let after = sorted_union(&map);
        (after != before).then_some(after)
    }

    /// Drop a closed window's report. `Some` when the union changed.
    pub fn drop_window(&self, label: &str) -> Option<Vec<String>> {
        let mut map = self.by_window.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(label)?;
        Some(sorted_union(&map))
    }

    pub fn list(&self) -> Vec<String> {
        let map = self.by_window.lock().unwrap_or_else(|e| e.into_inner());
        sorted_union(&map)
    }
}

fn emit(app: &AppHandle, ids: &[String]) {
    let _ = app.emit(
        CHANGED,
        LiveTurnsPayload {
            session_ids: ids.to_vec(),
        },
    );
}

#[tauri::command]
pub fn live_turns_set(
    app: AppHandle,
    window: WebviewWindow,
    session_ids: Vec<String>,
) -> Vec<String> {
    let host = app.state::<LiveTurns>();
    let label = window.label();
    if !crate::window::is_workspace_window(label) {
        return host.list();
    }
    if let Some(ids) = host.set_window(label, session_ids) {
        emit(&app, &ids);
        ids
    } else {
        host.list()
    }
}

#[tauri::command]
pub fn live_turns_list(host: State<'_, LiveTurns>) -> Vec<String> {
    host.list()
}

pub fn window_closed(app: &AppHandle, label: &str) {
    let Some(host) = app.try_state::<LiveTurns>() else {
        return;
    };
    if let Some(ids) = host.drop_window(label) {
        emit(app, &ids);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| (*id).to_string()).collect()
    }

    #[test]
    fn union_covers_every_window_and_drops_a_closed_one() {
        let host = LiveTurns::default();
        assert_eq!(
            host.set_window("main", ids(&["lead", "worker"])),
            Some(ids(&["lead", "worker"]))
        );
        assert_eq!(
            host.set_window("window-2", ids(&["lead", "other"])),
            Some(ids(&["lead", "other", "worker"]))
        );
        assert_eq!(
            host.set_window("window-2", ids(&["lead", "other"])),
            None,
            "same report is not a change"
        );
        assert_eq!(host.list(), ids(&["lead", "other", "worker"]));

        assert_eq!(
            host.set_window("main", Vec::<String>::new()),
            Some(ids(&["lead", "other"])),
            "clearing one window keeps the other's mid-turn chats"
        );
        assert_eq!(host.drop_window("window-2"), Some(Vec::<String>::new()));
        assert!(host.drop_window("window-2").is_none());
        assert!(host.list().is_empty());
    }

    #[test]
    fn a_window_opened_mid_turn_reads_the_union() {
        let host = LiveTurns::default();
        host.set_window("main", ids(&["lead"]));
        assert_eq!(
            host.list(),
            ids(&["lead"]),
            "the second window's first read is the chats already mid-turn"
        );
    }

    #[test]
    fn empty_and_huge_ids_are_ignored() {
        let host = LiveTurns::default();
        assert!(host
            .set_window("main", [String::new(), "x".repeat(MAX_ID_LEN + 1)])
            .is_none());
        assert!(host.list().is_empty());
        let many = (0..=MAX_IDS_PER_WINDOW).map(|i| format!("s{i}"));
        let changed = host.set_window("main", many).expect("accepted some ids");
        assert_eq!(changed.len(), MAX_IDS_PER_WINDOW);
    }
}
