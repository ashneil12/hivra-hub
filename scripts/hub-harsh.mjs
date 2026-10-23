// The standing harsh suite (board I3): four deliberately hard asks the hub keeps, plus the proof that they are hard.
//
// The cases live in verify/harsh (fixtures/, cases/ and suite.json). Each one has a broken starting state, a solved
// state and one or more ways an agent might "fix" it without doing the work. The suite mode runs every state through
// the case's own acceptance script and expects the broken and cheating states to FAIL and the solved state to PASS.
// That expectation is the point: a check that passes broken code is not one, and a suite whose own fixture it cannot
// accept is broken too. Any other combination makes the suite fail, not the case.
//
// The verdicts come from the acceptance scripts and nowhere else: one JSON line, `{outcome, detail}`, with exit 0 for
// passed, 1 for failed and 2 for could not exercise. A case that cannot run (no cargo, no browser) is reported as
// "couldn't be exercised" and is never counted as a pass; the suite as a whole is then "not proven". The runner
// refuses a verdict whose exit code disagrees with it.
//
// Every run is appended to ~/.monocode-hub-verify/harsh.jsonl (or $MONOCODE_HARSH_DIR/harsh.jsonl) next to the verify
// stage's records, so a case that passed before and does not pass now shows as a regression. The suite reports the
// trend; it never edits the cases.
//
//   node scripts/hub-harsh.mjs                    # the self-check: is the suite still harsh?
//   node scripts/hub-harsh.mjs --json             # the same, machine-readable on stdout
//   node scripts/hub-harsh.mjs --list             # the cases and where their asks live
//   node scripts/hub-harsh.mjs --case repro-first --target <dir>   # score one agent's attempt at one case
//
// Exit codes: 0 passed, 1 failed (or regressed), 2 could not exercise.
//
// The suite is also the `harsh` action in .monocode/project.json, so it runs from Settings > Worktrees and from
// `app actions.run`.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SUITE_ROOT = path.resolve(HERE, "../verify/harsh");

export const OUTCOMES = ["passed", "failed", "couldNotExercise"];

const WORD = { passed: "passed", failed: "failed", couldNotExercise: "couldn't be exercised" };
const EXIT = { passed: 0, failed: 1, couldNotExercise: 2 };

export function historyFile() {
  const dir = process.env.MONOCODE_HARSH_DIR || path.join(os.homedir(), ".monocode-hub-verify");
  return path.join(dir, "harsh.jsonl");
}

// ---------------------------------------------------------------- the suite

export function readSuite(root = SUITE_ROOT) {
  const file = path.join(root, "suite.json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  if (data.version !== 1) throw new Error(`${file}: unsupported version ${JSON.stringify(data.version)}`);
  if (!Array.isArray(data.cases) || data.cases.length === 0) throw new Error(`${file}: no cases`);

  const seen = new Set();
  for (const entry of data.cases) {
    for (const field of ["id", "title", "ask", "fixture", "accept"]) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) {
        throw new Error(`${file}: a case is missing "${field}"`);
      }
    }
    if (seen.has(entry.id)) throw new Error(`${file}: two cases are called ${entry.id}`);
    seen.add(entry.id);

    const states = entry.states ?? {};
    if (!Array.isArray(states.start) || !Array.isArray(states.solved)) {
      throw new Error(`${file}: ${entry.id} needs states.start and states.solved`);
    }
    if (!Array.isArray(states.cheats)) throw new Error(`${file}: ${entry.id} needs states.cheats (it may be empty)`);
    if (states.solved.length === 0) throw new Error(`${file}: ${entry.id} has no solved state`);

    const named = [
      ...states.start,
      ...states.solved,
      ...states.cheats.flatMap((cheat) => {
        if (typeof cheat?.name !== "string" || !Array.isArray(cheat.overlays)) {
          throw new Error(`${file}: ${entry.id} has a cheat without a name and overlays`);
        }
        return cheat.overlays;
      }),
    ];
    for (const overlay of named) {
      if (!fs.existsSync(path.join(root, entry.fixture, overlay))) {
        throw new Error(`${file}: ${entry.id} names a state that does not exist: ${entry.fixture}/${overlay}`);
      }
    }
    for (const field of ["accept", "ask", "fixture"]) {
      if (!fs.existsSync(path.join(root, entry[field]))) {
        throw new Error(`${file}: ${entry.id} names a file that does not exist: ${entry[field]}`);
      }
    }
    if (typeof entry.timeoutSeconds !== "undefined" && !(entry.timeoutSeconds > 0)) {
      throw new Error(`${file}: ${entry.id} has a timeout that is not a number of seconds`);
    }
  }
  return data;
}

