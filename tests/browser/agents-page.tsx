// The ready-made Agents page, kept, in the real Pages screen with the real bridge (pageBridgeHost, pageSources,
// pageActions) on the app's real stores: the Monos roster, a sessions store, the delegation rows and Waiting on you. What
// is faked is only the app's own hands (App.tsx lends them): answering a question in a chat, sending, opening and the
// delegation tree's Stop. Each records what it was asked and moves the stores the way the app would, so the page has to
// pick the change up live. window.fixture moves things; window.proof says what the hands were asked.
import { createRoot } from "react-dom/client";
import { setHubDataSource, hubData } from "../../src/features/hub/model/hubData";
import { noteChats, setWaitingChatsHost } from "../../src/features/hub/model/waitingChats";
import type { HubDataSource } from "../../src/features/hub/model/types";
import { delegationRows, setDelegationActions, setDelegationRows } from "../../src/features/monos/model/delegationStore";
import type { Delegation } from "../../src/features/monos/model/delegations";
import { addMono } from "../../src/features/monos/model/mono";
import type { Session } from "../../src/features/sessions/model/session";
import { SessionStateContext, SessionStateStore } from "../../src/features/sessions/model/sessionStateStore";
import type { UserQuestionPrompt, UserQuestionReply } from "../../src/features/sessions/model/userQuestion";
import { setPageActionsHost } from "../../src/features/pages/model/pageActions";
import { keepPage, pageFromSpec, requestOpenPage, setPagesBackend } from "../../src/features/pages/model/pages";
import { AGENTS_PAGE, AGENTS_READY, READY_BY } from "../../src/features/pages/model/readyPages";
import { PagesContent } from "../../src/features/pages/ui/PagesView";
import "../../src/styles/index.css";

localStorage.clear();
const NOW = Date.now();
const MIN = 60_000;

// The hub's projects (no Ash OS here: no live store, pages on this Mac).
const base = hubData();
const src = Object.create(base) as HubDataSource;
src.listProjects = () => [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/Users/example/Projects/vg-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/Users/example/Projects/hivra" },
];
src.listNeeds = () => [];
setHubDataSource(src);
setPagesBackend("local");

// The roster: the team and two Leads.
for (const m of [
  { id: "chief-of-staff", name: "Chief of Staff" }, { id: "projects-manager", name: "Projects Manager" }, { id: "frank", name: "frank", sessionId: "s-frank" },
  { id: "alfred", name: "Alfred" }, { id: "vg-game-lead", name: "EXO lead", sessionId: "s-exo" }, { id: "hivra-lead", name: "Hivra lead", sessionId: "s-hivra" },
]) addMono({ mascot: "letter", color: "#888", projects: [], ...m });

const session = (id: string, over: Partial<Session> = {}): Session =>
  ({ id, harness: "claude", model: "", modelSettings: {}, runtimeMode: "default", title: id, cwd: "/Users/example/Projects/vg-game", blocks: [], ...over }) as Session;
const tool = (title: string) => [{ id: `t-${title}`, role: "tool", text: "", tool: { title } }] as Session["blocks"];
const store = new SessionStateStore([
  session("s-exo", { busy: true, blocks: tool("Reading the save system") }),
  session("s-hivra", { busy: true, cwd: "/Users/example/Projects/hivra", blocks: tool("Drafting the waitlist email") }),
  session("s-frank"),
  session("w-d1", { busy: true, blocks: tool("Running the save tests") }),
  session("w-d2", { busy: true, blocks: tool("Comparing the slot layouts") }),
  session("w-d3", { busy: true, blocks: tool("Building 0.15") }),
]);
const row = (id: string, owner: string, title: string, over: Partial<Delegation> = {}): Delegation => ({
  id, ownerSession: owner, ownerMono: null, batchId: null, parentId: null, rootId: id, childSession: `w-${id}`, requestId: id, generation: 1, project: "vg-game",
  title, brief: null, goal: null, askIds: [], state: "running", errorClass: null, error: null, retryable: null, resetsAt: null, result: null,
  pendingQuestion: null, delivery: "pending", deliveryMessage: null, createdAt: NOW - 30 * MIN, updatedAt: NOW - 30 * MIN, settledAt: null, log: [],
  version: 1, mirroredVersion: 1, mirrorError: null, ...over,
});
setDelegationRows([
  row("d1", "s-exo", "Fix the save bug"),
  row("d2", "s-exo", "Pick the save slot layout"),
  row("d3", "s-exo", "Build 0.15 for the playtest"),
  row("d4", "s-hivra", "Check the pricing page", { state: "completed", settledAt: NOW - 20 * MIN, updatedAt: NOW - 20 * MIN }),
]);

