// @vitest-environment happy-dom
// The app's live sources against the app's real stores (the Monos roster, the delegation rows, Waiting on you and the
// chats): a page watching agents.read hears about each change and reads it as it is now.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { noteChats, resetWaitingChats } from "../../hub/model/waitingChats";
import { resetDelegationStore, setDelegationRows } from "../../monos/model/delegationStore";
import type { Delegation } from "../../monos/model/delegations";
import { addMono } from "../../monos/model/mono";
import type { Session } from "../../sessions/model/session";
import { SessionStateStore } from "../../sessions/model/sessionStateStore";
import { PageBridgeHost } from "./pageBridgeHost";
import { STUCK_QUIET_MS, type AgentsData } from "./pageData";
import { AGENTS_TICK_MS, appPageSources } from "./pageSources";

const session = (id: string, over: Partial<Session> = {}): Session =>
  ({ id, harness: "claude", model: "", modelSettings: {}, runtimeMode: "default", title: id, cwd: "/p/vg-game", blocks: [], ...over }) as Session;
const row = (id: string, over: Partial<Delegation> = {}) =>
  ({ id, ownerSession: "s-exo", childSession: `w-${id}`, state: "running", title: `Example: ${id}`, createdAt: 1, updatedAt: 1, settledAt: null, ...over }) as Delegation;

let now = 1_800_000_000_000;
beforeEach(() => {
  localStorage.clear();
  resetDelegationStore();
  resetWaitingChats();
  addMono({ id: "vg-game-lead", sessionId: "s-exo", mascot: "letter", color: "#000", projects: [] });
});
afterEach(() => vi.useRealTimers());

it("a watching page hears every change to the agents and reads them as they are now", async () => {
  vi.useFakeTimers();
  const store = new SessionStateStore([session("s-exo", { busy: true }), session("w-d1", { busy: true })]);
  const sent: { type: string; data?: AgentsData }[] = [];
  const host = new PageBridgeHost({
    pageId: "pg", title: "Agents", live: true, asks: ["agents.read"], approved: () => ["agents.read"], tapped: () => false,
    post: (m) => sent.push(m as never), sources: appPageSources(store, () => now), throttleMs: 50,
  });
  host.receive({ type: "hub:watch", id: "w", call: "agents.read" });
  const last = () => sent.filter((m) => m.type === "hub:data").at(-1)!.data!.agents[0];
  expect(last()).toMatchObject({ name: "EXO lead", state: "working", workers: [] });

  // The Lead hands out work: the delegation feed moves, the page sees the worker.
  setDelegationRows([row("d1")]);
  await vi.advanceTimersByTimeAsync(60);
  expect(last().workers.map((w) => [w.id, w.state])).toEqual([["d1", "working"]]);

  // The worker asks the Lead a question (its row says so).
  setDelegationRows([row("d1", { state: "question", pendingQuestion: "Example: keep the old saves?" })]);
  await vi.advanceTimersByTimeAsync(60);
  expect(last().workers[0]).toMatchObject({ state: "asking", question: { text: "Example: keep the old saves?" } });

  // The Lead's own chat asks Ash: Waiting on you has it, so the page does.
  noteChats([{ ...session("s-exo"), busy: false, blocks: [{ id: "b", role: "assistant", text: "Needs Ash: ship today or tomorrow?\nMy pick: today" }] } as never]);
  await vi.advanceTimersByTimeAsync(60);
  expect(last()).toMatchObject({ state: "asking", question: { chatId: "s-exo", pick: "today" } });

  // A busy worker chat with no new word for ten minutes reads as stuck, by itself (the clock ticks).
  setDelegationRows([row("d1")]);
  await vi.advanceTimersByTimeAsync(60);
  now += STUCK_QUIET_MS + 60_000;
  await vi.advanceTimersByTimeAsync(AGENTS_TICK_MS + 60);
  expect(last().workers[0]).toMatchObject({ state: "stuck", reason: "No progress for 11 min." });

  // A new word from the worker: working again.
  store.update((all) => all.map((s) => (s.id === "w-d1" ? { ...s, blocks: [{ id: "t", role: "tool", text: "", tool: { title: "Run the save tests" } } as never] } : s)));
  await vi.advanceTimersByTimeAsync(60);
  expect(last().workers[0]).toMatchObject({ state: "working", doing: "Run the save tests" });
  host.dispose();
});
