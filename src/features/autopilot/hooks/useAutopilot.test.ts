// @vitest-environment happy-dom
// The app hook end to end against the in-memory store: what a covered chat's question and approvals get, what the red
// list keeps for Ash, that an uncovered project is left alone, and that agents' limits are armed and come back after a
// restart.
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setHubDataSource, type HubDataSource } from "../../hub/model/hubData";
import { noteChats, resetWaitingChats, setWaitingChatsHost, waitingChats } from "../../hub/model/waitingChats";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import type { UserQuestionReply } from "../../sessions/model/userQuestion";
import { PASS_UP_MS } from "../../chief/model/captain";
import { refreshAutopilot, setAutopilotBackend } from "../model/autopilot";
import { memoryAutopilot, type MemoryAutopilot } from "../model/memoryAutopilot";
import { pruneAutopilotMemory, useAutopilot, type AutopilotMemory } from "./useAutopilot";

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
/** The servers the app says it wired from installed plugins for a chat, by chat id. */
let wired: Record<string, string[]> = {};
const wiredServers = async (_cwd: string, sessionId: string) => new Set(wired[sessionId] ?? []);
/** Folders that are links to elsewhere, as the app resolves them (fs.rs git_locate_files); outside git: null. */
let links: Record<string, string> = {};
const OUTSIDE_GIT = "/home/user/Scratch";
const locate = async (paths: string[]) =>
  paths.map((path) => {
    if (path.startsWith(`${OUTSIDE_GIT}/`)) return null;
    const link = Object.keys(links).find((from) => path.startsWith(`${from}/`));
    const real = link ? `${links[link]}${path.slice(link.length)}` : path;
    return { root: "/home/user", relative: real.slice("/home/user/".length) };
  });
/** The canonical path of each path, links followed, as fs.rs git_canonical_paths places it (round 7). */
const canonical = async (paths: string[]) =>
  paths.map((path) => {
    const link = Object.keys(links).find((from) => path.startsWith(`${from}/`));
    return link ? `${links[link]}${path.slice(link.length)}` : path;
  });
let setAll: (change: (sessions: Session[]) => Session[]) => void = () => undefined;

