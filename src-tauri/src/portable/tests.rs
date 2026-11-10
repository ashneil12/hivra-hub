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
            assert_eq!(row(&conn), scrubbed(&row(&source_conn)), "{id}");
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
                &json!({"id": "auto-1", "name": "Morning digest", "prompt": "Summarise", "harness": "claude", "model": "m", "cwd": "/x"})
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
    insert_session(&target, &conn, "old", "Old", &old).unwrap();
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
    insert_session(&target, &conn, "bad", "Bad", &bad).unwrap();
    let bad_row = session_store::get_session(&conn, "bad").unwrap().unwrap();
    assert_eq!(
        bad_row.private_boundary_id.as_deref(),
        Some("private-boundary-unreadable")
    );
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

/// Every file under `dir` (empty when there is no such folder), by name relative to it.
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
                        .into_owned(),
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
/// it, the link itself must be refused. An export that lists one is not opened at all; one swapped in after the
/// export was checked is left out of the copy.
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
    let opened = open_export(&dest.to_string_lossy()).unwrap();
    fs::remove_file(&picture).unwrap();
    std::os::unix::fs::symlink(outside.0.join("same-bytes.png"), &picture).unwrap();

    // Swapped after the check: the copy leaves it out and says why.
    let left_out = copy_note_assets(&target, &opened, "note-1", "note-1");
    assert_eq!(left_out, vec!["it is a link"]);
    assert_eq!(
        files_under(&target.data_dir.join(NOTE_ASSET_DIR)),
        Vec::<String>::new(),
        "a link was followed and its target copied in"
    );

    // Listed as a link from the start: the export isn't opened.
    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let why = import_held(&target, &conn, &note_import(&dest)).unwrap_err();
    assert!(
        why.contains("workspace/note-assets/note-1/1-shot.png") && why.contains("link"),
        "{why}"
    );
    assert_eq!(
        files_under(&target.data_dir.join(NOTE_ASSET_DIR)),
        Vec::<String>::new()
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

// ---- reading a folder export's files and its own pictures (links, pipes, sizes, what the manifest lists) ------------

/// Runs `f` on its own thread. A read that waits on a pipe, or never reaches the end of a device, would hang the whole
/// run (or fill the memory first), so one that is still going after `seconds` stops the process, not just the test.
fn finishes_within<T: Send + 'static>(seconds: u64, f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(seconds)) {
        Ok(value) => value,
        Err(_) => {
            eprintln!(
                "still reading after {seconds}s: a file that never ends, or a pipe, is being read"
            );
            std::process::exit(70);
        }
    }
}

/// `open_export` on its own thread, as what it says when it refuses.
fn open_refused(dest: &Path) -> Result<String, ()> {
    let path = dest.to_string_lossy().into_owned();
    match finishes_within(5, move || open_export(&path).map(|_| ())) {
        Ok(()) => Err(()),
        Err(why) => Ok(why),
    }
}

fn edit_manifest(dest: &Path, edit: impl FnOnce(&mut Value)) {
    let path = dest.join(MANIFEST);
    let mut manifest: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    edit(&mut manifest);
    fs::write(&path, manifest.to_string()).unwrap();
}

#[cfg(unix)]
fn make_pipe(path: &Path) {
    let c_path = std::ffi::CString::new(path.to_string_lossy().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
}

/// A listed file that is a link to a device that never ends: reading it to the end would fill the memory and take
/// the app down. It must be refused at the link, without reading a byte.
#[cfg(unix)]
#[test]
fn a_listed_file_that_links_to_an_endless_device_is_refused_unread() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let dest = note_export(&source, &out.0);
    let listed = dest.join("memory/ash/MEMORY.md");
    fs::remove_file(&listed).unwrap();
    std::os::unix::fs::symlink("/dev/urandom", &listed).unwrap();

    let why = open_refused(&dest).expect("an export with a link to a device was opened");
    assert!(
        why.contains("memory/ash/MEMORY.md") && why.contains("link"),
        "{why}"
    );
}

