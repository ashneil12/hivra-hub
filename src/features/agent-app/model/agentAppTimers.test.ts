// @vitest-environment happy-dom
// Hivra WP-11: timers a first mate sets (agentAppTimers.ts): who may set one, when it falls due, and that a chat only
// lists and cancels its own. The store is a stand-in with watcher/timers.rs's owner rule.
import { describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import type { Timer } from "../../firstmate/watcher/wakeQueue";
import { handleAgentApp, type AgentAppHost } from "./agentApp";
import { dueAt, type AgentAppTimersHost } from "./agentAppTimers";

vi.mock("../../../integrations/harness/core/availability", () => ({ isHarnessAvailable: () => true }));

function fixture(who: "mono" | "team" | "worker") {
  const source: Session = { ...newSession("claude", "/code/hivra", "claude:opus-5-5"), id: who === "worker" ? "app-w1" : `chat-${who}` };
  const timers: Timer[] = [];
  const api: AgentAppTimersHost = {
    timerSet: vi.fn(async (input) => {
      const timer = { id: `timer-${timers.length + 1}`, ...input, state: "armed", createdAt: 0 };
      timers.push(timer);
      return timer;
    }),
    timerCancel: vi.fn(async (owner, id) => {
      const found = timers.find((t) => t.id === id && t.ownerSession === owner && t.state === "armed");
      if (found) found.state = "cancelled";
      return found ?? null;
    }),
    timers: vi.fn(async (owner) => timers.filter((t) => t.ownerSession === owner && t.state === "armed")),
  };
  const host = {
    isMono: () => who === "mono",
    monoOf: () => (who === "mono" ? { id: "hivra-lead", name: "Hivra lead", projects: ["/code/hivra"] } : undefined),
    codingTeamOf: () => (who === "team" ? { project: "hivra", name: "Hivra coding team", folder: "/code/hivra" } : undefined),
    timers: api,
  } as unknown as AgentAppHost;
  return { source, host, api, timers };
}

describe("timers.*", () => {
  it("a Mono's chat or a coding-team chat sets one for itself, and is told to end its turn", async () => {
    for (const who of ["mono", "team"] as const) {
      const { source, host, timers } = fixture(who);
      const set = (await handleAgentApp(source, "r1", "timers.set", { inMinutes: 60, note: "look at the deploy" }, host)) as { note: string };
      expect(timers[0]).toMatchObject({ ownerSession: source.id, note: "look at the deploy" });
      expect(set.note).toContain("[MonoCode watcher]");
      expect(set.note).toContain("don't poll");
    }
  });

  it("a worker can't: it reports to the chat that delegated it", async () => {
    const { source, host } = fixture("worker");
    await expect(handleAgentApp(source, "r1", "timers.set", { inMinutes: 5, note: "x" }, host)).rejects.toThrow(/Only a first mate/);
  });

  it("lists and cancels only the chat's own", async () => {
    const { source, host, timers } = fixture("mono");
    await handleAgentApp(source, "r1", "timers.set", { inMinutes: 5, note: "check CI" }, host);
    timers.push({ id: "timer-other", ownerSession: "someone-else", dueAt: 0, note: "theirs", state: "armed", createdAt: 0 });
    expect(await handleAgentApp(source, "r2", "timers.list", {}, host)).toEqual({ timers: [expect.objectContaining({ id: "timer-1", note: "check CI" })] });
    await expect(handleAgentApp(source, "r3", "timers.cancel", { id: "timer-other" }, host)).rejects.toThrow(/No timer/);
    expect(await handleAgentApp(source, "r4", "timers.cancel", { id: "timer-1" }, host)).toEqual({ id: "timer-1", cancelled: true });
  });

  it("takes inMinutes or an ISO time, never both, and refuses nonsense", () => {
    expect(dueAt({ inMinutes: 30 }, 1_000)).toBe(1_000 + 30 * 60_000);
    expect(dueAt({ at: "2026-11-04T09:00:00Z" }, 0)).toBe(Date.parse("2026-11-04T09:00:00Z"));
    expect(() => dueAt({}, 0)).toThrow(/inMinutes or at/);
    expect(() => dueAt({ inMinutes: 5, at: "2026-11-04T09:00:00Z" }, 0)).toThrow(/not both/);
    expect(() => dueAt({ inMinutes: 0 }, 0)).toThrow(/from 1/);
    expect(() => dueAt({ at: "tomorrow" }, 0)).toThrow(/ISO time/);
  });
});
