// The opt-in seed copy (scripts/hub-seed-dev.mjs) on fixture databases in a throwaway HOME.
//
// Nothing here reads or writes Ash's real data: the "daily" database is a fixture with the real tables
// (session_store.rs, automations.rs, reminders.rs), and every target is a slot folder under the temporary HOME.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const emit = process.emitWarning;
process.emitWarning = (warning, ...rest) =>
  String(warning?.message ?? warning).includes("SQLite") ? undefined : emit.call(process, warning, ...rest);
const { DatabaseSync } = require("node:sqlite");

const DAILY = "com.ash.monocode-hub";
const SLOT = "com.ash.monocode-hub.dev.seed-test";
const load = () => import(pathToFileURL(path.join(__dirname, "hub-seed-dev.mjs")).href);

function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-seed-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const support = (root, identifier) => path.join(root, "Library/Application Support", identifier);

/** A database shaped like the daily one, with something in every table the seed must clear. */
function dailyFixture(root, { schema = 19 } = {}) {
  const dir = support(root, DAILY);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "monocode.db");
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES (${schema}, 1);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, harness TEXT NOT NULL, model TEXT NOT NULL, runtime_mode TEXT NOT NULL,
      title TEXT NOT NULL, provider_session_id TEXT, blocks_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, automation_id TEXT,
      queued_messages_json TEXT NOT NULL DEFAULT '[]', queue_status TEXT, goal_json TEXT);
    INSERT INTO sessions VALUES
      ('s1', '/p/a', 'claude', 'opus', 'agent', 'Chat one', 'claude-real-1', '[{"role":"user","text":"hi"}]', 1, 2, NULL, '[]', NULL, '{"objective":"the save test passes","checks":2,"status":"active","setAt":1}'),
      ('s2', '/p/b', 'claude', 'opus', 'agent', 'Chat two', 'claude-real-2', '[{"role":"user","text":"yo"}]', 1, 3, 'auto-1', '[{"text":"queued"}]', 'waiting', NULL),
      ('s3', '/p/c', 'codex', 'gpt', 'agent', 'Chat three', NULL, '[]', 1, 4, NULL, '[]', NULL, NULL);
    CREATE TABLE in_flight_sessions (session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, sort_index INTEGER NOT NULL);
    INSERT INTO in_flight_sessions VALUES ('s1', '/p/a', 0);
    CREATE TABLE workspace_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO workspace_snapshot VALUES (1, '{"tabs":["s1"]}', 5);
    CREATE TABLE worktree_removals (path TEXT PRIMARY KEY, sessions_json TEXT NOT NULL);
    INSERT INTO worktree_removals VALUES ('/Users/ash/Worktrees/real', '[]');
    CREATE TABLE imported_chat_folders (session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, worktree_cwd TEXT, blocked INTEGER NOT NULL DEFAULT 0);
    INSERT INTO imported_chat_folders VALUES ('s1', '/Users/old/Projects/app', NULL, 0);
    CREATE TABLE automations (id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO automations VALUES ('auto-1', '{}', 1, 9, 9);
    CREATE TABLE automation_runs (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, run_json TEXT NOT NULL);
    INSERT INTO automation_runs VALUES ('r1', 'auto-1', 9, '{}'), ('r2', 'auto-1', 10, '{}');
    CREATE TABLE automation_event_claims (automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE, event_key TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (automation_id, event_key));
    INSERT INTO automation_event_claims VALUES ('auto-1', 'e1', 9);
    CREATE TABLE session_reminders (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, due_at INTEGER NOT NULL CHECK (due_at > 0), fired_at INTEGER);
    INSERT INTO session_reminders VALUES ('s3', 100, NULL);
    CREATE TABLE orchestration_runs (lead_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE orchestration_sidebar (lead_id TEXT PRIMARY KEY, summary TEXT NOT NULL);
    CREATE TABLE orchestration_workers (session_id TEXT PRIMARY KEY, lead_id TEXT NOT NULL);
    INSERT INTO orchestration_runs VALUES ('s1', '{}');
    INSERT INTO orchestration_sidebar VALUES ('s1', '{}');
    INSERT INTO orchestration_workers VALUES ('s2', 's1');
    CREATE TABLE delegations (id TEXT PRIMARY KEY, owner_session TEXT NOT NULL, state TEXT NOT NULL, delivery TEXT NOT NULL);
    INSERT INTO delegations VALUES ('t-1', 's1', 'completed', 'pending'), ('t-2', 's1', 'running', 'pending');
    CREATE TABLE delegation_chat_binds (provider_session TEXT PRIMARY KEY, chat_id TEXT NOT NULL);
    INSERT INTO delegation_chat_binds VALUES ('claude-real-1', 's1');
    CREATE TABLE steer_messages (id TEXT PRIMARY KEY, child_session TEXT NOT NULL, state TEXT NOT NULL);
    INSERT INTO steer_messages VALUES ('s-1', 's2', 'pending');
    CREATE TABLE decisions (project TEXT NOT NULL, decision_key TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (project, decision_key));
    INSERT INTO decisions VALUES ('hivra', 'retention', 'open');
    CREATE TABLE autopilot_switches (scope TEXT PRIMARY KEY, until_ms INTEGER NOT NULL, set_by TEXT NOT NULL, set_at INTEGER NOT NULL);
    INSERT INTO autopilot_switches VALUES ('*', 9999999999999, 'ash', 1);
    CREATE TABLE autopilot_resumes (session_id TEXT PRIMARY KEY, resets_at INTEGER NOT NULL, resume_at INTEGER NOT NULL, state TEXT NOT NULL);
    INSERT INTO autopilot_resumes VALUES ('s1', 5, 6, 'armed');
    CREATE TABLE autopilot_log (id TEXT PRIMARY KEY, at INTEGER NOT NULL, what TEXT NOT NULL);
    INSERT INTO autopilot_log VALUES ('ap-1', 1, 'Autopilot on for everything');
    CREATE TABLE pr_watches (id TEXT PRIMARY KEY, owner_session TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL);
    INSERT INTO pr_watches VALUES ('w1', 's1', 'ashneil12/hivra', 42, 'watching');
    CREATE TABLE pr_watch_wakes (id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, owner_session TEXT NOT NULL, delivery TEXT NOT NULL);
    INSERT INTO pr_watch_wakes VALUES ('pr-watch-w1-1', 'w1', 's1', 'pending'), ('pr-watch-w1-2', 'w1', 's1', 'delivered');
    CREATE TABLE hub_local_docs (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0);
    INSERT INTO hub_local_docs VALUES ('fan-out-compares', '[{"id":"compare-1"}]', 1, 3), ('fresh-eyes', '{"settings":{},"reviews":[{"requestId":"r1"}]}', 1, 3), ('home', '{"recent":[]}', 1, 2);
    CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);
    INSERT INTO notes VALUES ('n1', 'kept');
    -- Hivra WP-92: the vault's index (never a value: values live in the keychain).
    CREATE TABLE secrets (scope TEXT NOT NULL, name TEXT NOT NULL, label TEXT NOT NULL, last4 TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER,
      version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (scope, name));
    INSERT INTO secrets VALUES ('global', 'stripe-api-key', 'Stripe', 'cd12', 1, 2, NULL, 3),
      ('project./p/a', 'resend-key', 'Resend', NULL, 1, 2, NULL, 1);
    CREATE TABLE secret_grants (scope TEXT NOT NULL, name TEXT NOT NULL, subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL, executable TEXT NOT NULL, mode TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (scope, name, subject_kind, subject_id, executable));
    INSERT INTO secret_grants VALUES ('global', 'stripe-api-key', 'mono', 'tally', 'curl', 'always', 1),
      ('global', 'stripe-api-key', 'project', '/p/a', '*', 'once', 2);
    CREATE TABLE secret_requests (id TEXT PRIMARY KEY, chat TEXT NOT NULL, mono TEXT, project TEXT,
      scope TEXT NOT NULL, name TEXT NOT NULL, why TEXT NOT NULL, state TEXT NOT NULL, answer_token TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO secret_requests VALUES ('req-1', 's1', 'Tally', NULL, 'global', 'resend-key', 'to send', 'open', NULL, 1, 1);
    CREATE TABLE secret_env_writes (scope TEXT NOT NULL, name TEXT NOT NULL, worktree TEXT NOT NULL,
      env_name TEXT NOT NULL, written_at INTEGER NOT NULL, PRIMARY KEY (scope, name, worktree));
    INSERT INTO secret_env_writes VALUES ('project./p/a', 'resend-key', '/p/a', 'RESEND_API_KEY', 1);
    -- The person's choice about "Always" for programs that can run any code: a dev copy starts with it off.
    CREATE TABLE secret_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO secret_settings VALUES ('always_for_any_code', '1');
  `);
  // Leave the last writes in the WAL, as a running daily app would.
  db.exec("PRAGMA wal_autocheckpoint = 0; UPDATE sessions SET title = 'Chat one (latest)' WHERE id = 's1';");
  return { file, db };
}

const fingerprint = (file) =>
  ["", "-wal"].map((suffix) =>
    fs.existsSync(file + suffix) ? crypto.createHash("sha256").update(fs.readFileSync(file + suffix)).digest("hex") : null,
  );

const rows = (file, sql) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
};

test("a seed copies every chat, clears what would act on Ash's behalf, and never writes to the source", async (t) => {
  const { seedDev } = await load();
  const root = home(t);
  const daily = dailyFixture(root);
  t.after(() => daily.db.close());
  const before = fingerprint(daily.file);
  const to = support(root, SLOT);

  const report = await seedDev({ to, home: root });

  assert.deepEqual(fs.readdirSync(to).sort(), ["instance-owner.sqlite", "monocode.db", "seeded.json"], "no temporary files left");
  assert.equal(report.sessions, 3);
  assert.equal(report.schemaVersion, 19);
  // Out of WAL: one file, which a read-only tool can open without creating anything beside it.
  const header = fs.readFileSync(path.join(to, "monocode.db")).subarray(18, 20);
  assert.deepEqual([...header], [1, 1], "rollback-journal mode in the file header");
  execFileSync("sqlite3", [`file:${path.join(to, "monocode.db")}?mode=ro`, "SELECT count(*) FROM sessions"]);
  assert.deepEqual(report.cleared, {
    inFlightTurns: 1,
    workspaceSnapshot: 1,
    worktreeRemovals: 1,
    importedChatFolders: 1,
    automationRuns: 2,
    automationEventClaims: 1,
    automations: 1,
    reminders: 1,
    orchestrationRuns: 1,
    orchestrationSidebar: 1,
    orchestrationWorkers: 1,
    delegations: 2,
    delegationChatBinds: 1,
    steerMessages: 1,
    decisions: 1,
    autopilotSwitches: 1,
    autopilotResumes: 1,
    prWatchWakes: 2,
    prWatches: 1,
    fanOutCompares: 1,
    freshEyesReviews: 1,
    queuedMessages: 1,
    goals: 1,
    providerSessionIds: 2,
    // WP-92: the vault's index, grants, requests and .env records stay with the daily app; only the chats come over,
    // and the keychain names (and so the values) are the daily app's own and never read here.
    secrets: 2,
    secretGrants: 2,
    secretRequests: 1,
    secretEnvWrites: 1,
    secretSettings: 1,
  });
  assert.deepEqual(rows(path.join(to, "monocode.db"), "SELECT count(*) AS n FROM sessions WHERE goal_json IS NOT NULL"), [{ n: 0 }], "no chat's /goal comes along");
  const copy = path.join(to, "monocode.db");
  // The chats, including the write still in the source's WAL (an online backup sees it).
  assert.deepEqual(rows(copy, "SELECT id, title, blocks_json, provider_session_id, queued_messages_json, queue_status FROM sessions ORDER BY id"), [
    { id: "s1", title: "Chat one (latest)", blocks_json: '[{"role":"user","text":"hi"}]', provider_session_id: null, queued_messages_json: "[]", queue_status: null },
    { id: "s2", title: "Chat two", blocks_json: '[{"role":"user","text":"yo"}]', provider_session_id: null, queued_messages_json: "[]", queue_status: null },
    { id: "s3", title: "Chat three", blocks_json: "[]", provider_session_id: null, queued_messages_json: "[]", queue_status: null },
  ]);
  for (const table of ["in_flight_sessions", "workspace_snapshot", "worktree_removals", "imported_chat_folders", "automations", "automation_runs", "automation_event_claims", "session_reminders", "orchestration_runs", "orchestration_sidebar", "orchestration_workers", "delegations", "delegation_chat_binds", "steer_messages", "decisions", "autopilot_switches", "autopilot_resumes", "pr_watches", "pr_watch_wakes", "secrets", "secret_grants", "secret_requests", "secret_env_writes", "secret_settings"])
    assert.deepEqual(rows(copy, `SELECT count(*) AS n FROM ${table}`), [{ n: 0 }], table);
  assert.deepEqual(
    rows(copy, "SELECT key FROM hub_local_docs ORDER BY key"),
    [{ key: "home" }],
    "a held brief and its review name Ash's real chats and stay behind; the other hub documents come along",
  );
  assert.deepEqual(rows(copy, "SELECT count(*) AS n FROM autopilot_log"), [{ n: 1 }], "the autopilot log is history and stays");
  assert.deepEqual(rows(copy, "SELECT body FROM notes"), [{ body: "kept" }], "everything else is kept");
  assert.deepEqual(
    rows(copy, "SELECT key FROM hub_local_docs ORDER BY key"),
    [{ key: "home" }],
    "a compare's records name Ash's real worktrees and stay behind; the other hub documents come along",
  );

  assert.deepEqual(fingerprint(daily.file), before, "the source's database and WAL are byte for byte the same");
  assert.deepEqual(fs.readdirSync(path.dirname(daily.file)).sort(), ["monocode.db", "monocode.db-shm", "monocode.db-wal"], "nothing new beside the source");
  const seeded = JSON.parse(fs.readFileSync(path.join(to, "seeded.json"), "utf8"));
  assert.equal(seeded.from, daily.file);
});

test("refuses the daily data folder, a link to it, and anything that isn't a dev slot's folder", async (t) => {
  const { seedDev, SeedRefusal } = await load();
  const root = home(t);
  const daily = dailyFixture(root);
  t.after(() => daily.db.close());
  const before = fingerprint(daily.file);
  const dailyDir = support(root, DAILY);

  await assert.rejects(seedDev({ to: dailyDir, home: root }), (error) => error instanceof SeedRefusal && /daily app's data folder/.test(error.message));
  await assert.rejects(seedDev({ to: path.join(dailyDir, "sub"), home: root }), /daily app's data folder/);
  // A dev-looking name that is really a link to the daily folder.
  const link = support(root, "com.ash.monocode-hub.dev.sneaky");
  fs.symlinkSync(dailyDir, link);
  await assert.rejects(seedDev({ to: link, home: root }), /daily app's data folder/);
  for (const other of [support(root, "com.monocode.desktop"), support(root, "com.ash.monocode-hub.sandbox"), path.join(root, "anywhere")])
    await assert.rejects(seedDev({ to: other, home: root }), /not a dev slot's data folder/, other);
  await assert.rejects(seedDev({ to: support(root, SLOT), from: path.join(support(root, SLOT), "monocode.db"), home: root }), /inside the slot/);
  await assert.rejects(seedDev({ to: support(root, SLOT), from: path.join(root, "missing.db"), home: root }), /no database at/);

  assert.deepEqual(fingerprint(daily.file), before);
  assert.ok(!fs.existsSync(path.join(dailyDir, "instance-owner.sqlite")), "never touched the daily folder's lock");
  assert.ok(!fs.existsSync(path.join(dailyDir, "seeded.json")));
  for (const dir of [support(root, "com.monocode.desktop"), path.join(root, "anywhere")]) assert.ok(!fs.existsSync(dir), "created nothing");
});

test("refuses a slot a running dev copy holds (its instance lock), and seeds it once that copy is gone", async (t) => {
  const { seedDev } = await load();
  const root = home(t);
  const daily = dailyFixture(root);
  t.after(() => daily.db.close());
  const to = support(root, SLOT);
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, "running.json"), JSON.stringify({ pid: 4242, kind: "dev", slot: "seed-test", branch: "hub/x", sha: "abcdef1234567" }));
  // Another process holds the lock the way the app does (instance.rs: BEGIN EXCLUSIVE for its whole life).
  const holder = spawn(
    process.execPath,
    [
      "--no-warnings",
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(process.argv[1]);
       db.exec("BEGIN EXCLUSIVE");
       console.log("locked");
       setInterval(() => {}, 1000);`,
      path.join(to, "instance-owner.sqlite"),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => holder.kill("SIGKILL"));
  await new Promise((resolve) => holder.stdout.once("data", resolve));

  await assert.rejects(seedDev({ to, home: root }), /a dev copy is running on .* \(pid 4242, hub\/x @ abcdef1\); quit it first/);
  assert.ok(!fs.existsSync(path.join(to, "monocode.db")));

  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  const report = await seedDev({ to, home: root });
  assert.equal(report.sessions, 3);
});

