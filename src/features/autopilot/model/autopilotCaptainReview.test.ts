// @vitest-environment happy-dom
// Review of PR #244, round 3 (WP-215). Each case is red on a33c10b0c.
import { afterEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import { appCaptainContext, appCaptainDoor, handleAutopilotApp, type AutopilotAppDeps, type AutopilotAppHost } from "./autopilotApp";
import { memoryAutopilot } from "./memoryAutopilot";

const spend = vi.hoisted(() => ({ status: "ok" as string }));
vi.mock("../../usage/model/spendGate", async (actual) => {
  const real = await actual<typeof import("../../usage/model/spendGate")>();
  // An app-wide limit is past: every project, and the app as a whole, is over.
  return { ...real, judgeLaunch: () => ({ status: spend.status, reason: "" }) };
});

const NOW = new Date(2026, 9, 17, 15, 0).getTime();
const MONDAY_9 = new Date(2026, 9, 19, 9, 0).getTime();

const PROJECTS = [
  { id: "vg-game", name: "EXO", folder: "/Users/someone/Projects/vg-game" },
  { id: "hivra", name: "Hivra", folder: "/Users/someone/Projects/hivra" },
];

const MONOS: Record<string, { id: string; projects: string[] }> = {
  "hivra-chat": { id: "hivra-lead", projects: ["/Users/someone/Projects/hivra"] },
};

const host: AutopilotAppHost = {
  isMono: (id) => id in MONOS,
  monoOf: (id) => MONOS[id],
};

function chat(id: string, cwd = "/Users/someone"): Session {
  return { ...newSession("claude", cwd), id, title: id, blocks: [] };
}

afterEach(() => {
  spend.status = "ok";
});

describe("autopilot.decide writes a captain answer (review of PR #244, round 3)", () => {
  it("never records a captain answer on a card in a project the calling chat does not work in", async () => {
    const backend = memoryAutopilot(() => NOW);
    await backend.set({ scopes: ["*"], untilMs: MONDAY_9, by: "ash" });
    const written: unknown[][] = [];
    const deps: AutopilotAppDeps = {
      backend,
      projects: () => PROJECTS,
      now: () => NOW,
      holdRed: () => undefined,
      monoName: (id) => id,
      isLeadership: () => false,
      leadProject: (id) => (id === "hivra-lead" ? "hivra" : undefined),
      // The app's context: the Chief of Staff is "ada".
      captainContext: () => ({ monoId: "ada", confident: true }),
      answerDecision: async (...args) => {
        written.push(args);
        return { applied: true };
      },
    };
    // A worker in Hivra, and Hivra's Lead, each name EXO's open card and put their own words on it.
    const worker = chat("worker-1", "/Users/someone/Projects/hivra");
    await handleAutopilotApp(
      worker,
      "x1",
      "autopilot.decide",
      { question: "Which font?", recommendation: "Comic Sans", project: "EXO", key: "font" },
      host,
      deps,
    ).catch(() => undefined);
    await handleAutopilotApp(
      chat("hivra-chat"),
      "x2",
      "autopilot.decide",
      { question: "Which font?", recommendation: "Comic Sans", project: "EXO", key: "font" },
      host,
      deps,
    ).catch(() => undefined);
    // The store would keep `captain:ada` on EXO's card, release EXO's waiting tasks with "The Chief of Staff answered",
    // and take it out of Ash's Needs you. Neither chat can see EXO.
    expect(written.filter(([project]) => project === "vg-game")).toEqual([]);
  });
});

describe("a plain waiting chat's door", () => {
  it("does not mark the pick confident, and remembers when the chat asked", () => {
    const waiting = appCaptainDoor({ projectId: "hivra", question: "Which first?", askedAt: 1_700_000_000_000 });
    expect(waiting.confident).toBe(false);
    expect(waiting.pendingSince).toBe(1_700_000_000_000);
  });
});

describe("money past the limit with no project (review of PR #244, round 3)", () => {
  it("a chat with no one project still sees an app-wide limit, at both captain doors", async () => {
    spend.status = "over";
    // A Mono over several projects has no projectId (waitingChats.ts r100). The app-wide limit still covers it.
    expect(appCaptainDoor({ projectId: null, question: "Example: which name?" }).moneyOverLimit).toBe(true);
    const ctx = await appCaptainContext({ project: null, question: "Example: which name?" });
    expect(ctx.moneyOverLimit).toBe(true);
  });
});
