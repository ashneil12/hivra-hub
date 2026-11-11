import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MORE_AGENT_COPY } from "../../../features/providers/model/moreAgents";
import type { HarnessEvent, SendTurnInput } from "../core/types";

/**
 * WP-134: a whole More agents turn through the generic ACP adapter, against the fake ACP agent
 * (scripts/fake-acp-agent.mjs) run as a real child process. Only the Tauri transport is replaced: the child's stdout
 * and stdin are wired to the adapter's line handlers the way the app's child pipe does it.
 */

const fake = vi.hoisted(() => ({
  procs: new Map<string, ChildProcess>(),
  onLine: new Map<string, (line: string) => void>(),
  onExit: new Map<string, (code: number | null) => void>(),
  args: [] as string[],
  refuse: null as string | null,
  slowSpawnMs: 0,
  spawnCalls: [] as string[],
}));

const approval = vi.hoisted(() => ({ check: vi.fn(async (_id: string) => undefined) }));

vi.mock("../../../features/providers/model/moreAgents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../features/providers/model/moreAgents")>()),
  checkMoreAgentApproval: approval.check,
}));

vi.mock("../core/child", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/child")>();
  return {
    ...actual,
    spawnMoreAgentChild: async (sessionId: string, agentId: string) => {
      fake.spawnCalls.push(`${sessionId}:${agentId}`);
      if (fake.refuse) throw new Error(fake.refuse);
      // A real spawn answers after the app has forked the process; a stop can arrive in that gap.
      if (fake.slowSpawnMs) await new Promise((resolve) => setTimeout(resolve, fake.slowSpawnMs));
      const script = path.resolve(process.cwd(), "scripts/fake-acp-agent.mjs");
      const proc = spawn(process.execPath, [script, ...fake.args], { stdio: ["pipe", "pipe", "pipe"] });
      fake.procs.set(sessionId, proc);
      readline
        .createInterface({ input: proc.stdout! })
        .on("line", (line) => fake.onLine.get(sessionId)?.(line));
      proc.on("exit", (code) => {
        fake.procs.delete(sessionId);
        fake.onExit.get(sessionId)?.(code);
      });
    },
    watchChild: (sessionId: string, onLine: (line: string) => void, onExit: (code: number | null) => void) => {
      fake.onLine.set(sessionId, onLine);
      fake.onExit.set(sessionId, onExit);
    },
    unwatchChild: (sessionId: string) => {
      fake.onLine.delete(sessionId);
      fake.onExit.delete(sessionId);
    },
    writeChild: async (sessionId: string, line: string) => {
      fake.procs.get(sessionId)?.stdin?.write(`${line}\n`);
    },
    killChild: async (sessionId: string) => {
      const proc = fake.procs.get(sessionId);
      fake.procs.delete(sessionId);
      proc?.kill();
    },
  };
});

const { moreAgentAdapter, openMoreAgentSession } = await import("./moreAgentAdapter");
const { checkMoreAgentEntry } = await import("./checkAgent");

function turn(sessionId: string, text: string, events: HarnessEvent[]): SendTurnInput {
  return {
    sessionId,
    cwd: process.cwd(),
    model: "",
    runtimeMode: "default" as SendTurnInput["runtimeMode"],
    text,
    onEvent: (event) => events.push(event),
  } as SendTurnInput;
}

function said(events: HarnessEvent[]): string {
  return events
    .flatMap((event) => (event.type === "message.delta" ? [event.text] : []))
    .join("");
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const sessionId of [...fake.procs.keys()]) {
    await moreAgentAdapter.stopSession(sessionId);
  }
  fake.args = [];
  fake.refuse = null;
  fake.slowSpawnMs = 0;
  fake.spawnCalls = [];
  fake.onLine.clear();
  fake.onExit.clear();
});

