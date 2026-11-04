// @vitest-environment happy-dom
// A coding-team chat hands what it can't do to its own Lead itself (Board 22 Oct, run d91c AD14: a Hivra coding chat
// asked "make me a page... whats shipped this week n whats stuck" told Ash to go ask the Lead in another chat).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import type { AgentAppHost } from "./agentApp";

vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: () => true,
  hasProbedHarnessAvailability: () => true,
  probeHarnessAvailability: async () => undefined,
}));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  vi.resetModules();
});

async function fixture(withLead = true) {
  const team = await import("../../hub/model/builtInMonos");
  team.ensureBuiltInMonos();
  const monos = await import("../../monos/model/mono");
  if (withLead) monos.addMono({ id: "hivra-lead", name: "Hivra lead", mascot: "dino", color: "hsl(12 80% 58%)", projects: ["/code/hivra"] } as never);
  const { handleAgentApp } = await import("./agentApp");
  const source: Session = { ...newSession("claude", "/code/hivra", "claude:opus-5-5"), id: "chat-hivra-1" };
  const message = vi.fn(async () => ({ delivery: "started" as const }));
  const host = {
    isMono: () => false,
    isHabitRun: () => false,
    monoOf: () => undefined,
    codingTeamOf: (id: string) => (id === source.id ? { project: "hivra", name: "Hivra coding team", folder: "/code/hivra" } : undefined),
    rooms: { message, delegated: vi.fn(), now: () => 1_000_000 },
  } as unknown as AgentAppHost;
  const run = (action: string, input: Record<string, unknown>) =>
    handleAgentApp(source, `r-${Math.random().toString(36).slice(2)}`, action, input, host) as Promise<Record<string, unknown>>;
  return { run, message };
}

describe("a coding-team chat and its Lead", () => {
  it("page_build from a coding chat says to hand Ash's ask to its Lead by mono_message, never to send him elsewhere", async () => {
    const { run } = await fixture();
    const refused = await run("pages.build", { project: "hivra", request: "make me a page whats shipped this week n whats stuck" }).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(refused).toContain('mono_message (to "hivra-lead")');
    expect(refused).toContain("Hivra lead has it");
    expect(refused).toContain("Don't send him to another chat");
  });

  it("mono_message from a coding chat goes to its own Lead as a turn there, framed as Ash's ask", async () => {
    const { run, message } = await fixture();
    const out = await run("monos.message", { to: "Hivra lead", text: "Ash asked: make me a page with whats shipped this week n whats stuck" });
    expect(message).toHaveBeenCalledTimes(1);
    const call = (message.mock.calls[0] as unknown as [{ from: { id: string; name: string; session: string }; to: { id: string }; text: string }])[0];
    expect(call.to.id).toBe("hivra-lead");
    expect(call.from).toEqual({ id: "coding-team:hivra", name: "a chat in Hivra coding team", session: "chat-hivra-1" });
    expect(call.text).toContain("make me a page");
    expect(out.to).toBe("Hivra lead");
    expect(String(out.note)).toContain("Tell Ash in one line that Hivra lead has it");
    // Without a "to" it still reaches its Lead.
    await run("monos.message", { text: "one more from Ash" });
    expect(message).toHaveBeenCalledTimes(2);
  });

  it("only to its own Lead: another Mono is refused, and so are room posts", async () => {
    const { run, message } = await fixture();
    await expect(run("monos.message", { to: "ed", text: "x" })).rejects.toThrow('only to its own Lead: Hivra lead (to "hivra-lead")');
    await expect(run("rooms.post", { room: "hub", text: "hi" })).rejects.toThrow("Only a Mono's own chat talks in rooms");
    expect(message).not.toHaveBeenCalled();
  });

  it("with no Lead yet, it says so plainly", async () => {
    const { run } = await fixture(false);
    await expect(run("monos.message", { text: "x" })).rejects.toThrow("Hivra coding team has no Lead to take it yet");
  });
});