/// A listed file that is a link to a plain file holding exactly the bytes the manifest hashes: the hash can't catch
/// it, the link itself must be refused.
#[cfg(unix)]
#[test]
fn a_listed_file_that_is_a_link_is_refused_even_when_the_hash_matches() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let outside = TestDir::new("outside");
    let source = env_for(&source_dir.0);
    let dest = note_export(&source, &out.0);
    let listed = dest.join("memory/ash/MEMORY.md");
    let bytes = fs::read(&listed).unwrap();
    fs::write(outside.0.join("same.md"), bytes).unwrap();
    fs::remove_file(&listed).unwrap();
    std::os::unix::fs::symlink(outside.0.join("same.md"), &listed).unwrap();

    let why = open_refused(&dest).expect("a listed link was opened");
    assert!(
        why.contains("memory/ash/MEMORY.md") && why.contains("link"),
        "{why}"
    );
}

/// A pipe where a listed file should be: a plain read waits for a writer that never comes.
#[cfg(unix)]
#[test]
fn a_listed_file_that_is_a_pipe_does_not_hang_the_open() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let dest = note_export(&source, &out.0);
    let listed = dest.join("memory/ash/MEMORY.md");
    fs::remove_file(&listed).unwrap();
    make_pipe(&listed);

    let why = open_refused(&dest).expect("an export with a pipe in it was opened");
    assert!(
        why.contains("memory/ash/MEMORY.md") && why.contains("plain file"),
        "{why}"
    );
}

/// The manifest says a file holds fewer bytes than it does: only that many are read, and the hash (of the whole
/// file) can't match them.
#[test]
fn a_file_longer_than_the_manifest_says_is_cut_at_that_size_and_fails_its_hash() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let dest = note_export(&source, &out.0);
    edit_manifest(&dest, |manifest| {
        for file in manifest["files"].as_array_mut().unwrap() {
            if file["path"] == "memory/ash/MEMORY.md" {
                file["bytes"] = json!(3);
            }
        }
    });

    let why = open_refused(&dest).expect("a file longer than listed was accepted");
    assert!(
        why.contains("memory/ash/MEMORY.md") && why.contains("damaged"),
        "{why}"
    );
}

/// The manifest itself is read like any other file: not through a link.
#[cfg(unix)]
#[test]
fn a_manifest_that_is_a_link_is_refused() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let outside = TestDir::new("outside");
    let source = env_for(&source_dir.0);
    let dest = note_export(&source, &out.0);
    fs::rename(dest.join(MANIFEST), outside.0.join("manifest.json")).unwrap();
    std::os::unix::fs::symlink(outside.0.join("manifest.json"), dest.join(MANIFEST)).unwrap();

    assert!(
        open_refused(&dest).is_ok(),
        "a manifest that is a link was read"
    );
}

/// A file the manifest doesn't list is never read, whatever its name: the fixed workspace files included.
#[test]
fn a_workspace_file_the_manifest_does_not_list_is_never_read() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = note_export(&source, &out.0);
    let opened = open_export(&dest.to_string_lossy()).unwrap();
    assert!(opened.json("workspace/notes.json").is_some(), "the control");
    assert!(opened.read("memory/ash/MEMORY.md").is_some(), "the control");

    // The files are all still there, only the manifest stops listing them.
    edit_manifest(&dest, |manifest| {
        manifest["files"].as_array_mut().unwrap().retain(|f| {
            !f["path"]
                .as_str()
                .is_some_and(|p| p.starts_with("workspace/") && p.ends_with(".json"))
        });
    });
    let opened = open_export(&dest.to_string_lossy()).unwrap();
    for fixed in [
        "workspace/notes.json",
        "workspace/automations.json",
        "workspace/reminders.json",
        "workspace/delegations.json",
        "workspace/doc-versions.json",
        "workspace/doc-mentions.json",
        "workspace/activity.json",
        "workspace/sessions/chat-1.json",
    ] {
        assert!(dest.join(fixed).is_file(), "{fixed} is on disk");
        assert!(opened.read(fixed).is_none(), "{fixed} was read unlisted");
        assert!(opened.json(fixed).is_none(), "{fixed} was read unlisted");
    }
    // A name that was never a file of the export, listed or not.
    assert!(opened.read("memory/ash/not-there.md").is_none());

    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(&target, &conn, &note_import(&dest)).unwrap();
    assert_eq!(report.notes_added + report.notes_copied, 0, "{report:?}");
    assert!(
        conn.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get::<_, i64>(0))
            .unwrap()
            == 0,
        "a note came in from a file the manifest doesn't list"
    );
}

