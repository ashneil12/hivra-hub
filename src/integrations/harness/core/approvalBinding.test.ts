// WP-243: a yes runs that exact action, once. The registry binds every allow to the frozen action of the call still
// waiting under its id.
import { afterEach, describe, expect, it, vi } from "vitest";
import { actionHash, resetAskedForTests } from "../../../features/sessions/model/approvalAction";
import { registerHarness, respondHarnessApproval, sendHarnessTurn, type HarnessAdapter } from "./registry";
import type { HarnessEvent, SendTurnInput, SteerTurnInput } from "./types";

type Asked = { requestId: number; hash?: string };

/** A CLI that asks for each call it is given, and records which answers it took. */
function askingCli(calls: { requestId: number; tool: string; input: Record<string, unknown>; bare?: boolean }[]) {
  const waiting = new Set<number>();
  const answered: { requestId: number; decision: string }[] = [];
  const seen: HarnessEvent[] = [];
  const adapter: HarnessAdapter = {
    id: "claude",
    live: true,
    async sendTurn(input: SendTurnInput) {
      for (const call of calls) {
        waiting.add(call.requestId);
        input.onEvent({
          type: "approval.requested",
          requestId: call.requestId,
          title: call.tool,
          call: { tool: call.tool, command: String(call.input.command ?? "") },
          // A CLI that hands the app its raw input hashes it; a bare one leaves it to the registry.
          ...(call.bare ? {} : { actionHash: actionHash(call.tool, call.input) }),
        });
      }
    },
    async steerTurn(_input: SteerTurnInput) {},
    async cancelTurn() {},
    respondApproval(_sessionId: string, requestId: number, decision: string) {
      if (!waiting.has(requestId)) return false;
      waiting.delete(requestId);
      answered.push({ requestId, decision });
      return true;
    },
    async stopSession() {},
    async forgetSession() {},
    bindSession() {},
  };
  return { adapter, answered, seen };
}

async function ask(sessionId: string, cli: ReturnType<typeof askingCli>): Promise<Asked[]> {
  registerHarness(cli.adapter);
  const asked: Asked[] = [];
  await sendHarnessTurn({
    harness: "claude",
    sessionId,
    cwd: "/tmp/example",
    model: "m",
    text: "Example: run it",
    runtimeMode: "supervised",
    onEvent: (event) => {
      if (event.type === "approval.requested") asked.push({ requestId: event.requestId, hash: event.actionHash });
    },
  });
  return asked;
}

describe("WP-243 an allow is bound to the frozen action", () => {
  afterEach(() => {
    resetAskedForTests();
    vi.restoreAllMocks();
  });

  it("hashes the tool name and full arguments, key order aside", () => {
    expect(actionHash("Bash", { command: "npm test", timeout: 5 })).toBe(actionHash("Bash", { timeout: 5, command: "npm test" }));
    expect(actionHash("Bash", { command: "npm test" })).not.toBe(actionHash("Bash", { command: "npm test -- --all" }));
    expect(actionHash("Bash", { command: "x" })).not.toBe(actionHash("Write", { command: "x" }));
    expect(actionHash("Bash", { command: "x" })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends an allow that names the card's hash, once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cli = askingCli([{ requestId: 1, tool: "Bash", input: { command: "npm test" } }]);
    const [card] = await ask("bind-once", cli);
    expect(card.hash).toBe(actionHash("Bash", { command: "npm test" }));
    expect(respondHarnessApproval("claude", "bind-once", 1, "allow", card.hash)).toBe(true);
    // The same yes again runs nothing.
    expect(respondHarnessApproval("claude", "bind-once", 1, "allow", card.hash)).toBe(false);
    expect(cli.answered).toEqual([{ requestId: 1, decision: "allow" }]);
  });

  it("asks again when the hash doesn't match: a retry with other arguments under the same id", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = askingCli([{ requestId: 1, tool: "Bash", input: { command: "npm test" } }]);
    const [old] = await ask("bind-retry", first);
    // The CLI restarted and its new ask reuses id 1 with different arguments; the old card's yes must not run it.
    const second = askingCli([{ requestId: 1, tool: "Bash", input: { command: "npm publish" } }]);
    const [fresh] = await ask("bind-retry", second);
    expect(fresh.hash).not.toBe(old.hash);
    expect(respondHarnessApproval("claude", "bind-retry", 1, "allow", old.hash)).toBe(false);
    expect(second.answered).toEqual([]);
    // The card for the new call still works.
    expect(respondHarnessApproval("claude", "bind-retry", 1, "allow", fresh.hash)).toBe(true);
    expect(second.answered).toEqual([{ requestId: 1, decision: "allow" }]);
  });

  it("refuses an allow that names no action, or one nobody asked for (fail closed)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cli = askingCli([{ requestId: 3, tool: "Bash", input: { command: "ls" } }]);
    await ask("bind-unbound", cli);
    expect(respondHarnessApproval("claude", "bind-unbound", 3, "allow")).toBe(false);
    expect(respondHarnessApproval("claude", "bind-unbound", 9, "allow", "f".repeat(64))).toBe(false);
    expect(cli.answered).toEqual([]);
  });

  it("lets a deny through without a hash: refusing runs nothing", async () => {
    const cli = askingCli([{ requestId: 4, tool: "Bash", input: { command: "ls" } }]);
    await ask("bind-deny", cli);
    expect(respondHarnessApproval("claude", "bind-deny", 4, "deny")).toBe(true);
    expect(cli.answered).toEqual([{ requestId: 4, decision: "deny" }]);
  });

  it("hashes what a CLI showed when it gives no hash of its own, and binds to that", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cli = askingCli([{ requestId: 5, tool: "Bash", input: { command: "make" }, bare: true }]);
    const [card] = await ask("bind-bare", cli);
    expect(card.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(respondHarnessApproval("claude", "bind-bare", 5, "allow", "0".repeat(64))).toBe(false);
    expect(respondHarnessApproval("claude", "bind-bare", 5, "allow", card.hash)).toBe(true);
  });
});
