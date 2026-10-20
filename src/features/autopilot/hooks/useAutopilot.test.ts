// @vitest-environment happy-dom
// The app hook end to end against the in-memory store: what a covered chat's question and approvals get, what the red
// list keeps for Ash, that an uncovered project is left alone, and that agents' limits are armed and come back after a
// restart.
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setHubDataSource, type HubDataSource } from "../../hub/model/hubData";
import { noteChats, resetWaitingChats, setWaitingChatsHost } from "../../hub/model/waitingChats";
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
let sent: { id: string; text: string }[];
let current: Session[];

function session(id: string, cwd: string, patch: Partial<Session> = {}): Session {
  return { ...newSession("claude", cwd), id, title: id, busy: false, ...patch };
}

let delegated = new Set<string>();

function Harness({ initial }: { initial: Session[] }) {
  const [sessions, setSessions] = useState(initial);
  current = sessions;
  const ref = { current: sessions };
  // As App.tsx wires Today's waiting list: it reads the chats and borrows these hands.
  useEffect(() => noteChats(sessions), [sessions]);
  useEffect(
    () =>
      setWaitingChatsHost({
        liveQuestion: (id) => current.find((s) => s.id === id)?.pendingQuestion,
        respond: (id, requestId, reply) => answers.push({ id, requestId, reply }),
        send: async (id, text) => {
          sent.push({ id, text });
          return true;
        },
        open: () => undefined,
      }),
    [],
  );
  useAutopilot({
    sessions,
    sessionsRef: ref,
    updateSession: (id, change) => setSessions((all) => all.map((s) => (s.id === id ? change(s) : s))),
    approve: (id, requestId, decision) => approvals.push({ id, requestId, decision }),
    openSession: async (id) => sessions.find((s) => s.id === id) ?? null,
    isDelegated: (id) => delegated.has(id),
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  answers = [];
  approvals = [];
  sent = [];
  localStorage.clear();
  resetWaitingChats();
  delegated = new Set();
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
  vi.unstubAllGlobals();
  container.remove();
  setAutopilotBackend(null);
  setHubDataSource(undefined);
});

const question = (id: string, prompt: string, options: { id: string; label: string }[]) => ({
  pendingQuestion: { requestId: 5, questions: [{ id: "q", prompt, multiSelect: false, allowCustom: true, options }] },
  id,
});

/** A tool approval; `null` for one whose provider didn't say exactly what it runs. */
const approval = (title: string, call: NonNullable<Block["approval"]>["call"] | null = { tool: "Bash", command: title }, detail?: string): Block => ({
  id: crypto.randomUUID(),
  role: "tool",
  text: title,
  tool: { title, kind: call?.tool === "Bash" ? "execute" : call?.tool.toLowerCase(), ...(detail ? { detail } : {}) },
  approval: { requestId: 9, ...(call ? { call } : {}) },
});

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
      session("line", "/Users/ash/Projects/hivra", { blocks: [{ id: "u", role: "user", text: "go" }, { id: "r", role: "assistant", text: "Done the first half.\nNeeds Ash: Keep the old endpoint for a week?\nMy pick: yes, behind a flag" }] }),
      session("nopick", "/Users/ash/Projects/hivra", { blocks: [{ id: "u", role: "user", text: "go" }, { id: "r", role: "assistant", text: "Needs Ash: Which name do you prefer?" }] }),
    ]);
    expect(answers).toEqual([{ id: "pick", requestId: 5, reply: { kind: "answered", answers: { q: ["a"] } } }]);
    expect(approvals).toEqual([{ id: "tests", requestId: 9, decision: "allow" }]);
    const byChat = Object.fromEntries(backend.entries.filter((e) => e.chatId).map((e) => [e.chatId, e]));
    expect(byChat.pick).toMatchObject({ kind: "question", outcome: "taken", recommendation: "Alpha", project: "hivra", what: "Which first?" });
    expect(byChat.money).toMatchObject({ kind: "question", outcome: "held", red: "money" });
    expect(byChat.tests).toMatchObject({ kind: "approval", outcome: "taken", recommendation: "Allowed" });
    expect(byChat.force).toMatchObject({ kind: "approval", outcome: "held", red: "mass-destructive" });
    expect(byChat.exo).toBeUndefined();
    // A "Needs Ash:" line takes its "My pick:" as Ash's go; one with no pick is handed back in words.
    expect(sent.find((m) => m.id === "line")?.text).toBe("Go with your pick: yes, behind a flag");
    expect(byChat.line).toMatchObject({ kind: "question", outcome: "taken", recommendation: "yes, behind a flag" });
    expect(sent.find((m) => m.id === "nopick")?.text).toMatch(/^Ash is away on autopilot until .* Decide this yourself/);
    expect(byChat.nopick).toMatchObject({ kind: "question", outcome: "handed_back" });
  });

  it("allows only reads, listed checks and edits in the chat's own folder; every other approval waits for Ash", async () => {
    await backend.set({ scopes: ["hivra"], untilMs: Date.now() + 48 * HOUR, by: "ash" });
    await refreshAutopilot();
    const hivra = "/Users/ash/Projects/hivra";
    const filler = "x".repeat(6_100);
    await mount([
      // What autopilot used to allow because the red list's words missed them.
      session("py", hivra, { blocks: [approval(`python3 -c "import shutil; shutil.rmtree('backups')"`)] }),
      session("b64", hivra, { blocks: [approval("echo cm0gLXJmIH4vZGF0YQ== | base64 -d | sh")] }),
      session("merge", hivra, { blocks: [approval("gh pr merge 12 --admin")] }),
      session("long", hivra, { blocks: [approval(`Write ${hivra}/notes.md`, { tool: "Write", paths: [`${hivra}/notes.md`] }, `${filler} DROP TABLE users`)] }),
      session("home", hivra, { blocks: [approval("Edit ~/.zshrc", { tool: "Edit", paths: ["/Users/ash/.zshrc"] })] }),
      session("tool", hivra, { blocks: [approval("Slack: post", { tool: "mcp__slack__post" })] }),
      session("bare", hivra, { blocks: [approval("npm test", null)] }),
      // What it allows by itself.
      session("check", hivra, { blocks: [approval("npm run check")] }),
      session("read", hivra, { blocks: [approval("Read /etc/hosts", { tool: "Read", paths: ["/etc/hosts"] })] }),
      session("edit", hivra, { blocks: [approval(`Edit ${hivra}/src/a.ts`, { tool: "Edit", paths: [`${hivra}/src/a.ts`] })] }),
      session("tree", hivra, { worktreeCwd: "/Users/ash/Worktrees/hivra-x", blocks: [approval("Edit a.ts", { tool: "Edit", paths: ["/Users/ash/Worktrees/hivra-x/a.ts"] })] }),
    ]);
    expect(approvals.map((a) => a.id).sort()).toEqual(["check", "edit", "read", "tree"]);
    const byChat = Object.fromEntries(backend.entries.filter((e) => e.chatId).map((e) => [e.chatId, e]));
    for (const id of ["py", "b64", "merge", "long", "home", "tool", "bare"])
      expect(byChat[id], id).toMatchObject({ kind: "approval", outcome: "held", detail: expect.stringMatching(/^Not allowed by itself: /) });
    expect(byChat.long.detail).toContain("too long");
    expect(byChat.check).toMatchObject({ kind: "approval", outcome: "taken" });
  });

  it("leaves a delegated worker's question to its Lead, but still decides its approvals", async () => {
    await backend.set({ scopes: ["*"], untilMs: Date.now() + 48 * HOUR, by: "ash" });
    await refreshAutopilot();
    delegated = new Set(["worker"]);
    await mount([
      session("worker", "/Users/ash/Projects/hivra", {
        ...question("worker", "Which first?", [{ id: "a", label: "Alpha (Recommended)" }]),
        blocks: [approval("npm test")],
      }),
    ]);
    expect(answers).toEqual([]);
    expect(approvals).toEqual([{ id: "worker", requestId: 9, decision: "allow" }]);
    expect(backend.entries.filter((e) => e.kind === "question")).toEqual([]);
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