describe("More agents adapter, one turn", () => {
  it("runs a turn through the generic ACP path and streams the reply", async () => {
    openMoreAgentSession("chat-turn", "fake");
    const events: HarnessEvent[] = [];
    await moreAgentAdapter.sendTurn(turn("chat-turn", "hello", events));
    expect(said(events)).toBe("You said: hello");
    expect(events.some((event) => event.type === "message.completed")).toBe(true);
    expect(events.some((event) => event.type === "session.providerBound")).toBe(true);
  });

  it("starts the agent once when two messages arrive together", async () => {
    openMoreAgentSession("chat-race", "fake");
    // One chat, one event sink, as in the app: both replies arrive on it.
    const events: HarnessEvent[] = [];
    await Promise.all([
      moreAgentAdapter.sendTurn(turn("chat-race", "one", events)),
      moreAgentAdapter.sendTurn(turn("chat-race", "two", events)),
    ]);
    expect(fake.spawnCalls).toHaveLength(1);
    expect(said(events)).toContain("You said: one");
    expect(said(events)).toContain("You said: two");
  });

  it("never runs a turn the Rust gate refused, and says why", async () => {
    fake.refuse = "This agent is not approved to run. Allow it in More agents first.";
    openMoreAgentSession("chat-denied", "fake");
    await expect(moreAgentAdapter.sendTurn(turn("chat-denied", "hi", []))).rejects.toThrow("not approved");
    expect(fake.procs.size).toBe(0);
  });

  it("a stop during the start ends the process it was starting", async () => {
    fake.slowSpawnMs = 40;
    openMoreAgentSession("chat-early-stop", "fake");
    const outcome: string[] = [];
    const sending = moreAgentAdapter.sendTurn(turn("chat-early-stop", "hi", [])).then(
      () => outcome.push("resolved"),
      (error: unknown) => outcome.push(error instanceof Error ? error.message : String(error)),
    );
    await moreAgentAdapter.stopSession("chat-early-stop");
    await sending;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(outcome).toEqual(["Stopped before it started."]);
    expect(fake.procs.size).toBe(0);
  });

  it("says stop was sent, and never that the agent confirmed it", async () => {
    openMoreAgentSession("chat-stop", "fake");
    const events: HarnessEvent[] = [];
    const sending = moreAgentAdapter.sendTurn(turn("chat-stop", "wait", events));
    await waitFor(() => said(events).includes("Working on it."));
    await moreAgentAdapter.cancelTurn("chat-stop");
    await sending;
    const notices = events.flatMap((event) => (event.type === "notice" ? [event.text] : []));
    expect(notices).toContain(MORE_AGENT_COPY.stopSent);
    expect(notices.join(" ")).not.toMatch(/has stopped|confirmed/i);
  });

  it("shows an edit ask as the standard card, and answers allow once", async () => {
    openMoreAgentSession("chat-ask", "fake");
    const events: HarnessEvent[] = [];
    const sending = moreAgentAdapter.sendTurn(turn("chat-ask", "ask", events));
    await waitFor(() => events.some((event) => event.type === "approval.requested"));
    const asked = events.find((event) => event.type === "approval.requested");
    if (!asked || asked.type !== "approval.requested") throw new Error("no ask");
    moreAgentAdapter.respondApproval("chat-ask", asked.requestId, "allow");
    await sending;
    expect(events.some((event) => event.type === "message.completed")).toBe(true);
  });

  it("declines an ask Hivra does not know, and says so in the chat", async () => {
    openMoreAgentSession("chat-odd", "fake");
    const events: HarnessEvent[] = [];
    await moreAgentAdapter.sendTurn(turn("chat-odd", "odd", events));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "notice", text: MORE_AGENT_COPY.unknownAsk }),
    );
  });

  it("says a tool with no preview has no preview", async () => {
    openMoreAgentSession("chat-plain", "fake");
    const events: HarnessEvent[] = [];
    await moreAgentAdapter.sendTurn(turn("chat-plain", "plain tool", events));
    const details = events.flatMap((event) =>
      event.type === "tool.updated" && event.detail ? [event.detail] : [],
    );
    expect(details).toContain(MORE_AGENT_COPY.noPreview);
  });
});

describe("More agents check", () => {
  it("reads the agent's name from initialize and stops the process", async () => {
    const result = await checkMoreAgentEntry("fake");
    expect(result).toMatchObject({ status: "ok", agentName: "fake-acp-agent" });
    expect(fake.procs.size).toBe(0);
  });

  it("refuses an agent that does not speak protocol version 1", async () => {
    fake.args = ["--protocol", "2"];
    const result = await checkMoreAgentEntry("fake");
    expect(result).toMatchObject({ status: "wrong_version", message: MORE_AGENT_COPY.wrongVersion });
    expect(fake.procs.size).toBe(0);
  });

  it("reports an unapproved agent without starting it", async () => {
    fake.refuse = "This agent is not approved to run. Allow it in More agents first.";
    const result = await checkMoreAgentEntry("fake");
    expect(result.status).toBe("not_approved");
    expect(fake.procs.size).toBe(0);
  });

  it("says not answering for an agent that never answers initialize", async () => {
    fake.args = ["--silent"];
    const result = await checkMoreAgentEntry("fake", 300);
    expect(result.status).toBe("not_answering");
    expect(fake.procs.size).toBe(0);
  });
});

describe("More agents adapter, approval on every turn", () => {
  it("a running agent answers the next turn only while the app still approves it", async () => {
    openMoreAgentSession("chat-recheck", "fake");
    const events: HarnessEvent[] = [];
    await moreAgentAdapter.sendTurn(turn("chat-recheck", "first", events));
    expect(fake.procs.size).toBe(1);

    approval.check.mockRejectedValueOnce(new Error("This agent is not approved to run. Allow it in More agents first."));
    await expect(moreAgentAdapter.sendTurn(turn("chat-recheck", "second", events))).rejects.toThrow("not approved");
    expect(fake.procs.size).toBe(0);
    expect(approval.check).toHaveBeenCalled();
  });
});
