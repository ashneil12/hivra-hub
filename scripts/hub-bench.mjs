// The cross-app benchmark (board I7): real asks from Ash's ledger, kept as a workspace each, replayed and scored
// against what he actually asked for.
//
// The asks live in verify/benchmark/sample.json with the ledger row they came from and his words verbatim, a fixture
// workspace, and an acceptance script. Each ask also has recorded attempts in verify/benchmark/attempts: `good` is a
// real answer to the ask and must PASS; every other attempt (a shortcut, an answer that pushes anyway) must FAIL.
//
// The check mode is the point: it runs the recorded attempts and nothing else, so it costs no agent and proves the
// acceptance scripts still tell a good answer from a shortcut. The replay mode is the benchmark itself: it copies a
// fixture, hands ASK.md to an agent in it, and scores what the agent left behind. It only runs when a driver is named,
// so a benchmark that cannot reach an agent is never silently reported as a pass.
//
// Verdicts come from the acceptance scripts and nowhere else: one JSON line, `{outcome, detail}`, exit 0 passed,
// 1 failed, 2 could not be exercised. The runner refuses a verdict whose exit code disagrees with it, and a replay
// whose agent did not run (not installed, timed out) is "couldn't be exercised", never a failure or a pass.
//
// Every run is appended to ~/.monocode-hub-verify/bench.jsonl (or $MONOCODE_BENCH_DIR/bench.jsonl), and an ask that
// passed in the previous run of the same kind and does not pass now is reported as a regression.
//
//   node scripts/hub-bench.mjs                      # the self-check: recorded attempts still score as they must
//   node scripts/hub-bench.mjs --json               # the same, machine-readable
//   node scripts/hub-bench.mjs --list               # the asks, their ledger rows and Ash's words
//   node scripts/hub-bench.mjs --trend              # the recorded runs, oldest first
//   node scripts/hub-bench.mjs --print-schedule     # the weekly launchd job, to stdout
//   node scripts/hub-bench.mjs --install-schedule   # write that job to ~/Library/LaunchAgents (does not load it)
//   node scripts/hub-bench.mjs --replay --driver claude        # the benchmark: every ask, a real agent
//   node scripts/hub-bench.mjs --replay --driver claude --ask no-killing
//   node scripts/hub-bench.mjs --replay --driver 'my-agent {workspace} --ask {ask}'
//
// Exit codes: 0 passed, 1 failed (or regressed), 2 could not exercise.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BENCH_ROOT = path.resolve(HERE, "../verify/benchmark");

export const OUTCOMES = ["passed", "failed", "couldNotExercise"];

const WORD = { passed: "passed", failed: "failed", couldNotExercise: "couldn't be exercised" };
const EXIT = { passed: 0, failed: 1, couldNotExercise: 2 };

export function historyFile() {
  const dir = process.env.MONOCODE_BENCH_DIR || path.join(os.homedir(), ".monocode-hub-verify");
  return path.join(dir, "bench.jsonl");
}

// ---------------------------------------------------------------- the sample

