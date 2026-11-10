use super::*;
use crate::session_store::SessionStore;

/// A throwaway folder, gone at the end of the test.
struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "monocode-portable-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self(crate::fs::canonical(dir).unwrap())
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// Planted on purpose: every one of these must never reach an export.
const ANTHROPIC: &str = "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ";
const GITHUB: &str = "ghp_PLANTED0123456789abcdefghijklmnopqrstu";
const PRIVATE_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAPLANTED\n-----END OPENSSH PRIVATE KEY-----";
const ASSIGNED: &str = "password = Planted9Secret9Value9X";
const PLANTED: [&str; 4] = [
    "sk-ant-api03-PLANTED",
    "ghp_PLANTED",
    "b3BlbnNzaC1rZXktdjEAAAAAPLANTED",
    "Planted9Secret9Value9X",
];

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn env_for(root: &Path) -> Env {
    Env {
        data_dir: root.join("data"),
        db_path: root.join("data/monocode.db"),
        memory_root: root.join("memory"),
        dev: false,
        protected: Vec::new(),
        claude_home: Some(root.join("claude")),
        home: Some(root.join("home")),
        // As on the daily app: the Monos home is a folder of the memory root.
        monos_root: root.join("memory/monos"),
    }
}

fn open_store(env: &Env) -> SessionStore {
    fs::create_dir_all(&env.data_dir).unwrap();
    SessionStore::open(env.db_path.clone()).unwrap()
}

/// An import with the session store already locked by the test.
fn import_held(
    env: &Env,
    conn: &Connection,
    request: &ImportRequest,
) -> Result<ImportReport, String> {
    import(env, request, || Ok(conn))
}

fn block(id: &str, role: &str, text: &str) -> Value {
    json!({"id": id, "role": role, "text": text})
}

fn add_session(
    conn: &Connection,
    id: &str,
    title: &str,
    harness: &str,
    blocks: Value,
    created: i64,
) {
    session_store::upsert_session(
        conn,
        &SessionUpsert {
            sidebar_hidden: false,
            id: id.into(),
            cwd: "/Users/someone/Projects/hivra".into(),
            harness: harness.into(),
            model: format!("{harness}-model"),
            model_settings: json!({"effort": "high"}),
            runtime_mode: "auto".into(),
            title: title.into(),
            provider_session_id: Some(format!("provider-{id}")),
            provider_account_id: None,
            blocks,
            queued_messages: Vec::new(),
            queue_status: None,
            context_used: Some(1200),
            context_window: Some(200_000),
            branch: Some("main".into()),
            worktree_cwd: None,
            worktree_removed: false,
            linked_work_item: None,
            automation_id: None,
            goal: None,
            private_chat: false,
            private_boundary_id: None,
        },
    )
    .unwrap();
    conn.execute(
        "UPDATE sessions SET created_at = ?2, updated_at = ?3, branch = 'main' WHERE id = ?1",
        params![id, created, created + 500],
    )
    .unwrap();
}

/// A source copy with something of everything, secrets planted throughout.
fn seed(env: &Env) {
    let store = open_store(env);
    let conn = store.lock_conn().unwrap();
    add_session(
        &conn,
        "chat-1",
        "Fix the login",
        "claude",
        json!([
            block("b1", "user", "Please fix the login"),
            block(
                "b2",
                "assistant",
                &format!("Found the key {ANTHROPIC} in .env; removed it.")
            )
        ]),
        1_000,
    );
    add_session(
        &conn,
        "chat-2",
        "Codex chat",
        "codex",
        json!([
            block("c1", "user", "hello"),
            block("c2", "assistant", PRIVATE_KEY)
        ]),
        2_000,
    );
    // A Mono's conversation lives in its own indexed transcript.
    add_session(
        &conn,
        "mono-chat",
        "Chief of Staff",
        "claude",
        json!([
            block("m1", "user", "Morning"),
            block("m2", "assistant", "Morning, Ash."),
            block("m3", "user", ASSIGNED)
        ]),
        3_000,
    );
    crate::mono_transcript::migrate_transcript(&conn, "mono-chat").unwrap();
    conn.execute(
        "UPDATE sessions SET archived = 1, pinned = 1 WHERE id = 'chat-2'",
        [],
    )
    .unwrap();
    // An empty draft chat is not worth exporting.
    add_session(&conn, "empty", "New chat", "claude", json!([]), 4_000);

    conn.execute(
        "INSERT INTO notes (id, slug, title, body, tags_json, source_session_id, source_cwd, slug_pending, created_at, updated_at, content_kind, artifact_kind)
         VALUES ('note-1', 'deploy-notes', 'Deploy notes', ?1, '[\"ops\"]', 'chat-1', '/x', 0, 10, 20, 'note', NULL),
                ('art-1', 'sales-chart', 'Sales chart', '<svg/>', '[]', NULL, NULL, 0, 11, 21, 'artifact', 'html')",
        [format!("Token is {GITHUB}\n![shot](note-assets/note-1/1-shot.png)")],
    )
    .unwrap();
    fs::create_dir_all(env.data_dir.join("note-assets/note-1")).unwrap();
    fs::write(
        env.data_dir.join("note-assets/note-1/1-shot.png"),
        [0x89, b'P', b'N', b'G', 1, 2, 3],
    )
    .unwrap();

    let automation = json!({"id": "auto-1", "name": "Morning digest", "prompt": "Summarise", "harness": "claude", "model": "m", "cwd": "/x", "enabled": true, "nextRunAt": 99_000, "updatedAt": 50});
    conn.execute(
        "INSERT INTO automations (id, definition_json, enabled, next_run_at, updated_at) VALUES ('auto-1', ?1, 1, 99000, 50)",
        [automation.to_string()],
    )
    .unwrap();
    let future = now_millis() + 86_400_000;
    conn.execute(
        "INSERT INTO session_reminders (session_id, due_at, fired_at) VALUES ('chat-1', ?1, NULL)",
        [future],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_reminders (session_id, due_at, fired_at) VALUES ('chat-2', 500, NULL)",
        [],
    )
    .unwrap();
    for (id, state, delivery) in [
        ("d-done", "completed", "acknowledged"),
        ("d-open", "running", "pending"),
    ] {
        conn.execute(
            "INSERT INTO delegations (id, owner_session, owner_mono, root_id, child_session, request_id, title, brief, state, delivery, created_at, updated_at, version, mirrored_version)
             VALUES (?1, 'mono-chat', 'cos', ?1, 'chat-1', ?1, 'Fix login', 'brief', ?2, ?3, 100, 200, 3, 3)",
            params![id, state, delivery],
        )
        .unwrap();
    }
    drop(conn);

    for (name, extra) in [("ash", "Ash files on Fridays."), ("hivra", "Canary first.")] {
        let dir = env.memory_root.join(name);
        fs::create_dir_all(dir.join("topics")).unwrap();
        fs::write(dir.join("MEMORY.md"), format!("# {name}\n- {extra}\n")).unwrap();
        fs::write(dir.join("decisions.md"), "- Keep it simple\n").unwrap();
        fs::write(dir.join("topics/deploy.md"), "Deploy notes\n").unwrap();
        // A hidden file in the history doesn't come back with it: an import restores notes, never anything a CLI reads
        // from a hidden file.
        fs::write(dir.join(".gitignore"), ".DS_Store\n").unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "memory"]);
    }
    // An uncommitted line with a secret: the file goes, scrubbed; the history (clean) goes too.
    fs::write(
        env.memory_root.join("hivra/never.md"),
        format!("- never paste {GITHUB}\n"),
    )
    .unwrap();
    // Not a memory folder (no MEMORY.md): the Ash OS ledger stays behind.
    fs::create_dir_all(env.memory_root.join("inbox/dumps")).unwrap();
    fs::write(env.memory_root.join("inbox/dumps/1.md"), "raw dump").unwrap();
}

fn setup_files() -> BTreeMap<String, String> {
    BTreeMap::from([
        (
            "setup/setup.json".to_string(),
            json!({"format": "monocode-hub-setup", "version": 2, "settings": {"monocode.theme": "dark", "monocode:custom-key": ANTHROPIC}, "connectors": [{"id": "c1", "name": "GitHub", "apiKey": "abcdefgh12345678"}]}).to_string(),
        ),
        ("setup/monos/cos/SOUL.md".to_string(), format!("# Chief of Staff\n\n## Role\nRuns the day\n\nOld note: {ASSIGNED}\n")),
        ("workspace/hub/group-chats.json".to_string(), json!([{"id": "g1", "messages": [{"text": GITHUB}]}]).to_string()),
    ])
}

fn export_request(dest: &Path, form: Form) -> ExportRequest {
    ExportRequest {
        destination: dest.to_string_lossy().into_owned(),
        form,
        files: setup_files(),
        memory: Some(MemoryChoice {
            projects: vec!["ash".into(), "hivra".into()],
            history: true,
        }),
        workspace: true,
        counts: Map::from_iter([("projects".to_string(), json!(4))]),
        app: json!({"version": "test"}),
    }
}

