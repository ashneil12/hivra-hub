#!/usr/bin/env node
// `npm run hub:realtest`: real end-to-end tests of the Hub with REAL Claude (Sonnet, medium effort), on a demanding test
// project, graded against Ash's benchmark (docs/REALTEST.md). It builds this worktree's dev copy, runs it under a
// throwaway HOME (a dev slot: never the daily app, its data, ~/.claude or ~/Applications), makes the Tally test project
// (tests/realtest/tally) as a fresh git repo, lists it in the dev copy's plan so the hub makes its Lead and seats
// the leadership team, and then plays Ash's side from a scenario file through the window's own handlers
// (src/app/model/verifyDriver.ts: the room's composer, a chat's composer, the Stop button, the views).
//
// Claude is the real CLI behind scripts/hub-realtest-claude.mjs: the dev copies' shared login, every chat held to
// Sonnet + medium, every line logged, a budget stop, and a recorded outage on demand. One stand-in gives the chats
// memory tools (scripts/hub-realtest-memory-mcp.mjs). Being
// built needs no stand-in: since 21 Oct it is the app's own rows, which the app lists itself.
//
// Evidence: evidence/realtest/<run>/ (events, snapshots, DOM views, screenshots when capture works, every Claude line,
// the database, per-scenario transcripts and grades, report.md).
//
//   npm run hub:realtest                                   # build, then run tests/realtest/scenarios/baseline.json
//   npm run hub:realtest -- --no-build                     # reuse target/debug/monocode
//   npm run hub:realtest -- --only s01,s02                 # some scenarios
//   npm run hub:realtest -- --max-turns 300 --max-minutes 110
//   npm run hub:realtest -- --no-grade                     # skip the grader (rule metrics only)
//   npm run hub:realtest -- --grade-only evidence/realtest/<run>   # grade a finished run again
//   npm run hub:realtest -- --keep                         # keep the temporary HOME afterwards
//   npm run hub:realtest -- --claude-config ~/claude-acct-2   # more Claude accounts Ash signed in himself (repeatable)
//   npm run hub:realtest -- --agents deepseek-sub          # the default (--agents deepseek-sub | claude | haiku-test)
//
// Default (Ash, 27 Oct: "no test or run may use his Claude subscription"): every chat, helper call and the grader on
// DeepSeek V4.1 Flash through ~/.local/bin/claude-deepseek. Claude runs only when someone passes `--agents claude`.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appsFromPs, benchDenyRules, exitCodeForStop, isHardStop, readDummy, startDummy, stopDummy, writeBenchSettings } from "./bench-guard.mjs";
import { privateTempDir } from "./bench-sandbox.mjs";
import { DEV_IDENTIFIER_PREFIX, kindOf } from "./hub-bundle.mjs";
import { DEV_PRODUCT, ROOT, isMain, planSlot, readJson, registerSlot, writeSlotConfig } from "./hub-dev.mjs";
import { cleanupOnExit, mergePatch, readNdjson } from "./hub-verify-live.mjs";
import { benchAccounts, claudeConfigArgs, latestReadings, limitedFiles, startCheck, watchAccounts, writeAccounts } from "./hub-realtest-accounts.mjs";

const REAL_HOME = os.homedir();
export const DEV_CLAUDE_CONFIG = path.join(REAL_HOME, ".monocode-hub-dev/claude-config");
const LOGIN_KEYCHAIN = path.join(REAL_HOME, "Library/Keychains/login.keychain-db");
const DEFAULT_SCENARIOS = path.join(ROOT, "tests/realtest/scenarios/baseline.json");
const TEMPLATE = path.join(ROOT, "tests/realtest/tally");

/**
 * A throwaway copy of one of Ash's repos for a scene: a fresh clone of its current branch (never hard links into his
 * repo), with every remote removed and pushes pointed nowhere, so the agents can commit and "ship" without reaching
 * his repo or any real remote. Returns the copy's folder.
 */
export function copyProject(source, dest, env = {}) {
  const run = (args, cwd) => execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  if (!fs.existsSync(path.join(source, ".git"))) throw new Error(`not a git repo: ${source}`);
  if (fs.existsSync(dest)) throw new Error(`copy already exists: ${dest}`);
  run(["clone", "-q", "--no-hardlinks", "--single-branch", source, dest]);
  for (const remote of run(["remote"], dest).split("\n").filter(Boolean)) run(["remote", "remove", remote], dest);
  run(["config", "remote.pushDefault", "nowhere"], dest);
  run(["config", "credential.helper", ""], dest);
  return fs.realpathSync(dest);
}
/**
 * The run's git never reaches a real remote with Ash's logins (21 Oct: a worker re-added origin, pulled his GitHub token
 * out of the login Keychain with `git credential fill`, and opened and merged real pull requests). The temporary HOME's
 * gitconfig and the app's environment both empty the credential helper list (that also drops the system osxkeychain
 * helper), push URLs for GitHub go nowhere, and git over ssh fails.
 */
export const BENCH_GITCONFIG =
  '[credential]\n\thelper =\n[url "nowhere://bench-blocked/"]\n\tpushInsteadOf = https://github.com/\n\tpushInsteadOf = git@github.com:\n\tpushInsteadOf = ssh://git@github.com/\n';
export const BENCH_GIT_ENV = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "false",
  GIT_ASKPASS: "false",
  SSH_ASKPASS: "false",
};
/** Ash's launcher for Claude Code on DeepSeek V4.1 Flash through his local gateway (no hub route needed). */
export const DEEPSEEK_BRIDGE = path.join(REAL_HOME, ".local/bin/claude-deepseek");
/** The alias Ash's gateway serves DeepSeek V4.1 Flash under; the launcher rewrites every model to it. */
export const DEEPSEEK_BRIDGE_MODEL = "claude-fable-5";

/** The DeepSeek launcher's path, or a plain-words error when this Mac doesn't have it. Presence only. */
export function deepseekBridge(file = DEEPSEEK_BRIDGE) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return file;
  } catch {
    throw new Error(`--deepseek-sub needs the DeepSeek launcher at ${file} (Claude Code on DeepSeek V4.1 Flash through the local gateway); it isn't there`);
  }
}

/** Ash's launcher for Claude Code on Grok through his local gateway. Presence only: the file is never read. */
export const GROK_BRIDGE = path.join(REAL_HOME, ".local/bin/claude-grok");