export function readSample(root = BENCH_ROOT) {
  const file = path.join(root, "sample.json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  if (data.version !== 1) throw new Error(`${file}: unsupported version ${JSON.stringify(data.version)}`);
  if (!Array.isArray(data.asks) || data.asks.length === 0) throw new Error(`${file}: no asks`);

  const seen = new Set();
  for (const entry of data.asks) {
    for (const field of ["id", "app", "fixture", "accept"]) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) {
        throw new Error(`${file}: an ask is missing "${field}"`);
      }
    }
    if (seen.has(entry.id)) throw new Error(`${file}: two asks are called ${entry.id}`);
    seen.add(entry.id);

    // Provenance is not decoration: a scenario that cannot point at the row Ash said it in has no place in a
    // benchmark of his asks.
    if (typeof entry.ledger?.ask !== "string" || !/^a_[0-9a-f]+$/.test(entry.ledger.ask)) {
      throw new Error(`${file}: ${entry.id} does not name the ledger row it came from (ledger.ask)`);
    }
    if (typeof entry.ledger?.quote !== "string" || !entry.ledger.quote.trim()) {
      throw new Error(`${file}: ${entry.id} has no words of Ash's to score against (ledger.quote)`);
    }
    if (!Array.isArray(entry.wanted) || entry.wanted.length === 0) {
      throw new Error(`${file}: ${entry.id} does not say what Ash wanted`);
    }
    for (const field of ["fixture", "accept"]) {
      if (!fs.existsSync(path.join(root, entry[field]))) {
        throw new Error(`${file}: ${entry.id} names a file that does not exist: ${entry[field]}`);
      }
    }
    if (entry.setup && !fs.existsSync(path.join(root, entry.setup))) {
      throw new Error(`${file}: ${entry.id} names a setup that does not exist: ${entry.setup}`);
    }
    if (!fs.existsSync(path.join(root, entry.fixture, "ASK.md"))) {
      throw new Error(`${file}: ${entry.id} has no ASK.md to hand an agent`);
    }
    if (typeof entry.timeoutSeconds !== "undefined" && !(entry.timeoutSeconds > 0)) {
      throw new Error(`${file}: ${entry.id} has a timeout that is not a number of seconds`);
    }

    const attempts = attemptsOf(root, entry);
    if (!attempts.includes("good")) throw new Error(`${file}: ${entry.id} has no recorded good attempt`);
    if (attempts.length < 2) {
      throw new Error(`${file}: ${entry.id} has no recorded shortcut, so nothing shows its check bites`);
    }
  }
  return data;
}

export function attemptsOf(root, entry) {
  const dir = path.join(root, "attempts", entry.id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort((a, b) => (a === "good" ? -1 : b === "good" ? 1 : a.localeCompare(b)));
}

// ---------------------------------------------------------------- workspaces

/// A throwaway copy of the fixture, prepared and then, for the self-check, with one recorded attempt applied over it.
/// An attempt is files, plus an optional `apply.mjs` for a failure that is an action rather than a diff (pushing);
/// the action runs from the attempt folder, never copied into the workspace.
export function buildWorkspace(root, entry, attempt = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${entry.id}-`));
  const work = path.join(dir, "work");
  fs.cpSync(path.join(root, entry.fixture), work, { recursive: true });
  const unavailable = (detail) => {
    fs.rmSync(dir, { recursive: true, force: true });
    return { dir: null, work: null, unavailable: detail };
  };

  if (entry.setup) {
    const setup = spawnSync(process.execPath, [path.join(root, entry.setup)], {
      cwd: work,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (setup.status !== 0) {
      return unavailable(`the workspace could not be prepared: ${(setup.stderr || setup.stdout || "it did not finish").trim().slice(-300)}`);
    }
  }

  if (attempt) {
    const from = path.join(root, "attempts", entry.id, attempt);
    for (const item of fs.readdirSync(from)) {
      if (item === "apply.mjs") continue;
      fs.cpSync(path.join(from, item), path.join(work, item), { recursive: true });
    }
    if (fs.existsSync(path.join(from, "apply.mjs"))) {
      const applied = spawnSync(process.execPath, [path.join(from, "apply.mjs")], {
        cwd: work,
        encoding: "utf8",
        timeout: 120_000,
      });
      if (applied.status !== 0) {
        return unavailable(`the recorded attempt's action did not run: ${(applied.stderr || applied.stdout || "it did not finish").trim().slice(-300)}`);
      }
    }
  }

  return { dir, work, unavailable: null };
}

// ---------------------------------------------------------------- verdicts

