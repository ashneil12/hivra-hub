// The room taking turns (docs/leadership/ROOM.md; the rules are roomTurns.ts). Event driven, like the Grok-era
// Leadership Board Ash liked:
//
// - Ash writes: whatever the room was doing in that conversation stops at once (running room turns are stopped through
//   the app's Stop, waiting ones dropped), and the host answers first, now. His messages since the last answer are
//   answered together. Then each other seat may add one reply to his message (the chime gate picks who may have
//   something new); a short message gets the host's answer alone.
// - A Mono's post (its turn's reply, or room_post) wakes the seats it names. That is how the review loop runs without
//   Ash: builder posts, reviewers pass or flag, the builder answers, the retake, "pass from me", "Locked". It ends when
//   nobody names anybody, and the guards pause it for Ash when posts stop making progress, two seats ping-pong, or the
//   ceiling is hit (40 posts or 30 minutes without him); "keep going" carries on.
// - When three or more seats spoke, the host closes the stretch with a digest.
// - Up to MAX_PARALLEL_TURNS turns run at once in a room, one per Mono. Each turn runs in the Mono's own session through
//   the app's runner: a managed turn when the Mono is free (its reply is the post), or, when it is busy in its own
//   chat, a room wake that goes into its work (steered or queued behind it) and that it answers with room_post. A busy
//   Mono is never refused and nothing is dropped quietly: every failure leaves a notice in the thread.
// - Work a Mono delegated from the room comes back as "X is back" (postBack, roomReports.ts); a Lead's report on a
//   leadership brief lands with its owner's answer (postReport).
import { listMonos } from "../../monos/model/mono";
import { examplesOn } from "./examples";
import {
  appendMessage,
  getChat,
  newMessageId,
  notify,
  react,
  setAnsweredThrough,
  setRoomRuntime,
  settleNotice,
  unanswered,
} from "./hubChats";
import { leadFor } from "./hubLeads";
import {
  addressedIn,
  answerPick,
  chimePrompt,
  cleanPost,
  DIGEST_SEATS,
  draftShowable,
  failureNotice,
  hostOf,
  isProgress,
  isShortMessage,
  isSilent,
  laneChimes,
  MAX_PARALLEL_TURNS,
  MONO_POSTS_CEILING,
  parseChimes,
  pingPong,
  QUIET_CEILING_MS,
  reviewChimes,
  roomTranscript,
  STALE_POSTS_LIMIT,
  turnPrompt,
  type Chime,
  type Pick,
  type Seat,
  type TurnKind,
} from "./roomTurns";
import type { ChatMessage, ChatPickSource, GroupChat } from "./types";

// ---- The app's side: the runner and the router ------------------------------------------------------------------

/** The quiet line a room turn leaves in the Mono's own chat. */
export type RoomTurnNote = { kind: "room"; room: string; roomId: string; line: string };
export type RoomTurnRequest = {
  monoId: string;
  chatId: string;
  convId: string;
  /** The turn's id: a waiting wake's queue id, and what stop() names. */
  wakeId: string;
  /** The managed turn's prompt: its reply is the post. */
  prompt: string;
  /** The same turn for a busy Mono: it answers with room_post. */
  wakePrompt: string;
  note: RoomTurnNote;
  /** A managed turn's words so far, as they are written (the runner calls it as they grow): the room shows them live. */
  onText?(text: string): void;
};
export type RoomWakeEnd = { status: "done" | "dropped" | "failed"; error?: string };
/** A managed turn's reply, or a wake that went into a busy Mono's chat (steered into its work, or queued behind it). */
export type RoomTurnOutcome =
  | { kind: "reply"; text: string }
  | { kind: "wake"; delivery: "queued" | "steered"; done: Promise<RoomWakeEnd> };
export type GroupChatRunner = {
  run(request: RoomTurnRequest): Promise<RoomTurnOutcome>;
  /** Stop a running room turn (the app's Stop) or take a waiting wake back out of the Mono's queue. */
  stop?(monoId: string, wakeId: string): Promise<void> | void;
};
/** The older shape (a Mono and a prompt, the reply back): always a managed turn. */
export type GroupChatRunFn = (monoId: string, prompt: string) => Promise<string>;

let runner: GroupChatRunner | undefined;
/** The app supplies its normal Mono session engine; the room never invents an answer. */
export function setGroupChatRunner(next: GroupChatRunner | GroupChatRunFn): () => void {
  const wrapped: GroupChatRunner =
    typeof next === "function" ? { run: async (request) => ({ kind: "reply", text: await next(request.monoId, request.prompt) }) } : next;
  runner = wrapped;
  return () => {
    if (runner === wrapped) runner = undefined;
  };
}
/** A runner may still say a Mono can't take the turn; it becomes a notice like any failure. */
export class MonoBusyError extends Error {}

/**
 * The cheap router: one isolated prompt to the smallest model, text back. Without one, or when it doesn't answer in
 * time, fails or answers something that isn't its JSON, the lane rules decide: a seat is never dropped silently.
 */
