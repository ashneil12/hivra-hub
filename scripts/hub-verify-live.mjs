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
//   Then double delegation, in one more launch with a second plan: Ash OS (the stub) lists a scratch project, so the hub
//   makes that project's Lead and ties its built-in leadership team to it, and the kickoff goes to Chief of Staff, which
//   briefs the Lead with `delegate_task {lead}`:
//   7. the Lead's worker asks a question (AskUserQuestion): it reaches the Lead as a [MonoCode question] turn, not
//      Chief of Staff and not Ash's Waiting on you; the Lead answers with task_answer and the worker's turn carries on
//      with that answer;
//   8. the Lead delegates another worker for the same brief, which goes silent mid-turn: the window marks its row
//      stalled (quiet) within seconds (the plan's stallMs), and Chief of Staff cancels its brief (task_cancel): the
//      worker beneath the Lead is stopped, both rows end cancelled with their reports dropped (the stall with them), and
//      the Lead's own long-running chat is not stopped for it.
//   Then restarts, on a third plan whose fake Claude takes /goal (verify_live.rs `goals`): Chief of Staff starts two
//   workers with a finish line (delegate_task `goal`), briefs the Verify lead, queues two more briefs behind the Lead's
//   work and one behind worker A's, and cancels one of the Lead's waiting briefs; the app is killed with all of them
//   busy, and worker B's transcript is deleted meanwhile:
//   9. each /goal survives: A's resumed conversation keeps it (not sent again, its checks go on from the stored count),
//      B's fresh conversation gets it again exactly once; both end met and stay cleared;
//   10. the briefs that waited go in by themselves once their chat's resumed turn is over, each once, in order;
//   11. the brief cancelled while it waited in the busy Lead's queue stays out, and the Lead was never stopped for it;
//   12. one more restart repeats nothing: no brief twice, no /goal again, no goal back.
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

/** Every check the walk can record, in order (the negative control records the ones it never reaches as skipped). */
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
  "question_routed",
  "worker_stalled",
  "cascade_stop",
  "goal_survives_restart",
  "queued_brief_after_restart",
  "cancelled_brief_stays_out",
  "nothing_repeats_after_restart",
];

