// The evidence behind the hourly progress check (board H2; Ash, 14 Oct: "if its running for more than an hour the main
// agent checks that progress is still being made or not", and "no cost ceiling ill handle it").
//
// It only measures. Given a worker's transcript and its folder, it adds up what actually moved: commits, files changed
// (the folder's diff plus the edits it made), test runs that passed or failed, and new messages. Time passing is not
// progress, and talk is not progress. `hourlyCheck.ts` turns the result into one grounded line for the Lead that owns the
// worker; the app still reads no worker's turn, messages no worker and stops nothing by itself.
//
// A worker's folder is read with the app's own git calls (useStallWatch passes them in), never by a model or a shell.
import { toolCallState } from "../../sessions/model/transcriptActivity";
import type { Block } from "../../sessions/model/session";

// ---- reading a worker's transcript ---------------------------------------------------------------------------------------

/** Running totals over a worker's whole chat. Progress is how they grow between two looks. */
export type WorkerTally = {
  edits: number;
  testsPassed: number;
  testsFailed: number;
  /** Distinct things it said. */
  messages: number;
  /** The newest failing test a run named, and how many runs in a row ended on it. */
  testRun?: { name: string; count: number };
  /** The newest finished test run and its exit, whatever the run before it did. */
  lastTest?: { exit: "passed" | "failed"; name?: string };
  /** The same change made to the same file, this many times in a row. */
  editRun?: { file: string; count: number };
};

const TEST_RUN =
  /\b(vitest|jest|pytest|mocha|playwright test|cargo test|go test|(npm|pnpm|yarn|bun) (run )?test|node --test|unittest|rspec|phpunit|swift test|xcodebuild test)\b/i;
const TEST_FAILED =
  /\b[1-9]\d*\s+(failed|failing|failures?)\b|\btests? failed\b|^\s*(?:FAIL\b|[×✗✕]\s)|--- FAIL:|^FAILED\b|\.\.\. FAILED\b/im;

function isEdit(block: Block): boolean {
  const tool = block.tool;
  if (!tool) return false;
  return tool.preview?.kind === "write" || tool.kind === "edit" || /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)\b/.test(tool.title ?? block.text);
}

function isTestRun(block: Block): boolean {
  const tool = block.tool;
  if (!tool) return false;
  const shell = tool.kind === "execute" || tool.preview?.kind === "shell" || /^(Bash|Run|Shell)\b/i.test(tool.title ?? "");
  return shell && TEST_RUN.test(`${tool.title ?? ""} ${block.text}`);
}

/** The file an edit went to, from what the row shows: its write preview, else its own label. */
function editTarget(block: Block): string | undefined {
  const preview = block.tool?.preview;
  if (preview?.path || preview?.fileName) return preview.path ?? preview.fileName;
  const label = (block.tool?.title ?? block.text).trim();
  const m = label.match(/^(?:Edit|Write|MultiEdit|NotebookEdit|apply_patch)\s+(.+)$/);
  return m?.[1]?.trim();
}

/** What one edit did, so the same change repeated reads as one: its file, and the lines it wrote. */
function editFingerprint(block: Block): string | undefined {
  const target = editTarget(block);
  if (!target) return undefined;
  const preview = block.tool?.preview;
  const body = preview?.lines?.map((line) => `${line.kind}:${line.text}`).join("\n") ?? block.tool?.detail?.trim() ?? "";
  return `${target}\u0000${body}`;
}

const short = (text: string, max = 100) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * The first failing test a test run names, in the words of the common runners (vitest/jest "FAIL file > test", "×",
 * go "--- FAIL: TestX", pytest "FAILED file::test", cargo "test x ... FAILED"), else its first line that says it failed.
 */
