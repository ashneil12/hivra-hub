// A reload cuts the running turns; the old page's ask to stop their processes is sent while it is torn down and can be
// lost (Mac round 2, 21 Oct: the Claude process ran on while the chat read "Turn interrupted ... reloaded"). The new
// page ends any of them still alive before it shows them as interrupted and resumes them.
import { describe, expect, it, vi } from "vitest";
import type { HarnessProcessRun } from "../../integrations/harness/core/child";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true) }));

const { endLeftoverTurns } = await import("./appLifecycle");

function host(runs: HarnessProcessRun[], exitsAfterKillMs = 0) {
  let clock = 0;
  const killed: string[] = [];
  const killedAt = new Map<string, number>();
  return {
    killed,
    deps: {
      list: async () =>
        runs.map((r) =>
          killedAt.has(r.sessionId) && clock - killedAt.get(r.sessionId)! >= exitsAfterKillMs ? { ...r, end: clock } : r,
        ),
      kill: async (id: string) => {
        killed.push(id);
        killedAt.set(id, clock);
      },
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
    elapsed: () => clock,
  };
}

describe("endLeftoverTurns", () => {
  it("stops a cut turn's process that is still alive and waits for it to exit", async () => {
    const h = host(
      [
        { sessionId: "ed-chat", pid: 1, start: 0, turns: [{ start: 0 }] },
        { sessionId: "other-window-chat", pid: 2, start: 0, turns: [{ start: 0 }] },
        { sessionId: "done-chat", pid: 3, start: 0, end: 5, turns: [] },
      ],
      300,
    );
    expect(await endLeftoverTurns(new Set(["ed-chat", "done-chat"]), h.deps)).toEqual(["ed-chat"]);
    expect(h.killed).toEqual(["ed-chat"]);
    expect(h.elapsed()).toBeGreaterThanOrEqual(300);
    expect(h.elapsed()).toBeLessThan(3_000);
  });

  it("does nothing when no cut turn's process is alive, or there were no cut turns", async () => {
    const h = host([{ sessionId: "x", pid: 1, start: 0, turns: [] }]);
    expect(await endLeftoverTurns(new Set(["y"]), h.deps)).toEqual([]);
    expect(await endLeftoverTurns(new Set(), h.deps)).toEqual([]);
    expect(h.killed).toEqual([]);
  });

  it("gives up waiting after a few seconds, and an unreadable record is no leftover", async () => {
    const h = host([{ sessionId: "stuck", pid: 1, start: 0, turns: [{ start: 0 }] }], 60_000);
    expect(await endLeftoverTurns(new Set(["stuck"]), h.deps)).toEqual(["stuck"]);
    expect(h.elapsed()).toBe(3_000);
    const broken = { ...h.deps, list: async () => Promise.reject(new Error("headless")) };
    expect(await endLeftoverTurns(new Set(["stuck"]), broken)).toEqual([]);
  });
});