export type RoomRouter = (prompt: string) => Promise<string>;
/** How long the gate may take (a helper call answers in about 2 s since 20 Oct). */
export const ROUTER_TIMEOUT_MS = 15_000;
let router: RoomRouter | undefined;
let routerTimeoutMs = ROUTER_TIMEOUT_MS;
export function setRoomRouter(next: RoomRouter, options: { timeoutMs?: number } = {}): () => void {
  router = next;
  routerTimeoutMs = options.timeoutMs ?? ROUTER_TIMEOUT_MS;
  return () => {
    if (router === next) router = undefined;
  };
}
/** The gate's answer, or why there is none (no router, it timed out, it failed). */
async function askRouter(prompt: string): Promise<{ out: string } | { missed: string }> {
  const ask = router;
  if (!ask) return { missed: "no gate" };
  let timer: number | undefined;
  try {
    const out = await Promise.race([
      ask(prompt),
      new Promise<undefined>((resolve) => {
        timer = window.setTimeout(() => resolve(undefined), routerTimeoutMs);
      }),
    ]);
    return out === undefined ? { missed: `the gate took over ${Math.round(routerTimeoutMs / 1000)} s` } : { out };
  } catch (error) {
    return { missed: `the gate failed (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    window.clearTimeout(timer);
  }
}

// ---- State --------------------------------------------------------------------------------------------------------

type Wake = {
  id: string;
  monoId: string;
  convId: string;
  kind: TurnKind;
  by: ChatPickSource;
  why: string;
  /** Who it answers (a chime: the host; a reply: who named it). */
  other?: string;
  /** The message that woke it (what its post replies to). */
  trigger?: string;
  /**
   * The round it answers: the message the poster that woke it was answering. It waits until every turn of that round is
   * done, so a builder flagged by two reviewers answers both flags in one message.
   */
  after?: string;
  /** The conversation's generation it belongs to (-1: never stale, work coming back). */
  gen: number;
  /** An answer: Ash's messages it takes up. */
  batch?: string[];
  seatsSpoke?: number;
  back?: { title: string; answer: string };
};
type Running = { wake: Wake; mode: "turn" | "queued" | "steered"; startedAt: number; answered?: boolean };
/**
 * A turn's words as it writes them, shown in the room as a live message until the turn ends (then the post takes its
 * place, under the same id) or is stopped (then it goes). Never saved: the Mono's own chat keeps the turn.
 */
export type RoomDraft = {
  id: string;
  monoId: string;
  convId: string;
  text: string;
  replyTo?: string;
  quiet: boolean;
  pick: { by: ChatPickSource; why: string };
  startedAt: number;
};
type Draft = RoomDraft & { wakeId: string; gen: number };
type PauseReason = "ceiling" | "stalled" | "stopped";
type Thread = {
  gen: number;
  /** Mono posts since Ash's last message (or "keep going"). */
  posts: number;
  since: number;
  /** Posts in a row that said nothing new. */
  stale: number;
  authors: string[];
  /** Seats that spoke since Ash's last message or the host's last digest. */
  spoke: Set<string>;
  /** Seats that already added their one reply to Ash's message. */
  chimed: Set<string>;
  routing: number;
  paused?: { reason: PauseReason; wakes: Wake[] };
};
type RoomRun = {
  queue: Wake[];
  running: Map<string, Running>;
  threads: Map<string, Thread>;
  pick?: Pick;
  idle: { convId?: string; resolve: () => void }[];
  /** Notices whose Try again runs this wake again. */
  retries: Map<string, Wake>;
  /** room_post times per Mono (the rate limit). */
  posts: Map<string, number[]>;
  /** Live words of running managed turns, by wake id. */
  drafts: Map<string, Draft>;
};
const rooms = new Map<string, RoomRun>();

function roomOf(chatId: string): RoomRun {
  let r = rooms.get(chatId);
  if (!r) {
    r = { queue: [], running: new Map(), threads: new Map(), idle: [], retries: new Map(), posts: new Map(), drafts: new Map() };
    rooms.set(chatId, r);
  }
  return r;
}
function threadOf(r: RoomRun, convId: string): Thread {
  let t = r.threads.get(convId);
  if (!t) {
    t = { gen: 0, posts: 0, since: Date.now(), stale: 0, authors: [], spoke: new Set(), chimed: new Set(), routing: 0 };
    r.threads.set(convId, t);
  }
  return t;
}

let wakeSeq = 0;
const newWakeId = (monoId: string) => `room-${Date.now().toString(36)}-${monoId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30)}-${++wakeSeq}`;

/** The chat's members as the room's seats: their names, and a Lead's project as another name for it. */
export function seatsOf(chat: GroupChat): Seat[] {
  const roster = listMonos();
  return chat.memberIds.map((id) => {
    // A member no longer on the roster keeps its seat; the runner says so if it is woken.
    const mono = roster.find((m) => m.id === id);
    const name = mono?.name?.trim() || id;
    const lead = leadFor(id);
    return {
      id,
      name,
      ...(mono?.engine ? { engine: mono.engine } : {}),
      ...(lead
        ? {
            aliases: [lead.projectName, `${lead.projectName} lead`],
            card: `${name}: runs ${lead.projectName}'s work and its workers; answers about ${lead.projectName} itself. Not: other projects.`,
          }
        : {}),
    };
  });
}
function nameOf(id: string): string {
  if (id === "ash") return "Ash";
  return listMonos().find((m) => m.id === id)?.name?.trim() || id;
}
const isMonoPost = (m: ChatMessage) => (m.kind ?? (m.from === "ash" ? "ash" : "mono")) === "mono";
function busyIn(r: RoomRun, convId?: string): boolean {
  const here = (id: string) => convId === undefined || id === convId;
  if (r.queue.some((w) => here(w.convId))) return true;
  for (const run of r.running.values()) if (here(run.wake.convId)) return true;
  for (const [id, t] of r.threads) if (here(id) && t.routing > 0) return true;
  return false;
}
function stale(r: RoomRun, wake: Wake): boolean {
  return wake.gen >= 0 && wake.gen !== threadOf(r, wake.convId).gen;
}