export function failingTestName(detail: string): string {
  const patterns: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^\s*(?:FAIL|×|✗|✕)\s+(.+?)\s*$/m, (m) => m[1].split(" > ").slice(-1)[0]],
    [/--- FAIL: (\S+)/, (m) => m[1]],
    [/^FAILED (\S+?)(?:\s+-.*)?$/m, (m) => m[1].split("::").slice(-1)[0]],
    [/^test (\S+) \.\.\. FAILED/m, (m) => m[1]],
  ];
  for (const [re, pick] of patterns) {
    const m = detail.match(re);
    if (m) return short(pick(m).trim());
  }
  const line = detail.split("\n").find((l) => /fail/i.test(l))?.trim();
  return line ? short(line) : "the test run";
}

/** What a worker's transcript adds up to: edits it made, test runs that passed or failed, and what it said. */
export function tallyTranscript(blocks: readonly Block[]): WorkerTally {
  let edits = 0;
  let testsPassed = 0;
  let testsFailed = 0;
  let testRun: WorkerTally["testRun"];
  let lastTest: WorkerTally["lastTest"];
  let editRun: { key: string; file: string; count: number } | undefined;
  const said = new Set<string>();
  for (const block of blocks) {
    if (block.role === "assistant" && block.text.trim()) said.add(block.text.trim());
    if (block.role !== "tool" || !block.tool) continue;
    const state = toolCallState(block);
    if (state === "pending") continue;
    const failed = state === "rejected";
    if (isTestRun(block)) {
      if (failed || TEST_FAILED.test(block.tool.detail ?? "")) {
        testsFailed++;
        const name = failingTestName(block.tool.detail ?? "");
        testRun = testRun?.name === name ? { name, count: testRun.count + 1 } : { name, count: 1 };
        lastTest = { exit: "failed", name };
      } else {
        testsPassed++;
        testRun = undefined;
        lastTest = { exit: "passed" };
      }
      continue;
    }
    if (isEdit(block) && !failed) {
      edits++;
      const key = editFingerprint(block);
      editRun = key && editRun?.key === key ? { key, file: editRun.file, count: editRun.count + 1 } : key ? { key, file: editTarget(block) ?? "file", count: 1 } : undefined;
    }
  }
  return {
    edits,
    testsPassed,
    testsFailed,
    messages: said.size,
    ...(testRun ? { testRun } : {}),
    ...(lastTest ? { lastTest } : {}),
    ...(editRun && editRun.count > 1 ? { editRun: { file: editRun.file, count: editRun.count } } : {}),
  };
}

/** The newest thing a worker said: its last report in its own words, whichever chat row it came from. */
export function newestWord(blocks: readonly Block[]): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.role === "assistant" && block.text.trim()) return short(block.text.trim(), 160);
  }
  return undefined;
}

// ---- reading a worker's folder -------------------------------------------------------------------------------------------

/** What its folder says, read with the app's own git calls. Null when it isn't a repo or can't be read. */
export type FolderLook = { commits: number; files: number; additions: number; deletions: number };

/** What moved in one window: the worker's chat and its folder, added up. */
export type ProgressEvidence = {
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  edits: number;
  testsPassed: number;
  testsFailed: number;
  messages: number;
  /** The newest failing test a run named. */
  failingTest?: string;
  /** Runs in a row that ended on the same failing test. */
  sameTestFailing?: number;
};

export type Look = { tally: WorkerTally; folder: FolderLook | null };

const grew = (after: number, before: number) => Math.max(0, after - before);

/** Everything a worker has done, as one witness: used the first time a worker is looked at. */
export function evidenceOf(look: Look): ProgressEvidence {
  const { tally, folder } = look;
  return {
    commits: folder?.commits ?? 0,
    files: folder?.files ?? 0,
    additions: folder?.additions ?? 0,
    deletions: folder?.deletions ?? 0,
    edits: tally.edits,
    testsPassed: tally.testsPassed,
    testsFailed: tally.testsFailed,
    messages: tally.messages,
    ...(tally.testRun ? { failingTest: tally.testRun.name, sameTestFailing: tally.testRun.count } : {}),
  };
}