/// Every file of an export, unpacked when it is an archive.
fn export_texts(path: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                // Named the way the manifest and the archive name them: `/` on every platform.
                out.insert(
                    path.strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                    fs::read(&path).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    if path.is_dir() {
        walk(path, path, &mut out);
    } else {
        let scratch = unpack(path).unwrap();
        walk(&scratch.0, &scratch.0, &mut out);
    }
    out
}

fn assert_no_secrets(path: &Path) {
    let files = export_texts(path);
    assert!(!files.is_empty());
    for (name, bytes) in files {
        let text = String::from_utf8_lossy(&bytes);
        for planted in PLANTED {
            assert!(
                !text.contains(planted),
                "{name} carries a planted secret {planted}"
            );
        }
        if !name.ends_with(".bundle") && !name.contains("note-assets") {
            assert!(
                scrubber().findings(&text).is_empty(),
                "{name}: {:?}",
                scrubber().findings(&text)
            );
        }
    }
}

#[test]
fn the_shared_patterns_compile_and_scrub() {
    let s = scrubber();
    let (clean, n) = s.redact_text(&format!("a {ANTHROPIC} b {GITHUB} c {ASSIGNED} d\n{PRIVATE_KEY}\nAuthorization: Bearer abcDEF123456ghiJKL789xyz"));
    assert_eq!(n, 5, "{clean}");
    assert!(
        !clean.contains("PLANTED") && !clean.contains("abcDEF123456"),
        "{clean}"
    );
    assert!(
        clean.contains("password = [secret removed]"),
        "the key name stays readable: {clean}"
    );
    // Words that merely mention secrets are left alone.
    let (same, n) = s.redact_text(
        "tokens: 1200, the password field, secretName = my-secret-name, token = getToken()",
    );
    assert_eq!(
        (same.as_str(), n),
        (
            "tokens: 1200, the password field, secretName = my-secret-name, token = getToken()",
            0
        )
    );
    let mut value = json!({"apiKey": "plainlettersonly", "nested": [{"token": "abc"}, {"note": ANTHROPIC}], "input_tokens": 5});
    assert_eq!(s.redact_value(&mut value), 2);
    assert_eq!(value["apiKey"], "[secret removed]");
    assert_eq!(
        value["nested"][0]["token"], "abc",
        "too short to be a secret"
    );
    assert_eq!(value["input_tokens"], 5);
}

/// The acceptance test: export everything, import into an empty data folder, and get the same thing back, minus
/// the secrets (scrubbed), with automations paused and delegations as history.
#[test]
fn a_round_trip_into_an_empty_data_folder_brings_everything_back_minus_secrets() {
    for form in [Form::Folder, Form::Archive] {
        let source_dir = TestDir::new("source");
        let target_dir = TestDir::new("target");
        let out = TestDir::new("out");
        let source = env_for(&source_dir.0);
        let target = env_for(&target_dir.0);
        seed(&source);
        let dest = match form {
            Form::Folder => out.0.join("export"),
            Form::Archive => out.0.join("export.tar.gz"),
        };

        let report = export(&source, &export_request(&dest, form)).unwrap();
        assert_eq!(report.path, dest.to_string_lossy());
        assert!(report.secrets_removed >= 7, "{report:?}");
        assert_eq!(report.counts["sessions"], 3, "the empty draft stays behind");
        assert_eq!(report.counts["memoryProjects"], 2);
        assert_eq!(
            report.counts["projects"], 4,
            "the webview's counts are kept"
        );
        assert!(
            !report.counts.contains_key("noteIds"),
            "only counts in the manifest"
        );
        assert_no_secrets(&dest);
        let files = export_texts(&dest);
        let prefix = if form == Form::Archive { "export/" } else { "" };
        assert!(files.contains_key(&format!("{prefix}memory/hivra.git.bundle")));
        assert!(
            !files.keys().any(|k| k.contains("inbox")),
            "the ledger isn't memory"
        );
        assert!(!files.keys().any(|k| k.contains("empty.json")));

        // The preview: everything is new on an empty copy.
        let target_store = open_store(&target);
        let preview = inspect(&target, &dest.to_string_lossy()).unwrap();
        assert_eq!(preview.format, "v2");
        assert_eq!(preview.files.len(), 3);
        assert!(preview.files["setup/setup.json"].contains("[secret removed]"));
        let ws = preview.workspace.as_ref().unwrap();
        assert_eq!(ws.sessions.len(), 3);
        assert!(ws.sessions.iter().all(|s| s.status == Status::New));
        assert!(ws
            .sessions
            .iter()
            .any(|s| s.id == "mono-chat" && s.mono_transcript));
        assert_eq!(ws.notes.len(), 2);
        assert_eq!(preview.memory.len(), 2);
        assert!(preview.memory.iter().all(|m| !m.target_exists
            && m.history
            && m.files.iter().all(|f| f.status == Status::New)));

        let conn = target_store.lock_conn().unwrap();
        let imported = import_held(
            &target,
            &conn,
            &ImportRequest {
                path: dest.to_string_lossy().into_owned(),
                memory: Some(MemoryImport {
                    projects: vec!["ash".into(), "hivra".into()],
                    keep_both: false,
                    history: true,
                }),
                workspace: Some(WorkspaceImport {
                    sessions: ws.sessions.iter().map(|s| s.id.clone()).collect(),
                    session_copies: Vec::new(),
                    notes: ws.notes.iter().map(|n| n.id.clone()).collect(),
                    note_copies: Vec::new(),
                    automations: vec!["auto-1".into()],
                    reminders: true,
                    delegations: true,
                    known_folders: Vec::new(),
                    known_monos: Vec::new(),
                    folder_map: Vec::new(),
                }),
            },
        )
        .unwrap();
        assert_eq!(
            (
                imported.sessions_added,
                imported.notes_added,
                imported.automations_added
            ),
            (3, 2, 1),
            "{imported:?}"
        );
        assert_eq!(
            (imported.reminders_added, imported.delegations_added),
            (2, 2)
        );
        assert_eq!(
            imported.memory_history,
            vec!["ash".to_string(), "hivra".to_string()]
        );

        let source_store = SessionStore::open(source.db_path.clone()).unwrap();
        let source_conn = source_store.lock_conn().unwrap();
        // Chats: same rows, same transcripts, scrubbed.
        for id in ["chat-1", "chat-2", "mono-chat"] {
            let row = |c: &Connection| -> Value {
                c.query_row(
                    "SELECT title, cwd, harness, model, model_settings, runtime_mode, created_at, updated_at, archived, pinned, branch, context_used, context_window, blocks_json FROM sessions WHERE id = ?1",
                    [id],
                    |r| {
                        let blocks_json: String = r.get(13)?;
                        let (blocks, mono) = session_blocks(c, id, &blocks_json)?;
                        Ok(json!([r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, i64>(6)?, r.get::<_, i64>(7)?, r.get::<_, i64>(8)?, r.get::<_, i64>(9)?, r.get::<_, Option<String>>(10)?, r.get::<_, Option<i64>>(11)?, r.get::<_, Option<i64>>(12)?, blocks, mono]))
                    },
                )
                .unwrap()
            };
            // The source's folder isn't a project in this empty copy, so the chat comes in with none (folders.rs).
            let mut expected = scrubbed(&row(&source_conn));
            expected[1] = json!("");
            // A file never chooses how freely a chat runs.
            expected[5] = json!("supervised");
            assert_eq!(row(&conn), expected, "{id}");
        }
        // Provider transcripts aren't on this Mac, so the ids that would resume them are not kept.
        let kept: Option<String> = conn
            .query_row(
                "SELECT provider_session_id FROM sessions WHERE id = 'chat-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, None);

        // Notes and their pictures.
        for id in ["note-1", "art-1"] {
            let a = table_rows_where(&conn, "notes", id).unwrap().unwrap();
            let b = table_rows_where(&source_conn, "notes", id)
                .unwrap()
                .unwrap();
            assert_eq!(Value::Object(a), scrubbed(&Value::Object(b)), "{id}");
        }
        assert_eq!(
            fs::read(target.data_dir.join("note-assets/note-1/1-shot.png")).unwrap(),
            [0x89, b'P', b'N', b'G', 1, 2, 3]
        );

        // Automations come back paused, otherwise the same.
        let (definition, enabled): (String, i64) = conn
            .query_row(
                "SELECT definition_json, enabled FROM automations WHERE id = 'auto-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let definition: Value = serde_json::from_str(&definition).unwrap();
        assert_eq!(enabled, 0);
        assert_eq!(definition["enabled"], false);
        assert_eq!(
            without_enabled(&definition),
            without_enabled(
                // Its folder isn't a project in this empty copy, so it comes back with none (folders.rs).
                &json!({"id": "auto-1", "name": "Morning digest", "prompt": "Summarise", "harness": "claude", "model": "m", "cwd": "", "runtimeMode": "supervised"})
            )
        );

        // Reminders: the future one as it was; the overdue one comes back done instead of firing on arrival.
        let fired: Option<i64> = conn
            .query_row(
                "SELECT fired_at FROM session_reminders WHERE session_id = 'chat-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fired, None);
        let fired: Option<i64> = conn
            .query_row(
                "SELECT fired_at FROM session_reminders WHERE session_id = 'chat-2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(fired.is_some());

        // Delegations: history only, nothing left to run, report or copy to Ash OS.
        let done = table_rows_where(&conn, "delegations", "d-done")
            .unwrap()
            .unwrap();
        let mut expected = table_rows_where(&source_conn, "delegations", "d-done")
            .unwrap()
            .unwrap();
        expected.remove("mirror_error");
        let mut done_cmp = done.clone();
        done_cmp.remove("mirror_error");
        assert_eq!(done_cmp, expected);
        let open = table_rows_where(&conn, "delegations", "d-open")
            .unwrap()
            .unwrap();
        assert_eq!(
            (open["state"].as_str(), open["delivery"].as_str()),
            (Some("cancelled"), Some("disposed"))
        );
        assert_eq!(open["mirrored_version"], open["version"]);

        // Memory: the same files (scrubbed), and the history.
        for name in ["ash", "hivra"] {
            for (relative, _) in memory_files(&source.memory_root.join(name)) {
                let original =
                    fs::read_to_string(source.memory_root.join(name).join(&relative)).unwrap();
                let copy =
                    fs::read_to_string(target.memory_root.join(name).join(&relative)).unwrap();
                assert_eq!(
                    copy,
                    scrubber().redact_text(&original).0,
                    "{name}/{relative}"
                );
            }
            let log = Command::new("git")
                .arg("-C")
                .arg(target.memory_root.join(name))
                .args(["log", "--oneline"])
                .output()
                .unwrap();
            assert_eq!(
                String::from_utf8_lossy(&log.stdout).lines().count(),
                1,
                "{name}'s history came back"
            );
            assert!(!target.memory_root.join(name).join(".gitignore").exists());
            let status = Command::new("git")
                .arg("-C")
                .arg(target.memory_root.join(name))
                .args(["status", "--porcelain"])
                .output()
                .unwrap();
            // Nothing tracked is deleted or changed (files the import wrote itself are only untracked).
            assert!(
                String::from_utf8_lossy(&status.stdout)
                    .lines()
                    .all(|line| line.starts_with("??")),
                "{name}: the restored history is intact: {}",
                String::from_utf8_lossy(&status.stdout)
            );
            let remotes = Command::new("git")
                .arg("-C")
                .arg(target.memory_root.join(name))
                .arg("remote")
                .output()
                .unwrap();
            assert!(
                remotes.stdout.is_empty(),
                "no remote left pointing at a scratch bundle"
            );
        }
        assert!(!target.memory_root.join("inbox").exists());

        // A second import of the same export finds everything here already and changes nothing.
        let again = inspect(&target, &dest.to_string_lossy()).unwrap();
        let ws = again.workspace.unwrap();
        assert!(
            ws.sessions.iter().all(|s| s.status == Status::Same),
            "{:?}",
            ws.sessions
                .iter()
                .map(|s| (&s.id, s.status))
                .collect::<Vec<_>>()
        );
        assert!(ws.notes.iter().all(|n| n.status == Status::Same));
        assert!(again
            .memory
            .iter()
            .all(|m| m.files.iter().all(|f| f.status == Status::Same)));
    }
}

#[test]
fn an_import_never_overwrites_and_shows_each_conflict_first() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    seed(&source);
    let dest = out.0.join("export");
    export(&source, &export_request(&dest, Form::Folder)).unwrap();

    // The target already has its own chat-1, note-1 and memory file, all different.
    let store = open_store(&target);
    {
        let conn = store.lock_conn().unwrap();
        add_session(
            &conn,
            "chat-1",
            "My own chat",
            "claude",
            json!([block("x", "user", "mine")]),
            9_000,
        );
        conn.execute(
            "INSERT INTO notes (id, slug, title, body, tags_json, slug_pending, created_at, updated_at, content_kind) VALUES ('note-1', 'deploy-notes', 'Mine', 'my body', '[]', 0, 1, 1, 'note')",
            [],
        )
        .unwrap();
    }
    fs::create_dir_all(target.memory_root.join("ash")).unwrap();
    fs::write(target.memory_root.join("ash/MEMORY.md"), "# my own\n").unwrap();

    let preview = inspect(&target, &dest.to_string_lossy()).unwrap();
    let ws = preview.workspace.unwrap();
    let status = |id: &str| ws.sessions.iter().find(|s| s.id == id).unwrap().status;
    assert_eq!(
        (status("chat-1"), status("chat-2")),
        (Status::Differs, Status::New)
    );
    assert_eq!(
        ws.notes.iter().find(|n| n.id == "note-1").unwrap().status,
        Status::Differs
    );
    let ash = preview.memory.iter().find(|m| m.name == "ash").unwrap();
    assert!(ash.target_exists);
    assert_eq!(
        ash.files
            .iter()
            .find(|f| f.path == "MEMORY.md")
            .unwrap()
            .status,
        Status::Differs
    );
    assert_eq!(
        ash.files
            .iter()
            .find(|f| f.path == "decisions.md")
            .unwrap()
            .status,
        Status::New
    );

    let conn = store.lock_conn().unwrap();
    let request = |copies: bool| ImportRequest {
        path: dest.to_string_lossy().into_owned(),
        memory: Some(MemoryImport {
            projects: vec!["ash".into()],
            keep_both: copies,
            history: true,
        }),
        workspace: Some(WorkspaceImport {
            sessions: vec!["chat-1".into()],
            session_copies: if copies {
                vec!["chat-1".into()]
            } else {
                Vec::new()
            },
            notes: vec!["note-1".into()],
            note_copies: if copies {
                vec!["note-1".into()]
            } else {
                Vec::new()
            },
            ..Default::default()
        }),
    };
    // Without asking for copies: everything already here is kept as it is.
    let report = import_held(&target, &conn, &request(false)).unwrap();
    assert_eq!(
        (
            report.sessions_added,
            report.sessions_copied,
            report.notes_added,
            report.notes_copied
        ),
        (0, 0, 0, 0)
    );
    assert_eq!(report.kept, 3, "{report:?}");
    let title: String = conn
        .query_row("SELECT title FROM sessions WHERE id = 'chat-1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(title, "My own chat");
    assert_eq!(
        fs::read_to_string(target.memory_root.join("ash/MEMORY.md")).unwrap(),
        "# my own\n"
    );
    assert!(
        target.memory_root.join("ash/decisions.md").is_file(),
        "a new file still comes in"
    );
    assert!(
        !target.memory_root.join("ash/.git").exists(),
        "history only for a folder that wasn't here"
    );

    // Asking for copies: the file's versions come in beside, under new ids and names.
    let report = import_held(&target, &conn, &request(true)).unwrap();
    assert_eq!(
        (
            report.sessions_copied,
            report.notes_copied,
            report.memory_files_beside
        ),
        (1, 1, 1),
        "{report:?}"
    );
    let copy = &report.renamed["chat-1"];
    let title: String = conn
        .query_row("SELECT title FROM sessions WHERE id = ?1", [copy], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(title, "Fix the login (imported)");
    let note_copy = &report.renamed["note-1"];
    let (slug, body): (String, String) = conn
        .query_row(
            "SELECT slug, body FROM notes WHERE id = ?1",
            [note_copy],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(slug, "deploy-notes-2");
    assert!(body.contains(&format!("note-assets/{note_copy}/")));
    assert!(target
        .data_dir
        .join(format!("note-assets/{note_copy}/1-shot.png"))
        .is_file());
    assert_eq!(
        fs::read_to_string(target.memory_root.join("ash/MEMORY.md")).unwrap(),
        "# my own\n"
    );
    assert!(
        fs::read_to_string(target.memory_root.join("ash/MEMORY.imported.md"))
            .unwrap()
            .contains("Ash files on Fridays")
    );
    let title: String = conn
        .query_row("SELECT title FROM sessions WHERE id = 'chat-1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(title, "My own chat");
}

#[test]
fn the_ticks_decide_what_goes_in_and_what_comes_back() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    seed(&source);

    // Setup only: no memory, no workspace in the export at all.
    let dest = out.0.join("setup-only");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.workspace = false;
    request.files.remove("workspace/hub/group-chats.json");
    export(&source, &request).unwrap();
    let names: Vec<String> = export_texts(&dest).into_keys().collect();
    assert!(
        names
            .iter()
            .all(|n| n == "manifest.json" || n.starts_with("setup/")),
        "{names:?}"
    );
    let preview = inspect(&target, &dest.to_string_lossy()).unwrap();
    assert!(preview.workspace.is_none() && preview.memory.is_empty());

    // Memory for one project, without its history.
    let dest = out.0.join("one-memory");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = Some(MemoryChoice {
        projects: vec!["hivra".into()],
        history: false,
    });
    request.workspace = false;
    export(&source, &request).unwrap();
    let names: Vec<String> = export_texts(&dest).into_keys().collect();
    assert!(names.iter().any(|n| n.starts_with("memory/hivra/")));
    assert!(
        !names
            .iter()
            .any(|n| n.starts_with("memory/ash") || n.ends_with(".bundle")),
        "{names:?}"
    );

    // An import that leaves memory unticked writes no memory, even when the export has it.
    let dest = out.0.join("all");
    export(&source, &export_request(&dest, Form::Folder)).unwrap();
    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(
        &target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(WorkspaceImport {
                sessions: vec!["chat-2".into()],
                ..Default::default()
            }),
        },
    )
    .unwrap();
    assert_eq!(report.sessions_added, 1);
    assert!(!target.memory_root.exists());
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1, "only the ticked chat");
    let notes: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(notes, 0);
}

#[test]
fn a_dev_copy_never_writes_the_real_memory_or_keeps_provider_ids() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    seed(&source);
    // The provider transcript exists here, in the Claude project folder of this Mac's own project for the chat, so
    // the daily app would keep the id.
    let here_project = env_for(&target_dir.0).home.unwrap().join("Projects/hivra");
    fs::create_dir_all(&here_project).unwrap();
    let projects = source
        .claude_home
        .clone()
        .unwrap()
        .join("projects")
        .join(claude_project_dir_name(&here_project.to_string_lossy()));
    fs::create_dir_all(&projects).unwrap();
    fs::write(projects.join("provider-chat-1.jsonl"), "{}\n").unwrap();
    let dest = out.0.join("export");
    export(&source, &export_request(&dest, Form::Folder)).unwrap();
    let file: Value = serde_json::from_str(
        &fs::read_to_string(dest.join("workspace/sessions/chat-1.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        file["providerTranscript"]["providerSessionId"],
        "provider-chat-1"
    );
    assert!(file["providerTranscript"]["path"]
        .as_str()
        .unwrap()
        .ends_with("provider-chat-1.jsonl"));
    assert_eq!(
        file["engine"]["harness"], "claude",
        "each chat says which engine it ran on"
    );

    let workspace = WorkspaceImport {
        sessions: vec!["chat-1".into()],
        known_folders: vec![here_project.to_string_lossy().into_owned()],
        folder_map: vec![FolderMapping {
            project_id: "hivra".into(),
            from: "/Users/someone/Projects/hivra".into(),
            to: here_project.to_string_lossy().into_owned(),
        }],
        ..Default::default()
    };
    // The daily app, with the transcript on this Mac, keeps the id so the chat resumes.
    let mut daily = env_for(&target_dir.0);
    daily.claude_home = source.claude_home.clone();
    let store = open_store(&daily);
    {
        let conn = store.lock_conn().unwrap();
        import_held(
            &daily,
            &conn,
            &ImportRequest {
                path: dest.to_string_lossy().into_owned(),
                memory: None,
                workspace: Some(workspace.clone()),
            },
        )
        .unwrap();
        let kept: Option<String> = conn
            .query_row(
                "SELECT provider_session_id FROM sessions WHERE id = 'chat-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept.as_deref(), Some("provider-chat-1"));
    }

    // A dev copy: never the id, and never a write into a protected memory folder.
    let dev_dir = TestDir::new("dev");
    let mut dev = env_for(&dev_dir.0);
    dev.dev = true;
    dev.claude_home = source.claude_home.clone();
    dev.memory_root = source.memory_root.clone();
    dev.protected = vec![source.memory_root.clone()];
    let store = open_store(&dev);
    let conn = store.lock_conn().unwrap();
    import_held(
        &dev,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(workspace),
        },
    )
    .unwrap();
    let kept: Option<String> = conn
        .query_row(
            "SELECT provider_session_id FROM sessions WHERE id = 'chat-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(kept, None);
    let refused = import_held(
        &dev,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: Some(MemoryImport {
                projects: vec!["ash".into()],
                ..Default::default()
            }),
            workspace: None,
        },
    )
    .unwrap_err();
    assert!(refused.contains("never writes into"), "{refused}");
    // Nor an export into one.
    let refused = export(
        &dev,
        &export_request(&source.memory_root.join("ash/export"), Form::Folder),
    )
    .unwrap_err();
    assert!(refused.contains("never writes into"), "{refused}");
}

#[test]
fn history_with_a_secret_in_an_old_commit_stays_behind() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    seed(&source);
    let dir = source.memory_root.join("ash");
    fs::write(dir.join("tooling.md"), format!("key {ANTHROPIC}\n")).unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "oops"]);
    fs::write(dir.join("tooling.md"), "key moved to the Keychain\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "fix"]);

    let dest = out.0.join("export");
    let report = export(&source, &export_request(&dest, Form::Folder)).unwrap();
    assert!(!dest.join("memory/ash.git.bundle").exists());
    assert!(dest.join("memory/hivra.git.bundle").exists());
    assert!(
        report
            .notes
            .iter()
            .any(|n| n.contains("history of ash") && n.contains("secret")),
        "{:?}",
        report.notes
    );
    assert_no_secrets(&dest);
}

/// A memory folder whose history holds `notes -> <somewhere else>`, and an export of it that carries files under
/// `notes/`: restoring the history would check the link out and the files after it would be written through it.
#[cfg(unix)]
fn export_with_a_linked_memory_folder(source: &Env, outside: &Path, dest: &Path) {
    let dir = source.memory_root.join("evil");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("MEMORY.md"), "# evil\n").unwrap();
    std::os::unix::fs::symlink(outside, dir.join("notes")).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "a link out"]);
    // A real notes/ folder by the same name on disk, so the export lists files under it.
    fs::remove_file(dir.join("notes")).unwrap();
    fs::create_dir_all(dir.join("notes")).unwrap();
    fs::write(dir.join("notes/planted.md"), "planted\n").unwrap();
    fs::write(dir.join("notes/existing.md"), "theirs\n").unwrap();
    let mut request = export_request(dest, Form::Folder);
    request.files.clear();
    request.workspace = false;
    request.memory = Some(MemoryChoice {
        projects: vec!["evil".into()],
        history: true,
    });
    export(source, &request).unwrap();
    assert!(dest.join("memory/evil.git.bundle").is_file());
}

/// Everything in `dir`, as name → text.
#[cfg(unix)]
fn folder_texts(dir: &Path) -> BTreeMap<String, String> {
    fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| {
            (
                e.file_name().to_string_lossy().into_owned(),
                fs::read_to_string(e.path()).unwrap_or_default(),
            )
        })
        .collect()
}

#[cfg(unix)]
#[test]
fn memory_never_lands_outside_its_folder_through_a_link() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let outside = TestDir::new("outside");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    fs::write(outside.0.join("existing.md"), "mine\n").unwrap();
    let before = folder_texts(&outside.0);
    let dest = out.0.join("export");
    export_with_a_linked_memory_folder(&source, &outside.0, &dest);
    let request = |history: bool| ImportRequest {
        path: dest.to_string_lossy().into_owned(),
        memory: Some(MemoryImport {
            projects: vec!["evil".into()],
            keep_both: true,
            history,
        }),
        workspace: None,
    };

    // With history: the bundle's link is refused, said plainly, and the files come in as plain files inside.
    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(&target, &conn, &request(true)).unwrap();
    assert_eq!(folder_texts(&outside.0), before, "nothing outside changed");
    assert!(report.memory_history.is_empty(), "{report:?}");
    assert!(
        report
            .notes
            .iter()
            .any(|n| n.contains("history of evil") && n.contains("link")),
        "{:?}",
        report.notes
    );
    let notes = target.memory_root.join("evil/notes");
    assert!(!fs::symlink_metadata(&notes)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read_to_string(notes.join("planted.md")).unwrap(),
        "planted\n"
    );
    assert!(!target.memory_root.join("evil/.git").exists());

    // A link already in the memory folder here (left by anything): no write follows it, and each skip is said.
    fs::remove_dir_all(&notes).unwrap();
    std::os::unix::fs::symlink(&outside.0, &notes).unwrap();
    let report = import_held(&target, &conn, &request(true)).unwrap();
    assert_eq!(folder_texts(&outside.0), before, "nothing outside changed");
    assert_eq!(
        (report.memory_files_added, report.memory_files_beside),
        (0, 0),
        "{report:?}"
    );
    assert!(
        report
            .notes
            .iter()
            .any(|n| n.contains("notes/planted.md") && n.contains("outside")),
        "{:?}",
        report.notes
    );
}

#[test]
fn a_memory_restore_that_writes_a_monos_soul_names_it() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    // The Monos home, exported as a memory folder (it has a MEMORY.md of its own).
    let monos = source.memory_root.join("monos");
    fs::create_dir_all(monos.join("hivra-lead")).unwrap();
    fs::create_dir_all(monos.join("ed")).unwrap();
    fs::write(monos.join("MEMORY.md"), "# monos\n").unwrap();
    fs::write(monos.join("hivra-lead/SOUL.md"), "# Soul\n\n- restored\n").unwrap();
    fs::write(monos.join("ed/SOUL.md"), "# Soul\n\n- ed's\n").unwrap();
    fs::write(monos.join("ed/MEMORY.md"), "- a note\n").unwrap();
    let dest = out.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.files.clear();
    request.workspace = false;
    request.memory = Some(MemoryChoice {
        projects: vec!["monos".into()],
        history: false,
    });
    export(&source, &request).unwrap();
    // ed's soul is here already with his own text: kept (no write), so not named.
    fs::create_dir_all(target.monos_root.join("ed")).unwrap();
    fs::write(target.monos_root.join("ed/SOUL.md"), "# Soul\n\n- mine\n").unwrap();

    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let import = ImportRequest {
        path: dest.to_string_lossy().into_owned(),
        memory: Some(MemoryImport {
            projects: vec!["monos".into()],
            keep_both: false,
            history: false,
        }),
        workspace: None,
    };
    let report = import_held(&target, &conn, &import).unwrap();
    assert_eq!(
        fs::read_to_string(target.monos_root.join("hivra-lead/SOUL.md")).unwrap(),
        "# Soul\n\n- restored\n"
    );
    assert_eq!(
        report.souls_restored,
        vec!["hivra-lead".to_string()],
        "{report:?}"
    );
    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(json["soulsRestored"], serde_json::json!(["hivra-lead"]));
    // Again: nothing new is written, nothing named.
    let again = import_held(&target, &conn, &import).unwrap();
    assert!(again.souls_restored.is_empty(), "{again:?}");
}

