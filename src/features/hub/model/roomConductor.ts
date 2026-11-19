// The room taking turns (docs/leadership/ROOM.md; the rules are roomTurns.ts). Leadership is just a group chat:
//
// - Ash writes: whatever the room was doing in that conversation stops at once, and one seat answers him now (the
//   light router, roomTurns.ts answerPick: whoever he names, else the host). His messages since the last answer are
//   answered together. When he named nobody, every other seat then gets one turn (everyoneElse) to reply in its own
//   voice or NO_REPLY, which shows nothing. They run side by side (up to MAX_PARALLEL_TURNS), each seeing the host's
//   answer; @name or opening with a seat's name means just that seat.
// - A Mono's post (its turn's reply, or room_post) wakes the seats it names (@name or "PM, ..."), so Monos can hand off
//   to each other. The one loop brake: after MONO_POSTS_CEILING posts without Ash, the room pauses for him.
// - Up to MAX_PARALLEL_TURNS turns run at once in a room, one per Mono. Each turn runs in the Mono's own session through
//   the app's runner: a managed turn when the Mono is free (its reply is the post), or, when it is busy in its own
//   chat, a room wake that goes into its work and that it answers with room_post. Every failure leaves a notice.
// - Work a Mono delegated from the room comes back as "X is back" (postBack, roomReports.ts); a Lead's report on a
//   leadership brief lands with its owner's answer (postReport).
import type { LiveActivity } from "../../sessions/model/liveActivity";
import { listMonos } from "../../monos/model/mono";
import { examplesOn } from "./examples";
import {
  addMember,
  appendMessage,
  getChat,
  leadershipChatId,
  newMessageId,
  notify,
  react,
  setAnsweredThrough,
  setRoomRuntime,
  settleNotice,
  unanswered,
} from "./hubChats";
import { hubData } from "./hubData";
import { leadFor, leadMono, projectLeadOf } from "./hubLeads";
import {
  addressedIn,
  answerPick,
  cleanPost,
  draftShowable,
  failureNotice,
  hostOf,
  isSilent,
  NO_REPLY,
  repeatsAnother,
  everyoneElse,
  MAX_PARALLEL_TURNS,
  MONO_POSTS_CEILING,
  roomTranscript,
  turnPrompt,
  type Pick,
  type Seat,
  type TurnKind,
} from "./roomTurns";
import type { ChatMessage, ChatPickSource, GroupChat, RoomAttachment } from "./types";
import { forUser, userLabel } from "./userName";
import { draftStatusLines } from "../../selfBuild/model/monoMake";
import { liveMonosNote } from "./liveMonos";
import { withoutNoReply } from "../../../shared/text/noReply";
import {
  AUTO_RECENT_MESSAGES,
  autoPick,
  GOAL_MAX_TURNS,
  goalEndLine,
  mentionedSeats,
  parseGoalControl,
  responderOf,
  type GoalState,
  type RoomDecider,
} from "./roomModes";
import { appDecider } from "./roomDecider";
import { isAckOrIntentOnly, isRolesAsk, isSecondStatus, isStatusAsk, logDropped, stripMeta, stripOtherSeats } from "./roomMeta";

// ---- The app's side: the runner -------------------------------------------------------------------------------

/** The quiet line a room turn leaves in the Mono's own chat. */
export type RoomTurnNote = { kind: "room"; room: string; roomId: string; line: string };
export type RoomTurnRequest = {
  monoId: string;
  chatId: string;
  convId: string;
  /** The room's project: the runner gives the seat that project's memory (roomMemory.ts). */
  projectId: string;
  /** The turn's id: a waiting wake's queue id, and what stop() names. */
  wakeId: string;
  /** The managed turn's prompt: its reply is the post. */
  prompt: string;
  /**
   * What Ash attached to the messages this turn takes up (photos, files): sent with the prompt the way his own chat
   * sends them, so the Mono sees the picture and can open the file, not only read its name.
   */
  attachments?: RoomAttachment[];
  /** The same turn for a busy Mono: it answers with room_post. */
  wakePrompt: string;
  /** Who wrote the message this turn answers: Ash, or a Mono (whose words are never saved as Ash's). */
  speaker: { id: string; name: string };
  note: RoomTurnNote;
  /** A managed turn's words so far, as they are written (the runner calls it as they grow): the room shows them live. */
  onText?(text: string): void;
  /** What the managed turn is doing now (its step, from its own stream) and when it last did anything: the live line. */
  onActivity?(activity: LiveActivity): void;
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
/** WP-22: the quick model auto mode asks; unset, the app's (roomDecider.ts), which is none outside the app. */
let decider: RoomDecider | null | undefined;
export function setRoomDecider(next: RoomDecider | null | undefined): () => void {
  decider = next;
  return () => {
    if (decider === next) decider = undefined;
  };
}
function currentDecider(): RoomDecider | undefined {
  return decider === undefined ? appDecider() : (decider ?? undefined);
}

/** A runner may still say a Mono can't take the turn; it becomes a notice like any failure. */
export class MonoBusyError extends Error {}

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
  /** The conversation's generation it belongs to (-1: never stale, work coming back). */
  gen: number;
  /** An answer: Ash's messages it takes up. */
  batch?: string[];
  back?: { title: string; answer: string };
  /** WP-22: a chime from a seat picked to answer too (several mentioned, or the auto pick chose several). */
  picked?: boolean;
  /** WP-22: a goal run's turn: the lead's (it chooses who goes next) or a member's (with the lead's instruction). */
  goal?: { role: "lead" | "member"; turn: number; instruction?: string; ashAnswered?: boolean };
  /** The goal turn's outcome was taken up (its post, or its silence), so the run moves on once. */
  stepped?: boolean;
  /** WP-245: one of several seats answering the same message of Ash's; its post waits for the others (Gather). */
  gather?: string;
};
/**
 * WP-245: one message of Ash's that several seats answer at once (he named several, the auto pick chose several, or an
 * "everyone" room's other seats chime in). Each answer is held as a live message until every seat has answered (or
 * stayed quiet, or failed) or GATHER_MS passed; then they land together, in seat order, and the room names any seat
 * that didn't answer in time. A late answer lands on its own when it comes.
 */
type Gather = {
  id: string;
  convId: string;
  gen: number;
  members: string[];
  /** Seats that are through: their post is held, or they said nothing, or failed. */
  done: Set<string>;
  held: Map<string, () => void>;
  timer?: ReturnType<typeof setTimeout>;
  closed?: boolean;
};
/** WP-22: a goal run in one conversation (roomModes.ts). */
type GoalRun = {
  text: string;
  lead: string;
  turns: number;
  state: GoalState;
  reason?: string;
  /** It stopped because it used all its turns: only Continue starts it again (Ash's next message doesn't). */
  outOfTurns?: boolean;
};
type Running = { wake: Wake; mode: "turn" | "queued" | "steered"; startedAt: number; answered?: boolean; activity?: LiveActivity };
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
  /** WP-245: its turn is over and its words wait for the others answering the same message. */
  held?: true;
};
type Draft = RoomDraft & { wakeId: string; gen: number };
type PauseReason = "ceiling" | "stopped";
type Thread = {
  gen: number;
  /** Mono posts since Ash's last message (or "keep going"): the loop brake. */
  posts: number;
  /** Seats that already added their one reply to Ash's message. */
  chimed: Set<string>;
  paused?: { reason: PauseReason; wakes: Wake[] };
  /** A status line for Ash (a host that finished its own work without answering here): shown in the strip above the
   * composer, never posted in the room (AD6, AD12). Its Try again runs the turn once more. */
  note?: { text: string; mono: string; wake: Wake };
  /** WP-22: a quiet line for Ash with nothing to retry (a mentions room where he mentioned nobody). */
  hint?: string;
  /** WP-22: the conversation's goal run, while it runs and after it ends (until Ash writes again). */
  goal?: GoalRun;
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
  /** WP-22: conversations whose auto pick is out, with the generation it belongs to. */
  deciding: Map<string, number>;
  /** WP-245: answers being gathered, by gather id. */
  gathers: Map<string, Gather>;
};
const rooms = new Map<string, RoomRun>();