function Harness({ initial }: { initial: Session[] }) {
  const [sessions, setSessions] = useState(initial);
  current = sessions;
  setAll = setSessions;
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
    locate,
    canonical,
    wiredServers,
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
  localStorage.setItem("monocode:hub-team-pack", "ash"); // Ash's install: the app's words name him (userName.ts)
  resetWaitingChats();
  delegated = new Set();
  links = {};
  wired = {};
  backend = memoryAutopilot();
  setAutopilotBackend(backend);
  setHubDataSource({
    listProjects: () => [
      { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/home/user/projects/hivra" },
      { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "ghost", folder: "/home/user/projects/vg-game" },
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

describe("what the hook remembers", () => {
  it("forgets decided approvals, closed chats' calls and past resets, and keeps what can still come back", () => {
    const now = Date.now();
    const open = session("open", "/home/user/projects/hivra", { blocks: [approval("git status")] });
    const memory: AutopilotMemory = {
      handled: new Map([
        // an approval of a chat that closed, and a question of a chat that closed and isn't waiting any more
        ["a:closed:3:y", "closed"],
        ["w:closed:line:z", "closed"],
        // a question of a closed chat that is still on the waiting list, and one of the open chat
        ["w:listed:5:q", "listed"],
        ["w:open:line:q", "open"],
      ]),
      retryAt: new Map([["w:closed:line:z", now + 30_000]]),
      triedArm: new Map([
        ["open:future", { id: "open", resetsAt: now + 3_600_000 }],
        ["open:past", { id: "open", resetsAt: now - 1 }],
        ["closed:future", { id: "closed", resetsAt: now + 3_600_000 }],
      ]),
    };
    pruneAutopilotMemory(memory, [open], ["listed"], now);
    expect([...memory.handled.keys()]).toEqual(["w:listed:5:q", "w:open:line:q"]);
    expect(memory.retryAt.size).toBe(0);
    expect([...memory.triedArm.keys()]).toEqual(["open:future"]);
  });
});

describe("useAutopilot", () => {
  it("while a project's switch is on, an allowed approval is taken; a waiting question is not the captain's answer", async () => {
    await backend.set({ scopes: ["hivra"], untilMs: Date.now() + 48 * HOUR, by: "ash" });
    await refreshAutopilot();
    await mount([
      session("pick", "/home/user/projects/hivra", question("pick", "Which first?", [{ id: "a", label: "Alpha (Recommended)" }, { id: "b", label: "Beta" }])),
      session("money", "/home/user/projects/hivra", question("money", "Charged twice: what now?", [{ id: "r", label: "Refund it (Recommended)" }])),
      session("tests", "/home/user/projects/hivra", { blocks: [approval("git status")] }),
      session("force", "/home/user/projects/hivra", { blocks: [approval("git push --force origin main")] }),
      session("exo", "/home/user/projects/vg-game", question("exo", "Which first?", [{ id: "a", label: "Alpha (Recommended)" }])),
      session("line", "/home/user/projects/hivra", { blocks: [{ id: "u", role: "user", text: "go" }, { id: "r", role: "assistant", text: "Done the first half.\nNeeds Ash: Keep the old endpoint for a week?\nMy pick: yes, behind a flag" }] }),
      session("nopick", "/home/user/projects/hivra", { blocks: [{ id: "u", role: "user", text: "go" }, { id: "r", role: "assistant", text: "Needs Ash: Which name do you prefer?" }] }),
    ]);
    // The waiting-chat door does not mark a pick confident, so neither question is stored as the captain's answer.
    // Each is logged as held while the captain waits, and nothing is sent.
    expect(answers).toEqual([]);
    expect(approvals).toEqual([{ id: "tests", requestId: 9, decision: "allow" }]);
    const byChat = Object.fromEntries(backend.entries.filter((e) => e.chatId).map((e) => [e.chatId, e]));
    expect(byChat.pick).toMatchObject({ kind: "question", outcome: "held" });
    expect(byChat.pick.detail).toMatch(/engine is down/);
    expect(byChat.money).toMatchObject({ kind: "question", outcome: "held", red: "money" });
    expect(byChat.tests).toMatchObject({ kind: "approval", outcome: "taken", recommendation: "Allowed" });
    expect(byChat.force).toMatchObject({ kind: "approval", outcome: "held", red: "mass-destructive" });
    expect(byChat.exo).toBeUndefined();
    expect(sent.find((m) => m.id === "line")).toBeUndefined();
    expect(byChat.line).toMatchObject({ kind: "question", outcome: "held" });
    expect(byChat.line.detail).toMatch(/engine is down/);
    // A question with no recommendation never reaches Waiting on you (the gate holds it in the chat), so Autopilot
    // neither takes it nor hands it back.
    expect(sent.find((m) => m.id === "nopick")).toBeUndefined();
    expect(byChat.nopick).toBeUndefined();
  });

  it("allows only reads, listed checks and edits in the chat's own folder; every other approval waits for Ash", async () => {
    await backend.set({ scopes: ["hivra"], untilMs: Date.now() + 48 * HOUR, by: "ash" });
    await refreshAutopilot();
    const hivra = "/home/user/projects/hivra";
    const filler = "x".repeat(6_100);
    await mount([
      // What autopilot used to allow because the red list's words missed them.
      session("py", hivra, { blocks: [approval(`python3 -c "import shutil; shutil.rmtree('backups')"`)] }),
      session("b64", hivra, { blocks: [approval("echo cm0gLXJmIH4vZGF0YQ== | base64 -d | sh")] }),
      session("merge", hivra, { blocks: [approval("gh pr merge 12 --admin")] }),
      session("long", hivra, { blocks: [approval(`Write ${hivra}/notes.md`, { tool: "Write", paths: [`${hivra}/notes.md`] }, `${filler} DROP TABLE users`)] }),
      session("home", hivra, { blocks: [approval("Edit ~/.zshrc", { tool: "Edit", paths: ["/home/user/.zshrc"] })] }),
      session("tool", hivra, { blocks: [approval("Slack: post", { tool: "mcp__slack__post" })] }),
      session("bare", hivra, { blocks: [approval("git status", null)] }),
      // What it allows by itself.
      session("check", hivra, { blocks: [approval("git status")] }),
      session("read", hivra, { blocks: [approval("Read /etc/hosts", { tool: "Read", paths: ["/etc/hosts"] })] }),
      session("edit", hivra, { blocks: [approval(`Edit ${hivra}/src/a.ts`, { tool: "Edit", paths: [`${hivra}/src/a.ts`] })] }),
      session("tree", hivra, { worktreeCwd: "/home/user/worktrees/hivra-x", blocks: [approval("Edit a.ts", { tool: "Edit", paths: ["/home/user/worktrees/hivra-x/a.ts"] })] }),
    ]);
    expect(approvals.map((a) => a.id).sort()).toEqual(["check", "edit", "read", "tree"]);
    const byChat = Object.fromEntries(backend.entries.filter((e) => e.chatId).map((e) => [e.chatId, e]));
    for (const id of ["py", "b64", "merge", "long", "home", "tool", "bare"])
      expect(byChat[id], id).toMatchObject({ kind: "approval", outcome: "held", detail: expect.stringMatching(/^Not allowed by itself: /) });
    expect(byChat.long.detail).toContain("too long");
    expect(byChat.check).toMatchObject({ kind: "approval", outcome: "taken" });
  });

  it("checks where an edit really lands: through a link out of the chat's folder, or outside git, it waits for Ash", async () => {
    await backend.set({ scopes: ["*"], untilMs: Date.now() + 48 * HOUR, by: "ash" });
    await refreshAutopilot();
    const tree = "/home/user/worktrees/hivra-x";
    links = {
      [`${tree}/shared`]: "/home/user/projects/hivra/shared",
      // Round 7, usability: a chat outside git whose folder holds a link out of it waits.
      [`${OUTSIDE_GIT}/notes/escape`]: "/home/user/projects/hivra/shared",
    };
    const edit = (path: string) => approval(`Edit ${path}`, { tool: "Edit", paths: [path] });
    await mount([
      session("linked", "/home/user/projects/hivra", { worktreeCwd: tree, blocks: [edit(`${tree}/shared/config.ts`)] }),
      session("plain", "/home/user/projects/hivra", { worktreeCwd: tree, blocks: [edit(`${tree}/src/a.ts`)] }),
      // Round 7, usability: outside git, an edit that really lands inside the chat's own folder is allowed.
      session("nogit", `${OUTSIDE_GIT}/notes`, { blocks: [edit(`${OUTSIDE_GIT}/notes/a.md`)] }),
      session("nogitlink", `${OUTSIDE_GIT}/notes`, { blocks: [edit(`${OUTSIDE_GIT}/notes/escape/a.md`)] }),
    ]);
    expect(approvals.map((a) => a.id).sort()).toEqual(["nogit", "plain"]);
    const byChat = Object.fromEntries(backend.entries.filter((e) => e.chatId).map((e) => [e.chatId, e]));
    expect(byChat.linked).toMatchObject({ outcome: "held", detail: expect.stringContaining("/home/user/projects/hivra/shared/config.ts, outside the chat's folder") });
    expect(byChat.nogit).toMatchObject({ outcome: "taken" });
    expect(byChat.nogitlink).toMatchObject({ outcome: "held", detail: expect.stringContaining("outside the chat's folder") });
  });

  it("holds a waiting question whose answer would send, delete, pay, publish or change access (WP-101, row 19)", async () => {
    await backend.set({ scopes: ["hivra"], untilMs: Date.now() + 48 * HOUR, by: "ash" });
    await refreshAutopilot();
    const line = (id: string, text: string) => session(id, "/home/user/projects/hivra", { blocks: [{ id: "u", role: "user", text: "go" }, { id: "r", role: "assistant", text }] });
    await mount([
      line("mail", "Needs Ash: Send the invoice to Priya?\nMy pick: yes, send it"),
      line("notes", "Needs Ash: Publish the release notes?\nMy pick: yes"),
      line("branch", "Needs Ash: Delete the old branch?\nMy pick: yes"),
      line("changelog", "Needs Ash: Post the changelog to the public site?\nMy pick: yes"),
      // WP-101 fix round 2, item F: the wider vocabulary reaches this door too.
      line("ship", "Needs Ash: Ship it?\nMy pick: yes"),
      line("merge", "Needs Ash: Should I merge the PR?\nMy pick: yes"),
      line("public", "Needs Ash: Make the repository public?\nMy pick: yes"),
      line("wire", "Needs Ash: Wire the money to the supplier?\nMy pick: yes"),
      line("migration", "Needs Ash: Run the migration?\nMy pick: yes"),
      line("ping", "Needs Ash: Ping Priya on Slack?\nMy pick: yes"),
      line("plain", "Needs Ash: Keep the old endpoint for a week?\nMy pick: yes, behind a flag"),
    ]);
    // A plain pick is not taken either: nobody marked it confident. It is logged while the captain waits.
    // The ones that send or publish are held, and nothing is sent.
    expect(sent.map((m) => m.id)).toEqual([]);
    const held = backend.entries.filter((e) => e.kind === "question" && e.outcome === "held").map((e) => e.chatId).sort();
    expect(held).toEqual(["branch", "changelog", "mail", "merge", "migration", "notes", "ping", "plain", "public", "ship", "wire"]);
    // Held ones stay on Today's waiting list for Ash, including the plain pick, which was not answered.
    expect(waitingChats().map((c) => c.sessionId).sort()).toEqual(held);
  });

  it("holds a saved question it can't read, instead of rejecting the hook (WP-101 fix round 2, item F)", async () => {
    await backend.set({ scopes: ["hivra"], untilMs: Date.now() + 48 * HOUR, by: "ash" });
    await refreshAutopilot();
    // A waiting question stored by an older build, whose options field isn't a list. It is read back from the store on
    // its own (its chat is not open here), and the hook has to leave it for Ash without throwing over the chats beside it.
    localStorage.setItem(
      "monocode:hub-waiting-chats",
      JSON.stringify({
        bad: {
          sessionId: "bad",
          source: "marker",
          question: "What next?",
          more: 0,
          pick: "keep it",
          redLine: false,
          options: 5,
          cwd: "/home/user/projects/hivra",
          title: "claude · Bad",
          askedAt: Date.now(),
        },
      }),
    );
    resetWaitingChats();
    await mount([session("good", "/home/user/projects/hivra", { blocks: [{ id: "u", role: "user", text: "go" }, { id: "r", role: "assistant", text: "Needs Ash: Keep the old endpoint?\nMy pick: yes" }] })]);
    // Nothing was sent. The unreadable one is held, and a plain pick is not the captain's answer.
    expect(sent.map((m) => m.id)).toEqual([]);
    expect(backend.entries.filter((e) => e.chatId === "bad" && e.outcome === "held")).toHaveLength(1);
    expect(backend.entries.find((e) => e.chatId === "good")).toBeUndefined();
    // The hook is still working: another change is decided the same way, and the unreadable one is still not sent.
    await act(async () =>
      setAll((all) => [...all, session("later", "/home/user/projects/hivra", { blocks: [{ id: "u", role: "user", text: "go" }, { id: "r", role: "assistant", text: "Needs Ash: Keep the old cache?\nMy pick: yes" }] })]),
    );
    await settle();
    expect(sent.map((m) => m.id)).toEqual([]);
    expect(sent.find((m) => m.id === "bad")).toBeUndefined();
    expect(backend.entries.find((e) => e.chatId === "later")).toBeUndefined();
  });

  it("allows an MCP read only from a server the app says it wired for that chat", async () => {
    await backend.set({ scopes: ["hivra"], untilMs: Date.now() + 48 * HOUR, by: "ash" });
    await refreshAutopilot();
    const hivra = "/home/user/projects/hivra";
    wired = { "wired-read": ["plugin-agent_plugins-notion"], "spoofed": ["plugin-agent_plugins-notion"] };
    const mcp = (tool: string) => approval(tool, { tool });
    await mount([
      session("wired-read", hivra, { blocks: [mcp("mcp__plugin-agent_plugins-notion__get_issue")] }),
      // Same tool name, from a chat whose wiring doesn't include that server: the name proves nothing.
      session("spoofed", hivra, { blocks: [mcp("mcp__plugin-evil-srv__get_page")] }),
      // A chat the app couldn't answer for at all: every MCP call waits.
      session("unwired", hivra, { blocks: [mcp("mcp__plugin-agent_plugins-notion__get_page")] }),
    ]);
    expect(approvals.map((a) => a.id)).toEqual(["wired-read"]);
    const byChat = Object.fromEntries(backend.entries.filter((e) => e.chatId).map((e) => [e.chatId, e]));
    for (const id of ["spoofed", "unwired"])
      expect(byChat[id], id).toMatchObject({ kind: "approval", outcome: "held", detail: expect.stringContaining("Hivra didn't install") });
  });

  it("forgets an approval once it is decided, so the same request id asking again is decided again", async () => {
    await backend.set({ scopes: ["hivra"], untilMs: Date.now() + 48 * HOUR, by: "ash" });
    await refreshAutopilot();
    await mount([session("tests", "/home/user/projects/hivra", { blocks: [approval("git status")] })]);
    expect(approvals).toHaveLength(1);
    // The app applies the decision; later (a new Claude process numbers its approvals from the start again) the same
    // request id asks for the same command.
    await act(async () => setAll((all) => all.map((s) => ({ ...s, blocks: s.blocks.map((b) => ({ ...b, approval: { ...b.approval!, decided: "allow" as const } })) }))));
    await settle();
    await act(async () => setAll((all) => all.map((s) => ({ ...s, blocks: [...s.blocks, approval("git status")] }))));
    await settle();
    expect(approvals).toHaveLength(2);
  });

  it("leaves a delegated worker's question to its Lead, but still decides its approvals", async () => {
    await backend.set({ scopes: ["*"], untilMs: Date.now() + 48 * HOUR, by: "ash" });
    await refreshAutopilot();
    delegated = new Set(["worker"]);
    await mount([
      session("worker", "/home/user/projects/hivra", {
        ...question("worker", "Which first?", [{ id: "a", label: "Alpha (Recommended)" }]),
        blocks: [approval("git status")],
      }),
    ]);
    expect(answers).toEqual([]);
    expect(approvals).toEqual([{ id: "worker", requestId: 9, decision: "allow" }]);
    expect(backend.entries.filter((e) => e.kind === "question")).toEqual([]);
  });

  it("logs a plain waiting pick, then passes it up once it has waited 10 minutes", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-11-11T12:00:00Z").getTime();
    vi.setSystemTime(start);
    try {
      await backend.set({ scopes: ["hivra"], untilMs: start + 48 * HOUR, by: "ash" });
      await refreshAutopilot();
      await act(async () => {
        root.render(createElement(Harness, {
          initial: [session("pick", "/home/user/projects/hivra", question("pick", "Which first?", [{ id: "a", label: "Alpha (Recommended)" }, { id: "b", label: "Beta" }]))],
        }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(waitingChats().map((chat) => chat.sessionId)).toContain("pick");
      expect(backend.entries.some((e) => e.kind === "switch" && e.outcome === "on")).toBe(true);
      const waiting = backend.entries.filter((e) => e.chatId === "pick" && e.kind === "question");
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toMatchObject({ outcome: "held" });
      expect(waiting[0]?.detail).toMatch(/engine is down/);
      expect(sent).toEqual([]);
      expect(answers).toEqual([]);

      vi.setSystemTime(start + PASS_UP_MS);
      await act(async () => setAll((all) => [...all]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      const rows = backend.entries.filter((e) => e.chatId === "pick" && e.kind === "question");
      expect(rows).toHaveLength(2);
      expect(rows[1]?.detail).toMatch(/Chief of Staff suggests|did not answer within/);
      expect(sent).toEqual([]);
      expect(answers).toEqual([]);
      expect(waitingChats().some((chat) => chat.sessionId === "pick")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing for questions while autopilot is off", async () => {
    await mount([session("pick", "/home/user/projects/hivra", question("pick", "Which first?", [{ id: "a", label: "Alpha (Recommended)" }]))]);
    expect(answers).toEqual([]);
    expect(backend.entries).toEqual([]);
  });

  it("arms an agent's chat at a usage limit to resume at the reset, and shows it paused", async () => {
    const resetsAt = Date.now() + HOUR;
    await mount([session("worker", "/home/user/projects/hivra", { sidebarHidden: true, usageLimit: { resetsAt } }), session("mine", "/home/user/projects/hivra", { usageLimit: { resetsAt } })]);
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
    await mount([session("worker", "/home/user/projects/hivra", { sidebarHidden: true, usageLimit: { resetsAt: Date.now() + HOUR } })]);
    expect(current[0].usageLimit?.resumeAtReset).toBeUndefined();
    expect(backend.resumesById.size).toBe(0);
  });

  it("brings an armed resume back after a restart", async () => {
    const resetsAt = Date.now() + HOUR;
    await backend.arm({ sessionId: "worker", resetsAt, resumeAt: resetsAt + 60_000 });
    // After a restart the chat has no limit in memory.
    await mount([session("worker", "/home/user/projects/hivra", { sidebarHidden: true })]);
    expect(current[0].usageLimit).toMatchObject({ resetsAt, resumeAt: resetsAt + 60_000, resumeAtReset: true, auto: true });
  });
});