/// Puts `bytes` at `relative` in a folder export and lists it in the manifest, as an export would.
fn put_in_export(dest: &Path, relative: &str, bytes: &[u8]) {
    fs::write(dest.join(relative), bytes).unwrap();
    let manifest_path = dest.join(MANIFEST);
    let mut manifest: Value =
        serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
    let files = manifest["files"].as_array_mut().unwrap();
    files.retain(|f| f["path"] != relative);
    files.push(json!({"path": relative, "bytes": bytes.len(), "sha256": sha256_hex(bytes)}));
    fs::write(&manifest_path, manifest.to_string()).unwrap();
}

#[test]
fn a_memory_file_that_isnt_text_is_skipped_never_written_empty() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    seed(&source);
    let dest = out.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.workspace = false;
    export(&source, &request).unwrap();
    // decisions.md comes back with the history; the file's own copy of it, and a new one, aren't UTF-8.
    let not_text = [0xff, 0xfe, b'x', 0xc3];
    put_in_export(&dest, "memory/ash/decisions.md", &not_text);
    put_in_export(&dest, "memory/ash/blob.md", &not_text);

    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(
        &target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: Some(MemoryImport {
                projects: vec!["ash".into()],
                keep_both: true,
                history: true,
            }),
            workspace: None,
        },
    )
    .unwrap();
    assert_eq!(report.memory_history, vec!["ash".to_string()]);
    assert_eq!(
        fs::read_to_string(target.memory_root.join("ash/decisions.md")).unwrap(),
        "- Keep it simple\n",
        "the history's text is kept, not replaced with nothing"
    );
    assert!(!target.memory_root.join("ash/blob.md").exists());
    for name in ["decisions.md", "blob.md"] {
        assert!(
            report
                .notes
                .iter()
                .any(|n| n.contains(&format!("memory/ash/{name}")) && n.contains("text")),
            "{:?}",
            report.notes
        );
    }
}

#[test]
fn a_workspace_import_that_fails_midway_leaves_nothing_half_in() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    seed(&source);
    let dest = out.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    export(&source, &request).unwrap();
    let request = ImportRequest {
        path: dest.to_string_lossy().into_owned(),
        memory: None,
        workspace: Some(WorkspaceImport {
            sessions: vec!["chat-1".into(), "chat-2".into(), "mono-chat".into()],
            notes: vec!["note-1".into(), "art-1".into()],
            automations: vec!["auto-1".into()],
            reminders: true,
            delegations: true,
            ..Default::default()
        }),
    };
    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    // The last step (delegations) fails, after notes, chats, automations and reminders went in.
    conn.execute_batch(
        "CREATE TRIGGER refuse_delegations BEFORE INSERT ON delegations BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    )
    .unwrap();
    let failed = import_held(&target, &conn, &request).unwrap_err();
    assert!(failed.contains("disk full"), "{failed}");
    let count = |table: &str| -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    };
    for table in [
        "notes",
        "sessions",
        "automations",
        "session_reminders",
        "delegations",
        "mono_transcripts",
    ] {
        assert_eq!(count(table), 0, "{table} is as it was");
    }
    assert!(
        !target.data_dir.join("note-assets/note-1").exists(),
        "no pictures for notes that didn't go in"
    );

    // The retry adds everything, and finds nothing of its own already here.
    conn.execute_batch("DROP TRIGGER refuse_delegations;")
        .unwrap();
    let report = import_held(&target, &conn, &request).unwrap();
    assert_eq!(
        (
            report.notes_added,
            report.sessions_added,
            report.automations_added,
            report.reminders_added,
            report.delegations_added,
            report.kept
        ),
        (2, 3, 1, 2, 2, 0),
        "{report:?}"
    );
    assert!(crate::mono_transcript::is_indexed(&conn, "mono-chat").unwrap());
    assert!(target
        .data_dir
        .join("note-assets/note-1/1-shot.png")
        .is_file());
}

/// Chat saves wait on the session store's lock: an import takes it only while the chats go in, never while it
/// unpacks, checks every file's hash or writes memory.
#[test]
fn the_session_store_is_locked_only_while_the_chats_go_in() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    seed(&source);
    let dest = out.0.join("export.tar.gz");
    export(&source, &export_request(&dest, Form::Archive)).unwrap();
    let store = open_store(&target);
    let memory = MemoryImport {
        projects: vec!["ash".into()],
        keep_both: false,
        history: true,
    };
    let never = || -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        panic!("the session store was locked")
    };

    // Memory only: the store is never locked.
    let report = import(
        &target,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: Some(memory.clone()),
            workspace: None,
        },
        never,
    )
    .unwrap();
    assert_eq!(report.memory_history, vec!["ash".to_string()]);

    // A damaged export is refused before the store is locked.
    let broken = out.0.join("broken.tar.gz");
    fs::write(&broken, [0x1f, 0x8b, 0, 0]).unwrap();
    assert!(import(
        &target,
        &ImportRequest {
            path: broken.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(WorkspaceImport::default()),
        },
        never,
    )
    .is_err());

    // With chats: locked once, after the export was opened and the memory written.
    fs::remove_dir_all(&target.memory_root).unwrap();
    let mut locked = 0;
    let report = import(
        &target,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: Some(memory),
            workspace: Some(WorkspaceImport {
                sessions: vec!["chat-1".into()],
                ..Default::default()
            }),
        },
        || {
            locked += 1;
            assert!(
                target.memory_root.join("ash/.git").is_dir()
                    && target.memory_root.join("ash/MEMORY.md").is_file(),
                "memory is written before the store is locked"
            );
            store.lock_conn()
        },
    )
    .unwrap();
    assert_eq!((locked, report.sessions_added), (1, 1));
}

#[test]
fn a_newer_or_damaged_export_is_refused_and_a_v1_file_is_recognised() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    seed(&source);
    let dest = out.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.workspace = false;
    request.memory = None;
    export(&source, &request).unwrap();

    let soul = dest.join("setup/monos/cos/SOUL.md");
    let original = fs::read_to_string(&soul).unwrap();
    fs::write(&soul, "changed").unwrap();
    let damaged = inspect(&source, &dest.to_string_lossy()).err().unwrap();
    assert!(damaged.contains("damaged or was changed"), "{damaged}");
    fs::write(&soul, original).unwrap();

    let manifest_path = dest.join(MANIFEST);
    let mut manifest: Value =
        serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
    manifest["version"] = json!(VERSION + 1);
    fs::write(&manifest_path, manifest.to_string()).unwrap();
    let newer = inspect(&source, &dest.to_string_lossy()).err().unwrap();
    assert!(newer.contains("newer MonoCode Hub"), "{newer}");

    let v1 = out.0.join("monocode-setup.json");
    fs::write(
        &v1,
        json!({"format": "monocode-hub-setup", "version": 1, "projects": []}).to_string(),
    )
    .unwrap();
    let preview = inspect(&source, &v1.to_string_lossy()).unwrap();
    assert_eq!(preview.format, "v1");
    assert!(preview.v1.unwrap().contains("monocode-hub-setup"));

    let other = out.0.join("other.json");
    fs::write(&other, "{\"hello\":1}").unwrap();
    assert!(inspect(&source, &other.to_string_lossy()).is_err());
}

#[test]
fn an_archive_that_climbs_out_of_itself_is_refused() {
    let out = TestDir::new("out");
    let path = out.0.join("evil.tar.gz");
    let file = fs::File::create(&path).unwrap();
    let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
        file,
        flate2::Compression::default(),
    ));
    let data = b"pwned";
    let mut header = tar::Header::new_gnu();
    {
        let name = &mut header.as_gnu_mut().unwrap().name;
        name[..12].copy_from_slice(b"../../escape");
    }
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_entry_type(tar::EntryType::Regular);
    header.set_cksum();
    tar.append(&header, &data[..]).unwrap();
    tar.into_inner().unwrap().finish().unwrap();
    let refused = inspect(&env_for(&out.0), &path.to_string_lossy())
        .err()
        .unwrap();
    assert!(refused.contains("outside itself"), "{refused}");
    assert!(!out.0.parent().unwrap().join("escape").exists());
}

#[test]
fn the_export_never_takes_a_path_outside_setup_or_overwrites_a_folder() {
    let dir = TestDir::new("out");
    let env = env_for(&dir.0);
    let mut request = export_request(&dir.0.join("x"), Form::Folder);
    request.memory = None;
    request.workspace = false;
    request.files.insert("../escape.json".into(), "{}".into());
    assert!(export(&env, &request)
        .unwrap_err()
        .contains("Not a setup file"));
    request.files.remove("../escape.json");
    request
        .files
        .insert("memory/ash/MEMORY.md".into(), "x".into());
    assert!(export(&env, &request)
        .unwrap_err()
        .contains("Not a setup file"));
    request.files.remove("memory/ash/MEMORY.md");
    fs::create_dir_all(dir.0.join("x")).unwrap();
    assert!(export(&env, &request)
        .unwrap_err()
        .contains("already exists"));
    // Nothing half-made is left beside it.
    let leftovers: Vec<_> = fs::read_dir(&dir.0)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(".monocode"))
        .collect();
    assert!(leftovers.is_empty());
}

#[test]
fn mono_files_are_read_without_making_folders() {
    let dir = TestDir::new("monos");
    let env = env_for(&dir.0);
    let mono = env.data_dir.join("monos/cos");
    fs::create_dir_all(mono.join("memory")).unwrap();
    fs::write(mono.join("SOUL.md"), "# soul").unwrap();
    fs::write(mono.join("MEMORY.md"), "- fact").unwrap();
    fs::write(mono.join("memory/clients.md"), "notes").unwrap();
    let refs = vec![
        MonoRef {
            id: "cos".into(),
            legacy_project: None,
        },
        MonoRef {
            id: "ghost".into(),
            legacy_project: None,
        },
    ];
    let without = mono_files(&env, &refs, false);
    assert_eq!(without["cos"].keys().collect::<Vec<_>>(), vec!["SOUL.md"]);
    let with = mono_files(&env, &refs, true);
    assert_eq!(
        with["cos"].keys().collect::<Vec<_>>(),
        vec!["MEMORY.md", "SOUL.md", "memory/clients.md"]
    );
    assert!(with["ghost"].is_empty());
    assert!(!env.data_dir.join("monos/ghost").exists());
}

#[test]
fn an_export_reads_souls_from_the_monos_home_in_use_not_the_stale_old_folder() {
    let dir = TestDir::new("monohome");
    let env = env_for(&dir.0);
    let refs = vec![MonoRef {
        id: "hivra-lead".into(),
        legacy_project: None,
    }];
    // Before the move: only the old folder in the app's data. It is read.
    let old = env.data_dir.join("monos/hivra-lead");
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("SOUL.md"), "# old copy").unwrap();
    assert!(!env.monos_root.exists());
    assert_eq!(env.mono_home(), env.data_dir.join("monos"));
    assert_eq!(
        mono_files(&env, &refs, false)["hivra-lead"]["SOUL.md"],
        "# old copy"
    );

    // After the move: the home holds the live soul; the old copy, left behind, is never read again.
    let home = env.monos_root.join("hivra-lead");
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("SOUL.md"), "# live soul").unwrap();
    assert_eq!(env.mono_home(), env.monos_root);
    assert_eq!(
        mono_files(&env, &refs, false)["hivra-lead"]["SOUL.md"],
        "# live soul"
    );

    // A dev copy's own home (another root entirely) is read the same way.
    let dev = Env {
        monos_root: dir.0.join("data/dev-slot/monos"),
        ..env_for(&dir.0)
    };
    fs::create_dir_all(dev.monos_root.join("hivra-lead")).unwrap();
    fs::write(dev.monos_root.join("hivra-lead/SOUL.md"), "# slot soul").unwrap();
    assert_eq!(
        mono_files(&dev, &refs, false)["hivra-lead"]["SOUL.md"],
        "# slot soul"
    );
}

#[test]
fn each_chat_says_which_engine_it_runs_on() {
    let dir = TestDir::new("engines");
    let env = env_for(&dir.0);
    seed(&env);
    let engines = session_engines(
        &env,
        &[
            "chat-2".into(),
            "mono-chat".into(),
            "nope".into(),
            "../x".into(),
        ],
    )
    .unwrap();
    assert_eq!(engines.len(), 2);
    assert_eq!(
        engines["chat-2"],
        json!({"harness": "codex", "model": "codex-model"})
    );
    assert_eq!(engines["mono-chat"]["harness"], "claude");
}

/// WP-02: an export is read on another machine, maybe another platform, so every name in it (the archive's entries and
/// the manifest's file list) uses `/`, whatever the platform that wrote it; and an import takes `\` as well.
#[test]
fn an_export_names_its_files_with_forward_slashes_on_every_platform() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    seed(&source);
    let dest = out.0.join("export.tar.gz");
    export(&source, &export_request(&dest, Form::Archive)).unwrap();

    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(fs::File::open(&dest).unwrap()));
    let mut names = Vec::new();
    let mut manifest = None;
    for entry in tar.entries().unwrap() {
        let mut entry = entry.unwrap();
        let raw = String::from_utf8(entry.path_bytes().into_owned()).unwrap();
        if raw.ends_with("/manifest.json") {
            let mut text = String::new();
            std::io::Read::read_to_string(&mut entry, &mut text).unwrap();
            manifest = Some(serde_json::from_str::<Value>(&text).unwrap());
        }
        names.push(raw);
    }
    assert!(
        names.iter().any(|n| n.contains("/setup/monos/")),
        "{names:?}"
    );
    assert!(!names.iter().any(|n| n.contains('\\')), "{names:?}");
    let listed: Vec<String> = manifest.unwrap()["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap().to_string())
        .collect();
    assert!(
        listed.iter().any(|p| p.starts_with("memory/")),
        "{listed:?}"
    );
    assert!(!listed.iter().any(|p| p.contains('\\')), "{listed:?}");

    // An archive written with `\` (another tool, an older Windows build) still opens, its files in their folders.
    let foreign = out.0.join("foreign.tar.gz");
    {
        let gz = flate2::write::GzEncoder::new(
            fs::File::create(&foreign).unwrap(),
            flate2::Compression::default(),
        );
        let mut builder = tar::Builder::new(gz);
        let body = b"# Soul\n";
        let mut header = tar::Header::new_gnu();
        // `set_path` would turn the separators into `/` itself; write the name's bytes as such a tool does.
        let name = b"export\\setup\\monos\\cos\\SOUL.md";
        header.as_old_mut().name[..name.len()].copy_from_slice(name);
        header.set_size(body.len() as u64);
        header.set_entry_type(tar::EntryType::Regular);
        header.set_mode(0o600);
        header.set_cksum();
        builder.append(&header, &body[..]).unwrap();
        builder.into_inner().unwrap().finish().unwrap();
    }
    let scratch = unpack(&foreign).unwrap();
    assert_eq!(
        fs::read_to_string(scratch.0.join("export/setup/monos/cos/SOUL.md")).unwrap(),
        "# Soul\n"
    );
}

/// WP-78: the activity log is part of the workspace export. A secret in a summary does not survive, a row older
/// than 90 days stays out, and importing the same file again adds nothing.
#[test]
fn the_activity_log_is_in_the_export_without_the_secret_and_a_second_import_adds_nothing() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    seed(&source);
    let now = crate::session_store::now_millis();
    {
        let store = SessionStore::open(source.db_path.clone()).unwrap();
        let conn = store.lock_conn().unwrap();
        conn.execute(
            "INSERT INTO activity (id, kind, actor_role, initiator_role, project, target, summary, link, at)
             VALUES ('act-fresh', 'git.push', 'app', 'person', 'acme/web', 'work', ?1, '', ?2)",
            params![format!("Pushed the branch. {GITHUB}"), now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO activity (id, kind, actor_role, initiator_role, summary, at)
             VALUES ('act-old', 'git.push', 'app', 'person', 'Pushed long ago.', ?1)",
            params![now - crate::activity::RETENTION_MS - 86_400_000],
        )
        .unwrap();
        let _: (i64, i64, i64) = conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
    }

    let dest = out.0.join("export");
    let report = export(&source, &export_request(&dest, Form::Folder)).unwrap();
    assert_eq!(report.counts["activity"], 1);
    assert_no_secrets(&dest);
    let text = String::from_utf8(
        export_texts(&dest)
            .get("workspace/activity.json")
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert!(!text.contains("ghp_"), "{text}");
    assert!(text.contains("[secret removed]"), "{text}");
    assert!(!text.contains("act-old"), "{text}");
    assert!(!text.contains("Pushed long ago"), "{text}");

    let target_store = open_store(&target);
    let preview = inspect(&target, &dest.to_string_lossy()).unwrap();
    assert_eq!(preview.workspace.unwrap().activity, 1);

    let request = ImportRequest {
        path: dest.to_string_lossy().into_owned(),
        memory: None,
        workspace: Some(WorkspaceImport::default()),
    };
    let conn = target_store.lock_conn().unwrap();
    let imported = import_held(&target, &conn, &request).unwrap();
    assert_eq!(imported.activity_added, 1, "{imported:?}");
    assert_eq!(imported.sessions_added, 0);
    let again = import_held(&target, &conn, &request).unwrap();
    assert_eq!(again.activity_added, 0, "{again:?}");

    let page = crate::activity::list(&conn, &crate::activity::ListQuery::default(), now).unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].id, "act-fresh");
    assert!(
        !page.entries[0].summary.contains("ghp_"),
        "{}",
        page.entries[0].summary
    );
    assert!(scrubber().findings(&page.entries[0].summary).is_empty());
    assert!(page.entries[0].summary.contains("[secret removed]"));
}