/** Thrown between phases when the negative control has already caught its failure: no more launches needed. */
class Halt extends Error {}
export const SUBAGENT_ID = "verify-agent-1";
export const KICKOFF = "VERIFY-LEAD-KICKOFF";
export const WORKER = "VERIFY-WORKER";
export const QUEUED = "VERIFY-QUEUED-BRIEF";
export const CONTINUE = "Continue from where you left off";
/** Double delegation (checks 7 and 8): the built-in team Mono the second plan's kickoff opens, and the stub's project. */
export const TEAM_MONO = "chief-of-staff";
export const TREE_PROJECT = { id: "verify", name: "Verify", shortName: "Verify", iconShape: "rocket" };
export const TREE_LEAD = "verify";
export const TREE_KICKOFF = "VERIFY-TREE-KICKOFF";
export const TREE_BRIEF = "VERIFY-TREE-BRIEF";
export const ASKER = "VERIFY-ASKER";
export const HELPER = "VERIFY-TREE-HELPER";
export const QUESTION = "Which colour should the verify widget be?";
export const PICK = "Green";
/** Restart durability (checks 9 to 12): the third plan's kickoff, two goal workers, the briefs that wait. */
export const DURABLE_KICKOFF = "VERIFY-DURABLE-KICKOFF";
export const GOAL_A_WORKER = "VERIFY-GOAL-A-WORKER";
export const GOAL_B_WORKER = "VERIFY-GOAL-B-WORKER";
export const QUEUED_A = "VERIFY-QUEUED-A";
export const LEAD_BRIEF = (n) => `VERIFY-LEAD-BRIEF-${n}`;
/** A worker's finish line: what the brief's "Done when" says, and so what MonoCode sends as `/goal`. */
export const goalFor = (worker, runId) => `${worker.replace("-WORKER", "")} run ${runId}: the transcript says ${worker.replace("VERIFY-", "").replace("-WORKER", "")}-DONE`;
/** An app notification as the turn's own message: first in the prompt, or right after the Mono's context block. */
export const said = (prefix) => `(?:^|</monocode_context>\\s*)${prefix}`;

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
  // Double delegation. Every prompt matches only as the turn's own message (first, or right after a Mono's context
  // block): that context quotes the delegate rules, which name [MonoCode question] and [MonoCode report], and a report
  // quotes its worker's brief.
  const brief = (marker) => said(`\\[MonoCode brief from [^\\]]*\\]\\s+${marker}`);
  const tree = [
    {
      name: "tree-cos-kickoff",
      match: said(TREE_KICKOFF),
      setTag: "tree-cos",
      times: 1,
      steps: [
        { say: "Briefing the Verify lead." },
        {
          app: "tasks.delegate",
          input: {
            lead: TREE_LEAD,
            title: "Verify tree",
            brief: `${TREE_BRIEF} run ${runId}: have one worker pick a colour with you, then another do a long job.`,
          },
          save: "cos-brief",
        },
        { mark: "cos-briefed" },
        // The walk opens this once the Lead's second worker is busy: one cancel at the top of the tree.
        { waitFile: "tree-cancel", timeoutMs: 300_000 },
        {
          app: "tasks.cancel",
          input: { taskId: "{{saved.cos-brief.response.result.taskId}}", reason: "Verify: cancelled from the top." },
          save: "cos-cancel",
        },
        { mark: "cos-cancelled" },
        { say: "Cancelled the Verify lead's brief and everything beneath it." },
      ],
    },
    {
      name: "tree-lead-question",
      tag: "tree-lead",
      match: said("\\[MonoCode question\\]"),
      steps: [
        { mark: "tree-lead-got-question" },
        { say: "My worker asked; the brief says green." },
        // The walk looks at Ash's Waiting on you while the question is open, then lets the Lead answer.
        { waitFile: "answer-go", timeoutMs: 120_000 },
        {
          app: "tasks.answer",
          input: {
            taskId: "{{prompt.taskId}}",
            requestId: "{{prompt.requestId}}",
            answers: { "{{prompt.questions.0.id}}": ["{{prompt.questions.0.options.1.id}}"] },
          },
          save: "lead-answer",
        },
        { mark: "tree-lead-answered" },
        { say: "Answered it." },
      ],
    },
    {
      name: "tree-lead-report",
      tag: "tree-lead",
      match: said("\\[MonoCode report\\]"),
      times: 1,
      steps: [
        { mark: "tree-lead-got-report" },
        { say: "The asker is done. One more worker for this brief." },
        {
          app: "tasks.delegate",
          input: { title: "Verify helper", brief: `${HELPER} run ${runId}: a long job; keep at it until you are stopped.` },
          save: "helper-task",
        },
        { mark: "tree-lead-delegated-helper" },
        // Still mid-turn when the brief above it is cancelled: the cancel must not stop this chat.
        { waitFile: "lead-hold", timeoutMs: 300_000 },
        { mark: "tree-lead-carried-on" },
        { say: "LEAD-CARRIED-ON" },
      ],
    },
    { name: "tree-lead-late-report", tag: "tree-lead", match: said("\\[MonoCode report\\]"), steps: [{ mark: "tree-lead-late-report" }, { say: "Noted." }] },
    {
      name: "tree-lead-brief",
      match: brief(TREE_BRIEF),
      setTag: "tree-lead",
      times: 1,
      steps: [
        { say: "Start-ack: handing the colour question to a worker." },
        {
          app: "tasks.delegate",
          input: { title: "Verify asker", brief: `${ASKER} run ${runId}: ask me which colour to use, then report it.` },
          save: "asker-task",
        },
        { mark: "tree-lead-delegated-asker" },
        { say: "Started the asker." },
      ],
    },
    {
      name: "tree-asker",
      match: brief(ASKER),
      setTag: "asker",
      times: 1,
      steps: [
        { say: "I need one decision from my Lead." },
        { mark: "asker-asking" },
        {
          ask: {
            questions: [
              {
                question: QUESTION,
                header: "Colour",
                multiSelect: false,
                options: [
                  { label: "Blue", description: "The usual" },
                  { label: PICK, description: "What the brief asks for" },
                ],
              },
            ],
            mark: "asker-answered",
          },
        },
        { say: "ASKER-DONE: going with {{answer}}." },
      ],
    },
    {
      name: "tree-helper",
      match: brief(HELPER),
      setTag: "helper",
      times: 1,
      steps: [{ say: "On it." }, { mark: "helper-started" }, { waitFile: "never" }],
    },
  ];
  // Restart durability. The goal workers' /goal prompts are exactly "/goal <goal>"; A's conversation survives the
  // restart, B's is deleted while the app is down, so B comes back in a fresh conversation from its chat's brief.
  const goalA = goalFor(GOAL_A_WORKER, runId);
  const goalB = goalFor(GOAL_B_WORKER, runId);
  const goalPrompt = (goal) => `^/goal ${goal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const durable = [
    {
      name: "durable-cos-kickoff",
      match: said(DURABLE_KICKOFF),
      setTag: "durable-cos",
      times: 1,
      steps: [
        { say: "Two workers with a finish line, then briefs for the Verify lead." },
        {
          app: "tasks.delegate",
          input: { title: "Goal A", project: TREE_PROJECT.id, brief: `${GOAL_A_WORKER} run ${runId}: work until the goal is met.`, goal: goalA },
          save: "goal-a",
        },
        {
          app: "tasks.delegate",
          input: { title: "Goal B", project: TREE_PROJECT.id, brief: `${GOAL_B_WORKER} run ${runId}: work until the goal is met.`, goal: goalB },
          save: "goal-b",
        },
        { app: "tasks.delegate", input: { lead: TREE_LEAD, title: "Lead brief 1", brief: `${LEAD_BRIEF(1)} run ${runId}: hold on to this one.` }, save: "lead-1" },
        { mark: "durable-started" },
        // The walk opens this once both goals are stored and the Lead is busy on brief 1.
        { waitFile: "durable-queue", timeoutMs: 300_000 },
        { app: "tasks.delegate", input: { lead: TREE_LEAD, title: "Lead brief 2", brief: `${LEAD_BRIEF(2)} run ${runId}: cancelled before it starts.` }, save: "lead-2" },
        { app: "tasks.delegate", input: { lead: TREE_LEAD, title: "Lead brief 3", brief: `${LEAD_BRIEF(3)} run ${runId}: after brief 1.` }, save: "lead-3" },
        {
          app: "sessions.send",
          input: {
            sessionId: "{{saved.goal-a.response.result.childSessionId}}",
            // Chief of Staff works on several projects: it names the worker's.
            project: "{{saved.goal-a.response.result.cwd}}",
            prompt: `${QUEUED_A} run ${runId}: one more thing after your goal.`,
            notifyOnComplete: true,
          },
          save: "queued-a",
        },
        { mark: "durable-queued" },
        { waitFile: "durable-cancel", timeoutMs: 300_000 },
        { app: "tasks.cancel", input: { taskId: "{{saved.lead-2.response.result.taskId}}", reason: "Verify: not needed after all." }, save: "cancel-2" },
        { mark: "durable-cancelled" },
        { say: "Queued what I could; cancelled brief 2." },
      ],
    },
    { name: "durable-cos-report", tag: "durable-cos", match: said("\\[MonoCode report\\]"), steps: [{ say: "Noted." }] },
    // Worker A: the brief's turn, then its /goal turn, which is still going when the app dies.
    { name: "durable-goal-a", match: brief(GOAL_A_WORKER), setTag: "goal-a", times: 1, steps: [{ say: "Starting on A." }] },
    {
      name: "durable-goal-a-set",
      tag: "goal-a",
      match: goalPrompt(goalA),
      times: 1,
      steps: [{ say: "Working toward A." }, { goalCheck: "no GOAL-A-DONE in the transcript yet" }, { mark: "goal-a-set" }, { waitFile: "never" }],
    },
    { name: "durable-queued-a", tag: "goal-a", match: said(QUEUED_A), steps: [{ mark: "queued-a-delivered" }, { say: "QUEUED-A-DONE" }] },
    {
      name: "durable-goal-a-resume",
      tag: "goal-a",
      match: CONTINUE,
      steps: [
        { goalCheck: "still no GOAL-A-DONE" },
        { mark: "goal-a-resumed" },
        { waitFile: "goal-a-finish", timeoutMs: 120_000 },
        { say: "GOAL-A-DONE" },
        { goalMet: true },
      ],
    },
    { name: "durable-goal-a-again", match: goalPrompt(goalA), steps: [{ mark: "goal-a-sent-again" }, { say: "Again?" }] },
    // Worker B: the same, but its transcript is gone after the restart.
    { name: "durable-goal-b", match: brief(GOAL_B_WORKER), setTag: "goal-b", times: 1, steps: [{ say: "Starting on B." }] },
    {
      name: "durable-goal-b-set",
      match: goalPrompt(goalB),
      times: 1,
      steps: [{ say: "Working toward B." }, { goalCheck: "no GOAL-B-DONE in the transcript yet" }, { mark: "goal-b-set" }, { waitFile: "never" }],
    },
    {
      name: "durable-goal-b-recovered",
      match: `<chat_brief>[\\s\\S]*${GOAL_B_WORKER}`,
      setTag: "goal-b",
      steps: [{ mark: "goal-b-recovered" }, { say: "Picking B up again." }],
    },
    {
      name: "durable-goal-b-reset",
      match: goalPrompt(goalB),
      steps: [
        { goalCheck: "nearly: no GOAL-B-DONE yet" },
        { mark: "goal-b-reset" },
        { waitFile: "goal-b-finish", timeoutMs: 120_000 },
        { say: "GOAL-B-DONE" },
        { goalMet: true },
      ],
    },
    // The Verify lead: busy on brief 1 when the app dies; briefs 2 and 3 wait behind it, and 2 is cancelled there.
    {
      name: "durable-lead-1",
      match: brief(LEAD_BRIEF(1)),
      setTag: "durable-lead",
      times: 1,
      steps: [{ say: "Holding brief 1." }, { mark: "durable-lead-busy" }, { waitFile: "never" }],
    },
    { name: "durable-lead-2", match: brief(LEAD_BRIEF(2)), steps: [{ mark: "durable-lead-2-delivered" }, { say: "BRIEF-2-DONE" }] },
    { name: "durable-lead-3", match: brief(LEAD_BRIEF(3)), steps: [{ mark: "durable-lead-3-delivered" }, { say: "BRIEF-3-DONE" }] },
    // Its resume comes last: a brief that waited behind it is a prompt of its own.
    { name: "durable-lead-resume", tag: "durable-lead", match: CONTINUE, steps: [{ mark: "durable-lead-resumed" }, { say: "BRIEF-1-DONE" }] },
  ];
  const rules = [
    ...durable,
    ...tree,
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

/**
 * Run `stop` once however the run ends: the caller awaits `finish()` when it returns or throws, and SIGINT/SIGTERM run
 * it too, then exit 130/143. `dispose()` takes the signal handlers off again.
 */
export function cleanupOnExit(stop, { onSignal = () => undefined, exit = (code) => process.exit(code) } = {}) {
  let done = null;
  const finish = () => (done ??= Promise.resolve().then(stop));
  const handlers = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ].map(([signal, code]) => {
    const handler = () => {
      onSignal(signal);
      finish()
        .catch(() => undefined)
        .finally(() => exit(code));
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  return {
    finish,
    dispose: () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}

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

/** WebKit's local storage files under a HOME (the window's: the kickoff claim, Ash's Waiting on you). */
function localStorageFiles(dir, depth = 0, found = []) {
  if (depth > 10) return found;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) localStorageFiles(full, depth + 1, found);
    else if (entry.isFile() && (entry.name === "localstorage.sqlite3" || entry.name.endsWith(".localstorage"))) found.push(full);
  }
  return found;
}

/** Every key of the window's local storage, read from a copy (WAL and all) so the running app's files are untouched. */
async function localStorageOf(home, scratch) {
  const { DatabaseSync } = await import("node:sqlite");
  const items = {};
  const files = localStorageFiles(path.join(home, "Library"));
  for (const [index, file] of files.entries()) {
    const copy = path.join(scratch, "localstorage-copy", String(index));
    fs.rmSync(copy, { recursive: true, force: true });
    fs.mkdirSync(copy, { recursive: true });
    let db;
    try {
      for (const suffix of ["", "-wal", "-shm"])
        if (fs.existsSync(`${file}${suffix}`)) fs.copyFileSync(`${file}${suffix}`, path.join(copy, `db${suffix}`));
      db = new DatabaseSync(path.join(copy, "db"));
      for (const row of db.prepare("SELECT key, value FROM ItemTable").all())
        items[row.key] = typeof row.value === "string" ? row.value : new TextDecoder("utf-16le").decode(row.value);
    } catch {
      // not a local storage database, or mid-write: the next look reads it again
    } finally {
      try {
        db?.close();
      } catch {
        // closed
      }
    }
  }
  return { files: files.length, items };
}

/**
 * A chat's entry on Ash's Waiting on you (hub/model/waitingChats.ts keeps it in local storage), or null while it has
 * none. `final`: describe what was read even without one (found: the store this window writes, by its kickoff claim).
 */
export async function waitingEntry(home, chat, scratch, final = false) {
  const { files, items } = await localStorageOf(home, scratch);
  let entry = null;
  try {
    entry = JSON.parse(items["monocode:hub-waiting-chats"] ?? "{}")[chat] ?? null;
  } catch {
    entry = null;
  }
  const found = "monocode:verify-live-kickoff" in items;
  if (entry) return { found, files, entry: { routedToLead: entry.routedToLead ?? false, source: entry.source, question: entry.question } };
  return final ? { found, files, entry: null } : null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const id = runId(new Date(), options.failGate);
  const evidence = path.join(ROOT, "evidence", id);
  fs.mkdirSync(evidence, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "monocode-verify-"));
  const home = path.join(scratch, "home");
  const project = path.join(scratch, "project");
  const bin = path.join(scratch, "bin");
  const fake = path.join(evidence, "fake");
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
  let slot;
  let dataDir = null;
  let db;
  let rulesFile;
  let planFile;
  let plan;

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
  // However the run ends (it returns, it throws, even while setting up, or it is killed with SIGINT/SIGTERM): the copy,
  // the build, vite and the stub stop, the database is kept as evidence and the temporary HOME goes (unless --keep).
  const ending = cleanupOnExit(
    async () => {
      await cleanup();
      // The database, after the app is gone (WAL and all).
      if (dataDir) {
        try {
          fs.mkdirSync(path.join(evidence, "db"), { recursive: true });
          for (const name of ["monocode.db", "monocode.db-wal", "monocode.db-shm"]) {
            const from = path.join(dataDir, name);
            if (fs.existsSync(from)) fs.copyFileSync(from, path.join(evidence, "db", name));
          }
        } catch (error) {
          log(`couldn't copy the database: ${error.message}`);
        }
      }
      if (!options.keep) fs.rmSync(scratch, { recursive: true, force: true });
    },
    { onSignal: (signal) => log(`${signal}: stopping what this run started${options.keep ? "" : " and removing its temporary HOME"}`) },
  );

  try {
    for (const dir of [home, project, bin, fake]) fs.mkdirSync(dir, { recursive: true });

    // -- the slot, the fake and the plan -------------------------------------------------------------------------------
    // Planned against the real slot registry (read only) so it never takes another worktree's slot, but registered only
    // under the temporary HOME: in the real slots.json a later plain hub:dev in this worktree could pick it.
    slot = await planSlot({ requested: options.slot });
    if (kindOf(slot.identifier) !== "dev" || !slot.identifier.startsWith(DEV_IDENTIFIER_PREFIX))
      throw new Error(`refusing: ${slot.identifier} is not a dev copy's identifier`);
    dataDir = path.join(home, "Library/Application Support", slot.identifier);
    db = path.join(dataDir, "monocode.db");
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
    rulesFile = path.join(evidence, "scenario.json");
    fs.writeFileSync(rulesFile, `${JSON.stringify(scenario({ runId: id, failGate: options.failGate }), null, 2)}\n`);
    planFile = path.join(scratch, "verify-plan.json");
    plan = {
      version: 1,
      runId: id,
      claudeBinary: claude,
      autoResume: true,
      kickoff: { project, monoName: "Verify Lead", prompt: `${KICKOFF} run ${id}: delegate the verify worker, then wait for its report.` },
    };
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    fs.writeFileSync(path.join(evidence, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  } catch (error) {
    await ending.finish();
    ending.dispose();
    throw error;
  }

  try {
    // -- build ---------------------------------------------------------------------------------------------------------
    registerSlot(slot, home);
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
        children.push(child);
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

    phase();
    // 7 and 8. Double delegation, in a fresh launch with a second plan. Ash OS (the stub) now lists a project on the
    // scratch folder, so the hub makes its Lead ("Verify lead") and ties the built-in team to it; the kickoff waits for
    // Chief of Staff to work on that folder and sends it the brief.
    stub.state.projects.push({ ...TREE_PROJECT, folder: project, workOwner: "ash_os", status: "active" });
    await kill("for the double-delegation plan");
    const treePlan = {
      ...plan,
      runId: `${id}-tree`,
      // A worker silent this long is stalled (workerStall.ts): seconds here, minutes in the app.
      stallMs: 10_000,
      kickoff: {
        project,
        monoName: "Chief of Staff",
        monoId: TEAM_MONO,
        prompt: `${TREE_KICKOFF} run ${id}: brief the Verify lead, then cancel that brief when told.`,
      },
    };
    fs.writeFileSync(planFile, `${JSON.stringify(treePlan, null, 2)}\n`);
    fs.writeFileSync(path.join(evidence, "plan-tree.json"), `${JSON.stringify(treePlan, null, 2)}\n`);
    await launch();

    const savedCall = (name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(fake, "saved", `${name}.json`), "utf8"));
      } catch {
        return null;
      }
    };
    const open = (name) => {
      fs.mkdirSync(path.join(fake, "gates"), { recursive: true });
      fs.writeFileSync(path.join(fake, "gates", name), "");
    };
    const rowById = async (taskId) =>
      taskId
        ? ((
            await query(
              db,
              "SELECT id, owner_session, child_session, parent_id, root_id, follow, state, delivery, result, pending_question, stall_kind, log FROM delegations WHERE id = ?",
              taskId,
            )
          )[0] ?? null)
        : null;
    const brief = (row) => row && { ...row, log: undefined, events: JSON.parse(row.log || "[]").map((entry) => `${entry.event} by ${entry.by}`) };
    const events = () => readNdjson(path.join(fake, "events.ndjson"));
    const interruptedIn = (conversation) =>
      !!conversation && events().some((event) => event.conversation === conversation && event.dir === "in" && /"subtype":"interrupt"/.test(event.line ?? ""));
    const turnsOf = (conversation, prefix) =>
      prompts().filter((entry) => entry.conversation === conversation && new RegExp(said(prefix)).test(entry.prompt));

    // 7. The Lead's worker asks; the question goes to the Lead.
    const cosBriefed = await waitMark("cos-briefed", 120_000);
    const cosBrief = savedCall("cos-brief");
    const cosTaskId = cosBrief?.response?.result?.taskId;
    const leadChat = cosBrief?.response?.result?.childSessionId;
    const asking = await waitMark("asker-asking", 90_000);
    const askerTask = savedCall("asker-task");
    const askerTaskId = askerTask?.response?.result?.taskId;
    const askerChat = askerTask?.response?.result?.childSessionId;
    const asked = await until(async () => {
      const row = await rowById(askerTaskId);
      return row?.state === "question" ? row : null;
    }, scale(20_000));
    const woken = await waitMark("tree-lead-got-question", 30_000);
    // While it is open: Ash's Waiting on you (the window's local storage) must not list the worker as his.
    const listing = asked ? await until(() => waitingEntry(home, askerChat, scratch), scale(10_000), 500) : null;
    const store = listing ?? (await waitingEntry(home, askerChat, scratch, true));
    open("answer-go");
    const answered = await waitMark("asker-answered", 30_000);
    const leadAnswer = savedCall("lead-answer");
    const askerDone = await until(async () => {
      const row = await rowById(askerTaskId);
      return row?.state === "completed" ? row : null;
    }, scale(30_000));
    const cosConversation = cosBriefed?.conversation;
    const askerConversation = asking?.conversation;
    const leadConversation = woken?.conversation;
    const notAsh = store?.found && (!store.entry || store.entry.routedToLead === true);
    const question = {
      wake: woken && woken.prompt.slice(woken.prompt.lastIndexOf("[MonoCode question]"), woken.prompt.lastIndexOf("[MonoCode question]") + 160),
      cosQuestions: turnsOf(cosConversation, "\\[MonoCode question\\]").length,
      askerPrompts: prompts().filter((entry) => entry.conversation === askerConversation).length,
    };
    if (
      cosBrief?.response?.ok &&
      cosBrief.response.result?.lead &&
      asked?.owner_session === leadChat &&
      asked.pending_question?.includes(QUESTION) &&
      woken &&
      leadConversation !== cosConversation &&
      woken.prompt.includes(askerTaskId) &&
      woken.prompt.includes(QUESTION) &&
      question.cosQuestions === 0 &&
      notAsh &&
      leadAnswer?.response?.ok &&
      leadAnswer.response.result?.answered === true &&
      answered?.answered &&
      answered.conversation === askerConversation &&
      answered.answers?.[QUESTION] === PICK &&
      question.askerPrompts === 1 &&
      askerDone?.result?.includes(`going with ${PICK}`)
    )
      pass(
        "question_routed",
        "A delegated worker's question goes to its Lead, not Ash, and its turn carries on with the Lead's answer",
        `Chief of Staff briefed ${cosBrief.response.result.lead} (task ${cosTaskId}); its worker asked "${QUESTION}" -> row ${askerTaskId} in question, the Lead woke with [MonoCode question] (Chief of Staff got none), Ash's Waiting on you ${store.entry ? "lists it as routed to the Lead" : "does not list it"}; task_answer ${PICK} -> the worker's same turn went on: "${askerDone.result.slice(0, 120)}"`,
        { evidence: { asked: brief(asked), answered: brief(askerDone), waitingOnYou: store, question } },
      );
    else
      fail(
        "question_routed",
        "A delegated worker's question goes to its Lead, not Ash, and its turn carries on with the Lead's answer",
        JSON.stringify({
          brief: cosBrief?.response ?? null,
          asking: !!asking,
          asked: brief(asked),
          woken: !!woken,
          sameAsCos: leadConversation === cosConversation,
          question,
          waitingOnYou: store,
          answer: leadAnswer?.response ?? null,
          answered: answered && { conversation: answered.conversation === askerConversation, answers: answered.answers },
          done: brief(askerDone ?? (await rowById(askerTaskId))),
        }),
      );

    phase();
    // 8. One cancel at the top: Chief of Staff cancels its brief while the Lead's second worker is busy.
    const helperStarted = await waitMark("helper-started", 60_000);
    const helperTask = savedCall("helper-task");
    const helperTaskId = helperTask?.response?.result?.taskId;
    const helperChat = helperTask?.response?.result?.childSessionId;
    const beneath = await until(async () => {
      const row = await rowById(helperTaskId);
      const busy = (await inFlight()).some((entry) => entry.session_id === helperChat);
      return row?.state === "running" && row.parent_id === cosTaskId && busy ? row : null;
    }, scale(20_000));
    // The helper went silent mid-turn (it waits on a gate that never opens): its row is marked stalled, quiet, since its
    // last activity, while it still runs; the window found it by itself.
    const stalledRow = await until(async () => {
      const rows = await query(db, "SELECT state, stall_kind, stall_reason, stalled_at, log FROM delegations WHERE id = ?", helperTaskId ?? "");
      return rows[0]?.stall_kind === "quiet" ? rows[0] : null;
    }, scale(90_000));
    if (stalledRow?.state === "running" && stalledRow.stalled_at > 0 && String(stalledRow.log).includes('"event":"stalled"'))
      pass(
        "worker_stalled",
        "A worker that goes silent mid-turn is marked stalled on its row",
        `task ${helperTaskId}: still running, stall_kind quiet since ${new Date(stalledRow.stalled_at).toISOString()}, logged "stalled"`,
        { evidence: { state: stalledRow.state, stall: stalledRow.stall_kind, since: stalledRow.stalled_at } },
      );
    else
      fail(
        "worker_stalled",
        "A worker that goes silent mid-turn is marked stalled on its row",
        JSON.stringify({ helperTaskId, row: brief(await rowById(helperTaskId)), stalled: stalledRow ?? null }),
      );
    phase();
    const before = { top: brief(await rowById(cosTaskId)), helper: brief(beneath) };
    open("tree-cancel");
    const cancelled = await waitMark("cos-cancelled", 60_000);
    const cancelCall = savedCall("cos-cancel");
    const ended = await until(async () => {
      const top = await rowById(cosTaskId);
      const helper = await rowById(helperTaskId);
      return [top, helper].every((row) => row?.state === "cancelled" && row.delivery === "disposed") ? { top, helper } : null;
    }, scale(15_000));
    const helperConversation = helperStarted?.conversation;
    const helperStopped = await until(
      async () => interruptedIn(helperConversation) && !(await inFlight()).some((entry) => entry.session_id === helperChat),
      scale(15_000),
    );
    const leadStopped = interruptedIn(leadConversation);
    open("lead-hold");
    const carriedOn = await waitMark("tree-lead-carried-on", 30_000);
    // Time for a report that should never come (the cancelled brief's, or its worker's).
    await sleep(scale(6_000));
    const askerRow = await rowById(askerTaskId);
    const late = {
      toCos: turnsOf(cosConversation, "\\[MonoCode report\\]").length,
      helperToLead: turnsOf(leadConversation, "\\[MonoCode report\\]").filter((entry) => helperChat && entry.prompt.includes(helperChat)).length,
      helperPrompts: prompts().filter((entry) => entry.conversation === helperConversation).length,
    };
    const result = cancelCall?.response?.result;
    if (
      beneath &&
      before.top?.follow === "lead" &&
      cancelled &&
      cancelCall?.response?.ok &&
      result?.status === "cancelled" &&
      result.cancelledBeneath >= 1 &&
      Array.isArray(result.stopFailed) &&
      !result.stopFailed.length &&
      ended &&
      !ended.helper.stall_kind &&
      helperStopped &&
      !leadStopped &&
      carriedOn &&
      askerRow?.state === "completed" &&
      !late.toCos &&
      !late.helperToLead &&
      late.helperPrompts === 1
    )
      pass(
        "cascade_stop",
        "One cancel at the top of a double delegation stops everything beneath it",
        `Chief of Staff -> Verify lead (task ${cosTaskId}, follow lead) -> worker (task ${helperTaskId}, parent ${beneath.parent_id}); task_cancel -> ${result.status}, cancelledBeneath ${result.cancelledBeneath}, stopFailed []; both rows cancelled and disposed, the worker's turn interrupted, the Lead's own turn not stopped (it carried on), no report to Chief of Staff or the Lead; the finished asker's row stays completed`,
        { evidence: { before, after: { top: brief(ended.top), helper: brief(ended.helper), asker: brief(askerRow) }, cancel: cancelCall.response } },
      );
    else
      fail(
        "cascade_stop",
        "One cancel at the top of a double delegation stops everything beneath it",
        JSON.stringify({
          beneath: !!beneath,
          before,
          cancelled: !!cancelled,
          cancel: cancelCall?.response ?? null,
          after: ended
            ? { top: brief(ended.top), helper: brief(ended.helper) }
            : { top: brief(await rowById(cosTaskId)), helper: brief(await rowById(helperTaskId)) },
          helperStopped: !!helperStopped,
          leadStopped,
          carriedOn: !!carriedOn,
          asker: askerRow?.state,
          late,
        }),
      );

    phase();
    // 9 to 12. Restarts. A third plan whose fake Claude takes /goal; the kickoff goes to Chief of Staff again.
    await kill("for the durability plan");
    const durablePlan = {
      ...plan,
      runId: `${id}-durable`,
      goals: true,
      kickoff: {
        project,
        monoName: "Chief of Staff",
        monoId: TEAM_MONO,
        prompt: `${DURABLE_KICKOFF} run ${id}: start the goal workers and brief the Verify lead.`,
      },
    };
    fs.writeFileSync(planFile, `${JSON.stringify(durablePlan, null, 2)}\n`);
    fs.writeFileSync(path.join(evidence, "plan-durable.json"), `${JSON.stringify(durablePlan, null, 2)}\n`);
    await launch();

    /** A chat's stored /goal (sessions.goal_json) and conversation; goal null when none is stored. */
    const storedGoal = async (sessionId) => {
      const row = sessionId
        ? (await query(db, "SELECT goal_json AS g, provider_session_id AS p FROM sessions WHERE id = ?", sessionId))[0]
        : undefined;
      if (!row) return null;
      let goal = null;
      try {
        goal = row.g ? JSON.parse(row.g) : null;
      } catch {
        goal = null;
      }
      return { goal, provider: row.p ?? null };
    };
    const queueOf = async (sessionId) => {
      const raw = sessionId ? (await query(db, "SELECT queued_messages_json AS q, queue_status AS s FROM sessions WHERE id = ?", sessionId))[0] : null;
      try {
        return { messages: raw?.q ? JSON.parse(raw.q) : [], status: raw?.s ?? null };
      } catch {
        return { messages: [], status: raw?.s ?? null };
      }
    };
    const rulesIn = (conversation) => prompts().filter((entry) => entry.conversation === conversation).map((entry) => entry.rule);
    const fired = (rule) => prompts().filter((entry) => entry.rule === rule).length;
    const goalPrompts = (goal) => prompts().filter((entry) => entry.prompt === `/goal ${goal}`);
    const requestOf = async (taskId) =>
      taskId ? ((await query(db, "SELECT request_id AS r FROM delegations WHERE id = ?", taskId))[0]?.r ?? null) : null;
    const goalA = goalFor(GOAL_A_WORKER, id);
    const goalB = goalFor(GOAL_B_WORKER, id);

    const durableStarted = await waitMark("durable-started", 120_000);
    const taskA = savedCall("goal-a")?.response?.result;
    const taskB = savedCall("goal-b")?.response?.result;
    const lead1 = savedCall("lead-1")?.response?.result;
    const chatA = taskA?.childSessionId;
    const chatB = taskB?.childSessionId;
    const durableLead = lead1?.childSessionId;
    const setA = await waitMark("goal-a-set", 60_000);
    const setB = await waitMark("goal-b-set", 60_000);
    const leadBusy1 = await waitMark("durable-lead-busy", 60_000);
    // The finish line is stored with the chat while it works: set, and its first check counted.
    const storedOpen = (sessionId, conversation, checks) =>
      until(async () => {
        const stored = await storedGoal(sessionId);
        return stored?.goal?.status === "active" && stored.goal.checks === checks && stored.goal.providerSessionId === conversation ? stored : null;
      }, scale(20_000));
    const beforeA = setA ? await storedOpen(chatA, setA.conversation, 1) : null;
    const beforeB = setB ? await storedOpen(chatB, setB.conversation, 1) : null;
    open("durable-queue");
    const durableQueued = await waitMark("durable-queued", 60_000);
    const lead2 = savedCall("lead-2")?.response?.result;
    const lead3 = savedCall("lead-3")?.response?.result;
    const sendA = savedCall("queued-a")?.response?.result;
    open("durable-cancel");
    const cancelledMark = await waitMark("durable-cancelled", 60_000);
    const cancel2 = savedCall("cancel-2")?.response;
    const lead2Row = () => rowById(lead2?.taskId);
    const waitingBefore = await until(async () => {
      const lead = await queueOf(durableLead);
      const worker = await queueOf(chatA);
      const has = (queue, requestId) => !!requestId && queue.messages.some((message) => message.appRequestId === requestId);
      const rows = { two: await lead2Row(), three: await rowById(lead3?.taskId) };
      return rows.two?.state === "cancelled" &&
        !has(lead, await requestOf(lead2?.taskId)) &&
        rows.three &&
        has(lead, await requestOf(lead3?.taskId)) &&
        worker.messages.some((message) => message.waitForIdle && String(message.text).startsWith(QUEUED_A))
        ? { lead: lead.messages.map((m) => m.appRequestId), worker: worker.messages.map((m) => m.appRequestId), rows }
        : null;
    }, scale(15_000));
    const leadConversation1 = leadBusy1?.conversation;
    const leadStoppedForCancel = interruptedIn(leadConversation1);
    // Chief of Staff's own turn ends first, so only the three busy chats are cut.
    const cosChat = (await rowById(lead1?.taskId))?.owner_session;
    await until(async () => (cosChat && !(await inFlight()).some((entry) => entry.session_id === cosChat) ? true : null), scale(10_000));
    const busyAtKill = (await inFlight()).map((entry) => entry.session_id);
    await kill("goal workers and the Lead busy, briefs waiting");
    if (setB?.conversation) fs.rmSync(path.join(fake, "conversations", `${setB.conversation}.json`), { force: true });
    await launch();

    // A: the same conversation, still holding its goal; nothing is sent again and the checks go on from the stored one.
    const resumedA = await waitMark("goal-a-resumed", 90_000);
    const duringA = resumedA ? await storedOpen(chatA, setA?.conversation, 2) : null;
    open("goal-a-finish");
    // B: a fresh conversation from its brief, and its /goal once more in it, with the checks it had.
    const recoveredB = await waitMark("goal-b-recovered", 90_000);
    const resetB = await waitMark("goal-b-reset", 60_000);
    const duringB = resetB ? await storedOpen(chatB, resetB.conversation, 2) : null;
    open("goal-b-finish");
    const clearedA = await until(async () => ((await storedGoal(chatA))?.goal === null ? true : null), scale(20_000));
    const clearedB = await until(async () => ((await storedGoal(chatB))?.goal === null ? true : null), scale(20_000));
    const goalEvidence = {
      before: { a: beforeA?.goal ?? null, b: beforeB?.goal ?? null },
      afterRestart: { a: duringA?.goal ?? null, b: duringB?.goal ?? null },
      cleared: { a: !!clearedA, b: !!clearedB },
      goalPrompts: { a: goalPrompts(goalA).map((p) => p.conversation), b: goalPrompts(goalB).map((p) => p.conversation) },
      conversations: { a: setA?.conversation, b: [setB?.conversation, recoveredB?.conversation] },
      busyAtKill,
    };
    if (
      beforeA &&
      beforeB &&
      resumedA?.resumed &&
      resumedA.conversation === setA.conversation &&
      duringA &&
      goalPrompts(goalA).length === 1 &&
      recoveredB &&
      recoveredB.conversation !== setB.conversation &&
      resetB?.conversation === recoveredB.conversation &&
      duringB &&
      goalPrompts(goalB).length === 2 &&
      goalPrompts(goalB)[1].conversation === recoveredB.conversation &&
      clearedA &&
      clearedB
    )
      pass(
        "goal_survives_restart",
        "A chat's /goal survives a restart: kept by a resumed conversation, set again once in a fresh one, then cleared when met",
        `stored before the kill: A ${beforeA.goal.checks} check, B ${beforeB.goal.checks}; A resumed ${resumedA.conversation} with its goal (no /goal sent again, checks ${duringA.goal.checks}); B's transcript was gone, fresh conversation ${recoveredB.conversation} got /goal once (checks carried: ${duringB.goal.checks}); both met and cleared`,
        { evidence: goalEvidence },
      );
    else fail("goal_survives_restart", "A chat's /goal survives a restart: kept by a resumed conversation, set again once in a fresh one, then cleared when met", JSON.stringify(goalEvidence));

    // 10. The briefs that waited go in once each chat's resumed turn is over.
    const deliveredA = await waitMark("queued-a-delivered", 60_000);
    const leadResumed = await waitMark("durable-lead-resumed", 60_000);
    const delivered3 = await waitMark("durable-lead-3-delivered", 60_000);
    const settled = await until(async () => {
      const followA = (await query(db, "SELECT id, state, delivery, follow FROM delegations WHERE child_session = ? AND follow = 'queue'", chatA ?? "?"))[0];
      const three = await rowById(lead3?.taskId);
      return followA?.state === "completed" && three?.state === "completed" ? { followA, three: brief(three) } : null;
    }, scale(30_000));
    const orderA = rulesIn(setA?.conversation);
    const orderLead = rulesIn(leadConversation1);
    const queueEvidence = {
      sends: { a: sendA?.delivery ?? null, lead2: lead2?.delivery ?? null, lead3: lead3?.delivery ?? null },
      waitingBefore,
      orderA,
      orderLead,
      settled,
      queuesAfter: { a: await queueOf(chatA), lead: await queueOf(durableLead) },
    };
    if (
      durableQueued &&
      sendA?.delivery === "queued" &&
      lead3?.delivery === "queued" &&
      waitingBefore &&
      deliveredA &&
      leadResumed &&
      delivered3 &&
      orderA.indexOf("durable-goal-a-resume") >= 0 &&
      orderA.indexOf("durable-goal-a-resume") < orderA.indexOf("durable-queued-a") &&
      orderLead.indexOf("durable-lead-resume") >= 0 &&
      orderLead.indexOf("durable-lead-resume") < orderLead.indexOf("durable-lead-3") &&
      fired("durable-queued-a") === 1 &&
      fired("durable-lead-3") === 1 &&
      settled
    )
      pass(
        "queued_brief_after_restart",
        "Briefs queued before a restart go in by themselves once their chat's resumed turn is over, once each",
        `worker A's brief and the Lead's brief 3 waited through the restart (queued), went in after the resumed turns (${orderA.join(" > ")}; ${orderLead.join(" > ")}), once each, and their rows settled (${settled.followA.state}, ${settled.three.state})`,
        { evidence: queueEvidence },
      );
    else fail("queued_brief_after_restart", "Briefs queued before a restart go in by themselves once their chat's resumed turn is over, once each", JSON.stringify(queueEvidence));

    // 11. The brief cancelled while it waited in the busy Lead's queue stays out.
    const twoAfter = await lead2Row();
    const cancelEvidence = {
      send: lead2?.delivery ?? null,
      cancel: cancel2 ?? null,
      row: brief(twoAfter),
      leadStoppedForCancel,
      deliveredAfterRestart: fired("durable-lead-2"),
    };
    if (
      lead2?.delivery === "queued" &&
      cancelledMark &&
      cancel2?.ok &&
      cancel2.result?.status === "cancelled" &&
      waitingBefore &&
      twoAfter?.state === "cancelled" &&
      twoAfter.delivery === "disposed" &&
      !leadStoppedForCancel &&
      leadResumed &&
      fired("durable-lead-2") === 0
    )
      pass(
        "cancelled_brief_stays_out",
        "A brief cancelled while it waits in a busy Lead's queue leaves the queue, the Lead isn't stopped, and a restart doesn't bring it back",
        `task_cancel on Lead brief 2 (queued) -> ${cancel2.result.status}; row cancelled and disposed, out of the Lead's queue before the restart, the Lead's own turn not interrupted, and after the restart brief 3 went in but brief 2 never did`,
        { evidence: cancelEvidence },
      );
    else fail("cancelled_brief_stays_out", "A brief cancelled while it waits in a busy Lead's queue leaves the queue, the Lead isn't stopped, and a restart doesn't bring it back", JSON.stringify(cancelEvidence));

    // 12. One more restart, with everything idle: nothing goes in twice and no goal comes back.
    await sleep(scale(2_000));
    await kill("everything idle");
    await launch();
    await sleep(scale(8_000));
    const finalCounts = {
      queuedA: fired("durable-queued-a"),
      lead2: fired("durable-lead-2"),
      lead3: fired("durable-lead-3"),
      goalA: goalPrompts(goalA).length,
      goalB: goalPrompts(goalB).length,
      goalAgain: fired("durable-goal-a-again"),
      storedA: (await storedGoal(chatA))?.goal ?? null,
      storedB: (await storedGoal(chatB))?.goal ?? null,
      inFlight: (await inFlight()).map((entry) => entry.session_id),
    };
    if (
      finalCounts.queuedA === 1 &&
      finalCounts.lead2 === 0 &&
      finalCounts.lead3 === 1 &&
      finalCounts.goalA === 1 &&
      finalCounts.goalB === 2 &&
      finalCounts.goalAgain === 0 &&
      finalCounts.storedA === null &&
      finalCounts.storedB === null &&
      clearedA &&
      clearedB
    )
      pass(
        "nothing_repeats_after_restart",
        "Another restart repeats nothing: no brief twice, no /goal again, no finished goal back",
        `after launch ${launches}: worker A's brief 1x, Lead brief 3 1x, brief 2 0x; /goal A 1x, /goal B 2x (once per conversation); no stored goal`,
        { evidence: finalCounts },
      );
    else fail("nothing_repeats_after_restart", "Another restart repeats nothing: no brief twice, no /goal again, no finished goal back", JSON.stringify(finalCounts));
  } catch (error) {
    if (error instanceof Halt) {
      for (const name of WALK.filter((name) => !checks.some((check) => check.id === name)))
        skip(name, name, "not run: the negative control stops at its first failure");
    } else fail("run", "The walk ran to the end", error.message);
  } finally {
    await ending.finish();
    ending.dispose();
  }

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
