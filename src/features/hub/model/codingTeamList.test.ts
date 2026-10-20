// @vitest-environment happy-dom
// The coding team's Sessions list (codingTeamList.ts): every chat a chat started nests under the top-level chat Ash
// talks to, with its state, and the list opens on the Lead unless Ash was last in another chat there.
import { beforeEach, describe, expect, it } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import { codingTeamView, noteCodingTeamView, subChatsByParent } from "./codingTeamList";

const row = (id: string, ownerSession: string, childSession: string, patch: Partial<Delegation> = {}) =>
  ({ id, ownerSession, childSession, title: id, state: "running", createdAt: Number(id.slice(2)) * 1000, log: [], ...patch }) as Delegation;
const LEAD = "9a7e-lead-chat";
const TEAM = "6f1c-2a9e";

describe("subChatsByParent", () => {
  it("nests each worker under the chat Ash talks to, newest first, with its state", () => {
    const rows = [
      row("t-1", LEAD, `app-${LEAD}-r1`, { title: "Wire the dodge input" }),
      row("t-2", LEAD, `app-${LEAD}-r2`, { title: "Pick the dodge timing", state: "question" }),
      row("t-3", TEAM, `app-${TEAM}-r3`, { title: "Save bug test", state: "completed" }),
    ];
    const { byParent, childIds } = subChatsByParent([LEAD, TEAM, "plain"], [], rows, new Set());
    expect(byParent.get(LEAD)!.map((chat) => [chat.title, chat.state])).toEqual([
      ["Pick the dodge timing", "question"],
      ["Wire the dodge input", "running"],
    ]);
    expect(byParent.get(TEAM)!.map((chat) => chat.sessionId)).toEqual([`app-${TEAM}-r3`]);
    expect(byParent.get("plain")).toBeUndefined();
    expect([...childIds].sort()).toEqual([`app-${LEAD}-r1`, `app-${LEAD}-r2`, `app-${TEAM}-r3`].sort());
  });

  it("joins a worker's own workers to the top-level chat above it, by row or by id", () => {
    const worker = `app-${TEAM}-r1`;
    const rows = [row("t-1", TEAM, worker), row("t-2", worker, `app-${worker}-r2`, { title: "Deeper" })];
    const listed = [{ id: `app-app-${TEAM}-r1-r9`, title: "Operator launch", createdAt: 1 }];
    const { byParent } = subChatsByParent([TEAM], listed, rows, new Set([`app-app-${TEAM}-r1-r9`]));
    expect(byParent.get(TEAM)!.map((chat) => [chat.title, chat.state, chat.row ? "row" : "id"])).toEqual([
      ["Deeper", "running", "row"],
      ["t-1", "running", "row"],
      ["Operator launch", "running", "id"],
    ]);
  });

  it("nests a chat started without a row by its id, done once it is no longer busy", () => {
    const listed = [
      { id: TEAM, title: "Fix the save bug", createdAt: 1 },
      { id: `app-${TEAM}-r1`, title: "Write the regression test", createdAt: 2 },
    ];
    const { byParent, childIds } = subChatsByParent([TEAM], listed, [], new Set());
    expect(byParent.get(TEAM)).toEqual([
      { sessionId: `app-${TEAM}-r1`, ownerSession: TEAM, title: "Write the regression test", state: "completed", createdAt: 2 },
    ]);
    expect(childIds.has(TEAM)).toBe(false);
  });

  it("never nests a top-level chat, nor work whose owner isn't in the list", () => {
    // A leadership brief went into the Lead's own chat: the Lead stays at the top.
    const rows = [row("t-1", "cos-chat", LEAD), row("t-2", "cos-chat", "app-cos-chat-r2")];
    const { byParent, childIds } = subChatsByParent([LEAD], [], rows, new Set());
    expect(byParent.size).toBe(0);
    expect(childIds.size).toBe(0);
  });
});

describe("what the coding team opens on", () => {
  beforeEach(() => localStorage.clear());

  it("is the Lead by default, and the chat Ash was last in there after he picks one", () => {
    expect(codingTeamView("vg-game")).toBe("lead");
    noteCodingTeamView("vg-game", "chat");
    expect(codingTeamView("vg-game")).toBe("chat");
    expect(codingTeamView("hivra")).toBe("lead");
    noteCodingTeamView("vg-game", "lead");
    expect(codingTeamView("vg-game")).toBe("lead");
  });
});
