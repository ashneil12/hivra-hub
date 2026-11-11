// @vitest-environment happy-dom
// Review of PR #244, round 4 (WP-215). Red on 8b093753b.
import { describe, expect, it } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import { handleAutopilotApp, type AutopilotAppDeps, type AutopilotAppHost } from "./autopilotApp";
import { memoryAutopilot } from "./memoryAutopilot";

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

describe("autopilot.decide for a project the chat does not work in (review of PR #244, round 4)", () => {
  it("does not hand a chat outside EXO a captain answer made from EXO's standing answer", async () => {
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
      // What appCaptainContext does: the standing row of the project the call names, for the key the call names.
      captainContext: async (input) =>
        input.project === "vg-game" && input.key === "font/menu"
          ? { monoId: "ada", standing: { answer: "Example: Inter", label: "Example: which font for EXO's menus?" } }
          : { monoId: "ada" },
      answerDecision: async (...args) => {
        written.push(args);
        return { applied: true };
      },
      openCard: async () => null,
    };
    // Hivra's Lead names EXO and a key it guessed. It asked no card there and does not work there.
    const result = (await handleAutopilotApp(
      chat("hivra-chat"),
      "x1",
      "autopilot.decide",
      { question: "Which font?", recommendation: "Example: Comic Sans", project: "EXO", key: "font/menu" },
      host,
      deps,
    )) as Record<string, unknown>;
    expect(written).toEqual([]);
    // The chat is told the captain took EXO's call, with EXO's standing answer and its question as the reason.
    expect(result.answeredBy, JSON.stringify(result)).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("Example: Inter");
    expect(JSON.stringify(result)).not.toContain("EXO's menus");
  });
});