function roomOf(chatId: string): RoomRun {
  let r = rooms.get(chatId);
  if (!r) {
    r = { queue: [], running: new Map(), threads: new Map(), idle: [], retries: new Map(), posts: new Map(), drafts: new Map(), deciding: new Map(), gathers: new Map() };
    rooms.set(chatId, r);
  }
  return r;
}
function threadOf(r: RoomRun, convId: string): Thread {
  let t = r.threads.get(convId);
  if (!t) {
    t = { gen: 0, posts: 0, chimed: new Set() };
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
  if (id === "ash") return userLabel();
  return listMonos().find((m) => m.id === id)?.name?.trim() || id;
}
const isMonoPost = (m: ChatMessage) => (m.kind ?? (m.from === "ash" ? "ash" : "mono")) === "mono";
function busyIn(r: RoomRun, convId?: string): boolean {
  const here = (id: string) => convId === undefined || id === convId;
  if (r.queue.some((w) => here(w.convId))) return true;
  for (const run of r.running.values()) if (here(run.wake.convId)) return true;
  for (const id of r.deciding.keys()) if (here(id)) return true;
  return false;
}
function stale(r: RoomRun, wake: Wake): boolean {
  return wake.gen >= 0 && wake.gen !== threadOf(r, wake.convId).gen;
}

// ---- What the screens read ----------------------------------------------------------------------------------------

export type RoomWorker = {
  monoId: string;
  convId: string;
  kind: TurnKind;
  state: "writing" | "queued" | "steered";
  /**
   * What the turn is doing now: a writing turn's step ("Thinking" since it began until its stream says more), or a
   * queued or steered wake's, once its session has reported one.
   */
  activity?: LiveActivity;
};
/** Who is working on a room turn now, and how: writing it, or answering from their own chat. */
export function roomWorking(chatId: string, convId?: string): RoomWorker[] {
  const r = rooms.get(chatId);
  if (!r) return [];
  return [...r.running.values()]
    .filter((x) => !convId || x.wake.convId === convId)
    .filter((x) => !(x.mode !== "turn" && x.answered))
    .map((x) =>
      x.mode === "turn"
        ? {
            monoId: x.wake.monoId,
            convId: x.wake.convId,
            kind: x.wake.kind,
            state: "writing" as const,
            activity: x.activity ?? { key: "start", label: "Thinking", since: x.startedAt, lastEventAt: x.startedAt },
          }
        : // A queued or steered wake carries what it is doing once its session reports it (r62), never a made-up step.
          { monoId: x.wake.monoId, convId: x.wake.convId, kind: x.wake.kind, state: x.mode, ...(x.activity ? { activity: x.activity } : {}) },
    );
}
/**
 * r67 (Alfred's r66 A9): every Mono working on a room turn now, with the room it is in. A room-only turn never touches
 * the Mono's own chat, so the rail read every row "idle" and the folded header said nothing while seats wrote.
 */
export function roomTurnsByMono(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [chatId, r] of rooms)
    for (const x of r.running.values()) if (x.mode === "turn" || !x.answered) if (!out.has(x.wake.monoId)) out.set(x.wake.monoId, chatId);
  return out;
}
/** The first Mono writing in the room (the older single indicator). */
export function typingIn(chatId: string): string | undefined {
  return roomWorking(chatId)[0]?.monoId;
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
/**
 * The room's quiet status strip for one conversation: the brake or Stop pause, or a status note. The app never posts
 * these as room messages, so they don't read as a seat talking and no Mono sees them as part of the conversation.
 */
export type RoomStrip =
  | { kind: "paused"; reason: PauseReason; text: string }
  | { kind: "note"; text: string; mono: string }
  | { kind: "goal"; text: string }
  | { kind: "goal-waiting"; text: string }
  | { kind: "hint"; text: string };
export function roomStrip(chatId: string, convId: string): RoomStrip | undefined {
  const t = rooms.get(chatId)?.threads.get(convId);
  if (!t) return undefined;
  if (t.paused) return { kind: "paused", reason: t.paused.reason, text: pauseText(t, t.paused.reason) };
  if (t.note) return { kind: "note", text: t.note.text, mono: t.note.mono };
  // How a finished goal ended is a line in the room itself (endGoal); a running or waiting one shows here.
  if (t.goal?.state === "running") return { kind: "goal", text: `Working toward the goal · turn ${Math.max(1, t.goal.turns)} of ${GOAL_MAX_TURNS}` };
  // A goal that waits for Ash says why, with Continue and End goal beside it.
  if (goalWaiting(t.goal)) return { kind: "goal-waiting", text: goalEndLine(t.goal.state as "blocked" | "needs_input", t.goal.reason) };
  if (t.hint) return { kind: "hint", text: t.hint };
  return undefined;
}

/** WP-22: the conversation's goal run (running or how it ended), if it has one. */
export type RoomGoal = { text: string; lead: string; turns: number; max: number; state: GoalState; reason?: string };
export function roomGoal(chatId: string, convId: string): RoomGoal | undefined {
  const g = rooms.get(chatId)?.threads.get(convId)?.goal;
  return g ? { ...g, max: GOAL_MAX_TURNS } : undefined;
}
/** Try again on the strip's note: the host's turn runs once more. */
export function retryRoomNote(chatId: string, convId: string): Promise<void> {
  const t = rooms.get(chatId)?.threads.get(convId);
  if (!t?.note) return Promise.resolve();
  t.note = undefined;
  notify();
  return requestReply(chatId, convId);
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
  // r64: on a status ask only the host's words stream in; another seat's post shows only if it lands (one missed fact).
  if (wake.kind === "chime" && statusAsked(chatId, wake)) return;
  // r64: notes about its own process ("I'll check the board before I add anything.") never show, even while streaming.
  // WP-22: a goal lead's control block (whole or still being written) never shows.
  if (wake.kind === "goal") text = text.replace(/<room_control>[\s\S]*$/i, "").replace(/<[^>\s]*$/, "");
  let clean = stripMeta(cleanPost(text, me.name)).text;
  // r66: on a roles ask a seat's words about another seat's role never show, even while streaming.
  if (rolesAsked(chatId, wake)) clean = stripOtherSeats(clean, otherSeatNames(chatId, me)).text || clean;
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
  const answering = (w: Wake) => w.convId === convId && (w.kind === "answer" || w.kind === "goal") && w.gen === t.gen && !!w.batch && w.batch[w.batch.length - 1] === newest;
  if (newest && (r.queue.some(answering) || [...r.running.values()].some((run) => answering(run.wake)))) return false;
  turnRoom(chatId, convId);
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
  // WP-22: a goal whose lead has left the room is over: the room answers as usual.
  const goal = t.goal;
  if (goal && !seats.some((s) => s.id === goal.lead)) {
    endGoal(chatId, convId, "blocked", `${nameOf(goal.lead)} left the room`);
    t.goal = undefined;
  }
  // A running goal takes up what Ash wrote (its lead's next turn answers him), and so does one whose lead asked him
  // something. A goal that is blocked or out of turns waits for Continue; meanwhile the room answers as usual.
  if (t.goal && (t.goal.state === "running" || (t.goal.state === "needs_input" && !t.goal.outOfTurns))) {
    if (t.goal.state !== "running") Object.assign(t.goal, { state: "running", turns: 0, reason: undefined });
    goalTurn(chatId, convId, t.goal.lead, { trigger: batch[batch.length - 1].id, batch: batch.map((m) => m.id), ashAnswered: true });
    pump(chatId);
    return true;
  }
  if (!goalWaiting(t.goal)) t.goal = undefined;
  const mode = responderOf(chat);
  const texts = batch.map((m) => m.text);
  const host = hostOf(seats, chat.leadId)!;
  if (mode === "everyone") {
    answerWith(chatId, convId, batch, [answerPick(texts, seats, chat.leadId)!]);
    pump(chatId);
    return true;
  }
  // lead, mentions and auto: whoever Ash mentions answers, every one of them; nobody else chimes in.
  const named = mentionedSeats(texts, seats);
  if (named.length) {
    const names = named.map((s) => s.name).join(", ");
    answerWith(chatId, convId, batch, named.map((s) => ({ id: s.id, by: "mention" as const, why: forUser`Ash mentioned ${names}` })));
  } else if (mode === "mentions") {
    // Nobody mentioned in a room that answers only who's mentioned: nothing runs, and the strip says why.
    setAnsweredThrough(chatId, convId, batch[batch.length - 1].id);
    t.hint = "Nobody was mentioned, so nobody answers. This room answers only who you @mention.";
    notify();
  } else if (seats.length === 1) {
    answerWith(chatId, convId, batch, [{ id: seats[0].id, by: "only", why: "the only Mono in this chat" }]);
  } else if (mode === "lead") {
    answerWith(chatId, convId, batch, [{ id: host.id, by: "lead", why: forUser`${host.name} leads this room and answers` }]);
  } else {
    autoAnswer(chatId, convId, batch, seats, host);
    return true;
  }
  pump(chatId);
  return true;
}

/** Ash turned the room (wrote, or set a goal): what waited in this conversation is dropped, what runs is stopped. */
function turnRoom(chatId: string, convId: string): void {
  const r = roomOf(chatId);
  const t = threadOf(r, convId);
  // WP-245: answers already written stay in the room, even though Ash moved on before the others answered.
  flushGathers(chatId, convId);
  t.gen++;
  pruneDrafts(r);
  Object.assign(t, { posts: 0, chimed: new Set(), paused: undefined, note: undefined, hint: undefined });
  setRoomRuntime(chatId, { replyError: undefined });
  r.deciding.delete(convId);
  // Work coming back stays.
  r.queue = r.queue.filter((w) => w.convId !== convId || w.kind === "back");
  for (const [monoId, run] of r.running)
    // A wake already steered into a Mono's work can't be taken back; the runner only withdraws one still waiting.
    if (run.wake.convId === convId && run.wake.kind !== "back") void Promise.resolve(runner?.stop?.(monoId, run.wake.id)).catch(() => undefined);
}

/**
 * The seats that answer Ash's message(s): the first answers him; any others (several mentioned, or the auto pick chose
 * several) each add their own answer beside it.
 */
function answerWith(chatId: string, convId: string, batch: readonly ChatMessage[], picks: readonly Pick[]): void {
  const r = roomOf(chatId);
  const t = threadOf(r, convId);
  const [first, ...rest] = picks;
  if (!first) return;
  r.pick = first;
  const trigger = batch[batch.length - 1].id;
  const gather = rest.length ? openGather(chatId, convId, t.gen, picks.map((p) => p.id)) : undefined;
  const joined = [
    enqueue(chatId, { id: newWakeId(first.id), monoId: first.id, convId, kind: "answer", by: first.by, why: first.why, trigger, gen: t.gen, batch: batch.map((m) => m.id), ...(gather ? { gather } : {}) }),
  ];
  for (const p of rest) {
    t.chimed.add(p.id);
    joined.push(
      enqueue(chatId, { id: newWakeId(p.id), monoId: p.id, convId, kind: "chime", by: p.by, why: p.why, other: nameOf(first.id), trigger, gen: t.gen, picked: true, ...(gather ? { gather } : {}) }),
    );
  }
  if (gather) keepGathered(chatId, gather, joined);
}

/**
 * Auto: the quick model picks who answers, within AUTO_PICK_TIMEOUT_MS. On a timeout, an error, an unsure answer or no
 * model, the lead answers. Ash writing again (or Stop) before it answers drops the pick.
 */
function autoAnswer(chatId: string, convId: string, batch: readonly ChatMessage[], seats: readonly Seat[], host: Seat): void {
  const r = roomOf(chatId);
  const t = threadOf(r, convId);
  const gen = t.gen;
  r.deciding.set(convId, gen);
  notify();
  const conv = getChat(chatId)?.conversations.find((c) => c.id === convId);
  const recent = (conv?.messages ?? [])
    .filter((m) => m.kind !== "notice" && m.kind !== "system" && m.text.trim())
    .slice(-AUTO_RECENT_MESSAGES)
    .map((m) => ({ who: nameOf(m.from), text: m.text }));
  void autoPick({ decider: currentDecider(), seats, recent }).then((result) => {
    if (r.deciding.get(convId) === gen) r.deciding.delete(convId);
    if (t.gen !== gen) {
      settleIfIdle(chatId);
      return;
    }
    if ("ids" in result) answerWith(chatId, convId, batch, result.ids.map((id) => ({ id, by: "auto" as const, why: result.why })));
    else answerWith(chatId, convId, batch, [{ id: host.id, by: "lead", why: `${host.name} leads this room (${result.fallback})` }]);
    pump(chatId);
  });
}

// ---- Goal mode (WP-22) -------------------------------------------------------------------------------------------

/**
 * Ash gave the room a goal (his newest unanswered message): the lead works toward it for at most GOAL_MAX_TURNS turns,
 * choosing who speaks next each time, and stops on completed, needs input or blocked. Resolves once the conversation
 * is quiet again.
 */
export function startGoal(chatId: string, convId?: string): Promise<void> {
  const chat = getChat(chatId);
  const conv = chat?.conversations.find((c) => c.id === convId) ?? chat?.conversations[0];
  if (!chat || !conv) return Promise.resolve();
  const batch = unanswered(conv);
  if (!batch.length) return Promise.resolve();
  const r = roomOf(chatId);
  const t = threadOf(r, conv.id);
  turnRoom(chatId, conv.id);
  const seats = seatsOf(chat);
  if (!seats.length || !runner) {
    setRoomRuntime(chatId, {
      replyConversationId: conv.id,
      replyMessageId: batch[batch.length - 1].id,
      replyError: !seats.length ? "Add a Mono to this chat before setting a goal." : "The Mono session engine isn't connected. Open this chat in the desktop app.",
    });
    settleIfIdle(chatId);
    return Promise.resolve();
  }
  const lead = hostOf(seats, chat.leadId)!;
  t.goal = { text: batch.map((m) => m.text).join("\n"), lead: lead.id, turns: 0, state: "running" };
  appendMessage(chatId, conv.id, {
    id: newMessageId("app"),
    from: "app",
    kind: "system",
    text: `Goal mode: ${lead.name} leads the room toward this goal, for up to ${GOAL_MAX_TURNS} turns.`,
  });
  goalTurn(chatId, conv.id, lead.id, { trigger: batch[batch.length - 1].id, batch: batch.map((m) => m.id) });
  pump(chatId);
  return roomIdle(chatId, conv.id);
}

/** The goal run's next turn, if it has turns left; out of turns, the run stops and waits for Ash. */
function goalTurn(chatId: string, convId: string, monoId: string, input: { trigger?: string; instruction?: string; batch?: string[]; ashAnswered?: boolean }): void {
  const r = roomOf(chatId);
  const t = threadOf(r, convId);
  const g = t.goal;
  if (!g || g.state !== "running") return;
  if (g.turns >= GOAL_MAX_TURNS) {
    endGoal(chatId, convId, "needs_input", `the room used all ${GOAL_MAX_TURNS} of its turns`);
    g.outOfTurns = true;
    return;
  }
  const chat = getChat(chatId);
  if (!chat?.memberIds.includes(monoId)) {
    endGoal(chatId, convId, "blocked", `${nameOf(monoId)} isn't in the room any more`);
    return;
  }
  g.turns++;
  const lead = monoId === g.lead;
  enqueue(chatId, {
    id: newWakeId(monoId),
    monoId,
    convId,
    kind: "goal",
    by: "goal",
    why: lead ? `${nameOf(monoId)} leads the room toward the goal` : `${nameOf(g.lead)} asked ${nameOf(monoId)} to go next`,
    other: nameOf(g.lead),
    ...(input.trigger ? { trigger: input.trigger } : {}),
    gen: t.gen,
    ...(input.batch?.length ? { batch: input.batch } : {}),
    goal: { role: lead ? "lead" : "member", turn: g.turns, ...(input.instruction ? { instruction: input.instruction } : {}), ...(input.ashAnswered ? { ashAnswered: true } : {}) },
  });
  notify();
}

/** The goal run ends, and the room says how. */
function endGoal(chatId: string, convId: string, state: Exclude<GoalState, "running">, reason?: string): void {
  const r = roomOf(chatId);
  const t = threadOf(r, convId);
  const g = t.goal;
  if (!g || g.state !== "running") return;
  Object.assign(g, { state, reason: reason?.trim() || undefined });
  r.queue = r.queue.filter((w) => !(w.convId === convId && w.kind === "goal"));
  // A goal turn still in flight is over too: whatever it says or however it ends later moves nothing.
  for (const [monoId, run] of r.running)
    if (run.wake.convId === convId && run.wake.kind === "goal" && !run.wake.stepped) {
      run.wake.stepped = true;
      void Promise.resolve(runner?.stop?.(monoId, run.wake.id)).catch(() => undefined);
    }
  appendMessage(chatId, convId, { id: newMessageId("app"), from: "app", kind: "system", text: goalEndLine(state, reason) });
  notify();
}

/** A goal that stopped short and waits for Ash: blocked, out of turns, or its lead asked him something. */
function goalWaiting(g: GoalRun | undefined): g is GoalRun {
  return !!g && (g.state === "blocked" || g.state === "needs_input");
}

/**
 * Continue on a goal that waits for Ash: its lead picks it up again with a fresh budget of turns, taking up anything
 * he wrote since.
 */
export function continueGoal(chatId: string, convId: string): Promise<void> {
  const r = roomOf(chatId);
  const t = threadOf(r, convId);
  const g = t.goal;
  const chat = getChat(chatId);
  const conv = chat?.conversations.find((c) => c.id === convId);
  if (!goalWaiting(g) || !chat || !conv) return Promise.resolve();
  if (!chat.memberIds.includes(g.lead) || !runner) {
    t.goal = undefined;
    notify();
    return Promise.resolve();
  }
  turnRoom(chatId, convId);
  Object.assign(g, { state: "running", turns: 0, reason: undefined, outOfTurns: undefined });
  const line = appendMessage(chatId, convId, { id: newMessageId("app"), from: "app", kind: "system", text: forUser("Ash asked the room to carry on with the goal.") });
  const batch = unanswered(conv);
  goalTurn(chatId, convId, g.lead, {
    trigger: batch[batch.length - 1]?.id ?? line?.message.id,
    ...(batch.length ? { batch: batch.map((m) => m.id), ashAnswered: true } : {}),
  });
  pump(chatId);
  return roomIdle(chatId, convId);
}

/** End goal: a goal that waits for Ash (or still runs) is over. */
export function endRoomGoal(chatId: string, convId: string): void {
  const t = threadOf(roomOf(chatId), convId);
  const g = t.goal;
  if (!g) return;
  if (g.state === "running") endGoal(chatId, convId, "stopped", "you ended it");
  else if (goalWaiting(g)) appendMessage(chatId, convId, { id: newMessageId("app"), from: "app", kind: "system", text: goalEndLine("stopped", "you ended it") });
  t.goal = undefined;
  notify();
  settleIfIdle(chatId);
}

/**
 * A goal turn's words: the lead's control block is read and taken out, what is left is posted, and the run moves on:
 * after a member, back to the lead; after the lead, to whoever it named, or it stops as the lead said. A lead turn
 * without a readable block stops the run for Ash.
 */
function landGoal(chatId: string, wake: Wake, me: Seat, text: string, id?: string): ChatMessage | undefined {
  const r = roomOf(chatId);
  const t = threadOf(r, wake.convId);
  if (wake.stepped) return undefined;
  wake.stepped = true;
  const g = t.goal;
  const chat = getChat(chatId);
  if (!g || g.state !== "running" || !chat) return undefined;
  const leading = wake.goal?.role === "lead";
  const parsed = leading ? parseGoalControl(text, seatsOf(chat)) : { post: text.replace(/<room_control>[\s\S]*?(?:<\/room_control>|$)/gi, "") };
  const words = cleanPost(parsed.post, me.name);
  let posted: ChatMessage | undefined;
  if (!isSilent(words)) {
    posted = appendMessage(chatId, wake.convId, {
      ...(id ? { id } : {}),
      from: me.id,
      kind: "mono",
      text: words,
      ...(wake.trigger ? { replyTo: wake.trigger } : {}),
      pick: { by: "goal", why: wake.why },
    })?.message;
  }
  if (wake.batch?.length) {
    setAnsweredThrough(chatId, wake.convId, wake.batch[wake.batch.length - 1]);
    setRoomRuntime(chatId, { replyError: undefined });
  }
  const trigger = posted?.id ?? wake.trigger;
  if (!leading) goalTurn(chatId, wake.convId, g.lead, { trigger });
  else {
    const control = "control" in parsed ? parsed.control : undefined;
    if (!control) endGoal(chatId, wake.convId, "needs_input", `${me.name} didn't say who goes next`);
    else if (control.status === "continue") goalTurn(chatId, wake.convId, control.next, { trigger, instruction: control.instruction });
    else endGoal(chatId, wake.convId, control.status, control.reason);
  }
  return posted;
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

const RANK: Record<TurnKind, number> = { goal: 4, answer: 4, back: 3, reply: 2, chime: 1 };

/** One waiting turn per seat and conversation: a newer wake updates it (the stronger kind wins). */
function enqueue(chatId: string, wake: Wake): Wake {
  const r = roomOf(chatId);
  const same = r.queue.find((w) => w.monoId === wake.monoId && w.convId === wake.convId);
  if (!same) {
    r.queue.push(wake);
    return wake;
  }
  if (RANK[wake.kind] >= RANK[same.kind]) Object.assign(same, { ...wake, id: same.id });
  else same.trigger = wake.trigger ?? same.trigger;
  return same;
}

// ---- Gathered answers (WP-245) -------------------------------------------------------------------------------------

/** How long the room holds the answers that came in for the ones still being written. */
export const GATHER_MS = 3 * 60_000;
let gatherMs = GATHER_MS;
let gathering = true;
/** Tests and proofs: a shorter wait. */
export function setRoomGatherTimeout(ms: number | undefined): void {
  gatherMs = ms ?? GATHER_MS;
}
/** On by default; off, every answer lands as soon as it is written (the room before WP-245). */
export function setRoomGathering(on: boolean): void {
  gathering = on;
}
let gatherSeq = 0;

/** Several seats are about to answer one message of Ash's: hold their answers until all are in (or the wait ends). */
function openGather(chatId: string, convId: string, gen: number, members: readonly string[]): string | undefined {
  const unique = [...new Set(members)];
  if (!gathering || unique.length < 2) return undefined;
  const r = roomOf(chatId);
  const g: Gather = { id: `gather-${++gatherSeq}`, convId, gen, members: unique, done: new Set(), held: new Map() };
  g.timer = setTimeout(() => releaseGather(chatId, g, true), gatherMs);
  r.gathers.set(g.id, g);
  return g.id;
}

/** A seat whose waiting turn kept an older wake (a stronger kind already queued) isn't part of the gather. */
function keepGathered(chatId: string, id: string, wakes: readonly Wake[]): void {
  const g = roomOf(chatId).gathers.get(id);
  if (!g) return;
  g.members = g.members.filter((m) => wakes.some((w) => w.monoId === m && w.gather === id));
  if (g.members.length < 2) releaseGather(chatId, g, false);
}

function gatherOf(chatId: string, wake: Wake): Gather | undefined {
  const g = wake.gather ? roomOf(chatId).gathers.get(wake.gather) : undefined;
  return g && !g.closed && g.members.includes(wake.monoId) ? g : undefined;
}

/** The seat is through (quiet, failed, or its post went out another way): the gather may be complete. */
function gatherDone(chatId: string, wake: Wake): void {
  const g = gatherOf(chatId, wake);
  if (!g) return;
  g.done.add(wake.monoId);
  if (g.members.every((m) => g.done.has(m))) releaseGather(chatId, g, false);
}

/**
 * Hold a finished answer for its gather: it stays on screen as a held live message (its words, "Waiting for the others
 * to answer") and `post` puts it in the room when the gather lands. False when the turn isn't part of an open gather.
 */
function holdForGather(chatId: string, wake: Wake, me: Seat, text: string, id: string | undefined, post: (id: string) => void): boolean {
  const g = gatherOf(chatId, wake);
  if (!g) return false;
  const r = roomOf(chatId);
  const shown = id ?? newMessageId(me.id);
  r.drafts.set(`held:${wake.id}`, {
    id: shown,
    wakeId: wake.id,
    gen: wake.gen,
    monoId: me.id,
    convId: wake.convId,
    text,
    ...(wake.trigger ? { replyTo: wake.trigger } : {}),
    quiet: wake.kind === "chime" || wake.kind === "reply",
    pick: { by: wake.by, why: wake.why },
    startedAt: Date.now(),
    held: true,
  });
  g.held.set(me.id, () => {
    r.drafts.delete(`held:${wake.id}`);
    post(shown);
  });
  notify();
  gatherDone(chatId, wake);
  return true;
}

/** The answers land together, in seat order; a seat still writing when the wait ended is named. */
function releaseGather(chatId: string, g: Gather, timedOut: boolean): void {
  if (g.closed) return;
  g.closed = true;
  if (g.timer) clearTimeout(g.timer);
  const r = roomOf(chatId);
  r.gathers.delete(g.id);
  const late = timedOut ? g.members.filter((m) => !g.done.has(m)) : [];
  for (const m of g.members) g.held.get(m)?.();
  if (late.length && g.held.size) {
    const names = late.map(nameOf);
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    const secs = Math.max(1, Math.round(gatherMs / 1000));
    const wait = secs >= 120 ? `${Math.round(secs / 60)} minutes` : secs === 1 ? "a second" : `${secs} seconds`;
    appendMessage(chatId, g.convId, {
      id: newMessageId("app"),
      from: "app",
      kind: "system",
      text: `No answer from ${list} within ${wait}.`,
    });
  }
  notify();
  pump(chatId);
}

/** Ash moved the conversation on (or stopped it): whatever was held lands now. */
function flushGathers(chatId: string, convId?: string): void {
  for (const g of [...roomOf(chatId).gathers.values()]) if (!convId || g.convId === convId) releaseGather(chatId, g, false);
}

function pump(chatId: string): void {
  const r = roomOf(chatId);
  while (r.running.size < MAX_PARALLEL_TURNS) {
    const at = r.queue.findIndex(
      (w) => free(r, w) && (w.kind === "back" || !threadOf(r, w.convId).paused),
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

function noteLine(wake: Wake): string {
  switch (wake.kind) {
    case "answer":
      return forUser("Answered Ash");
    case "chime":
      return `Added to ${wake.other ?? "the host"}'s answer`;
    case "reply":
      return `Answered ${wake.other ?? "someone in the room"}`;
    case "back":
      return `Reported "${wake.back?.title ?? "work"}" back`;
    case "goal":
      return "Worked toward the room's goal";
  }
}

/** A goal turn's part of the prompt: the goal, its lead, the turn and the lead's instruction. */
function goalInput(chatId: string, wake: Wake, seats: readonly Seat[]): { goal?: NonNullable<Parameters<typeof turnPrompt>[0]["goal"]> } {
  const g = threadOf(roomOf(chatId), wake.convId).goal;
  const lead = g ? seats.find((s) => s.id === g.lead) : undefined;
  if (wake.kind !== "goal" || !g || !lead || !wake.goal) return {};
  return {
    goal: {
      lead,
      goal: g.text,
      turn: wake.goal.turn,
      max: GOAL_MAX_TURNS,
      ...(wake.goal.instruction ? { instruction: wake.goal.instruction } : {}),
      ...(wake.goal.ashAnswered ? { ashAnswered: true } : {}),
    },
  };
}

async function start(chatId: string, wake: Wake): Promise<void> {
  const r = roomOf(chatId);
  const chat = getChat(chatId);
  const seats = chat ? seatsOf(chat) : [];
  const me = seats.find((s) => s.id === wake.monoId);
  const conv = chat?.conversations.find((c) => c.id === wake.convId);
  if (!chat || !me || !conv || !runner) {
    gatherDone(chatId, wake);
    // WP-22: a goal turn for a seat that has left ends the run, with a line, rather than leaving it waiting forever.
    if (wake.kind === "goal" && !stale(r, wake)) endGoal(chatId, wake.convId, "blocked", `${nameOf(wake.monoId)} isn't in the room any more`);
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
    projectName: hubData().listProjects().find((p) => p.id === chat.projectId)?.name,
    me,
    seats,
    host: hostOf(seats, chat.leadId),
    kind: wake.kind,
    batch: wake.batch?.length,
    statusAsk: statusAsked(chatId, wake),
    rolesAsk: rolesAsked(chatId, wake),
    other: wake.other,
    speaker: speakerOf(conv.messages, wake).name,
    back: wake.back,
    transcript: roomTranscript(conv.messages, nameOf, 30, wake.kind === "reply" ? wake.trigger : undefined),
    ...(chat.conversations.length > 1 ? { conversation: { title: conv.title, startedAt: conv.createdAt } } : {}),
    cards: draftStatusLines(me.id, { room: chatId, conv: conv.id }),
    monosNow: liveMonosNote(me.id),
    ...(wake.picked ? { picked: true } : {}),
    ...goalInput(chatId, wake, seats),
  };
  const attachments = turnAttachments(conv.messages, wake);
  let outcome: RoomTurnOutcome;
  try {
    outcome = await runner.run({
      monoId: me.id,
      chatId,
      convId: wake.convId,
      projectId: chat.projectId,
      wakeId: wake.id,
      ...(attachments.length ? { attachments } : {}),
      prompt: turnPrompt(base),
      wakePrompt: turnPrompt({ ...base, viaTool: true }),
      speaker: speakerOf(conv.messages, wake),
      note: { kind: "room", room: chat.name, roomId: chatId, line: noteLine(wake) },
      onText: (text) => showDraft(chatId, wake, me, text),
      onActivity: (activity) => {
        if (r.running.get(me.id) !== running) return;
        running.activity = activity;
        notify();
      },
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
    // WP-22: a goal turn that ended without posting moves the run on as a silent turn.
    // One that already posted (room_post) has moved the run on: how its own session ends afterwards changes nothing.
    if (wake.kind === "goal" && wake.stepped) {
      /* already taken up */
    } else if (wake.kind === "goal" && end.status === "done") landGoal(chatId, wake, me, NO_REPLY);
    else if (wake.kind === "goal" && end.status === "dropped") endGoal(chatId, wake.convId, "blocked", `${me.name}'s turn didn't run`);
    else if (end.status === "failed") failed(chatId, wake, me, end.error ?? "Its turn did not finish.");
    // Ash must never be left without an answer: the host that finished its own work without one says so.
    else if (wake.kind === "answer" && !running.answered && end.status === "done")
      noteFor(chatId, wake, me, `${me.name} finished its own work without answering here.`);
    // WP-245: a wake answered from the Mono's own chat posted there (room_post) or not at all: either way it is through.
    gatherDone(chatId, wake);
  }
  pump(chatId);
}

/** What the other Monos posted in this conversation since Ash's last message. */
function othersSinceAsh(chatId: string, convId: string | undefined, me: string): string[] {
  const chat = getChat(chatId);
  const conv = chat?.conversations.find((c) => c.id === convId) ?? chat?.conversations[chat.conversations.length - 1];
  if (!conv) return [];
  const out: string[] = [];
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.from === "ash") break;
    if (m.kind === "mono" && m.from !== me && m.text) out.push(m.text);
  }
  return out;
}

/** r64: Ash asked where things stand ("wat now", "whats landed") in the messages this answer or chime is about. */
function statusAsked(chatId: string, wake: Wake): boolean {
  if (wake.kind !== "answer" && wake.kind !== "chime") return false;
  const ids = new Set(wake.kind === "answer" ? (wake.batch ?? []) : wake.trigger ? [wake.trigger] : []);
  const conv = getChat(chatId)?.conversations.find((c) => c.id === wake.convId);
  return !!conv?.messages.some((m) => m.from === "ash" && ids.has(m.id) && isStatusAsk(m.text) && !isRolesAsk(m.text));
}

/**
 * r66 (Alfred, 0.16.5 A-row): Ash asked who does what. Every seat answers for itself (the no-repeat and status-only-host
 * rules are for status asks), and nobody describes another seat's role.
 */
function rolesAsked(chatId: string, wake: Wake): boolean {
  if (wake.kind !== "answer" && wake.kind !== "chime") return false;
  const ids = new Set(wake.kind === "answer" ? (wake.batch ?? []) : wake.trigger ? [wake.trigger] : []);
  const conv = getChat(chatId)?.conversations.find((c) => c.id === wake.convId);
  return !!conv?.messages.some((m) => m.from === "ash" && ids.has(m.id) && isRolesAsk(m.text));
}

/** The names Ash and the Monos use for the other seats: name, aliases and initials ("Projects Manager", "PM"). */
function otherSeatNames(chatId: string, me: Seat): string[] {
  const chat = getChat(chatId);
  if (!chat) return [];
  const out = new Set<string>();
  for (const seat of seatsOf(chat)) {
    if (seat.id === me.id) continue;
    for (const n of [seat.name, ...(seat.aliases ?? [])]) {
      if (!n?.trim()) continue;
      out.add(n.trim());
      const words = n.trim().split(/\s+/);
      if (words.length > 1) out.add(words.map((w) => w[0]).join(""));
    }
  }
  return [...out].filter((n) => n.length >= 2);
}

/** A roles-ask post with the sentences about other seats taken out; the rest stands. */
function ownRoleOnly(chatId: string, wake: Wake, me: Seat, text: string): string {
  if (!rolesAsked(chatId, wake)) return text;
  const own = stripOtherSeats(text, otherSeatNames(chatId, me));
  if (!own.dropped.length || !own.text.trim()) return text;
  logDropped({ chatId, monoId: me.id, why: "other-seats", text: own.dropped.join(" ") });
  return own.text;
}

/** Who wrote the message a turn answers: Ash for an answer or a chime, the Mono that posted it for a reply. */
function speakerOf(messages: readonly ChatMessage[], wake: Wake): { id: string; name: string } {
  const from = wake.trigger ? messages.find((m) => m.id === wake.trigger)?.from : undefined;
  if (wake.kind === "answer" || !from || from === "ash") return { id: "ash", name: userLabel() };
  return { id: from, name: nameOf(from) };
}

/**
 * The files a turn hands its Mono: what Ash attached to the messages it answers, or to the message of his it adds to
 * (a chime). Later turns see them in the transcript by name and path.
 */
function turnAttachments(messages: readonly ChatMessage[], wake: Wake): RoomAttachment[] {
  const ids = new Set([...(wake.batch ?? []), ...(wake.trigger ? [wake.trigger] : [])]);
  const out: RoomAttachment[] = [];
  for (const m of messages)
    if (m.from === "ash" && ids.has(m.id)) for (const file of m.attachments ?? []) if (!out.some((x) => x.path === file.path)) out.push(file);
  return out;
}

/**
 * A managed turn's reply becomes the post (a bare acknowledgement becomes a 👍 on what it answers). `id`: the live
 * message it replaces, so the room shows one message that filled in rather than a new one.
 */
function land(chatId: string, wake: Wake, me: Seat, text: string, id?: string): void {
  if (wake.kind === "goal") {
    const posted = landGoal(chatId, wake, me, text, id);
    if (posted) afterPost(chatId, wake.convId, posted, wake);
    return;
  }
  if (wake.kind === "answer" && !text.trim()) {
    failed(chatId, wake, me, "The Mono finished without a text reply. Open its conversation to inspect the result.");
    return;
  }
  const answered = () => {
    if (wake.kind !== "answer" || !wake.batch?.length) return;
    setAnsweredThrough(chatId, wake.convId, wake.batch[wake.batch.length - 1]);
    setRoomRuntime(chatId, { replyError: undefined });
  };
  // r64 (realconv S8): sentences about the seat's own process ("I'll check the board before I add anything.", "CoS
  // already set the order.", "nothing to add") are dropped; a post that was only that isn't posted. Logged, never shown.
  // A bare "Got it." stays as it is: it becomes a 👍 below.
  const meta = isSilent(text) && !/NO_REPLY/i.test(text) ? { text, dropped: [] } : stripMeta(text);
  if (meta.dropped.length) {
    logDropped({ chatId, monoId: me.id, why: "meta", text: meta.dropped.join(" ") });
    text = meta.text.trim() || NO_REPLY;
  }
  // r66: on a roles ask each seat speaks for itself: what it said about another seat's role is dropped.
  const roles = !isSilent(text) && rolesAsked(chatId, wake);
  if (roles) text = ownRoleOnly(chatId, wake, me, text);
  // r64: on a status ask the host gives the one combined status; another seat adds one missed fact at most.
  if (wake.kind === "chime" && !isSilent(text) && statusAsked(chatId, wake) && isSecondStatus(withoutNoReply(text))) {
    logDropped({ chatId, monoId: me.id, why: "second-status", text });
    text = NO_REPLY;
  }
  // r67 (S8 on 0.16.8): on a status ask a seat that isn't the host posts nothing at all unless it has a missed fact: an
  // acknowledgement or a line about what it is about to do ("I'll check the board ... before I stay quiet.") goes, whole.
  if (wake.kind === "chime" && !isSilent(text) && statusAsked(chatId, wake) && isAckOrIntentOnly(withoutNoReply(text))) {
    logDropped({ chatId, monoId: me.id, why: "status-ack", text });
    text = NO_REPLY;
  }
  // Words Ash already watched arrive stay in the room: a turn that wrote them and then decided on NO_REPLY posts them
  // without it, rather than its live message vanishing when the turn ends (r52, ed). Unseen, it stays quiet.
  // r67 (S8 on 0.16.9 dev): not for a seat that chimed in unasked and narrated its way to NO_REPLY. ed's "Ash locked
  // two calls. I'll check they're actually in Tally's memory before I say anything." then NO_REPLY posted "Ash locked two
  // calls.", a lead-in to the narration that adds nothing; the seat chose silence, so its draft goes with the narration.
  const narratedChime = wake.kind === "chime" && meta.dropped.length > 0;
  const kept = id && !narratedChime && /\n\W*NO_REPLY\W*$/i.test(text.trim()) ? withoutNoReply(text).trim() : "";
  if (kept && !isSilent(kept) && !(wake.kind === "chime" && isAckOrIntentOnly(kept))) text = kept;
  // r63: a near-copy of what another Mono already said since Ash last wrote stays out (add something new or stay quiet).
  // A roles ask is exempt: each seat's own role is never a copy of another's answer.
  else if (isSilent(text) || (!roles && repeatsAnother(text, othersSinceAsh(chatId, wake.convId, me.id)))) {
    if (!isSilent(text)) text = NO_REPLY;
    // "Got it" is a 👍 on what it answers; the host that has nothing to say to Ash still shows it read him.
    const emoji = /<reaction>\s*(✅|👀)\s*<\/reaction>/.exec(text)?.[1] ?? "👍";
    const ack = !!text.trim() && !/^\W*NO_REPLY/i.test(text.trim()) && !/\n\W*NO_REPLY\W*$/i.test(text.trim());
    if (wake.trigger && (ack || wake.kind === "answer")) react(chatId, wake.trigger, me.id, ack ? emoji : "👍", true);
    answered();
    gatherDone(chatId, wake);
    if (wake.kind === "answer") {
      const chat = getChat(chatId);
      if (chat) roomTurn(chatId, wake, seatsOf(chat), me.name);
      pump(chatId);
    }
    return;
  }
  const words = cleanPost(text, me.name);
  const post = (shown: string | undefined, gather?: string) => {
    const posted = appendMessage(chatId, wake.convId, {
      ...(shown ? { id: shown } : {}),
      from: me.id,
      kind: "mono",
      text: words,
      ...(wake.trigger ? { replyTo: wake.trigger } : {}),
      pick: { by: wake.by, why: wake.why },
      ...(wake.kind === "chime" || wake.kind === "reply" ? { quiet: true } : {}),
      ...(gather ? { gather } : {}),
    });
    if (posted) afterPost(chatId, posted.convId, posted.message, wake);
  };
  answered();
  // WP-245: one of several answers to the same message waits for the others, then they land together.
  if (holdForGather(chatId, wake, me, words, id, (shown) => post(shown, wake.gather))) return;
  post(id);
}

/** Never silent: a turn that failed, ran out of budget or couldn't start says so in the thread. */
function failed(chatId: string, wake: Wake, me: Seat, error: string): void {
  // WP-22: a goal turn already taken up (it posted, or the run ended) has nothing left to fail.
  if (wake.kind === "goal" && wake.stepped) return;
  notice(chatId, wake, me, failureNotice(me.name, error, me.engine));
  gatherDone(chatId, wake);
  if (wake.kind === "goal") endGoal(chatId, wake.convId, "blocked", `${me.name}'s turn failed`);
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
  if (posted) r.retries.set(posted.message.id, { ...wake, id: newWakeId(me.id), stepped: undefined });
}

/** A status note in the strip above the composer, not a message in the room (AD6, AD12). */
function noteFor(chatId: string, wake: Wake, me: Seat, text: string): void {
  threadOf(roomOf(chatId), wake.convId).note = { text, mono: me.id, wake };
  notify();
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
  // WP-22: Try again on a goal turn that failed picks the run up again from that turn.
  if (wake.kind === "goal") {
    const goal = threadOf(r, wake.convId).goal;
    // A run that has since ended or moved on has no use for this turn.
    if (goal?.state !== "blocked") return Promise.resolve();
    Object.assign(goal, { state: "running", reason: undefined });
  }
  enqueue(chatId, { ...wake, gen: wake.gen < 0 ? -1 : threadOf(r, wake.convId).gen });
  pump(chatId);
  return roomIdle(chatId, wake.convId);
}

// ---- After a post ------------------------------------------------------------------------------------------------

/** A Mono posted: count it against the loop brake, then wake the seats it names (and, after an answer, the lanes). */
function afterPost(chatId: string, convId: string, message: ChatMessage, wake?: Wake): string[] {
  const r = roomOf(chatId);
  const t = threadOf(r, convId);
  const chat = getChat(chatId);
  const conv = chat?.conversations.find((c) => c.id === convId);
  if (!chat || !conv || !isMonoPost(message)) return [];
  let seats = seatsOf(chat);
  // A project's Leadership room: naming the project's lead brings it in (Ash 12 Nov: the Chief of Staff asked the
  // Hivra lead to say hi there and nobody was woken, because the lead had no seat).
  const lead = chat.id === leadershipChatId(chat.projectId) ? projectLeadOf(chat.projectId) : undefined;
  const leadMonoNow = lead ? leadMono(lead) : undefined;
  if (leadMonoNow && !chat.memberIds.includes(leadMonoNow.id) && message.from !== leadMonoNow.id) {
    const withLead = seatsOf({ ...chat, memberIds: [...chat.memberIds, leadMonoNow.id] });
    if (addressedIn(message.text, withLead, message.from).includes(leadMonoNow.id)) {
      addMember(chat.id, leadMonoNow.id);
      seats = withLead;
    }
  }
  t.posts++;
  // The seat the strip said hadn't answered just did.
  if (t.note?.mono === message.from) t.note = undefined;
  // WP-22: during a goal run the lead says who speaks next; naming a seat doesn't wake it.
  if (t.paused || t.goal?.state === "running") {
    pump(chatId);
    return [];
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
      gen: t.gen,
    });
  // The loop brake: the wakes this post made wait with the room, and "keep going" runs them.
  if (t.posts >= MONO_POSTS_CEILING) {
    pause(chatId, convId, "ceiling");
    pump(chatId);
    return [];
  }
  if (wake?.kind === "answer") roomTurn(chatId, wake, seats, speaker, named);
  pump(chatId);
  return named;
}

/**
 * Ash wrote to the room without naming anyone (the host answered): every other seat gets its one turn, once, on Ash's
 * message. The host answering NO_REPLY or a 👍 still opens it. Seats the host named already have their reply wake.
 */
function roomTurn(chatId: string, wake: Wake, seats: readonly Seat[], other: string, named: readonly string[] = []): void {
  if (wake.by !== "lead" || !wake.batch?.length) return;
  // WP-22: only an "everyone" room gives every other seat its turn.
  if (responderOf(getChat(chatId) ?? {}) !== "everyone") return;
  const t = threadOf(roomOf(chatId), wake.convId);
  if (t.gen !== wake.gen || t.paused) return;
  const ash = wake.batch[wake.batch.length - 1];
  const chiming = everyoneElse(seats, wake.monoId).filter((seat) => !named.includes(seat.id) && !t.chimed.has(seat.id));
  // WP-245: the other seats' answers to the whole room land together.
  const gather = openGather(chatId, wake.convId, t.gen, chiming.map((seat) => seat.id));
  const joined: Wake[] = [];
  for (const seat of chiming) {
    t.chimed.add(seat.id);
    joined.push(
      enqueue(chatId, { id: newWakeId(seat.id), monoId: seat.id, convId: wake.convId, kind: "chime", by: "room", why: forUser("Ash wrote to the whole room"), other, trigger: ash, gen: t.gen, ...(gather ? { gather } : {}) }),
    );
  }
  if (gather) keepGathered(chatId, gather, joined);
}

function pauseText(t: Thread, reason: PauseReason): string {
  if (reason === "stopped") return "You stopped the room. The team waits for you.";
  return `The team has posted ${t.posts} messages since you last wrote, so it paused here for you.`;
}

function pause(chatId: string, convId: string, reason: PauseReason): void {
  const r = roomOf(chatId);
  const t = threadOf(r, convId);
  const held = r.queue.filter((w) => w.convId === convId && w.kind !== "back");
  r.queue = r.queue.filter((w) => !(w.convId === convId && w.kind !== "back"));
  t.paused = { reason, wakes: reason === "stopped" ? [] : held };
  // Shown in the strip above the composer (roomStrip), not posted as a line in the room (AD6, AD12).
  notify();
}

/** Ash's Stop: every room turn in the conversation (all of them without one) stops, and the room waits for him. */
export function stopRoom(chatId: string, convId?: string): void {
  const r = roomOf(chatId);
  flushGathers(chatId, convId);
  const touched = new Set<string>();
  for (const w of r.queue) if (w.kind !== "back" && (!convId || w.convId === convId)) touched.add(w.convId);
  for (const run of r.running.values()) if (run.wake.kind !== "back" && (!convId || run.wake.convId === convId)) touched.add(run.wake.convId);
  for (const id of r.deciding.keys()) if (!convId || id === convId) touched.add(id);
  if (convId) touched.add(convId);
  r.queue = r.queue.filter((w) => w.kind === "back" || !touched.has(w.convId));
  for (const [monoId, run] of r.running)
    if (touched.has(run.wake.convId) && run.wake.kind !== "back")
      void Promise.resolve(runner?.stop?.(monoId, run.wake.id)).catch(() => undefined);
  for (const id of touched) {
    const t = threadOf(r, id);
    endGoal(chatId, id, "stopped", "you stopped the room");
    r.deciding.delete(id);
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
  Object.assign(t, { paused: undefined, posts: 0 });
  const line = appendMessage(chatId, convId, { id: newMessageId("app"), from: "app", kind: "system", text: forUser("Ash asked the team to keep going.") });
  const chat = getChat(chatId);
  if (held.length) for (const w of held) enqueue(chatId, { ...w, gen: t.gen });
  else if (chat && line) {
    const host = hostOf(seatsOf(chat), chat.leadId);
    if (host)
      enqueue(chatId, { id: newWakeId(host.id), monoId: host.id, convId, kind: "reply", by: "lead", why: forUser("Ash asked the team to keep going"), other: userLabel(), trigger: line.message.id, gen: t.gen });
  }
  pump(chatId);
}

/** Nothing left in the room: anyone waiting for it to go quiet is told. */
function settleIfIdle(chatId: string): void {
  const r = roomOf(chatId);
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
  if (!chat.memberIds.includes(monoId)) throw new Error(forUser`You're not in ${chat.name}. Ask Ash to add you if you should be.`);
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
        ? forUser("Ash stopped this conversation. Post again only when he writes; tell him in your own chat if it can't wait.")
        : forUser("This conversation is paused waiting for Ash. Tell him in your own chat if it can't wait."),
    );
  const now = options.now ?? Date.now();
  const times = (r.posts.get(monoId) ?? []).filter((at) => now - at < 60_000);
  if (times.length >= POSTS_PER_MINUTE) throw new Error(`Slow down: at most ${POSTS_PER_MINUTE} posts a minute in a room. Put it in one message.`);
  // The wake it was woken for, unless Ash has written since (then this is a post of its own).
  const wake = running && running.wake.convId === convId && !stale(r, running.wake) ? running.wake : undefined;
  const replyTo = options.replyTo ?? wake?.trigger;
  if (replyTo && !chat.conversations.some((c) => c.messages.some((m) => m.id === replyTo))) throw new Error(`No message ${replyTo} in ${chat.name}.`);
  const me = seatsOf(chat).find((s) => s.id === monoId)!;
  // WP-22: a busy Mono's goal turn posted from its own chat: read like a managed goal turn's reply.
  if (wake?.kind === "goal" && running) {
    r.posts.set(monoId, [...times, now]);
    running.answered = true;
    const goalPost = landGoal(chatId, wake, me, text);
    if (goalPost) afterPost(chatId, wake.convId, goalPost, wake);
    pump(chatId);
    return goalPost
      ? { posted: goalPost, convId: wake.convId, note: "Posted. The goal run carries on; carry on with your work." }
      : { convId: wake.convId, note: "Nothing to post; the goal run carries on." };
  }
  const raw = cleanPost(text, me.name);
  const meta = isSilent(raw) && !/NO_REPLY/i.test(raw) ? { text: raw, dropped: [] } : stripMeta(raw);
  if (meta.dropped.length) logDropped({ chatId, monoId, why: "meta", text: meta.dropped.join(" ") });
  const clean = meta.text;
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
  const woken = afterPost(chatId, posted.convId, posted.message, wake);
  return { posted: posted.message, convId: posted.convId, note: postedNote(chatId, monoId, woken) };
}

/** What room_post tells the poster: who it really woke, or that it woke nobody and how to reach someone outside. */
function postedNote(chatId: string, monoId: string, woken: readonly string[]): string {
  if (woken.length) return `Posted. Woke ${woken.map(nameOf).join(", ")}; carry on with your work.`;
  const others = (getChat(chatId)?.memberIds ?? []).filter((id) => id !== monoId).map(nameOf);
  const seats = others.length ? `This room's other seats are ${others.join(", ")}. ` : "";
  return `Posted. Nobody was woken: you didn't name anyone in this room. ${seats}Name a seat to wake it, or reach a Mono outside the room with mono_message.`;
}

/**
 * A Lead's report on a brief from a leadership Mono lands in the room (double delegation, roomReports.ts): the Lead's
 * report, then the briefing Mono's answer to it, which was its own turn on the report in its chat (the H2 report-back
 * path), so the room's "one answers" holds. Then the seats the answer names look at it. Posting
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
    // The Lead's report is the room's news, not a seat's turn: only the answer counts toward the brake.
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
  for (const r of rooms.values()) for (const g of r.gathers.values()) if (g.timer) clearTimeout(g.timer);
  rooms.clear();
  gatherMs = GATHER_MS;
  gathering = true;
  runner = undefined;
}