test("refuses a slot that already has chats unless --replace, which moves them aside first", async (t) => {
  const { seedDev } = await load();
  const root = home(t);
  const daily = dailyFixture(root);
  t.after(() => daily.db.close());
  const to = support(root, SLOT);
  fs.mkdirSync(to, { recursive: true });
  const existing = new DatabaseSync(path.join(to, "monocode.db"));
  existing.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('dev-only');");
  existing.close();

  await assert.rejects(seedDev({ to, home: root }), /already has chats; pass --replace/);
  assert.deepEqual(rows(path.join(to, "monocode.db"), "SELECT id FROM sessions"), [{ id: "dev-only" }], "untouched");

  const report = await seedDev({ to, home: root, replace: true, now: () => new Date("2026-10-19T12:00:00Z") });
  assert.equal(report.sessions, 3);
  assert.ok(report.movedAside.endsWith("monocode.db.before-seed-2026-10-19T12-00-00-000Z"));
  assert.deepEqual(rows(report.movedAside, "SELECT id FROM sessions"), [{ id: "dev-only" }], "the old chats are kept beside it");
});

test("refuses a source written by a newer build than this checkout (the dev copy would refuse it, exit 65)", async (t) => {
  const { seedDev, checkoutSchemaVersion } = await load();
  const supported = checkoutSchemaVersion();
  assert.ok(Number.isInteger(supported) && supported > 0, "reads SCHEMA_VERSION from session_store.rs");
  const root = home(t);
  const daily = dailyFixture(root, { schema: supported + 1 });
  t.after(() => daily.db.close());
  const to = support(root, SLOT);
  await assert.rejects(seedDev({ to, home: root }), new RegExp(`newer build \\(schema ${supported + 1}; this checkout knows up to ${supported}\\)`));
  assert.ok(!fs.existsSync(path.join(to, "monocode.db")));
  assert.deepEqual(fs.readdirSync(to).filter((name) => name.startsWith(".seed-")), [], "the half-made copy is gone");
});
