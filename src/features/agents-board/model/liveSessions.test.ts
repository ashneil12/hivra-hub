import { describe, expect, it } from "vitest";
import { boardFromStores } from "./fromStores";
import { liveBoardSessions, type LiveChat } from "./liveSessions";
import { flattenBoard } from "./tree";

const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);

function chat(patch: Partial<LiveChat> & Pick<LiveChat, "id">): LiveChat {
  return patch;
}

describe("liveBoardSessions", () => {
  it("makes the Chief of Staff home chat a Home row and still keeps project chats and sub-chats", () => {
    const sessions = liveBoardSessions({
      sessions: [
        chat({ id: "chief-home", title: "Home", busy: true, blocks: [{ startedAt: NOW - 60_000 }] }),
        chat({ id: "hivra-chat", title: "Hivra", busy: false }),
        chat({ id: "worker-chat", title: "Worker" }),
        chat({ id: "app-worker-chat-1", title: "Read the test", busy: true }),
        chat({ id: "loose", title: "Not on the board" }),
        chat({ id: "chief-home", title: "Home again" }),
      ],
      childSessionIds: ["worker-chat", "  ", null],
      projectOfChat: (id) => (id === "hivra-chat" || id === "chief-home" ? "hivra" : undefined),
      homeSessionId: " chief-home ",
    });

    expect(sessions.map((row) => row.place)).toEqual(["home", "project", "subchat"]);
    expect(sessions[0]).toMatchObject({
      id: "chief-home",
      place: "home",
      title: "Home",
      status: "working",
      startedAt: NOW - 60_000,
    });
    expect(sessions[1]).toMatchObject({ id: "hivra-chat", place: "project", projectId: "hivra", status: "idle" });
    expect(sessions[2]).toMatchObject({ id: "app-worker-chat-1", place: "subchat", parentSessionId: "worker-chat" });

    const board = boardFromStores({
      now: NOW,
      projects: [{ id: "hivra", name: "Hivra" }],
      sessions,
      mates: [],
      delegations: [],
      checks: [],
      costs: [],
    });
    const home = flattenBoard(board.tree).find((node) => node.id === "chief-home");
    expect(home?.role).toBe("home");
    expect(home?.name).toBe("Home");
    expect(flattenBoard(board.tree).some((node) => node.id === "loose")).toBe(false);
  });

  it("does not invent a Home row when the home chat is missing or unnamed", () => {
    const missing = liveBoardSessions({
      sessions: [chat({ id: "hivra-chat" })],
      childSessionIds: [],
      projectOfChat: () => undefined,
      homeSessionId: "chief-home",
    });
    expect(missing).toEqual([]);

    const unnamed = liveBoardSessions({
      sessions: [chat({ id: "hivra-chat" })],
      childSessionIds: [],
      projectOfChat: (id) => (id === "hivra-chat" ? "hivra" : undefined),
      homeSessionId: "  ",
    });
    expect(unnamed.map((row) => row.place)).toEqual(["project"]);
    expect(unnamed.some((row) => row.place === "home")).toBe(false);
  });
});
