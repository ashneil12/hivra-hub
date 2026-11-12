use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use super::apply::{self, learn_apply};
use super::cursor::{self, ide_user_dir};
use super::events::LearnEvent;
use super::gate::{self, Limits, StandIn};
use super::grok;
use super::opencode;
use super::pi;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("learn_fixtures")
        .join(name)
}

struct Tmp(PathBuf);

impl Tmp {
    fn new(label: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "hivra-wp83-{}-{}-{}",
            label,
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        if self.0.starts_with(std::env::temp_dir()) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

fn messages(events: &[LearnEvent]) -> Vec<String> {
    events
        .iter()
        .filter(|event| event.kind == "message")
        .map(|event| {
            format!(
                "{}: {}",
                event.role.as_deref().unwrap_or(""),
                event.text.as_deref().unwrap_or("")
            )
        })
        .collect()
}

fn tools(events: &[LearnEvent]) -> Vec<&LearnEvent> {
    events.iter().filter(|event| event.kind == "tool").collect()
}

#[test]
fn pi_fixture_drops_thinking_and_folds_the_tool() {
    let text = fs::read_to_string(fixture("pi-session.jsonl")).unwrap();
    let descriptor = pi::classify_text(&text, false, "fallback").unwrap();
    assert_eq!(descriptor.id, "pi-1234");
    assert_eq!(descriptor.cwd, "/repo/demo");
    let (events, model) = pi::read_text(&text);
    assert_eq!(model.as_deref(), Some("gpt-5.6-sol"));
    assert!(!format!("{events:?}").contains("internal reasoning"));
    let call = tools(&events)[0];
    assert_eq!(call.name.as_deref(), Some("bash"));
    assert_eq!(call.result.as_deref(), Some("nothing to commit"));
}

#[test]
fn plain_pi_ignores_an_omp_model_field() {
    let text = "{\"type\":\"session\",\"id\":\"plain\",\"cwd\":\"/repo/demo\"}\n{\"type\":\"model_change\",\"model\":\"cursor/composer-2.5\"}\n";
    assert_eq!(pi::read_text(text).1, None);
}

#[test]
fn omp_fixture_reads_past_the_title_and_plain_pi_does_not() {
    let text = fs::read_to_string(fixture("omp-session.jsonl")).unwrap();
    assert!(pi::classify_text(&text, false, "fallback").is_none());
    let descriptor = pi::classify_text(&text, true, "fallback").unwrap();
    assert_eq!(descriptor.id, "omp-5678");
    assert_eq!(descriptor.cwd, "/repo/demo");
    let (events, model) = pi::read_text(&text);
    assert_eq!(model.as_deref(), Some("cursor/composer-2.5"));
    assert_eq!(
        tools(&events)[0].result.as_deref(),
        Some("nothing to commit")
    );
}

#[test]
fn a_session_on_line_three_is_not_a_header() {
    let title = r#"{"type":"title","v":1,"title":""}"#;
    let other = r#"{"type":"message","message":{"role":"user","content":"hello"}}"#;
    let session = r#"{"type":"session","id":"late","cwd":"/repo/demo"}"#;
    let after_title = format!("{title}\n{other}\n{session}\n");
    let after_other = format!("{other}\n{session}\n");
    assert!(pi::classify_text(&after_title, true, "fallback").is_none());
    assert!(pi::classify_text(&after_other, true, "fallback").is_none());
}

#[test]
fn grok_fixture_reads_remotes_and_the_tool_on_the_assistant() {
    let dir = fixture("grok-session")
        .join("%2Frepo%2Fdemo")
        .join("grok-9999");
    let descriptor = grok::classify_dir(&dir).unwrap();
    assert_eq!(descriptor.remotes, vec!["git@github.com:acme/demo.git"]);
    assert_eq!(descriptor.cwd, "/repo/demo");
    assert_eq!(descriptor.model.as_deref(), Some("grok-4.5"));
    assert_eq!(descriptor.id, "grok-9999");
    let text = fs::read_to_string(dir.join("chat_history.jsonl")).unwrap();
    let (events, model) = grok::read_text(&text);
    assert_eq!(model.as_deref(), Some("grok-4.5"));
    assert_eq!(
        messages(&events),
        vec![
            "user: Deploy the staging build.".to_string(),
            "assistant: Staging is live.".to_string()
        ]
    );
    let call = tools(&events)[0];
    assert_eq!(call.name.as_deref(), Some("run_terminal_command"));
    assert_eq!(
        call.input
            .as_ref()
            .and_then(|input| input.get("command"))
            .and_then(Value::as_str),
        Some("make deploy")
    );
    assert_eq!(call.result.as_deref(), Some("deployed to staging"));
    assert!(!format!("{events:?}").contains("OPAQUE"));
}

#[test]
fn cursor_directory_name_is_md5_of_the_cwd() {
    assert_eq!(
        cursor::cwd_hash("/Users/kunchen/.treehouse/sshhip-b697bb/9/sshhip"),
        "43ed8ea0825f9a5321fbe6d772769411"
    );
}

#[test]
fn cursor_cli_reads_json_blobs_and_skips_the_rest() {
    let tmp = Tmp::new("cursor");
    let dir = tmp.0.join("session");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("meta.json"),
        r#"{"cwd":"/repo/demo","title":"Ship"}"#,
    )
    .unwrap();
    let descriptor = cursor::classify_dir(&dir).unwrap();
    assert_eq!(descriptor.cwd, "/repo/demo");
    assert_eq!(descriptor.title.as_deref(), Some("Ship"));
    let db = dir.join("store.db");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)")
        .unwrap();
    conn.execute(
        "INSERT INTO blobs (id, data) VALUES (?1, ?2)",
        rusqlite::params!["a", br#"{"role":"user","content":"Open a PR."}"#],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO blobs (id, data) VALUES (?1, ?2)",
        rusqlite::params!["b", b"not-json"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO blobs (id, data) VALUES (?1, ?2)",
        rusqlite::params![
            "c",
            br#"{"role":"assistant","content":[{"text":"Opened."}]}"#
        ],
    )
    .unwrap();
    drop(conn);
    let events = cursor::read_db(&db).unwrap();
    assert_eq!(
        messages(&events),
        vec![
            "user: Open a PR.".to_string(),
            "assistant: Opened.".to_string()
        ]
    );
}

#[test]
fn cursor_ide_skips_a_composer_with_no_workspace() {
    let tmp = Tmp::new("cursor-ide");
    let user = tmp.0.join("User");
    fs::create_dir_all(user.join("globalStorage")).unwrap();
    fs::create_dir_all(user.join("workspaceStorage").join("ws-1")).unwrap();
    fs::write(
        user.join("workspaceStorage")
            .join("ws-1")
            .join("workspace.json"),
        r#"{"folder":"file:///repo/demo"}"#,
    )
    .unwrap();
    let db = user.join("globalStorage").join("state.vscdb");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT);
         CREATE TABLE cursorDiskKV (key TEXT, value TEXT);",
    )
    .unwrap();
    conn.execute("INSERT INTO composerHeaders VALUES ('keep', 'ws-1')", [])
        .unwrap();
    conn.execute("INSERT INTO composerHeaders VALUES ('drop', '')", [])
        .unwrap();
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES ('composerData:keep', '{\"createdAt\":5,\"lastUpdatedAt\":9}')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES ('bubbleId:keep:1', '{\"type\":1,\"text\":\"Ship the parser.\"}')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES ('bubbleId:keep:2', '{\"type\":2,\"text\":\"Done.\"}')",
        [],
    )
    .unwrap();
    drop(conn);
    let found = cursor::discover_ide(&user, None).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, "keep");
    assert_eq!(found[0].cwd, "/repo/demo");
    assert!(cursor::discover_ide(&user, Some(10)).unwrap().is_empty());
    let events = cursor::read_ide(&user, "keep").unwrap();
    assert_eq!(
        messages(&events),
        vec![
            "user: Ship the parser.".to_string(),
            "assistant: Done.".to_string()
        ]
    );
    assert!(cursor::discover_ide(&user.join("missing"), None)
        .unwrap()
        .is_empty());
}

