#!/usr/bin/env node
// `npm run hub:verify-live`: the fake-Claude test bench (Phase 1b WP5, docs/PHASE-1B-DEV-SETUP.md, docs/T3-HARVEST.md
// "Fake-Claude test bench with evidence"). It runs this worktree's dev copy of the Hub, with a scripted fake Claude
// (scripts/fake-claude.mjs), under a throwaway HOME, and walks the delegation chain through real restarts:
//
//   1. a Lead (a Mono) delegates a worker with `monocode app sessions.start` (an H2 delegation row);
//   2. the worker runs and leaves a subagent going in the background; the Lead sends it one more brief meanwhile, which
//      queues behind the worker's work (a followed row, "queued" back to the Lead) instead of failing as busy;
//   3. the app is killed mid-turn and started again: the worker resumes by itself with the note naming the subagent;
//   4. the worker's report wakes the Lead;
//   5. the Lead's Claude transcript is deleted while the app is down: it starts fresh from its brief;
//   6. the app is killed under the Lead's turn again and again: it resumes three times, then stops in Needs you.
//   Not built yet, so reported as skipped: a worker's question routed to its Lead, and a cascade Stop.
//
// Every run leaves evidence/<run>/: verdict.json, the fake's event stream and prompts, each launch's log, and a copy
// of the dev copy's database. `-- --fail-gate` plants a failure (the fake worker leaves no background work and has no
// resume step) and must end FAIL with a non-zero exit, so a green run means something.
//
// Never the daily app or its data: the copy is a dev slot (its identifier is checked against instance.rs's kind
// table), HOME is a temporary folder (the app keeps its data, WebKit storage and Claude config there, and only then
// reads the verify plan: src-tauri/src/verify_live.rs), Ash OS is the in-process stub with a throwaway token, and
// Claude is the fake. Nothing here reads ~/Library/Application Support/com.ash.monocode-hub, ~/.claude or ~/Applications.
//
//   npm run hub:verify-live                      # build this worktree's verify slot, then walk
//   npm run hub:verify-live -- --fail-gate       # the negative control: must exit non-zero
//   npm run hub:verify-live -- --no-build        # reuse target/debug/monocode from the last run
//   npm run hub:verify-live -- --keep            # leave the temporary HOME for a look afterwards

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEV_IDENTIFIER_PREFIX, kindOf } from "./hub-bundle.mjs";
import { DEV_PRODUCT, ROOT, isMain, planSlot, readJson, registerSlot, writeSlotConfig } from "./hub-dev.mjs";

export const MAX_RESUMES = 3;

/** Every check the walk can record, in order (the not-built ones are recorded as skipped). */
export const WALK = [
  "isolated",
  "lead_delegated",
  "delegation_mirrored",
  "worker_ran",
  "brief_queued",
  "inflight_saved_background",
  "restart_resumed_with_note",
  "report_woke_lead",
  "dead_session_recovered",
  "crash_loop_capped",
];

/** Thrown between phases when the negative control has already caught its failure: no more launches needed. */
class Halt extends Error {}
export const SUBAGENT_ID = "verify-agent-1";
export const KICKOFF = "VERIFY-LEAD-KICKOFF";
export const WORKER = "VERIFY-WORKER";
export const QUEUED = "VERIFY-QUEUED-BRIEF";
export const CONTINUE = "Continue from where you left off";