/** What moved since the last look: growth in the chat, plus the folder's commits and diff now. */
export function evidenceSince(before: Look, after: Look): ProgressEvidence {
  const run = after.tally.testRun;
  const beforeRun = before.tally.testRun;
  // The failing run grew in this window (a new test failing, or the same one more times in a row).
  const runGrew = run ? (beforeRun?.name === run.name ? run.count > beforeRun.count : true) : false;
  // A folder's diff is a snapshot, not a total: it counts only when it changed since the last look.
  const folderMoved = !!after.folder && (!before.folder || after.folder.files !== before.folder.files || after.folder.additions !== before.folder.additions || after.folder.deletions !== before.folder.deletions);
  const folder = folderMoved ? after.folder : null;
  return {
    commits: after.folder?.commits ?? 0,
    files: folder?.files ?? 0,
    additions: folder?.additions ?? 0,
    deletions: folder?.deletions ?? 0,
    edits: grew(after.tally.edits, before.tally.edits),
    testsPassed: grew(after.tally.testsPassed, before.tally.testsPassed),
    testsFailed: grew(after.tally.testsFailed, before.tally.testsFailed),
    messages: grew(after.tally.messages, before.tally.messages),
    ...(run && runGrew ? { failingTest: run.name, sameTestFailing: run.count } : {}),
  };
}

/** One plain line of what moved: "2 commits, 6 files changed (+120/−30), 3 test runs passed". */
export function movedLine(e: ProgressEvidence): string {
  const parts: string[] = [];
  if (e.commits) parts.push(`${e.commits} commit${e.commits === 1 ? "" : "s"}`);
  const changed = [e.files ? `${e.files} file${e.files === 1 ? "" : "s"}` : "", e.edits ? `${e.edits} edit${e.edits === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(" and ");
  if (changed) {
    const diff = e.additions || e.deletions ? ` (+${e.additions}/−${e.deletions})` : "";
    parts.push(`${changed} changed${diff}`);
  }
  if (e.testsPassed) parts.push(`${e.testsPassed} test run${e.testsPassed === 1 ? "" : "s"} passed`);
  return parts.join(", ") || "nothing";
}

/** Whether anything real moved: a commit, a changed file, an edit, or a test run that passed. Talk alone is not progress. */
export function realProgress(e: ProgressEvidence): boolean {
  return !!(e.commits || e.files || e.edits || e.testsPassed);
}

/** What a failing run adds, in the same plain line: the test it names, and how often in a row. */
function failureLine(e: ProgressEvidence): string {
  if (e.sameTestFailing && e.sameTestFailing > 1 && e.failingTest) return `The same test failed in each of the last ${e.sameTestFailing} runs: ${e.failingTest}.`;
  if (e.failingTest) return `Its last test run failed: ${e.failingTest}.`;
  if (e.testsFailed) return `${e.testsFailed} test run${e.testsFailed === 1 ? "" : "s"} failed.`;
  return "";
}

/**
 * The one grounded line a Lead gets: what actually moved in this window, or plainly that nothing did. `windowMinutes`
 * says how long the window was, so "in the last hour" and "since it started" are both true statements of the same read.
 */
export function realityLine(e: ProgressEvidence, windowMinutes: number): string {
  const window =
    windowMinutes >= 110 ? `in the last ${Math.round(windowMinutes / 60)} hours` : windowMinutes >= 55 ? "in the last hour" : "since it started";
  const failed = failureLine(e) ? ` ${failureLine(e)}` : "";
  if (realProgress(e)) return `moving — ${movedLine(e)} ${window}.${failed}`;
  const said = e.messages ? ` It said ${e.messages} thing${e.messages === 1 ? "" : "s"}, but talk is not progress.` : "";
  return `nothing moved ${window} — no commits, file changes or passing test runs.${failed}${said}`;
}