fn load_fixture(name: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(fixture(name)).unwrap()).unwrap()
}

const V2_PARENT: &str = "ses_f17ca477affeM7vJpYuwLTunDK";
const V2_CHILD: &str = "ses_f17c42540ffeM0ZIydCm19byyr";
const V2_SELF: &str = "ses_f139e87ceffeqUsW26A55Cc7W1";
const V2_SELF_CHILD: &str = "ses_f139e880dffeSelfChildSess01";
const V2_RESUMED: &str = "ses_f0a1b2c3dffeResumedSession01";

fn ids_of(rows: &[opencode::OpenSession]) -> Vec<String> {
    let mut ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
    ids.sort();
    ids
}

#[test]
fn opencode_v2_fixture_lists_by_newest_message_and_marks_self() {
    let tmp = Tmp::new("oc-v2");
    let db = tmp.0.join("opencode.db");
    opencode::write_fixture(&db, &load_fixture("opencode-v2-store.json"), &[]).unwrap();
    let rows = opencode::discover(&db, None).unwrap();
    let mut expected = [V2_RESUMED, V2_SELF, V2_SELF_CHILD, V2_CHILD, V2_PARENT];
    expected.sort();
    assert_eq!(
        ids_of(&rows),
        expected
            .iter()
            .map(|id| (*id).to_string())
            .collect::<Vec<_>>()
    );
    assert!(rows
        .iter()
        .all(|row| row.id != "ses_f1378472bffeProbeEmptySess1"));
    let parent = rows.iter().find(|row| row.id == V2_PARENT).unwrap();
    assert_eq!(parent.cwd, "/repo/demo");
    assert_eq!(parent.git_root.as_deref(), Some("/repo/demo"));
    assert_eq!(parent.title.as_deref(), Some("Parser fix"));
    assert_eq!(parent.started_at, Some(1790600000000));
    assert_eq!(parent.mtime_ms, 1790600020800);
    assert_eq!(parent.layout, "v2");
    assert!(!parent.self_session);
    let child = rows.iter().find(|row| row.id == V2_CHILD).unwrap();
    assert_eq!(child.parent_id.as_deref(), Some(V2_PARENT));
    assert!(!child.self_session);
    assert!(
        rows.iter()
            .find(|row| row.id == V2_SELF)
            .unwrap()
            .self_session
    );
    assert!(
        rows.iter()
            .find(|row| row.id == V2_SELF_CHILD)
            .unwrap()
            .self_session
    );
    let resumed = opencode::discover(&db, Some(1790600100000)).unwrap();
    assert!(resumed.iter().any(|row| row.id == V2_RESUMED));
    assert!(resumed.iter().all(|row| row.id != V2_PARENT));
    assert!(opencode::discover(&db, Some(1790600300000))
        .unwrap()
        .is_empty());
}

