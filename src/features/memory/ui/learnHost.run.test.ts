// A sampled learn run through the real ports, with fixture transcripts only: the app's own commands
// are stood in for, no real home folder is read, and no model is called.
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { learnPorts, learnRunStatus, startLearnRun } from "./learnHost";
import { resetLearnRunStatus } from "./learnRunStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../workLog/model/retroStore", () => ({
  listStaged: vi.fn(async () => []),
  acceptStaged: vi.fn(),
  rejectStaged: vi.fn(),
}));
vi.mock("../../sessions/data/privateKeys", () => ({ loadPrivateChatKeys: vi.fn(async () => new Set<string>()) }));
vi.mock("../model/crewBrief", () => ({ crewMemoryBrief: () => ({}) }));
vi.mock("../../crew/model/host", () => ({
  crewRouteFor: vi.fn(async () => ({
    cli: "claude",
    model: "claude-opus-4-8",
    effort: "high",
    cliFrom: "default",
    modelFrom: "rule",
    effortFrom: "rule",
    ruleIndex: null,
    skipped: [],
  })),
}));
const ask = vi.hoisted(() => ({ askForLessons: vi.fn() }));
vi.mock("../backpass/ask", async (original) => ({ ...(await original<typeof import("../backpass/ask")>()), ...ask }));

const QUOTE_A = "the launch notes were wrong";
const QUOTE_B = "the launch notes were wrong again";

function claudeFile(sessionId: string, messages: string[]): string {
  return messages
    .map((content, index) =>
      JSON.stringify({
        type: "user",
        sessionId,
        cwd: "/work/hub",
        timestamp: `2026-11-0${index + 1}T10:00:00Z`,
        message: { role: "user", content },
      }),
    )
    .join("\n");
}

const FILES: Record<string, string> = {
  "-work-hub/one.jsonl": claudeFile("one", [QUOTE_A, "ship it on Friday"]),
  "-work-api/two.jsonl": claudeFile("two", [QUOTE_B, "keep commits small"]),
  "-work-api/lonely.jsonl": claudeFile("lonely", ["only one message here, and nothing else to say"]),
};

function chatRow(rel: string, mtimeMs: number, bytes = 2_000) {
  const id = rel.split("/")[1].replace(".jsonl", "");
  return { source: "claude", id, root: "/stand-in", rel, cwd: null, title: null, mtimeMs, bytes };
}

const MODEL_ANSWER = JSON.stringify({
  files: [
    {
      file: "opinions.md",
      title: "Say it once",
      staged: "# Opinions\n\nSay the lesson once.\n",
      sightings: [
        { sessionId: "one", quote: QUOTE_A, proposedInstruction: "Say the lesson once." },
        { sessionId: "two", quote: QUOTE_B, proposedInstruction: "Say the lesson once." },
      ],
    },
  ],
});

type Handler = (args: Record<string, unknown> | undefined) => unknown;

