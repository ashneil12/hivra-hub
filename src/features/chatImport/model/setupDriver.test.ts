// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatImportRun, type ChatImportPorts } from "./runner";
import { nextStage, startSetupDriver, type LearnStatus } from "./setupDriver";
import { resetSetupForTest, setSetupState, setupState } from "./setupStage";

const line = (o: unknown) => JSON.stringify(o);
const text = (id: string) =>
  ["Example: one", "Example: two"]
    .map((said, i) => line({ type: "user", sessionId: id, cwd: "/p/app", timestamp: `2026-01-0${i + 1}T10:00:00Z`, message: { role: "user", content: said } }))
    .join("\n");

function ports(count: number): ChatImportPorts {
  return {
    roots: async () => ({ claudeCode: ["/h/.claude/projects"], codex: [] }),
    index: async (_r, _s, offset) => ({
      missing: false,
      total: count,
      offset,
      chats: Array.from({ length: count }, (_, i) => ({ path: `c${i}.jsonl`, bytes: 1, mtimeMs: 1000 - i, cwd: "/p/app", sessionId: `s${i}` })).slice(offset),
      active: 0,
      links: 0,
      side: 0,
      done: true,
    }),
    folders: async (paths) => paths.map((path) => ({ path, exists: true })),
    knownIds: async () => [],
    read: async (_r, _s, path) => ({ text: text(path.replace(/^c|\.jsonl$/g, "s")), cut: false, longLines: 0 }),
    projects: () => [],
    createProject: async (name, folder) => ({ id: name, name, folder }),
    save: async () => true,
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  localStorage.clear();
  resetSetupForTest();
});

describe("the setup's stages", () => {
  it("move only on facts", () => {
    const idle: LearnStatus = { phase: "idle", proposals: [] };
    expect(nextStage({ stage: "sweep", learn: true }, "finding", 0, idle).stage).toBe("sweep");
    expect(nextStage({ stage: "sweep", learn: true }, "ready", 0, idle).stage).toBe("choose");
    expect(nextStage({ stage: "choose", learn: true }, "ready", 0, idle).stage).toBe("choose");
    expect(nextStage({ stage: "importing", learn: true }, "done", 5, idle).stage).toBe("reading");
    expect(nextStage({ stage: "importing", learn: false }, "done", 5, idle).stage).toBe("off");
    expect(nextStage({ stage: "importing", learn: true }, "done", 0, idle).stage).toBe("off");
    expect(nextStage({ stage: "reading", learn: true }, "done", 5, { phase: "asking", proposals: [] }).stage).toBe("reading");
    expect(nextStage({ stage: "reading", learn: true }, "done", 5, { phase: "done", proposals: [1] }).stage).toBe("rules");
    expect(nextStage({ stage: "reading", learn: true }, "done", 5, { phase: "done", proposals: [] }).stage).toBe("off");
  });
});

describe("the setup driver", () => {
  it("sweeps, waits for the person to choose, brings the chats in, reads them and stops at the rules", async () => {
    const run = new ChatImportRun(ports(3));
    let learn: LearnStatus = { phase: "idle", proposals: [] };
    const learnListeners = new Set<() => void>();
    const startLearn = vi.fn(async () => {
      learn = { phase: "done", proposals: [{ id: "r1" }] };
      for (const listener of learnListeners) listener();
    });
    setSetupState({ stage: "sweep", learn: true });
    const stop = startSetupDriver({
      run,
      learnStatus: () => learn,
      subscribeLearn: (listener) => {
        learnListeners.add(listener);
        return () => learnListeners.delete(listener);
      },
      startLearn,
    });
    await settle();
    // A relaunch mid-sweep finds the run idle and starts it again; then it waits. Nothing comes in unasked.
    expect(setupState().stage).toBe("choose");
    expect(run.get().phase).toBe("ready");
    await run.bringIn();
    await settle();
    expect(startLearn).toHaveBeenCalledTimes(1);
    expect(startLearn).toHaveBeenCalledWith({ includeUserFile: true });
    expect(setupState().stage).toBe("rules");
    stop();
  });

  it("with the reading left off, the setup ends when the chats are in", async () => {
    const run = new ChatImportRun(ports(2));
    const startLearn = vi.fn(async () => undefined);
    setSetupState({ stage: "sweep", learn: false });
    const stop = startSetupDriver({ run, learnStatus: () => ({ phase: "idle", proposals: [] }), subscribeLearn: () => () => undefined, startLearn });
    await settle();
    await run.bringIn();
    await settle();
    expect(setupState().stage).toBe("off");
    expect(startLearn).not.toHaveBeenCalled();
    stop();
  });

  it("the stage survives a relaunch", () => {
    setSetupState({ stage: "choose", learn: true });
    resetSetupForTest();
    expect(setupState()).toEqual({ stage: "choose", learn: true });
  });
});