#[test]
fn docs_history_comes_back_and_a_copy_keeps_its_own_parent() {
    let source_dir = TestDir::new("docs-source");
    let target_dir = TestDir::new("docs-target");
    let copy_dir = TestDir::new("docs-copy");
    let out = TestDir::new("docs-out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let copy = env_for(&copy_dir.0);
    let store = open_store(&source);
    let conn = store.lock_conn().unwrap();
    conn.execute_batch(
        "INSERT INTO notes (id, slug, title, body, tags_json, slug_pending, created_at, updated_at, content_kind, parent_id, blocks_json)
         VALUES ('parent', 'parent', 'Parent', 'parent body', '[]', 0, 1, 1, 'note', NULL, NULL),
                ('child', 'child', 'Child', 'see note-assets/child/pic.png', '[]', 0, 2, 2, 'note', 'parent', '{\"url\":\"note-assets/child/pic.png\"}');
         INSERT INTO note_versions (id, note_id, version, title, body, blocks_json, kind, author_kind, author_id, author_name, created_at)
         VALUES ('ver-1', 'child', 1, 'Child', 'see note-assets/child/pic.png', '{\"url\":\"note-assets/child/pic.png\"}', 'auto', 'person', 'ash', 'Ash', 3);
         INSERT INTO note_mentions (note_id, kind, target_id, name) VALUES ('child', 'page', 'parent', 'Parent');",
    )
    .unwrap();
    drop(conn);
    drop(store);
    let dest = out.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.files.clear();
    let exported = export(&source, &request).unwrap();
    assert_eq!(exported.counts["docVersions"], 1);
    assert_eq!(exported.counts["docMentions"], 1);

    let bring = ImportRequest {
        path: dest.to_string_lossy().into_owned(),
        memory: None,
        workspace: Some(WorkspaceImport {
            notes: vec!["parent".into(), "child".into()],
            ..Default::default()
        }),
    };
    let target_store = open_store(&target);
    let target_conn = target_store.lock_conn().unwrap();
    import_held(&target, &target_conn, &bring).unwrap();
    let parent_of = |id: &str| -> Option<String> {
        target_conn
            .query_row("SELECT parent_id FROM notes WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .unwrap()
    };
    assert_eq!(parent_of("child").as_deref(), Some("parent"));
    let version_body: String = target_conn
        .query_row(
            "SELECT body FROM note_versions WHERE note_id = 'child' AND version = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        version_body.contains("note-assets/child/pic.png"),
        "{version_body}"
    );
    let mentioned: String = target_conn
        .query_row(
            "SELECT target_id FROM note_mentions WHERE note_id = 'child' AND kind = 'page'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(mentioned, "parent");
    drop(target_conn);
    drop(target_store);

    let copy_store = open_store(&copy);
    let copy_conn = copy_store.lock_conn().unwrap();
    copy_conn
        .execute_batch(
            "INSERT INTO notes (id, slug, title, body, tags_json, slug_pending, created_at, updated_at, content_kind, parent_id)
             VALUES ('parent', 'parent', 'Kept', 'local parent', '[]', 0, 1, 1, 'note', NULL),
                    ('child', 'child', 'Kept', 'local child', '[]', 0, 2, 2, 'note', 'parent');",
        )
        .unwrap();
    let report = import_held(
        &copy,
        &copy_conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(WorkspaceImport {
                notes: vec!["parent".into(), "child".into()],
                note_copies: vec!["parent".into(), "child".into()],
                ..Default::default()
            }),
        },
    )
    .unwrap();
    let new_parent = report.renamed.get("parent").unwrap();
    let new_child = report.renamed.get("child").unwrap();
    let copied_parent: String = copy_conn
        .query_row(
            "SELECT parent_id FROM notes WHERE id = ?1",
            [new_child],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(copied_parent, *new_parent);
    let kept_parent: String = copy_conn
        .query_row(
            "SELECT parent_id FROM notes WHERE id = 'child'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(kept_parent, "parent");
    let copied_blocks: String = copy_conn
        .query_row(
            "SELECT blocks_json FROM notes WHERE id = ?1",
            [new_child],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        copied_blocks.contains(&format!("note-assets/{new_child}/pic.png")),
        "{copied_blocks}"
    );
    assert!(!copied_blocks.contains("note-assets/child/"));
    let copied_version: String = copy_conn
        .query_row(
            "SELECT blocks_json FROM note_versions WHERE note_id = ?1",
            [new_child],
            |row| row.get(0),
        )
        .unwrap();
    assert!(copied_version.contains(&format!("note-assets/{new_child}/")));
    let copied_mention: String = copy_conn
        .query_row(
            "SELECT target_id FROM note_mentions WHERE note_id = ?1 AND kind = 'page'",
            [new_child],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(copied_mention, *new_parent);
}

#[test]
fn a_private_chat_stays_private_across_export_and_an_old_file_stays_readable() {
    let source_dir = TestDir::new("private-source");
    let target_dir = TestDir::new("private-target");
    let out = TestDir::new("private-out");
    let source = env_for(&source_dir.0);
    let store = open_store(&source);
    let conn = store.lock_conn().unwrap();
    add_session(
        &conn,
        "secret",
        "Secret",
        "claude",
        json!([block("b1", "user", "hello")]),
        5_000,
    );
    conn.execute(
        "UPDATE sessions SET private_chat = 1, private_boundary_id = 'b1' WHERE id = 'secret'",
        [],
    )
    .unwrap();
    drop(conn);
    drop(store);

    let dest = out.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.files.clear();
    export(&source, &request).unwrap();
    let file: Value = serde_json::from_str(
        &fs::read_to_string(dest.join("workspace/sessions/secret.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(file["private"], true);
    assert_eq!(file["privateBoundaryId"], "b1");

    let target = env_for(&target_dir.0);
    let target_store = open_store(&target);
    let conn = target_store.lock_conn().unwrap();
    import_held(
        &target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(WorkspaceImport {
                sessions: vec!["secret".into()],
                ..Default::default()
            }),
        },
    )
    .unwrap();
    let stored = session_store::get_session(&conn, "secret")
        .unwrap()
        .unwrap();
    assert!(stored.private_chat);
    assert_eq!(stored.private_boundary_id.as_deref(), Some("b1"));

    // An old export has neither key, so the chat comes back readable.
    let old = json!({
        "title": "Old",
        "cwd": "/tmp",
        "blocks": [block("u", "user", "hi")],
        "engine": {"harness": "claude", "model": "m", "runtimeMode": "auto"}
    });
    insert_session(
        &target,
        &conn,
        "old",
        "Old",
        &old,
        &FolderRules::load(&target, &[], &[], &[], &[]),
    )
    .unwrap();
    let old_row = session_store::get_session(&conn, "old").unwrap().unwrap();
    assert!(!old_row.private_chat);
    assert_eq!(old_row.private_boundary_id, None);

    // A boundary that is not a message id must not unlock what came before the switch.
    let bad = json!({
        "title": "Bad",
        "cwd": "/tmp",
        "private": false,
        "privateBoundaryId": "../no",
        "blocks": [block("u", "user", "hi")],
        "engine": {"harness": "claude", "model": "m", "runtimeMode": "auto"}
    });
    insert_session(
        &target,
        &conn,
        "bad",
        "Bad",
        &bad,
        &FolderRules::load(&target, &[], &[], &[], &[]),
    )
    .unwrap();
    let bad_row = session_store::get_session(&conn, "bad").unwrap().unwrap();
    assert_eq!(
        bad_row.private_boundary_id.as_deref(),
        Some("private-boundary-unreadable")
    );
}

// ---- the folder an imported chat may keep ---------------------------------------------------------------------------
// A crafted or foreign export names any folder it likes. The agent, git, checkpoints and terminals then run there, so a
// chat keeps a folder only when it is a real folder here inside a project this copy already has.

/// A target copy with one project (`root/projects/app`, in the app's own project record) and the places a crafted
/// export would aim at: a folder beside the project that shares its prefix, one far outside, a link in the project that
/// points out.
struct Layout {
    root: TestDir,
    target: Env,
    project: PathBuf,
    outside: PathBuf,
}

fn layout() -> Layout {
    let root = TestDir::new("folders");
    let mut target = env_for(&root.0.join("target"));
    // As on the daily app: the memory root, with the Monos home in it, is inside the home folder.
    let home = target.home.clone().unwrap();
    target.memory_root = home.join("agent-memory");
    target.monos_root = target.memory_root.join("monos");
    let project = home.join("Projects/app");
    fs::create_dir_all(project.join("src/deep")).unwrap();
    // A repository's own marker: only a repository can be adopted as a project's folder.
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(home.join("Projects/app-evil")).unwrap();
    let outside = root.0.join("outside");
    fs::create_dir_all(&outside).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, project.join("escape")).unwrap();
    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    crate::local_hub::write(
        &conn,
        "projects",
        &json!({"projects": [{"id": "app", "name": "App", "folder": project.to_string_lossy()}]}),
    )
    .unwrap();
    drop(conn);
    drop(store);
    Layout {
        root,
        target,
        project,
        outside,
    }
}

/// Chats `(id, cwd, worktreeCwd)` as another copy exported them, imported into the layout's copy. The stored folders
/// come back by id, with the report.
fn import_folders(
    layout: &Layout,
    chats: &[(&str, String, Option<String>)],
    known: &[String],
) -> (BTreeMap<String, (String, Option<String>)>, Value) {
    import_folders_with(layout, chats, known, &[], &[])
}

/// As `import_folders`, with the Monos seated here and the file-folder to this-Mac-folder pairs the window passes.
fn import_folders_with(
    layout: &Layout,
    chats: &[(&str, String, Option<String>)],
    known: &[String],
    monos: &[&str],
    map: &[(&str, &str, String)],
) -> (BTreeMap<String, (String, Option<String>)>, Value) {
    let source = env_for(&layout.root.0.join("source"));
    let store = open_store(&source);
    let conn = store.lock_conn().unwrap();
    for (n, (id, cwd, worktree)) in chats.iter().enumerate() {
        add_session(
            &conn,
            id,
            id,
            "claude",
            json!([block("u", "user", "hi")]),
            1_000 + n as i64,
        );
        conn.execute(
            "UPDATE sessions SET cwd = ?2, worktree_cwd = ?3 WHERE id = ?1",
            params![id, cwd, worktree],
        )
        .unwrap();
    }
    drop(conn);
    drop(store);
    let dest = layout.root.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.files.clear();
    export(&source, &request).unwrap();

    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    let workspace: WorkspaceImport = serde_json::from_value(json!({
        "sessions": chats.iter().map(|(id, _, _)| *id).collect::<Vec<_>>(),
        "knownFolders": known,
        "knownMonos": monos,
        "folderMap": map.iter().map(|(id, from, to)| json!({"projectId": id, "from": from, "to": to})).collect::<Vec<_>>(),
    }))
    .unwrap();
    let report = import_held(
        &layout.target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(workspace),
        },
    )
    .unwrap();
    assert_eq!(report.sessions_added, chats.len(), "{report:?}");
    let stored = chats
        .iter()
        .map(|(id, _, _)| {
            let row = session_store::get_session(&conn, id).unwrap().unwrap();
            (id.to_string(), (row.cwd, row.worktree_cwd))
        })
        .collect();
    (stored, serde_json::to_value(&report).unwrap())
}

fn path(base: &Path, tail: &str) -> String {
    base.join(tail).to_string_lossy().into_owned()
}

#[test]
fn an_imported_chat_keeps_its_folder_only_inside_a_project_this_copy_has() {
    let layout = layout();
    let p = &layout.project;
    let keep = [
        ("fine", path(p, "src/deep")),
        ("root", p.to_string_lossy().into_owned()),
    ];
    let clear = [
        // The crafted file's own folder, wherever it lives on this Mac.
        ("elsewhere", "/tmp/elsewhere".to_string()),
        ("outside", layout.outside.to_string_lossy().into_owned()),
        // Shares the project's prefix; is not inside it.
        (
            "sibling",
            path(layout.project.parent().unwrap(), "app-evil"),
        ),
        // Climbs out of the project.
        ("dotdot", path(p, "src/../../app-evil")),
        ("missing", path(p, "nope")),
        // Resolved against whatever folder the app happens to run in.
        ("relative", "src".to_string()),
        ("home", "~".to_string()),
        ("empty", String::new()),
    ];
    #[cfg(unix)]
    let clear = [clear.to_vec(), vec![("link", path(p, "escape"))]].concat();
    #[cfg(not(unix))]
    let clear = clear.to_vec();
    let chats: Vec<(&str, String, Option<String>)> = keep
        .iter()
        .chain(clear.iter())
        .map(|(id, cwd)| (*id, cwd.clone(), None))
        .collect();
    let (stored, report) = import_folders(&layout, &chats, &[]);
    for (id, cwd) in &keep {
        assert_eq!(&stored[*id].0, cwd, "{id} stays");
    }
    for (id, _) in &clear {
        assert_eq!(stored[*id].0, "", "{id} is cleared, not sent anywhere");
    }
    // "empty" named no folder, so it isn't one this import cleared.
    assert_eq!(report["foldersCleared"], clear.len() - 1, "{report}");
}

#[test]
fn a_chat_with_no_folder_in_the_file_has_none_here_not_the_home_folder() {
    let layout = layout();
    let source = env_for(&layout.root.0.join("source"));
    let store = open_store(&source);
    let conn = store.lock_conn().unwrap();
    add_session(
        &conn,
        "bare",
        "Bare",
        "claude",
        json!([block("u", "user", "hi")]),
        1_000,
    );
    drop(conn);
    drop(store);
    let dest = layout.root.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.files.clear();
    export(&source, &request).unwrap();
    // A file from a build that never wrote the folder keys.
    let mut file: Value = serde_json::from_str(
        &fs::read_to_string(dest.join("workspace/sessions/bare.json")).unwrap(),
    )
    .unwrap();
    file.as_object_mut().unwrap().remove("cwd");
    file.as_object_mut().unwrap().remove("worktreeCwd");
    put_in_export(
        &dest,
        "workspace/sessions/bare.json",
        file.to_string().as_bytes(),
    );

    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(
        &layout.target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(WorkspaceImport {
                sessions: vec!["bare".into()],
                ..Default::default()
            }),
        },
    )
    .unwrap();
    assert_eq!(report.sessions_added, 1, "{report:?}");
    let row = session_store::get_session(&conn, "bare").unwrap().unwrap();
    assert_eq!((row.cwd.as_str(), row.worktree_cwd), ("", None));
    // It named no folder, so there was nothing for this import to clear.
    assert_eq!(serde_json::to_value(&report).unwrap()["foldersCleared"], 0);
}

#[test]
fn a_worktree_stays_only_when_git_lists_it_for_a_known_project() {
    let layout = layout();
    let p = &layout.project;
    git(p, &["init", "-q"]);
    fs::write(p.join("a.txt"), "a").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "first"]);
    let tree = layout
        .target
        .home
        .clone()
        .unwrap()
        .join("Worktrees/feature");
    git(
        p,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            &tree.to_string_lossy(),
        ],
    );
    let chats = [
        // A real worktree of the project, beside it rather than inside it.
        (
            "listed",
            p.to_string_lossy().into_owned(),
            Some(tree.to_string_lossy().into_owned()),
        ),
        // A folder git never listed.
        (
            "unlisted",
            p.to_string_lossy().into_owned(),
            Some(layout.outside.to_string_lossy().into_owned()),
        ),
        // The project's folder is gone, so the working copy it names isn't vouched for either.
        (
            "orphan",
            "/tmp/elsewhere".to_string(),
            Some(tree.to_string_lossy().into_owned()),
        ),
    ];
    let (stored, report) = import_folders(&layout, &chats, &[]);
    assert_eq!(
        stored["listed"],
        (
            p.to_string_lossy().into_owned(),
            Some(tree.to_string_lossy().into_owned())
        )
    );
    assert_eq!(stored["unlisted"], (p.to_string_lossy().into_owned(), None));
    assert_eq!(stored["orphan"], (String::new(), None));
    assert_eq!(report["foldersCleared"], 2, "{report}");
}

#[test]
fn folders_the_window_lists_count_but_the_home_folder_and_the_root_never_vouch_for_what_is_in_them()
{
    let layout = layout();
    let rail = layout.target.home.clone().unwrap().join("rail");
    fs::create_dir_all(rail.join("site")).unwrap();
    let home = layout.target.home.clone().unwrap();
    fs::create_dir_all(home.join("Documents")).unwrap();
    let known = vec![
        rail.to_string_lossy().into_owned(),
        home.to_string_lossy().into_owned(),
        "/".to_string(),
    ];
    let chats = [
        ("rail", path(&rail, "site"), None),
        ("documents", path(&home, "Documents"), None),
        (
            "anywhere",
            layout.outside.to_string_lossy().into_owned(),
            None,
        ),
    ];
    let (stored, report) = import_folders(&layout, &chats, &known);
    assert_eq!(stored["rail"].0, path(&rail, "site"));
    assert_eq!(stored["documents"].0, "");
    assert_eq!(stored["anywhere"].0, "");
    assert_eq!(report["foldersCleared"], 2, "{report}");
}

#[test]
fn a_monos_own_folders_here_are_kept() {
    let layout = layout();
    let lead = layout.target.monos_root.join("hivra-lead");
    let team = layout.target.data_dir.join("mono-teams/hivra-lead");
    fs::create_dir_all(&lead).unwrap();
    fs::create_dir_all(&team).unwrap();
    let chats = [
        ("lead", lead.to_string_lossy().into_owned(), None),
        ("team", team.to_string_lossy().into_owned(), None),
        (
            "memory",
            layout.target.memory_root.to_string_lossy().into_owned(),
            None,
        ),
    ];
    fs::create_dir_all(&layout.target.memory_root).unwrap();
    let (stored, report) = import_folders_with(&layout, &chats, &[], &["hivra-lead"], &[]);
    assert_eq!(stored["lead"].0, lead.to_string_lossy());
    assert_eq!(stored["team"].0, team.to_string_lossy());
    // The memory folder itself isn't a Mono's own folder.
    assert_eq!(stored["memory"].0, "");
    assert_eq!(report["foldersCleared"], 1, "{report}");
}

#[test]
fn an_imported_automation_loses_a_folder_that_is_not_in_a_project_here() {
    let layout = layout();
    let source = env_for(&layout.root.0.join("source"));
    let store = open_store(&source);
    let conn = store.lock_conn().unwrap();
    let definition = |id: &str, cwd: &str, worktree: &str| {
        json!({"id": id, "name": id, "prompt": "p", "harness": "claude", "model": "m", "cwd": cwd,
               "workspaceMode": "existing", "worktreeCwd": worktree, "enabled": true, "nextRunAt": 99_000, "updatedAt": 50})
    };
    let inside = path(&layout.project, "src");
    for automation in [
        definition("away", "/tmp/elsewhere", &path(&layout.outside, "x")),
        definition("home", &inside, ""),
    ] {
        conn.execute(
            "INSERT INTO automations (id, definition_json, enabled, next_run_at, updated_at) VALUES (?1, ?2, 1, 99000, 50)",
            params![automation["id"].as_str().unwrap(), automation.to_string()],
        )
        .unwrap();
    }
    drop(conn);
    drop(store);
    let dest = layout.root.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.files.clear();
    export(&source, &request).unwrap();

    let target_store = open_store(&layout.target);
    let conn = target_store.lock_conn().unwrap();
    let report = import_held(
        &layout.target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(WorkspaceImport {
                automations: vec!["away".into(), "home".into()],
                ..Default::default()
            }),
        },
    )
    .unwrap();
    assert_eq!(report.automations_added, 2, "{report:?}");
    let stored = |id: &str| -> Value {
        let raw: String = conn
            .query_row(
                "SELECT definition_json FROM automations WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    };
    let away = stored("away");
    assert_eq!(
        (away["cwd"].as_str(), away["worktreeCwd"].as_str()),
        (Some(""), Some(""))
    );
    assert_eq!(away["enabled"], false);
    assert_eq!(stored("home")["cwd"], inside);
    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(json["automationFoldersCleared"], 1, "{json}");
}

// ---- paths in an imported chat's tool rows ---------------------------------------------------------------------------
// A tool row's `paths` and `preview.path` feed `sessionEditPaths`, which the window hands to the checkpoint calls
// (`session_checkpoint_begin_turn`, `session_checkpoint_status`). A file's paths are nobody's choice here either.

fn edit_row(id: &str, paths: &[String], preview: Option<String>) -> Value {
    let mut tool = json!({"status": "completed", "kind": "edit", "title": "Edit", "paths": paths});
    if let Some(path) = preview {
        tool["preview"] = json!({"kind": "diff", "path": path, "steps": []});
    }
    json!({"id": id, "role": "tool", "tool": tool})
}

/// One chat, exported with these blocks and folder, imported into the layout's copy; its stored blocks and the report.
fn import_blocks(layout: &Layout, cwd: &str, blocks: Vec<Value>) -> (Vec<Value>, Value) {
    let source = env_for(&layout.root.0.join("source"));
    let store = open_store(&source);
    let conn = store.lock_conn().unwrap();
    let mut all = vec![block("u", "user", "edit please")];
    all.extend(blocks);
    add_session(&conn, "tools", "Tools", "claude", json!(all), 1_000);
    conn.execute(
        "UPDATE sessions SET cwd = ?2 WHERE id = ?1",
        params!["tools", cwd],
    )
    .unwrap();
    drop(conn);
    drop(store);
    let dest = layout.root.0.join("export-tools");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.files.clear();
    export(&source, &request).unwrap();
    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(
        &layout.target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(WorkspaceImport {
                sessions: vec!["tools".into()],
                ..Default::default()
            }),
        },
    )
    .unwrap();
    let row = session_store::get_session(&conn, "tools").unwrap().unwrap();
    (
        row.blocks.as_array().unwrap().clone(),
        serde_json::to_value(&report).unwrap(),
    )
}

#[test]
fn an_imported_tool_row_keeps_only_paths_inside_the_chats_folder() {
    let layout = layout();
    let p = &layout.project;
    fs::write(layout.outside.join("secret.txt"), "x").unwrap();
    let inside_abs = path(p, "src/b.rs");
    let paths: Vec<String> = [
        "src/a.rs".to_string(),
        inside_abs.clone(),
        // A file that no longer exists is still the chat's own.
        "gone/deleted.rs".to_string(),
        "../outside.txt".to_string(),
        "src/../../app-evil/x".to_string(),
        path(&layout.outside, "secret.txt"),
        "/etc/hosts".to_string(),
        "~/.ssh/id_rsa".to_string(),
        String::new(),
    ]
    .into_iter()
    .chain(cfg!(unix).then(|| path(p, "escape/secret.txt")))
    .collect();
    let blocks = vec![
        edit_row("t1", &paths, Some(path(&layout.outside, "secret.txt"))),
        edit_row("t2", &[], Some("src/a.rs".to_string())),
    ];
    let (stored, report) = import_blocks(&layout, &p.to_string_lossy(), blocks);
    assert_eq!(
        stored[1]["tool"]["paths"],
        json!(["src/a.rs", inside_abs, "gone/deleted.rs"])
    );
    assert!(stored[1]["tool"]["preview"].get("path").is_none());
    // Inside paths, and the rest of the row, are as they were.
    assert_eq!(stored[2]["tool"]["preview"]["path"], "src/a.rs");
    assert_eq!(stored[1]["tool"]["status"], "completed");
    let dropped = paths.len() - 3 + 1;
    assert_eq!(report["toolPathsDropped"], dropped, "{report}");
}

#[test]
fn a_chat_whose_folder_was_cleared_keeps_no_tool_paths_at_all() {
    let layout = layout();
    let blocks = vec![edit_row(
        "t1",
        &["src/a.rs".to_string(), path(&layout.project, "src/b.rs")],
        Some("src/a.rs".to_string()),
    )];
    let (stored, report) = import_blocks(&layout, "/tmp/elsewhere", blocks);
    assert_eq!(stored[1]["tool"]["paths"], json!([]));
    assert!(stored[1]["tool"]["preview"].get("path").is_none());
    assert_eq!(report["foldersCleared"], 1, "{report}");
    assert_eq!(report["toolPathsDropped"], 3, "{report}");
}

// ---- project folders an export wants to register ---------------------------------------------------------------------
// The preview starts every such folder unticked; whatever is ticked, these are refused in Rust too, and the projects
// this copy has (before the import adds any) are what a chat's folder is judged against.

#[test]
fn a_project_folder_that_holds_everything_is_refused_whatever_is_ticked() {
    let layout = layout();
    let env = &layout.target;
    let home = env.home.clone().unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(env.data_dir.join("monos")).unwrap();
    let refused = |dir: &Path| refused_project_folder(env, &dir.to_string_lossy());
    for dir in [
        home.clone(),
        // A folder that holds the home folder, and the one that holds that.
        home.parent().unwrap().to_path_buf(),
        layout.root.0.clone(),
        PathBuf::from("/"),
        PathBuf::from("/Volumes"),
        env.data_dir.clone(),
        env.data_dir.join("monos"),
        // The folder that holds the app's data.
        env.data_dir.parent().unwrap().to_path_buf(),
    ] {
        assert!(refused(&dir).is_some(), "{} must be refused", dir.display());
    }
    // `~` is the home folder, a relative path and a missing folder aren't projects.
    for raw in ["~", "src", "../..", ""] {
        assert!(refused_project_folder(env, raw).is_some(), "{raw:?}");
    }
    assert!(refused(&layout.root.0.join("missing")).is_some());
    // A folder of its own is fine, and so is one inside it.
    assert_eq!(refused(&layout.project), None);
    // Only the top of a repository is a project's folder.
    assert!(refused(&layout.project.join("src"))
        .unwrap()
        .contains("git repository"));
    let checks = project_folder_checks(
        env,
        &[
            home.to_string_lossy().into_owned(),
            layout.project.to_string_lossy().into_owned(),
        ],
    );
    assert_eq!(checks.len(), 1, "{checks:?}");
}

#[test]
fn a_record_that_lists_a_broad_folder_does_not_vouch_for_what_is_inside_it() {
    let layout = layout();
    let env = &layout.target;
    let home = env.home.clone().unwrap();
    fs::create_dir_all(home.join("Documents")).unwrap();
    fs::create_dir_all(env.data_dir.join("scratch")).unwrap();
    let store = open_store(env);
    let conn = store.lock_conn().unwrap();
    let folders: Vec<String> = [
        home.clone(),
        home.parent().unwrap().to_path_buf(),
        env.data_dir.clone(),
        PathBuf::from("/"),
        PathBuf::from("/Volumes"),
    ]
    .iter()
    .map(|dir| dir.to_string_lossy().into_owned())
    .collect();
    crate::local_hub::write(
        &conn,
        "projects",
        &json!({"projects": folders.iter().enumerate().map(|(n, folder)| json!({"id": format!("p{n}"), "name": format!("P{n}"), "folder": folder})).collect::<Vec<_>>()}),
    )
    .unwrap();
    drop(conn);
    drop(store);
    let chats = [
        ("docs", path(&home, "Documents"), None),
        ("scratch", path(&env.data_dir, "scratch"), None),
        ("tmp", layout.outside.to_string_lossy().into_owned(), None),
    ];
    let (stored, report) = import_folders(&layout, &chats, &[]);
    assert!(stored.values().all(|(cwd, _)| cwd.is_empty()), "{stored:?}");
    assert_eq!(report["foldersCleared"], 3, "{report}");
}

#[test]
fn a_project_registered_without_its_folder_leaves_its_chats_without_one() {
    let layout = layout();
    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    // Registered, but its folder was left unticked in the preview.
    crate::local_hub::write(
        &conn,
        "projects",
        &json!({"projects": [{"id": "app", "name": "App", "folder": null}]}),
    )
    .unwrap();
    drop(conn);
    drop(store);
    let chats = [("inside", path(&layout.project, "src"), None)];
    let (stored, report) = import_folders(&layout, &chats, &[]);
    assert_eq!(stored["inside"].0, "");
    assert_eq!(report["foldersCleared"], 1, "{report}");
}

// ---- a folder export's note pictures (symlinks, the manifest, the hash) --------------------------------------------

/// What the seeded note's picture holds.
const PICTURE: [u8; 7] = [0x89, b'P', b'N', b'G', 1, 2, 3];

/// A folder export of the seeded source copy: note-1 with its one listed picture, `1-shot.png`.
fn note_export(source: &Env, out: &Path) -> PathBuf {
    seed(source);
    let dest = out.join("export");
    export(source, &export_request(&dest, Form::Folder)).unwrap();
    assert!(dest
        .join("workspace/note-assets/note-1/1-shot.png")
        .is_file());
    dest
}

/// An import of note-1 only.
fn note_import(dest: &Path) -> ImportRequest {
    ImportRequest {
        path: dest.to_string_lossy().into_owned(),
        memory: None,
        workspace: Some(WorkspaceImport {
            notes: vec!["note-1".into()],
            ..Default::default()
        }),
    }
}

/// Every file under `dir` (empty when there is no such folder), by name relative to it, with `/` on every platform.
fn files_under(dir: &Path) -> Vec<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                out.push(
                    path.strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

/// No picture folder here holds a byte of `secret`.
fn assert_not_in_pictures(env: &Env, secret: &str) {
    let root = env.data_dir.join(NOTE_ASSET_DIR);
    for name in files_under(&root) {
        let bytes = fs::read(root.join(&name)).unwrap();
        assert!(
            !String::from_utf8_lossy(&bytes).contains(secret),
            "{name} carries the secret"
        );
    }
}

/// A file in the export that is a link to a private key, and not listed in the manifest: it must not be copied.
#[cfg(unix)]
#[test]
fn an_unlisted_link_in_a_picture_folder_never_copies_what_it_points_at() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let outside = TestDir::new("outside");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = note_export(&source, &out.0);
    fs::write(outside.0.join("id_rsa"), PRIVATE_KEY).unwrap();
    std::os::unix::fs::symlink(
        outside.0.join("id_rsa"),
        dest.join("workspace/note-assets/note-1/x.png"),
    )
    .unwrap();

    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(&target, &conn, &note_import(&dest)).unwrap();
    assert!(
        !target.data_dir.join("note-assets/note-1/x.png").exists(),
        "the link was followed and its target copied in"
    );
    assert_not_in_pictures(&target, "OPENSSH PRIVATE KEY");
    assert_eq!(
        fs::read(target.data_dir.join("note-assets/note-1/1-shot.png")).unwrap(),
        PICTURE,
        "the listed picture still comes in"
    );
    assert_eq!(report.note_assets_skipped, 1, "{report:?}");
    assert_eq!(
        report.notes,
        vec!["1 picture of note note-1 was not copied (the export doesn't list it).".to_string()]
    );
}

/// A LISTED picture that is a link to a file with the very bytes the manifest hashes: the hash alone can't catch
/// it, the link itself must be refused.
#[cfg(unix)]
#[test]
fn a_listed_picture_that_is_a_link_is_refused_even_when_the_hash_matches() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let outside = TestDir::new("outside");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = note_export(&source, &out.0);
    let picture = dest.join("workspace/note-assets/note-1/1-shot.png");
    fs::write(outside.0.join("same-bytes.png"), PICTURE).unwrap();
    fs::remove_file(&picture).unwrap();
    std::os::unix::fs::symlink(outside.0.join("same-bytes.png"), &picture).unwrap();

    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(&target, &conn, &note_import(&dest)).unwrap();
    assert_eq!(
        files_under(&target.data_dir.join(NOTE_ASSET_DIR)),
        Vec::<String>::new(),
        "a link was followed and its target copied in"
    );
    assert_eq!(report.note_assets_skipped, 1, "{report:?}");
    assert_eq!(
        report.notes,
        vec!["1 picture of note note-1 was not copied (it is a link).".to_string()]
    );
}