/// A throwaway copy of the fixture with one or more overlay folders copied over it, in order.
export function buildState(root, entry, overlays) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harsh-${entry.id}-`));
  const work = path.join(dir, "work");
  fs.cpSync(path.join(root, entry.fixture), work, { recursive: true });
  for (const name of overlays) {
    fs.cpSync(path.join(root, entry.fixture, name), work, { recursive: true });
  }
  return { dir, work };
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

/// Runs one case's acceptance script against a folder and reads its verdict.
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
  const verdict = loadVerdict(result.stdout, result.status);
  return { ...verdict, seconds };
}

/// One case, end to end: the broken start must fail, every cheat must fail, the solved state must pass. A case whose
/// own solved state is not accepted is a broken fixture, and one that passes a broken state is a check that does not
/// bite; either way the case fails, which is what makes the self-check worth running.
export function runCase(root, entry) {
  const runs = [];
  const check = (state, overlays, expected) => {
    const { dir, work } = buildState(root, entry, overlays);
    try {
      const verdict = runAcceptance(root, entry, work);
      runs.push({ state, expected, ...verdict });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  check("start", entry.states.start, "failed");
  for (const cheat of entry.states.cheats) check(`cheat: ${cheat.name}`, cheat.overlays, "failed");
  check("solved", entry.states.solved, "passed");

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
    const states = runs.length;
    detail = `every state behaved: failed where it must fail, passed where it must pass (${states} states)`;
  }
  return { id: entry.id, title: entry.title, verdict, detail, runs };
}

export function runSuite(root = SUITE_ROOT) {
  const suite = readSuite(root);
  const started = Date.now();
  const cases = suite.cases.map((entry) => runCase(root, entry));
  return { verdict: aggregate(cases), cases, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

export function aggregate(cases) {
  if (cases.some((entry) => entry.verdict === "failed")) return "failed";
  if (cases.some((entry) => entry.verdict === "couldNotExercise")) return "couldNotExercise";
  return "passed";
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

/// The last run of the same kind, so a case can be compared with itself over time.
export function previousRun(entries, mode) {
  return [...entries].reverse().find((line) => line.mode === mode && Array.isArray(line.cases)) ?? null;
}

/// A case that passed in the last run and does not pass now. This is a change in the hub or its machine, and it is
/// reported by name; a case that could not be exercised before and passes now is an improvement, not a regression.
export function regressions(previous, cases) {
  if (!previous) return [];
  const before = new Map((previous.cases ?? []).map((entry) => [entry.id, entry.verdict]));
  return cases
    .filter((entry) => before.get(entry.id) === "passed" && entry.verdict !== "passed")
    .map((entry) => ({ id: entry.id, title: entry.title, was: "passed", now: entry.verdict, detail: entry.detail }));
}

/// Runs the suite, compares it with the last run and records the result.
export function runSuiteRecorded(root = SUITE_ROOT, file = historyFile()) {
  const result = runSuite(root);
  const regressed = regressions(previousRun(readHistory(file), "suite"), result.cases);
  const line = {
    at: new Date().toISOString(),
    mode: "suite",
    verdict: result.verdict,
    seconds: result.seconds,
    cases: result.cases.map((entry) => ({ id: entry.id, verdict: entry.verdict, detail: entry.detail })),
    regressed: regressed.map((entry) => entry.id),
  };
  appendHistory(line, file);
  return { ...result, regressed, history: file };
}

/// Scores one agent's attempt at one case, and records it.
export function runTargetRecorded(root, caseId, target, file = historyFile()) {
  const entry = readSuite(root).cases.find((candidate) => candidate.id === caseId);
  if (!entry) throw new Error(`no case is called ${caseId}`);
  const started = Date.now();
  const verdict = runAcceptance(root, entry, target);
  const line = {
    at: new Date().toISOString(),
    mode: "target",
    case: entry.id,
    target: path.resolve(target),
    verdict: verdict.outcome,
    detail: verdict.detail,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
  appendHistory(line, file);
  return { ...verdict, case: entry.id, history: file };
}

// ---------------------------------------------------------------- command line

function usage() {
  return [
    "usage: node scripts/hub-harsh.mjs [--json | --list]",
    "       node scripts/hub-harsh.mjs --case <id> --target <dir> [--json]",
    "",
    "  (no arguments)  prove the suite is harsh: every case must fail on its broken state and pass on its solved one",
    "  --list          the cases and where their asks live",
    "  --json          the verdict as JSON on stdout",
    "  --case, --target  score one agent's attempt at one case",
    "",
    "exit codes: 0 passed, 1 failed, 2 could not exercise",
  ].join("\n");
}

function value(argv, flag) {
  const at = argv.indexOf(flag);
  return at === -1 ? null : argv[at + 1] ?? null;
}

export function main(argv = process.argv.slice(2)) {
  const root = SUITE_ROOT;
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }

  if (argv.includes("--list")) {
    for (const entry of readSuite(root).cases) {
      console.log(`${entry.id}\t${entry.title}\t${path.join(root, entry.ask)}`);
    }
    return 0;
  }

  const target = value(argv, "--target");
  const caseId = value(argv, "--case");
  if (target || caseId) {
    if (!target || !caseId) {
      console.error(usage());
      return 64;
    }
    if (!fs.existsSync(path.resolve(target))) {
      console.error(`no such folder: ${target}`);
      return 64;
    }
    const result = runTargetRecorded(root, caseId, path.resolve(target));
    if (argv.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${result.case}: ${WORD[result.outcome]}`);
      if (result.detail) console.log(`  ${result.detail}`);
      console.log(`history: ${result.history}`);
    }
    return EXIT[result.outcome];
  }

  const result = runSuiteRecorded(root);
  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          verdict: result.verdict,
          cases: result.cases.map(({ id, title, verdict, detail, runs }) => ({ id, title, verdict, detail, runs })),
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

  console.log(`Harsh suite: ${WORD[result.verdict]}`);
  for (const entry of result.cases) {
    console.log(`  ${entry.id.padEnd(14)} ${WORD[entry.verdict].padEnd(21)} ${entry.detail}`);
  }
  if (result.verdict === "passed") {
    console.log("  The suite is harsh: every case failed on its broken state and passed on its solved one.");
  } else if (result.verdict === "couldNotExercise") {
    console.log("  Not proven: the cases above could not be exercised here, and nothing says they are harsh.");
  } else {
    console.log("  The suite is broken: a state did not behave as the case says it must.");
  }
  if (result.regressed.length) {
    console.log(`Regressed since the last run: ${result.regressed.map((entry) => entry.id).join(", ")}`);
  }
  console.log(`history: ${result.history}`);
  return EXIT[result.verdict];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main();
}
