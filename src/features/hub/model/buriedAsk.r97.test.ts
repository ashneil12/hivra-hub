// @vitest-environment happy-dom
// r97 (Critiquito g, c02 BLIND 242d): the Lead ended its report with "Needs Ash: keep that all-time order, or sort by
// this week? My pick is to keep the all-time order." The pick on the same line wasn't read, so the gate held it ("no
// recommendation") and it never reached Needs you. It is a real ask now: to Ash, its two options, the pick marked.
import { beforeEach, expect, it } from "vitest";
import { mockHubData } from "./mockData";
import { setHubDataSource } from "./hubData";
import { chatQuestion, gateQuestion, parseNeedsAsh } from "./chatQuestions";
import { noteChats, resetWaitingChats, waitingChats } from "./waitingChats";

const REPORT =
  "The board shows last week's total beside this week, with weeks starting Monday.\n`npm test`: 16 passed, 0 failed.\nNot fixed: rows still sort by the all-time total, not this week. The old board-order test locks that, and they left it.\nNeeds Ash: keep that all-time order, or sort by this week? My pick is to keep the all-time order.";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  resetWaitingChats();
  setHubDataSource({ ...mockHubData, listProjects: () => [{ id: "tally", name: "Tally", shortName: "Tally", iconShape: "folder", folder: "/tmp/tally" }] });
});

it("reads 242d's line as a question to Ash with its pick", () => {
  expect(parseNeedsAsh(REPORT)).toMatchObject({
    question: "Would you rather keep that all-time order, or sort by this week?",
    pick: "keep the all-time order",
  });
});

it("puts both options, marks the pick on one, and passes the gate", () => {
  const q = chatQuestion({ busy: false, blocks: [{ role: "user", text: "go" }, { role: "assistant", text: REPORT }] })!;
  expect(q.options).toEqual(["Keep that all-time order", "Sort by this week"]);
  expect(q.pick).toBe("Keep that all-time order");
  expect(gateQuestion(q)).toMatchObject({ admit: true, kind: "choice" });
});

it("reaches Needs you (the rail and the Inbox list)", () => {
  noteChats([{ id: "lead", cwd: "/tmp/tally", title: "Tally API and weekly board", harness: "claude", blocks: [{ role: "user", text: "go", startedAt: 1 }, { role: "assistant", text: REPORT }] }], 1000);
  const [row] = waitingChats();
  expect(row?.question).toBe("Would you rather keep that all-time order, or sort by this week?");
  expect(row?.pick).toBe("Keep that all-time order");
});

it("leaves a question that already asks, and a plain pick line, as they were", () => {
  expect(parseNeedsAsh("Needs Ash: Keep the old waitlist page?\nMy pick: Archive it.")).toMatchObject({ question: "Keep the old waitlist page?", pick: "Archive it." });
  expect(parseNeedsAsh("Needs Ash: should I keep A or B?\nMy pick: A.")?.question).toBe("should I keep A or B?");
});

// c02 BLIND 1533 (r97 rerun): "…, or switch health to `{ ok: true, version }`? I'd keep alive." The pick was a plain
// "I'd keep …" and was missed, so it stayed in the chat.
it("an \"I'd keep …\" after the question is the pick too", () => {
  const text = "Not fixed: those week edges are UTC.\nNeeds Ash: keep the alive body and correct the backlog, or switch health to `{ ok: true, version }`? I'd keep alive.";
  const q = chatQuestion({ busy: false, blocks: [{ role: "user", text: "go" }, { role: "assistant", text }] })!;
  expect(q.question).toBe("Would you rather keep the alive body and correct the backlog, or switch health to { ok: true, version }?");
  expect(q.options).toEqual(["Keep the alive body and correct the backlog", "Switch health to { ok: true, version }"]);
  expect(q.pick).toBe("Keep the alive body and correct the backlog");
  expect(gateQuestion(q)).toMatchObject({ admit: true, kind: "choice" });
});
