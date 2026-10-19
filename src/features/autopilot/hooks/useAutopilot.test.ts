// @vitest-environment happy-dom
// The app hook end to end against the in-memory store: what a covered chat's question and approvals get, what the red
// list keeps for Ash, that an uncovered project is left alone, and that agents' limits are armed and come back after a
// restart.
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setHubDataSource, type HubDataSource } from "../../hub/model/hubData";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import type { UserQuestionReply } from "../../sessions/model/userQuestion";
import { refreshAutopilot, setAutopilotBackend } from "../model/autopilot";
import { memoryAutopilot, type MemoryAutopilot } from "../model/memoryAutopilot";
import { useAutopilot } from "./useAutopilot";

const HOUR = 3_600_000;
let root: Root;
let container: HTMLElement;
let backend: MemoryAutopilot;
let answers: { id: string; requestId: number; reply: UserQuestionReply }[];
let approvals: { id: string; requestId: number; decision: string }[];
let current: Session[];

function session(id: string, cwd: string, patch: Partial<Session> = {}): Session {
  return { ...newSession("claude", cwd), id, title: id, busy: false, ...patch };
}

function Harness({ initial }: { initial: Session[] }) {
  const [sessions, setSessions] = useState(initial);
  current = sessions;
  const ref = { current: sessions };
  useAutopilot({
    sessions,
    sessionsRef: ref,
    updateSession: (id, change) => setSessions((all) => all.map((s) => (s.id === id ? change(s) : s))),
    answerQuestion: (id, requestId, reply) => answers.push({ id, requestId, reply }),
    approve: (id, requestId, decision) => approvals.push({ id, requestId, decision }),
    openSession: async (id) => sessions.find((s) => s.id === id) ?? null,
    isDelegated: () => false,
    openChat: () => undefined,
  });
  return null;
}

async function settle(ms = 60) {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms / 4));
    });
  }
}

async function mount(initial: Session[]) {
  await act(async () => root.render(createElement(Harness, { initial })));
  await settle();
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  answers = [];
  approvals = [];
  backend = memoryAutopilot();
  setAutopilotBackend(backend);
  setHubDataSource({
    listProjects: () => [
      { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/Users/ash/Projects/hivra" },
      { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "ghost", folder: "/Users/ash/Projects/vg-game" },
    ],
  } as unknown as HubDataSource);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setAutopilotBackend(null);
  setHubDataSource(undefined);
});

const question = (id: string, prompt: string, options: { id: string; label: string }[]) => ({
  pendingQuestion: { requestId: 5, questions: [{ id: "q", prompt, multiSelect: false, allowCustom: true, options }] },
  id,
});

const approval = (title: string): Block => ({ id: crypto.randomUUID(), role: "tool", text: title, tool: { title, kind: "execute" }, approval: { requestId: 9 } });

describe("useAutopilot", () => {
  it("while a project's switch is on, its chats take their recommendation; the red list and other projects wait", async () => {
    await backend.set({ scopes: ["hivra"], untilMs: Date.now() + 48 * HOUR, by: "ash" });
    await refreshAutopilot();
    await mount([
      session("pick", "/Users/ash/Projects/hivra", question("pick", "Which first?", [{ id: "a", label: "Alpha (Recommended)" }, { id: "b", label: "Beta" }])),
      session("money", "/Users/ash/Projects/hivra", question("money", "Charged twice: what now?", [{ id: "r", label: "Refund it (Recommended)" }])),
      session("tests", "/Users/ash/Projects/hivra", { blocks: [approval("npm run check")] }),
      session("force", "/Users/ash/Projects/hivra", { blocks: [approval("git push --force origin main")] }),
      session("exo", "/Users/ash/Projects/vg-game", question("exo", "Which first?", [{ id: "a", label: "Alpha (Recommended)" }])),
    ]);
    expect(answers).toEqual([{ id: "pick", requestId: 5, reply: { kind: "answered", answers: { q: ["a"] } } }]);
    expect(approvals).toEqual([{ id: "tests", requestId: 9, decision: "allow" }]);
    const byChat = Object.fromEntries(backend.entries.filter((e) => e.chatId).map((e) => [e.chatId, e]));
    expect(byChat.pick).toMatchObject({ kind: "question", outcome: "taken", recommendation: "Alpha", project: "hivra", what: "Which first?" });
    expect(byChat.money).toMatchObject({ kind: "question", outcome: "held", red: "money" });
    expect(byChat.tests).toMatchObject({ kind: "approval", outcome: "taken", recommendation: "Allowed" });
    expect(byChat.force).toMatchObject({ kind: "approval", outcome: "held", red: "mass-destructive" });
    expect(byChat.exo).toBeUndefined();
  });

  it("does nothing for questions while autopilot is off", async () => {
    await mount([session("pick", "/Users/ash/Projects/hivra", question("pick", "Which first?", [{ id: "a", label: "Alpha (Recommended)" }]))]);
    expect(answers).toEqual([]);
    expect(backend.entries).toEqual([]);
  });

  it("arms an agent's chat at a usage limit to resume at the reset, and shows it paused", async () => {
    const resetsAt = Date.now() + HOUR;
    await mount([session("worker", "/Users/ash/Projects/hivra", { sidebarHidden: true, usageLimit: { resetsAt } }), session("mine", "/Users/ash/Projects/hivra", { usageLimit: { resetsAt } })]);
    const worker = current.find((s) => s.id === "worker")!;
    expect(worker.usageLimit).toMatchObject({ resetsAt, resumeAtReset: true, auto: true });
    expect(worker.usageLimit!.resumeAt!).toBeGreaterThan(resetsAt);
    expect(backend.resumesById.get("worker")).toMatchObject({ state: "armed", attempts: 1 });
    expect(backend.entries.find((e) => e.kind === "resume")).toMatchObject({ outcome: "armed", chatId: "worker" });
    // Ash's own chat keeps its opt-in toggle.
    expect(current.find((s) => s.id === "mine")!.usageLimit).toEqual({ resetsAt });
  });

  it("respects a project switched off for auto-resume", async () => {
    await backend.setAutoResume({ project: "hivra", value: false });
    await refreshAutopilot();
    await mount([session("worker", "/Users/ash/Projects/hivra", { sidebarHidden: true, usageLimit: { resetsAt: Date.now() + HOUR } })]);
    expect(current[0].usageLimit?.resumeAtReset).toBeUndefined();
    expect(backend.resumesById.size).toBe(0);
  });

  it("brings an armed resume back after a restart", async () => {
    const resetsAt = Date.now() + HOUR;
    await backend.arm({ sessionId: "worker", resetsAt, resumeAt: resetsAt + 60_000 });
    // After a restart the chat has no limit in memory.
    await mount([session("worker", "/Users/ash/Projects/hivra", { sidebarHidden: true })]);
    expect(current[0].usageLimit).toMatchObject({ resetsAt, resumeAt: resetsAt + 60_000, resumeAtReset: true, auto: true });
  });
});