#[test]
fn opencode_epoch_messages_are_still_recorded() {
    let tmp = Tmp::new("oc-epoch");
    let mut fixture = load_fixture("opencode-v2-store.json");
    for message in fixture["rows"]["session_message"].as_array_mut().unwrap() {
        message["time_updated"] = json!(0);
    }
    let db = tmp.0.join("opencode.db");
    opencode::write_fixture(&db, &fixture, &[]).unwrap();
    let rows = opencode::discover(&db, None).unwrap();
    let mut expected = [V2_RESUMED, V2_SELF, V2_SELF_CHILD, V2_CHILD, V2_PARENT];
    expected.sort();
    assert_eq!(
        ids_of(&rows),
        expected
            .iter()
            .map(|id| (*id).to_string())
            .collect::<Vec<_>>()
    );
}

#[test]
fn opencode_v2_read_keeps_turns_and_drops_harness_text() {
    let tmp = Tmp::new("oc-read");
    let db = tmp.0.join("opencode.db");
    opencode::write_fixture(&db, &load_fixture("opencode-v2-store.json"), &[]).unwrap();
    let read = opencode::read(&db, V2_PARENT, Some("v2")).unwrap();
    assert_eq!(read.model.as_deref(), Some("claude-opus-5.5"));
    assert_eq!(
        messages(&read.events),
        vec![
            "user: Open a PR for the parser fix.".to_string(),
            "assistant: I'll run the tests first.".to_string(),
            "assistant: Opened PR #2731.".to_string(),
            "user: Thanks, ship it.".to_string(),
            "assistant: Building the release.".to_string(),
            "assistant: The build failed; I will fix dist/ first.".to_string(),
        ]
    );
    let calls = tools(&read.events);
    assert_eq!(calls[0].name.as_deref(), Some("shell"));
    assert_eq!(calls[0].input.as_ref().unwrap()["command"], "npm test");
    assert_eq!(calls[0].input.as_ref().unwrap()["workdir"], "/repo/demo");
    assert_eq!(calls[0].status.as_deref(), Some("completed"));
    assert_eq!(calls[0].result.as_deref(), Some("2 passing"));
    assert_eq!(calls[1].name.as_deref(), Some("read"));
    assert!(calls[1]
        .result
        .as_deref()
        .unwrap()
        .contains("export function parse()"));
    assert_eq!(calls[2].name.as_deref(), Some("subagent"));
    assert_eq!(calls[2].input.as_ref().unwrap()["agent"], "general");
    assert_eq!(calls[2].input.as_ref().unwrap()["background"], true);
    assert!(calls[2]
        .result
        .as_deref()
        .unwrap()
        .contains("No blocking findings."));
    assert_eq!(calls[3].name.as_deref(), Some("edit"));
    assert_eq!(calls[3].status.as_deref(), Some("error"));
    assert_eq!(
        calls[3].result.as_deref(),
        Some("oldString not found in content")
    );
    assert_eq!(
        calls[4].input.as_ref().unwrap()["command"],
        "git status --short"
    );
    assert_eq!(calls[5].name.as_deref(), Some("skill"));
    assert_eq!(calls[5].input.as_ref().unwrap()["name"], "release");
    assert!(calls[5].result.is_none());
    assert_eq!(calls[6].input.as_ref().unwrap()["command"], "npm run build");
    assert_eq!(calls[6].status.as_deref(), Some("error"));
    assert!(calls[6]
        .result
        .as_deref()
        .unwrap()
        .contains("build failed: missing dist/"));
    let raw = format!("{:?}", read.events);
    for harness in [
        "Instructions from",
        "Today's date",
        "The previous response was interrupted",
        "The following shell command was executed by the user",
        "## Objective",
        "Tag from main only",
        "internal reasoning",
        "OPAQUE",
    ] {
        assert!(!raw.contains(harness), "{harness} is harness text");
    }
    let by_ref = opencode::read(&db, V2_PARENT, None).unwrap();
    assert_eq!(by_ref.events, read.events);
}

