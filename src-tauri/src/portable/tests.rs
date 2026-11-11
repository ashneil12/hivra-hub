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

/// What git prints for `args` in `dir` (trimmed of its trailing newline).
fn git_stdout(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

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
            teleport: None,
            move_brief_owed: false,
            moved_from: None,
            registry_agent_id: None,
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
        // The restored row is marked as an import's (`imported`), which the source row is not: that is the point of it.
        expected.remove("imported");
        let mut done_cmp = done.clone();
        done_cmp.remove("mirror_error");
        assert_eq!(done_cmp.remove("imported"), Some(serde_json::json!(1)));
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
            // The export's history, plus the commit that takes instruction and hidden files out (round 6, in every folder).
            assert_eq!(
                String::from_utf8_lossy(&log.stdout).lines().count(),
                2,
                "{name}'s history came back"
            );
            // Hidden files, .gitignore included, are taken out of a restored history; the export's tip keeps them.
            assert!(
                !target.memory_root.join(name).join(".gitignore").exists(),
                "{name}/.gitignore was restored"
            );
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
    // Built part by part so its text uses this platform's separator, as the app's own (checked) folders do.
    let project = home.join("Projects").join("app");
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

/// `base` and a `/`-separated tail, written with this platform's separator (`..` is kept as written).
fn path(base: &Path, tail: &str) -> String {
    tail.split('/')
        .fold(base.to_path_buf(), |dir, part| dir.join(part))
        .to_string_lossy()
        .into_owned()
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
        .join("Worktrees")
        .join("feature");
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
    let team = layout.target.data_dir.join("mono-teams").join("hivra-lead");
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
/// folder that holds the listed picture (so every listed hash still matches) and one more file. An export that lists
/// files in such a folder isn't opened; one swapped for a link after the check is not followed by the copy.
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
        // Opened (and so checked) while the folders are real; swapped for links after.
        let opened = open_export(&dest.to_string_lossy()).unwrap();
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

        assert_eq!(
            copy_note_assets(&target, &opened, "note-1", "note-1"),
            vec!["its folder is a link"],
            "{linked}"
        );
        assert_eq!(
            files_under(&target.data_dir.join(NOTE_ASSET_DIR)),
            Vec::<String>::new(),
            "{linked} is a link and was followed"
        );
        assert_not_in_pictures(&target, "OPENSSH PRIVATE KEY");

        // Listed in a linked folder from the start: not opened.
        let store = open_store(&target);
        let conn = store.lock_conn().unwrap();
        let why = import_held(&target, &conn, &note_import(&dest)).unwrap_err();
        assert!(why.contains("outside"), "{linked}: {why}");
        assert_eq!(
            files_under(&target.data_dir.join(NOTE_ASSET_DIR)),
            Vec::<String>::new()
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
    // Round 6: the seeded memory folder holds an instruction file, so its history gets the removal commit on top.
    assert_eq!(
        history_subjects(&target, "ash"),
        vec![
            "Removed instruction and hidden files from an imported history".to_string(),
            "memory".to_string()
        ]
    );
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
    // Round 6: the seeded memory folder holds an instruction file, so its history gets the removal commit on top.
    assert_eq!(
        history_subjects(&target, "ash"),
        vec![
            "Removed instruction and hidden files from an imported history".to_string(),
            "memory".to_string()
        ]
    );
    assert!(target.memory_root.join("ash/MEMORY.md").is_file());
}

const MIB: u64 = 1024 * 1024;

/// A file past the size its kind may be is left out, with a line in the report, and never read: the rest of the export
/// still opens and comes in. (The sizes in the manifest are the attacker's own numbers.)
#[test]
fn a_file_declared_larger_than_its_kind_is_left_out_with_a_note_and_never_read() {
    // (what is declared too large, what to ask the import for, how it shows)
    for relative in [
        "setup/setup.json",
        "workspace/sessions/chat-1.json",
        "workspace/note-assets/note-1/1-shot.png",
        "memory/ash.git.bundle",
    ] {
        let source_dir = TestDir::new("source");
        let target_dir = TestDir::new("target");
        let out = TestDir::new("out");
        let source = env_for(&source_dir.0);
        let target = env_for(&target_dir.0);
        let dest = note_export(&source, &out.0);
        let declared = match relative {
            "workspace/note-assets/note-1/1-shot.png" => 21 * MIB,
            "memory/ash.git.bundle" => 2048 * MIB,
            _ => 4096 * MIB,
        };
        edit_manifest(&dest, |manifest| {
            for file in manifest["files"].as_array_mut().unwrap() {
                if file["path"] == relative {
                    file["bytes"] = json!(declared);
                }
            }
        });
        // The export still opens: only that file is out.
        let opened = open_export(&dest.to_string_lossy())
            .unwrap_or_else(|why| panic!("{relative}: the whole export was refused: {why}"));
        assert!(opened.read(relative).is_none(), "{relative} was read");
        assert!(
            opened.read("memory/ash/MEMORY.md").is_some(),
            "the rest opens"
        );

        let store = open_store(&target);
        let conn = store.lock_conn().unwrap();
        let report = import_held(
            &target,
            &conn,
            &ImportRequest {
                path: dest.to_string_lossy().into_owned(),
                memory: Some(MemoryImport {
                    projects: vec!["ash".into()],
                    keep_both: false,
                    history: true,
                }),
                workspace: Some(WorkspaceImport {
                    notes: vec!["note-1".into()],
                    sessions: vec!["chat-1".into()],
                    ..Default::default()
                }),
            },
        )
        .unwrap_or_else(|why| panic!("{relative}: the import failed: {why}"));
        let said = report
            .notes
            .iter()
            .any(|n| n.contains(relative) && n.contains("left out"));
        match relative {
            // A note's pictures are said per note, when the note comes in.
            "workspace/note-assets/note-1/1-shot.png" => {
                assert_eq!(report.note_assets_skipped, 1, "{report:?}");
                assert!(
                    report
                        .notes
                        .iter()
                        .any(|n| n.contains("too large for a note picture")),
                    "{:?}",
                    report.notes
                );
            }
            "workspace/sessions/chat-1.json" => {
                assert!(said, "{:?}", report.notes);
                assert_eq!(report.sessions_added, 0, "{report:?}");
            }
            "memory/ash.git.bundle" => {
                assert!(said, "{:?}", report.notes);
                assert!(report.memory_history.is_empty(), "{report:?}");
            }
            _ => {
                assert!(said, "{:?}", report.notes);
                let inspected = inspect(&target, &dest.to_string_lossy()).unwrap();
                assert!(!inspected.files.contains_key(relative), "{relative}");
            }
        }
        // And the rest of what was asked for came in.
        assert_eq!(report.notes_added, 1, "{relative}: {report:?}");
    }
}

/// Large by nature: a chat holds every tool output, and Claude's own transcript of one is far past 64 MB. A file of
/// 65 MB is an ordinary file of its kind.
#[test]
fn a_session_file_larger_than_64_mb_is_read() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = note_export(&source, &out.0);
    let mut bytes = fs::read(dest.join("workspace/sessions/chat-1.json")).unwrap();
    bytes.resize(65 * MIB as usize, b' ');
    put_in_export(&dest, "workspace/sessions/chat-1.json", &bytes);

    let opened = open_export(&dest.to_string_lossy())
        .unwrap_or_else(|why| panic!("a 65 MB chat refused the export: {why}"));
    assert!(opened.json("workspace/sessions/chat-1.json").is_some());
    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(
        &target,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(WorkspaceImport {
                sessions: vec!["chat-1".into()],
                ..Default::default()
            }),
        },
    )
    .unwrap();
    assert_eq!(report.sessions_added, 1, "{report:?}");
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

/// How much of the webview's files the export lists, so a budget can be set just past them.
fn webview_bytes_listed(dest: &Path) -> u64 {
    let manifest: Value =
        serde_json::from_str(&fs::read_to_string(dest.join(MANIFEST)).unwrap()).unwrap();
    manifest["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| is_webview(f["path"].as_str().unwrap()))
        .map(|f| f["bytes"].as_u64().unwrap())
        .sum()
}

/// The preview names what an import will leave out, before anything is restored: each file that is too big, with why.
#[test]
fn the_preview_names_the_files_an_import_will_leave_out() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = note_export(&source, &out.0);
    let before = webview_bytes_listed(&dest);
    for name in ["a", "b", "c"] {
        put_in_export(&dest, &format!("setup/big-{name}.json"), &[b' '; 100]);
    }
    let path = dest.to_string_lossy().into_owned();
    let inspected = inspect_within(&target, &path, before + 250).unwrap();
    let paths: Vec<&str> = inspected.left_out.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["setup/big-c.json"], "{:?}", inspected.left_out);
    assert!(
        inspected.left_out[0].reason.contains("MB"),
        "{:?}",
        inspected.left_out
    );
    let json = serde_json::to_value(&inspected).unwrap();
    assert_eq!(json["leftOut"][0]["path"], "setup/big-c.json", "{json}");
}

