// @vitest-environment happy-dom
// What a chat in a project's coding team is told (monoFiles.ts codingTeamContext), and who owns delegated work
// (orchestrators.ts): Ash, 20 Oct, "mainly the coding team is the main place i want to talk to" and "I don't talk to
// workers. I only talk to orchestrators."
import { beforeEach, describe, expect, it } from "vitest";
import { noteCodingTeamChat, resetCodingTeamChats } from "../../hub/model/codingTeam";
import { questionGoesToLead } from "../../notifications/model/stuckNotifications";
import type { Delegation } from "./delegations";
import { codingTeamContext, hubNote } from "./monoFiles";
import { isOrchestratorChat } from "./orchestrators";

const TEAM = { projectId: "vg-game", projectName: "EXO", folder: "/Users/ash/Projects/vg-game", leadName: "EXO lead" };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash"); // Ash's install: the app's words name him (userName.ts)
  resetCodingTeamChats();
});

describe("codingTeamContext", () => {
  // r77 (blind c02): plus its short team rules (asks first, workers within two minutes, no worktree by hand).
  it("is the hub note, the project and the team chat rules, and nothing else: under 1.8 KB before memory", () => {
    const text = codingTeamContext(TEAM);
    expect(text.startsWith(`${hubNote()}\n\n- This`)).toBe(true);
    expect(text).toContain("- This chat is in EXO's coding team (Ash OS project `vg-game`), working in /Users/ash/Projects/vg-game. EXO lead keeps the project's board.");
    expect(text).toContain("- Hub tools: hand work to another Mono");
    expect(text).not.toMatch(/money/i);
    expect(text).not.toContain("<project_memory>");
    for (const gone of ["<chat_rules>", "<ask_ash_rules>", "Needs Ash:", "Right:", "ash_remember"]) expect(text, gone).not.toContain(gone);
    expect(text).toContain("<team_chat_rules>");
    expect(text).toContain("Work only inside /Users/ash/Projects/vg-game.");
    expect(new TextEncoder().encode(text).length).toBeLessThan(1_800);
  });

  it("ends with the project's memory primer when there is one", () => {
    const primer = "<project_memory>\n- EXO is dark blue\n</project_memory>";
    expect(codingTeamContext(TEAM, { projectMemory: `  ${primer}\n` }).endsWith(`\n\n${primer}`)).toBe(true);
  });
});

describe("who owns delegated work", () => {
  const row = (ownerSession: string) =>
    ({ id: "t-1", ownerSession, childSession: `app-${ownerSession}-r1`, state: "running", log: [] }) as unknown as Delegation;

  it("is a coding-team chat as well as a Mono's own chat", () => {
    expect(isOrchestratorChat("team-1")).toBe(false);
    noteCodingTeamChat("team-1", "vg-game");
    expect(isOrchestratorChat("team-1")).toBe(true);
    expect(isOrchestratorChat("app-team-1-r1")).toBe(false);
  });

  it("sends a coding-team chat's worker's question to that chat, not to Ash", () => {
    const rows = [row("team-1")];
    expect(questionGoesToLead("app-team-1-r1", rows)).toBe(false);
    noteCodingTeamChat("team-1", "vg-game");
    expect(questionGoesToLead("app-team-1-r1", rows)).toBe(true);
  });
});