/// The picture folder of the note, the folder of all notes' pictures, or the workspace folder is a link to a
/// folder that holds the listed picture (so every listed hash still matches) and one more file.
#[cfg(unix)]
#[test]
fn a_linked_picture_folder_is_never_followed() {
    for linked in [
        "workspace",
        "workspace/note-assets",
        "workspace/note-assets/note-1",
    ] {
        let source_dir = TestDir::new("source");
        let target_dir = TestDir::new("target");
        let outside = TestDir::new("outside");
        let out = TestDir::new("out");
        let source = env_for(&source_dir.0);
        let target = env_for(&target_dir.0);
        let dest = note_export(&source, &out.0);
        let real = dest.join(linked);
        let elsewhere = outside.0.join("moved");
        fs::rename(&real, &elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &real).unwrap();
        // Something the link reaches that the export never listed.
        let reached = if linked == "workspace/note-assets/note-1" {
            elsewhere.clone()
        } else if linked == "workspace/note-assets" {
            elsewhere.join("note-1")
        } else {
            elsewhere.join("note-assets/note-1")
        };
        fs::write(reached.join("unlisted.png"), PRIVATE_KEY).unwrap();

        let store = open_store(&target);
        let conn = store.lock_conn().unwrap();
        let report = import_held(&target, &conn, &note_import(&dest)).unwrap();
        assert_eq!(
            files_under(&target.data_dir.join(NOTE_ASSET_DIR)),
            Vec::<String>::new(),
            "{linked} is a link and was followed"
        );
        assert_not_in_pictures(&target, "OPENSSH PRIVATE KEY");
        assert_eq!(report.note_assets_skipped, 1, "{linked}: {report:?}");
        assert_eq!(
            report.notes,
            vec!["1 picture of note note-1 was not copied (its folder is a link).".to_string()],
            "{linked}"
        );
    }
}

/// A plain file in the picture folder that the manifest doesn't list isn't copied; the listed one is.
#[test]
fn an_unlisted_file_in_a_picture_folder_is_not_copied() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = note_export(&source, &out.0);
    fs::write(
        dest.join("workspace/note-assets/note-1/extra.png"),
        PRIVATE_KEY,
    )
    .unwrap();

    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(&target, &conn, &note_import(&dest)).unwrap();
    assert_eq!(
        files_under(&target.data_dir.join(NOTE_ASSET_DIR)),
        vec!["note-1/1-shot.png".to_string()]
    );
    assert_eq!(report.note_assets_skipped, 1, "{report:?}");
}

/// A listed picture that changes after the export was checked (the import opens, checks every hash, and only then
/// copies) is not copied: what lands is only bytes that hash as the manifest says.
#[test]
fn a_picture_that_changed_after_the_check_is_not_copied() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = note_export(&source, &out.0);
    let opened = open_export(&dest.to_string_lossy()).unwrap();
    // The same call copies the picture while it still hashes as listed.
    assert!(copy_note_assets(&target, &opened, "note-1", "control").is_empty());
    assert_eq!(
        fs::read(target.data_dir.join("note-assets/control/1-shot.png")).unwrap(),
        PICTURE
    );

    let picture = dest.join("workspace/note-assets/note-1/1-shot.png");
    // Swapped for other bytes of the same length (only the hash can tell), then for a longer file (past the size the
    // manifest gives).
    for swapped in [&b"KEYBYTE"[..], PRIVATE_KEY.as_bytes()] {
        assert_eq!(swapped.len() == PICTURE.len(), swapped == b"KEYBYTE");
        fs::write(&picture, swapped).unwrap();
        let left_out = copy_note_assets(&target, &opened, "note-1", "note-1");
        assert_eq!(left_out, vec!["it changed after the export was checked"]);
        assert_eq!(
            files_under(&target.data_dir.join(NOTE_ASSET_DIR)),
            vec!["control/1-shot.png".to_string()]
        );
    }
    assert_not_in_pictures(&target, "OPENSSH PRIVATE KEY");
    assert_not_in_pictures(&target, "KEYBYTE");
}

/// A note id is one plain name. `..` would read the export's workspace folder as pictures, or write them beside the
/// data folder's own files.
#[test]
fn a_note_id_that_is_not_one_plain_name_copies_nothing() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = note_export(&source, &out.0);
    let opened = open_export(&dest.to_string_lossy()).unwrap();
    open_store(&target);
    // A plain id copies.
    assert!(copy_note_assets(&target, &opened, "note-1", "note-1").is_empty());
    let before = files_under(&target.data_dir);
    assert!(before.contains(&"note-assets/note-1/1-shot.png".to_string()));

    for (from, to) in [
        ("..", "note-1"),
        (".", "note-1"),
        ("note-1/../..", "note-1"),
        ("", "note-1"),
        ("note-1", ".."),
        ("note-1", "../escape"),
        ("note-1", "a/b"),
        ("note-1", ""),
    ] {
        assert_eq!(
            copy_note_assets(&target, &opened, from, to),
            vec!["the note's id isn't one plain name"],
            "from {from:?} to {to:?}"
        );
        assert_eq!(
            files_under(&target.data_dir),
            before,
            "from {from:?} to {to:?} wrote something"
        );
    }
}