/** The Grok launcher's path, or a plain-words error when this Mac doesn't have it. Presence only. */
export function grokBridge(file = GROK_BRIDGE) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return file;
  } catch {
    throw new Error(`--agents grok-sub needs the Grok launcher at ${file} (Claude Code on Grok through the local gateway); it isn't there`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (ms) => new Date(ms).toISOString();
const secs = (ms) => Math.round(ms / 100) / 10;

async function until(read, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(everyMs);
  }
}

/**
 * Puts Ash's team on the fresh copy (WP-05 seats nobody) and waits until the project's Lead and a seated leadership
 * room exist. `beforeReady`, when it returns the pre-load, is that call; otherwise the Ash team is loaded here.
 * `until` is injectable so a test can try once. Returns the ready snapshot and the Monos the pre-load named.
 */
export async function waitForSeatedRoom({ act, log, spec, beforeReady, until: wait = until }) {
  let teamResult = beforeReady ? await beforeReady({ act, log }) : null;
  if (!teamResult && (spec.team ?? "ash") === "ash") {
    teamResult = await act("teamPack", { pack: "ash", project: spec.project?.id });
    if (teamResult?.ok === false) throw new Error(`the hub wouldn't pre-load Ash's team: ${teamResult.error ?? teamResult.pack}`);
    const names = (teamResult?.monos ?? []).map((mono) => mono.name).filter(Boolean).join(", ");
    log(`team: Ash's pre-load (${names || "none"}; souls written: ${(teamResult.wrote ?? []).join(", ") || "none"})`);
  } else if (teamResult?.ok === false) {
    throw new Error(`the hub wouldn't pre-load Ash's team: ${teamResult.error ?? teamResult.pack}`);
  }
  const leadId = `${spec.project.id}-lead`;
  const roomId = `${spec.project.id}:leadership`;
  const ready = await wait(async () => {
    const snap = await act("snapshot", {}, 60_000);
    const lead = snap.monos?.find((mono) => mono.id === leadId);
    const room = snap.rooms?.find((r) => r.id === roomId);
    return lead && room?.memberIds?.length ? snap : null;
  }, 180_000, 3_000);
  if (!ready) throw new Error(`the hub never made ${leadId} and a seated ${roomId}`);
  return { ready, team: teamResult?.monos ?? [], leadId, roomId };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function parseArgs(argv) {
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    scenarios: path.resolve(value("--scenarios", DEFAULT_SCENARIOS)),
    only: value("--only", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    build: !argv.includes("--no-build"),
    keep: argv.includes("--keep"),
    // r82: the scenario's check is installed in the app (gates.rs runs it when a worker reports done); the bench's own loop is off.
    appGate: argv.includes("--app-gate"),
    grade: !argv.includes("--no-grade"),
    gradeOnly: value("--grade-only", null),
    slot: value("--slot", `${path.basename(ROOT)}-realtest`),
    maxTurns: Number(value("--max-turns", "0")) || null,
    maxMinutes: Number(value("--max-minutes", "0")) || null,
    maxRequests: Number(value("--max-requests", "0")) || null,
    claudeConfigs: claudeConfigArgs(argv),
    ...benchAgents(argv, value("--agents", null)),
  };
}

/** Which model the agents (and the grader) run on: DeepSeek by default, Claude or Grok only when named. */
export function benchAgents(argv, named = null) {
  if (named !== null && !BENCH_AGENTS.includes(named)) throw new Error(`--agents is ${BENCH_AGENTS.join(", ")}, not "${named}"`);
  const claude = named === "claude";
  const haikuTest = named === "haiku-test";
  const grokSub = named === "grok-sub";
  const deepseekNamed = argv.includes("--deepseek-sub") || named === "deepseek-sub";
  if ((claude || haikuTest || grokSub) && deepseekNamed) throw new Error(`--agents ${named} and a subscription bridge are two different agents' models; pass one`);
  const deepseekSub = deepseekNamed || (!claude && !haikuTest && !grokSub);
  return { deepseekSub, grokSub, ...(haikuTest ? { haikuTest } : {}) };
}
/** haiku-test: every chat on Haiku with Ash's Anthropic test key (ANTHROPIC_TEST_API_KEY), never a Claude login. */
export const BENCH_AGENTS = ["deepseek-sub", "claude", "haiku-test", "grok-sub"];

/** True when the grader stays on the DeepSeek launcher (the default, Haiku test workers, and Grok agents). */
export function graderUsesDeepSeek(options) {
  return !!(options.deepseekSub || options.haikuTest || options.grokSub);
}

/** The grader's CLI and model: through the DeepSeek launcher, so grading never spends Claude unless asked. */
export function graderVia(options) {
  if (graderUsesDeepSeek(options)) return { claude: deepseekBridge(), model: DEEPSEEK_BRIDGE_MODEL };
  return {};
}

/**
 * The model the bench's claude wrapper asks for. Grok keeps the book's model (the launcher maps it). DeepSeek uses
 * the gateway's alias. Haiku test workers are Haiku.
 */
export function wrapperModel({ grokSub = false, deepseekSub = false, haikuTest = false, specModel = "sonnet" } = {}) {
  if (haikuTest) return "haiku";
  if (grokSub) return specModel || "sonnet";
  if (deepseekSub) return DEEPSEEK_BRIDGE_MODEL;
  return specModel || "sonnet";
}

/** Plan flags the window reads. Grok is `launcher` (no Claude sign-in) and never `deepseek` (that would rename models). */
export function planFlags(options) {
  return {
    ...(options.deepseekSub ? { deepseek: true } : {}),
    ...(options.grokSub ? { launcher: true } : {}),
  };
}

/** The throwaway `claude` the dev copy runs. A Grok run sets REALTEST_GROK_SUB so the wrapper strips caller credentials. */
export function claudeWrapperScript({ state, realClaude, config, model, effort, memoryDir, haiku = false, grok = false, node, script, realHome, allowed, devData, benchSettings }) {
  const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  return [
    "#!/bin/sh",
    `export REALTEST_STATE=${quote(state)}`,
    `export REALTEST_REAL_CLAUDE=${quote(realClaude)}`,
    `export REALTEST_CLAUDE_CONFIG=${quote(config)}`,
    `export REALTEST_MODEL=${quote(model)}`,
    ...(haiku ? ["export REALTEST_HAIKU_TEST=1"] : []),
    ...(grok ? ["export REALTEST_GROK_SUB=1"] : []),
    `export REALTEST_EFFORT=${quote(effort)}`,
    `export REALTEST_MEMORY_DIR=${quote(memoryDir)}`,
    ...(realHome ? [`export REALTEST_REAL_HOME=${quote(realHome)}`] : []),
    ...(allowed ? [`export REALTEST_ALLOWED=${quote(JSON.stringify(allowed))}`] : []),
    ...(devData ? [`export REALTEST_DEV_DATA=${quote(devData)}`] : []),
    ...(benchSettings ? [`export REALTEST_BENCH_SETTINGS=${quote(benchSettings)}`] : []),
    `exec ${quote(node)} ${quote(script)} "$@"`,
    "",
  ].join("\n");
}

export function runId(now = new Date()) {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")}-${crypto.randomBytes(2).toString("hex")}`;
}

// ---- the database (read-only, a copy-free read like hub-verify-live) -------------------------------------------------

async function query(file, sql, ...params) {
  if (!fs.existsSync(file)) return [];
  const { DatabaseSync } = await import("node:sqlite");
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
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

/** Plain text of a stored block list (assistant and user text; tools as one line each). */
export function blocksText(blocks, { tools = true, max = 1500 } = {}) {
  const lines = [];
  for (const block of blocks ?? []) {
    if (!block || typeof block !== "object") continue;
    const at = block.startedAt ?? block.sentAt ?? null;
    if (block.role === "assistant" && block.text?.trim()) lines.push({ at, who: "assistant", text: block.text.trim().slice(0, max) });
    else if (block.role === "user" && block.text?.trim()) lines.push({ at, who: "user", text: block.text.trim().slice(0, max) });
    else if (tools && block.tool) lines.push({ at, who: "tool", text: `${block.tool.title ?? block.tool.kind ?? "tool"} [${block.tool.status ?? ""}]`.slice(0, 300) });
    else if (block.notice || block.role === "notice" || block.role === "system")
      lines.push({ at, who: "notice", text: String(block.text ?? block.notice ?? "").slice(0, max) });
  }
  return lines;
}


// ---- Claude usage (scripts/hub-realtest-claude.mjs writes it) ---------------------------------------------------------

export function usageOf(entries, since = 0) {
  const after = entries.filter((entry) => entry.t >= since);
  return {
    turns: after.filter((entry) => entry.kind === "turn").length,
    requests: after.filter((entry) => entry.kind === "request").length,
    helperTurns: after.filter((entry) => entry.kind === "helper-turn").length,
    faults: after.filter((entry) => entry.kind === "fault").length,
    refused: after.filter((entry) => entry.kind === "refused").length,
    models: [...new Set(after.filter((entry) => entry.model).map((entry) => entry.model))],
    outputTokens: after.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0),
  };
}

// ---- main -------------------------------------------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.gradeOnly) {
    const { gradeRun } = await import("./hub-realtest-grade.mjs");
    return gradeRun(path.resolve(options.gradeOnly), { claudeConfig: DEV_CLAUDE_CONFIG, ...graderVia(options) });
  }
  const outcome = await runBench(options);
  return exitCodeForStop(outcome?.stopReason);
}