/// Inspect holds no more than a budget of the webview's files whole, so the file that would take them past it is left
/// out (with a line in the report) and the ones before it come through. The budget here is set just past two of three
/// 100-byte setup files; the real one is `MAX_INSPECT_BYTES`.
#[test]
fn inspect_holds_no_more_than_a_budget_of_the_webviews_files() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = note_export(&source, &out.0);
    let before = webview_bytes_listed(&dest);
    for name in ["a", "b", "c"] {
        put_in_export(&dest, &format!("setup/big-{name}.json"), &[b' '; 100]);
    }
    let path = dest.to_string_lossy().into_owned();
    let budget = before + 250;
    let inspected = inspect_within(&target, &path, budget)
        .unwrap_or_else(|why| panic!("the whole preview was refused: {why}"));
    let big: Vec<&String> = inspected
        .files
        .keys()
        .filter(|name| name.starts_with("setup/big-"))
        .collect();
    assert_eq!(big.len(), 2, "{big:?}");
    assert!(
        inspected.files.contains_key("setup/setup.json"),
        "the ones before it come through"
    );

    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let opened = open_export_within(&path, budget).unwrap();
    let report = import_opened(
        &target,
        &opened,
        &ImportRequest {
            path,
            memory: None,
            workspace: None,
        },
        || Ok(&*conn),
    )
    .unwrap();
    assert!(
        report
            .notes
            .iter()
            .any(|n| n.contains("setup/big-c.json") && n.contains("left out")),
        "{:?}",
        report.notes
    );
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

/// The folder git reads a history bundle from is the importer's alone, and goes with it.
#[cfg(unix)]
#[test]
fn a_private_scratch_folder_is_owner_only_and_goes_when_dropped() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::private("test").unwrap();
    let path = scratch.0.clone();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(fs::read_dir(&path).unwrap().next().is_none());
    drop(scratch);
    assert!(!path.exists());
}

/// The copy git is given: the bytes that hash as listed and nothing else, in a file only this user can open, and
/// never a file that isn't a bundle, a link, or one that no longer hashes as listed.
#[test]
fn a_listed_bundle_is_copied_only_as_the_bytes_that_hash_as_listed() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let dest = memory_export(&source, &out.0);
    let bundle = dest.join("memory/ash.git.bundle");
    let bytes = fs::read(&bundle).unwrap();
    assert!(
        BUNDLE_HEADERS.contains(&&bytes[..16]),
        "the control is a bundle"
    );
    let listed_for = |bytes: &[u8]| Listed {
        path: "memory/ash.git.bundle".into(),
        declared: bytes.len() as u64,
        sha256: sha256_hex(bytes),
    };
    let scratch = Scratch::private("test").unwrap();
    let copy = scratch.0.join("copy");

    copy_listed_bundle(&bundle, &listed_for(&bytes), &copy).unwrap();
    assert_eq!(fs::read(&copy).unwrap(), bytes);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&copy).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    // Other bytes of the same length, a longer file, a shorter one: none hashes as listed.
    for (n, other) in [
        vec![b'x'; bytes.len()],
        [bytes.clone(), vec![0; 10]].concat(),
        bytes[..bytes.len() - 1].to_vec(),
    ]
    .into_iter()
    .enumerate()
    {
        fs::write(&bundle, &other).unwrap();
        let copy = scratch.0.join(format!("changed-{n}"));
        assert!(
            matches!(
                copy_listed_bundle(&bundle, &listed_for(&bytes), &copy),
                Err(HistoryRefusal::NotAsListed)
            ),
            "{n}"
        );
    }

    // Hashes as listed and isn't a bundle (a gitfile, text, nothing).
    for (n, text) in [&b"gitdir: /elsewhere/.git\n"[..], b"hello", b""]
        .into_iter()
        .enumerate()
    {
        fs::write(&bundle, text).unwrap();
        let copy = scratch.0.join(format!("not-{n}"));
        assert!(
            matches!(
                copy_listed_bundle(&bundle, &listed_for(text), &copy),
                Err(HistoryRefusal::NotABundle)
            ),
            "{n}"
        );
    }

    #[cfg(unix)]
    {
        fs::write(&bundle, &bytes).unwrap();
        let aside = scratch.0.join("aside.bundle");
        fs::rename(&bundle, &aside).unwrap();
        std::os::unix::fs::symlink(&aside, &bundle).unwrap();
        assert!(matches!(
            copy_listed_bundle(&bundle, &listed_for(&bytes), &scratch.0.join("link-copy")),
            Err(HistoryRefusal::NotAsListed)
        ));
    }
}

/// Names Windows doesn't take for what they say are refused in an export's paths there (the check itself runs
/// everywhere so it is tested everywhere).
#[test]
fn windows_names_that_are_not_what_they_say_are_unsafe() {
    for name in [
        "CON",
        "con",
        "NUL.txt",
        "aux.md",
        "COM1",
        "lpt9.png",
        "a:stream",
        "x.",
        "x ",
        "C:",
        "COM0",
        "LPT0",
        "CONIN$",
        "conout$",
        "CONOUT$.txt",
        "COM\u{b9}",
        "com\u{b2}.md",
        "COM\u{b3}",
        "LPT\u{b9}",
        "lpt\u{b2}.txt",
        "LPT\u{b3}",
    ] {
        assert!(windows_unsafe_name(name), "{name}");
    }
    for name in [
        "MEMORY.md",
        "console.md",
        "COM10",
        "LPT",
        "nul-ish",
        "a.b",
        "1-shot.png",
        "CONIN",
        "COM\u{b9}x",
    ] {
        assert!(!windows_unsafe_name(name), "{name}");
    }
}