/// The bytes a read hands back are the ones that hash as listed: a listed file changed after the check is not used.
#[test]
fn a_listed_file_changed_after_the_check_is_not_read() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let dest = note_export(&source, &out.0);
    let opened = open_export(&dest.to_string_lossy()).unwrap();
    let listed = dest.join("memory/ash/MEMORY.md");
    assert!(opened.read("memory/ash/MEMORY.md").is_some(), "the control");
    // Other bytes of the same length (only the hash can tell), then a longer file (past the size the manifest gives).
    let length = fs::read(&listed).unwrap().len();
    for swapped in ["x".repeat(length), "y".repeat(length + 1000)] {
        fs::write(&listed, swapped).unwrap();
        assert!(
            opened.read("memory/ash/MEMORY.md").is_none(),
            "{length}: a file that no longer hashes as listed was used"
        );
    }
}

/// A listed picture whose name has a separator isn't one of the note's pictures: it isn't read, whatever is behind
/// the folder it names.
#[test]
fn a_listed_picture_name_with_a_separator_is_refused() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = note_export(&source, &out.0);
    fs::create_dir_all(dest.join("workspace/note-assets/note-1/sub")).unwrap();
    put_in_export(&dest, "workspace/note-assets/note-1/sub/x.png", &PICTURE);

    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(&target, &conn, &note_import(&dest)).unwrap();
    assert_eq!(
        files_under(&target.data_dir.join(NOTE_ASSET_DIR)),
        vec!["note-1/1-shot.png".to_string()]
    );
    assert_eq!(report.note_assets_skipped, 1, "{report:?}");
    assert_eq!(
        report.notes,
        vec![
            "1 picture of note note-1 was not copied (its name isn't one plain file name)."
                .to_string()
        ]
    );

    // And one that climbs out of its folder doesn't even open.
    put_in_export(&dest, "workspace/note-assets/note-1/x.png", &PICTURE);
    edit_manifest(&dest, |manifest| {
        for file in manifest["files"].as_array_mut().unwrap() {
            if file["path"] == "workspace/note-assets/note-1/x.png" {
                file["path"] = json!("workspace/note-assets/note-1/../note-1/x.png");
            }
        }
    });
    let why = open_refused(&dest).expect("a path that climbs out was opened");
    assert!(why.contains("bad path"), "{why}");
}

/// The picture folder of a note on this Mac, or the folder of them all, is a link: the export doesn't follow it (it
/// would carry out whatever the link reaches), and says so.
#[cfg(unix)]
#[test]
fn an_export_does_not_follow_a_linked_picture_folder_in_the_data_folder() {
    for linked in ["note-assets", "note-assets/note-1"] {
        let source_dir = TestDir::new("source");
        let out = TestDir::new("out");
        let outside = TestDir::new("outside");
        let source = env_for(&source_dir.0);
        seed(&source);
        let real = source.data_dir.join(linked);
        let elsewhere = outside.0.join("moved");
        fs::rename(&real, &elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &real).unwrap();
        let reached = if linked == "note-assets" {
            elsewhere.join("note-1")
        } else {
            elsewhere.clone()
        };
        fs::write(reached.join("private.png"), PRIVATE_KEY).unwrap();

        let dest = out.0.join("export");
        let report = export(&source, &export_request(&dest, Form::Folder)).unwrap();
        let carried: Vec<String> = export_texts(&dest)
            .into_keys()
            .filter(|name| name.starts_with("workspace/note-assets/"))
            .collect();
        assert_eq!(
            carried,
            Vec::<String>::new(),
            "{linked} is a link and was followed"
        );
        assert!(
            report
                .notes
                .iter()
                .any(|n| n.contains("note-assets") && n.contains("link")),
            "{linked}: {:?}",
            report.notes
        );
    }
}