// ---- What the screens read ----------------------------------------------------------------------------------------

export type RoomWorker = { monoId: string; convId: string; kind: TurnKind; state: "writing" | "queued" | "steered" };
/** Who is working on a room turn now, and how: writing it, or answering from their own chat. */
export function roomWorking(chatId: string, convId?: string): RoomWorker[] {
  const r = rooms.get(chatId);
  if (!r) return [];
  return [...r.running.values()]
    .filter((x) => !convId || x.wake.convId === convId)
    .filter((x) => !(x.mode !== "turn" && x.answered))
    .map((x) => ({ monoId: x.wake.monoId, convId: x.wake.convId, kind: x.wake.kind, state: x.mode === "turn" ? "writing" : x.mode }));
}
/** The first Mono writing in the room (the older single indicator). */
export function typingIn(chatId: string): string | undefined {
  return roomWorking(chatId)[0]?.monoId;
}
/** The chime gate is deciding who else may speak. */
export function roomRouting(chatId: string, convId?: string): boolean {
  const r = rooms.get(chatId);
  if (!r) return false;
  for (const [id, t] of r.threads) if ((!convId || id === convId) && t.routing > 0) return true;
  return false;
}
/** Anything running or waiting to run in the room (or one conversation): Stop applies. */
export function roomActive(chatId: string, convId?: string): boolean {
  const r = rooms.get(chatId);
  return !!r && busyIn(r, convId);
}
/** The conversation paused for Ash (the ceiling, no progress, or his Stop). */
export function roomPaused(chatId: string, convId?: string): boolean {
  return !!roomPauseReason(chatId, convId);
}
export function roomPauseReason(chatId: string, convId?: string): PauseReason | undefined {
  const r = rooms.get(chatId);
  if (!r) return undefined;
  if (convId) return r.threads.get(convId)?.paused?.reason;
  for (const t of r.threads.values()) if (t.paused) return t.paused.reason;
  return undefined;
}
/** The words running turns have written so far (oldest first): the room shows each as a live message. */
export function roomDrafts(chatId: string, convId?: string): RoomDraft[] {
  const r = rooms.get(chatId);
  if (!r) return [];
  return [...r.drafts.values()]
    .filter((d) => !convId || d.convId === convId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(({ wakeId: _w, gen: _g, ...draft }) => draft);
}
/** A turn's words so far: shown once they can't be NO_REPLY or an acknowledgement, and only while the turn counts. */
function showDraft(chatId: string, wake: Wake, me: Seat, text: string): void {
  const r = roomOf(chatId);
  if (stale(r, wake) || r.running.get(me.id)?.wake !== wake) return;
  const clean = cleanPost(text, me.name);
  const existing = r.drafts.get(wake.id);
  if (existing ? existing.text === clean : !draftShowable(clean)) return;
  r.drafts.set(
    wake.id,
    existing
      ? { ...existing, text: clean }
      : {
          id: newMessageId(me.id),
          wakeId: wake.id,
          gen: wake.gen,
          monoId: me.id,
          convId: wake.convId,
          text: clean,
          ...(wake.trigger ? { replyTo: wake.trigger } : {}),
          quiet: wake.kind === "chime" || wake.kind === "reply",
          pick: { by: wake.by, why: wake.why },
          startedAt: Date.now(),
        },
  );
  notify();
}
/** The turn is over: its live words go (the caller posts the final ones under the same id). */
function takeDraft(r: RoomRun, wake: Wake): Draft | undefined {
  const draft = r.drafts.get(wake.id);
  if (draft) r.drafts.delete(wake.id);
  return draft;
}
/** Live words of turns Ash or Stop overtook go at once. */
function pruneDrafts(r: RoomRun): void {
  for (const [id, d] of r.drafts) if (d.gen >= 0 && d.gen !== threadOf(r, d.convId).gen) r.drafts.delete(id);
}

/** Who was picked to answer Ash's last message, and why. */
export function roomPick(chatId: string): Pick | undefined {
  return rooms.get(chatId)?.pick;
}
export function replyProblem(chatId: string, convId?: string): string | undefined {
  const chat = getChat(chatId);
  return convId && chat?.replyConversationId !== convId ? undefined : chat?.replyError;
}
/** Resolves once nothing runs or waits in the room (or in one conversation). */
export function roomIdle(chatId: string, convId?: string): Promise<void> {
  const r = roomOf(chatId);
  if (!busyIn(r, convId)) return Promise.resolve();
  return new Promise((resolve) => r.idle.push({ convId, resolve }));
}
/** The room and conversation a Mono's managed room turn is running in now (its delegations come back there). */
export function roomTurnOf(monoId: string): { chatId: string; convId: string } | undefined {
  for (const [chatId, r] of rooms) {
    const run = r.running.get(monoId);
    if (run?.mode === "turn") return { chatId, convId: run.wake.convId };
  }
  return undefined;
}

// ---- Ash writes ---------------------------------------------------------------------------------------------------

/**
 * Ash wrote in a conversation: it stops what it was doing, and the room answers his message(s). Resolves once the
 * conversation has gone quiet again (the tests wait on it; the screens don't).
 */
export function requestReply(chatId: string, convId?: string): Promise<void> {
  const chat = getChat(chatId);
  const conv = chat?.conversations.find((c) => c.id === convId) ?? chat?.conversations[0];
  if (!chat || !conv) return Promise.resolve();
  return onAsh(chatId, conv.id) ? roomIdle(chatId, conv.id) : Promise.resolve();
}

/** The answer failed and Ash pressed Try again: the room answers what is still unanswered. */
export function retryReply(chatId: string): Promise<void> {
  const chat = getChat(chatId);
  const convId = chat?.replyConversationId ?? chat?.conversations[0]?.id;
  return convId ? requestReply(chatId, convId) : Promise.resolve();
}

/** Returns false when there was nothing new to take up (an answer to the same messages is already under way). */
function onAsh(chatId: string, convId: string): boolean {
  const r = roomOf(chatId);
  const t = threadOf(r, convId);
  // Asked again with nothing new from Ash: the answer already under way stands.
  const latest = getChat(chatId)?.conversations.find((c) => c.id === convId);
  const waiting = latest ? unanswered(latest) : [];
  const newest = waiting[waiting.length - 1]?.id;
  const answering = (w: Wake) => w.convId === convId && w.kind === "answer" && w.gen === t.gen && !!w.batch && w.batch[w.batch.length - 1] === newest;
  if (newest && (r.queue.some(answering) || [...r.running.values()].some((run) => answering(run.wake)))) return false;
  t.gen++;
  pruneDrafts(r);
  Object.assign(t, { posts: 0, since: Date.now(), stale: 0, authors: [], spoke: new Set(), chimed: new Set(), paused: undefined });
  setRoomRuntime(chatId, { replyError: undefined });
  // He turned the room: what waited in this conversation is dropped, what runs is stopped (work coming back stays).
  r.queue = r.queue.filter((w) => w.convId !== convId || w.kind === "back");
  for (const [monoId, run] of r.running)
    // A wake already steered into a Mono's work can't be taken back; the runner only withdraws one still waiting.
    if (run.wake.convId === convId && run.wake.kind !== "back") void Promise.resolve(runner?.stop?.(monoId, run.wake.id)).catch(() => undefined);
  const chat = getChat(chatId)!;
  const conv = chat.conversations.find((c) => c.id === convId)!;
  const batch = unanswered(conv);
  if (!batch.length) {
    pump(chatId);
    return true;
  }
  const seats = seatsOf(chat);
  if (!seats.length || !runner) {
    setRoomRuntime(chatId, {
      replyConversationId: convId,
      replyMessageId: batch[batch.length - 1].id,
      replyError: !seats.length ? "Add a Mono to this chat before sending." : "The Mono session engine isn't connected. Open this chat in the desktop app.",
    });
    settleIfIdle(chatId);
    return true;
  }
  const pick = answerPick(batch.map((m) => m.text), seats, chat.leadId)!;
  r.pick = pick;
  enqueue(chatId, {
    id: newWakeId(pick.id),
    monoId: pick.id,
    convId,
    kind: "answer",
    by: pick.by,
    why: pick.why,
    trigger: batch[batch.length - 1].id,
    gen: t.gen,
    batch: batch.map((m) => m.id),
  });
  pump(chatId);
  return true;
}

/**
 * Ash sent a message: the room answers it (requestReply). With the example data on, a scripted stand-in answers
 * instead: the host types and replies, and one other member may add a line.
 */
export function simulateReplies(chatId: string, convId?: string): void {
  if (!examplesOn()) {
    void requestReply(chatId, convId);
    return;
  }
  const chat = getChat(chatId);
  const [answerer, extra] = chat?.memberIds ?? [];
  if (!answerer) return;
  setRoomRuntime(chatId, { replyPending: answerer });
  window.setTimeout(() => {
    setRoomRuntime(chatId, { replyPending: undefined });
    appendMessage(chatId, convId, { from: answerer, kind: "mono", text: "Example: on it. I'll put the plan on the board within the hour." });
    if (!extra) return;
    window.setTimeout(() => appendMessage(chatId, convId, { from: extra, kind: "mono", text: "Example: I'll check it against the project's needs when it's done.", quiet: true }), 1600);
  }, 1800);
}

// ---- Turns ------------------------------------------------------------------------------------------------------

const RANK: Record<TurnKind, number> = { answer: 5, back: 4, digest: 3, reply: 2, chime: 1 };

/** One waiting turn per seat and conversation: a newer wake updates it (the stronger kind wins). */
function enqueue(chatId: string, wake: Wake): void {
  const r = roomOf(chatId);
  const same = r.queue.find((w) => w.monoId === wake.monoId && w.convId === wake.convId);
  if (!same) {
    r.queue.push(wake);
    return;
  }
  if (RANK[wake.kind] >= RANK[same.kind]) Object.assign(same, { ...wake, id: same.id });
  else same.trigger = wake.trigger ?? same.trigger;
}

function pump(chatId: string): void {
  const r = roomOf(chatId);
  while (r.running.size < MAX_PARALLEL_TURNS) {
    const at = r.queue.findIndex(
      (w) => free(r, w) && (w.kind === "back" || !threadOf(r, w.convId).paused) && !roundOpen(r, w),
    );
    if (at < 0) break;
    const [wake] = r.queue.splice(at, 1);
    void start(chatId, wake);
  }
  settleIfIdle(chatId);
}

/**
 * The Mono can take this turn now: it runs nothing else in the room, or (for an answer to Ash) its last turn here went
 * into its own busy work, where a second wake can follow at once instead of waiting for that work to end.
 */
function free(r: RoomRun, wake: Wake): boolean {
  const run = r.running.get(wake.monoId);
  return !run || (wake.kind === "answer" && run.mode !== "turn");
}

/** Turns of the round `wake` answers are still out (in this conversation; a busy Mono's own work doesn't hold it). */
function roundOpen(r: RoomRun, wake: Wake): boolean {
  if (!wake.after) return false;
  const sibling = (w: Wake) => w !== wake && w.convId === wake.convId && w.trigger === wake.after;
  if (r.queue.some(sibling)) return true;
  for (const run of r.running.values()) if (run.mode === "turn" && sibling(run.wake)) return true;
  return false;
}

function noteLine(wake: Wake): string {
  switch (wake.kind) {
    case "answer":
      return "Answered Ash";
    case "chime":
      return `Added to ${wake.other ?? "the host"}'s answer`;
    case "reply":
      return `Answered ${wake.other ?? "a seat"}`;
    case "digest":
      return "Closed the stretch with a digest";
    case "back":
      return `Reported "${wake.back?.title ?? "work"}" back`;
  }
}

async function start(chatId: string, wake: Wake): Promise<void> {
  const r = roomOf(chatId);
  const chat = getChat(chatId);
  const seats = chat ? seatsOf(chat) : [];
  const me = seats.find((s) => s.id === wake.monoId);
  const conv = chat?.conversations.find((c) => c.id === wake.convId);
  if (!chat || !me || !conv || !runner) {
    settleIfIdle(chatId);
    return;
  }
  const running: Running = { wake, mode: "turn", startedAt: Date.now() };
  r.running.set(me.id, running);
  notify();
  const finish = () => {
    if (r.running.get(me.id) === running) r.running.delete(me.id);
    notify();
  };
  const base = {
    chatName: chat.name,
    chatId,
    projectId: chat.projectId,
    me,
    seats,
    host: hostOf(seats, chat.leadId),
    kind: wake.kind,
    batch: wake.batch?.length,
    other: wake.other,
    seatsSpoke: wake.seatsSpoke,
    back: wake.back,
    transcript: roomTranscript(conv.messages, nameOf, 30, wake.kind === "reply" ? wake.trigger : undefined),
  };
  let outcome: RoomTurnOutcome;
  try {
    outcome = await runner.run({
      monoId: me.id,
      chatId,
      convId: wake.convId,
      wakeId: wake.id,
      prompt: turnPrompt(base),
      wakePrompt: turnPrompt({ ...base, viaTool: true }),
      note: { kind: "room", room: chat.name, roomId: chatId, line: noteLine(wake) },
      onText: (text) => showDraft(chatId, wake, me, text),
    });
  } catch (error) {
    takeDraft(r, wake);
    finish();
    if (!stale(r, wake)) failed(chatId, wake, me, error instanceof Error ? error.message : String(error));
    pump(chatId);
    return;
  }
  if (outcome.kind === "reply") {
    const draft = takeDraft(r, wake);
    finish();
    if (!stale(r, wake)) land(chatId, wake, me, outcome.text, draft?.id);
    pump(chatId);
    return;
  }
  takeDraft(r, wake);
  running.mode = outcome.delivery;
  notify();
  // A newer answer to Ash may have been waiting on this Mono: it can follow into its busy work now.
  pump(chatId);
  let end: RoomWakeEnd;
  try {
    end = await outcome.done;
  } catch (error) {
    end = { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  finish();
  if (!stale(r, wake)) {
    if (end.status === "failed") failed(chatId, wake, me, end.error ?? "Its turn did not finish.");
    // Ash must never be left without an answer: the host that finished its own work without one says so.
    else if (wake.kind === "answer" && !running.answered && end.status === "done")
      notice(chatId, wake, me, `${me.name} finished its own work without answering here.`);
  }
  pump(chatId);
}

/**
 * A managed turn's reply becomes the post (a bare acknowledgement becomes a 👍 on what it answers). `id`: the live
 * message it replaces, so the room shows one message that filled in rather than a new one.
 */
function land(chatId: string, wake: Wake, me: Seat, text: string, id?: string): void {
  if (wake.kind === "answer" && !text.trim()) {
    failed(chatId, wake, me, "The Mono finished without a text reply. Open its conversation to inspect the result.");
    return;
  }
  const answered = () => {
    if (wake.kind !== "answer" || !wake.batch?.length) return;
    setAnsweredThrough(chatId, wake.convId, wake.batch[wake.batch.length - 1]);
    setRoomRuntime(chatId, { replyError: undefined });
  };
  if (isSilent(text)) {
    // "Got it" is a 👍 on what it answers; the host that has nothing to say to Ash still shows it read him.
    const emoji = /<reaction>\s*(✅|👀)\s*<\/reaction>/.exec(text)?.[1] ?? "👍";
    const ack = !!text.trim() && !/^\W*NO_REPLY/i.test(text.trim());
    if (wake.trigger && (ack || wake.kind === "answer")) react(chatId, wake.trigger, me.id, ack ? emoji : "👍", true);
    answered();
    return;
  }
  const posted = appendMessage(chatId, wake.convId, {
    ...(id ? { id } : {}),
    from: me.id,
    kind: "mono",
    text: cleanPost(text, me.name),
    ...(wake.trigger ? { replyTo: wake.trigger } : {}),
    pick: { by: wake.by, why: wake.why },
    ...(wake.kind === "chime" || wake.kind === "reply" ? { quiet: true } : {}),
  });
  answered();
  if (posted) afterPost(chatId, posted.convId, posted.message, wake);
}

/** Never silent: a turn that failed, ran out of budget or couldn't start says so in the thread. */
function failed(chatId: string, wake: Wake, me: Seat, error: string): void {
  notice(chatId, wake, me, failureNotice(me.name, error, me.engine));
}

function notice(chatId: string, wake: Wake, me: Seat, text: string): void {
  const r = roomOf(chatId);
  const posted = appendMessage(chatId, wake.convId, {
    id: newMessageId("app"),
    from: "app",
    kind: "notice",
    text,
    ...(wake.trigger ? { replyTo: wake.trigger } : {}),
    notice: { mono: me.id, retry: true },
  });
  if (posted) r.retries.set(posted.message.id, { ...wake, id: newWakeId(me.id) });
}

/** Try again on a notice: the same turn runs once more (an answer answers whatever is still unanswered). */
export function retryNotice(chatId: string, noticeId: string): Promise<void> {
  const r = roomOf(chatId);
  const wake = r.retries.get(noticeId);
  settleNotice(chatId, noticeId);
  r.retries.delete(noticeId);
  if (!wake) {
    const convId = getChat(chatId)?.conversations.find((c) => c.messages.some((m) => m.id === noticeId))?.id;
    return convId ? requestReply(chatId, convId) : Promise.resolve();
  }
  if (wake.kind === "answer") return requestReply(chatId, wake.convId);
  enqueue(chatId, { ...wake, gen: wake.gen < 0 ? -1 : threadOf(r, wake.convId).gen });
  pump(chatId);
  return roomIdle(chatId, wake.convId);
}

// ---- After a post ------------------------------------------------------------------------------------------------

/** A Mono posted: count it against the guards, then wake the seats it names (and, after an answer, the chime gate). */
function afterPost(chatId: string, convId: string, message: ChatMessage, wake?: Wake): void {
  const r = roomOf(chatId);
  const t = threadOf(r, convId);
  const chat = getChat(chatId);
  const conv = chat?.conversations.find((c) => c.id === convId);
  if (!chat || !conv || !isMonoPost(message)) return;
  const seats = seatsOf(chat);
  const before = conv.messages.filter((m) => m.id !== message.id && isMonoPost(m)).slice(-12).map((m) => m.text);
  t.posts++;
  t.authors.push(message.from);
  t.spoke.add(message.from);
  t.stale = isProgress(message.text, before) ? 0 : t.stale + 1;
  if (t.paused) {
    pump(chatId);
    return;
  }
  const speaker = nameOf(message.from);
  const named = addressedIn(message.text, seats, message.from);
  for (const id of named)
    enqueue(chatId, {
      id: newWakeId(id),
      monoId: id,
      convId,
      kind: "reply",
      by: "addressed",
      why: `${speaker} addressed ${nameOf(id)}`,
      other: speaker,
      trigger: message.id,
      ...(wake?.trigger ? { after: wake.trigger } : {}),
      gen: t.gen,
    });
  // The guards: the wakes this post made wait with the room, and "keep going" runs them.
  if (t.posts >= MONO_POSTS_CEILING || Date.now() - t.since >= QUIET_CEILING_MS) pause(chatId, convId, "ceiling");
  else if (t.stale >= STALE_POSTS_LIMIT || pingPong(t.authors)) pause(chatId, convId, "stalled");
  if (t.paused) {
    pump(chatId);
    return;
  }
  if (wake?.kind === "answer") {
    const ash = (wake.batch ?? []).map((id) => conv.messages.find((m) => m.id === id)?.text ?? "").join("\n");
    if (!isShortMessage(ash)) void chimeIn(chatId, convId, message, named, "answer", ash);
  } else if (!named.length && (wake?.kind === "back" || message.pick?.by === "report")) {
    void chimeIn(chatId, convId, message, named, "post", message.text);
  }
  pump(chatId);
}

/** The chime gate: who else may add something to Ash's message (once each), or must look at work that came back. */
async function chimeIn(chatId: string, convId: string, post: ChatMessage, named: readonly string[], about: "answer" | "post", words: string): Promise<void> {
  const r = roomOf(chatId);
  const t = threadOf(r, convId);
  const gen = t.gen;
  const chat = getChat(chatId);
  if (!chat) return;
  const seats = seatsOf(chat);
  const poster = seats.find((s) => s.id === post.from);
  if (!poster || seats.length < 2) return;
  t.routing++;
  notify();
  let chimes: Chime[] | undefined;
  let by: ChatPickSource = "chime";
  try {
    const conv = getChat(chatId)?.conversations.find((c) => c.id === convId);
    const asked = await askRouter(chimePrompt(seats, poster, roomTranscript(conv?.messages ?? [], nameOf), about));
    chimes = "out" in asked ? parseChimes(asked.out, seats, poster.id) : undefined;
    if (!chimes) {
      // No gate, or none in time: the lanes pick, so nobody whose lane it is gets dropped.
      const missed = "missed" in asked ? asked.missed : "the gate's answer wasn't a list";
      if (router) console.warn(`[room] ${missed}; the lane rules pick who else speaks`);
      by = "lanes";
      chimes = (about === "answer" ? laneChimes(words, seats, poster.id) : reviewChimes(words, seats, poster.id)).map((c) => ({
        ...c,
        why: router ? `${c.why} (${missed})` : c.why,
      }));
    }
  } finally {
    t.routing--;
  }
  if (t.gen !== gen || t.paused) {
    pump(chatId);
    return;
  }
  for (const c of chimes) {
    if (named.includes(c.id) || (about === "answer" && t.chimed.has(c.id))) continue;
    if (about === "answer") t.chimed.add(c.id);
    enqueue(chatId, {
      id: newWakeId(c.id),
      monoId: c.id,
      convId,
      kind: about === "answer" ? "chime" : "reply",
      by,
      why: c.why,
      other: poster.name,
      trigger: post.id,
      gen,
    });
  }
  pump(chatId);
}

function pauseText(t: Thread, reason: PauseReason): string {
  if (reason === "stopped") return "You stopped the room. The team waits for you.";
  if (reason === "stalled")
    return pingPong(t.authors)
      ? `${[...new Set(t.authors.slice(-2))].map(nameOf).join(" and ")} kept going back and forth without new ground, so the room paused here for you.`
      : "The last few posts said nothing new, so the room paused here for you.";
  return t.posts >= MONO_POSTS_CEILING
    ? `The team has posted ${t.posts} messages since you last wrote, so it paused here for you.`
    : `The team has been talking for ${Math.round(QUIET_CEILING_MS / 60_000)} minutes since you last wrote, so it paused here for you.`;
}

function pause(chatId: string, convId: string, reason: PauseReason): void {
  const r = roomOf(chatId);
  const t = threadOf(r, convId);
  const held = r.queue.filter((w) => w.convId === convId && w.kind !== "back");
  r.queue = r.queue.filter((w) => !(w.convId === convId && w.kind !== "back"));
  t.paused = { reason, wakes: reason === "stopped" ? [] : held };
  appendMessage(chatId, convId, { id: newMessageId("app"), from: "app", kind: "system", text: pauseText(t, reason) });
  notify();
}

/** Ash's Stop: every room turn in the conversation (all of them without one) stops, and the room waits for him. */
export function stopRoom(chatId: string, convId?: string): void {
  const r = roomOf(chatId);
  const touched = new Set<string>();
  for (const w of r.queue) if (w.kind !== "back" && (!convId || w.convId === convId)) touched.add(w.convId);
  for (const run of r.running.values()) if (run.wake.kind !== "back" && (!convId || run.wake.convId === convId)) touched.add(run.wake.convId);
  if (convId) touched.add(convId);
  r.queue = r.queue.filter((w) => w.kind === "back" || !touched.has(w.convId));
  for (const [monoId, run] of r.running)
    if (touched.has(run.wake.convId) && run.wake.kind !== "back")
      void Promise.resolve(runner?.stop?.(monoId, run.wake.id)).catch(() => undefined);
  for (const id of touched) {
    const t = threadOf(r, id);
    t.gen++;
    if (!t.paused) pause(chatId, id, "stopped");
    else t.paused = { reason: "stopped", wakes: [] };
  }
  pruneDrafts(r);
  notify();
  settleIfIdle(chatId);
}

/** "Keep going": the paused conversation carries on from where it stopped, with fresh guards. */
export function keepGoing(chatId: string, convId: string): void {
  const r = roomOf(chatId);
  const t = threadOf(r, convId);
  if (!t.paused) return;
  const held = t.paused.wakes;
  Object.assign(t, { paused: undefined, posts: 0, since: Date.now(), stale: 0, authors: [] });
  const line = appendMessage(chatId, convId, { id: newMessageId("app"), from: "app", kind: "system", text: "Ash asked the team to keep going." });
  const chat = getChat(chatId);
  if (held.length) for (const w of held) enqueue(chatId, { ...w, gen: t.gen });
  else if (chat && line) {
    const host = hostOf(seatsOf(chat), chat.leadId);
    if (host)
      enqueue(chatId, { id: newWakeId(host.id), monoId: host.id, convId, kind: "reply", by: "lead", why: "Ash asked the team to keep going", other: "Ash", trigger: line.message.id, gen: t.gen });
  }
  pump(chatId);
}

/** Nothing left in a conversation: the host's digest when three or more seats spoke, then anyone waiting is told. */
function settleIfIdle(chatId: string): void {
  const r = roomOf(chatId);
  const chat = getChat(chatId);
  for (const [convId, t] of r.threads) {
    if (busyIn(r, convId) || t.paused || !chat || t.spoke.size < DIGEST_SEATS || !runner) continue;
    const host = hostOf(seatsOf(chat), chat.leadId);
    const conv = chat.conversations.find((c) => c.id === convId);
    const last = conv?.messages[conv.messages.length - 1];
    const spoke = t.spoke.size;
    t.spoke = new Set();
    if (!host || !last || last.from === "ash") continue;
    enqueue(chatId, { id: newWakeId(host.id), monoId: host.id, convId, kind: "digest", by: "digest", why: `${spoke} seats spoke since Ash's message`, trigger: last.id, gen: t.gen, seatsSpoke: spoke });
    pump(chatId);
    return;
  }
  const waiting = r.idle;
  r.idle = [];
  for (const w of waiting) {
    if (busyIn(r, w.convId)) r.idle.push(w);
    else w.resolve();
  }
}

// ---- Posts that don't come from a managed turn -------------------------------------------------------------------

/** room_post's limits: at most this many posts a minute per Mono and room. */
export const POSTS_PER_MINUTE = 6;

/**
 * A Mono posts with room_post (it is busy in its own chat, or posts on its own: work coming back, a heads-up). Answers
 * the wake it was woken for, if one is out; then the post wakes the seats it names, like any other. Refused while the
 * conversation is paused for Ash, during the Mono's own managed room turn (its reply is the post), and past the rate.
 */
export function postFromMono(
  chatId: string,
  monoId: string,
  text: string,
  options: { conversation?: string; replyTo?: string; now?: number } = {},
): { posted?: ChatMessage; reacted?: string; convId: string; note: string } {
  const chat = getChat(chatId);
  if (!chat) throw new Error("That room doesn't exist.");
  if (!chat.memberIds.includes(monoId)) throw new Error(`You're not in ${chat.name}. Ask Ash to add you if you should be.`);
  const r = roomOf(chatId);
  const running = r.running.get(monoId);
  if (running?.mode === "turn")
    throw new Error("You're in a room turn for this room: your reply is posted for you. Write it as your turn's answer instead of calling room_post.");
  const convId =
    (options.conversation && chat.conversations.some((c) => c.id === options.conversation) ? options.conversation : undefined) ??
    (options.conversation ? undefined : running?.wake.convId ?? chat.conversations[0]?.id);
  if (options.conversation && !convId) throw new Error(`No conversation ${options.conversation} in ${chat.name}.`);
  const t = convId ? threadOf(r, convId) : undefined;
  if (t?.paused)
    throw new Error(
      t.paused.reason === "stopped"
        ? "Ash stopped this conversation. Post again only when he writes; tell him in your own chat if it can't wait."
        : "This conversation is paused waiting for Ash. Tell him in your own chat if it can't wait.",
    );
  const now = options.now ?? Date.now();
  const times = (r.posts.get(monoId) ?? []).filter((at) => now - at < 60_000);
  if (times.length >= POSTS_PER_MINUTE) throw new Error(`Slow down: at most ${POSTS_PER_MINUTE} posts a minute in a room. Put it in one message.`);
  // The wake it was woken for, unless Ash has written since (then this is a post of its own).
  const wake = running && running.wake.convId === convId && !stale(r, running.wake) ? running.wake : undefined;
  const replyTo = options.replyTo ?? wake?.trigger;
  if (replyTo && !chat.conversations.some((c) => c.messages.some((m) => m.id === replyTo))) throw new Error(`No message ${replyTo} in ${chat.name}.`);
  const me = seatsOf(chat).find((s) => s.id === monoId)!;
  const clean = cleanPost(text, me.name);
  if (isSilent(clean)) {
    if (!replyTo) throw new Error("Nothing to post: a bare acknowledgement isn't a message. React to a message (reaction) instead, or say nothing.");
    react(chatId, replyTo, monoId, "👍", true);
    if (running && wake) running.answered = true;
    return { reacted: "👍", convId: convId ?? "", note: "That was only an acknowledgement, so it went on the message as a 👍." };
  }
  r.posts.set(monoId, [...times, now]);
  const posted = appendMessage(chatId, convId, {
    from: monoId,
    kind: "mono",
    text: clean,
    ...(replyTo ? { replyTo } : {}),
    pick: wake ? { by: wake.by, why: wake.why } : { by: "post", why: `${me.name} posted from its own chat` },
    ...(wake && (wake.kind === "chime" || wake.kind === "reply") ? { quiet: true } : {}),
  });
  if (!posted) throw new Error("The room couldn't take the post.");
  if (running && wake) {
    running.answered = true;
    if (wake.kind === "answer" && wake.batch?.length) {
      setAnsweredThrough(chatId, posted.convId, wake.batch[wake.batch.length - 1]);
      setRoomRuntime(chatId, { replyError: undefined });
    }
    notify();
  }
  afterPost(chatId, posted.convId, posted.message, wake);
  return { posted: posted.message, convId: posted.convId, note: "Posted. Seats you named are woken; carry on with your work." };
}

/**
 * A Lead's report on a brief from a leadership Mono lands in the room (double delegation, roomReports.ts): the Lead's
 * report, then the briefing Mono's answer to it, which was its own turn on the report in its chat (the H2 report-back
 * path), so the room's "one answers" holds. Then the seats the answer names, or the gate's picks, look at it. Posting
 * the same report again changes nothing (its id is the report's receipt).
 */
export async function postReport(
  chatId: string,
  report: { id: string; from: string; text: string; answeredBy: string; answer: string; why: string },
): Promise<boolean> {
  const chat = getChat(chatId);
  if (!chat || !chat.memberIds.includes(report.answeredBy)) return false;
  if (chat.conversations.some((c) => c.messages.some((m) => m.id === report.id))) return false;
  const pick = { by: "report" as const, why: report.why };
  const first = appendMessage(chatId, undefined, {
    id: report.id,
    from: report.from,
    kind: "mono",
    text: report.text.trim() || "(the Lead finished without a written report)",
    pick,
  });
  if (!first) return false;
  if (!report.answer.trim() || isSilent(report.answer)) return true;
  const answer = appendMessage(chatId, first.convId, {
    id: `${report.id}-answer`,
    from: report.answeredBy,
    kind: "mono",
    text: cleanPost(report.answer, nameOf(report.answeredBy)),
    replyTo: report.id,
    pick,
  });
  if (answer) {
    // The Lead's report is the room's news, not a seat's turn: only the answer counts toward the guards and the digest.
    afterPost(chatId, answer.convId, answer.message);
  }
  return true;
}

/** Work a Mono delegated from this room came back: it posts "X is back" in the room (a turn of its own). */
export function postBack(input: { chatId: string; convId: string; monoId: string; title: string; answer: string }): boolean {
  const chat = getChat(input.chatId);
  if (!chat || !chat.memberIds.includes(input.monoId)) return false;
  const convId = chat.conversations.some((c) => c.id === input.convId) ? input.convId : chat.conversations[0]?.id;
  if (!convId) return false;
  enqueue(input.chatId, {
    id: newWakeId(input.monoId),
    monoId: input.monoId,
    convId,
    kind: "back",
    by: "back",
    why: `${nameOf(input.monoId)}'s work from this room came back: ${input.title}`,
    gen: -1,
    back: { title: input.title, answer: input.answer },
  });
  pump(input.chatId);
  return true;
}

/** Tests: forget every room's turns. */
export function resetConductorForTests(): void {
  rooms.clear();
  runner = undefined;
  router = undefined;
  routerTimeoutMs = ROUTER_TIMEOUT_MS;
}