/// The normal case: a listed picture that hashes as listed comes in, owner-only; one already here is kept; a hidden
/// file the Finder leaves in the folder is passed over without a word.
#[test]
fn a_listed_picture_that_hashes_as_listed_is_copied_and_never_replaces_one_already_here() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = note_export(&source, &out.0);
    fs::write(dest.join("workspace/note-assets/note-1/.DS_Store"), "junk").unwrap();

    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(&target, &conn, &note_import(&dest)).unwrap();
    let picture = target.data_dir.join("note-assets/note-1/1-shot.png");
    assert_eq!(fs::read(&picture).unwrap(), PICTURE);
    assert_eq!(
        files_under(&target.data_dir.join(NOTE_ASSET_DIR)),
        vec!["note-1/1-shot.png".to_string()]
    );
    assert_eq!(report.note_assets_skipped, 0, "{report:?}");
    assert!(report.notes.is_empty(), "{:?}", report.notes);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&picture).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    // A second restore of the same note into a copy of the data folder that kept its own picture: that one stays.
    let opened = open_export(&dest.to_string_lossy()).unwrap();
    fs::write(&picture, "mine").unwrap();
    assert!(copy_note_assets(&target, &opened, "note-1", "note-1").is_empty());
    assert_eq!(fs::read_to_string(&picture).unwrap(), "mine");
}

/// A chat file as another machine, or someone writing one by hand, could make it: every place a block can name a
/// file on disk, with paths that mean something on the machine that wrote them.
fn crafted_chat() -> Value {
    json!({
        "title": "Crafted",
        "cwd": "/tmp",
        "engine": {"harness": "claude", "model": "m", "runtimeMode": "auto"},
        "blocks": [
            {"id": "u1", "role": "user", "text": "look", "attachments": [
                {"id": "a1", "name": "id_rsa", "mimeType": "application/octet-stream", "kind": "file", "size": 1679,
                 "path": "/Users/someone/.ssh/id_rsa"},
                {"id": "a2", "name": "shot.png", "mimeType": "image/png", "kind": "image", "size": 10,
                 "path": "/Users/someone/Desktop/shot.png", "copyFromPath": true}
            ]},
            {"id": "i1", "role": "image", "text": "",
             "image": {"path": "/Users/someone/.ssh/leak.png", "name": "generated-image", "mimeType": "image/png",
                       "size": 10, "alt": "a cat"}},
            {"id": "t1", "role": "tool", "text": "", "tool": {"title": "Read", "preview": {"kind": "read", "path": "/Users/someone/notes.md"}}},
            {"id": "a3", "role": "assistant", "text": "done", "btwThreads": [
                {"id": "th", "sourceEndBlockId": "a3", "createdAt": 1, "updatedAt": 2, "status": "ready", "messages": [
                    {"id": "m1", "role": "assistant", "text": "x", "createdAt": 1, "blocks": [
                        {"id": "bi", "role": "image", "text": "",
                         "image": {"path": "/etc/hosts.png", "name": "side", "mimeType": "image/png", "size": 1}},
                        {"id": "bu", "role": "user", "text": "", "attachments": [
                            {"id": "z", "name": "passwd", "mimeType": "text/plain", "kind": "file", "size": 1, "path": "/etc/passwd"}
                        ]}
                    ]}
                ]}
            ]}
        ]
    })
}

const FOREIGN_PATHS: [&str; 6] = [
    "/Users/someone/.ssh/id_rsa",
    "/Users/someone/Desktop/shot.png",
    "/Users/someone/.ssh/leak.png",
    "/etc/hosts.png",
    "/etc/passwd",
    "copyFromPath",
];

#[test]
fn an_imported_chat_keeps_no_file_path_from_the_file() {
    let source_dir = TestDir::new("paths-source");
    let target_dir = TestDir::new("paths-target");
    let out = TestDir::new("paths-out");
    let source = env_for(&source_dir.0);
    let store = open_store(&source);
    let conn = store.lock_conn().unwrap();
    add_session(
        &conn,
        "plain",
        "Plain",
        "claude",
        json!([block("p", "user", "hi")]),
        1_000,
    );
    drop(conn);
    drop(store);
    let dest = out.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.files.clear();
    export(&source, &request).unwrap();
    // The export is crafted: its chat file names files the importing Mac has, whatever machine wrote it.
    put_in_export(
        &dest,
        "workspace/sessions/crafted.json",
        crafted_chat().to_string().as_bytes(),
    );

    let target = env_for(&target_dir.0);
    let target_store = open_store(&target);
    let conn = target_store.lock_conn().unwrap();
    let report = import_held(
        &target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(WorkspaceImport {
                sessions: vec!["crafted".into(), "plain".into()],
                ..Default::default()
            }),
        },
    )
    .unwrap();
    assert_eq!(report.sessions_added, 2);

    let stored = session_store::get_session(&conn, "crafted")
        .unwrap()
        .unwrap();
    let text = stored.blocks.to_string();
    for foreign in FOREIGN_PATHS {
        assert!(
            !text.contains(foreign),
            "{foreign} survived the import: {text}"
        );
    }
    let blocks = stored.blocks.as_array().unwrap();
    // Every block is still there, in order.
    let ids: Vec<&str> = blocks.iter().map(|b| b["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["u1", "i1", "t1", "a3"]);
    // An image block keeps what it says about the picture and says its file is not here: an empty path.
    assert_eq!(
        blocks[1]["image"],
        json!({"path": "", "name": "generated-image", "mimeType": "image/png", "size": 10, "alt": "a cat"})
    );
    // An attachment keeps its name and kind, and no path.
    assert_eq!(
        blocks[0]["attachments"],
        json!([
            {"id": "a1", "name": "id_rsa", "mimeType": "application/octet-stream", "kind": "file", "size": 1679},
            {"id": "a2", "name": "shot.png", "mimeType": "image/png", "kind": "image", "size": 10}
        ])
    );
    // A side thread's blocks are held to the same rule.
    let side = &blocks[3]["btwThreads"][0]["messages"][0]["blocks"];
    assert_eq!(side[0]["image"]["path"], "");
    assert_eq!(side[0]["image"]["name"], "side");
    assert_eq!(side[1]["attachments"][0].get("path"), None);
    assert_eq!(side[1]["attachments"][0]["name"], "passwd");
    // A tool row's path outside the chat's kept folder goes too (folders.rs): this chat's `/tmp` is no project here,
    // so it keeps no folder and no tool path. The row itself stays.
    assert_eq!(blocks[2]["tool"]["preview"].get("path"), None);
    assert_eq!(blocks[2]["tool"]["title"], "Read");
    assert_eq!(blocks[3]["text"], "done");
    // The chat that named no file comes back as it was, and the import says what it left out.
    let plain = session_store::get_session(&conn, "plain").unwrap().unwrap();
    assert_eq!(plain.blocks, json!([block("p", "user", "hi")]));
    assert!(
        report.notes.iter().any(|n| n.contains("5 file paths")),
        "{:?}",
        report.notes
    );

    // Looking at the same file again finds the chat already here: paths are not what makes two chats differ.
    let again = inspect(&target, &dest.to_string_lossy()).unwrap();
    let status = |id: &str| {
        again
            .workspace
            .as_ref()
            .unwrap()
            .sessions
            .iter()
            .find(|session| session.id == id)
            .unwrap()
            .status
    };
    assert_eq!(status("crafted"), Status::Same);
    assert_eq!(status("plain"), Status::Same);
    // The Mac that made the export, with its paths in place, sees the same.
    let from_source = inspect(&source, &dest.to_string_lossy()).unwrap();
    assert_eq!(
        from_source
            .workspace
            .unwrap()
            .sessions
            .iter()
            .find(|s| s.id == "plain")
            .unwrap()
            .status,
        Status::Same
    );
}

#[test]
fn an_imported_mono_transcript_index_holds_no_file_path_either() {
    let target_dir = TestDir::new("paths-mono");
    let target = env_for(&target_dir.0);
    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let mut file = crafted_chat();
    file["monoTranscript"] = json!(true);
    insert_session(
        &target,
        &conn,
        "mono-chat",
        "Mono",
        &file,
        &FolderRules::load(&target, &[], &[], &[], &[]),
    )
    .unwrap();
    crate::mono_transcript::migrate_transcript(&conn, "mono-chat").unwrap();

    let indexed: Vec<String> = conn
        .prepare("SELECT block_json FROM mono_blocks WHERE session_id = 'mono-chat' ORDER BY seq")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(indexed.len(), 4, "the transcript was indexed");
    for row in &indexed {
        for foreign in FOREIGN_PATHS {
            assert!(!row.contains(foreign), "{foreign} in the index: {row}");
        }
    }
    let paths = crate::mono_transcript::generated_image_paths(&conn, "mono-chat").unwrap();
    assert!(paths.iter().all(String::is_empty), "{paths:?}");
}

#[test]
fn odd_shapes_in_an_imported_chat_are_dropped_not_kept_and_do_not_fail_the_import() {
    let target_dir = TestDir::new("paths-odd");
    let target = env_for(&target_dir.0);
    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let file = json!({
        "title": "Odd",
        "cwd": "/tmp",
        "engine": {"harness": "claude", "model": "m", "runtimeMode": "auto"},
        "blocks": [
            {"id": "n", "role": "image", "text": "", "image": {"path": 7, "name": "n", "mimeType": "image/png", "size": 1}},
            {"id": "r", "role": "image", "text": "", "image": {"path": "../../.ssh/id_rsa", "name": "r", "mimeType": "image/png", "size": 1}},
            {"id": "a", "role": "user", "text": "", "attachments": null},
            {"id": "b", "role": "user", "text": "", "attachments": ["not an object", {"id": "c", "name": "c", "path": 5}]},
            {"id": "e", "role": "image", "text": "", "image": null},
            {"id": "w", "role": "assistant", "text": "", "btwThreads": [{"id": "t", "pendingBlocks": [
                {"id": "p", "role": "user", "text": "", "attachments": [{"id": "d", "name": "d", "path": "/etc/shadow"}]}
            ]}]}
        ]
    });
    insert_session(
        &target,
        &conn,
        "odd",
        "Odd",
        &file,
        &FolderRules::load(&target, &[], &[], &[], &[]),
    )
    .unwrap();
    let stored = session_store::get_session(&conn, "odd").unwrap().unwrap();
    let text = stored.blocks.to_string();
    for foreign in ["../../.ssh/id_rsa", "/etc/shadow"] {
        assert!(!text.contains(foreign), "{foreign}: {text}");
    }
    let blocks = stored.blocks.as_array().unwrap();
    assert_eq!(blocks[0]["image"]["path"], "");
    assert_eq!(blocks[1]["image"]["path"], "");
    assert_eq!(blocks[3]["attachments"][1].get("path"), None);
    assert_eq!(
        blocks[5]["btwThreads"][0]["pendingBlocks"][0]["attachments"][0].get("path"),
        None
    );
}

// ---- round 3: an allow-list, rules loaded before anything is written, nothing a file chooses about how a chat runs ------

/// A target copy's own folders for the places a Mac keeps besides projects.
fn hidden_places(layout: &Layout) -> Vec<(&'static str, String)> {
    let home = layout.target.home.clone().unwrap();
    for dir in [".claude", ".ssh", "Library/LaunchAgents", "agent-memory"] {
        fs::create_dir_all(home.join(dir)).unwrap();
    }
    fs::create_dir_all(layout.project.join(".hidden")).unwrap();
    vec![
        ("claude", path(&home, ".claude")),
        ("ssh", path(&home, ".ssh")),
        ("launch", path(&home, "Library/LaunchAgents")),
        ("memory", path(&home, "agent-memory")),
        ("hidden", path(&layout.project, ".hidden")),
        ("dotgit", path(&layout.project, ".git")),
        ("data", "/System/Volumes/Data".to_string()),
        ("private", "/private".to_string()),
        ("privatetmp", "/private/tmp".to_string()),
        ("shared", "/Users/Shared".to_string()),
        ("apps", "/Applications".to_string()),
        ("library", "/Library".to_string()),
        ("backup", "/Volumes/Backup".to_string()),
    ]
}

#[test]
fn a_chat_is_kept_only_inside_the_home_folder_whatever_a_record_or_the_rail_says() {
    let layout = layout();
    let places = hidden_places(&layout);
    let home = layout.target.home.clone().unwrap();
    // The record and the rail both vouch for these places; none of them may.
    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    let mut listed: Vec<Value> =
        vec![json!({"id": "app", "name": "App", "folder": layout.project.to_string_lossy()})];
    listed.extend(
        places
            .iter()
            .map(|(id, folder)| json!({"id": id, "name": id, "folder": folder})),
    );
    crate::local_hub::write(&conn, "projects", &json!({"projects": listed})).unwrap();
    drop(conn);
    drop(store);
    let rail: Vec<String> = places.iter().map(|(_, folder)| folder.clone()).collect();
    let chats: Vec<(&str, String, Option<String>)> = places
        .iter()
        .map(|(id, folder)| (*id, folder.clone(), None))
        .chain([("fine", path(&layout.project, "src"), None)])
        .collect();
    let (stored, report) = import_folders(&layout, &chats, &rail);
    for (id, _) in &places {
        assert_eq!(stored[*id].0, "", "{id} is not a place for a chat");
    }
    assert_eq!(stored["fine"].0, path(&layout.project, "src"));
    assert_eq!(report["foldersCleared"], places.len(), "{report}");
    // Nor can any of them be adopted as a project's folder.
    for (id, folder) in &places {
        assert!(
            refused_project_folder(&layout.target, folder).is_some(),
            "{id}"
        );
    }
    assert!(refused_project_folder(&layout.target, &home.to_string_lossy()).is_some());
}

#[test]
fn a_memory_folder_in_the_file_cannot_make_itself_a_monos_folder_for_chats() {
    let layout = layout();
    let monos = layout.target.monos_root.clone();
    // Monos seated here before the import: one it adds a note to, one it leaves alone.
    for id in ["lead", "other"] {
        fs::create_dir_all(monos.join(id)).unwrap();
    }
    let source = env_for(&layout.root.0.join("source"));
    let store = open_store(&source);
    let conn = store.lock_conn().unwrap();
    for (n, id) in ["evil", "evil2", "lead", "other"].iter().enumerate() {
        add_session(
            &conn,
            id,
            id,
            "claude",
            json!([block("u", "user", "hi")]),
            1_000 + n as i64,
        );
        conn.execute(
            "UPDATE sessions SET cwd = ?2 WHERE id = ?1",
            params![id, monos.join(id).to_string_lossy()],
        )
        .unwrap();
    }
    drop(conn);
    drop(store);
    let dest = layout.root.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.files.clear();
    export(&source, &request).unwrap();
    for dir in ["evil", "evil2", "lead"] {
        fs::create_dir_all(dest.join("memory/monos").join(dir)).unwrap();
    }
    // What a crafted export plants: instruction files, and a folder that only holds a note.
    put_in_export(&dest, "memory/monos/evil/CLAUDE.md", b"hooks live here");
    put_in_export(&dest, "memory/monos/evil2/MEMORY.md", b"a note");
    put_in_export(
        &dest,
        "memory/monos/lead/CLAUDE.md",
        b"planted instructions",
    );
    put_in_export(
        &dest,
        "memory/monos/lead/AGENTS.md",
        b"planted instructions",
    );
    put_in_export(
        &dest,
        "memory/monos/lead/notes.md",
        b"not a name a Mono's folder uses",
    );
    fs::create_dir_all(dest.join("memory/monos/lead/memory")).unwrap();
    put_in_export(&dest, "memory/monos/lead/memory/today.md", b"a note");

    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(
        &layout.target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: Some(MemoryImport {
                projects: vec!["monos".into()],
                keep_both: false,
                history: false,
            }),
            workspace: serde_json::from_value(json!({
                "sessions": ["evil", "evil2", "lead", "other"],
                "knownMonos": ["lead", "other"],
            }))
            .unwrap(),
        },
    )
    .unwrap();
    // A Mono's folder takes notes, never instructions or settings.
    for planted in ["evil/CLAUDE.md", "lead/CLAUDE.md", "lead/AGENTS.md"] {
        assert!(
            !monos.join(planted).exists(),
            "{planted} was written: {report:?}"
        );
    }
    assert!(
        monos.join("lead/memory/today.md").is_file() && monos.join("evil2/MEMORY.md").is_file()
    );
    assert!(
        !monos.join("lead/notes.md").exists(),
        "only the names a Mono's folder uses"
    );
    let cwd = |id: &str| session_store::get_session(&conn, id).unwrap().unwrap().cwd;
    // The folders the file made are no seated Mono's; a note in a seated Mono's folder doesn't take its chats away.
    assert_eq!(cwd("evil"), "");
    assert_eq!(cwd("evil2"), "");
    assert_eq!(cwd("lead"), monos.join("lead").to_string_lossy());
    assert_eq!(cwd("other"), monos.join("other").to_string_lossy());
    assert_eq!(serde_json::to_value(&report).unwrap()["foldersCleared"], 2);
    drop(conn);
    drop(store);
    // And nothing is offered back for them: neither is a seated Mono's, so neither passes.
    assert_eq!(
        relink_candidates(&layout.target, None, &[], &["lead".into(), "other".into()]),
        Vec::<Relink>::new()
    );
}

#[test]
fn a_chat_is_not_kept_where_the_import_wrote_instructions_and_is_never_offered_back() {
    let layout = layout();
    let monos = layout.target.monos_root.clone();
    let lead = monos.join("lead");
    fs::create_dir_all(lead.join("notes")).unwrap();
    let mut rules = FolderRules::load(&layout.target, &[], &[], &["lead".into()], &[]);
    let wrote = |path: PathBuf, rules: &mut FolderRules| rules.note_written(&[path]);
    // A note beside or below it, or a folder that merely holds a written file further down, takes nothing away.
    wrote(lead.join("notes/today.md"), &mut rules);
    wrote(monos.join("MEMORY.md"), &mut rules);
    let kept = rules.vet(Some(&lead.to_string_lossy()), None);
    assert_eq!(kept.cwd, lead.to_string_lossy());
    assert!(!kept.named_blocked);
    // An instruction file a CLI would read from that folder or above it does.
    for planted in [
        lead.join("CLAUDE.md"),
        monos.join("AGENTS.md"),
        lead.join(".claude/settings.json"),
    ] {
        let mut rules = FolderRules::load(&layout.target, &[], &[], &["lead".into()], &[]);
        rules.note_written(std::slice::from_ref(&planted));
        let cleared = rules.vet(Some(&lead.to_string_lossy()), None);
        assert_eq!(cleared.cwd, "", "{} must clear the chat", planted.display());
        assert!(
            cleared.cleared && cleared.named_blocked,
            "{}",
            planted.display()
        );
    }
}

