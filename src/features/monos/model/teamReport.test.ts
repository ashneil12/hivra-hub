// Port map idea 1: a coding team's report in the briefing Mono's chat, read the way UniiChat reads a report.
import { describe, expect, it } from "vitest";
import { completionMessage, type MonoSessionCompletionResult } from "./monoSessionCompletion";
import { REPORT_FALLBACK_NAME, REPORT_TALL, readTeamReport, reportIsTall } from "./teamReport";

const result = (over: Partial<MonoSessionCompletionResult> = {}): MonoSessionCompletionResult => ({
  sessionId: "lead-chat",
  project: "/code/vg-game",
  title: "EXO lead",
  status: "completed",
  originalPrompt: "Fix the save bug",
  result: "Fixed the save bug.\nTests pass.",
  truncated: false,
  ...over,
});
const blockOf = (results: MonoSessionCompletionResult[]) => {
  const message = completionMessage("mono-completion-r1-g1", results);
  return { role: "user" as const, internal: true, text: message.text, monoSessionCompletion: message.monoSessionCompletion };
};
const teams = (id: string) => (id === "lead-chat" ? "EXO coding team" : id === "nameless-lead" ? "" : undefined);

describe("readTeamReport", () => {
  it("names the team the Lead runs and keeps its words as written", () => {
    expect(readTeamReport(blockOf([result()]), teams)).toEqual({
      team: "EXO coding team",
      text: "Fixed the save bug.\nTests pass.",
      status: "completed",
    });
  });

  it("a Lead whose team has no name is labelled 'Report' (UniiChat WHO.work)", () => {
    expect(REPORT_FALLBACK_NAME).toBe("Report");
    expect(readTeamReport(blockOf([result({ sessionId: "nameless-lead" })]), teams)?.team).toBe("Report");
  });

  it("drops a trailing Full chat: zoom(...) pointer, as report_read does", () => {
    const text = 'Done.\n\nFull chat: zoom("FireAnt")';
    expect(readTeamReport(blockOf([result({ result: text })]), teams)?.text).toBe("Done.");
  });

  it("a failed brief shows its error and status", () => {
    const report = readTeamReport(blockOf([result({ status: "failed", result: "", error: "402 Payment Required" })]), teams);
    expect(report).toMatchObject({ text: "402 Payment Required", status: "failed" });
  });

  it("is not a team report: another chat's report, a batch, a worker's question, Ash's own words", () => {
    expect(readTeamReport(blockOf([result({ sessionId: "worker-chat" })]), teams)).toBeUndefined();
    expect(readTeamReport(blockOf([result(), result({ sessionId: "lead-chat" })]), teams)).toBeUndefined();
    const question = blockOf([result()]);
    expect(readTeamReport({ ...question, monoSessionCompletion: { ...question.monoSessionCompletion!, question: true } }, teams)).toBeUndefined();
    expect(readTeamReport({ role: "user", internal: false, text: "hello" }, teams)).toBeUndefined();
  });
});

describe("reportIsTall: UniiChat's TALL rule, length + 80 per line > 4000", () => {
  it("one line: tall only past 3920 characters", () => {
    expect(REPORT_TALL).toBe(4000);
    expect(reportIsTall("a".repeat(3920))).toBe(false); // 3920 + 80 = 4000, not over
    expect(reportIsTall("a".repeat(3921))).toBe(true);
  });

  it("lines weigh 80 each: a short paste of many lines folds too", () => {
    expect(reportIsTall(Array(48).fill("x").join("\n"))).toBe(false); // 95 + 48 * 80 = 3935
    expect(reportIsTall(Array(49).fill("x").join("\n"))).toBe(true); // 97 + 49 * 80 = 4017
  });
});
