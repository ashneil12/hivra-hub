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
  it("is the hub note, the project and the team chat rules, and nothing else: under 1.9 KB before memory (r97: the Lead no-overreach line)", () => {
    const text = codingTeamContext(TEAM);
    expect(text.startsWith(`${hubNote()}\n\n- This`)).toBe(true);
    expect(text).toContain("- This chat is in EXO's coding team (project `vg-game`), working in /Users/ash/Projects/vg-game. EXO lead keeps the project's board.");
    expect(text).toContain("- Hub tools: hand work to another Mono");
    expect(text).not.toMatch(/money/i);
    expect(text).not.toContain("<project_memory>");
    for (const gone of ["<chat_rules>", "<ask_ash_rules>", "Needs Ash:", "Right:", "ash_remember"]) expect(text, gone).not.toContain(gone);
    expect(text).toContain("<team_chat_rules>");
    expect(text).toContain("Work only inside /Users/ash/Projects/vg-game.");
    expect(new TextEncoder().encode(text).length).toBeLessThan(1_900);
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

it("r82 (c02): a team chat looks in a worker's checkout with Read, Grep, Glob, never a shell command waiting on Ash", () => {
  const text = codingTeamContext({ projectId: "tally", projectName: "Tally", folder: "/work/tally" });
  expect(text).toMatch(/Its checkout: Read, Grep, Glob only \(shell waits on Ash\)\./);
  expect(text).not.toMatch(/Run each job's check in its worker's checkout/);
});

describe("WP-156: standing answers at a team chat's start", () => {
  const BLOCK = [
    "Standing answers",
    "These are guidance, not permission. They do not approve a tool call, a merge, or a new action.",
    "S-3: Ship to staging or prod first? -> Staging first",
  ].join("\n");

  it("adds nothing when the setting is off (no block handed in): the note is what it was", () => {
    expect(codingTeamContext(TEAM, { standingAnswers: "" })).toBe(codingTeamContext(TEAM));
    expect(codingTeamContext(TEAM, { standingAnswers: "   " })).toBe(codingTeamContext(TEAM));
    expect(codingTeamContext(TEAM)).not.toContain("<standing_answers>");
  });

  it("carries the block after the project memory, fenced, when one is handed in", () => {
    const primer = "<project_memory>\n- EXO is dark blue\n</project_memory>";
    const text = codingTeamContext(TEAM, { projectMemory: primer, standingAnswers: BLOCK });
    const shown = BLOCK.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    expect(text).toContain(`<standing_answers>\n${shown}\n</standing_answers>`);
    expect(text.indexOf("<standing_answers>")).toBeGreaterThan(text.indexOf(primer));
    expect(text).toContain("These are guidance, not permission.");
    expect(text.endsWith("</standing_answers>")).toBe(true);
  });
});