/// The one JSON line an acceptance script prints, checked against its exit code. Anything else, including a missing
/// verdict or a disagreement between the two, is "could not exercise": never a pass, never a failure of the work.
export function loadVerdict(stdout, status) {
  const lines = String(stdout ?? "").trim().split("\n").reverse();
  for (const line of lines) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || typeof value.outcome !== "string") continue;
    if (!OUTCOMES.includes(value.outcome)) {
      return { outcome: "couldNotExercise", detail: `the check reported an outcome nobody knows: ${value.outcome}` };
    }
    if (status !== EXIT[value.outcome]) {
      const exited = status === null ? "with no exit code" : `with exit ${status}`;
      return { outcome: "couldNotExercise", detail: `the check said ${value.outcome} but finished ${exited}` };
    }
    return { outcome: value.outcome, detail: typeof value.detail === "string" ? value.detail : "" };
  }
  const exited = status === null ? "it did not finish" : `exit ${status}`;
  return { outcome: "couldNotExercise", detail: `the check printed no verdict (${exited})` };
}

export function runAcceptance(root, entry, target) {
  const accept = path.join(root, entry.accept);
  const fixture = path.join(root, entry.fixture);
  const started = Date.now();
  const result = spawnSync(process.execPath, [accept, "--target", target, "--fixture", fixture], {
    cwd: target,
    encoding: "utf8",
    timeout: (entry.timeoutSeconds ?? 180) * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (result.error?.code === "ETIMEDOUT") {
    return { outcome: "couldNotExercise", detail: `the check did not finish within ${entry.timeoutSeconds ?? 180} s`, seconds };
  }
  return { ...loadVerdict(result.stdout, result.status), seconds };
}

// ---------------------------------------------------------------- the self-check

/// One ask's recorded attempts: `good` must pass and every other attempt must fail. An attempt that could not be
/// built or run leaves the ask "not proven"; an attempt that lands on the wrong side means the check no longer tells
/// a good answer from a shortcut, which fails the ask.
export function checkEntry(root, entry) {
  const runs = [];
  for (const name of attemptsOf(root, entry)) {
    const expected = name === "good" ? "passed" : "failed";
    const built = buildWorkspace(root, entry, name);
    if (built.unavailable) {
      runs.push({ state: name, expected, outcome: "couldNotExercise", detail: built.unavailable, seconds: 0 });
      continue;
    }
    try {
      runs.push({ state: name, expected, ...runAcceptance(root, entry, built.work) });
    } finally {
      fs.rmSync(built.dir, { recursive: true, force: true });
    }
  }

  const wrong = runs.filter((run) => run.outcome !== run.expected && run.outcome !== "couldNotExercise");
  const unproven = runs.filter((run) => run.outcome === "couldNotExercise");
  let verdict;
  let detail;
  if (wrong.length) {
    verdict = "failed";
    detail = wrong
      .map((run) => `${run.state}: expected ${run.expected}, got ${run.outcome}${run.detail ? ` (${run.detail})` : ""}`)
      .join("; ");
  } else if (unproven.length) {
    verdict = "couldNotExercise";
    detail = unproven.map((run) => `${run.state}: ${run.detail}`).join("; ");
  } else {
    verdict = "passed";
    const good = runs.find((run) => run.state === "good");
    const shortcuts = runs.filter((run) => run.state !== "good").length;
    detail = `the good answer passed and ${shortcuts} shortcut${shortcuts === 1 ? "" : "s"} failed (${good?.detail ?? "checked"})`;
  }
  return { id: entry.id, app: entry.app, verdict, detail, runs };
}

export function runCheck(root = BENCH_ROOT, only = null) {
  const sample = readSample(root);
  const started = Date.now();
  const cases = sample.asks.filter((entry) => !only || entry.id === only).map((entry) => checkEntry(root, entry));
  return { verdict: aggregate(cases), cases, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

export function aggregate(cases) {
  if (cases.some((entry) => entry.verdict === "failed")) return "failed";
  if (cases.some((entry) => entry.verdict === "couldNotExercise")) return "couldNotExercise";
  return "passed";
}

// ---------------------------------------------------------------- the replay

const shellQuote = (text) => `'${String(text).replaceAll("'", `'\\''`)}'`;

/// What runs the agent. `claude` is the Claude Code CLI in print mode; any other driver is a shell command with
/// `{ask}` and `{workspace}` filled in. A driver that names neither placeholder is a mistake, not a driver.
export function driverFor(spec) {
  if (!spec) return null;
  if (spec === "claude") return (ask) => ({ command: "claude", args: ["-p", ask, "--permission-mode", "acceptEdits"] });
  if (!spec.includes("{ask}") || !spec.includes("{workspace}")) return null;
  return (ask, workspace) => ({
    command: "/bin/sh",
    args: ["-c", spec.replaceAll("{ask}", shellQuote(ask)).replaceAll("{workspace}", shellQuote(workspace))],
  });
}

/// One ask, played for real: the fixture is copied, ASK.md is handed to the driver in it, the driver's reply is kept
/// as ANSWER.md when the agent did not write one itself, and the acceptance script scores what is left.
export function replayEntry(root, entry, { driver, driveSeconds = 900 }) {
  const built = buildWorkspace(root, entry, null);
  if (built.unavailable) return { id: entry.id, app: entry.app, verdict: "couldNotExercise", detail: built.unavailable };

  try {
    const ask = fs.readFileSync(path.join(root, entry.fixture, "ASK.md"), "utf8");
    const run = driver(ask, built.work);
    const started = Date.now();
    const result = spawnSync(run.command, run.args, {
      cwd: built.work,
      encoding: "utf8",
      timeout: driveSeconds * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const drive = Math.round((Date.now() - started) / 100) / 10;

    if (result.error?.code === "ENOENT") {
      return { id: entry.id, app: entry.app, verdict: "couldNotExercise", detail: `the agent (${run.command}) is not installed here`, drive };
    }
    // An agent that never started is not an answer that failed: the CLI can exit non-zero both when it crashes and
    // when it declines to start (claude -p exits 1 with "Not logged in · Please run /login" on stdout), and an ask
    // scored from that output would read as "Ash's question went unanswered" when nothing was ever tried.
    const said = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const firstLine = said.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
    if (/not logged in|please run \/login/i.test(said)) {
      return { id: entry.id, app: entry.app, verdict: "couldNotExercise", detail: `the agent is not logged in: ${firstLine}`, drive };
    }
    if (result.status !== 0) {
      return {
        id: entry.id,
        app: entry.app,
        verdict: "couldNotExercise",
        detail: `the agent did not finish (exit ${result.status}): ${firstLine || "no output"}`,
        drive,
      };
    }
    if (result.error?.code === "ETIMEDOUT") {
      return {
        id: entry.id,
        app: entry.app,
        verdict: "couldNotExercise",
        detail: `the agent did not finish within ${driveSeconds} s, so there is no finished attempt to score`,
        drive,
      };
    }

    const reply = path.join(built.work, "ANSWER.md");
    if (!fs.existsSync(reply) && (result.stdout ?? "").trim()) fs.writeFileSync(reply, result.stdout);

    const scored = runAcceptance(root, entry, built.work);
    return { id: entry.id, app: entry.app, verdict: scored.outcome, detail: scored.detail, seconds: scored.seconds, drive };
  } finally {
    fs.rmSync(built.dir, { recursive: true, force: true });
  }
}

export function runReplay(root = BENCH_ROOT, { driver, only = null, driveSeconds = 900 } = {}) {
  if (!driver) throw new Error("a replay needs a driver: --driver claude or a command with {ask} and {workspace}");
  const sample = readSample(root);
  const started = Date.now();
  const cases = sample.asks
    .filter((entry) => !only || entry.id === only)
    .map((entry) => replayEntry(root, entry, { driver, driveSeconds }));
  return { verdict: aggregate(cases), cases, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

// ---------------------------------------------------------------- history

export function readHistory(file = historyFile()) {
  if (!fs.existsSync(file)) return [];
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
}

export function appendHistory(line, file = historyFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  return file;
}

export function previousRun(entries, mode) {
  return [...entries].reverse().find((line) => line.mode === mode && Array.isArray(line.cases)) ?? null;
}

/// An ask that passed the previous time and does not pass now, compared with the previous run of the same kind: a
/// check run is compared with the last check run and a replay with the last replay, so the two never mask each other.
export function regressions(previous, cases) {
  if (!previous) return [];
  const before = new Map((previous.cases ?? []).map((entry) => [entry.id, entry.verdict]));
  return cases
    .filter((entry) => before.get(entry.id) === "passed" && entry.verdict !== "passed")
    .map((entry) => ({ id: entry.id, app: entry.app, was: "passed", now: entry.verdict, detail: entry.detail }));
}

export function record(result, { mode, file = historyFile(), extra = {} } = {}) {
  const regressed = regressions(previousRun(readHistory(file), mode), result.cases);
  appendHistory(
    {
      at: new Date().toISOString(),
      mode,
      verdict: result.verdict,
      seconds: result.seconds,
      cases: result.cases.map((entry) => ({
        id: entry.id,
        app: entry.app,
        verdict: entry.verdict,
        detail: entry.detail,
      })),
      regressed: regressed.map((entry) => entry.id),
      ...extra,
    },
    file,
  );
  return { ...result, regressed, history: file };
}

// ---------------------------------------------------------------- the schedule

const xml = (text) =>
  String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/// The weekly job, as text. It runs the replay, not the self-check: a schedule that only re-ran the recorded attempts
/// would record the same line every week and say nothing about the hub.
export function schedule({ driver = "claude", checkout = path.resolve(HERE, "..") } = {}) {
  const label = "com.ash.monocode-hub.bench";
  const home = os.homedir();
  const file = path.join(home, "Library/LaunchAgents", `${label}.plist`);
  const log = path.join(home, "Library/Logs/monocode-hub-bench.log");
  const args = [process.execPath, path.join(HERE, "hub-bench.mjs"), "--replay", "--driver", driver, "--json"];
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args.map((arg) => `    <string>${xml(arg)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(checkout)}</string>`,
    "  <key>StartCalendarInterval</key>",
    "  <dict>",
    "    <key>Weekday</key>",
    "    <integer>0</integer>",
    "    <key>Hour</key>",
    "    <integer>3</integer>",
    "    <key>Minute</key>",
    "    <integer>30</integer>",
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <false/>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(log)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  return { label, file, plist, load: `launchctl bootstrap gui/$(id -u) "${file}"` };
}

/// Writes the schedule file once. It is never loaded from here: starting a weekly job on Ash's Mac is his call, and
/// the command to do it is printed instead.
export function installSchedule(options = {}) {
  const made = schedule(options);
  if (fs.existsSync(made.file)) return { ...made, written: false, reason: "it is already there" };
  fs.mkdirSync(path.dirname(made.file), { recursive: true });
  fs.writeFileSync(made.file, made.plist);
  return { ...made, written: true, reason: "" };
}

// ---------------------------------------------------------------- command line

function usage() {
  return [
    "usage: node scripts/hub-bench.mjs [--json | --list | --trend | --print-schedule | --install-schedule]",
    "       node scripts/hub-bench.mjs --replay --driver claude [--ask <id>] [--timeout <seconds>] [--json]",
    "       node scripts/hub-bench.mjs --replay --driver 'agent {workspace} {ask}'",
    "",
    "  (no arguments)    prove the checks bite: the recorded good attempt must pass, every shortcut must fail",
    "  --list            the asks, the ledger rows they came from and Ash's words",
    "  --trend           every recorded run, oldest first",
    "  --print-schedule  the weekly job that replays the benchmark, as a launchd plist on stdout",
    "  --install-schedule  write that job to ~/Library/LaunchAgents (it is not loaded)",
    "  --replay          replay the asks with an agent and score what it left behind (needs --driver)",
    "  --ask <id>        only that ask",
    "  --timeout <s>     how long one agent run may take (default 900)",
    "  --json            the verdict as JSON on stdout",
    "",
    "exit codes: 0 passed, 1 failed, 2 could not exercise",
  ].join("\n");
}

function value(argv, flag) {
  const at = argv.indexOf(flag);
  return at === -1 ? null : argv[at + 1] ?? null;
}

function reportTrend(file = historyFile()) {
  const runs = readHistory(file);
  if (!runs.length) {
    console.log(`No runs recorded yet at ${file}.`);
    return 0;
  }
  console.log(`Benchmark trend (${runs.length} runs, ${file})`);
  for (const run of runs.slice(-20)) {
    const when = String(run.at ?? "").replace("T", " ").slice(0, 16);
    const asks = (run.cases ?? []).map((entry) => `${entry.id} ${entry.verdict}`).join(" · ");
    const regressed = run.regressed?.length ? `  (regressed: ${run.regressed.join(", ")})` : "";
    console.log(`  ${when}  ${String(run.mode).padEnd(6)}  ${WORD[run.verdict] ?? run.verdict}${regressed}`);
    if (asks) console.log(`    ${asks}`);
  }
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  const root = BENCH_ROOT;
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }

  if (argv.includes("--list")) {
    for (const entry of readSample(root).asks) {
      console.log(`${entry.id}\t${entry.app}\t${entry.ledger.ask}\t${entry.ledger.quote}`);
    }
    return 0;
  }

  if (argv.includes("--trend")) return reportTrend();

  if (argv.includes("--print-schedule")) {
    const made = schedule();
    process.stdout.write(made.plist);
    console.error(`To start it after Ash's call: ${made.load}`);
    return 0;
  }

  if (argv.includes("--install-schedule")) {
    const made = installSchedule();
    if (!made.written) {
      console.log(`The schedule is already at ${made.file}; nothing was changed.`);
      return 0;
    }
    console.log(`Wrote ${made.file}. It is not loaded. To load it: ${made.load}`);
    return 0;
  }

  const only = value(argv, "--ask");
  if (only && !readSample(root).asks.some((entry) => entry.id === only)) {
    console.error(`no ask is called ${only}`);
    return 64;
  }

  const replaying = argv.includes("--replay");
  const mode = replaying ? "replay" : "check";
  const driverSpec = value(argv, "--driver");
  let driver = null;
  if (replaying) {
    driver = driverFor(driverSpec);
    if (!driver) {
      console.error(
        driverSpec
          ? `--driver "${driverSpec}" is not a driver: use claude, or a command with {ask} and {workspace}`
          : "a replay needs an agent: --driver claude, or a command with {ask} and {workspace}",
      );
      return 64;
    }
  }

  const driveSeconds = Number(value(argv, "--timeout") ?? 900);
  if (!(driveSeconds > 0)) {
    console.error("--timeout must be a number of seconds");
    return 64;
  }

  const result = replaying
    ? record(runReplay(root, { driver, only, driveSeconds }), { mode })
    : record(runCheck(root, only), { mode });

  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          mode,
          verdict: result.verdict,
          cases: result.cases.map(({ id, app, verdict, detail, runs, seconds, drive }) => ({ id, app, verdict, detail, runs, seconds, drive })),
          regressed: result.regressed,
          seconds: result.seconds,
          history: result.history,
        },
        null,
        2,
      ),
    );
    return EXIT[result.verdict];
  }

  console.log(`${mode === "replay" ? "Benchmark replay" : "Benchmark check"}: ${WORD[result.verdict]}`);
  for (const entry of result.cases) {
    console.log(`  ${entry.id.padEnd(14)} ${WORD[entry.verdict].padEnd(21)} ${entry.detail}`);
  }
  if (result.verdict === "passed") {
    console.log(
      mode === "replay"
        ? "  Every ask was met as Ash asked it."
        : "  The checks bite: the good answer passed and every recorded shortcut failed.",
    );
  } else if (result.verdict === "couldNotExercise") {
    console.log("  Not proven: the asks above could not be scored here, and nothing says they are met.");
  } else {
    console.log(
      mode === "replay"
        ? "  Failed: an ask that Ash asked for was not met by the attempt left behind."
        : "  Broken: a check that should bite no longer tells a good answer from a shortcut.",
    );
  }
  if (result.regressed.length) {
    console.log(`Regressed since the last ${mode}: ${result.regressed.map((entry) => entry.id).join(", ")}`);
  }
  console.log(`history: ${result.history}`);
  return EXIT[result.verdict];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main();
}
