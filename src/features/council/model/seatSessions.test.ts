// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { blankProposal } from "./record";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

it("starts each seat on its own CLI, opens that session, and hands the brief to the convening first mate", async () => {
  const host = await import("./host");
  const chats = await import("../../hub/model/hubChats");
  const { bindCouncilApp } = await import("./seatSessions");
  const sessions: { id: string; harness: string; model?: string; title?: string }[] = [];
  const asked: { id: string; text: string }[] = [];
  const shown: string[] = [];
  const handed: { monoId: string; text: string }[] = [];
  const stop = bindCouncilApp({
    sessions: () => sessions,
    add: (session) => {
      sessions.push(session);
    },
    submit: (sessionId, text, options) => {
      asked.push({ id: sessionId, text });
      options.onSettled?.({ status: "completed", text: `from ${sessionId}` });
      return true;
    },
    stop: () => {},
    show: (sessionId) => {
      shown.push(sessionId);
    },
    cwd: "/tmp/work",
    hand: (monoId, text) => {
      handed.push({ monoId, text });
    },
  });
  host.noteCouncilSeats([
    { id: "a", cli: "claude", model: "opus", sessionId: "s-a", label: "Member A" },
    { id: "c", cli: "grok", sessionId: "s-c", label: "Member C" },
    { id: "z", cli: "not-a-cli", sessionId: "s-z", label: "Nobody" },
  ]);
  const model = host.councilModelInUse();
  expect(model).toBeTypeOf("function");
  const signal = new AbortController().signal;
  expect((await model!({ seatId: "a", round: "blind", prompt: "one", signal })).text).toBe("from s-a");
  expect((await model!({ seatId: "c", round: "verdict", prompt: "the tally", signal })).text).toBe("from s-c");
  expect(asked.map((row) => row.id)).toEqual(["s-a", "s-c"]);
  expect(asked[1].text).toBe("the tally");
  expect(sessions.map((session) => session.harness)).toEqual(["claude", "grok"]);
  expect(sessions.map((session) => session.id)).toEqual(["s-a", "s-c"]);
  await expect(model!({ seatId: "z", round: "blind", prompt: "x", signal })).rejects.toThrow(/no CLI/);
  expect(sessions.some((session) => session.id === "s-z")).toBe(false);
  await expect(model!({ seatId: "missing", round: "blind", prompt: "x", signal })).rejects.toThrow(/not on this council/);

  host.openCouncilSeat({ id: "a", sessionId: "s-a", label: "Member A", cli: "claude", model: "opus" });
  expect(shown).toEqual(["s-a"]);
  expect(sessions.filter((session) => session.id === "s-a")).toHaveLength(1);

  const chat = chats.createChat("hub", "Council", ["ada", "ed"]);
  const record = {
    ...blankProposal("should we ship"),
    phase: "done" as const,
    verdict: {
      unresolved: "The price.",
      killCriteria: "A refund spike.",
      nextStep: "Publish the page.",
      minority: "Member C waited.",
      fromChairman: true,
    },
  };
  host.postCouncilBrief(chat.id, record);
  expect(handed).toEqual([{ monoId: "ada", text: expect.stringContaining("Publish the page.") }]);
  stop();
  host.setCouncilModel(undefined);
});