/// What an export writes is what an import will take: a file past the size its kind may be is left out of the export,
/// with a line saying so, and the rest is written.
#[test]
fn an_export_leaves_out_a_file_an_import_would_not_take() {
    let dir = TestDir::new("writer");
    let mut writer = Writer::new(dir.0.clone());
    for (relative, size) in [
        ("setup/big.json", MAX_TEXT_FILE + 1),
        (
            "workspace/note-assets/note-1/big.png",
            crate::notes::IMAGE_MAX_BYTES + 1,
        ),
    ] {
        // Zeros: the allocation costs nothing until it is written, and a file left out is never written.
        writer
            .bytes(relative, &vec![0u8; size as usize])
            .unwrap_or_else(|why| panic!("{relative}: the whole export failed: {why}"));
        assert!(!dir.0.join(relative).exists(), "{relative} was written");
        assert!(
            writer
                .left_out
                .iter()
                .any(|n| n.contains(relative) && n.contains("left out")),
            "{relative}: {:?}",
            writer.left_out
        );
    }
    assert!(writer.files.is_empty());
    // The largest a picture may be goes in.
    writer
        .bytes(
            "workspace/note-assets/note-1/edge.png",
            &vec![0u8; crate::notes::IMAGE_MAX_BYTES as usize],
        )
        .unwrap();
    assert_eq!(writer.files.len(), 1);
}

/// The webview's files are held whole by Inspect, so the export keeps them within the same budget: the file that
/// would take them past it is left out with a line.
#[test]
fn an_export_keeps_the_webviews_files_within_the_budget_inspect_holds() {
    let dir = TestDir::new("writer");
    let mut writer = Writer::new(dir.0.clone());
    writer.webview_budget = 250;
    for name in ["a", "b", "c"] {
        writer
            .bytes(&format!("setup/big-{name}.json"), &[b' '; 100])
            .unwrap();
    }
    // Other files don't count toward it.
    writer.bytes("workspace/notes.json", &[b' '; 1000]).unwrap();
    assert_eq!(writer.files.len(), 3, "{:?}", writer.files);
    assert!(
        writer
            .left_out
            .iter()
            .any(|n| n.contains("setup/big-c.json") && n.contains("left out")),
        "{:?}",
        writer.left_out
    );
}

/// setup/setup.json is never the one file the webview's budget leaves out: it goes in first, whatever its name sorts
/// after.
#[test]
fn the_setup_file_goes_in_before_the_other_webview_files() {
    let dir = TestDir::new("writer");
    let mut writer = Writer::new(dir.0.clone());
    writer.webview_budget = 250;
    let files = BTreeMap::from([
        ("setup/a.json".to_string(), " ".repeat(100)),
        ("setup/monos/cos/SOUL.md".to_string(), "x".repeat(100)),
        ("setup/setup.json".to_string(), " ".repeat(100)),
    ]);
    write_webview_files(&mut writer, &files).unwrap();
    let written: Vec<&str> = writer
        .files
        .iter()
        .map(|(name, _, _)| name.as_str())
        .collect();
    assert!(written.contains(&"setup/setup.json"), "{written:?}");
    assert!(
        !writer
            .left_out
            .iter()
            .any(|n| n.contains("setup/setup.json")),
        "{:?}",
        writer.left_out
    );
}

/// Setup files past the budget the preview holds stop the export with one plain line (their size and the limit),
/// rather than an export that quietly misses some of them.
#[test]
fn an_export_whose_setup_files_are_past_the_budget_stops_with_one_line() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    seed(&source);
    let dest = out.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request
        .files
        .insert("setup/big.json".into(), " ".repeat(3 * 1024 * 1024));
    let why = export_within(&source, &request, 2 * 1024 * 1024).unwrap_err();
    assert!(
        why.contains("setup files") && why.contains("3.0 MB") && why.contains("2 MB"),
        "{why}"
    );
    assert!(!why.contains('\n'), "{why}");
    assert!(!dest.exists(), "an export was written");
    // Within it, the same request goes through.
    assert!(export_within(&source, &request, 8 * 1024 * 1024).is_ok());
}

/// A chat the writer leaves out (here: its name clashes with another's apart from capitals) isn't counted as exported.
#[test]
fn a_chat_left_out_of_an_export_is_not_counted() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    seed(&source);
    {
        let store = open_store(&source);
        let conn = store.lock_conn().unwrap();
        add_session(
            &conn,
            "CHAT-1",
            "Same name, other capitals",
            "claude",
            json!([block("x1", "user", "hello")]),
            9_000,
        );
    }
    let dest = out.0.join("export");
    let report = export(&source, &export_request(&dest, Form::Folder)).unwrap();
    let written = export_texts(&dest)
        .into_keys()
        .filter(|name| name.starts_with("workspace/sessions/"))
        .count();
    assert!(
        report
            .notes
            .iter()
            .any(|n| n.contains("CHAT-1") && n.contains("left out")),
        "{:?}",
        report.notes
    );
    assert_eq!(
        report.counts["sessions"],
        json!(written),
        "{:?}",
        report.counts
    );
}

/// When workspace/notes.json is left out, the notes' pictures stay out too (and no note is counted).
#[test]
fn note_pictures_stay_out_when_the_notes_are_left_out() {
    let source_dir = TestDir::new("source");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    seed(&source);
    fs::create_dir_all(&out.0).unwrap();
    let mut writer = Writer::new(out.0.clone());
    // A file of the same name apart from capitals is in first: the writer leaves the real one out.
    writer.bytes("workspace/NOTES.json", b"[]").unwrap();
    let mut counts = Map::new();
    let conn = source.read_db().unwrap().unwrap();
    export_workspace(&source, &conn, &mut writer, &mut counts).unwrap();
    assert!(
        writer
            .left_out
            .iter()
            .any(|n| n.contains("workspace/notes.json")),
        "{:?}",
        writer.left_out
    );
    let mut notes = Vec::new();
    export_note_assets(&source, &mut writer, &counts, &mut notes).unwrap();
    assert!(
        !writer
            .files
            .iter()
            .any(|(name, _, _)| name.starts_with("workspace/note-assets/")),
        "{:?}",
        writer.files
    );
    assert_eq!(counts["notes"], json!(0), "{counts:?}");
}

