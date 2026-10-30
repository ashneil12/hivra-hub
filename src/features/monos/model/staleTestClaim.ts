// r92 (c02 blind 0176, +249s): the board worker reported "fixed the even-count median ... npm test: 13 passed", and the
// Lead still told Ash "the even-count median test is still red", reversing itself 80s later. A failing-test claim is
// checked against the newest worker result first: the report carries that result in one line (monoSessionCompletion),
// and a reply that still calls a test red after a newer green worker result gets one app note to correct it.
import { forUser } from "../../hub/model/userName";
import type { Block, QueuedMessage, Session } from "../../sessions/model/session";

export const LATEST_RESULT_PREFIX = "[MonoCode latest result]";
/** monoSessionCompletion.ts's MONO_REPORT_PREFIX (it imports this file; the test holds the two equal). */
export const REPORT_PREFIX = "[MonoCode report]";

export type TestVerdict = { verdict: "green" | "red"; line: string };

const PASSED = /\b\d+ (?:tests? )?pass(?:ed|ing)\b/i;
const FAILED = /\b[1-9]\d* (?:tests? )?fail(?:ed|ing|s)?\b/i;
const GREEN = /\b(?:tests?|suite|npm test|everything)\b[^.;\n]{0,30}\b(?:(?:is|are|went|goes|now|all) )+(?:green|passing)\b|\ball (?:\d+ )?tests? pass(?:ed|es|ing)?\b|\b(?:tests?|suite) (?:now )?pass(?:es|ed)?\b/i;
const RED =
  /\bstill (?:red|failing|fails|broken)\b|\b(?:tests?|suite|npm test)\b[^.;\n]{0,40}\b(?:is|are) (?:still )?(?:red|failing)\b/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z`])|\n+|\s+\/\s+/)
    .map((s) => s.replace(/^[\s>*#-]+/, "").trim())
    .filter(Boolean);
}

function clip(line: string): string {
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/** What a worker's own report says the tests did: a count wins ("13 passed", "1 failed"), then plain words. */
export function testVerdict(text: string): TestVerdict | undefined {
  const lines = sentences(text);
  const failed = lines.find((s) => FAILED.test(s));
  if (failed) return { verdict: "red", line: clip(failed) };
  const passed = lines.find((s) => PASSED.test(s)) ?? lines.find((s) => GREEN.test(s));
  if (passed) return { verdict: "green", line: clip(passed) };
  const red = lines.find((s) => RED.test(s));
  return red ? { verdict: "red", line: clip(red) } : undefined;
}

/** The first sentence of a Lead's reply telling Ash a test still fails. */
export function redClaim(reply: string): string | undefined {
  const line = sentences(reply).find((s) => (FAILED.test(s) && !PASSED.test(s)) || RED.test(s) || (FAILED.test(s) && /\bstill\b/i.test(s)));
  return line ? clip(line) : undefined;
}

type ReportResult = { title?: string; result?: string };

/** The worker results a report turn carries (its JSON payload: one session, or several). */
export function reportResults(text: string): ReportResult[] {
  if (!text.trimStart().startsWith(REPORT_PREFIX)) return [];
  const at = text.indexOf("\n\n{");
  if (at < 0) return [];
  try {
    const payload = JSON.parse(text.slice(at + 2)) as ReportResult & { sessions?: ReportResult[] };
    return Array.isArray(payload.sessions) ? payload.sessions : [payload];
  } catch {
    return [];
  }
}

/** The newest worker result with a test verdict in a chat, and where it is. */
export function latestWorkerTest(blocks: readonly Block[]): (TestVerdict & { title: string; index: number }) | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.role !== "user") continue;
    const results = reportResults(block.text);
    for (let r = results.length - 1; r >= 0; r--) {
      const found = testVerdict(String(results[r].result ?? ""));
      if (found) return { ...found, title: String(results[r].title ?? "a worker"), index: i };
    }
  }
  return undefined;
}

/** The one line a report adds when a worker in it ran the tests green: the newest result, ahead of any earlier red one. */
export function latestTestLine(results: readonly ReportResult[]): string {
  for (let r = results.length - 1; r >= 0; r--) {
    const found = testVerdict(String(results[r].result ?? ""));
    if (found?.verdict === "green")
      return ` LATEST TEST RESULT: ${results[r].title ?? "a worker"} ran the tests and they pass ("${found.line}"). This replaces any earlier failing result: don't tell the user a test is still failing or red unless a newer run shows it.`;
  }
  return "";
}

/** The app note a Lead or coding-team chat gets when its reply calls a test red after a newer green worker result. */
export function staleTestClaimNudge(chat: Session, nudged: ReadonlySet<string>): QueuedMessage | undefined {
  if (chat.busy || chat.queuedMessages?.length) return undefined;
  let start = chat.blocks.length - 1;
  for (; start >= 0; start--) {
    const block = chat.blocks[start];
    if (block.role === "user" && !block.draft) break;
  }
  if (start < 0 || chat.blocks[start].text.trimStart().startsWith(LATEST_RESULT_PREFIX)) return undefined;
  const turn = chat.blocks.slice(start + 1);
  const replies = turn.filter((b: Block) => b.role === "assistant" && !b.tool && !b.internal && b.text.trim());
  const last = replies[replies.length - 1];
  if (!last || nudged.has(last.id)) return undefined;
  const claim = redClaim(replies.map((b) => b.text).join("\n"));
  if (!claim) return undefined;
  // It ran the tests itself this turn and saw them fail: that is newer than any report.
  if (turn.some((b) => b.tool && FAILED.test(`${b.tool.detail ?? ""}\n${b.text}`))) return undefined;
  const latest = latestWorkerTest(chat.blocks);
  if (latest?.verdict !== "green") return undefined;
  return {
    id: `latest-result-${last.id}`,
    attachments: [],
    waitForIdle: true,
    text: forUser`${LATEST_RESULT_PREFIX} From the app: your last reply told Ash "${claim}", but the newest worker result says the tests pass (${latest.title}: "${latest.line}"). Check the latest worker result, or run the tests, before telling Ash anything is still failing. Then correct it to him in one line. This is an app notification, not a new message from Ash.`,
  };
}