const setRow = (id: string, change: Partial<Delegation>) => setDelegationRows(delegationRows().map((r) => (r.id === id ? { ...r, ...change, updatedAt: Date.now() } : r)));
const setSession = (id: string, change: Partial<Session>) => store.update((all) => all.map((s) => (s.id === id ? { ...s, ...change } : s)));

// The app's hands, recorded. Answering a worker's question clears it in its chat and the worker goes back to work.
const proof = { responds: [] as { id: string; requestId: number; reply: UserQuestionReply }[], sent: [] as { id: string; text: string }[], opened: [] as string[], stops: [] as { kind: string; id: string }[] };
(window as unknown as { proof: typeof proof }).proof = proof;
const respond = (id: string, requestId: number, reply: UserQuestionReply) => {
  proof.responds.push({ id, requestId, reply });
  setSession(id, { pendingQuestion: undefined, blocks: tool("Laying out three slots") });
  const r = delegationRows().find((x) => x.childSession === id);
  if (r) setRow(r.id, { state: "running", pendingQuestion: null });
};
setPageActionsHost({
  liveQuestion: (id) => store.session(id)?.pendingQuestion,
  respond,
  send: async (id, text) => { proof.sent.push({ id, text }); return true; },
  open: (id) => void proof.opened.push(id),
  openMono: (id) => void proof.opened.push(`mono:${id}`),
});
setWaitingChatsHost({
  liveQuestion: (id) => store.session(id)?.pendingQuestion,
  respond,
  send: async (id, text) => {
    proof.sent.push({ id, text });
    setSession(id, { busy: true, blocks: tool("Shipping to the testers") });
    noteChats(store.snapshot());
    return true;
  },
  open: (id) => void proof.opened.push(id),
});
setDelegationActions({
  openOwner: (s) => void proof.opened.push(`owner:${s}`),
  openChild: (_o, c) => void proof.opened.push(`child:${c}`),
  stopTree: async (chat) => { proof.stops.push({ kind: "stopTree", id: chat }); return { stopped: [chat], cancelled: [], stopFailed: [] }; },
  stopRow: async (r) => {
    proof.stops.push({ kind: "stopRow", id: r.id });
    setRow(r.id, { state: "cancelled", error: "Stopped by Ash.", settledAt: Date.now() });
    setSession(r.childSession, { busy: false });
    return { stopped: [r.childSession], cancelled: [r.id], stopFailed: [] };
  },
});

// What the test moves.
const slotQuestion: UserQuestionPrompt = { requestId: 7, questions: [{ id: "layout", prompt: "Three save slots or five?", multiSelect: false, allowCustom: true,
  options: [{ id: "three", label: "Three slots (Recommended)" }, { id: "five", label: "Five slots" }] }] };
(window as unknown as { fixture: unknown }).fixture = {
  /** The worker picking the slot layout asks its Lead a question (its chat asks; its row says so). */
  workerAsks() {
    setSession("w-d2", { pendingQuestion: slotQuestion });
    setRow("d2", { state: "question", pendingQuestion: "Three save slots or five?" });
  },
  /** The build worker goes quiet: its Lead still has it, so it is not Needs you (r30). */
  workerStuck() {
    setRow("d3", { stallKind: "quiet", stallReason: "Still running npm run build", stalledAt: Date.now() - 12 * MIN });
  },
  /** A worker fails because the provider is out of credits: red Needs you (r30). It is already finished, so it can't be stopped. */
  workerFailed() {
    setDelegationRows([...delegationRows(), row("d5", "s-exo", "Ship the save fix", { state: "failed", errorClass: "billing", error: "402", settledAt: Date.now() })]);
  },
  /** Hivra lead ends its turn asking Ash (Waiting on you). */
  leadAsks() {
    setSession("s-hivra", { busy: false, blocks: [{ id: "a", role: "assistant", text: "The welcome email is ready.\nNeeds Ash: send it to the waitlist today or wait for the new headline?\nMy pick: send it today" }] as Session["blocks"] });
    noteChats(store.snapshot());
  },
};

// Ash kept the ready-made page (Keep and allow), then opened it.
const kept = { ...pageFromSpec(AGENTS_PAGE, AGENTS_READY, READY_BY, "today", [], NOW - 60 * MIN), id: "page-agents" };
void keepPage(kept).then(() => {
  requestOpenPage(kept.id);
  createRoot(document.getElementById("root")!).render(
    <SessionStateContext.Provider value={store}>
      <PagesContent />
    </SessionStateContext.Provider>,
  );
});