#[test]
fn opencode_v1_fixture_reads_the_old_layout() {
    let tmp = Tmp::new("oc-v1");
    let db = tmp.0.join("opencode.db");
    opencode::write_fixture(&db, &load_fixture("opencode-v1-store.json"), &[]).unwrap();
    let rows = opencode::discover(&db, None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "ses_f16e2d036ffeZd4lFcWRZCBMYV");
    assert_eq!(rows[0].layout, "v1");
    assert_eq!(rows[0].mtime_ms, 1790605324420);
    assert!(!rows[0].self_session);
    let read = opencode::read(&db, &rows[0].id, Some("v1")).unwrap();
    assert_eq!(read.model.as_deref(), Some("gpt-5.6-terra"));
    assert_eq!(
        messages(&read.events)
            .into_iter()
            .chain(Vec::new())
            .collect::<Vec<_>>(),
        vec![
            "user: Open a PR for the parser fix.".to_string(),
            "assistant: I'll run the tests first.".to_string(),
            "assistant: Opened PR #2731.".to_string(),
        ]
    );
    let order: Vec<String> = read
        .events
        .iter()
        .map(|event| {
            if event.kind == "message" {
                format!(
                    "{}: {}",
                    event.role.as_deref().unwrap_or(""),
                    event.text.as_deref().unwrap_or("")
                )
            } else {
                format!("tool {}", event.name.as_deref().unwrap_or(""))
            }
        })
        .collect();
    assert_eq!(
        order,
        vec![
            "user: Open a PR for the parser fix.".to_string(),
            "tool bash".to_string(),
            "assistant: I'll run the tests first.".to_string(),
            "assistant: Opened PR #2731.".to_string(),
        ]
    );
    let call = tools(&read.events)[0];
    assert_eq!(call.input.as_ref().unwrap()["command"], "npm test");
    assert_eq!(call.result.as_deref(), Some("2 passing\n"));
    assert!(!format!("{:?}", read.events).contains("internal reasoning"));
}

#[test]
fn an_upgraded_store_is_read_from_session_v2() {
    let tmp = Tmp::new("oc-up");
    let db = tmp.0.join("opencode.db");
    let v2 = load_fixture("opencode-v2-store.json");
    let v1 = load_fixture("opencode-v1-store.json");
    opencode::write_fixture(&db, &v2, &[]).unwrap();
    let project_id = v2["rows"]["project"][0]["id"].as_str().unwrap().to_string();
    let mut sessions = v1["rows"]["session"].as_array().unwrap().clone();
    for session in &mut sessions {
        session["project_id"] = json!(project_id);
    }
    let mut copy = sessions[0].clone();
    copy["id"] = json!(V2_PARENT);
    copy["title"] = json!("stale 1.x copy");
    sessions.push(copy);
    let leftover = json!({
        "schema": v1["schema"],
        "rows": { "session": sessions, "message": v1["rows"]["message"], "part": v1["rows"]["part"] }
    });
    opencode::write_fixture(&db, &leftover, &["project", "session_message"]).unwrap();
    let rows = opencode::discover(&db, None).unwrap();
    assert_eq!(rows.iter().filter(|row| row.id == V2_PARENT).count(), 1);
    let parent = rows.iter().find(|row| row.id == V2_PARENT).unwrap();
    assert_eq!(parent.layout, "v2");
    assert_eq!(parent.title.as_deref(), Some("Parser fix"));
    let v1_row = rows
        .iter()
        .find(|row| row.id == "ses_f16e2d036ffeZd4lFcWRZCBMYV")
        .unwrap();
    assert_eq!(v1_row.layout, "v1");
    let read = opencode::read(&db, V2_PARENT, Some(&parent.layout)).unwrap();
    assert_eq!(
        messages(&read.events)[0].as_str(),
        "user: Open a PR for the parser fix."
    );
}

#[test]
fn a_store_with_neither_session_table_is_not_read_as_empty() {
    let tmp = Tmp::new("oc-drift");
    let db = tmp.0.join("opencode.db");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE unrelated (id INTEGER)")
        .unwrap();
    drop(conn);
    let err = opencode::discover(&db, None).unwrap_err();
    assert!(err.contains("unrecognised opencode store"), "{err}");
}

#[test]
fn a_dev_copy_reads_only_named_stand_ins() {
    let home = Tmp::new("home");
    fs::create_dir_all(home.0.join(".claude").join("projects")).unwrap();
    fs::write(
        home.0.join(".claude").join("projects").join("real.jsonl"),
        "{}\n",
    )
    .unwrap();
    let limits = Limits {
        max_read: 1024,
        max_files: 20,
    };
    assert!(gate::list_stores(&home.0, None, false, true, limits)
        .unwrap()
        .is_empty());
    assert!(gate::list_stores(&home.0, Some(&[]), false, true, limits)
        .unwrap()
        .is_empty());
    let inside = StandIn {
        source: "claude".into(),
        root: home.0.join(".claude").to_string_lossy().into_owned(),
    };
    assert!(gate::list_stores(&home.0, Some(&[inside]), false, true, limits).is_err());
    let parent = StandIn {
        source: "pi".into(),
        root: home.0.to_string_lossy().into_owned(),
    };
    assert!(gate::list_stores(&home.0, Some(&[parent]), false, true, limits).is_err());
    let stand = Tmp::new("stand");
    fs::write(
        stand.0.join("chat.jsonl"),
        "{\"type\":\"session\",\"id\":\"s\",\"cwd\":\"/repo\"}\n",
    )
    .unwrap();
    let named = StandIn {
        source: "pi".into(),
        root: stand.0.to_string_lossy().into_owned(),
    };
    let listed = gate::list_stores(&home.0, Some(&[named]), false, true, limits).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, "chat");
    assert_eq!(
        listed[0].bytes,
        fs::metadata(stand.0.join("chat.jsonl")).unwrap().len()
    );
    let daily = gate::list_stores(&home.0, None, false, false, limits).unwrap();
    assert!(daily.iter().any(|chat| chat.source == "claude"));
    assert!(daily.iter().all(|chat| chat.source != "cursor-ide"));
}