/// A picture past the size a note takes is left out of the export, not read to the end.
#[test]
fn an_export_leaves_out_a_picture_past_the_size_a_note_takes() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    seed(&source);
    let huge = source.data_dir.join("note-assets/note-1/huge.png");
    let file = fs::File::create(&huge).unwrap();
    file.set_len(crate::notes::IMAGE_MAX_BYTES + 1).unwrap();
    drop(file);

    let dest = out.0.join("export");
    let report = export(&source, &export_request(&dest, Form::Folder)).unwrap();
    let carried: Vec<String> = export_texts(&dest)
        .into_keys()
        .filter(|name| name.starts_with("workspace/note-assets/"))
        .collect();
    assert_eq!(
        carried,
        vec!["workspace/note-assets/note-1/1-shot.png".to_string()]
    );
    assert!(
        report
            .notes
            .iter()
            .any(|n| n.contains("huge.png") && n.contains("too large")),
        "{:?}",
        report.notes
    );
}

// ---- round 2: the history bundle, sizes by kind, the manifest's own list, tar sizes ----------------------------------

/// A repository somewhere else with one file, `EVIL.md`, in its only commit.
fn evil_repo(dir: &Path) -> PathBuf {
    let repo = dir.join("evil");
    fs::create_dir_all(&repo).unwrap();
    fs::write(repo.join("EVIL.md"), "carried in from elsewhere\n").unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "evil"]);
    repo
}

/// A folder export of the seeded memory (ash and hivra, with their history), no workspace.
fn memory_export(source: &Env, out: &Path) -> PathBuf {
    seed(source);
    let dest = out.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.workspace = false;
    export(source, &request).unwrap();
    assert!(dest.join("memory/ash.git.bundle").is_file());
    dest
}

fn history_import(dest: &Path) -> ImportRequest {
    ImportRequest {
        path: dest.to_string_lossy().into_owned(),
        memory: Some(MemoryImport {
            projects: vec!["ash".into()],
            keep_both: false,
            history: true,
        }),
        workspace: None,
    }
}

/// The subjects of the commits in the memory folder this import made.
fn history_subjects(target: &Env, name: &str) -> Vec<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(target.memory_root.join(name))
        .args(["log", "--format=%s"])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

/// A listed, correctly hashed `memory/ash.git.bundle` that is a gitfile: `git clone` takes its path for a repository
/// and clones the one it names. It is no bundle, so it is never handed to git.
#[cfg(unix)]
#[test]
fn a_history_bundle_that_is_a_gitfile_never_clones_the_repo_it_names() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let outside = TestDir::new("outside");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = memory_export(&source, &out.0);
    let repo = evil_repo(&outside.0);
    put_in_export(
        &dest,
        "memory/ash.git.bundle",
        format!("gitdir: {}\n", repo.join(".git").display()).as_bytes(),
    );

    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(&target, &conn, &history_import(&dest)).unwrap();
    assert!(
        !target.memory_root.join("ash/EVIL.md").exists(),
        "git cloned a repository the export only pointed at"
    );
    assert_eq!(history_subjects(&target, "ash"), Vec::<String>::new());
    assert!(report.memory_history.is_empty(), "{report:?}");
    assert!(
        report
            .notes
            .iter()
            .any(|n| n.contains("history of ash") && n.contains("wasn't restored")),
        "{:?}",
        report.notes
    );
    // The files themselves still come in.
    assert!(target.memory_root.join("ash/MEMORY.md").is_file());
}

