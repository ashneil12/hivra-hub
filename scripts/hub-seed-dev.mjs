#!/usr/bin/env node
// `npm run hub:seed-dev`: give a dev slot a cleaned copy of the daily app's chats (Phase 1b WP2,
// docs/PHASE-1B-DEV-SETUP.md). Opt-in; `npm run hub:dev -- --seed` runs it before starting the slot.
//
//   npm run hub:seed-dev                        # this worktree's slot, from the daily database
//   npm run hub:seed-dev -- --slot my-slot      # another slot
//   npm run hub:seed-dev -- --replace           # the slot already has chats: move them aside and seed again
//   npm run hub:seed-dev -- --from <file.db>    # seed from another database (a fixture, a backup)
//
// How:
// 1. Refuse first: a target that is the daily data folder (or isn't a dev slot's folder at all), a target a running dev
//    copy holds (its instance lock, instance-owner.sqlite), a target that already has a database (without --replace),
//    and a source newer than this checkout's schema (the dev build would refuse it, exit 65).
// 2. Take the slot's instance lock for the whole seed, so the slot can't start half-way through.
// 3. Copy the source with SQLite's online backup API, opened read-only: the daily app may keep running, and nothing
//    is ever written back to it.
// 4. In the copy only, clear what would make a dev copy act on Ash's behalf or resume his real Claude transcripts:
//    in-flight turns, queued messages, the open-tab snapshot, pending worktree removals, automations and their runs,
//    reminders, orchestration rows, delegation rows and chat bindings, autopilot switches and resumes, every chat's
//    open /goal, and every provider_session_id.
// 5. Check the copy's integrity, move it into place, and record what was done in seeded.json beside it.
//
// Only monocode.db is copied: not monos/ (habits), not checkpoints, not the Keychain (a dev copy uses its own names).
// Tests: scripts/hub-seed-dev.test.cjs (fixture databases only).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEV_IDENTIFIER_PREFIX, HUB_IDENTIFIER, kindOf } from "./hub-bundle.mjs";
import { ROOT, isMain, planSlot, readRunning, registerSlot, samePath, supportDir } from "./hub-dev.mjs";

export const DB_FILE = "monocode.db";
export const LOCK_FILE = "instance-owner.sqlite";

/** node:sqlite, without its "experimental" warning on every run. */
async function sqlite() {
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) =>
    String(warning?.message ?? warning).includes("SQLite") ? undefined : emit.call(process, warning, ...rest);
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
}

/** The schema this checkout's build writes (session_store.rs SCHEMA_VERSION), or null when it can't be read. */
export function checkoutSchemaVersion(root = ROOT) {
  try {
    const source = fs.readFileSync(path.join(root, "src-tauri/src/session_store.rs"), "utf8");
    const match = /pub const SCHEMA_VERSION: i64 = (\d+);/.exec(source);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export class SeedRefusal extends Error {}

function canonicalPath(target) {
  // Resolve symlinks in the part that exists, so a link into the daily folder is caught too.
  let existing = path.resolve(target);
  const rest = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.realpathSync(existing), ...rest);
}

/** Why `to` must not be seeded, or null. Pure checks; the lock and an existing database are checked by `seedDev`. */
export function targetRefusal({ to, from, home = os.homedir() }) {
  const target = canonicalPath(to);
  const daily = canonicalPath(path.join(supportDir(home), HUB_IDENTIFIER));
  if (target === daily || target.startsWith(`${daily}${path.sep}`))
    return "that is the daily app's data folder; a seed only ever writes into a dev slot's folder";
  if (kindOf(path.basename(target)) !== "dev")
    return `${to} is not a dev slot's data folder (${DEV_IDENTIFIER_PREFIX}<slot>)`;
  if (from) {
    const source = canonicalPath(from);
    if (source === target || source.startsWith(`${target}${path.sep}`))
      return "the source database is inside the slot being seeded";
  }
  return null;
}

/** Take the slot's instance lock without waiting, the way the app does (instance.rs). Throws a refusal when held. */
async function takeLock(dir, DatabaseSync) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = new DatabaseSync(path.join(dir, LOCK_FILE), { timeout: 0 });
  try {
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    if (/locked|busy/i.test(String(error.message))) {
      const owner = readRunning(dir);
      throw new SeedRefusal(
        `a dev copy is running on ${dir}${owner ? ` (pid ${owner.pid}, ${owner.branch} @ ${String(owner.sha).slice(0, 7)})` : ""}; quit it first`,
      );
    }
    throw error;
  }
  return lock;
}