/**
 * The bench: a dev copy under a temporary HOME with the test project and the window's driver, then the
 * scenarios, then the evidence. `hooks` let another runner use the same bench (scripts/hub-realconv.mjs):
 *  - spec: the run's spec object instead of reading options.scenarios;
 *  - evidenceDir: where under the repo the run's folder goes (default evidence/realtest);
 *  - routedAgents: the agents run on a custom model through the hub's router, so the Claude login is only needed for
 *    the app's helper calls and its account limits don't gate the run (they are still read and logged when reachable);
 *  - beforeReady({act, log}): before the ready wait, once the window's driver answers. Return the teamPack
 *    result to seat that team; return nothing and the Ash pre-load runs here (a fresh copy seats nobody);
 *  - afterReady(ctx): once the hub is ready and its defaults are set (add a custom model, pick it);
 *  - play(ctx, {runScenario, stopped}): replaces the scenario loop and returns the results; the realtest grader is not
 *    run (the caller judges).
 * Resolves with {id, evidence, results, stopReason}.
 */
export async function runBench(options, hooks = {}) {
  const spec = hooks.spec ?? readJson(options.scenarios);
  // On a gateway launcher no chat spends Claude: limits are logged, not enforced, as for routed agents.
  const bridge = options.deepseekSub ? deepseekBridge() : options.grokSub ? grokBridge() : null;
  const unmetered = !!hooks.routedAgents || !!bridge;
  const budget = {
    maxTurns: options.maxTurns ?? spec.budget?.maxTurns ?? 300,
    maxMinutes: options.maxMinutes ?? spec.budget?.maxMinutes ?? 110,
    maxRequests: options.maxRequests ?? spec.budget?.maxRequests ?? 2500,
    /** Don't start above this share of the account's 5-hour window, and stop once it passes stopAtFiveHour. */
    startBelowFiveHour: spec.budget?.startBelowFiveHour ?? 0.6,
    stopAtFiveHour: spec.budget?.stopAtFiveHour ?? 0.85,
    stopAtSevenDay: spec.budget?.stopAtSevenDay ?? 0.7,
  };
  const scenarios = hooks.play ? [] : spec.scenarios.filter((s) => !options.only.length || options.only.includes(s.id));
  const id = runId();
  const evidence = path.resolve(ROOT, hooks.evidenceDir ?? "evidence/realtest", id);
  const state = path.join(evidence, "claude");
  fs.mkdirSync(state, { recursive: true });
  // Canonical (macOS's /var is /private/var): the app, git and Claude all report real paths, and the plan's project
  // folder has to match what they say.
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "monocode-realtest-")));
  const home = path.join(scratch, "home");
  const projects = path.join(scratch, "projects");
  const project = path.join(projects, spec.project.id);
  const driver = path.join(scratch, "driver");
  const memoryDir = path.join(scratch, "memory");
  const bin = path.join(scratch, "bin");
  const started = Date.now();
  const deadline = started + budget.maxMinutes * 60_000;
  const log = (line) => {
    const text = `[${hooks.label ?? "realtest"} ${new Date().toISOString().slice(11, 19)}] ${line}`;
    console.log(text);
    fs.appendFileSync(path.join(evidence, "run.log"), `${text}\n`);
  };
  const children = [];
  let app = null;
  let dataDir = null;
  let db = null;
  let slot = null;
  let pumpTimer = null;
  let stopReason = null;
  let results = [];
  let accountList = [];

  const cleanup = async () => {
    clearInterval(pumpTimer);
    // No new turns from here on: the wrapper refuses them once this file exists.
    try {
      if (!isHardStop(stopReason)) fs.writeFileSync(path.join(state, "stop"), "run ended\n");
    } catch {
      // gone
    }
    try {
      stopDummy(state);
    } catch {
      // the dummy was already gone
    }
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
    // Claude processes this run started that outlived the app (every real chat's arguments name this run's folder).
    const left = spawnSync("pgrep", ["-f", scratch], { encoding: "utf8" }).stdout.split("\n").map(Number).filter((pid) => pid && pid !== process.pid);
    for (const pid of left) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // gone
      }
    }
    if (left.length) log(`stopped ${left.length} leftover process(es) of this run`);
  };
  const ending = cleanupOnExit(
    async () => {
      await cleanup();
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
      try {
        // The project as the agents left it (its git log is evidence of what shipped).
        fs.writeFileSync(path.join(evidence, "project-git-log.txt"), execFileSync("git", ["log", "--all", "--stat", "--format=%h %ad %s", "--date=iso"], { cwd: project, encoding: "utf8" }));
        fs.writeFileSync(path.join(evidence, "project-status.txt"), execFileSync("git", ["status", "--short"], { cwd: project, encoding: "utf8" }));
      } catch {
        // no project yet
      }
      try {
        fs.cpSync(memoryDir, path.join(evidence, "memory-after"), { recursive: true });
      } catch {
        // none
      }
      // Each Mono's own files (SOUL.md, MEMORY.md): the app's per-Mono memory, for the memory checks.
      try {
        const monos = path.join(dataDir, "monos");
        for (const mono of fs.existsSync(monos) ? fs.readdirSync(monos) : [])
          for (const name of ["MEMORY.md", "SOUL.md"]) {
            const from = path.join(monos, mono, name);
            if (fs.existsSync(from)) {
              fs.mkdirSync(path.join(evidence, "monos", mono), { recursive: true });
              fs.copyFileSync(from, path.join(evidence, "monos", mono, name));
            }
          }
      } catch {
        // none
      }
      if (!options.keep) fs.rmSync(scratch, { recursive: true, force: true });
    },
    { onSignal: (signal) => log(`${signal}: stopping what this run started`) },
  );

  try {
    for (const dir of [home, projects, driver, path.join(driver, "inbox"), memoryDir, bin]) fs.mkdirSync(dir, { recursive: true });
    slot = await planSlot({ requested: options.slot });
    if (kindOf(slot.identifier) !== "dev" || !slot.identifier.startsWith(DEV_IDENTIFIER_PREFIX))
      throw new Error(`refusing: ${slot.identifier} is not a dev copy's identifier`);
    dataDir = path.join(home, "Library/Application Support", slot.identifier);
    db = path.join(dataDir, "monocode.db");
    log(`run ${id}: slot ${slot.slot} (${slot.identifier}), HOME ${home}, evidence ${path.relative(ROOT, evidence)}`);
    log(`budget: ${budget.maxTurns} model turns, ${budget.maxRequests} model requests, ${budget.maxMinutes} min; ${hooks.play ? "the caller's scenes" : `${scenarios.length} scenarios`}`);

    // -- the temporary HOME: the dev copies' Claude login and git identity, nothing of the real home's ---------------------
    if (!fs.existsSync(DEV_CLAUDE_CONFIG)) throw new Error(`${DEV_CLAUDE_CONFIG} is missing: sign a dev copy's Claude in first`);
    fs.mkdirSync(path.join(home, ".monocode-hub-dev"), { recursive: true });
    // The app reads Claude's transcripts where its own CLAUDE_CONFIG_DIR points; the wrapper runs Claude in the real
    // shared dev config (its Keychain login is keyed to that path), so the two must be the same folder.
    fs.symlinkSync(DEV_CLAUDE_CONFIG, path.join(home, ".monocode-hub-dev/claude-config"));
    // Claude finds its Keychain login through `security`, which looks in HOME's keychain list: point the temporary
    // HOME's list (its own Library/Preferences, never the real one) at the login keychain.
    fs.mkdirSync(path.join(home, "Library/Preferences"), { recursive: true });
    execFileSync("security", ["list-keychains", "-d", "user", "-s", LOGIN_KEYCHAIN], { env: { ...process.env, HOME: home } });
    fs.writeFileSync(
      path.join(home, ".gitconfig"),
      "[user]\n\tname = Tally Agents\n\temail = agents@tally.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n" + BENCH_GITCONFIG,
    );
    // Every Claude account the run may use (E5): the shared dev login first, then any folder Ash signed in himself and
    // named with --claude-config. Each is checked for its login and its use; the run starts when any has room.
    const accounts = benchAccounts(DEV_CLAUDE_CONFIG, options.claudeConfigs ?? []);
    const loginOf = (config) => {
      const login = spawnSync(path.join(REAL_HOME, ".local/bin/claude"), ["auth", "status"], {
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: config },
        encoding: "utf8",
      });
      try {
        return JSON.parse(login.stdout);
      } catch {
        return {};
      }
    };
    const readings = accounts.map((account) => {
      // On a bridge the Claude login isn't used at all: no login check, no Haiku use reading.
      if (bridge) return { loggedIn: false, at: new Date().toISOString(), status: null, fiveHour: null, sevenDay: null };
      const login = loginOf(account.config);
      if (login.loggedIn) log(`claude account ${account.n} signed in under the temporary HOME (${login.authMethod}, ${login.subscriptionType}): ${account.config}`);
      else log(`claude account ${account.n} isn't signed in: ${account.config}`);
      // The login is Ash's own account, shared with his work: one tiny Haiku call reads its use.
      return login.loggedIn ? { loggedIn: true, ...accountUse(home, account.config) } : { loggedIn: false, at: new Date().toISOString(), status: null, fiveHour: null, sevenDay: null };
    });
    const status = { loggedIn: readings.some((r) => r.loggedIn) };
    if (bridge) log(options.grokSub
      ? `every chat and helper call on Grok through the local gateway launcher (${bridge}); no Claude login used`
      : `every chat and helper call on DeepSeek V4.1 Flash through the local gateway launcher (${bridge}); no Claude login used`);
    if (!status.loggedIn && !unmetered) throw new Error("no dev Claude login is reachable under the temporary HOME (claude auth status says logged out for every account)");
    if (!status.loggedIn && !bridge) log("no Claude login is reachable: the agents run on the custom model, but the app's Haiku helper calls (titles, the room's gate) will fail");
    const use = readings[0];
    fs.writeFileSync(path.join(evidence, "account-before.json"), JSON.stringify({ ...use, accounts: accounts.map((a, i) => ({ ...a, ...readings[i] })) }, null, 2));
    for (const [i, reading] of readings.entries()) log(`account ${i + 1} use: 5-hour ${pctOf(reading.fiveHour)}, 7-day ${pctOf(reading.sevenDay)}${reading.status ? ` (${reading.status})` : ""}`);
    // A run whose agents are on a custom model only spends Claude on helper calls, so its limits are logged, not enforced.
    const checked = startCheck(accounts, unmetered ? readings.map((r) => ({ ...r, fiveHour: null, sevenDay: null, status: null })) : readings, budget);
    if (!checked.ok && !unmetered)
      throw new Error(`no Claude account has room to start (each must be under ${pctOf(budget.startBelowFiveHour)} of its 5-hour window; Ash's own work shares them): ${checked.list.map((a) => `account ${a.n} ${a.out}`).join("; ")}`);
    accountList = checked.list;
    writeAccounts(state, accountList);
    if (checked.active) log(`new Claude chats go to account ${checked.active.n}${accounts.length > 1 ? ` of ${accounts.length}` : ""}`);

    // -- the test project ------------------------------------------------------------------------------------------------
    fs.cpSync(TEMPLATE, project, { recursive: true });
    // A scenario book's own changes to the starting project (r77 s14: a note only a worker reading that file meets),
    // committed with the rest so nothing marks them as added.
    for (const [file, text] of Object.entries(spec.projectFiles ?? {})) fs.writeFileSync(path.join(project, file), text);
    const git = (...args) => execFileSync("git", args, { cwd: project, env: { ...process.env, HOME: home }, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "Tally: starting point (one failing stats test on purpose)");
    log(`project ${spec.project.name} at ${project}`);
    // Throwaway copies of Ash's real repos (a scene book's `copies`): cloned with no remote, so nothing can reach his.
    const copies = (spec.copies ?? []).map((copy) => ({ ...copy, folder: copyProject(copy.source, path.join(projects, copy.id), { HOME: home }) }));
    for (const copy of copies) log(`copy of ${copy.name} at ${copy.folder} (from ${copy.source}, no remote)`);

    // -- memory: the invented facts the run checks for ----------------------------------------------------------------------
    for (const [layer, facts] of Object.entries(spec.memory ?? {})) {
      fs.mkdirSync(path.join(memoryDir, layer), { recursive: true });
      fs.writeFileSync(path.join(memoryDir, layer, "MEMORY.md"), `${facts.map((fact) => `- ${fact}`).join("\n")}\n`);
    }
    fs.cpSync(memoryDir, path.join(evidence, "memory-before"), { recursive: true });

    // Bench denies live in a settings file under the temporary HOME. The shared dev config is never written.
    const allowedRoots = [scratch, home, project, projects, memoryDir];
    const settingsFile = path.join(home, ".monocode-hub-bench", "settings.json");
    writeBenchSettings(settingsFile, {
      rules: benchDenyRules({ realHome: REAL_HOME, allowed: allowedRoots }),
      node: process.execPath,
      hook: path.join(ROOT, "scripts/bench-guard-hook.mjs"),
      realHome: REAL_HOME,
      devData: dataDir,
      allowed: allowedRoots,
      home,
      devConfig: DEV_CLAUDE_CONFIG,
    });
    try {
      startDummy(state);
    } catch (error) {
      log(`bench dummy did not start: ${error.message}`);
    }

    // -- the claude wrapper -----------------------------------------------------------------------------------------------
    // A bridge launcher is passed as itself (it maps the model to its gateway's alias by its own name), never resolved.
    const realClaude = bridge ?? fs.realpathSync(path.join(REAL_HOME, ".local/bin/claude"));
    const claude = path.join(bin, "claude");
    fs.writeFileSync(
      claude,
      claudeWrapperScript({
        state,
        realClaude,
        config: DEV_CLAUDE_CONFIG,
        model: wrapperModel({ grokSub: !!options.grokSub, deepseekSub: !!options.deepseekSub, haikuTest: !!options.haikuTest, specModel: spec.model ?? "sonnet" }),
        effort: spec.effort ?? "medium",
        memoryDir,
        haiku: !!options.haikuTest,
        grok: !!options.grokSub,
        node: process.execPath,
        script: path.join(ROOT, "scripts/hub-realtest-claude.mjs"),
        realHome: REAL_HOME,
        allowed: allowedRoots,
        devData: dataDir,
        benchSettings: settingsFile,
      }),
      { mode: 0o755 },
    );
    const planFile = path.join(scratch, "verify-plan.json");
    // On a gateway launcher the window knows it: no Claude account's sign-in or limit holds workers.
    // Grok sets `launcher` only. `deepseek` would rename every model, which the Grok gateway would reject.
    const plan = { version: 1, runId: id, claudeBinary: claude, autoResume: true, driver, ...planFlags(options) };
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    fs.writeFileSync(path.join(evidence, "plan.json"), `${JSON.stringify({ ...plan, scenarios: options.scenarios, budget }, null, 2)}\n`);

    // -- build -------------------------------------------------------------------------------------------------------------
    registerSlot(slot, home);
    writeSlotConfig(slot);
    const config = mergePatch(readJson(path.join(ROOT, "src-tauri/tauri.hub.conf.json")), readJson(slot.configFile));
    const binary = path.join(ROOT, "target/debug/monocode");
    if (options.build) {
      log("building the dev copy (cargo build, shared cache) ...");
      const buildLog = fs.openSync(path.join(evidence, "build.log"), "w");
      const code = await new Promise((resolve) => {
        const child = spawn("cargo", ["build", "-p", "monocode"], {
          cwd: ROOT,
          stdio: ["ignore", buildLog, buildLog],
          env: { ...process.env, TAURI_CONFIG: JSON.stringify(config), CARGO_BUILD_BUILD_DIR: slot.buildDir },
        });
        children.push(child);
        child.on("exit", (exit) => resolve(exit ?? 1));
      });
      if (code !== 0) throw new Error("cargo build failed (build.log)");
    }
    const version = JSON.parse(execFileSync(binary, ["version", "--json"], { encoding: "utf8", env: { ...process.env, HOME: home } }));
    if (version.identifier !== slot.identifier || version.kind !== "dev")
      throw new Error(`the built copy is ${version.identifier} (${version.kind}), not ${slot.identifier}`);
    const stamp = `${version.stamp?.branch} @ ${String(version.stamp?.sha).slice(0, 7)}${version.stamp?.dirty ? "-dirty" : ""}`;
    log(`built ${version.identifier} at ${stamp}`);

    // -- vite ------------------------------------------------------------------------------------------------------------------
    const viteLog = fs.openSync(path.join(evidence, "vite.log"), "w");
    // --mode stable: no hot reload and no file watching, so a checkout moving under a run never reloads its window
    // mid-scene (21 Oct: a fast-forward during S10 reloaded the page, cut frank's turn and lost a drain).
    const vite = spawn(path.join(ROOT, "node_modules/.bin/vite"), ["--mode", "stable"], {
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
    if (!served) throw new Error(`vite never answered on port ${slot.port} (vite.log)`);
    // The test project (and any copies) go in the plan: the dev copy's local store starts with them (WP-04 retired the
    // Ash OS stub that used to list them).
    const benchProjects = [
      { id: spec.project.id, name: spec.project.name, folder: project },
      ...copies.filter((copy) => copy.id !== spec.project.id).map((copy) => ({ id: copy.id, name: copy.name, folder: copy.folder })),
    ];
    fs.writeFileSync(planFile, `${JSON.stringify({ ...plan, projects: benchProjects }, null, 2)}\n`);

    // Being built is the app's own: delegation rows live in the app since 21 Oct (src-tauri/src/delegations.rs, "No
    // mirror"), and the app lists them under the Mono that started them.

    // -- the app ------------------------------------------------------------------------------------------------------------------
    const appEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("TAURI_") && !key.startsWith("MONOCODE_") && !key.startsWith("REALTEST_") && key !== "CFFIXED_USER_HOME"),
    );
    const runTmp = privateTempDir({ HOME: home, REALTEST_REAL_HOME: REAL_HOME, TMPDIR: process.env.TMPDIR });
    if (runTmp) fs.mkdirSync(runTmp, { recursive: true });
    Object.assign(appEnv, {
      HOME: home,
      MONOCODE_NO_ALERT: "1",
      MONOCODE_HUB_BACKGROUND: "1",
      MONOCODE_VERIFY_LIVE: planFile,
      MONOCODE_DEV_APP_NAME: `${DEV_PRODUCT} ${slot.slot}`,
      ...BENCH_GIT_ENV,
      ...(runTmp ? { TMPDIR: runTmp, TMP: runTmp, TEMP: runTmp, CLAUDE_TMPDIR: runTmp } : {}),
    });
    // The run's own launch, and (r98, B5) its reopen after Ash's Quit: the same binary, HOME and data, in the background
    // (MONOCODE_HUB_BACKGROUND: an accessory app that never activates or comes forward, like `open -g`).
    let launches = 0;
    const launchApp = async () => {
      const before = app?.pid ?? null;
      const out = fs.openSync(path.join(evidence, launches++ ? `app-${launches}.log` : "app.log"), "w");
      const child = spawn(binary, [], { cwd: ROOT, env: appEnv, stdio: ["ignore", out, out] });
      children.push(child);
      const running = await until(() => {
        try {
          const record = JSON.parse(fs.readFileSync(path.join(dataDir, "running.json"), "utf8"));
          return record.pid && record.pid !== before && alive(record.pid) ? record : null;
        } catch {
          return null;
        }
      }, 120_000);
      if (!running) return { pid: null, why: "the app never wrote running.json (app.log)" };
      app = { pid: running.pid, child };
      log(`app pid ${running.pid}`);
      return { pid: running.pid };
    };
    const first = await launchApp();
    if (!first.pid) throw new Error(first.why);
    const restart = async ({ idleMs = 0 } = {}) => {
      const { quitThenReopen } = await import("./hub-realtest-scenarios.mjs");
      const front = () => spawnSync("lsappinfo", ["info", "-only", "pid", spawnSync("lsappinfo", ["front"], { encoding: "utf8" }).stdout.trim()], { encoding: "utf8" }).stdout;
      const result = await quitThenReopen({ act, pid: app.pid, alive, until, launch: launchApp, idleMs });
      // Read-only check that the reopened copy didn't take the front (it is an accessory app; this proves it).
      if (result.ok) result.front = new RegExp(`=\\s*${result.pid}\\b`).test(front()) ? "the reopened copy is in front" : "not in front";
      return result;
    };

    // -- the driver ---------------------------------------------------------------------------------------------------------------
    let seq = 0;
    const act = async (op, payload = {}, timeoutMs = 60_000) => {
      const actionId = `${String(++seq).padStart(5, "0")}-${op}`;
      const tmp = path.join(driver, "inbox", `.${actionId}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify({ id: actionId, op, ...payload }));
      fs.renameSync(tmp, path.join(driver, "inbox", `${actionId}.json`));
      const done = path.join(driver, "done", `${actionId}.json`);
      const answer = await until(() => {
        try {
          return JSON.parse(fs.readFileSync(done, "utf8"));
        } catch {
          return null;
        }
      }, timeoutMs, 200);
      if (!answer) throw Object.assign(new Error(`driver: no answer to ${actionId} in ${timeoutMs / 1000}s`), { actionId });
      return answer;
    };
    const events = [];
    const eventsFile = path.join(evidence, "events.ndjson");
    const take = (list) => {
      for (const event of list ?? []) {
        events.push(event);
        fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`);
      }
    };
    // A drain the window answered after we stopped waiting still holds events (21 Oct S10: the CoS report-back
    // and PM's reply in the room were in a late answer, so the scene was judged without them).
    const lateDrains = new Set();
    const takeLate = () => {
      for (const actionId of [...lateDrains]) {
        try {
          take(JSON.parse(fs.readFileSync(path.join(driver, "done", `${actionId}.json`), "utf8")).events);
          lateDrains.delete(actionId);
          log(`drain: ${actionId} answered late; its events are in`);
        } catch {
          // not answered yet
        }
      }
    };
    let pumping = null;
    const drainOnce = async () => {
      try {
        take((await act("drain", {}, 30_000)).events);
      } catch (error) {
        if (error.actionId) lateDrains.add(error.actionId);
        log(`drain: ${error.message}`);
      } finally {
        takeLate();
      }
    };
    // A timer tick skips a drain already running; a scene's own call waits for it and then drains once more, so what it
    // reads next is everything the window had by then.
    const pump = async ({ tick = false } = {}) => {
      if (pumping) {
        if (tick) return;
        await pumping;
      }
      pumping = drainOnce().finally(() => {
        pumping = null;
      });
      await pumping;
    };
    const pong = await act("ping", {}, 120_000).catch(() => null);
    if (!pong?.ok) throw new Error("the window never answered the driver (is verify_live_take registered? app.log)");
    log("the window's driver answers");
    pumpTimer = setInterval(() => {
      void pump({ tick: true });
      const now = usageOf(readNdjson(path.join(state, "usage.ndjson")));
      // Every account's newest reading and limit file: an account that runs out sits out, new Claude processes go to
      // the next one, and the run stops only when every account is out (E5, hub-realtest-accounts.mjs).
      const limitedNow = limitedFiles(state, accountList);
      const watched = watchAccounts(
        accountList,
        unmetered ? accountList.map(() => ({})) : latestReadings(readNdjson(path.join(state, "ratelimits.ndjson")), accountList.length),
        limitedNow,
        budget,
      );
      if (JSON.stringify(watched.list) !== JSON.stringify(accountList)) {
        accountList = watched.list;
        writeAccounts(state, accountList);
        for (const a of accountList.filter((x) => x.out)) log(`claude account ${a.n} is out: ${a.out}`);
        if (watched.moved) log(`new Claude chats now go to account ${watched.moved.to} (account ${watched.moved.from} is out)`);
      }
      const why =
        // A run on a custom model only needs Claude for helper calls: it stops on a refusal, not on a missing login.
        watched.stop && !(unmetered && !Object.keys(limitedNow).length) ? watched.stop
        : now.turns >= budget.maxTurns || now.requests >= budget.maxRequests ? `budget spent: ${now.turns} turns, ${now.requests} requests`
        : Date.now() > deadline ? "time budget spent" : null;
      if (why && !fs.existsSync(path.join(state, "stop")) && !isHardStop(stopReason)) {
        fs.writeFileSync(path.join(state, "stop"), `${why}\n`);
        stopReason = why;
        log(`STOP: ${why}: the claude wrapper now refuses new turns and the remaining scenarios are skipped`);
      }
    }, 1_500);

    // Ready: the project's Lead exists and its leadership room has the team (a fresh copy seats nobody until this).
    const { ready, team, leadId, roomId } = await waitForSeatedRoom({ act, log, spec, beforeReady: hooks.beforeReady });
    fs.writeFileSync(path.join(evidence, "snapshot-ready.json"), JSON.stringify(ready, null, 2));
    log(`ready: ${leadId}; room ${roomId} seats ${ready.rooms.find((r) => r.id === roomId).memberIds.join(", ")}`);
    await act("defaults", { model: spec.appModel ?? "claude:sonnet-5", effort: spec.effort ?? "medium" });
    // r91: the fresh copy is set up like Ash's own app, which knows him by name, so the Leads write "Needs Ash:".
    const named = await act("userName", { name: spec.ownerName ?? "Ash" }).catch((error) => ({ ok: false, error: error.message }));
    log(`owner name: ${named.ok ? named.name : `NOT SET (${named.error ?? "refused"})`}`);

    // -- helpers the scenarios use ------------------------------------------------------------------------------------------------
    const usageEntries = () => readNdjson(path.join(state, "usage.ndjson"));
    const usage = (since = 0) => usageOf(usageEntries(), since);
    const monoSession = async (monoId) => {
      const snap = await act("snapshot");
      return snap.monos?.find((mono) => mono.id === monoId)?.sessionId ?? null;
    };
    const delegationRows = () =>
      query(
        db,
        "SELECT id, owner_session, owner_mono, parent_id, root_id, child_session, project, title, brief, goal, state, error_class, error, result, pending_question, delivery, follow, stall_kind, stall_reason, created_at, updated_at, settled_at FROM delegations ORDER BY created_at",
      );
    const sessionBlocks = async (sessionId) => {
      const rows = await query(db, "SELECT block_json FROM mono_blocks WHERE session_id = ? ORDER BY seq", sessionId);
      if (rows.length) return rows.map((row) => JSON.parse(row.block_json));
      const own = (await query(db, "SELECT blocks_json FROM sessions WHERE id = ?", sessionId))[0]?.blocks_json;
      try {
        return own ? JSON.parse(own) : [];
      } catch {
        return [];
      }
    };
    const providerOf = async () =>
      Object.fromEntries((await query(db, "SELECT id, provider_session_id AS p FROM sessions WHERE provider_session_id IS NOT NULL")).map((row) => [row.p, row.id]));
    /** Every assistant text line Claude wrote, with its time and app session (from the wrapper's logs). */
    const claudeTexts = async (since = 0) => {
      const providers = await providerOf();
      const out = [];
      const logs = path.join(state, "claude");
      for (const name of fs.existsSync(logs) ? fs.readdirSync(logs).filter((n) => n.endsWith(".ndjson")) : []) {
        let provider = null;
        let cwd = null;
        let hidden = null;
        for (const entry of readNdjson(path.join(state, "claude", name))) {
          if (entry.dir === "start") cwd = entry.cwd;
          if (entry.dir === "prompt") hidden = entry.hidden ?? null;
          if (entry.dir !== "out" && entry.dir !== "fault-out") continue;
          let message;
          try {
            message = JSON.parse(entry.line);
          } catch {
            continue;
          }
          if (message.session_id) provider = message.session_id;
          if (entry.t < since) continue;
          if (message.type === "assistant") {
            const text = (message.message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
            const toolUses = (message.message?.content ?? []).filter((part) => part.type === "tool_use").map((part) =>
              // What a chat asks Ash (or its Lead) is part of what it says.
              part.name === "AskUserQuestion"
                ? `AskUserQuestion: ${(part.input?.questions ?? []).map((q) => `${q.question} [${(q.options ?? []).map((o) => o.label).join(" / ")}]`).join(" ; ")}`.slice(0, 600)
                : part.name === "Bash"
                  ? `Bash: ${String(part.input?.command ?? "")}`.slice(0, 600) // the command, so a held Allow card can be checked
                  : part.name,
            );
            if (text || toolUses.length) out.push({ t: entry.t, pid: name.replace(".ndjson", ""), provider, session: providers[provider] ?? null, cwd, text, tools: toolUses, ...(hidden ? { hidden } : {}) });
          } else if (message.type === "result") out.push({ t: entry.t, pid: name.replace(".ndjson", ""), provider, session: providers[provider] ?? null, cwd, result: true, isError: !!message.is_error, text: String(message.result ?? "").slice(0, 400) });
        }
      }
      return out.sort((a, b) => a.t - b.t);
    };

    // r83 (Critiquito 7): no two shots may be the same picture; a repeat (a locked screen, a window that didn't draw)
    // is reported as a failed shot, never passed off as a new one.
    const shotHashes = new Map();
    const screenshot = async (name) => {
      const file = path.join(evidence, "screens", `${name}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const windows = listWindows(scratch).filter((w) => w.pid === app.pid);
      const window = windows.sort((a, b) => b.area - a.area)[0];
      if (!window) return { ok: false, why: `no window for pid ${app.pid} (${windows.length} listed; the screen may be locked or the copy is an accessory app off-screen)` };
      // r90: a window that isn't on screen (Ash's own apps in front, another Space) captures blank; say so, keep no file.
      // r98 (Critiquito): a covered or off-screen window is still tried by its id (-l), never raised or resized; a
      // capture that comes out blank (a near-empty file) is reported and deleted, never passed off as a shot.
      const shot = spawnSync("screencapture", ["-x", "-o", "-l", String(window.id), file], { encoding: "utf8" });
      if (shot.status !== 0 || !fs.existsSync(file) || fs.statSync(file).size < 2000) {
        fs.rmSync(file, { force: true });
        return { ok: false, why: window.onscreen ? `screencapture failed (${shot.status}): ${(shot.stderr || "").trim().slice(0, 200)}` : "the hub's window is not on screen and its capture came out blank; nothing was brought forward" };
      }
      // r90 (Ash on the Mac): only the hub's own window is captured, never the whole screen (r83's banner check is answered).
      const screen = null;
      const hash = crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
      const same = shotHashes.get(hash);
      shotHashes.set(hash, shotHashes.get(hash) ?? name);
      if (same) return { ok: false, why: `same picture as ${same} (the screen may be locked or the window didn't redraw)`, file: path.relative(evidence, file), screen };
      return { ok: true, file: path.relative(evidence, file), screen, window: { id: window.id, onscreen: window.onscreen } };
    };

    const memoryCalls = () => readNdjson(path.join(state, "memory-calls.ndjson"));
    // A Mono's memory as the app keeps it: MEMORY.md, topic notes, and its long chat's logs (memory/tree/), for the
    // memory-guard checks (scripts/realconv/checks.mjs).
    const monoFiles = (mono) => {
      const dir = path.join(dataDir, "monos", mono);
      const text = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
      const list = (folder) => (fs.existsSync(folder) ? fs.readdirSync(folder).sort() : []);
      const records = (folder) =>
        list(folder).flatMap((name) => text(path.join(folder, name)).split("\n").filter(Boolean).flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        }));
      return {
        memory: text(path.join(dir, "MEMORY.md")),
        topics: list(path.join(dir, "memory")).filter((name) => name.endsWith(".md")).map((name) => ({ name, text: text(path.join(dir, "memory", name)) })),
        tree: fs.existsSync(path.join(dir, "memory/tree")) ? { messages: records(path.join(dir, "memory/tree/main")), nodes: records(path.join(dir, "memory/tree/tree")) } : null,
      };
    };
    const stopRun = (why) => {
      const text = String(why ?? "").trim();
      if (!text || isHardStop(stopReason)) return;
      stopReason = text;
      try {
        fs.writeFileSync(path.join(state, "stop"), `${text}\n`);
      } catch {
        // the run folder went away
      }
    };
    const listApps = () => {
      try {
        return appsFromPs(execFileSync("ps", ["-ax", "-ww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }), REAL_HOME);
      } catch {
        return null;
      }
    };
    const listAgents = () => {
      try {
        return execFileSync("ps", ["-axeww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      } catch {
        return null;
      }
    };
    const agentWatch = () => ({ rootPid: app?.pid ?? null, profile: path.join(state, "sandbox.sb"), wrapper: claude });
    const ctx = { runStarted: started, restart, memoryCalls, monoFiles, act, events, usage, monoSession, delegationRows, sessionBlocks, claudeTexts, screenshot, log, evidence, state, leadId, roomId, team, project, home, copies, spec, deadline, budget, pump, dataDir, appGate: !!options.appGate, stopRun, listApps, listAgents, agentWatch, readDummy: () => readDummy(state), realHome: REAL_HOME, allowed: allowedRoots };

    // -- the scenarios ------------------------------------------------------------------------------------------------------------
    const { runScenario } = await import("./hub-realtest-scenarios.mjs");
    if (hooks.afterReady) await hooks.afterReady(ctx);
    if (hooks.play) {
      results = await hooks.play(ctx, { runScenario, stopped: () => stopReason });
      fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify(results, null, 2));
    }
    for (const scenario of scenarios) {
      if (stopReason && (scenario.since !== "run" || isHardStop(stopReason))) {
        results.push({ id: scenario.id, title: scenario.title, skipped: stopReason });
        continue;
      }
      const spent = usage();
      if ((spent.turns >= budget.maxTurns || spent.requests >= budget.maxRequests) && scenario.since !== "run") {
        log(`budget spent (${spent.turns} turns): skipping ${scenario.id} and the rest`);
        results.push({ id: scenario.id, title: scenario.title, skipped: `budget spent (${spent.turns} turns)` });
        continue;
      }
      if (Date.now() > deadline && scenario.since !== "run") {
        log(`time budget spent: skipping ${scenario.id} and the rest`);
        results.push({ id: scenario.id, title: scenario.title, skipped: "time budget spent" });
        continue;
      }
      log(`== ${scenario.id}: ${scenario.title}`);
      try {
        results.push(await runScenario(scenario, ctx));
      } catch (error) {
        log(`${scenario.id} failed to run: ${error.stack ?? error.message}`);
        results.push({ id: scenario.id, title: scenario.title, error: error.message });
      }
      fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify(results, null, 2));
      if ((usage().turns >= budget.maxTurns || usage().requests >= budget.maxRequests) && !isHardStop(stopReason)) fs.writeFileSync(path.join(state, "stop"), "budget spent\n");
    }

    // -- the end ------------------------------------------------------------------------------------------------------------------
    await pump();
    const finalSnap = await act("snapshot").catch(() => null);
    if (finalSnap) fs.writeFileSync(path.join(evidence, "snapshot-final.json"), JSON.stringify(finalSnap, null, 2));
    const total = usage();
    // Every account that was signed in at the start is read again (one tiny Haiku call each).
    const afterAll = accountList.map((a) => (a.reading?.loggedIn ? { n: a.n, config: a.config, ...accountUse(home, a.config) } : { n: a.n, config: a.config, loggedIn: false }));
    const after = { ...(afterAll[0] ?? accountUse(home)), accounts: afterAll };
    fs.writeFileSync(path.join(evidence, "account-after.json"), JSON.stringify(after, null, 2));
    for (const a of afterAll) log(`account ${a.n} use after: 5-hour ${pctOf(a.fiveHour)}, 7-day ${pctOf(a.sevenDay)}`);
    const summary = { runId: id, stopReason, account: { before: JSON.parse(fs.readFileSync(path.join(evidence, "account-before.json"), "utf8")), after }, build: stamp, slot: slot.slot, started: iso(started), ended: iso(Date.now()), wallMinutes: secs(Date.now() - started) / 60, usage: total, budget, results };
    fs.writeFileSync(path.join(evidence, "summary.json"), JSON.stringify(summary, null, 2));
    log(`done: ${total.turns} turns, ${total.requests} model requests, ${Math.round((Date.now() - started) / 60000)} min`);
  } finally {
    await ending.finish();
    ending.dispose();
  }
  if (options.grade && !hooks.play) {
    const { gradeRun } = await import("./hub-realtest-grade.mjs");
    await gradeRun(evidence, { claudeConfig: DEV_CLAUDE_CONFIG, ...graderVia(options) });
  }
  return { id, evidence, results, stopReason };
}

const pctOf = (value) => (value == null ? "?" : `${Math.round(value * 100)}%`);

/**
 * The shared account's use right now, from one tiny Haiku call's rate_limit_event (the CLI prints one per call):
 * {status, fiveHour, sevenDay} as fractions, null when the CLI didn't say.
 */
export function accountUse(home, config = DEV_CLAUDE_CONFIG) {
  const run = spawnSync(
    path.join(REAL_HOME, ".local/bin/claude"),
    ["-p", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "user", "--no-session-persistence", "reply with the word ok"],
    {
      encoding: "utf8",
      timeout: 90_000,
      cwd: home,
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: "1" },
    },
  );
  const out = { at: new Date().toISOString(), status: null, fiveHour: null, sevenDay: null };
  for (const line of String(run.stdout ?? "").split("\n")) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.type !== "rate_limit_event") continue;
    const info = message.rate_limit_info ?? {};
    out.status = info.status ?? out.status;
    out.fiveHour = info.unifiedWindows?.five_hour?.utilization ?? (info.rateLimitType === "five_hour" ? info.utilization : out.fiveHour);
    out.sevenDay = info.unifiedWindows?.seven_day?.utilization ?? (info.rateLimitType === "seven_day" ? info.utilization : out.sevenDay);
  }
  return out;
}