/// A real, listed bundle, and an unlisted bare repository beside it named `<bundle>.git`: `git clone` tries that
/// name first and clones the bare repository instead. The bundle's own bytes are what restores.
#[test]
fn a_bare_repo_beside_the_history_bundle_is_not_what_gets_cloned() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let outside = TestDir::new("outside");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = memory_export(&source, &out.0);
    let repo = evil_repo(&outside.0);
    for beside in ["memory/ash.git.bundle.git", "memory/ash.git.bundle.bundle"] {
        let bare = dest.join(beside);
        git(
            &outside.0,
            &[
                "clone",
                "-q",
                "--bare",
                &repo.to_string_lossy(),
                &bare.to_string_lossy(),
            ],
        );
    }
    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(&target, &conn, &history_import(&dest)).unwrap();
    assert!(
        !target.memory_root.join("ash/EVIL.md").exists(),
        "git cloned the bare repository beside the bundle"
    );
    assert_eq!(report.memory_history, vec!["ash".to_string()], "{report:?}");
    assert_eq!(history_subjects(&target, "ash"), vec!["memory".to_string()]);
}

/// The normal case: a real bundle restores the folder's history, and it is a plain file in a private folder when
/// git reads it.
#[test]
fn a_real_history_bundle_still_restores() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = memory_export(&source, &out.0);

    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(&target, &conn, &history_import(&dest)).unwrap();
    assert_eq!(report.memory_history, vec!["ash".to_string()], "{report:?}");
    assert_eq!(history_subjects(&target, "ash"), vec!["memory".to_string()]);
    assert!(target.memory_root.join("ash/MEMORY.md").is_file());
}

/// What a file is allowed to be, by kind, is checked from the manifest before a byte is read: the numbers are the
/// attacker's, and a hashed file of any declared size would otherwise be read whole.
#[test]
fn a_file_declared_larger_than_its_kind_allows_is_refused_before_it_is_read() {
    const GIB: u64 = 1024 * 1024 * 1024;
    for (relative, declared) in [
        ("setup/setup.json", 4 * GIB),
        ("workspace/sessions/chat-1.json", 65 * 1024 * 1024),
        ("workspace/note-assets/note-1/1-shot.png", 21 * 1024 * 1024),
        ("memory/ash.git.bundle", 2 * GIB),
    ] {
        let source_dir = TestDir::new("source");
        let out = TestDir::new("out");
        let source = env_for(&source_dir.0);
        let dest = note_export(&source, &out.0);
        if relative == "setup/setup.json" {
            assert!(dest.join(relative).is_file(), "{relative} is listed");
        }
        edit_manifest(&dest, |manifest| {
            for file in manifest["files"].as_array_mut().unwrap() {
                if file["path"] == relative {
                    file["bytes"] = json!(declared);
                }
            }
        });
        let why = open_refused(&dest).unwrap_or_else(|()| panic!("{relative}: opened"));
        assert!(
            why.contains(relative) && why.contains("too large"),
            "{relative}: {why}"
        );
    }
}

#[test]
fn a_listed_file_with_no_size_is_refused() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let dest = note_export(&source, &out.0);
    edit_manifest(&dest, |manifest| {
        for file in manifest["files"].as_array_mut().unwrap() {
            if file["path"] == "memory/ash/MEMORY.md" {
                file.as_object_mut().unwrap().remove("bytes");
            }
        }
    });
    let why = open_refused(&dest).expect("a file with no size was opened");
    assert!(
        why.contains("memory/ash/MEMORY.md") && why.contains("how big"),
        "{why}"
    );
}

/// Nine bundles of a gigabyte each are listed: more than an archive may unpack to. Nothing is read for it.
#[test]
fn sizes_that_add_up_past_what_an_archive_may_hold_are_refused() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let dest = note_export(&source, &out.0);
    edit_manifest(&dest, |manifest| {
        let files = manifest["files"].as_array_mut().unwrap();
        for n in 0..9 {
            files.push(json!({"path": format!("memory/p{n}.git.bundle"), "bytes": 1024 * 1024 * 1024u64, "sha256": "0"}));
        }
    });
    let why = open_refused(&dest).expect("an export listing nine gigabytes was opened");
    assert!(why.contains("too large"), "{why}");
}