const has = (db, table) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
const hasColumn = (db, table, column) =>
  has(db, table) && Boolean(db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column));
const count = (db, sql) => Number(Object.values(db.prepare(sql).get() ?? { n: 0 })[0] ?? 0);

/** Clear, in the copy, everything that would act on Ash's behalf. Returns what was cleared, by name. */
export function scrub(db) {
  const cleared = {};
  const wipe = (name, table) => {
    if (!has(db, table)) return;
    cleared[name] = (cleared[name] ?? 0) + count(db, `SELECT count(*) FROM ${table}`);
    db.exec(`DELETE FROM ${table}`);
  };
  db.exec("BEGIN");
  try {
    wipe("inFlightTurns", "in_flight_sessions");
    wipe("workspaceSnapshot", "workspace_snapshot");
    wipe("worktreeRemovals", "worktree_removals");
    // What an import's file named for a chat's folder (src-tauri/src/portable.rs): paths from Ash's Mac, never a copy's.
    wipe("importedChatFolders", "imported_chat_folders");
    // Runs and claims first: they reference automations.
    wipe("automationRuns", "automation_runs");
    wipe("automationEventClaims", "automation_event_claims");
    wipe("automations", "automations");
    wipe("reminders", "session_reminders");
    wipe("orchestrationRuns", "orchestration_runs");
    wipe("orchestrationSidebar", "orchestration_sidebar");
    wipe("orchestrationWorkers", "orchestration_workers");
    // Delegation rows (src-tauri/src/delegations.rs): a dev copy would otherwise deliver Ash's owed reports into its
    // copies of his Mono chats, and its outbox would replay them (to the stub, never the live studio).
    wipe("delegations", "delegations");
    wipe("delegationChatBinds", "delegation_chat_binds");
    // Hivra WP-14 (src-tauri/src/steering.rs, decisions.rs): pending messages would be delivered into the copy's chats,
    // and decisions answered there would release them. Both belong to the daily app's work.
    wipe("steerMessages", "steer_messages");
    wipe("decisions", "decisions");
    // Autopilot (src-tauri/src/autopilot.rs): a copy of Ash's switch would keep the Mac awake and auto-decide in the
    // dev copy, and his armed resumes would resume its copies of his chats. The log is history and stays.
    wipe("autopilotSwitches", "autopilot_switches");
    wipe("autopilotResumes", "autopilot_resumes");
    // PR watches (src-tauri/src/pr_watch): a dev copy would otherwise poll Ash's pull requests, wake its copies of his
    // Mono chats and make mc/pr-<n> worktrees in his real project checkouts.
    wipe("prWatchWakes", "pr_watch_wakes");
    wipe("prWatches", "pr_watches");
    // WP-135: a compare's records name Ash's real worktrees, and Discard in a dev copy would take one of them back.
    // WP-144: a held brief and its fresh-eyes review name Ash's real chats and folders; a dev copy would start the brief
    // as a worker there once approved. Only those documents go; the other hub documents (projects, Pages, home) are
    // what the seed is for.
    if (has(db, "hub_local_docs")) {
      cleared.fanOutCompares = count(db, "SELECT count(*) FROM hub_local_docs WHERE key = 'fan-out-compares'");
      db.exec("DELETE FROM hub_local_docs WHERE key = 'fan-out-compares'");
      cleared.freshEyesReviews = count(db, "SELECT count(*) FROM hub_local_docs WHERE key = 'fresh-eyes'");
      db.exec("DELETE FROM hub_local_docs WHERE key = 'fresh-eyes'");
    }
    if (hasColumn(db, "sessions", "queued_messages_json")) {
      cleared.queuedMessages = count(db, "SELECT count(*) FROM sessions WHERE queued_messages_json NOT IN ('', '[]')");
      db.exec("UPDATE sessions SET queued_messages_json = '[]'");
    }
    if (hasColumn(db, "sessions", "queue_status")) db.exec("UPDATE sessions SET queue_status = NULL");
    // A chat's open /goal (session_store.rs goal_json) belongs to Ash's real Claude conversations; a dev copy never sends
    // one, and must not show or carry on with his.
    if (hasColumn(db, "sessions", "goal_json")) {
      cleared.goals = count(db, "SELECT count(*) FROM sessions WHERE goal_json IS NOT NULL");
      db.exec("UPDATE sessions SET goal_json = NULL");
    }
    if (hasColumn(db, "sessions", "provider_session_id")) {
      cleared.providerSessionIds = count(db, "SELECT count(*) FROM sessions WHERE provider_session_id IS NOT NULL");
      db.exec("UPDATE sessions SET provider_session_id = NULL");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return cleared;
}

function removeDatabase(file) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${file}${suffix}`, { force: true });
}

/**
 * Seed the dev data folder `to` from `from` (default: the daily database). Returns the report written to seeded.json.
 * Throws a SeedRefusal, and changes nothing in `to` but the lock file, when it must not run.
 */
export async function seedDev({
  to,
  from,
  replace = false,
  home = os.homedir(),
  root = ROOT,
  now = () => new Date(),
} = {}) {
  if (!to) throw new SeedRefusal("no slot data folder given");
  const source = from ?? path.join(supportDir(home), HUB_IDENTIFIER, DB_FILE);
  const refusal = targetRefusal({ to, from: source, home });
  if (refusal) throw new SeedRefusal(refusal);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new SeedRefusal(`no database at ${source}`);

  const { DatabaseSync, backup } = await sqlite();
  const lock = await takeLock(to, DatabaseSync);
  const target = path.join(to, DB_FILE);
  const temporary = path.join(to, `.seed-${process.pid}.db`);
  try {
    if (fs.existsSync(target) && !replace)
      throw new SeedRefusal(`${to} already has chats; pass --replace to move them aside and seed again`);

    removeDatabase(temporary);
    // Read-only: SQLite's online backup copies a consistent snapshot while the daily app keeps writing.
    const original = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(original, temporary);
    } finally {
      original.close();
    }

    const copy = new DatabaseSync(temporary);
    let report;
    try {
      const schema = has(copy, "schema_migrations") ? count(copy, "SELECT COALESCE(MAX(version), 0) FROM schema_migrations") : 0;
      const supported = checkoutSchemaVersion(root);
      if (supported != null && schema > supported)
        throw new SeedRefusal(
          `the source was written by a newer build (schema ${schema}; this checkout knows up to ${supported}), so this dev copy would refuse it`,
        );
      const cleared = scrub(copy);
      const integrity = copy.prepare("PRAGMA integrity_check").get();
      if (Object.values(integrity ?? {})[0] !== "ok") throw new SeedRefusal(`the copy failed its integrity check: ${JSON.stringify(integrity)}`);
      // Out of WAL, so the copy is one self-contained file that read-only tools can open too; the app switches it
      // back to WAL when it opens it (session_store.rs).
      copy.exec("PRAGMA journal_mode = DELETE");
      report = {
        from: source,
        to: target,
        at: now().toISOString(),
        schemaVersion: schema,
        sessions: has(copy, "sessions") ? count(copy, "SELECT count(*) FROM sessions") : 0,
        cleared,
      };
    } finally {
      copy.close();
    }

    if (fs.existsSync(target)) {
      const aside = `${target}.before-seed-${now().toISOString().replace(/[:.]/g, "-")}`;
      for (const suffix of ["", "-wal", "-shm"])
        if (fs.existsSync(`${target}${suffix}`)) fs.renameSync(`${target}${suffix}`, `${aside}${suffix}`);
      report.movedAside = aside;
    }
    for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(`${temporary}${suffix}`, { force: true });
    fs.renameSync(temporary, target);
    fs.writeFileSync(path.join(to, "seeded.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    removeDatabase(temporary);
    lock.close();
  }
}

// ---- command line ------------------------------------------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const plan = await planSlot({ requested: value("slot") });
  const report = await seedDev({ to: plan.dataDir, from: value("from"), replace: args.includes("--replace") });
  registerSlot(plan);
  console.log(`seeded slot ${plan.slot}: ${report.sessions} chats into ${report.to}`);
  console.log(`  cleared ${Object.entries(report.cleared).map(([name, n]) => `${name} ${n}`).join(", ") || "nothing"}`);
  if (report.movedAside) console.log(`  the slot's previous chats are in ${report.movedAside}`);
  console.log(`  start it: npm run hub:dev${value("slot") ? ` -- --slot ${plan.slot}` : ""}`);
  if (samePath(report.from, path.join(supportDir(), HUB_IDENTIFIER, DB_FILE)))
    console.log("  (read the daily database with the online backup API; nothing was written to it)");
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`hub:seed-dev: ${error instanceof SeedRefusal ? "refused: " : ""}${error.message}`);
    process.exit(error instanceof SeedRefusal ? 2 : 1);
  });
}