#[test]
fn a_missing_daily_store_is_empty_not_an_error() {
    let home = Tmp::new("empty-home");
    let listed = gate::list_stores(&home.0, None, true, false, Limits::production()).unwrap();
    assert!(listed.is_empty());
    let _ = ide_user_dir(&home.0);
}

#[test]
fn listing_pi_skips_a_file_over_the_cap() {
    let home = Tmp::new("pi-list-home");
    let root = Tmp::new("pi-list");
    let mut body = String::from("{\"type\":\"session\",\"id\":\"big\",\"cwd\":\"/repo\"}\n");
    body.push_str(&"x".repeat(80));
    fs::write(root.0.join("big.jsonl"), body).unwrap();
    let listed = gate::list_stores(
        &home.0,
        Some(&[StandIn {
            source: "pi".into(),
            root: root.0.to_string_lossy().into_owned(),
        }]),
        false,
        true,
        Limits {
            max_read: 40,
            max_files: 10,
        },
    )
    .unwrap();
    assert!(
        listed.iter().all(|chat| chat.id != "big"),
        "a pi chat over the cap was listed: {listed:?}"
    );
}

#[test]
fn hermes_follows_the_active_profile() {
    let home = Tmp::new("hermes-profile");
    let root = home.0.join(".hermes");
    fs::create_dir_all(root.join("profiles").join("work")).unwrap();
    fs::write(root.join("active_profile"), "work\n").unwrap();
    fs::write(
        root.join("profiles").join("work").join("chat.jsonl"),
        "{}\n",
    )
    .unwrap();
    fs::write(root.join("other.jsonl"), "{}\n").unwrap();
    let listed = gate::list_stores(&home.0, None, false, false, Limits::production()).unwrap();
    let hermes: Vec<_> = listed
        .iter()
        .filter(|chat| chat.source == "hermes")
        .collect();
    assert_eq!(hermes.len(), 1, "{listed:?}");
    assert!(
        hermes[0].rel.ends_with("chat.jsonl"),
        "rel {}",
        hermes[0].rel
    );
}

#[test]
fn hermes_home_env_is_the_only_hermes_store() {
    let home = Tmp::new("hermes-env-home");
    let custom = Tmp::new("hermes-env");
    fs::write(custom.0.join("chat.jsonl"), "{}\n").unwrap();
    fs::create_dir_all(home.0.join(".hermes")).unwrap();
    fs::write(home.0.join(".hermes").join("ignored.jsonl"), "{}\n").unwrap();
    let listed = gate::list_located(
        &home.0,
        None,
        false,
        false,
        Limits::production(),
        &gate::StoreLocate {
            hermes_env: Some(custom.0.to_str().unwrap()),
            windows: false,
            local_app_data: None,
        },
    )
    .unwrap();
    let hermes: Vec<_> = listed
        .iter()
        .filter(|chat| chat.source == "hermes")
        .collect();
    assert_eq!(hermes.len(), 1, "{listed:?}");
    assert!(hermes[0].rel.ends_with("chat.jsonl"), "{}", hermes[0].rel);
    assert!(!hermes[0].root.contains(".hermes"));
}

#[test]
fn hermes_on_windows_uses_local_app_data() {
    let home = Tmp::new("hermes-win-home");
    let local = Tmp::new("hermes-local");
    fs::create_dir_all(local.0.join("hermes")).unwrap();
    fs::write(local.0.join("hermes").join("chat.jsonl"), "{}\n").unwrap();
    fs::create_dir_all(home.0.join(".hermes")).unwrap();
    fs::write(home.0.join(".hermes").join("nope.jsonl"), "{}\n").unwrap();
    let listed = gate::list_located(
        &home.0,
        None,
        false,
        false,
        Limits::production(),
        &gate::StoreLocate {
            hermes_env: None,
            windows: true,
            local_app_data: Some(local.0.to_str().unwrap()),
        },
    )
    .unwrap();
    let hermes: Vec<_> = listed
        .iter()
        .filter(|chat| chat.source == "hermes")
        .collect();
    assert_eq!(hermes.len(), 1, "{listed:?}");
    assert!(hermes[0].rel.ends_with("chat.jsonl"), "{}", hermes[0].rel);
    assert!(!hermes[0].root.contains(".hermes"));
}

