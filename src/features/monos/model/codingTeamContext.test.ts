// @vitest-environment happy-dom
// What a chat in a project's coding team is handed (monoFiles.ts codingTeamContext), and who owns delegated work
// (orchestrators.ts): Ash, 20 Oct, "mainly the coding team is the main place i want to talk to" and "I don't talk to
// workers. I only talk to orchestrators."
import { beforeEach, describe, expect, it } from "vitest";
import { ASK_ASH_RULES } from "../../hub/model/askAshRules";
import { CHECK_RULES } from "../../hub/model/checkerRules";
import { noteCodingTeamChat, resetCodingTeamChats } from "../../hub/model/codingTeam";
import { questionGoesToLead } from "../../notifications/model/stuckNotifications";
import type { Delegation } from "./delegations";
import { CHAT_RULES, codingTeamContext, DELEGATE_NOTE } from "./monoFiles";
import { isOrchestratorChat } from "./orchestrators";

const TEAM = { projectId: "vg-game", projectName: "EXO", folder: "/Users/ash/Projects/vg-game", leadName: "EXO lead" };

beforeEach(() => {
  localStorage.clear();
  resetCodingTeamChats();
});

describe("codingTeamContext", () => {
  it("says who the chat is, then carries the chat, ask-Ash and delegate notes", () => {
    const text = codingTeamContext(TEAM);
    expect(text.startsWith("<coding_team>\nYou are a chat in EXO's coding team (Ash OS project `vg-game`), working in /Users/ash/Projects/vg-game.")).toBe(true);
    expect(text).toContain("Ash talks to you directly: you orchestrate");
    expect(text).toContain("on sonnet unless the job needs more");
    for (const block of [CHAT_RULES, ASK_ASH_RULES, DELEGATE_NOTE]) expect(text).toContain(block);
    expect(DELEGATE_NOTE).toContain(CHECK_RULES);
    expect(text).not.toContain("<project_memory>");
    expect(text).not.toMatch(/\u2014/);
    // Small: a thin layer over Claude Code (Ash, 21 Oct).
    expect(new TextEncoder().encode(text).length).toBeLessThan(3_000);
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
