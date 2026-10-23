// What an acceptance script says, in the one shape the runner trusts: the harsh suite's cases
// (verify/harsh/cases/*.mjs, run by scripts/hub-harsh.mjs) and the benchmark's (verify/benchmark/cases/*.mjs, run by
// scripts/hub-bench.mjs). There is no fourth "mostly fine" result: a case either passed, failed, or could not be
// exercised, and the exit code carries the same answer (0 / 1 / 2). A check that cannot run therefore cannot be
// mistaken for a pass: the runner refuses any other combination.
import { spawnSync } from "node:child_process";
import path from "node:path";

export function report(outcome, detail) {
  const code = outcome === "passed" ? 0 : outcome === "failed" ? 1 : 2;
  process.stdout.write(`${JSON.stringify({ outcome, detail })}\n`);
  process.exit(code);
}

export const passed = (detail) => report("passed", detail);
export const failed = (detail) => report("failed", detail);
export const couldNotExercise = (detail) => report("couldNotExercise", detail);

export function run(command, args, { cwd, env = process.env, timeout = 120_000 } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    didNotStart: Boolean(result.error) || result.status === null,
  };
}

/// Whether a command is on PATH. Only used for prerequisites (cargo, a browser); a missing one is "could not
/// exercise", never a failure of the work being scored.
export function have(command) {
  return spawnSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0;
}

/// The last few lines of a command's output, for a detail a person can read without the whole log.
export function tail(text, lines = 6) {
  const kept = String(text ?? "").trim().split("\n").slice(-lines).join("\n");
  return kept.length > 600 ? `…${kept.slice(-599)}` : kept;
}

/// `--target <dir>` and `--fixture <dir>`, the runner's two arguments. A case script refuses to guess either one.
export function places(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? null : argv[at + 1] ?? null;
  };
  const target = value("--target");
  const fixture = value("--fixture");
  if (!target) couldNotExercise("the runner gave no --target folder, so there is nothing to check");
  return { target: path.resolve(target), fixture: fixture ? path.resolve(fixture) : null };
}