/** The fake Claude's rules for the walk. `failGate` plants the failure the negative control must catch. */
export function scenario({ runId, failGate = false }) {
  const worker = {
    name: "worker",
    match: WORKER,
    setTag: "worker",
    steps: [
      { say: "Working on it." },
      ...(failGate ? [] : [{ background: { id: SUBAGENT_ID, kind: "subagent", description: "Verify subagent" } }]),
      { mark: "worker-started" },
      { waitFile: "worker-release" },
      { say: "WORKER-DONE (first try)" },
    ],
  };
  const rules = [
    // The Lead after its transcript was lost: a fresh conversation whose first prompt carries the chat's brief.
    { name: "lead-recovered", match: "<chat_brief>", setTag: "lead", steps: [{ mark: "lead-recovered" }, { waitFile: "never" }] },
    ...(failGate
      ? []
      : [
          {
            name: "worker-resume",
            tag: "worker",
            match: CONTINUE,
            steps: [{ mark: "worker-resumed" }, { say: "WORKER-DONE" }],
          },
        ]),
    { name: "lead-resume", tag: "lead", match: CONTINUE, steps: [{ waitFile: "never" }] },
    {
      name: "lead-report",
      tag: "lead",
      match: "\\[MonoCode report\\]",
      steps: [{ mark: "lead-got-report" }, { say: "Got the report. Checking it." }, { waitFile: "never" }],
    },
    worker,
    {
      name: "lead-kickoff",
      match: KICKOFF,
      setTag: "lead",
      times: 1,
      steps: [
        { say: "Delegating the verify worker." },
        {
          app: "sessions.start",
          input: { prompt: `${WORKER} run ${runId}: do a small task and report back.`, notifyOnComplete: true },
        },
        { mark: "lead-delegated" },
        // Once the worker is mid-turn (the walk opens this gate), one more brief to it: it must queue, not fail.
        { waitFile: "worker-busy", timeoutMs: 180_000 },
        {
          app: "sessions.send",
          input: { sessionId: "{{lastStarted}}", prompt: `${QUEUED} run ${runId}: one more small thing when you're free.`, notifyOnComplete: true },
        },
        { mark: "lead-queued" },
        { say: "Started it." },
      ],
    },
  ];
  return { version: 1, rules };
}

/** PASS only when every check that ran passed; skipped checks are reported, never counted. */
export function verdictOf(checks) {
  const ran = checks.filter((check) => check.status !== "skipped");
  return ran.length > 0 && ran.every((check) => check.status === "pass") ? "PASS" : "FAIL";
}

/** The exit code: a FAIL is 1; a negative control that came out PASS (the planted failure went unnoticed) is 3. */
export function exitCode(verdict, failGate) {
  if (verdict === "FAIL") return 1;
  return failGate ? 3 : 0;
}

