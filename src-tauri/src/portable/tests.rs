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
        // A hidden file in the history is an ordinary file: it comes back with it.
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
                &json!({"id": "auto-1", "name": "Morning digest", "prompt": "Summarise", "harness": "claude", "model": "m", "cwd": ""})
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
            assert!(target.memory_root.join(name).join(".gitignore").is_file());
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
    // The provider transcript exists here, so the daily app would keep the id.
    let projects = source.claude_home.clone().unwrap().join("projects/-x");
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
        &FolderRules::load(&target, &conn, &[]),
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
        &FolderRules::load(&target, &conn, &[]),
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
    let project = root.0.join("projects/app");
    fs::create_dir_all(project.join("src/deep")).unwrap();
    fs::create_dir_all(root.0.join("projects/app-evil")).unwrap();
    let outside = root.0.join("outside");
    fs::create_dir_all(&outside).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, project.join("escape")).unwrap();
    let target = env_for(&root.0.join("target"));
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
        ("sibling", path(&layout.root.0, "projects/app-evil")),
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
    let tree = layout.root.0.join("worktrees/feature");
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
    let rail = layout.root.0.join("rail");
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
    let (stored, report) = import_folders(&layout, &chats, &[]);
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
