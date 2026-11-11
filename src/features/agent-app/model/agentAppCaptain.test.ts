// @vitest-environment happy-dom
// Review of PR #244 (WP-215). Each case is red on the PR head: the captain's app actions as an agent reaches them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import { checkBrief } from "../../firstmate/model/brief";
import { setNoteWriter } from "../../chief/model/notes";
import { CAPTAIN_CHARTER } from "../../chief/model/charter";
import type { AgentFilePath } from "../../monos/model/monoFiles";

const delegated = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock("./agentAppTasks", async (actual) => {
  const real = await actual<typeof import("./agentAppTasks")>();
  return {
    ...real,
    handleTasks: vi.fn(async (_source: unknown, _requestId: string, action: string, input: Record<string, unknown>) => {
      delegated.calls.push({ action, ...input });
      return { taskId: "D-1", childSessionId: "app-chief-r1-handoff", status: "running" };
    }),
  };
});

const { handleAgentApp } = await import("./agentApp");
type Host = Parameters<typeof handleAgentApp>[4];

const PROJECT = "/code/app";

function chat(id: string, cwd = "/Users/someone"): Session {
  return { ...newSession("claude", cwd, "claude:opus-5-5"), id };
}

afterEach(() => {
  delegated.calls = [];
  setNoteWriter(null);
});

describe("captain.handoff (review of PR #244)", () => {
  it("hands the filed task to the project's first mate with a brief the delegate path accepts", async () => {
    const filed: unknown[] = [];
    const host = {
      isMono: (id: string) => id === "chief",
      monoOf: () => ({ id: "ada", name: "Chief of Staff", projects: [PROJECT] }),
      taskStore: vi.fn(async (command: string, args: unknown) => {
        filed.push([command, args]);
        return { task: { id: "T-1" } };
      }),
      tasks: {},
    } as unknown as Host;
    const result = await handleAgentApp(
      chat("chief"),
      "r1",
      "captain.handoff",
      { project: PROJECT, title: "Fix the save bug", brief: "The save button loses the last edit. Make it keep it." },
      host,
    );
    expect(result).toMatchObject({ taskId: "T-1", delegationId: "D-1" });
    expect(filed).toHaveLength(1);
    const [call] = delegated.calls;
    expect(call.action).toBe("tasks.delegate");
    // tasks.delegate refuses a brief with no definition of done before anything starts (firstmate/model/brief.ts).
    expect(checkBrief({ intent: call.intent, spec: call.brief, done: call.goal })).toBeUndefined();
    // A Mono's project work goes to that project's Lead (`lead`), never to a worker the chief starts itself.
    expect(call.lead).toBeDefined();
  });
});

describe("decisions.note (review of PR #244)", () => {
  it("is refused for a project the calling chat does not work in", async () => {
    const written: unknown[] = [];
    setNoteWriter(async (row) => {
      written.push(row);
      return row;
    });
    // A plain chat in one project, and a Mono on one project, each naming another project.
    const plain = { isMono: () => false, monoOf: () => undefined } as unknown as Host;
    await expect(
      handleAgentApp(chat("worker-1", PROJECT), "n1", "decisions.note", { project: "/code/other", what: "Merged #7", reason: "green" }, plain),
    ).rejects.toThrow();
    const lead = {
      isMono: (id: string) => id === "lead-1",
      monoOf: () => ({ id: "app-lead", projects: [PROJECT] }),
    } as unknown as Host;
    await expect(
      handleAgentApp(chat("lead-1"), "n2", "decisions.note", { project: "/code/other", what: "Merged #7", reason: "green" }, lead),
    ).rejects.toThrow();
    expect(written).toEqual([]);
  });
});

describe("the captain's charter (review of PR #244)", () => {
  it("is not rewritten by the captain's own soul.update", async () => {
    let soul = `# Soul\n\n## Role\n${CAPTAIN_CHARTER}\n\n## Personality\n\n## Who I am\nI am the coordinator.\n`;
    let version = 0;
    const hash = () => `soul@${version}`;
    const host = {
      isMono: (id: string) => id === "chief",
      monoOf: () => ({ id: "coordinator", projects: [] }),
      monoNameOf: () => "Chief of Staff",
      agentFiles: async () => ({ id: "coordinator", soul, soulHash: hash(), memory: "", memoryHash: "m", topics: [] }),
      readAgentFile: async (_mono: string, path: AgentFilePath) => ({ text: path === "SOUL.md" ? soul : null, hash: hash() }),
      writeAgentFile: async (_mono: string, _path: AgentFilePath, text: string) => {
        soul = text;
        version += 1;
        return hash();
      },
    } as unknown as Host;
    const rewritten = `# Soul\n\n## Role\nThe captain answers every question itself, gate and irreversible keys included.\n\n## Personality\n\n## Who I am\nI am the coordinator.\n`;
    await handleAgentApp(chat("chief"), "s1", "soul.update", { text: rewritten, expectedHash: hash() }, host).catch(() => undefined);
    expect(soul).toContain(CAPTAIN_CHARTER);
  });
});