#[test]
fn a_read_stays_inside_a_named_store() {
    let home = Tmp::new("read-home");
    let projects = home.0.join(".claude").join("projects");
    fs::create_dir_all(&projects).unwrap();
    fs::write(projects.join("real.jsonl"), "REAL CHAT\n").unwrap();
    fs::create_dir_all(home.0.join(".ssh")).unwrap();
    fs::write(home.0.join(".ssh").join("id_ed25519"), "PRIVATE KEY\n").unwrap();
    let locate = gate::StoreLocate::unix();
    let limits = Limits::production();
    let dev = gate::read_allowed(
        &home.0,
        "claude",
        &projects,
        "real.jsonl",
        None,
        true,
        limits,
        &locate,
    )
    .unwrap_err();
    assert!(dev.contains("stand-ins"), "{dev}");
    assert!(!dev.contains("REAL CHAT"));
    let ssh = gate::read_allowed(
        &home.0,
        "claude",
        &home.0,
        ".ssh/id_ed25519",
        None,
        false,
        limits,
        &locate,
    )
    .unwrap_err();
    assert!(ssh.contains("isn't one of the chat folders"), "{ssh}");
    assert!(!ssh.contains("PRIVATE KEY"));
    let parent = gate::read_allowed(
        &home.0,
        "claude",
        &home.0.join(".claude"),
        "projects/real.jsonl",
        None,
        false,
        limits,
        &locate,
    )
    .unwrap_err();
    assert!(parent.contains("isn't one of the chat folders"), "{parent}");
    assert!(!parent.contains("REAL CHAT"));
    let daily = gate::read_allowed(
        &home.0,
        "claude",
        &projects,
        "real.jsonl",
        None,
        false,
        limits,
        &locate,
    )
    .unwrap();
    assert!(daily.contains("REAL CHAT"), "{daily}");
    let stand = Tmp::new("read-stand");
    fs::write(
        stand.0.join("chat.jsonl"),
        "{\"type\":\"session\",\"id\":\"s\",\"cwd\":\"/repo\"}\n{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"stand-in hello\"}]}}\n",
    )
    .unwrap();
    let named = StandIn {
        source: "pi".into(),
        root: stand.0.to_string_lossy().into_owned(),
    };
    let read = gate::read_allowed(
        &home.0,
        "pi",
        &stand.0,
        "chat.jsonl",
        Some(&[named]),
        true,
        limits,
        &locate,
    )
    .unwrap();
    assert!(read.contains("stand-in hello"), "{read}");
}

#[test]
fn apply_inside_does_not_create_a_file_outside_the_learn_folder() {
    let learn = Tmp::new("learn-dir");
    let outside = Tmp::new("outside-note");
    let empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    let note = outside.0.join("note.md");
    let err = apply::apply_inside(&learn.0, &note, empty, "hello\n", "instruction").unwrap_err();
    assert!(err.contains("learn folder"), "{err}");
    assert!(!note.exists());
    let nested = learn.0.join("note.md");
    let err = apply::apply_inside(&learn.0, &nested, empty, "hello\n", "instruction").unwrap_err();
    assert!(err.contains("learn folder"), "{err}");
    assert!(!nested.exists());
    let agents = learn.0.join("AGENTS.md");
    assert!(apply::apply_inside(&learn.0, &agents, empty, "hello\n", "instruction").unwrap());
    assert_eq!(fs::read_to_string(&agents).unwrap(), "hello\n");
}

#[test]
fn a_corrupt_ledger_is_not_treated_as_empty() {
    let tmp = Tmp::new("corrupt-ledger");
    fs::write(tmp.0.join("state.json"), "{").unwrap();
    match apply::state_load(&tmp.0) {
        Err(err) => assert!(err.contains("saved lessons"), "{err}"),
        Ok(_) => panic!("a corrupt ledger loaded as empty"),
    }
    match apply::state_cas(&tmp.0, 0, json!({"rejections": {}})) {
        Err(err) => assert!(err.contains("saved lessons"), "{err}"),
        Ok(_) => panic!("a corrupt ledger was replaced"),
    }
    assert_eq!(fs::read_to_string(tmp.0.join("state.json")).unwrap(), "{");
}

#[cfg(unix)]
#[test]
fn cursor_ide_does_not_follow_a_symlink() {
    let outside = Tmp::new("cursor-outside");
    let user = outside.0.join("User");
    write_ide_db(&user);
    let linked = Tmp::new("cursor-linked");
    let linked_user = linked.0.join("User");
    fs::create_dir_all(linked_user.join("globalStorage")).unwrap();
    fs::create_dir_all(linked_user.join("workspaceStorage").join("ws-1")).unwrap();
    fs::write(
        linked_user
            .join("workspaceStorage")
            .join("ws-1")
            .join("workspace.json"),
        r#"{"folder":"file:///repo/demo"}"#,
    )
    .unwrap();
    std::os::unix::fs::symlink(
        user.join("globalStorage").join("state.vscdb"),
        linked_user.join("globalStorage").join("state.vscdb"),
    )
    .unwrap();
    match cursor::discover_ide(&linked_user, None) {
        Err(err) => assert!(
            err.contains("isn't in the folder") || err.contains("link"),
            "{err}"
        ),
        Ok(found) => panic!("a symlinked Cursor database was opened: {found:?}"),
    }
    match gate::read_store("cursor-ide", &linked_user, "keep", Limits::production()) {
        Err(err) => assert!(
            err.contains("isn't in the folder") || err.contains("link"),
            "{err}"
        ),
        Ok(text) => panic!("a symlinked Cursor database was read: {text}"),
    }
}

#[test]
fn cursor_ide_refuses_a_database_over_the_cap() {
    let home = Tmp::new("cursor-cap-home");
    let user = ide_user_dir(&home.0);
    write_ide_db(&user);
    match gate::read_store(
        "cursor-ide",
        &user,
        "keep",
        Limits {
            max_read: 10,
            max_files: 5,
        },
    ) {
        Err(err) => assert!(err.contains("too big"), "{err}"),
        Ok(text) => panic!("a Cursor database over the cap was read: {text}"),
    }
    let listed = gate::list_stores(
        &home.0,
        None,
        true,
        false,
        Limits {
            max_read: 10,
            max_files: 5,
        },
    )
    .unwrap();
    assert!(listed.iter().all(|chat| chat.source != "cursor-ide"));
}

