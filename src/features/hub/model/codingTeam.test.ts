// @vitest-environment happy-dom
// Which chats are in a project's coding team (codingTeam.ts): top-level chats in its code folder, kept by id so who a
// chat is is known before it opens.
import { beforeEach, describe, expect, it } from "vitest";
import {
  codingTeamChatProject,
  codingTeamName,
  codingTeamProjectFor,
  forgetCodingTeamChat,
  isCodingTeamChat,
  noteCodingTeamChat,
  resetCodingTeamChats,
} from "./codingTeam";
import type { HubProject } from "./types";

const project = (id: string, folder: string | null, name = id): HubProject =>
  ({ id, name, shortName: name, iconShape: "folder", folder, workOwner: "ash_os", status: "active" }) as HubProject;
const PROJECTS = [
  project("vg-game", "/Users/ash/Projects/vg-game", "EXO"),
  project("hivra", "/Users/ash/Projects/hivra/", "Hivra"),
  project("ideas", null),
  project("ash", "/Users/ash/agent-memory/ash"),
];
const none = { isMono: () => false, isHabitRun: () => false };

beforeEach(() => {
  localStorage.clear();
  resetCodingTeamChats();
});

describe("codingTeamProjectFor", () => {
  it("is the project whose code folder a top-level chat is in", () => {
    expect(codingTeamProjectFor({ id: "c1", cwd: "/Users/ash/Projects/vg-game" }, PROJECTS, none)?.id).toBe("vg-game");
    // A trailing slash on either side is the same folder.
    expect(codingTeamProjectFor({ id: "c2", cwd: "/Users/ash/Projects/hivra" }, PROJECTS, none)?.id).toBe("hivra");
    expect(codingTeamProjectFor({ id: "c3", cwd: "/Users/ash/Projects/other" }, PROJECTS, none)).toBeUndefined();
    // Ash's global memory has no coding team.
    expect(codingTeamProjectFor({ id: "c4", cwd: "/Users/ash/agent-memory/ash" }, PROJECTS, none)).toBeUndefined();
  });

  it("is never a worker, a Mono's chat, a habit run, a throwaway, an orchestration run, an Inbox question or an automation", () => {
    const cwd = "/Users/ash/Projects/vg-game";
    expect(codingTeamProjectFor({ id: "app-c1-r1", cwd }, PROJECTS, none)).toBeUndefined();
    expect(codingTeamProjectFor({ id: "lead", cwd }, PROJECTS, { ...none, isMono: (id) => id === "lead" })).toBeUndefined();
    expect(codingTeamProjectFor({ id: "run", cwd }, PROJECTS, { ...none, isHabitRun: (id) => id === "run" })).toBeUndefined();
    expect(codingTeamProjectFor({ id: "e", cwd, ephemeral: true }, PROJECTS, none)).toBeUndefined();
    expect(codingTeamProjectFor({ id: "o", cwd, orchestrationLeadId: "x" }, PROJECTS, none)).toBeUndefined();
    expect(codingTeamProjectFor({ id: "i", cwd, inboxAsk: {} }, PROJECTS, none)).toBeUndefined();
    expect(codingTeamProjectFor({ id: "a", cwd, automationId: "auto-1" }, PROJECTS, none)).toBeUndefined();
  });
});

describe("the coding team's chats", () => {
  it("are kept by id across a reload, and leave when deleted", () => {
    expect(isCodingTeamChat("c1")).toBe(false);
    noteCodingTeamChat("c1", "vg-game");
    expect(codingTeamChatProject("c1")).toBe("vg-game");
    resetCodingTeamChats();
    expect(codingTeamChatProject("c1")).toBe("vg-game");
    forgetCodingTeamChat("c1");
    expect(isCodingTeamChat("c1")).toBe(false);
  });

  it("sign what they send with the project's short name", () => {
    expect(codingTeamName(PROJECTS[0])).toBe("EXO coding team");
    expect(codingTeamName(undefined)).toBe("Coding team");
  });
});
