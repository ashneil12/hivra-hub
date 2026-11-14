import { expect, it } from "vitest";
import { isAshMessage } from "./askNotes";
import { wideAsks } from "./wideReading";
it("does not turn automatic resumes or background notices into asks", () => {
  for (const text of [
    "Continue from where you left off.",
    "<system-notice>Background job bg_1 has completed.</system-notice>",
  ]) {
    expect(isAshMessage({ id: "background", role: "user", text })).toBe(false);
    expect(wideAsks(text)).toEqual([]);
  }
  expect(
    wideAsks("Please continue the example invoice export and fix its dates."),
  ).not.toEqual([]);
});

it("does not count historical generated resume rows as open requests", async () => {
  const { askedRows, askedOpenCount } = await import("./askedView");
  const { emptyAskDoc, withAdded } = await import("./asks");
  let doc = withAdded(emptyAskDoc(1), {
    mateId: "example",
    sessionId: "example-chat",
    blockId: "resume",
    text: "Continue from where you left off.",
    now: 2,
  });
  doc = withAdded(doc, {
    mateId: "example",
    sessionId: "example-chat",
    blockId: "request",
    text: "Example: fix the export dates",
    now: 3,
  });
  expect(askedOpenCount(askedRows(doc))).toBe(1);
  expect(doc.asks).toHaveLength(2);
});

it("describes failed background commands without promoting transport completion to success", async () => {
  const { backgroundResultSummary } =
    await import("../../sessions/model/backgroundMessage");
  expect(
    backgroundResultSummary(
      "<system-notice>Background job has completed. [Command timed out after 300 seconds]</system-notice>",
    ),
  ).toContain("timed out");
  expect(backgroundResultSummary("error: interrupted")).toContain(
    "not verified",
  );
  expect(backgroundResultSummary("command returned")).toContain(
    "agent is checking",
  );
});

it("leaves a conversational opener out of the task ledger without losing a specific request", () => {
  expect(
    wideAsks("Yeah tbh I just wanted to start working on you some more"),
  ).toEqual([]);
  expect(
    wideAsks(
      "I want to start working on the example export dates and fix the timezone.",
    ),
  ).not.toEqual([]);
});