fn write_ide_db(user: &std::path::Path) {
    fs::create_dir_all(user.join("globalStorage")).unwrap();
    fs::create_dir_all(user.join("workspaceStorage").join("ws-1")).unwrap();
    fs::write(
        user.join("workspaceStorage")
            .join("ws-1")
            .join("workspace.json"),
        r#"{"folder":"file:///repo/demo"}"#,
    )
    .unwrap();
    let db = user.join("globalStorage").join("state.vscdb");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT);
         CREATE TABLE cursorDiskKV (key TEXT, value TEXT);",
    )
    .unwrap();
    conn.execute("INSERT INTO composerHeaders VALUES ('keep', 'ws-1')", [])
        .unwrap();
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES ('composerData:keep', '{\"createdAt\":5,\"lastUpdatedAt\":9}')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES ('bubbleId:keep:1', '{\"type\":1,\"text\":\"Ship the parser.\"}')",
        [],
    )
    .unwrap();
}

#[test]
fn a_file_over_the_cap_is_refused() {
    let tmp = Tmp::new("cap");
    let file = tmp.0.join("big.jsonl");
    fs::write(&file, "x".repeat(50)).unwrap();
    let err = gate::read_store(
        "pi",
        &tmp.0,
        "big.jsonl",
        Limits {
            max_read: 10,
            max_files: 5,
        },
    )
    .unwrap_err();
    assert!(err.contains("too big"), "{err}");
}

#[test]
fn a_parent_segment_is_refused() {
    let tmp = Tmp::new("dotdot");
    let err = gate::read_store("pi", &tmp.0, "../secret.jsonl", Limits::production()).unwrap_err();
    assert!(err.contains("isn't in the folder"), "{err}");
}

#[cfg(unix)]
#[test]
fn a_symlink_is_not_followed() {
    let tmp = Tmp::new("link");
    let outside = Tmp::new("outside");
    fs::write(outside.0.join("secret.jsonl"), "secret\n").unwrap();
    std::os::unix::fs::symlink(outside.0.join("secret.jsonl"), tmp.0.join("secret.jsonl")).unwrap();
    let err = gate::read_store("pi", &tmp.0, "secret.jsonl", Limits::production()).unwrap_err();
    assert!(err.contains("isn't in the folder"), "{err}");
    std::os::unix::fs::symlink(&outside.0, tmp.0.join("linked-root")).unwrap();
    let stand = StandIn {
        source: "pi".into(),
        root: tmp.0.join("linked-root").to_string_lossy().into_owned(),
    };
    let home = Tmp::new("link-home");
    assert!(gate::list_stores(&home.0, Some(&[stand]), false, true, Limits::production()).is_err());
}

#[cfg(windows)]
#[test]
fn windows_refuses_a_parent_segment() {
    let tmp = Tmp::new("win-dot");
    let err = gate::read_store("pi", &tmp.0, "..\\secret.jsonl", Limits::production()).unwrap_err();
    assert!(err.contains("isn't in the folder"), "{err}");
}

#[test]
fn apply_refuses_a_plugin_and_a_hash_miss_is_not_final() {
    let tmp = Tmp::new("apply");
    let plugin = tmp
        .0
        .join("plugins")
        .join("installed")
        .join("pstack")
        .join("SKILL.md");
    fs::create_dir_all(plugin.parent().unwrap()).unwrap();
    fs::write(&plugin, "old").unwrap();
    let err = learn_apply(&plugin, &apply::sha256_hex(b"old"), "new", "skill").unwrap_err();
    assert!(err.contains("plugin"), "{err}");
    assert_eq!(fs::read_to_string(&plugin).unwrap(), "old");

    let file = tmp.0.join("AGENTS.md");
    fs::write(&file, "hello").unwrap();
    assert!(!learn_apply(&file, "deadbeef", "hello!", "instruction").unwrap());
    assert_eq!(fs::read_to_string(&file).unwrap(), "hello");
    assert!(learn_apply(&file, &apply::sha256_hex(b"hello"), "hello!", "instruction").unwrap());
    assert_eq!(fs::read_to_string(&file).unwrap(), "hello!");
}

#[test]
fn apply_refuses_growth_over_the_cap_and_allows_a_shrink() {
    let tmp = Tmp::new("budget");
    let file = tmp.0.join("AGENTS.md");
    let current = "a".repeat(20);
    fs::write(&file, &current).unwrap();
    let hash = apply::sha256_hex(current.as_bytes());
    let over = "b".repeat(2000 * 4 + 8);
    let err = learn_apply(&file, &hash, &over, "instruction").unwrap_err();
    assert!(err.contains("remove or merge"), "{err}");
    let big = "c".repeat(2000 * 4 + 8);
    fs::write(&file, &big).unwrap();
    let hash = apply::sha256_hex(big.as_bytes());
    let same = big.clone();
    assert!(learn_apply(&file, &hash, &same, "instruction").is_err());
    let smaller = "d".repeat(100);
    assert!(learn_apply(&file, &hash, &smaller, "instruction").unwrap());
    assert_eq!(fs::read_to_string(&file).unwrap(), smaller);
}