#[test]
fn a_chat_from_another_mac_finds_its_monos_folders_here_by_id() {
    let layout = layout();
    let team = layout.target.data_dir.join("mono-teams/lead");
    let home = layout.target.monos_root.join("lead");
    fs::create_dir_all(&team).unwrap();
    fs::create_dir_all(&home).unwrap();
    let chats = [
        (
            "team",
            "/Users/someone/Library/Application Support/com.ash.monocode-hub/mono-teams/lead"
                .to_string(),
            None,
        ),
        (
            "home",
            "/Users/someone/agent-memory/monos/lead".to_string(),
            None,
        ),
        (
            "stranger",
            "/Users/someone/agent-memory/monos/evil".to_string(),
            None,
        ),
        ("dots", "/Users/someone/mono-teams/..".to_string(), None),
    ];
    let (stored, report) = import_folders_with(&layout, &chats, &[], &["lead"], &[]);
    assert_eq!(stored["team"].0, team.to_string_lossy());
    assert_eq!(stored["home"].0, home.to_string_lossy());
    assert_eq!(stored["stranger"].0, "");
    assert_eq!(stored["dots"].0, "");
    assert_eq!(report["foldersCleared"], 2, "{report}");
}

#[test]
fn a_worktree_listed_by_a_parent_repository_is_not_vouched_for() {
    let layout = layout();
    let home = layout.target.home.clone().unwrap();
    // The project is a plain folder inside a bigger repository (a dotfiles repo, say).
    let parent = home.join("Projects");
    fs::remove_dir_all(layout.project.join(".git")).unwrap();
    git(&parent, &["init", "-q"]);
    fs::write(parent.join("a.txt"), "a").unwrap();
    git(&parent, &["add", "."]);
    git(&parent, &["commit", "-q", "-m", "first"]);
    let linked = home.join("Worktrees/linked");
    git(
        &parent,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "linked",
            &linked.to_string_lossy(),
        ],
    );
    fs::create_dir_all(parent.join("other")).unwrap();
    let project = layout.project.to_string_lossy().into_owned();
    let chats = [
        // Inside the parent repository, not inside the project: its main worktree line must not vouch for it.
        ("main", project.clone(), Some(path(&parent, "other"))),
        // A linked working copy of the parent repository, not of the project.
        (
            "linked",
            project.clone(),
            Some(linked.to_string_lossy().into_owned()),
        ),
        ("plain", project.clone(), None),
    ];
    let (stored, report) = import_folders(&layout, &chats, &[]);
    assert_eq!(stored["main"], (project.clone(), None));
    assert_eq!(stored["linked"], (project.clone(), None));
    assert_eq!(stored["plain"], (project, None));
    assert_eq!(report["foldersCleared"], 2, "{report}");
}

#[test]
fn a_worktree_belongs_to_the_chats_own_project() {
    let layout = layout();
    let p = &layout.project;
    git(p, &["init", "-q"]);
    fs::write(p.join("a.txt"), "a").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "first"]);
    let home = layout.target.home.clone().unwrap();
    let tree = home.join("Worktrees/app-feature");
    git(
        p,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            &tree.to_string_lossy(),
        ],
    );
    // A second known project: the worktree is the first one's, not this one's.
    let other = home.join("Projects/other");
    fs::create_dir_all(other.join(".git")).unwrap();
    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    crate::local_hub::write(
        &conn,
        "projects",
        &json!({"projects": [
            {"id": "app", "name": "App", "folder": p.to_string_lossy()},
            {"id": "other", "name": "Other", "folder": other.to_string_lossy()}
        ]}),
    )
    .unwrap();
    drop(conn);
    drop(store);
    let tree = tree.to_string_lossy().into_owned();
    let chats = [
        ("own", p.to_string_lossy().into_owned(), Some(tree.clone())),
        (
            "foreign",
            other.to_string_lossy().into_owned(),
            Some(tree.clone()),
        ),
    ];
    let (stored, report) = import_folders(&layout, &chats, &[]);
    assert_eq!(stored["own"].1.as_deref(), Some(tree.as_str()));
    assert_eq!(
        stored["foreign"],
        (other.to_string_lossy().into_owned(), None)
    );
    assert_eq!(report["foldersCleared"], 1, "{report}");
}

#[test]
fn an_imported_chat_and_automation_come_in_supervised_whatever_the_file_says() {
    let layout = layout();
    let source = env_for(&layout.root.0.join("source"));
    let store = open_store(&source);
    let conn = store.lock_conn().unwrap();
    add_session(
        &conn,
        "free",
        "Free",
        "claude",
        json!([block("u", "user", "hi")]),
        1_000,
    );
    conn.execute(
        "UPDATE sessions SET runtime_mode = 'full-access' WHERE id = 'free'",
        [],
    )
    .unwrap();
    let definition = json!({"id": "bypass", "name": "b", "prompt": "p", "harness": "claude", "model": "m", "cwd": path(&layout.project, "src"),
        "runtimeMode": "full-access", "enabled": true, "nextRunAt": 99_000, "updatedAt": 50});
    conn.execute(
        "INSERT INTO automations (id, definition_json, enabled, next_run_at, updated_at) VALUES ('bypass', ?1, 1, 99000, 50)",
        params![definition.to_string()],
    )
    .unwrap();
    drop(conn);
    drop(store);
    let dest = layout.root.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.files.clear();
    export(&source, &request).unwrap();
    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    import_held(
        &layout.target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(WorkspaceImport {
                sessions: vec!["free".into()],
                automations: vec!["bypass".into()],
                ..Default::default()
            }),
        },
    )
    .unwrap();
    let chat = session_store::get_session(&conn, "free").unwrap().unwrap();
    assert_eq!(chat.runtime_mode, "supervised");
    let raw: String = conn
        .query_row(
            "SELECT definition_json FROM automations WHERE id = 'bypass'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let stored: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(stored["runtimeMode"], "supervised");
    assert_eq!(stored["enabled"], false);
}

#[test]
fn a_delegation_stays_only_when_both_its_chats_came_in_and_is_always_history() {
    let layout = layout();
    let source = env_for(&layout.root.0.join("source"));
    let store = open_store(&source);
    let conn = store.lock_conn().unwrap();
    for (n, id) in ["one", "two", "here"].iter().enumerate() {
        add_session(
            &conn,
            id,
            id,
            "claude",
            json!([block("u", "user", "hi")]),
            1_000 + n as i64,
        );
    }
    for (id, owner, child, state) in [
        ("d-in", "one", "two", "running"),
        ("d-odd", "one", "two", "who-knows"),
        // Names a chat this import doesn't bring: it is not the file's to attach history to.
        ("d-out", "one", "here", "completed"),
    ] {
        conn.execute(
            "INSERT INTO delegations (id, owner_session, owner_mono, root_id, child_session, request_id, title, brief, state, delivery, created_at, updated_at, version, mirrored_version)
             VALUES (?1, ?2, NULL, ?1, ?3, ?1, 'T', 'b', ?4, 'pending', 100, 200, 3, 3)",
            params![id, owner, child, state],
        )
        .unwrap();
    }
    drop(conn);
    drop(store);
    let dest = layout.root.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.files.clear();
    export(&source, &request).unwrap();
    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(
        &layout.target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(WorkspaceImport {
                sessions: vec!["one".into(), "two".into()],
                delegations: true,
                ..Default::default()
            }),
        },
    )
    .unwrap();
    assert_eq!(report.delegations_added, 2, "{report:?}");
    let state = |id: &str| {
        table_rows_where(&conn, "delegations", id)
            .unwrap()
            .map(|row| row["state"].clone())
    };
    assert_eq!(state("d-in"), Some(json!("cancelled")));
    assert_eq!(state("d-odd"), Some(json!("cancelled")));
    assert_eq!(state("d-out"), None);
}

