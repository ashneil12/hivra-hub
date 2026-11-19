use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use super::*;

struct Tmp(PathBuf);

impl Tmp {
    fn new(label: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "hivra-chat-import-{}-{}-{}",
            label,
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(crate::fs::canonical(&path).unwrap())
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const CLAUDE: &str = r#"{"type":"summary","summary":"Fix the login page"}
{"type":"user","sessionId":"s-1","cwd":"/work/app","timestamp":"2026-01-03T10:00:00Z","entrypoint":"cli","message":{"role":"user","content":"Please fix the login"}}
{"type":"assistant","sessionId":"s-1","cwd":"/work/app","timestamp":"2026-01-03T10:01:00Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"THINKING_NOISE"},{"type":"text","text":"Done."},{"type":"tool_use","name":"bash","input":{"command":"TOOL_NOISE"}}]}}
{"type":"user","sessionId":"s-1","cwd":"/work/app","timestamp":"2026-01-03T10:02:00Z","toolUseResult":"TOOL_NOISE","message":{"role":"user","content":[{"type":"tool_result","content":"TOOL_NOISE"}]}}
"#;

const CODEX: &str = r#"{"type":"session_meta","timestamp":"2026-02-01T00:00:00Z","payload":{"id":"codex-1","cwd":"/work/hub","base_instructions":{"text":"HUGE_INSTRUCTIONS"}}}
{"type":"event_msg","timestamp":"2026-02-01T00:01:00Z","payload":{"type":"user_message","message":"Always write the test first"}}
{"type":"response_item","timestamp":"2026-02-01T00:02:00Z","payload":{"type":"function_call_output","output":"TOOL_NOISE"}}
{"type":"event_msg","timestamp":"2026-02-01T00:04:00Z","payload":{"type":"agent_message","phase":"final_answer","message":"Tests go first."}}
"#;

fn old() -> SystemTime {
    SystemTime::now() + Duration::from_secs(3600)
}

#[test]
fn the_index_has_no_file_cap_pages_newest_first_and_reads_only_the_header() {
    let tmp = Tmp::new("index");
    let dir = tmp.0.join("-work-app");
    fs::create_dir_all(&dir).unwrap();
    for n in 0..30 {
        fs::write(dir.join(format!("chat-{n:02}.jsonl")), CLAUDE).unwrap();
    }
    let first = index_root(
        &tmp.0,
        "claude_code",
        0,
        25,
        old(),
        Duration::from_secs(300),
    );
    assert_eq!(first.total, 30);
    assert_eq!(first.chats.len(), 25);
    assert!(!first.done);
    let rest = index_root(
        &tmp.0,
        "claude_code",
        25,
        25,
        old(),
        Duration::from_secs(300),
    );
    assert_eq!(rest.chats.len(), 5);
    assert!(rest.done);
    let chat = &first.chats[0];
    assert_eq!(chat.cwd.as_deref(), Some("/work/app"));
    assert_eq!(chat.session_id.as_deref(), Some("s-1"));
    assert_eq!(chat.title.as_deref(), Some("Fix the login page"));
    assert_eq!(chat.first_ms, Some(1_767_434_400_000));
    let json = serde_json::to_string(&first).unwrap();
    assert!(
        !json.contains("Please fix the login"),
        "the index carries no message text"
    );
}

#[test]
fn the_index_leaves_out_side_traces_symlinks_and_chats_still_being_written() {
    let tmp = Tmp::new("leftouts");
    let dir = tmp.0.join("-work-app");
    fs::create_dir_all(dir.join("s-1").join("subagents")).unwrap();
    fs::write(
        dir.join("s-1").join("subagents").join("agent-1.jsonl"),
        CLAUDE,
    )
    .unwrap();
    fs::write(dir.join("live.jsonl"), CLAUDE).unwrap();
    let outside = Tmp::new("outside");
    fs::write(outside.0.join("secret.jsonl"), CLAUDE).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.0.join("secret.jsonl"), dir.join("link.jsonl")).unwrap();
    let page = index_root(
        &tmp.0,
        "claude_code",
        0,
        100,
        SystemTime::now(),
        Duration::from_secs(300),
    );
    assert_eq!(page.side, 1);
    assert_eq!(page.active, 1);
    #[cfg(unix)]
    assert_eq!(page.links, 1);
    assert!(page.chats.is_empty());
}

#[test]
fn a_missing_store_is_missing_not_an_error() {
    let tmp = Tmp::new("missing");
    let page = index_root(
        &tmp.0.join("nope"),
        "codex",
        0,
        10,
        old(),
        Duration::from_secs(300),
    );
    assert!(page.missing && page.done);
}

#[test]
fn a_claude_read_keeps_only_prose_and_the_folder() {
    let tmp = Tmp::new("claude");
    fs::write(tmp.0.join("a.jsonl"), CLAUDE).unwrap();
    let read = read_prose(&tmp.0.join("a.jsonl"), "claude_code").unwrap();
    assert!(read.text.contains("Please fix the login"));
    assert!(read.text.contains("Done."));
    assert!(read.text.contains("/work/app"));
    assert!(!read.text.contains("TOOL_NOISE"));
    assert!(!read.text.contains("THINKING_NOISE"));
    assert!(!read.cut);
}

#[test]
fn a_codex_read_keeps_only_the_meta_and_the_messages() {
    let tmp = Tmp::new("codex");
    fs::write(tmp.0.join("b.jsonl"), CODEX).unwrap();
    let read = read_prose(&tmp.0.join("b.jsonl"), "codex").unwrap();
    assert!(read.text.contains("Always write the test first"));
    assert!(read.text.contains("Tests go first."));
    assert!(read.text.contains("codex-1"));
    assert!(!read.text.contains("HUGE_INSTRUCTIONS"));
    assert!(!read.text.contains("TOOL_NOISE"));
    let header = header_of("codex", &tmp.0.join("b.jsonl"));
    assert_eq!(header.0.as_deref(), Some("/work/hub"));
    assert_eq!(header.1.as_deref(), Some("codex-1"));
}

#[test]
fn a_huge_line_is_skipped_without_holding_it_and_the_rest_still_reads() {
    let tmp = Tmp::new("huge");
    let big = "x".repeat(LINE_CAP + 10);
    let text = format!(
        "{{\"type\":\"user\",\"sessionId\":\"s\",\"timestamp\":\"2026-01-03T10:00:00Z\",\"message\":{{\"role\":\"user\",\"content\":\"{big}\"}}}}\n{}",
        CLAUDE
    );
    fs::write(tmp.0.join("c.jsonl"), text).unwrap();
    let read = read_prose(&tmp.0.join("c.jsonl"), "claude_code").unwrap();
    assert_eq!(read.long_lines, 1);
    assert!(read.text.contains("Please fix the login"));
    assert!(read.text.len() < 10_000);
}

#[test]
fn a_file_outside_the_root_or_through_a_link_is_refused() {
    let tmp = Tmp::new("checked");
    fs::write(tmp.0.join("ok.jsonl"), CLAUDE).unwrap();
    assert!(checked_file(&tmp.0, "ok.jsonl").is_ok());
    assert!(checked_file(&tmp.0, "../ok.jsonl").is_err());
    assert!(checked_file(&tmp.0, "/etc/passwd").is_err());
    assert!(checked_file(&tmp.0, "ok.txt").is_err());
    #[cfg(unix)]
    {
        let outside = Tmp::new("outside2");
        fs::write(outside.0.join("x.jsonl"), CLAUDE).unwrap();
        std::os::unix::fs::symlink(outside.0.join("x.jsonl"), tmp.0.join("link.jsonl")).unwrap();
        assert!(checked_file(&tmp.0, "link.jsonl").is_err());
    }
}

#[test]
fn a_worktree_names_its_main_checkout() {
    let tmp = Tmp::new("worktree");
    let repo = tmp.0.join("repo");
    fs::create_dir_all(repo.join(".git").join("worktrees").join("wt")).unwrap();
    let wt = tmp.0.join("wt");
    fs::create_dir_all(&wt).unwrap();
    fs::write(
        wt.join(".git"),
        format!(
            "gitdir: {}\n",
            repo.join(".git").join("worktrees").join("wt").display()
        ),
    )
    .unwrap();
    let info = folder_info(&wt.to_string_lossy());
    assert!(info.exists);
    assert_eq!(
        info.repo_root.as_deref(),
        Some(crate::fs::path_to_js(&repo).as_str())
    );
    let main = folder_info(&repo.to_string_lossy());
    assert_eq!(
        main.repo_root.as_deref(),
        Some(crate::fs::path_to_js(&repo).as_str())
    );
    let gone = folder_info(&tmp.0.join("gone").to_string_lossy());
    assert!(!gone.exists && gone.repo_root.is_none());
    assert!(!folder_info("relative/path").exists);
}
