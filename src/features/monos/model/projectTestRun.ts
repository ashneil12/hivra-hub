// r86 (c02 r85 run 1, +624s: the Lead ran npm test in the project after every job had landed, 15 passed and 0 failed,
// and said "the suite is green"; the grader went by a worker's earlier report from its own, older copy, 1 failed): the
// app reads the chat's own test run in the project and, when it comes after a worker's report, says so in a quiet line
// under it. That run is the newer word on the suite, for status and for a "suite is green".
import { invoke } from "@tauri-apps/api/core";
import type { Block, Session } from "../../sessions/model/session";

export type TestTotals = { passed: number; failed: number };

const TEST_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|npx\s+vitest\b|vitest\s+run\b|jest\b|cargo\s+test\b|node\s+--test\b)/;

const last = (text: string, pattern: RegExp): number | undefined => {
  const all = [...text.matchAll(pattern)];
  return all.length ? Number(all[all.length - 1][1]) : undefined;
};

/** The totals a test run printed (node:test, vitest, jest, mocha, cargo), if it printed any. */
export function testTotals(output: string): TestTotals | undefined {
  const nodePass = last(output, /^\s*(?:ℹ|#)\s*pass\s+(\d+)\s*$/gm);
  if (nodePass !== undefined) return { passed: nodePass, failed: last(output, /^\s*(?:ℹ|#)\s*fail\s+(\d+)\s*$/gm) ?? 0 };
  const vitest = [...output.matchAll(/^\s*Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/gm)].pop();
  if (vitest) return { passed: Number(vitest[2]), failed: Number(vitest[1] ?? 0) };
  const jest = [...output.matchAll(/^\s*Tests:\s+(?:(\d+)\s+failed,\s*)?(?:\d+\s+\w+,\s*)*?(\d+)\s+passed/gm)].pop();
  if (jest) return { passed: Number(jest[2]), failed: Number(jest[1] ?? 0) };
  const passing = last(output, /^\s*(\d+)\s+passing\b/gm);
  if (passing !== undefined) return { passed: passing, failed: last(output, /^\s*(\d+)\s+failing\b/gm) ?? 0 };
  const cargo = [...output.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length)
    return cargo.reduce((sum, m) => ({ passed: sum.passed + Number(m[1]), failed: sum.failed + Number(m[2]) }), { passed: 0, failed: 0 });
  return undefined;
}

/** A test run this chat made in the project itself (not in a worker's copy), with what it printed. */
function projectRun(block: Block): TestTotals | undefined {
  const command = block.tool?.command ?? "";
  if (block.role !== "tool" || !TEST_COMMAND.test(command) || /-worktrees\//.test(command)) return undefined;
  if (block.tool?.status && !/^(?:completed|failed|done|error)$/i.test(block.tool.status)) return undefined;
  return testTotals(block.tool?.detail ?? block.text ?? "");
}

const isReport = (block: Block) => block.role === "user" && !!block.monoSessionCompletion;
const SAYS_GREEN = /\b(?:suite is green|all (?:the )?tests pass|tests? (?:all )?pass(?:es|ed)?|is green|green suite)\b/i;

/**
 * The quiet line a Lead or coding-team chat gets for its newest test run in the project, when that run comes after a
 * worker's report: what it printed, said as the newer word on the suite. Once per run (its block id).
 */
export function projectTestNote(chat: Session, noted: ReadonlySet<string>, now = Date.now()): Block | undefined {
  let reportAt = -1;
  let found: { index: number; totals: TestTotals } | undefined;
  chat.blocks.forEach((block, index) => {
    if (isReport(block)) reportAt = index;
    const totals = projectRun(block);
    if (totals) found = { index, totals };
  });
  if (!found || found.index < reportAt || reportAt < 0) return undefined;
  const run = chat.blocks[found.index];
  const id = `project-tests-${run.id}`;
  if (noted.has(id)) return undefined;
  const { passed, failed } = found.totals;
  const after = chat.blocks.slice(found.index + 1).filter((b) => b.role === "assistant" && !b.tool && b.text.trim());
  const claimsGreen = after.some((b) => SAYS_GREEN.test(b.text));
  const verdict = failed
    ? `${passed} passed, ${failed} failed${claimsGreen ? ", so the suite is not green" : ""}`
    : `${passed} passed, 0 failed: the suite is green`;
  return {
    id,
    role: "system",
    text: `Test run in the project itself, after the workers' reports: ${verdict}. This is newer than any worker's own run in its copy.`,
    // Timed, so the line sits where it was said (a stored note with no time drops out of a timed read of the chat).
    startedAt: now,
  } as Block;
}

const STALE_REPORT_MS = 2 * 60 * 60 * 1000;

/**
 * r88 (Ash, step 4: "if the Lead didn't run the tests in the project before its roll-up, the hub runs them itself after
 * the last landing and posts the 'Test run in the project' note"): when that run is due. Its jobs have all settled, one
 * of them landed in the project, the chat has rolled up (said something after the last report and is idle), and it ran
 * no tests in the project after that report. Once per last report (`key`).
 */
export function hubTestRunDue(
  chat: Pick<Session, "id" | "blocks" | "cwd" | "busy">,
  rows: readonly { ownerSession: string; state: string; result?: string | null }[],
  done: ReadonlySet<string>,
  now = Date.now(),
): { key: string; project: string } | undefined {
  if (chat.busy || !chat.cwd || /-worktrees\//.test(chat.cwd)) return undefined;
  // r89 (s16 run 1): a delivered job's row is let go by the window (delegations.ts retained), so its rows are often
  // gone by the roll-up; the landing is then read from the chat's own reports. Only a job still open holds the run.
  const mine = rows.filter((r) => r.ownerSession === chat.id);
  if (mine.some((r) => r.state === "running" || r.state === "question")) return undefined;
  const landed = (text: string | null | undefined) => (text ?? "").includes("[MonoCode landed]");
  if (!mine.some((r) => landed(r.result)) && !chat.blocks.some((b) => isReport(b) && landed(b.text))) return undefined;
  let reportAt = -1;
  chat.blocks.forEach((block, index) => {
    if (isReport(block)) reportAt = index;
  });
  if (reportAt < 0) return undefined;
  // An old roll-up (a chat reopened hours later) doesn't start a run on its own.
  const reportTime = chat.blocks[reportAt].startedAt ?? chat.blocks[reportAt].sentAt;
  if (reportTime !== undefined && now - reportTime > STALE_REPORT_MS) return undefined;
  const after = chat.blocks.slice(reportAt + 1);
  if (!after.some((b) => b.role === "assistant" && !b.tool && b.text.trim() && !b.streaming)) return undefined;
  if (after.some((b) => projectRun(b) || b.id?.startsWith("hub-tests-"))) return undefined;
  const key = `hub-tests-${chat.blocks[reportAt].id}`;
  return done.has(key) ? undefined : { key, project: chat.cwd };
}

export type HubTestRun = { command: string; ok: boolean; output: string };

/** The line the chat gets for the app's own run: what it printed, said as the newer word on the suite. */
export function hubTestNote(key: string, run: HubTestRun, chat: Pick<Session, "blocks">, now = Date.now()): Block {
  const totals = testTotals(run.output);
  const claimsGreen = chat.blocks.some((b) => b.role === "assistant" && !b.tool && SAYS_GREEN.test(b.text));
  const verdict = totals
    ? totals.failed
      ? `${totals.passed} passed, ${totals.failed} failed${claimsGreen ? ", so the suite is not green" : ""}`
      : `${totals.passed} passed, 0 failed: the suite is green`
    : run.ok
      ? "it passed, though it printed no totals"
      : `it failed: ${run.output.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200) || "it said nothing"}`;
  return {
    id: key,
    role: "system",
    text: `Test run in the project itself, by the app after the last landing (${run.command}; the Lead hadn't run one): ${verdict}. This is newer than any worker's own run in its copy.`,
    startedAt: now,
  } as Block;
}

/** The app's own run of the project's tests (project_tests.rs); null when it has no test script or couldn't run. */
export const runProjectTests = async (project: string): Promise<HubTestRun | null> => {
  try {
    return await invoke<HubTestRun | null>("run_project_tests", { project });
  } catch (error) {
    console.warn("the project's tests couldn't run", error);
    return null;
  }
};