#[test]
fn a_cleared_folder_is_kept_as_an_inert_note_and_offered_back_only_when_it_passes() {
    let layout = layout();
    let later = path(&layout.project, "later");
    let chats = [
        ("away", "/tmp/elsewhere".to_string(), None),
        ("later", later.clone(), None),
        ("kept", path(&layout.project, "src"), None),
    ];
    let (stored, _) = import_folders(&layout, &chats, &[]);
    // The project's `later` folder doesn't exist yet, so the chat came in without a folder.
    assert_eq!(stored["later"].0, "");
    let note = |id: &str| -> Option<String> {
        let store = open_store(&layout.target);
        let conn = store.lock_conn().unwrap();
        conn.query_row(
            "SELECT cwd FROM imported_chat_folders WHERE session_id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    };
    assert_eq!(note("away").as_deref(), Some("/tmp/elsewhere"));
    assert_eq!(note("later"), Some(later.clone()));
    assert_eq!(note("kept"), None);
    // Nothing runs from the note: the chat's own folder is still blank.
    let offer = |id: &str| relink_candidate(&layout.target, id, &[], &[]);
    assert_eq!(offer("later"), None);
    fs::create_dir_all(&later).unwrap();
    assert_eq!(offer("later"), Some(later));
    // A folder outside every project is never offered; neither is one for a chat that has a folder.
    assert_eq!(offer("away"), None);
    assert_eq!(offer("kept"), None);
}

#[test]
fn paths_in_side_threads_and_agent_steps_are_confined_and_a_paths_that_is_not_a_list_is_dropped() {
    let layout = layout();
    let outside = path(&layout.outside, "secret.txt");
    let step = json!({"paths": [outside.clone(), "src/a.rs"], "preview": {"kind": "diff", "path": outside.clone(), "steps": [
        {"preview": {"path": outside.clone()}, "paths": outside.clone()}]}});
    let blocks = vec![
        json!({"id": "t", "role": "tool", "tool": {"paths": outside.clone(), "preview": {"kind": "diff", "steps": [step]}}}),
        json!({"id": "b", "role": "assistant", "btwThreads": [{"messages": [
            {"role": "tool", "tool": {"paths": [outside.clone(), "src/ok.rs"], "preview": {"path": outside.clone()}}}]}]}),
    ];
    let (stored, report) = import_blocks(&layout, &layout.project.to_string_lossy(), blocks);
    let text = serde_json::to_string(&stored).unwrap();
    assert!(!text.contains(&outside), "an outside path survived: {text}");
    assert!(text.contains("src/a.rs") && text.contains("src/ok.rs"));
    assert!(
        stored[1]["tool"].get("paths").is_none(),
        "a paths that isn't a list is dropped"
    );
    assert!(
        report["toolPathsDropped"].as_u64().unwrap() >= 6,
        "{report}"
    );
}

// ---- round 4: restores of your own export, relinking, and what a Mono's folder may be given ----------------------------

#[test]
fn a_chat_from_another_user_or_home_is_mapped_to_the_project_here_by_id() {
    let layout = layout();
    let old = "/Users/old/Projects/app";
    let map = [("app", old, layout.project.to_string_lossy().into_owned())];
    let chats = [
        ("deep", format!("{old}/src/deep"), None),
        ("root", old.to_string(), None),
        // A sibling of the mapped folder is not inside it.
        ("sibling", "/Users/old/Projects/app-evil".to_string(), None),
        // A project the window has no pair for stays unknown.
        ("stranger", "/Users/old/Projects/other".to_string(), None),
    ];
    let (stored, report) = import_folders_with(&layout, &chats, &[], &[], &map);
    assert_eq!(stored["deep"].0, path(&layout.project, "src/deep"));
    assert_eq!(stored["root"].0, layout.project.to_string_lossy());
    assert_eq!(stored["sibling"].0, "");
    assert_eq!(stored["stranger"].0, "");
    assert_eq!(report["foldersCleared"], 2, "{report}");
    // The same allow-list judges the mapped folder: a pair that leads outside the home folder keeps nothing.
    let escape = [(
        "x",
        "/Users/old/x",
        layout.outside.to_string_lossy().into_owned(),
    )];
    let (stored, _) = import_folders_with(
        &layout_again(&layout),
        &[("away", "/Users/old/x/y".to_string(), None)],
        &[],
        &[],
        &escape,
    );
    assert_eq!(stored["away"].0, "");
}

/// A fresh layout beside the first one (a second import into the same root would collide with the first export).
fn layout_again(first: &Layout) -> Layout {
    let _ = first;
    layout()
}

#[test]
fn a_mapped_folder_that_isnt_cloned_yet_is_offered_back_once_it_is_and_all_at_once() {
    let layout = layout();
    let old = "/Users/old/Projects/app";
    let later = layout.project.parent().unwrap().join("later");
    let map = [(
        "later",
        "/Users/old/Projects/later",
        later.to_string_lossy().into_owned(),
    )];
    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    // The project record has the folder (a project registered before the repository is cloned).
    crate::local_hub::write(
        &conn,
        "projects",
        &json!({"projects": [
            {"id": "app", "name": "App", "folder": layout.project.to_string_lossy()},
            {"id": "later", "name": "Later", "folder": later.to_string_lossy()}
        ]}),
    )
    .unwrap();
    drop(conn);
    drop(store);
    let chats = [
        ("a", "/Users/old/Projects/later/src".to_string(), None),
        ("b", "/Users/old/Projects/later".to_string(), None),
        ("c", format!("{old}/src"), None),
    ];
    let map = [
        map[0].clone(),
        ("app", old, layout.project.to_string_lossy().into_owned()),
    ];
    let (stored, _) = import_folders_with(&layout, &chats, &[], &[], &map);
    // `later` isn't there yet, so its chats came in with none; `app` is.
    assert_eq!(stored["a"].0, "");
    assert_eq!(stored["b"].0, "");
    assert_eq!(stored["c"].0, path(&layout.project, "src"));
    let offers = |env: &Env| relink_candidates(env, None, &[], &[]);
    assert!(offers(&layout.target).is_empty());
    fs::create_dir_all(later.join("src")).unwrap();
    let mut found = offers(&layout.target);
    found.sort_by(|x, y| x.session_id.cmp(&y.session_id));
    assert_eq!(
        found
            .iter()
            .map(|r| r.session_id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    // One group for the project, so one "Relink all".
    assert!(
        found.iter().all(|r| r.group == later.to_string_lossy()),
        "{found:?}"
    );
    // Relinking gives the folders back and forgets the notes; a chat that has a folder is left alone.
    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    let applied = apply_relinks(&conn, &found).unwrap();
    assert_eq!(applied.len(), 2);
    let cwd = |id: &str| session_store::get_session(&conn, id).unwrap().unwrap().cwd;
    assert_eq!(cwd("a"), path(&later, "src"));
    assert_eq!(cwd("b"), later.to_string_lossy());
    let notes: i64 = conn
        .query_row("SELECT COUNT(*) FROM imported_chat_folders", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(notes, 0);
    assert!(apply_relinks(&conn, &found).unwrap().is_empty());
    // A folder the import itself wrote instructions into is never offered, however well it qualifies.
    conn.execute("UPDATE sessions SET cwd = '' WHERE id = 'c'", [])
        .unwrap();
    conn.execute(
        "INSERT INTO imported_chat_folders (session_id, cwd, worktree_cwd, blocked) VALUES ('c', ?1, NULL, 1)",
        [path(&layout.project, "src")],
    )
    .unwrap();
    drop(conn);
    drop(store);
    assert!(offers(&layout.target).is_empty());
}

#[test]
fn a_seated_monos_folder_the_restore_made_keeps_its_chats_but_only_for_a_seated_mono() {
    let layout = layout();
    let monos = layout.target.monos_root.clone();
    let source = env_for(&layout.root.0.join("source"));
    let store = open_store(&source);
    let conn = store.lock_conn().unwrap();
    for (n, id) in ["lead", "guest"].iter().enumerate() {
        add_session(
            &conn,
            id,
            id,
            "claude",
            json!([block("u", "user", "hi")]),
            1_000 + n as i64,
        );
        conn.execute(
            "UPDATE sessions SET cwd = ?2 WHERE id = ?1",
            params![id, format!("/Users/old/agent-memory/monos/{id}")],
        )
        .unwrap();
    }
    drop(conn);
    drop(store);
    let dest = layout.root.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.files.clear();
    export(&source, &request).unwrap();
    for id in ["lead", "guest"] {
        fs::create_dir_all(dest.join("memory/monos").join(id)).unwrap();
        put_in_export(&dest, &format!("memory/monos/{id}/MEMORY.md"), b"- notes\n");
    }
    // A Mono's folder isn't here until the restore makes it: the rules look after the memory is written.
    assert!(!monos.join("lead").exists());
    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    import_held(
        &layout.target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: Some(MemoryImport {
                projects: vec!["monos".into()],
                keep_both: false,
                history: false,
            }),
            workspace: serde_json::from_value(json!({
                "sessions": ["lead", "guest"],
                "knownMonos": ["lead"],
            }))
            .unwrap(),
        },
    )
    .unwrap();
    let cwd = |id: &str| session_store::get_session(&conn, id).unwrap().unwrap().cwd;
    assert_eq!(cwd("lead"), monos.join("lead").to_string_lossy());
    assert_eq!(cwd("guest"), "");
}

#[test]
fn a_restored_monos_history_keeps_only_its_notes() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let mut target = env_for(&target_dir.0);
    target.monos_root = target.memory_root.join("monos");
    let monos = source.memory_root.join("monos");
    fs::create_dir_all(monos.join("evil")).unwrap();
    fs::create_dir_all(monos.join(".claude")).unwrap();
    fs::write(monos.join("MEMORY.md"), "# monos\n").unwrap();
    fs::write(monos.join("evil/notes.md"), "a note\n").unwrap();
    fs::write(monos.join("evil/CLAUDE.md"), "planted\n").unwrap();
    fs::write(monos.join(".claude/settings.json"), "{\"hooks\":{}}\n").unwrap();
    git(&monos, &["init", "-q", "-b", "main"]);
    git(&monos, &["add", "-A"]);
    git(&monos, &["commit", "-q", "-m", "monos"]);
    let dest = out.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.workspace = false;
    request.memory = Some(MemoryChoice {
        projects: vec!["monos".into()],
        history: true,
    });
    export(&source, &request).unwrap();
    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(
        &target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: Some(MemoryImport {
                projects: vec!["monos".into()],
                keep_both: false,
                history: true,
            }),
            workspace: None,
        },
    )
    .unwrap();
    let root = target.memory_root.join("monos");
    assert!(root.join("evil/notes.md").is_file(), "{report:?}");
    assert!(!root.join("evil/CLAUDE.md").exists());
    assert!(!root.join(".claude/settings.json").exists());
}

#[test]
fn a_provider_conversation_is_kept_only_for_the_chat_it_belongs_to() {
    let layout = layout();
    let mut env = layout.target.clone();
    env.dev = false;
    let home = env.home.clone().unwrap();
    env.claude_home = Some(home.join(".claude"));
    let transcripts = |folder: &Path| {
        let dir = env
            .claude_home
            .clone()
            .unwrap()
            .join("projects")
            .join(claude_project_dir_name(&folder.to_string_lossy()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("conv-1.jsonl"), "{}\n").unwrap();
    };
    transcripts(&layout.project);
    let store = open_store(&env);
    let conn = store.lock_conn().unwrap();
    let rules = FolderRules::load(
        &env,
        &[layout.project.to_string_lossy().into_owned()],
        &[],
        &[],
        &[],
    );
    let file = |private: bool, cwd: &Path| {
        json!({"title": "T", "cwd": cwd.to_string_lossy(), "private": private,
               "blocks": [block("u", "user", "hi")],
               "engine": {"harness": "claude", "model": "m", "runtimeMode": "auto"},
               "providerTranscript": {"providerSessionId": "conv-1"}})
    };
    let kept = |id: &str, conn: &Connection| -> Option<String> {
        conn.query_row(
            "SELECT provider_session_id FROM sessions WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    };
    insert_session(
        &env,
        &conn,
        "own",
        "T",
        &file(false, &layout.project),
        &rules,
    )
    .unwrap();
    assert_eq!(kept("own", &conn).as_deref(), Some("conv-1"));
    // Another chat here already resumes it.
    insert_session(
        &env,
        &conn,
        "second",
        "T",
        &file(false, &layout.project),
        &rules,
    )
    .unwrap();
    assert_eq!(kept("second", &conn), None);
    // A private chat never resumes one from a file.
    conn.execute("DELETE FROM sessions WHERE id = 'own'", [])
        .unwrap();
    insert_session(
        &env,
        &conn,
        "secret",
        "T",
        &file(true, &layout.project),
        &rules,
    )
    .unwrap();
    assert_eq!(kept("secret", &conn), None);
    // A transcript in another project's folder isn't this chat's.
    conn.execute("DELETE FROM sessions WHERE id IN ('second','secret')", [])
        .unwrap();
    let elsewhere = layout.project.join("src");
    insert_session(&env, &conn, "moved", "T", &file(false, &elsewhere), &rules).unwrap();
    assert_eq!(kept("moved", &conn), None);
}

// ---- round 5: another spelling of the Monos home, notes only everywhere, relinks through the project record ----------

/// An export whose memory folder `name` holds these files, imported into the layout's copy with its Monos home.
fn import_memory_files(layout: &Layout, name: &str, files: &[(&str, &str)]) -> ImportReport {
    let source = env_for(&layout.root.0.join("source"));
    let store = open_store(&source);
    drop(store);
    let dest = layout.root.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.workspace = false;
    request.files.clear();
    export(&source, &request).unwrap();
    for (relative, text) in files {
        let place = dest.join("memory").join(name).join(relative);
        fs::create_dir_all(place.parent().unwrap()).unwrap();
        put_in_export(&dest, &format!("memory/{name}/{relative}"), text.as_bytes());
    }
    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    import_held(
        &layout.target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: Some(MemoryImport {
                projects: vec![name.to_string()],
                keep_both: false,
                history: false,
            }),
            workspace: None,
        },
    )
    .unwrap()
}

#[test]
fn a_memory_folder_that_reaches_the_monos_home_under_another_name_writes_nothing_there() {
    let layout = layout();
    let monos = layout.target.monos_root.clone();
    fs::create_dir_all(monos.join("lead")).unwrap();
    // A link stands in for a case alias (`Monos` on a case-insensitive disk is the same folder as `monos`).
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&monos, layout.target.memory_root.join("MonosAlias")).unwrap();
        let report = import_memory_files(
            &layout,
            "MonosAlias",
            &[
                ("CLAUDE.md", "planted"),
                ("lead/CLAUDE.md", "planted"),
                ("lead/AGENTS.override.md", "planted"),
                ("lead/opencode.json", "{\"mcp\":{}}"),
                ("lead/MEMORY.md", "a note"),
            ],
        );
        for planted in [
            "CLAUDE.md",
            "lead/CLAUDE.md",
            "lead/AGENTS.override.md",
            "lead/opencode.json",
            "lead/MEMORY.md",
        ] {
            assert!(
                !monos.join(planted).exists(),
                "{planted} reached the Monos home: {report:?}"
            );
        }
        assert!(
            report
                .notes
                .iter()
                .any(|n| n.contains("MonosAlias") && n.contains("Monos home")),
            "{:?}",
            report.notes
        );
    }
}

#[test]
fn another_spelling_of_the_monos_home_is_refused_by_name() {
    let env = layout().target;
    let target = |name: &str| env.memory_root.join(name);
    // The Monos home itself, spelled as it is, is not an alias.
    assert_eq!(aliases_monos_home(&env, "monos", &target("monos")), None);
    // A case alias, and Windows' trailing dot or space, all spell it another way.
    for alias in ["Monos", "MONOS", "monos.", "monos ", "monos. .", "MonoS "] {
        assert!(
            aliases_monos_home(&env, alias, &target(alias)).is_some(),
            "{alias:?}"
        );
    }
    assert_eq!(aliases_monos_home(&env, "ash", &target("ash")), None);
    // A name that ends in a dot or a space is never taken as a memory folder at all.
    for name in ["monos.", "monos ", "ash.", "ash "] {
        assert!(!plain_name(name), "{name:?}");
    }
    assert!(plain_name("ash") && plain_name("my notes"));
}

#[test]
fn a_memory_import_writes_only_notes_in_any_folder() {
    let layout = layout();
    let report = import_memory_files(
        &layout,
        "ash",
        &[
            ("MEMORY.md", "# ash\n"),
            ("topics/deploy.md", "note"),
            ("CLAUDE.md", "planted"),
            ("AGENTS.md", "planted"),
            ("AGENTS.override.md", "planted"),
            ("GEMINI.md", "planted"),
            ("topics/CLAUDE.local.md", "planted"),
            ("opencode.json", "{}"),
            ("topics/settings.json", "{}"),
            ("data.txt", "not a note"),
        ],
    );
    let root = layout.target.memory_root.join("ash");
    for note in ["MEMORY.md", "topics/deploy.md"] {
        assert!(root.join(note).is_file(), "{note}: {report:?}");
    }
    for planted in [
        "CLAUDE.md",
        "AGENTS.md",
        "AGENTS.override.md",
        "GEMINI.md",
        "topics/CLAUDE.local.md",
        "opencode.json",
        "topics/settings.json",
        "data.txt",
    ] {
        assert!(!root.join(planted).exists(), "{planted} was written");
    }
}

#[test]
fn what_counts_as_a_note_and_as_an_instruction_file() {
    for note in ["a.md", "topics/deploy.md", "My Notes.MD"] {
        assert!(folders::memory_note_file(Path::new(note)), "{note}");
    }
    for not_note in [
        "CLAUDE.md",
        "claude.md",
        "AGENTS.md",
        "AGENTS.override.md",
        "agents.override.md",
        "CLAUDE.local.md",
        "GEMINI.md",
        "opencode.json",
        ".cursorrules",
        ".mcp.json",
        "settings.json",
        "topics/.hidden.md",
        ".claude/x.md",
        "data.txt",
        "a.md.exe",
        "../a.md",
    ] {
        assert!(
            !folders::memory_note_file(Path::new(not_note)),
            "{not_note}"
        );
    }
    for instruction in [
        "AGENTS.override.md",
        "CLAUDE.local.md",
        "GEMINI.md",
        ".cursorrules",
        "opencode.json",
        ".mcp.json",
        "mcp.json",
        ".windsurfrules",
        "copilot-instructions.md",
    ] {
        assert!(folders::instruction_file(instruction), "{instruction}");
    }
    assert!(!folders::instruction_file("today.md"));
}

#[test]
fn a_monos_folder_takes_only_the_names_mono_rs_uses() {
    let allowed = [
        "lead/SOUL.md",
        "lead/MEMORY.md",
        "lead/soul-template.md",
        "lead/memory/today.md",
        "lead/skills/review.md",
    ];
    let refused = [
        "lead/AGENTS.override.md",
        "lead/CLAUDE.local.md",
        "lead/GEMINI.md",
        "lead/notes.md",
        "lead/habits.md",
        "lead/memory/CLAUDE.md",
        "lead/memory/.hidden.md",
        "lead/memory/deep/x.md",
        "lead/.claude/settings.json",
        "MEMORY.md",
        "lead",
        "../lead/SOUL.md",
    ];
    for path in allowed {
        assert!(folders::mono_folder_file(Path::new(path)), "{path}");
    }
    for path in refused {
        assert!(!folders::mono_folder_file(Path::new(path)), "{path}");
    }
}

#[test]
fn a_restored_history_loses_instruction_and_hidden_files_but_keeps_everything_else_and_stays_intact(
) {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let docs = source.memory_root.join("docs");
    fs::create_dir_all(docs.join(".claude")).unwrap();
    fs::create_dir_all(docs.join("topics")).unwrap();
    fs::write(docs.join("MEMORY.md"), "# docs\n").unwrap();
    fs::write(docs.join("topics/a.md"), "a\n").unwrap();
    fs::write(docs.join("themes.json"), "{}\n").unwrap();
    fs::write(docs.join("AGENTS.override.md"), "planted\n").unwrap();
    fs::write(docs.join(".claude/settings.json"), "{\"hooks\":{}}\n").unwrap();
    git(&docs, &["init", "-q", "-b", "main"]);
    git(&docs, &["add", "-A"]);
    git(&docs, &["commit", "-q", "-m", "docs"]);
    let dest = out.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.workspace = false;
    request.memory = Some(MemoryChoice {
        projects: vec!["docs".into()],
        history: true,
    });
    export(&source, &request).unwrap();
    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    import_held(
        &target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: Some(MemoryImport {
                projects: vec!["docs".into()],
                keep_both: false,
                history: true,
            }),
            workspace: None,
        },
    )
    .unwrap();
    let root = target.memory_root.join("docs");
    assert!(
        root.join("themes.json").is_file(),
        "only instruction and hidden files go"
    );
    assert!(root.join("topics/a.md").is_file());
    assert!(!root.join("AGENTS.override.md").exists());
    assert!(!root.join(".claude/settings.json").exists());
    let git_out = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    assert!(
        git_out(&["status", "--porcelain"]).trim().is_empty(),
        "the restored folder is clean"
    );
    assert_eq!(
        git_out(&["log", "--oneline"]).lines().count(),
        1,
        "the history keeps its length"
    );
}

#[test]
fn a_project_chat_from_another_user_is_relinked_through_the_project_record_once_it_has_a_folder() {
    let layout = layout();
    let old = "/Users/old/Projects/app";
    // On a fresh Mac the project has no folder here at import time: the pair carries only the id and the file's folder.
    let map = [("app", old, String::new())];
    let chats = [
        ("one", format!("{old}/src/deep"), None),
        ("two", old.to_string(), None),
    ];
    // The record has no folder for it yet.
    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    crate::local_hub::write(
        &conn,
        "projects",
        &json!({"projects": [{"id": "app", "name": "App", "folder": null}]}),
    )
    .unwrap();
    drop(conn);
    drop(store);
    let (stored, report) = import_folders_with(&layout, &chats, &[], &[], &map);
    assert_eq!(stored["one"].0, "");
    assert_eq!(stored["two"].0, "");
    assert_eq!(report["foldersCleared"], 2, "{report}");
    assert!(relink_candidates(&layout.target, None, &[], &[]).is_empty());
    // Ash picks the project's folder here (a different user name, a different path).
    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    crate::local_hub::write(
        &conn,
        "projects",
        &json!({"projects": [{"id": "app", "name": "App", "folder": layout.project.to_string_lossy()}]}),
    )
    .unwrap();
    drop(conn);
    drop(store);
    let mut offers = relink_candidates(&layout.target, None, &[], &[]);
    offers.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    assert_eq!(
        offers
            .iter()
            .map(|o| (o.session_id.as_str(), o.folder.as_str()))
            .collect::<Vec<_>>(),
        [
            ("one", path(&layout.project, "src/deep").as_str()),
            ("two", layout.project.to_string_lossy().as_ref())
        ]
    );
    assert!(offers
        .iter()
        .all(|o| o.group == layout.project.to_string_lossy()));
}

#[test]
fn a_file_cannot_map_everything_onto_a_project_with_a_broad_from() {
    let layout = layout();
    let to = layout.project.to_string_lossy().into_owned();
    let home = layout
        .target
        .home
        .clone()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let map = [
        ("all", "/", to.clone()),
        ("users", "/Users", to.clone()),
        ("user", "/Users/old", to.clone()),
        ("mine", home.as_str(), to.clone()),
    ];
    let chats = [
        ("a", "/anything/at/all".to_string(), None),
        ("b", "/Users/old/Documents".to_string(), None),
        ("c", format!("{home}/Documents"), None),
    ];
    let (stored, _) = import_folders_with(&layout, &chats, &[], &[], &map);
    assert!(stored.values().all(|(cwd, _)| cwd.is_empty()), "{stored:?}");
    // Only the deepest project the chat is in maps it: the other pair is not applied to it.
    let map = [
        ("app", "/Users/old/Projects/app", to.clone()),
        (
            "other",
            "/Users/old/Projects/other",
            path(layout.project.parent().unwrap(), "app-evil"),
        ),
    ];
    let chats = [("x", "/Users/old/Projects/other/src".to_string(), None)];
    let (stored, _) = import_folders_with(&layout_again(&layout), &chats, &[], &[], &map);
    assert_eq!(
        stored["x"].0, "",
        "the mapped folder app-evil is no project here"
    );
}

#[test]
fn a_relink_checks_the_folder_and_the_ones_above_it_on_disk_again() {
    let layout = layout();
    let lead = layout.target.monos_root.join("lead");
    fs::create_dir_all(lead.join("memory")).unwrap();
    let source = env_for(&layout.root.0.join("source"));
    let store = open_store(&source);
    let conn = store.lock_conn().unwrap();
    add_session(
        &conn,
        "chat",
        "chat",
        "claude",
        json!([block("u", "user", "hi")]),
        1_000,
    );
    conn.execute(
        "UPDATE sessions SET cwd = ?1 WHERE id = 'chat'",
        [path(&lead, "memory")],
    )
    .unwrap();
    drop(conn);
    drop(store);
    let dest = layout.root.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.files.clear();
    export(&source, &request).unwrap();
    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    // Imported while `lead` isn't a Mono seated here, so the chat comes in folderless; it is seated afterwards.
    import_held(
        &layout.target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: serde_json::from_value(json!({"sessions": ["chat"]})).unwrap(),
        },
    )
    .unwrap();
    drop(conn);
    drop(store);
    let monos = ["lead".to_string()];
    assert_eq!(
        relink_candidates(&layout.target, None, &[], &monos).len(),
        1
    );
    // Something a CLI reads has appeared above the folder since the import: a file in its Mono's folder, or a hidden
    // folder there, however deep the chat's own folder is.
    fs::write(lead.join("AGENTS.override.md"), "planted").unwrap();
    assert!(relink_candidates(&layout.target, None, &[], &monos).is_empty());
    fs::remove_file(lead.join("AGENTS.override.md")).unwrap();
    fs::create_dir_all(lead.join(".claude")).unwrap();
    assert!(relink_candidates(&layout.target, None, &[], &monos).is_empty());
    fs::remove_dir_all(lead.join(".claude")).unwrap();
    assert_eq!(
        relink_candidates(&layout.target, None, &[], &monos).len(),
        1
    );
}

#[test]
fn a_hidden_folder_below_the_memory_root_makes_its_holder_and_what_is_below_it_read_instructions() {
    let layout = layout();
    let lead = layout.target.monos_root.join("lead");
    fs::create_dir_all(lead.join("memory")).unwrap();
    // (what the import wrote, the chat folder that now reads it)
    for (planted, chat) in [
        (lead.join(".claude/hooks/run.json"), lead.clone()),
        (lead.join(".claude/hooks/run.json"), lead.join("memory")),
        (lead.join("memory/.cursor/rules/x.md"), lead.join("memory")),
        (lead.join("AGENTS.override.md"), lead.clone()),
    ] {
        let mut rules = FolderRules::load(&layout.target, &[], &[], &["lead".into()], &[]);
        rules.note_written(std::slice::from_ref(&planted));
        let cleared = rules.vet(Some(&chat.to_string_lossy()), None);
        assert_eq!(
            cleared.cwd,
            "",
            "{} in {}",
            planted.display(),
            chat.display()
        );
        assert!(cleared.named_blocked, "{}", planted.display());
    }
    // A folder a CLI isn't started in doesn't read what is only below it.
    let mut rules = FolderRules::load(&layout.target, &[], &[], &["lead".into()], &[]);
    rules.note_written(&[lead.join("memory/.cursor/rules/x.md")]);
    assert_eq!(
        rules.vet(Some(&lead.to_string_lossy()), None).cwd,
        lead.to_string_lossy()
    );
}

#[test]
fn the_imported_folder_table_made_by_an_earlier_build_gets_every_column() {
    let layout = layout();
    let store = open_store(&layout.target);
    {
        let conn = store.lock_conn().unwrap();
        // The round-3 build made the table on the fly with three columns, and a round-4 database has four.
        conn.execute_batch(
            "DROP TABLE imported_chat_folders;
             CREATE TABLE imported_chat_folders (session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, worktree_cwd TEXT);
             INSERT INTO imported_chat_folders VALUES ('old', '/Users/old/app', NULL);",
        )
        .unwrap();
    }
    drop(store);
    // Opened again, the table is whole, the old row is kept, and an import writes to it.
    let store = open_store(&layout.target);
    let conn = store.lock_conn().unwrap();
    let columns: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('imported_chat_folders') ORDER BY cid")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(
        columns,
        [
            "session_id",
            "cwd",
            "worktree_cwd",
            "blocked",
            "project_id",
            "rest"
        ]
    );
    let kept: String = conn
        .query_row(
            "SELECT cwd FROM imported_chat_folders WHERE session_id = 'old'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(kept, "/Users/old/app");
    drop(conn);
    drop(store);
    let (_, report) = import_folders(
        &layout,
        &[("away", "/tmp/elsewhere".to_string(), None)],
        &[],
    );
    assert_eq!(report["foldersCleared"], 1, "{report}");
}