#[test]
fn more_listed_files_than_an_archive_may_hold_are_refused() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let dest = note_export(&source, &out.0);
    let manifest = fs::read_to_string(dest.join(MANIFEST)).unwrap();
    let mut value: Value = serde_json::from_str(&manifest).unwrap();
    value["files"] = Value::Null;
    let head = value.to_string();
    // "files":null is replaced by that many empty entries; nothing is hashed for an export this long.
    let empties = vec!["{}"; MAX_ENTRIES + 1].join(",");
    fs::write(
        dest.join(MANIFEST),
        head.replace("\"files\":null", &format!("\"files\":[{empties}]")),
    )
    .unwrap();
    let why = open_refused(&dest).expect("an export listing too many files was opened");
    assert!(why.contains("too many"), "{why}");
}

/// The same file listed again under another spelling is hashed again and again: refused, however it is spelled.
#[test]
fn a_file_listed_twice_is_refused_however_it_is_spelled() {
    for again in [
        "memory/ash/MEMORY.md",
        "memory/./ash/MEMORY.md",
        "memory/ash//MEMORY.md",
        "Memory/Ash/memory.md",
    ] {
        let source_dir = TestDir::new("source");
        let out = TestDir::new("out");
        let source = env_for(&source_dir.0);
        let dest = note_export(&source, &out.0);
        edit_manifest(&dest, |manifest| {
            let files = manifest["files"].as_array_mut().unwrap();
            let first = files
                .iter()
                .find(|f| f["path"] == "memory/ash/MEMORY.md")
                .unwrap()
                .clone();
            let mut second = first;
            second["path"] = json!(again);
            files.push(second);
        });
        let why = open_refused(&dest).unwrap_or_else(|()| panic!("{again}: opened"));
        assert!(why.contains("more than once"), "{again}: {why}");
    }
}

/// Two correctly hashed setup files, each as large as a text file may be: Inspect would read both whole and send
/// them to the window. It holds no more than a budget.
#[test]
fn inspect_holds_no_more_than_a_budget_of_the_webviews_files() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let dest = note_export(&source, &out.0);
    let size = 50 * 1024 * 1024;
    let zeros = vec![b' '; size];
    for name in ["a", "b", "c"] {
        put_in_export(&dest, &format!("setup/big-{name}.json"), &zeros);
    }
    let result = finishes_within(60, {
        let target = env_for(&TestDir::new("target").0);
        let path = dest.to_string_lossy().into_owned();
        move || inspect(&target, &path)
    });
    let why = result.err().expect("150 MB of setup files was inspected");
    assert!(why.contains("too large to preview"), "{why}");
}

/// A tar.gz with one file whose header says it holds nothing and whose PAX record says `size` bytes: the tar crate
/// copies the PAX size.
fn pax_sized_archive(path: &Path, size: usize) {
    use std::io::Write;
    fn header(name: &str, kind: tar::EntryType, size: u64) -> [u8; 512] {
        let mut header = tar::Header::new_gnu();
        header.set_path(name).unwrap();
        header.set_entry_type(kind);
        header.set_size(size);
        header.set_mode(0o644);
        header.set_cksum();
        *header.as_bytes()
    }
    let mut body = format!(" size={size}\n");
    let mut length = body.len() + 1;
    while format!("{length}{body}").len() != length {
        length += 1;
    }
    body = format!("{length}{body}");
    let pad = |out: &mut Vec<u8>| out.resize(out.len().div_ceil(512) * 512, 0);

    let mut tar_bytes = Vec::new();
    tar_bytes.extend_from_slice(&header("pax", tar::EntryType::XHeader, body.len() as u64));
    tar_bytes.extend_from_slice(body.as_bytes());
    pad(&mut tar_bytes);
    tar_bytes.extend_from_slice(&header("export/zeros.bin", tar::EntryType::Regular, 0));
    tar_bytes.resize(tar_bytes.len() + size, 0);
    pad(&mut tar_bytes);
    tar_bytes.resize(tar_bytes.len() + 1024, 0);
    let mut gz =
        flate2::write::GzEncoder::new(fs::File::create(path).unwrap(), flate2::Compression::fast());
    gz.write_all(&tar_bytes).unwrap();
    gz.finish().unwrap();
}