/// A history bundle past its cap is left out of the export with a line: the memory files still go.
#[test]
fn an_export_leaves_out_a_history_bundle_past_its_cap() {
    let dir = TestDir::new("writer");
    let mut writer = Writer::new(dir.0.clone());
    let bundle = dir.0.join("source.bundle");
    fs::write(&bundle, b"01234567890").unwrap();
    writer
        .binary("memory/ash.git.bundle", &bundle, 10)
        .unwrap_or_else(|why| panic!("the whole export failed: {why}"));
    assert!(writer.files.is_empty());
    assert!(
        writer
            .left_out
            .iter()
            .any(|n| n.contains("history") && n.contains("left out")),
        "{:?}",
        writer.left_out
    );
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
    let team = layout.target.data_dir.join("mono-teams").join("lead");
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
    let linked = home.join("Worktrees").join("linked");
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
    let tree = home.join("Worktrees").join("app-feature");
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
    let other = home.join("Projects").join("other");
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
    // The removal is a commit of its own on top of the history, never an amend of Ash's tip.
    let source_tip_before_removal = git_stdout(&monos, &["rev-parse", "HEAD"]);
    assert_eq!(
        git_stdout(&root, &["rev-parse", "HEAD~1"]),
        source_tip_before_removal,
        "the restored tip was amended"
    );
    assert_eq!(
        git_stdout(&root, &["log", "-1", "--format=%an <%ae>|%s"]),
        "Hivra import <import@hivra.invalid>|Removed instruction and hidden files from an imported history"
    );
    // Round 6: an instruction file that the export brought comes in beside its original as a note, untracked; nothing
    // else in the folder changed.
    let status = git_stdout(&root, &["status", "--porcelain"]);
    assert!(
        status
            .lines()
            .all(|line| line.starts_with("?? ") && line.contains(".imported")),
        "the restored Monos home has more than the imported notes: {status}"
    );
    assert!(
        root.join("evil/CLAUDE.imported.md").is_file(),
        "the instruction file did not come in beside its original: {status}"
    );
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
fn a_memory_import_outside_the_monos_home_never_writes_an_instruction_file_under_its_name() {
    // Round 6 (HIGH-1): a memory folder outside the Monos home is no safer for an export's instruction files. Each one
    // comes in beside its original as NAME.imported.md, with a report line; notes come in as before, and anything
    // else that is not a note is left out with a line saying so.
    let layout = layout();
    let report = import_memory_files(
        &layout,
        "ash",
        &[
            ("MEMORY.md", "# ash\n"),
            ("topics/deploy.md", "note"),
            ("CLAUDE.md", "planted rules"),
            ("AGENTS.md", "planted agents"),
            ("AGENTS.override.md", "planted override"),
            ("GEMINI.md", "planted gemini"),
            ("topics/CLAUDE.local.md", "planted local"),
            ("opencode.json", "{}"),
            ("data.txt", "plain text"),
        ],
    );
    let root = layout.target.memory_root.join("ash");
    for kept in ["MEMORY.md", "topics/deploy.md"] {
        assert!(
            root.join(kept).is_file(),
            "{kept} was not restored: {report:?}"
        );
    }
    for planted in [
        "CLAUDE.md",
        "AGENTS.md",
        "AGENTS.override.md",
        "GEMINI.md",
        "topics/CLAUDE.local.md",
        "opencode.json",
        ".mcp.json",
        "data.txt",
    ] {
        assert!(
            !root.join(planted).exists(),
            "{planted} was written under its own name: {report:?}"
        );
    }
    assert_eq!(
        fs::read_to_string(root.join("CLAUDE.imported.md")).unwrap(),
        "planted rules"
    );
    assert_eq!(
        fs::read_to_string(root.join("AGENTS.override.imported.md")).unwrap(),
        "planted override"
    );
    assert_eq!(
        fs::read_to_string(root.join("topics/CLAUDE.local.imported.md")).unwrap(),
        "planted local"
    );
    assert!(
        report
            .notes
            .iter()
            .any(|n| n.contains("CLAUDE.imported.md") && n.contains("review")),
        "{:?}",
        report.notes
    );
    assert!(
        report
            .notes
            .iter()
            .any(|n| n.contains("data.txt") && n.contains("only writes notes")),
        "{:?}",
        report.notes
    );
}

#[test]
fn an_instruction_file_is_held_for_review_only_in_a_mono_folders_id_folder_or_its_memory_or_skills()
{
    // Round 6 (LOW-3): a file at any depth under any id is not a Mono's instruction file for review. Only the id folder,
    // and the memory and skills notes under it, can hold one beside its original.
    let layout = layout();
    let report = import_memory_files(
        &layout,
        "monos",
        &[
            ("lead/a/b/CLAUDE.md", "planted deep"),
            ("lead/memory/x/CLAUDE.md", "planted in memory"),
            ("CLAUDE.md", "planted at the Monos home"),
        ],
    );
    let root = layout.target.monos_root.clone();
    assert!(
        !root.join("lead/a/b/CLAUDE.imported.md").exists(),
        "a deep instruction file was written: {report:?}"
    );
    assert!(
        !root.join("CLAUDE.imported.md").exists(),
        "a file at the Monos home was written: {report:?}"
    );
    assert_eq!(
        fs::read_to_string(root.join("lead/memory/x/CLAUDE.imported.md")).unwrap(),
        "planted in memory"
    );
    assert!(
        report
            .notes
            .iter()
            .any(|n| n.contains("lead/a/b/CLAUDE.md")),
        "{:?}",
        report.notes
    );
    for (path, expected) in [
        ("lead/CLAUDE.md", true),
        ("lead/skills/review/AGENTS.md", true),
        ("lead/memory/CLAUDE.md", true),
        ("lead/a/b/CLAUDE.md", false),
        ("CLAUDE.md", false),
        ("lead/.claude/CLAUDE.md", false),
    ] {
        assert_eq!(
            folders::instruction_file_for_review(Path::new(path)),
            expected,
            "{path}"
        );
    }
}

#[test]
fn inside_the_monos_home_instruction_files_come_in_beside_their_original_for_review() {
    let layout = layout();
    assert_eq!(
        layout.target.monos_root,
        layout.target.memory_root.join("monos")
    );
    let report = import_memory_files(
        &layout,
        "monos",
        &[
            ("MEMORY.md", "# monos\n"),
            ("lead/CLAUDE.md", "planted"),
            ("lead/AGENTS.override.md", "planted override"),
            ("lead/memory/sub/topic.md", "a nested note"),
            ("lead/notes.txt", "not a note"),
        ],
    );
    let root = layout.target.monos_root.clone();
    assert_eq!(
        fs::read_to_string(root.join("MEMORY.md")).unwrap(),
        "# monos\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("lead/memory/sub/topic.md")).unwrap(),
        "a nested note"
    );
    assert_eq!(
        fs::read_to_string(root.join("lead/CLAUDE.imported.md")).unwrap(),
        "planted"
    );
    assert_eq!(
        fs::read_to_string(root.join("lead/AGENTS.override.imported.md")).unwrap(),
        "planted override"
    );
    for dropped in [
        "lead/CLAUDE.md",
        "lead/AGENTS.override.md",
        "lead/notes.txt",
    ] {
        assert!(
            !root.join(dropped).exists(),
            "{dropped} was written: {report:?}"
        );
    }
    assert!(
        report
            .notes
            .iter()
            .any(|n| n.contains("CLAUDE.imported.md") && n.contains("review")),
        "{:?}",
        report.notes
    );
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
fn a_name_folds_the_way_a_case_insensitive_disk_reads_it() {
    // A Mac disk (APFS, case-insensitive) opens `AGENT` + U+017F (long s) + `.md` as AGENTS.md, and a Windows disk reads a
    // trailing dot or space as nothing. Every name check folds the same way, so these are all the instruction file.
    for folded in [
        "AGENT\u{17F}.md",
        "agent\u{17F}.MD",
        "AGENTS.md.",
        "AGENTS.md ",
        "\u{FF21}\u{FF27}\u{FF25}\u{FF2E}\u{FF34}\u{FF33}.md",
    ] {
        assert!(folders::instruction_file(folded), "{folded}");
        assert!(!folders::memory_note_file(Path::new(folded)), "{folded}");
        assert!(
            folders::instruction_file_at(Path::new(folded)),
            "{folded} came in under its own name"
        );
    }
    assert_eq!(fold("AGENT\u{17F}.md"), fold("AGENTS.md"));
    assert_eq!(fold("Docs/AGENT\u{17F}.md "), fold("docs/agents.md"));
    assert!(prunable_path("AGENT\u{17F}.md"));
    assert!(prunable_path("topics/AGENT\u{17F}.md"));
}

#[test]
fn the_instruction_names_the_other_agent_tools_read_are_held() {
    for name in [
        "HERMES.md",
        "hermes.md",
        "GROK.md",
        "AGENT.md",
        "CRUSH.md",
        "Crush.MD",
    ] {
        assert!(folders::instruction_file(name), "{name}");
        assert!(!folders::memory_note_file(Path::new(name)), "{name}");
        assert!(prunable_path(&format!("topics/{name}")), "{name}");
    }
    // A plain note with a similar name is still a note.
    assert!(folders::memory_note_file(Path::new("hermes-notes.md")));
    assert!(!folders::instruction_file("hermes-notes.md"));
}

#[test]
fn a_folder_with_a_name_that_folds_to_instructions_is_held_back() {
    let layout = layout();
    assert!(instructions_seen_in(
        &layout,
        "folded-long-s",
        &["AGENT\u{17F}.md"]
    ));
    assert!(instructions_seen_in(
        &layout,
        "folded-space",
        &["AGENTS.md "]
    ));
    assert!(instructions_seen_in(&layout, "hermes", &["HERMES.md"]));
    // A hidden name that is only harmless with its dot kept: a trailing dot makes it another name. Windows drops a
    // trailing dot when it creates a file, so there the name can't be on disk: the folder holds a plain `.env`.
    if cfg!(windows) {
        assert!(!instructions_seen_in(&layout, "dotted-env", &[".env."]));
        assert!(layout.root.0.join("dotted-env").join(".env").is_file());
    } else {
        assert!(instructions_seen_in(&layout, "dotted-env", &[".env."]));
    }
}

#[test]
fn a_restored_history_with_thousands_of_hidden_files_still_restores() {
    // A long prune list goes to git as a pathspec file. As arguments, seven thousand long names overflow the argument
    // list of macOS, and the restore would be refused with every file left in the folder.
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let docs = source.memory_root.join("docs");
    fs::create_dir_all(&docs).unwrap();
    // Windows' command line stops at 32,767 characters, so shorter names overflow it too; long ones would pass the
    // 260-character path limit of the test's own git there.
    let padding = "x".repeat(if cfg!(windows) { 40 } else { 150 });
    for index in 0..7000 {
        fs::write(docs.join(format!(".hidden-{index:05}-{padding}")), "x\n").unwrap();
    }
    let dest = docs_history_export(&out, &source);
    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(
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
        !report
            .notes
            .iter()
            .any(|n| n.contains("couldn't be restored")),
        "{:?}",
        report.notes
    );
    assert!(root.join(".git").exists(), "{:?}", report.notes);
    assert!(
        !git_stdout(&root, &["ls-files"])
            .lines()
            .any(|line| line.starts_with(".hidden-")),
        "hidden files are still tracked"
    );
    assert!(
        !fs::read_dir(&root)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with(".hidden-")),
        "hidden files were restored"
    );
    assert!(root.join("topics/a.md").is_file());
}

/// Whether a folder holding these entries counts as having instructions on disk (a Mono's folder is offered back only
/// without them).
fn instructions_seen_in(layout: &Layout, name: &str, entries: &[&str]) -> bool {
    let dir = layout.root.0.join(name);
    fs::create_dir_all(&dir).unwrap();
    for entry in entries {
        if entry.ends_with('/') {
            fs::create_dir_all(dir.join(entry.trim_end_matches('/'))).unwrap();
        } else {
            fs::write(dir.join(entry), "x\n").unwrap();
        }
    }
    let rules = FolderRules::load(&layout.target, &[], &[], &[], &[]);
    rules.instructions_on_disk(&dir, &dir)
}

#[test]
fn a_folder_with_env_or_venv_is_still_offered_but_one_with_instructions_is_not() {
    let layout = layout();
    for plain in [
        &[][..],
        &[".env", ".venv/"][..],
        &[".gitignore", ".DS_Store", ".git/"][..],
        &["README.md", "src/"][..],
    ] {
        assert!(
            !instructions_seen_in(&layout, "plain", plain),
            "{plain:?} was refused"
        );
    }
    for marked in [
        &["CLAUDE.md"][..],
        &["AGENTS.override.md"][..],
        &[".claude/"][..],
        &[".codex/"][..],
        &[".cursor/"][..],
        &[".gemini/"][..],
        &[".opencode/"][..],
        &[".github/"][..],
        &["opencode.json"][..],
    ] {
        assert!(
            instructions_seen_in(&layout, "marked", marked),
            "{marked:?} was offered"
        );
    }
}

#[test]
fn a_folder_with_another_tools_hidden_folder_or_a_link_is_held_back() {
    // Round 6 (MEDIUM-1): the names a folder may hold are an allow-list, compared lowercased. Any other hidden entry,
    // whatever tool it belongs to and whatever its case, and any link, holds the folder back.
    let layout = layout();
    for (index, held) in [
        ".agents/",
        ".grok/",
        ".pi/",
        ".omp/",
        ".hermes/",
        ".devin/",
        ".windsurf/",
        ".kiro/",
        ".vscode/",
        ".Claude/",
        ".CODEX/",
        ".Mcp.JSON",
        ".something-new/",
    ]
    .into_iter()
    .enumerate()
    {
        let name = format!("held-{index}");
        assert!(
            instructions_seen_in(&layout, &name, &[held]),
            "{held} was offered"
        );
    }
    for (index, plain) in [
        ".git/",
        ".gitignore",
        ".DS_Store",
        ".env",
        ".ENV",
        ".env.local",
        ".venv/",
        "README.md",
    ]
    .into_iter()
    .enumerate()
    {
        let name = format!("plain-{index}");
        assert!(
            !instructions_seen_in(&layout, &name, &[plain]),
            "{plain} was refused"
        );
    }
    #[cfg(unix)]
    {
        let dir = layout.root.0.join("linked");
        fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(&layout.outside, dir.join("notes")).unwrap();
        let rules = FolderRules::load(&layout.target, &[], &[], &[], &[]);
        assert!(rules.instructions_on_disk(&dir, &dir), "a link was offered");
    }
}

#[test]
fn an_imported_chats_media_roots_are_only_the_folders_folder_rules_keeps() {
    let layout = layout();
    let env = layout.target.clone();
    let project = layout.project.clone();
    let home = env.home.clone().unwrap();
    let rules = FolderRules::load(
        &env,
        &[project.to_string_lossy().into_owned()],
        &[],
        &["lead".into()],
        &[],
    );
    let store = open_store(&env);
    let conn = store.lock_conn().unwrap();
    let mono_folder = env.monos_root.join("lead");
    let cases = [
        ("in-project", project.join("src/deep")),
        ("outside", layout.outside.clone()),
        ("home", home.clone()),
        ("monos-home", env.monos_root.clone()),
        ("mono", mono_folder.clone()),
        ("project-top", project.clone()),
    ];
    for (id, cwd) in cases {
        let file = json!({"title": "T", "cwd": cwd.to_string_lossy(), "private": false,
               "blocks": [block("u", "user", "hi")],
               "engine": {"harness": "claude", "model": "m", "runtimeMode": "auto"}});
        insert_session(&env, &conn, id, "T", &file, &rules).unwrap();
        let kept = rules.vet(Some(&cwd.to_string_lossy()), None);
        let allowed: Vec<String> = kept
            .roots
            .iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect();
        for root in crate::chat_media::folders(&conn, None, id).folders {
            assert!(
                allowed.contains(&root),
                "{id}: {root} is a media root FolderRules does not keep ({allowed:?})"
            );
        }
    }
}

#[test]
fn an_imported_chats_own_delegation_grants_no_worker_worktree_as_a_media_root() {
    // Round 6 (LOW-1): a delegation an export wrote names the imported chat as its owner. A worker's worktree that
    // git records for the project must not become a media root for that chat (chat_media only lets a Mono's own chats
    // lend their workers' worktrees).
    let layout = layout();
    let env = layout.target.clone();
    let project = layout.project.clone();
    let home = env.home.clone().unwrap();
    let admin = project.join(".git/worktrees/app-a");
    let tree = home.join("Worktrees").join("app-a");
    fs::create_dir_all(&admin).unwrap();
    fs::create_dir_all(&tree).unwrap();
    fs::write(tree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
    fs::write(
        admin.join("gitdir"),
        format!("{}\n", tree.join(".git").display()),
    )
    .unwrap();
    let rules = FolderRules::load(
        &env,
        &[project.to_string_lossy().into_owned()],
        &[],
        &[],
        &[],
    );
    let store = open_store(&env);
    let conn = store.lock_conn().unwrap();
    let cwd = project.join("src/deep");
    let file = json!({"title": "T", "cwd": cwd.to_string_lossy(), "private": false,
           "blocks": [block("u", "user", "hi")],
           "engine": {"harness": "claude", "model": "m", "runtimeMode": "auto"}});
    insert_session(&env, &conn, "imported", "T", &file, &rules).unwrap();
    conn.execute(
        &format!(
            "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, blocks_json, created_at, updated_at, worktree_cwd, worktree_removed) VALUES ('worker', '{}', 'codex', 'test', 'supervised', 'W', '[]', 0, 0, '{}', 0)",
            project.to_string_lossy(),
            tree.to_string_lossy()
        ),
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO delegations (id, owner_session, owner_mono, root_id, child_session, request_id, state, delivery, created_at, updated_at, imported) VALUES ('d1', 'imported', NULL, 'd1', 'worker', 'd1', 'done', 'delivered', 0, 0, 1)",
        [],
    )
    .unwrap();
    let found = crate::chat_media::folders(&conn, None, "imported").folders;
    assert!(
        !found.contains(&tree.to_string_lossy().into_owned()),
        "the worker's worktree is a media root of an imported chat: {found:?}"
    );
}

#[test]
fn a_monos_folder_takes_only_the_names_mono_rs_uses() {
    let allowed = [
        "MEMORY.md",
        "lead/SOUL.md",
        "lead/MEMORY.md",
        "lead/soul-template.md",
        "lead/memory/today.md",
        "lead/memory/deep/x.md",
        "lead/memory/deep/more/x.md",
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
        "lead/memory/.hidden/x.md",
        "lead/.claude/settings.json",
        "lead/memory/a b/../x.md",
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

/// A memory folder `docs` with instruction and hidden files, its history exported, and the export's folder. Shared by the
/// history tests below (round 6: the prune reaches every folder, not only the Monos home).
fn docs_history_export(out: &TestDir, source: &Env) -> PathBuf {
    let docs = source.memory_root.join("docs");
    fs::create_dir_all(docs.join(".claude")).unwrap();
    fs::create_dir_all(docs.join(".obsidian")).unwrap();
    fs::create_dir_all(docs.join("topics")).unwrap();
    fs::write(docs.join("MEMORY.md"), "# docs\n").unwrap();
    fs::write(docs.join("topics/a.md"), "a\n").unwrap();
    fs::write(docs.join("themes.json"), "{}\n").unwrap();
    fs::write(docs.join("CLAUDE.md"), "my own rules\n").unwrap();
    fs::write(docs.join("AGENTS.override.md"), "my own override\n").unwrap();
    fs::write(docs.join(".gitignore"), ".DS_Store\n").unwrap();
    fs::write(docs.join(".obsidian/app.json"), "{}\n").unwrap();
    fs::write(docs.join(".claude/settings.json"), "{\"theme\":\"dark\"}\n").unwrap();
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
    export(source, &request).unwrap();
    dest
}

#[test]
fn a_restored_history_drops_its_instruction_and_hidden_files_in_a_commit_of_its_own_and_keeps_its_tip(
) {
    // Round 6 (HIGH-1, LOW-2): the folder is Ash's own kind of folder, not the Monos home, and its history still loses
    // its instruction and hidden files, as a commit of its own. The export's tip stays under refs/hivra/imported-tip.
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = docs_history_export(&out, &source);
    let source_tip = git_stdout(&source.memory_root.join("docs"), &["rev-parse", "HEAD"]);
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
    for kept in ["themes.json", "topics/a.md", "MEMORY.md"] {
        assert!(root.join(kept).is_file(), "{kept} was dropped");
    }
    for planted in [
        "CLAUDE.md",
        "AGENTS.override.md",
        ".gitignore",
        ".obsidian/app.json",
        ".claude/settings.json",
    ] {
        assert!(!root.join(planted).exists(), "{planted} was restored");
        assert!(
            git_stdout(&root, &["ls-files", "--", planted])
                .trim()
                .is_empty(),
            "{planted} is still tracked"
        );
    }
    // The instruction files come in beside their originals, for Ash to review.
    assert_eq!(
        fs::read_to_string(root.join("CLAUDE.imported.md")).unwrap(),
        "my own rules\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("AGENTS.override.imported.md")).unwrap(),
        "my own override\n"
    );
    assert_eq!(
        git_stdout(&root, &["rev-parse", "refs/hivra/imported-tip"]),
        source_tip,
        "the export's tip was not kept"
    );
    assert_ne!(
        git_stdout(&root, &["rev-parse", "HEAD"]),
        source_tip,
        "the removal is not a commit of its own"
    );
    assert_eq!(
        git_stdout(&root, &["log", "--oneline"]).lines().count(),
        2,
        "the history is not the export's plus one removal commit"
    );
    let status = git_stdout(&root, &["status", "--porcelain"]);
    assert!(
        status
            .lines()
            .all(|line| line.starts_with("?? ") && line.contains(".imported.md")),
        "the restored folder has more than the imported notes: {status}"
    );
}

#[test]
fn a_history_whose_removal_commit_fails_is_refused_and_leaves_no_history_behind() {
    // Round 6 (LOW-2): a failed commit is a refused restore. The removal runs under the same isolated git as the clone,
    // so a machine's own git configuration can't be the thing that fails it; here the commit's date is made invalid
    // for the restore's own commands only (the test's stand-in for an inherited environment), and the history must not
    // be left in the folder with its instruction files in it.
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = docs_history_export(&out, &source);
    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    super::INHERITED_GIT_ENV.with(|vars| {
        vars.borrow_mut().push((
            std::ffi::OsString::from("GIT_COMMITTER_DATE"),
            std::ffi::OsString::from("not a date"),
        ))
    });
    let report = import_held(
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
    );
    super::INHERITED_GIT_ENV.with(|vars| vars.borrow_mut().clear());
    let report = report.unwrap();
    let root = target.memory_root.join("docs");
    assert!(
        !root.join(".git").exists(),
        "a folder whose removal commit failed kept its history: {report:?}"
    );
    assert!(!root.join("CLAUDE.md").exists(), "{report:?}");
    assert!(
        report
            .notes
            .iter()
            .any(|n| n.contains("docs") && n.contains("couldn't be restored")),
        "{:?}",
        report.notes
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

/// Hands every git command a history restore runs on this thread `name=value`, as if the app had been started with it
/// (tests run in parallel, so nothing is set for the whole process), and takes it away again.
#[cfg(unix)]
struct InheritedGitEnv;

#[cfg(unix)]
impl InheritedGitEnv {
    fn set(name: &str, value: &Path) -> Self {
        INHERITED_GIT_ENV.with(|vars| {
            vars.borrow_mut()
                .push((name.into(), value.as_os_str().to_owned()));
        });
        Self
    }
}

#[cfg(unix)]
impl Drop for InheritedGitEnv {
    fn drop(&mut self) {
        INHERITED_GIT_ENV.with(|vars| vars.borrow_mut().clear());
    }
}

#[cfg(unix)]
/// A bundle whose tree has a filter attribute on every `.md`, an LFS config, a submodule file and attributes in a
/// folder: what git-lfs (or any filter in the machine's own git config) would act on at checkout.
fn bundle_with_filter_files(dir: &Path) -> Vec<u8> {
    let repo = dir.join("filtered");
    fs::create_dir_all(repo.join("sub")).unwrap();
    fs::write(repo.join(".gitattributes"), "*.md filter=evil\n").unwrap();
    fs::write(repo.join("sub/.gitattributes"), "* text\n").unwrap();
    fs::write(
        repo.join(".lfsconfig"),
        "[lfs]\n\turl = http://127.0.0.1:9/\n",
    )
    .unwrap();
    fs::write(
        repo.join(".gitmodules"),
        "[submodule \"x\"]\n\tpath = x\n\turl = ./x\n",
    )
    .unwrap();
    fs::write(repo.join("A.md"), "a\n").unwrap();
    fs::write(repo.join("MEMORY.md"), "an older memory\n").unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "filtered"]);
    let bundle = dir.join("filtered.bundle");
    git(
        &repo,
        &["bundle", "create", &bundle.to_string_lossy(), "--all"],
    );
    fs::read(bundle).unwrap()
}

/// The machine's own git configuration (Ash's has git-lfs filters in it) is not read while a history is restored,
/// and the files that tell git what to run at checkout are not restored with it: no filter or hook of the history
/// runs, and a bundle can't bring an LFS server, a submodule or an attribute in.
#[cfg(unix)]
#[test]
fn restoring_a_history_runs_no_filter_and_drops_the_files_that_name_one() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let outside = TestDir::new("outside");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = memory_export(&source, &out.0);
    put_in_export(
        &dest,
        "memory/ash.git.bundle",
        &bundle_with_filter_files(&outside.0),
    );
    let marker = outside.0.join("FILTER-RAN");
    let config = outside.0.join("gitconfig");
    fs::write(
        &config,
        format!(
            "[filter \"evil\"]\n\tsmudge = cat && touch '{}'\n\tclean = cat\n",
            marker.display()
        ),
    )
    .unwrap();
    let _global = InheritedGitEnv::set("GIT_CONFIG_GLOBAL", &config);

    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(&target, &conn, &history_import(&dest)).unwrap();
    assert!(
        !marker.exists(),
        "a filter from the machine's git config ran"
    );
    assert_eq!(report.memory_history, vec!["ash".to_string()], "{report:?}");
    assert_eq!(
        fs::read_to_string(target.memory_root.join("ash/A.md")).unwrap(),
        "a\n",
        "the history's files still come back"
    );
    for dropped in [
        ".gitattributes",
        "sub/.gitattributes",
        ".lfsconfig",
        ".gitmodules",
    ] {
        assert!(
            !target.memory_root.join("ash").join(dropped).exists(),
            "{dropped} was restored"
        );
    }
    assert!(
        report
            .notes
            .iter()
            .any(|n| n.contains("history of ash") && n.contains(".gitattributes")),
        "{:?}",
        report.notes
    );
}

/// A git command in a restored memory folder, the way Ash would run one: his own global config (here a stand-in that
/// defines the filters a hostile history names), hooks and attributes as git finds them.
#[cfg(unix)]
fn git_as_ash(folder: &Path, global: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .arg("-C")
        .arg(folder)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", global)
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap()
}

/// The git control files left out of a restored history are gone from its HEAD too: the folder is clean, so an
/// ordinary `git reset --hard` under Ash's own config can't bring the hostile `.gitattributes` and `.lfsconfig` back
/// and run the filter they name.
#[cfg(unix)]
#[test]
fn a_reset_after_a_restore_cannot_bring_the_control_files_back() {
    let source_dir = TestDir::new("source");
    let target_dir = TestDir::new("target");
    let out = TestDir::new("out");
    let outside = TestDir::new("outside");
    let source = env_for(&source_dir.0);
    let target = env_for(&target_dir.0);
    let dest = memory_export(&source, &out.0);
    assert!(dest.join("memory/ash/MEMORY.md").is_file());
    put_in_export(
        &dest,
        "memory/ash.git.bundle",
        &bundle_with_filter_files(&outside.0),
    );
    let store = open_store(&target);
    let conn = store.lock_conn().unwrap();
    let report = import_held(&target, &conn, &history_import(&dest)).unwrap();
    assert_eq!(report.memory_history, vec!["ash".to_string()], "{report:?}");
    let folder = target.memory_root.join("ash");

    // Ash's global config, with a stand-in for git-lfs and the filter the history's attributes name.
    let marker = outside.0.join("FILTER-RAN");
    let global = outside.0.join("ash-gitconfig");
    let run = format!("touch '{}'; cat", marker.display());
    fs::write(
        &global,
        format!(
            "[filter \"lfs\"]\n\tsmudge = {run}\n\tclean = {run}\n\trequired = true\n[filter \"evil\"]\n\tsmudge = {run}\n\tclean = {run}\n"
        ),
    )
    .unwrap();

    let tree = git_as_ash(&folder, &global, &["ls-tree", "-r", "--name-only", "HEAD"]);
    assert!(tree.status.success());
    let tree = String::from_utf8_lossy(&tree.stdout).into_owned();
    for control in [".gitattributes", ".lfsconfig", ".gitmodules"] {
        assert!(
            !tree
                .lines()
                .any(|path| path.rsplit('/').next() == Some(control)),
            "HEAD still holds {control}: {tree}"
        );
    }
    let author = git_as_ash(&folder, &global, &["log", "-1", "--format=%an <%ae>%n%s"]);
    let author = String::from_utf8_lossy(&author.stdout).into_owned();
    assert!(
        author.starts_with("Hivra import <import@hivra.invalid>"),
        "{author}"
    );

    // Nothing staged or deleted: only what the import itself wrote (the export's newer MEMORY.md, its other files).
    let status = git_as_ash(&folder, &global, &["status", "--porcelain"]);
    let status = String::from_utf8_lossy(&status.stdout).into_owned();
    for line in status.lines() {
        assert!(
            line.starts_with(" M ") || line.starts_with("?? "),
            "unexpected status line {line:?} in {status}"
        );
    }
    assert!(status.contains(" M MEMORY.md"), "{status}");

    let reset = git_as_ash(&folder, &global, &["reset", "--hard", "--quiet"]);
    assert!(
        reset.status.success(),
        "{}",
        String::from_utf8_lossy(&reset.stderr)
    );
    for control in [".gitattributes", ".lfsconfig", ".gitmodules"] {
        assert!(
            !folder.join(control).exists(),
            "the reset brought back {control}"
        );
    }
    assert_eq!(
        fs::read_to_string(folder.join("MEMORY.md")).unwrap(),
        "an older memory\n"
    );
    assert!(!marker.exists(), "a filter ran on the reset");
}

/// The folder an archive is unpacked into is the importer's alone.
#[cfg(unix)]
#[test]
fn an_unpacked_archive_is_in_a_folder_only_this_user_can_open() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TestDir::new("unpack");
    let archive = dir.0.join("a.tar.gz");
    pax_sized_archive(&archive, 10);
    let scratch = unpack(&archive).unwrap();
    assert_eq!(
        fs::metadata(&scratch.0).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

/// What an import holds a whole export to, the export holds itself to before it writes the manifest.
#[test]
fn an_export_is_checked_against_the_totals_an_import_takes() {
    assert!(check_export_limits(MAX_ENTRIES, MAX_UNPACKED).is_ok());
    let why = check_export_limits(MAX_ENTRIES + 1, 0).unwrap_err();
    assert!(
        why.contains("500000") || why.contains("500,000") || why.contains(&MAX_ENTRIES.to_string()),
        "{why}"
    );
    let why = check_export_limits(1, MAX_UNPACKED + 1).unwrap_err();
    assert!(why.contains("GB"), "{why}");
}

/// The rule export and import share: what is left out, and why.
#[test]
fn the_size_rule_is_one_for_export_and_import() {
    let reason =
        |path: &str, size: u64, used: u64| left_out_reason(path, size, used, MAX_INSPECT_BYTES);
    let text = MAX_TEXT_FILE;
    assert!(reason("workspace/sessions/a.json", text, 0).is_none());
    assert!(reason("workspace/sessions/a.json", text + 1, 0).is_some());
    assert!(reason("workspace/notes.json", 150 * MIB, 0).is_none());
    let picture = crate::notes::IMAGE_MAX_BYTES;
    assert!(reason("workspace/note-assets/n/a.png", picture, 0).is_none());
    assert!(reason("workspace/note-assets/n/a.png", picture + 1, 0).is_some());
    assert!(reason("memory/ash.git.bundle", MAX_BUNDLE, 0).is_none());
    assert!(reason("memory/ash.git.bundle", MAX_BUNDLE + 1, 0).is_some());
    // A memory file called .bundle inside a folder is text, not a history.
    assert!(reason("memory/ash/x.git.bundle", MAX_BUNDLE, 0).is_some());
    // The webview's files together: the one that takes them past the budget is out.
    assert!(reason("setup/a.json", MAX_INSPECT_BYTES, 0).is_none());
    assert!(reason("setup/a.json", 1, MAX_INSPECT_BYTES).is_some());
    assert!(reason("workspace/hub/g.json", 100 * MIB, 200 * MIB).is_some());
    // Other files don't count toward it.
    assert!(reason("workspace/notes.json", 100 * MIB, MAX_INSPECT_BYTES).is_none());
}

/// A folder that can't be resolved is only taken for inside when it isn't there at all.
#[cfg(unix)]
#[test]
fn a_folder_that_cannot_be_resolved_is_not_taken_for_inside() {
    let dir = TestDir::new("inside");
    let outside = TestDir::new("outside");
    fs::create_dir_all(dir.0.join("real")).unwrap();
    fs::write(dir.0.join("file"), "x").unwrap();
    std::os::unix::fs::symlink(&outside.0, dir.0.join("link")).unwrap();
    let root = fs::canonicalize(&dir.0).unwrap();
    assert!(folder_is_inside(&root, &dir.0.join("real")));
    assert!(folder_is_inside(&root, &dir.0.join("not-there")));
    // The file is in the way of a folder: ENOTDIR, not "not there".
    assert!(!folder_is_inside(&root, &dir.0.join("file/sub")));
    assert!(!folder_is_inside(&root, &dir.0.join("link")));
}

// Review #231 r2 repro (MEDIUM): an export does not carry a chat's More agents entry, and the import writes none. A More
// agents chat is saved with the placeholder harness `claude` (App.tsx, registrySessionFields), so the imported chat is
// a plain Claude chat: its next message starts Claude Code with the other agent's conversation as its brief, instead of
// going to the entry or refusing with "That agent is no longer in your list". The import should keep the entry id (the
// target's own list and approval still decide whether it runs) or mark the chat so it refuses.
#[test]
fn review_231_r2_an_imported_more_agents_chat_does_not_become_a_claude_chat() {
    let source_dir = TestDir::new("registry-source");
    let target_dir = TestDir::new("registry-target");
    let out = TestDir::new("registry-out");
    let source = env_for(&source_dir.0);
    let store = open_store(&source);
    let conn = store.lock_conn().unwrap();
    add_session(
        &conn,
        "acp-chat",
        "Copilot",
        "claude",
        json!([
            block("b1", "user", "hello"),
            block("b2", "assistant", "hi from copilot")
        ]),
        5_000,
    );
    assert!(session_store::adopt_registry_agent(&conn, "acp-chat", "my-copilot").unwrap());
    drop(conn);
    drop(store);

    let dest = out.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.files.clear();
    export(&source, &request).unwrap();

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
                sessions: vec!["acp-chat".into()],
                ..Default::default()
            }),
        },
    )
    .unwrap();
    let stored = session_store::get_session(&conn, "acp-chat")
        .unwrap()
        .unwrap();
    assert_eq!(stored.harness, "claude");
    assert_eq!(
        stored.registry_agent_id.as_deref(),
        Some("my-copilot"),
        "the imported More agents chat lost its entry and runs as a Claude chat"
    );
}