/** RFC 7396 merge, the way `tauri --config a --config b` layers configs into TAURI_CONFIG. */
export function mergePatch(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const result = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

export function runId(now = new Date(), failGate = false) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}${failGate ? "-fail-gate" : ""}`;
}

/** The lines of an NDJSON file, parsed; [] when it isn't there yet. */
export function readNdjson(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// ---- the run --------------------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(everyMs);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function commandOf(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function parseArgs(argv) {
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    failGate: argv.includes("--fail-gate"),
    build: !argv.includes("--no-build"),
    keep: argv.includes("--keep"),
    slot: value("--slot", `${path.basename(ROOT)}-verify`),
    scale: Number(value("--timeout-scale", "1")) || 1,
  };
}

async function openDb(file) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(file, { readOnly: true });
}

/** One read-only query against the dev copy's database, or [] while it can't be read. */
async function query(file, sql, ...params) {
  if (!fs.existsSync(file)) return [];
  let db;
  try {
    db = await openDb(file);
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // closed
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const id = runId(new Date(), options.failGate);
  const evidence = path.join(ROOT, "evidence", id);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "monocode-verify-"));
  const home = path.join(scratch, "home");
  const project = path.join(scratch, "project");
  const bin = path.join(scratch, "bin");
  const fake = path.join(evidence, "fake");
  for (const dir of [evidence, home, project, bin, fake]) fs.mkdirSync(dir, { recursive: true });
  const log = (line) => {
    const text = `[verify-live ${new Date().toISOString().slice(11, 19)}] ${line}`;
    console.log(text);
    fs.appendFileSync(path.join(evidence, "run.log"), `${text}\n`);
  };
  const scale = (ms) => Math.round(ms * options.scale);
  const started = new Date().toISOString();
  const checks = [];
  const record = (check) => {
    checks.push(check);
    log(`${check.status.toUpperCase().padEnd(7)} ${check.id}: ${check.detail}`);
  };
  const pass = (idName, title, detail, extra = {}) => record({ id: idName, title, status: "pass", detail, ...extra });
  const fail = (idName, title, detail, extra = {}) => record({ id: idName, title, status: "fail", detail, ...extra });
  const skip = (idName, title, detail) => record({ id: idName, title, status: "skipped", detail });
  // The negative control only has to show the gate fails: once a check has failed, stop launching.
  const phase = () => {
    if (options.failGate && checks.some((check) => check.status === "fail")) throw new Halt();
  };
  const children = [];
  let stub = null;
  let app = null;
  let launches = 0;

  // -- the slot, the fake and the plan ---------------------------------------------------------------------------------
  const slot = await planSlot({ requested: options.slot });
  if (kindOf(slot.identifier) !== "dev" || !slot.identifier.startsWith(DEV_IDENTIFIER_PREFIX))
    throw new Error(`refusing: ${slot.identifier} is not a dev copy's identifier`);
  const dataDir = path.join(home, "Library/Application Support", slot.identifier);
  const db = path.join(dataDir, "monocode.db");
  log(`run ${id}: slot ${slot.slot} (${slot.identifier}), HOME ${home}, evidence ${path.relative(ROOT, evidence)}`);

  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
  fs.writeFileSync(path.join(project, "README.md"), "Scratch project for hub:verify-live.\n");
  execFileSync("git", ["add", "README.md"], { cwd: project });
  execFileSync(
    "git",
    ["-c", "user.name=verify", "-c", "user.email=verify@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
    { cwd: project },
  );

  const claude = path.join(bin, "claude");
  fs.writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, "scripts/fake-claude.mjs")}" "$@"\n`, { mode: 0o755 });
  const rulesFile = path.join(evidence, "scenario.json");
  fs.writeFileSync(rulesFile, `${JSON.stringify(scenario({ runId: id, failGate: options.failGate }), null, 2)}\n`);
  const planFile = path.join(scratch, "verify-plan.json");
  const plan = {
    version: 1,
    runId: id,
    claudeBinary: claude,
    autoResume: true,
    kickoff: { project, monoName: "Verify Lead", prompt: `${KICKOFF} run ${id}: delegate the verify worker, then wait for its report.` },
  };
  fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  fs.writeFileSync(path.join(evidence, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);

  const cleanup = async () => {
    if (app && alive(app.pid)) {
      try {
        process.kill(app.pid, "SIGTERM");
      } catch {
        // gone
      }
      await until(() => !alive(app.pid), 10_000);
      if (alive(app.pid)) process.kill(app.pid, "SIGKILL");
    }
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // gone
      }
    }
    await stub?.close().catch(() => undefined);
  };

  try {
    // -- build ---------------------------------------------------------------------------------------------------------
    registerSlot(slot);
    writeSlotConfig(slot);
    const config = mergePatch(readJson(path.join(ROOT, "src-tauri/tauri.hub.conf.json")), readJson(slot.configFile));
    const binary = path.join(ROOT, "target/debug/monocode");
    if (options.build) {
      log("building the verify slot's dev copy (cargo build, shared cache) ...");
      const buildLog = fs.openSync(path.join(evidence, "build.log"), "w");
      const code = await new Promise((resolve) => {
        const child = spawn("cargo", ["build", "-p", "monocode"], {
          cwd: ROOT,
          stdio: ["ignore", buildLog, buildLog],
          env: {
            ...process.env,
            TAURI_CONFIG: JSON.stringify(config),
            CARGO_BUILD_BUILD_DIR: slot.buildDir,
          },
        });
        child.on("exit", (exit) => resolve(exit ?? 1));
      });
      if (code !== 0) throw new Error(`cargo build failed (${path.relative(ROOT, path.join(evidence, "build.log"))})`);
    }
    if (!fs.existsSync(binary)) throw new Error(`${binary} is missing; run without --no-build`);
    const version = JSON.parse(execFileSync(binary, ["version", "--json"], { encoding: "utf8", env: { ...process.env, HOME: home } }));
    if (version.identifier !== slot.identifier || version.kind !== "dev")
      throw new Error(`the built copy is ${version.identifier} (${version.kind}), not ${slot.identifier}`);
    log(`built ${version.identifier} at ${version.stamp?.branch} @ ${String(version.stamp?.sha).slice(0, 7)}${version.stamp?.dirty ? "-dirty" : ""}`);

    // -- vite and the Ash OS stub ----------------------------------------------------------------------------------------
    const viteLog = fs.openSync(path.join(evidence, "vite.log"), "w");
    const vite = spawn(path.join(ROOT, "node_modules/.bin/vite"), [], {
      cwd: ROOT,
      stdio: ["ignore", viteLog, viteLog],
      env: { ...process.env, MONOCODE_VITE_PORT: String(slot.port), VITE_MONOCODE_HUB: "1" },
    });
    children.push(vite);
    const served = await until(async () => {
      try {
        return (await fetch(`http://localhost:${slot.port}/`)).ok;
      } catch {
        return false;
      }
    }, 60_000);
    if (!served) throw new Error(`vite never answered on port ${slot.port} (see vite.log)`);
    const { startStub } = await import("./hub-stub-server.mjs");
    const tokenFile = path.join(home, ".monocode-hub-dev/slots", slot.slot, "hub-token");
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
    stub = await startStub({ port: 0, tokenFile, token: crypto.randomBytes(24).toString("hex") });

    // -- the app -------------------------------------------------------------------------------------------------------
    const appEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("TAURI_") && !key.startsWith("MONOCODE_") && !key.startsWith("FAKE_CLAUDE_") && key !== "CFFIXED_USER_HOME",
      ),
    );
    Object.assign(appEnv, {
      HOME: home,
      MONOCODE_NO_ALERT: "1",
      // An accessory app that never takes focus (src-tauri/src/lib.rs): the walk's launches stay out of Ash's way.
      MONOCODE_HUB_BACKGROUND: "1",
      MONOCODE_VERIFY_LIVE: planFile,
      MONOCODE_HUB_PORT: String(stub.port),
      MONOCODE_HUB_TOKEN_FILE: tokenFile,
      MONOCODE_DEV_APP_NAME: `${DEV_PRODUCT} ${slot.slot}`,
      FAKE_CLAUDE_STATE: fake,
      FAKE_CLAUDE_SCENARIO: rulesFile,
    });
    const readRunning = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dataDir, "running.json"), "utf8"));
      } catch {
        return null;
      }
    };
    const launch = async () => {
      launches += 1;
      const out = fs.openSync(path.join(evidence, `app-${launches}.log`), "w");
      const child = spawn(binary, [], { cwd: ROOT, env: appEnv, stdio: ["ignore", out, out] });
      children.push(child);
      const record = await until(() => {
        const running = readRunning();
        return running && running.pid && alive(running.pid) && (running.pid === child.pid || !app || running.pid !== app.pid)
          ? running
          : null;
      }, scale(120_000));
      if (!record) throw new Error(`launch ${launches} never wrote running.json (see app-${launches}.log)`);
      app = { pid: record.pid, child, record };
      log(`launch ${launches}: pid ${record.pid}`);
      return record;
    };
    const kill = async (why) => {
      const pids = [...new Set([app.pid, app.child.pid])].filter((pid) => alive(pid));
      for (const pid of pids) {
        const command = commandOf(pid);
        // Only our own dev copy: its binary in this worktree's target/debug (or the dev wrapper beside it).
        if (!command.includes(path.join(ROOT, "target/debug"))) throw new Error(`refusing to kill pid ${pid}: ${command}`);
        process.kill(pid, "SIGKILL");
      }
      await until(() => pids.every((pid) => !alive(pid)), 15_000);
      log(`killed launch ${launches} (${why})`);
      // Its Claude children see stdin close and exit.
      await sleep(500);
    };
    const prompts = () => readNdjson(path.join(fake, "prompts.ndjson"));
    const mark = (name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(fake, "marks", `${name}.json`), "utf8"));
      } catch {
        return null;
      }
    };
    const waitMark = (name, ms) => until(() => mark(name), scale(ms));
    const inFlight = () => query(db, "SELECT session_id, background_json, resumes FROM in_flight_sessions");
    const delegations = () =>
      query(db, "SELECT id, owner_session, child_session, state, delivery, generation FROM delegations ORDER BY created_at");
    const providerOf = async (sessionId) =>
      (await query(db, "SELECT provider_session_id AS p FROM sessions WHERE id = ?", sessionId))[0]?.p ?? null;
    const monoBlocks = (sessionId) =>
      query(db, "SELECT block_json FROM mono_blocks WHERE session_id = ? ORDER BY seq DESC LIMIT 20", sessionId).then((rows) =>
        rows.map((row) => JSON.parse(row.block_json)),
      );

    // 0. Isolation.
    const first = await launch();
    const isolated =
      first.kind === "dev" &&
      path.resolve(dataDir).startsWith(path.resolve(home)) &&
      fs.existsSync(path.join(dataDir, "running.json")) &&
      !String(first.bundlePath ?? "").includes("/Applications/");
    (isolated ? pass : fail)(
      "isolated",
      "A throwaway dev slot under a temporary HOME",
      `${slot.identifier} (${first.kind}), data in the temporary HOME, bundle ${first.bundlePath ?? "?"}`,
    );

    // 1. The Lead delegates.
    const delegated = await waitMark("lead-delegated", 240_000);
    const call = readNdjson(path.join(fake, "app-calls.ndjson")).find((entry) => entry.action === "sessions.start");
    const workerId = call?.response?.result?.id;
    const rows = await until(async () => {
      const found = await delegations();
      return found.length ? found : null;
    }, scale(20_000));
    const row = rows?.find((entry) => entry.child_session === workerId);
    if (delegated && call?.response?.ok && row)
      pass("lead_delegated", "A Lead delegates (a stored H2 row)", `sessions.start -> ${workerId}; delegation ${row.id} (${row.state})`, {
        evidence: { delegation: row },
      });
    else
      fail("lead_delegated", "A Lead delegates (a stored H2 row)", `mark ${!!delegated}, call ${JSON.stringify(call?.response ?? null)}, rows ${JSON.stringify(rows)}`);
    const leadId = row?.owner_session;
    const mirrored = row && (await until(() => stub.delegations.has(row.id), scale(15_000)));
    (mirrored ? pass : fail)(
      "delegation_mirrored",
      "The delegation row is copied to Ash OS (the stub) by the outbox",
      mirrored ? `stub has ${row.id} v${stub.delegations.get(row.id)?.version}` : "the stub never received it",
    );

    phase();
    // 2. The worker runs, with a subagent in the background, and its in-flight row says so.
    const workerStarted = await waitMark("worker-started", 90_000);
    (workerStarted ? pass : fail)("worker_ran", "The worker runs", workerStarted ? `conversation ${workerStarted.conversation}` : "no worker turn");
    // The Lead's second brief to the busy worker queues behind its work (T3 "Briefs to a busy chat queue or steer").
    fs.mkdirSync(path.join(fake, "gates"), { recursive: true });
    fs.writeFileSync(path.join(fake, "gates", "worker-busy"), "");
    const queuedMark = await waitMark("lead-queued", 60_000);
    const sendCall = readNdjson(path.join(fake, "app-calls.ndjson")).find((entry) => entry.action === "sessions.send");
    const followed = await until(async () => {
      const found = await query(db, "SELECT id, child_session, state, follow FROM delegations WHERE follow = 'queue'");
      return found.length ? found[0] : null;
    }, scale(15_000));
    const waiting = await until(async () => {
      const raw = (await query(db, "SELECT queued_messages_json AS q FROM sessions WHERE id = ?", workerId))[0]?.q;
      const parsed = raw ? JSON.parse(raw) : [];
      return parsed.find((message) => message.waitForIdle && String(message.appRequestId ?? "").includes(leadId ?? "?")) ?? null;
    }, scale(15_000));
    if (queuedMark && sendCall?.response?.ok && sendCall.response.result?.delivery === "queued" && followed?.child_session === workerId && waiting)
      pass(
        "brief_queued",
        "A brief to a busy session queues behind its work and the sender hears \"queued\"",
        `sessions.send -> delivery ${sendCall.response.result.delivery}; followed row ${followed.id} (${followed.follow}, ${followed.state}); waiting in the worker's queue as ${waiting.appRequestId}`,
      );
    else
      fail(
        "brief_queued",
        "A brief to a busy session queues behind its work and the sender hears \"queued\"",
        `mark ${!!queuedMark}, response ${JSON.stringify(sendCall?.response ?? null)}, row ${JSON.stringify(followed)}, queued ${JSON.stringify(waiting)}`,
      );
    const saved = await until(async () => {
      const rowsNow = await inFlight();
      const own = rowsNow.find((entry) => entry.session_id === workerId);
      // The chat's Claude conversation must be saved too, or nothing could resume it.
      return own?.background_json?.includes(SUBAGENT_ID) && (await providerOf(workerId)) === workerStarted?.conversation
        ? own
        : null;
    }, scale(20_000));
    (saved ? pass : fail)(
      "inflight_saved_background",
      "The running worker's in-flight row holds its background work",
      saved ? `in_flight_sessions: ${saved.background_json}` : `rows: ${JSON.stringify(await inFlight())}`,
    );

    phase();
    // 3. The app dies mid-turn and comes back: the worker resumes by itself, told what was cut.
    await kill("mid-turn, worker waiting on its subagent");
    await launch();
    const resumed = await waitMark("worker-resumed", 90_000);
    const note = resumed?.prompt ?? "";
    if (resumed && resumed.resumed && note.includes("background work was cut") && note.includes(`(id ${SUBAGENT_ID})`) && note.includes(CONTINUE))
      pass("restart_resumed_with_note", "After the restart the worker resumes once, with the what-was-cut note", note.slice(0, 400));
    else
      fail(
        "restart_resumed_with_note",
        "After the restart the worker resumes once, with the what-was-cut note",
        resumed ? `prompt: ${note.slice(0, 400)}` : `no resumed worker turn; prompts: ${JSON.stringify(prompts().map((p) => p.rule))}`,
      );

    phase();
    // 4. The worker's report wakes the Lead.
    const report = await waitMark("lead-got-report", 90_000);
    const delivered = await until(async () => {
      const found = (await delegations()).find((entry) => entry.child_session === workerId);
      return found && found.delivery === "delivered" ? found : null;
    }, scale(15_000));
    if (report && report.prompt.includes("[MonoCode report]") && delivered)
      pass("report_woke_lead", "The worker's report wakes the Lead", `delegation ${delivered.id}: ${delivered.state}, ${delivered.delivery}`);
    else
      fail(
        "report_woke_lead",
        "The worker's report wakes the Lead",
        `mark ${!!report}; delegation ${JSON.stringify((await delegations()).find((entry) => entry.child_session === workerId) ?? null)}`,
      );

    phase();
    // 5. The Lead's Claude transcript is lost while the app is down: it starts fresh from its brief.
    const leadBusy = await until(
      async () =>
        (await inFlight()).find((entry) => entry.session_id === leadId) &&
        (await providerOf(leadId)) === report?.conversation,
      scale(20_000),
    );
    if (!report || !leadBusy) {
      fail("dead_session_recovered", "A Lead whose Claude transcript is gone starts fresh from its brief", "not reached: the Lead never went busy on the report");
      fail("crash_loop_capped", `A turn that keeps dying stops after ${MAX_RESUMES} resumes (Needs you)`, "not reached");
    } else {
      await kill("Lead mid-turn");
      const lostConversation = report.conversation;
      fs.rmSync(path.join(fake, "conversations", `${lostConversation}.json`), { force: true });
      await launch();
      const recovered = await waitMark("lead-recovered", 90_000);
      const dead = readNdjson(path.join(fake, "events.ndjson")).some((event) => event.dir === "dead" && event.conversation === lostConversation);
      const recoveredBlocks = leadId ? await until(async () => {
        const blocks = await monoBlocks(leadId);
        return blocks.some((block) => block.notice === "recovered") ? blocks : null;
      }, scale(15_000)) : null;
      if (recovered && dead && recovered.conversation !== lostConversation && recovered.prompt.includes("<chat_brief>") && recoveredBlocks)
        pass(
          "dead_session_recovered",
          "A Lead whose Claude transcript is gone starts fresh from its brief",
          `"No conversation found" for ${lostConversation}; fresh conversation ${recovered.conversation}; the chat shows the recovered note`,
        );
      else
        fail(
          "dead_session_recovered",
          "A Lead whose Claude transcript is gone starts fresh from its brief",
          `dead ${dead}, mark ${JSON.stringify(recovered && { conversation: recovered.conversation, brief: recovered.prompt.includes("<chat_brief>") })}, recovered note ${!!recoveredBlocks}`,
        );

      // 6. Killed under the Lead's resumed turn again and again: three resumes, then Needs you.
      const leadResumes = () => prompts().filter((entry) => entry.rule === "lead-recovered" || entry.rule === "lead-resume");
      let capped = Boolean(recovered);
      for (let resume = 2; capped && resume <= MAX_RESUMES; resume += 1) {
        const counted = await until(async () => {
          const rowNow = (await inFlight()).find((entry) => entry.session_id === leadId);
          const latest = leadResumes().at(-1)?.conversation;
          return rowNow && rowNow.resumes === resume - 1 && (await providerOf(leadId)) === latest ? rowNow : null;
        }, scale(20_000));
        if (!counted) {
          capped = false;
          break;
        }
        await kill(`Lead's resume ${resume - 1}`);
        await launch();
        capped = Boolean(await until(() => leadResumes().length >= resume, scale(90_000)));
      }
      const third = capped && (await until(async () => {
        const rowNow = (await inFlight()).find((entry) => entry.session_id === leadId);
        return rowNow && rowNow.resumes === MAX_RESUMES ? rowNow : null;
      }, scale(20_000)));
      let stopped = null;
      if (third) {
        await kill(`Lead's resume ${MAX_RESUMES}`);
        await launch();
        stopped = await until(async () => {
          const blocks = await monoBlocks(leadId);
          return blocks[0]?.notice === "resume-stopped" ? blocks[0] : null;
        }, scale(60_000));
        // Give it time to (wrongly) resume a fourth time.
        await sleep(scale(8_000));
      }
      const resumeCount = leadResumes().length;
      const leftInFlight = (await inFlight()).some((entry) => entry.session_id === leadId);
      if (stopped && resumeCount === MAX_RESUMES && !leftInFlight)
        pass(
          "crash_loop_capped",
          `A turn that keeps dying stops after ${MAX_RESUMES} resumes (Needs you)`,
          `${resumeCount} resumes, then: ${String(stopped.text).split("\n")[0]}`,
        );
      else
        fail(
          "crash_loop_capped",
          `A turn that keeps dying stops after ${MAX_RESUMES} resumes (Needs you)`,
          `resumes ${resumeCount}, stopped note ${!!stopped}, still in flight ${leftInFlight}`,
        );
    }

  } catch (error) {
    if (error instanceof Halt) {
      for (const name of WALK.filter((name) => !checks.some((check) => check.id === name)))
        skip(name, name, "not run: the negative control stops at its first failure");
    } else fail("run", "The walk ran to the end", error.message);
  } finally {
    await cleanup();
    // The database, after the app is gone (WAL and all).
    try {
      fs.mkdirSync(path.join(evidence, "db"), { recursive: true });
      for (const name of ["monocode.db", "monocode.db-wal", "monocode.db-shm"]) {
        const from = path.join(dataDir, name);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(evidence, "db", name));
      }
    } catch (error) {
      log(`couldn't copy the database: ${error.message}`);
    }
    if (!options.keep) fs.rmSync(scratch, { recursive: true, force: true });
  }

  skip(
    "question_routed",
    "A worker's question is routed to its Lead",
    "not built yet: the app control has no sessions.pending / sessions.answer (docs/T3-HARVEST.md, Workers ask their Lead)",
  );
  skip(
    "cascade_stop",
    "One Stop on the Lead stops everything beneath it",
    "not built yet: sessions.stop has no cascade (docs/T3-HARVEST.md, A delegation tree you can see and stop)",
  );
  const verdict = verdictOf(checks);
  const result = {
    run: id,
    verdict,
    failGate: options.failGate,
    ...(options.failGate
      ? {
          plantedFailure: "the fake worker starts no background work and has no resume step",
          negativeControl: verdict === "FAIL" ? "caught" : "missed",
        }
      : {}),
    startedAt: started,
    finishedAt: new Date().toISOString(),
    build: { branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), sha: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "" },
    slot: options.slot,
    launches,
    checks,
    evidence: {
      fakeEvents: "fake/events.ndjson",
      prompts: "fake/prompts.ndjson",
      appCalls: "fake/app-calls.ndjson",
      database: "db/monocode.db",
      logs: Array.from({ length: launches }, (_, index) => `app-${index + 1}.log`),
    },
  };
  fs.writeFileSync(path.join(evidence, "verdict.json"), `${JSON.stringify(result, null, 2)}\n`);
  log(`${verdict}${options.failGate ? ` (negative control ${result.negativeControl})` : ""}: ${path.relative(ROOT, path.join(evidence, "verdict.json"))}`);
  return exitCode(verdict, options.failGate);
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`hub:verify-live: ${error.stack ?? error.message}`);
      process.exit(1);
    },
  );
}