/// The size the budget is checked against is the one the tar crate will copy (a PAX size overrides the header's), and
/// what is copied never runs past what is left of the budget.
#[test]
fn a_pax_size_cannot_get_past_the_unpack_budget() {
    let dir = TestDir::new("pax");
    let archive = dir.0.join("pax.tar.gz");
    pax_sized_archive(&archive, 3 * 1024 * 1024);
    // The control: the same archive unpacks within a budget that fits it.
    assert!(unpack_within(&archive, 4 * 1024 * 1024).is_ok());
    let why = unpack_within(&archive, 1024 * 1024)
        .err()
        .expect("3 MiB came out of a 1 MiB budget");
    assert!(why.contains("too large"), "{why}");
}

/// A single picked `.json` is read like any other file the export names: not past the size a manifest can be, and
/// not through a link.
#[test]
fn a_picked_json_file_is_read_through_the_plain_reader() {
    let dir = TestDir::new("single");
    let v1 = json!({"format": V1_FORMAT, "version": 1}).to_string();
    let plain = dir.0.join("setup.json");
    fs::write(&plain, &v1).unwrap();
    assert!(matches!(
        open_export(&plain.to_string_lossy()),
        Ok(Opened::V1(_))
    ));

    // Valid JSON, padded to one byte past what a manifest may be: never read whole.
    let padded = dir.0.join("padded.json");
    let mut bytes = v1.clone().into_bytes();
    bytes.resize(MAX_MANIFEST as usize + 1, b' ');
    fs::write(&padded, bytes).unwrap();
    assert!(open_export(&padded.to_string_lossy()).is_err());

    #[cfg(unix)]
    {
        let link = dir.0.join("link.json");
        std::os::unix::fs::symlink(&plain, &link).unwrap();
        assert!(open_export(&link.to_string_lossy()).is_err());
    }
}

/// A listed workspace file that changes between the check and the import isn't used, and the report says so.
#[test]
fn a_listed_workspace_file_that_changed_after_the_check_is_reported() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = note_export(&source, &out.0);
    let opened = open_export(&dest.to_string_lossy()).unwrap();
    fs::write(dest.join("workspace/notes.json"), "[]").unwrap();

    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_opened(&target, &opened, &note_import(&dest), || Ok(&*conn)).unwrap();
    assert_eq!(report.notes_added, 0, "{report:?}");
    assert!(
        report
            .notes
            .iter()
            .any(|n| n.contains("workspace/notes.json") && n.contains("changed")),
        "{:?}",
        report.notes
    );
}

/// The export's own folder holds a link to a folder elsewhere with the very files the manifest lists: each listed
/// file's folder must be inside the export, so the export isn't opened.
#[cfg(unix)]
#[test]
fn a_listed_file_in_a_folder_that_leads_outside_the_export_is_refused() {
    for linked in ["memory", "memory/ash", "workspace"] {
        let source_dir = TestDir::new("source");
        let out = TestDir::new("out");
        let outside = TestDir::new("outside");
        let source = env_for(&source_dir.0);
        let dest = note_export(&source, &out.0);
        let real = dest.join(linked);
        let elsewhere = outside.0.join("moved");
        fs::rename(&real, &elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &real).unwrap();
        let why = open_refused(&dest).unwrap_or_else(|()| panic!("{linked}: opened"));
        assert!(why.contains("outside"), "{linked}: {why}");
    }
}

/// An export root that is a link to somewhere else inside the picked folder isn't taken for the export.
#[cfg(unix)]
#[test]
fn an_export_folder_that_is_a_link_inside_the_picked_folder_is_not_taken() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let outside = TestDir::new("outside");
    let source = env_for(&source_dir.0);
    let dest = note_export(&source, &out.0);
    let picked = outside.0.join("picked");
    fs::create_dir_all(&picked).unwrap();
    std::os::unix::fs::symlink(&dest, picked.join("export")).unwrap();
    assert!(
        open_refused(&picked).is_ok(),
        "a linked folder was the export"
    );
    // The control: the same export, as a real folder inside the picked one.
    fs::remove_file(picked.join("export")).unwrap();
    fs::rename(&dest, picked.join("export")).unwrap();
    assert!(open_refused(&picked).is_err(), "the control opens");
}
