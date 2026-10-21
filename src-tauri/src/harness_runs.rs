//! When each chat's process lived and when it was in a turn, kept by the app process itself.
//!
//! The soul tamper check (src/features/hub/model/soulTamper.ts) asks "was a chat running when this soul changed?".
//! The page used to answer from its own idea of busy, and a window reload ended that idea at the turn's start while
//! the Claude process ran on (Mac round 2, 21 Oct: a python3 write 6-26 s into a turn was kept as Ash's edit). This
//! ledger lives in the app process, which a reload doesn't touch, and follows the real process: a turn opens when the
//! app sends a message on the child's stdin and closes on the line that ends a turn, or when the process exits.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Runs kept for the app's life (newest last), and turns kept per run.
const MAX_RUNS: usize = 500;
const MAX_TURNS: usize = 200;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub start: u64,
    /// Absent: the turn is still going.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRun {
    pub session_id: String,
    pub pid: u32,
    pub cwd: String,
    pub start: u64,
    /// Absent: the process is still alive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<u64>,
    pub turns: Vec<Turn>,
}

pub type RunHandle = Arc<Mutex<ProcessRun>>;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A message on stdin that starts a turn: Claude stream-json's user message, Codex app-server's `turn/start`, an ACP
/// `session/prompt`. Control messages (an interrupt, a permission answer, initialize) don't.
pub fn starts_turn(line: &str) -> bool {
    let line = line.trim_start();
    line.starts_with("{\"type\":\"user\"")
        || line.contains("\"method\":\"turn/start\"")
        || line.contains("\"method\":\"session/prompt\"")
}

/// A stdout line that ends a turn: Claude's `result`, Codex's `turn/completed`, an ACP prompt's `stopReason` answer.
pub fn ends_turn(line: &str) -> bool {
    let line = line.trim_start();
    line.starts_with("{\"type\":\"result\"")
        || line.contains("\"method\":\"turn/completed\"")
        || line.contains("\"stopReason\"")
}

impl ProcessRun {
    pub fn new(session_id: String, pid: u32, cwd: String, at: u64) -> Self {
        Self {
            session_id,
            pid,
            cwd,
            start: at,
            end: None,
            turns: Vec::new(),
        }
    }

    fn open_turn(&self) -> bool {
        self.turns.last().is_some_and(|turn| turn.end.is_none())
    }

    pub fn input(&mut self, line: &str, at: u64) {
        if self.end.is_some() || self.open_turn() || !starts_turn(line) {
            return;
        }
        self.turns.push(Turn {
            start: at,
            end: None,
        });
        if self.turns.len() > MAX_TURNS {
            let drop = self.turns.len() - MAX_TURNS;
            self.turns.drain(..drop);
        }
    }

    pub fn output(&mut self, line: &str, at: u64) {
        if !ends_turn(line) {
            return;
        }
        if let Some(turn) = self.turns.last_mut().filter(|turn| turn.end.is_none()) {
            turn.end = Some(at);
        }
    }

    pub fn exited(&mut self, at: u64) {
        if self.end.is_none() {
            self.end = Some(at);
        }
        if let Some(turn) = self.turns.last_mut().filter(|turn| turn.end.is_none()) {
            turn.end = Some(at);
        }
    }
}

#[derive(Default)]
pub struct RunLedger {
    runs: Mutex<VecDeque<RunHandle>>,
}

impl RunLedger {
    pub fn start(&self, session_id: &str, pid: u32, cwd: &str) -> RunHandle {
        let run = Arc::new(Mutex::new(ProcessRun::new(
            session_id.to_string(),
            pid,
            cwd.to_string(),
            now_ms(),
        )));
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        runs.push_back(run.clone());
        while runs.len() > MAX_RUNS {
            // Oldest finished run first; a live one is never dropped while a finished one is left.
            let finished = runs
                .iter()
                .position(|r| r.lock().unwrap_or_else(|e| e.into_inner()).end.is_some());
            match finished {
                Some(i) => {
                    runs.remove(i);
                }
                None => {
                    runs.pop_front();
                }
            }
        }
        run
    }