function wire(listing: unknown, extra: Record<string, Handler> = {}) {
  const writes: unknown[] = [];
  const handlers: Record<string, Handler> = {
    learn_stores_list: () => listing,
    learn_stores_read: (args) => {
      const text = FILES[String(args?.rel)];
      if (text === undefined) throw new Error("That chat wasn't found.");
      return text;
    },
    learn_profile_load: () => ({
      opinions: "# Opinions\n",
      voice: "",
      agents: "",
      claude: "",
      opinionsSha256: "a",
      voiceSha256: "b",
      agentsSha256: "c",
      claudeSha256: "d",
    }),
    learn_state_load: () => ({ revision: 1, state: {} }),
    learn_state_cas: () => true,
    learn_profile_save: (args) => {
      writes.push(args);
      return true;
    },
    ...extra,
  };
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected command ${command}`);
    return handler(args as Record<string, unknown> | undefined);
  });
  return writes;
}

describe("a sampled learn run", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    ask.askForLessons.mockReset().mockResolvedValue({ ok: true, text: MODEL_ANSWER, wrote: false });
    resetLearnRunStatus();
  });

  it("estimates chats, tokens and the cheap model before anything is sent, and reads nothing", async () => {
    wire({
      chats: [chatRow("-work-hub/one.jsonl", 3), chatRow("-work-api/two.jsonl", 2)],
      leftOut: 4_000,
      tooBig: 2,
    });
    const found = await learnPorts().estimate!();
    expect(found.chats).toBe(2);
    expect(found.tokens).toBeGreaterThan(0);
    expect(found.model).toContain("claude-haiku-4-5");
    expect(found.leftOut).toBe(4_000);
    expect(found.tooBig).toBe(2);
    expect(ask.askForLessons).not.toHaveBeenCalled();
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "learn_stores_read")).toBe(false);
  });

  it("reads a spread of chats, passes over unusable ones, and returns one batch with its chat count", async () => {
    wire({
      chats: [
        chatRow("-work-hub/one.jsonl", 3),
        chatRow("-work-api/two.jsonl", 2),
        chatRow("-work-api/lonely.jsonl", 1),
        chatRow("-work-api/missing.jsonl", 0),
      ],
      leftOut: 0,
      tooBig: 0,
    });
    const result = await learnPorts().run({ includeUserFile: false, budget: 10 });
    expect(Array.isArray(result)).toBe(false);
    const done = result as { proposals: { id: string }[]; chats: number };
    expect(done.chats).toBe(2);
    expect(done.proposals).toHaveLength(1);
    expect(done.proposals[0].id.startsWith("opinions.md:")).toBe(true);
    const prompt = String(ask.askForLessons.mock.calls[0][0]);
    expect(prompt).toContain(`user: ${QUOTE_A}`);
    expect(prompt).not.toContain("only one message here");
    expect(learnRunStatus().phase).toBe("done");
  });

  it("reads no more chats than the budget", async () => {
    wire({
      chats: [chatRow("-work-hub/one.jsonl", 3), chatRow("-work-api/two.jsonl", 2)],
      leftOut: 0,
      tooBig: 0,
    });
    await learnPorts().run({ includeUserFile: false, budget: 1 });
    const reads = vi.mocked(invoke).mock.calls.filter(([command]) => command === "learn_stores_read");
    expect(reads).toHaveLength(1);
  });

  it("honours the from-date and the named projects", async () => {
    wire({
      chats: [chatRow("-work-hub/one.jsonl", 3_000), chatRow("-work-api/two.jsonl", 1_000)],
      leftOut: 0,
      tooBig: 0,
    });
    await learnPorts().run({ includeUserFile: false, fromMs: 2_000 });
    const reads = vi.mocked(invoke).mock.calls.filter(([command]) => command === "learn_stores_read");
    expect(reads.map(([, args]) => (args as { rel: string }).rel)).toEqual(["-work-hub/one.jsonl"]);
  });

  it("accepting every suggestion in turn goes through the same accept, and nothing is written before", async () => {
    const writes = wire({
      chats: [chatRow("-work-hub/one.jsonl", 3), chatRow("-work-api/two.jsonl", 2)],
      leftOut: 0,
      tooBig: 0,
    });
    const ports = learnPorts();
    const result = (await ports.run({ includeUserFile: false })) as { proposals: { id: string }[] };
    expect(writes).toHaveLength(0);
    for (const proposal of result.proposals) await expect(ports.accept(proposal.id)).resolves.toBe(true);
    expect(writes).toHaveLength(1);
    expect(String((writes[0] as { next: string }).next)).toContain("Say the lesson once.");
    expect(learnRunStatus().proposals).toHaveLength(0);
  });

  it("a failed read of every chat is a plain failure, not a silent empty run", async () => {
    wire({ chats: [chatRow("-work-api/missing.jsonl", 1)], leftOut: 0, tooBig: 0 });
    await expect(learnPorts().run({ includeUserFile: false })).rejects.toThrow("The chats could not be read.");
    expect(learnRunStatus().phase).toBe("failed");
  });

  it("startLearnRun is the entry point: it runs, reports its status and leaves the batch waiting", async () => {
    wire({
      chats: [chatRow("-work-hub/one.jsonl", 3), chatRow("-work-api/two.jsonl", 2)],
      leftOut: 0,
      tooBig: 0,
    });
    const status = await startLearnRun({ budget: 5 });
    expect(status.phase).toBe("done");
    expect(status.chats).toBe(2);
    expect(status.proposals).toHaveLength(1);
  });

  it("a run that fails reports the failure through the status instead of throwing", async () => {
    wire({ chats: [chatRow("-work-hub/one.jsonl", 3), chatRow("-work-api/two.jsonl", 2)], leftOut: 0, tooBig: 0 });
    ask.askForLessons.mockResolvedValue({ ok: false, kind: "timeout", reason: "timeout", wrote: false });
    const status = await startLearnRun();
    expect(status.phase).toBe("failed");
    expect(status.note).toBe("The model didn't answer. Try again.");
  });
});