/** On-screen and off-screen windows (CGWindowList), via a tiny Swift script; [] when it can't run. */
export function listWindows(scratch) {
  const script = path.join(scratch, "windows.swift");
  if (!fs.existsSync(script))
    fs.writeFileSync(
      script,
      `import CoreGraphics
import Foundation
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
var out: [[String: Any]] = []
for w in list {
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  out.append(["id": w[kCGWindowNumber as String] ?? 0, "pid": w[kCGWindowOwnerPID as String] ?? 0, "name": w[kCGWindowName as String] ?? "", "owner": w[kCGWindowOwnerName as String] ?? "", "onscreen": w[kCGWindowIsOnscreen as String] ?? false, "w": b["Width"] ?? 0, "h": b["Height"] ?? 0, "layer": w[kCGWindowLayer as String] ?? 0])
}
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
`,
    );
  const run = spawnSync("swift", [script], { encoding: "utf8", timeout: 60_000 });
  try {
    return JSON.parse(run.stdout)
      .filter((w) => w.layer === 0 && w.w > 200 && w.h > 200)
      .map((w) => ({ ...w, area: w.w * w.h }));
  } catch {
    return [];
  }
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => process.exit(code ?? 0),
    (error) => {
      console.error(`hub:realtest: ${error.stack ?? error.message}`);
      process.exit(1);
    },
  );
}