    /// Every run that was alive at or after `since` (ms since the epoch).
    pub fn since(&self, since: u64) -> Vec<ProcessRun> {
        self.runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|r| r.lock().unwrap_or_else(|e| e.into_inner()).clone())
            .filter(|r| r.end.is_none_or(|end| end >= since))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = r#"{"type":"user","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#;
    const RESULT: &str = r#"{"type":"result","subtype":"success","is_error":false}"#;

    #[test]
    fn a_claude_turn_opens_on_the_user_message_and_closes_on_result() {
        let mut run = ProcessRun::new("s".into(), 1, "/p".into(), 100);
        run.output(r#"{"type":"system","subtype":"init"}"#, 101);
        assert!(run.turns.is_empty(), "output before a message is no turn");
        run.input(
            r#"{"type":"control_request","request":{"subtype":"interrupt"}}"#,
            102,
        );
        assert!(run.turns.is_empty(), "a control message is no turn");
        run.input(USER, 110);
        run.output(r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"{\"type\":\"result\"}"}]}}"#, 120);
        assert_eq!(
            run.turns,
            vec![Turn {
                start: 110,
                end: None
            }],
            "a tool result is not the turn's end"
        );
        run.output(RESULT, 140);
        assert_eq!(
            run.turns,
            vec![Turn {
                start: 110,
                end: Some(140)
            }]
        );
        assert_eq!(run.end, None, "the process lives on between turns");
    }

    #[test]
    fn a_process_that_exits_mid_turn_ends_its_turn_there() {
        let mut run = ProcessRun::new("s".into(), 1, "/p".into(), 100);
        run.input(USER, 110);
        run.exited(30_110);
        assert_eq!(run.end, Some(30_110));
        assert_eq!(
            run.turns,
            vec![Turn {
                start: 110,
                end: Some(30_110)
            }]
        );
        run.input(USER, 40_000);
        assert_eq!(run.turns.len(), 1, "no turn after exit");
    }

    #[test]
    fn codex_and_acp_turns_are_seen_too() {
        let mut codex = ProcessRun::new("c".into(), 2, "/p".into(), 0);
        codex.input(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            1,
        );
        assert!(codex.turns.is_empty());
        codex.input(
            r#"{"jsonrpc":"2.0","id":2,"method":"turn/start","params":{}}"#,
            5,
        );
        codex.output(
            r#"{"jsonrpc":"2.0","method":"turn/completed","params":{}}"#,
            9,
        );
        assert_eq!(
            codex.turns,
            vec![Turn {
                start: 5,
                end: Some(9)
            }]
        );
        let mut acp = ProcessRun::new("a".into(), 3, "/p".into(), 0);
        acp.input(
            r#"{"jsonrpc":"2.0","id":4,"method":"session/prompt","params":{}}"#,
            2,
        );
        acp.output(
            r#"{"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}"#,
            7,
        );
        assert_eq!(
            acp.turns,
            vec![Turn {
                start: 2,
                end: Some(7)
            }]
        );
    }

    #[test]
    fn the_ledger_lists_live_and_recent_runs_and_keeps_live_ones_when_full() {
        let ledger = RunLedger::default();
        let live = ledger.start("live", 9, "/p");
        for i in 0..MAX_RUNS + 5 {
            let run = ledger.start(&format!("s{i}"), i as u32, "/p");
            run.lock().unwrap().exited(now_ms());
        }
        let all = ledger.since(0);
        assert_eq!(all.len(), MAX_RUNS);
        assert!(all
            .iter()
            .any(|r| r.session_id == "live" && r.end.is_none()));
        live.lock().unwrap().exited(5);
        assert!(
            ledger.since(10).iter().all(|r| r.session_id != "live"),
            "ended before `since`"
        );
    }
}