#[test]
fn state_cas_rejects_a_stale_revision() {
    let tmp = Tmp::new("state");
    assert!(apply::state_cas(&tmp.0, 0, json!({"weekly": false})).unwrap());
    assert!(!apply::state_cas(&tmp.0, 0, json!({"weekly": true})).unwrap());
    let loaded = apply::state_load(&tmp.0).unwrap();
    assert_eq!(loaded.revision, 1);
    assert_eq!(loaded.state["weekly"], false);
    assert!(apply::state_cas(&tmp.0, 1, json!({"weekly": true})).unwrap());
}

#[test]
fn profile_files_stay_in_the_learn_folder() {
    let tmp = Tmp::new("profile");
    let loaded = apply::profile_load(&tmp.0).unwrap();
    assert_eq!(loaded.opinions, "");
    assert_eq!(loaded.opinions_sha256, apply::sha256_hex(b""));
    assert!(apply::profile_save(&tmp.0, "nope", &loaded.opinions_sha256, "x").is_err());
    assert!(!apply::profile_save(&tmp.0, "opinions", "deadbeef", "# Opinions\n").unwrap());
    assert!(
        apply::profile_save(&tmp.0, "opinions", &loaded.opinions_sha256, "# Opinions\n").unwrap()
    );
    let again = apply::profile_load(&tmp.0).unwrap();
    assert_eq!(again.opinions, "# Opinions\n");
    assert!(!apply::profile_save(
        &tmp.0,
        "opinions",
        &loaded.opinions_sha256,
        "# Opinions\n\n"
    )
    .unwrap());
    assert_eq!(
        fs::read_to_string(tmp.0.join("opinions.md")).unwrap(),
        "# Opinions\n"
    );
    let over = "o".repeat(1500 * 4 + 8);
    let err = apply::profile_save(&tmp.0, "opinions", &again.opinions_sha256, &over).unwrap_err();
    assert!(err.contains("remove or merge"), "{err}");
}

fn set_mtime(path: &std::path::Path, secs: u64) {
    let file = fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs))
        .unwrap();
}

fn claude_stand_in(root: &std::path::Path) -> StandIn {
    StandIn {
        source: "claude".into(),
        root: root.to_string_lossy().into_owned(),
    }
}

#[test]
fn a_capped_listing_keeps_the_newest_and_says_how_many_were_left_out() {
    let home = Tmp::new("newest-home");
    let root = Tmp::new("newest");
    // Names sort the opposite way to age: "a" is the newest, "f" the oldest.
    for (index, name) in ["a", "b", "c", "d", "e", "f"].iter().enumerate() {
        let dir = root.0.join(format!("proj-{}", index % 2));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{name}.jsonl"));
        fs::write(&file, "{}\n").unwrap();
        set_mtime(&file, 10_000 - index as u64 * 100);
    }
    let found = gate::list_report(
        &home.0,
        Some(&[claude_stand_in(&root.0)]),
        false,
        true,
        Limits {
            max_read: 1024,
            max_files: 4,
        },
        &gate::StoreLocate::unix(),
    )
    .unwrap();
    let ids: Vec<&str> = found.chats.iter().map(|chat| chat.id.as_str()).collect();
    assert_eq!(ids, ["a", "b", "c", "d"], "{found:?}");
    assert_eq!(found.left_out, 2);
    assert_eq!(found.too_big, 0);
}

#[test]
fn newest_files_win_even_when_their_names_sort_last() {
    let home = Tmp::new("newest-late-home");
    let root = Tmp::new("newest-late");
    for (index, name) in ["a", "b", "c", "z"].iter().enumerate() {
        let file = root.0.join(format!("{name}.jsonl"));
        fs::write(&file, "{}\n").unwrap();
        set_mtime(&file, 1_000 + index as u64 * 10);
    }
    let found = gate::list_report(
        &home.0,
        Some(&[claude_stand_in(&root.0)]),
        false,
        true,
        Limits {
            max_read: 1024,
            max_files: 2,
        },
        &gate::StoreLocate::unix(),
    )
    .unwrap();
    let ids: Vec<&str> = found.chats.iter().map(|chat| chat.id.as_str()).collect();
    assert_eq!(ids, ["z", "c"]);
    assert_eq!(found.left_out, 2);
}

#[test]
fn one_file_over_the_read_cap_is_counted_and_never_fails_the_listing() {
    let home = Tmp::new("big-home");
    let root = Tmp::new("big");
    fs::write(root.0.join("small.jsonl"), "{}\n").unwrap();
    fs::write(root.0.join("huge.jsonl"), "x".repeat(200)).unwrap();
    let found = gate::list_report(
        &home.0,
        Some(&[claude_stand_in(&root.0)]),
        false,
        true,
        Limits {
            max_read: 50,
            max_files: 10,
        },
        &gate::StoreLocate::unix(),
    )
    .unwrap();
    let ids: Vec<&str> = found.chats.iter().map(|chat| chat.id.as_str()).collect();
    assert_eq!(ids, ["small"]);
    assert_eq!(found.too_big, 1);
    assert_eq!(found.left_out, 0);
}