/// A chat exported while a move is open, then brought in as a copy, must not keep that move's notices. The same chat
/// imported under its own id keeps them, so recovery on the machine it belongs to can still finish the move.
#[test]
fn an_imported_copy_drops_move_notices_and_the_same_chat_keeps_them() {
    let source_dir = TestDir::new("move-source");
    let same_dir = TestDir::new("move-same");
    let copy_dir = TestDir::new("move-copy");
    let out = TestDir::new("move-out");
    let source = env_for(&source_dir.0);
    let store = open_store(&source);
    {
        let conn = store.lock_conn().unwrap();
        add_session(
            &conn,
            "chat-move",
            "Mid move",
            "claude",
            json!([
                block("b1", "user", "keep this message"),
                {
                    "id": "teleport-frozen-m1",
                    "role": "system",
                    "text": "{}",
                    "notice": "teleport-frozen"
                },
                {
                    "id": "teleported@host-a@1",
                    "role": "system",
                    "text": "Moved to Studio box",
                    "notice": "teleported"
                }
            ]),
            5_000,
        );
    }
    drop(store);

    let dest = out.0.join("export");
    let mut request = export_request(&dest, Form::Folder);
    request.memory = None;
    request.files.clear();
    export(&source, &request).unwrap();

    let same = env_for(&same_dir.0);
    let same_store = open_store(&same);
    let conn = same_store.lock_conn().unwrap();
    let added = import_held(
        &same,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(WorkspaceImport {
                sessions: vec!["chat-move".into()],
                ..Default::default()
            }),
        },
    )
    .unwrap();
    assert_eq!(added.sessions_added, 1);
    let kept: String = conn
        .query_row(
            "SELECT blocks_json FROM sessions WHERE id = 'chat-move'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(kept.contains("keep this message"));
    assert!(
        kept.contains("teleport-frozen"),
        "a chat imported under its own id lost the note recovery needs"
    );
    drop(conn);
    drop(same_store);

    let copy_env = env_for(&copy_dir.0);
    let copy_store = open_store(&copy_env);
    let conn = copy_store.lock_conn().unwrap();
    add_session(
        &conn,
        "chat-move",
        "Already here",
        "claude",
        json!([block("x", "user", "mine")]),
        9_000,
    );
    let report = import_held(
        &copy_env,
        &conn,
        &ImportRequest {
            path: dest.to_string_lossy().into_owned(),
            memory: None,
            workspace: Some(WorkspaceImport {
                sessions: vec!["chat-move".into()],
                session_copies: vec!["chat-move".into()],
                ..Default::default()
            }),
        },
    )
    .unwrap();
    assert_eq!(report.sessions_copied, 1, "{report:?}");
    let copy_id = &report.renamed["chat-move"];
    let blocks: String = conn
        .query_row(
            "SELECT blocks_json FROM sessions WHERE id = ?1",
            [copy_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(blocks.contains("keep this message"), "{blocks}");
    assert!(
        !blocks.contains("teleport"),
        "an imported copy kept a move notice: {blocks}"
    );
}
