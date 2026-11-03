// WP-22: who answers in a room, and goal mode (docs/hivra/SPEC.md section 6; docs/hivra/work/WP-22-groups.md).
//
// Responder modes, after OpenMausBot's room responder kinds (agent, everyone, mentions, auto; ideas only, see
// docs/hivra/SOURCES.md):
// - lead: the room's lead answers, unless Ash @mentions someone (then they do).
// - mentions: only the seats Ash mentions answer; with nobody mentioned, nobody does.
// - everyone: the room before modes (the default): the lead answers first, then every other seat may add one reply.
// - auto: a fast, cheap model picks one seat or several. It fails open: on a timeout, an error, an unsure or low
//   confidence answer, or no model configured, the lead answers. The room never waits longer than AUTO_PICK_TIMEOUT_MS.
//
// Goal mode, after OpenMausBot's bounded goal run: the lead works toward a goal Ash set for at most GOAL_MAX_TURNS
// turns. Each lead turn ends with a <room_control> block the app reads and hides: who speaks next and what they should
// do, or that the run stopped (completed, needs input, blocked) and why.
//
// Everything here is pure; roomConductor.ts runs it.
import { addressedIn, cardOf, type Seat } from "./roomTurns";
import type { ResponderMode } from "./types";

export const RESPONDER_MODES: readonly ResponderMode[] = ["lead", "mentions", "everyone", "auto"];
/** A room that never chose keeps the behaviour it had before modes. */
export const DEFAULT_RESPONDER: ResponderMode = "everyone";

export function isResponderMode(value: unknown): value is ResponderMode {
  return typeof value === "string" && (RESPONDER_MODES as readonly string[]).includes(value);
}
export function responderOf(chat: { responder?: unknown }): ResponderMode {
  return isResponderMode(chat.responder) ? chat.responder : DEFAULT_RESPONDER;
}

/** The mode in a few words, for the room's settings. */
export const RESPONDER_LABELS: Readonly<Record<ResponderMode, { label: string; hint: string }>> = {
  lead: { label: "The lead", hint: "The lead answers, unless you @mention someone." },
  mentions: { label: "Who you mention", hint: "Only the members you @mention answer." },
  everyone: { label: "Everyone", hint: "The lead answers first, then anyone with something to add." },
  auto: { label: "Auto", hint: "A quick model picks who answers. If it's slow or unsure, the lead answers." },
};

/**
 * Every seat Ash's messages address, in order: @mentions anywhere, or a name opening a line or sentence ("frank, ...").
 * The latest message counts first, as answerPick does.
 */
export function mentionedSeats(messages: readonly string[], seats: readonly Seat[]): Seat[] {
  const out: Seat[] = [];
  for (const text of [...messages].reverse())
    for (const id of addressedIn(text, seats, "ash")) {
      const seat = seats.find((s) => s.id === id);
      if (seat && !out.includes(seat)) out.push(seat);
    }
  return out;
}

// ---- Auto ---------------------------------------------------------------------------------------------------------

/** The longest the room waits for the auto pick before the lead answers. */
export const AUTO_PICK_TIMEOUT_MS = 1_500;
/** Below this confidence the pick counts as unsure. */
export const AUTO_MIN_CONFIDENCE = 0.6;
/** Messages of the conversation the decider sees. */
export const AUTO_RECENT_MESSAGES = 6;

export type AutoPrompt = { system: string; prompt: string };

export function autoPickPrompt(seats: readonly Seat[], recent: readonly { who: string; text: string }[]): AutoPrompt {
  const system =
    "You route messages in a group chat between a person and several AI agents. Pick who should answer the person's " +
    'latest message. Reply with JSON only: {"pick":["<id>", ...],"confidence":<0 to 1>}. Pick one member, or several ' +
    'only when the message plainly needs each of them. If you can\'t tell, reply {"pick":[],"confidence":0}.';
  const members = seats.map((s) => `- id "${s.id}": ${cardOf(s)}`).join("\n");
  const lines = recent.map((m) => `${m.who}: ${m.text.replace(/\s+/g, " ").slice(0, 600)}`).join("\n");
  return { system, prompt: `Members:\n${members}\n\nLatest messages, oldest first:\n${lines}\n\nWho answers the last message?` };
}

export type AutoAnswer = { ids: string[]; confidence: number } | { unsure: string };

/** The decider's reply as seats, or why it counts as unsure. Ids or names both count; anything else is unsure. */
export function parseAutoPick(reply: string, seats: readonly Seat[]): AutoAnswer {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  if (!json) return { unsure: "no answer" };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { unsure: "no answer" };
  }
  const v = value as { pick?: unknown; confidence?: unknown };
  const raw = Array.isArray(v.pick) ? v.pick : typeof v.pick === "string" ? [v.pick] : [];
  const confidence = typeof v.confidence === "number" && Number.isFinite(v.confidence) ? v.confidence : 0;
  const ids: string[] = [];
  for (const said of raw) {
    if (typeof said !== "string") continue;
    const key = said.trim().toLowerCase();
    const seat = seats.find((s) => s.id.toLowerCase() === key || s.name.trim().toLowerCase() === key);
    if (seat && !ids.includes(seat.id)) ids.push(seat.id);
  }
  if (!ids.length) return { unsure: "unsure" };
  if (confidence < AUTO_MIN_CONFIDENCE) return { unsure: "low confidence" };
  return { ids, confidence };
}

/** Asks the configured quick model; rejects on any failure. `signal` aborts when the room stops waiting. */
export type RoomDecider = (input: AutoPrompt & { signal: AbortSignal; timeoutMs: number }) => Promise<string>;

export type AutoResult = { ids: string[]; why: string } | { fallback: string };

/**
 * The auto pick, bounded: the decider's answer within `timeoutMs`, or a fallback with its reason (the caller hands the
 * turn to the lead). Never throws, never waits longer than `timeoutMs`.
 */
export async function autoPick(input: {
  decider: RoomDecider | undefined;
  seats: readonly Seat[];
  recent: readonly { who: string; text: string }[];
  timeoutMs?: number;
}): Promise<AutoResult> {
  const timeoutMs = input.timeoutMs ?? AUTO_PICK_TIMEOUT_MS;
  if (!input.decider) return { fallback: "no quick model is set up" };
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const asked = Promise.resolve()
      .then(() => input.decider!({ ...autoPickPrompt(input.seats, input.recent), signal: abort.signal, timeoutMs }))
      .then((text) => ({ text }), () => ({ error: true as const }));
    const out = await Promise.race([asked, late]);
    if (out === "timeout") return { fallback: "the quick pick took too long" };
    if ("error" in out) return { fallback: "the quick pick failed" };
    const answer = parseAutoPick(out.text, input.seats);
    if ("unsure" in answer) return { fallback: answer.unsure === "low confidence" ? "the quick pick wasn't sure" : "the quick pick was unsure" };
    return { ids: answer.ids, why: "picked automatically" };
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
  }
}

// ---- Goal mode ----------------------------------------------------------------------------------------------------

/** Turns a goal run takes at most, counting every member's turn (the lead's included). */
export const GOAL_MAX_TURNS = 13;

export type GoalStop = "completed" | "needs_input" | "blocked";
export type GoalState = "running" | GoalStop | "stopped";
export type GoalControl =
  | { status: "continue"; next: string; instruction: string }
  | { status: GoalStop; reason: string };

const CONTROL = /<room_control>([\s\S]*?)<\/room_control>/gi;

/**
 * A lead's goal turn: its words for the room (the control block taken out) and the control it gave, if any. A `next`
 * that isn't a seat in the room, or a block that can't be read, is no control.
 */
export function parseGoalControl(text: string, seats: readonly Seat[]): { post: string; control?: GoalControl } {
  const blocks = [...text.matchAll(CONTROL)];
  const post = text.replace(CONTROL, "").replace(/```\s*```/g, "").trim();
  const last = blocks[blocks.length - 1]?.[1];
  if (!last) return { post };
  const json = /\{[\s\S]*\}/.exec(last)?.[0];
  let v: { status?: unknown; next?: unknown; instruction?: unknown; reason?: unknown };
  try {
    v = JSON.parse(json ?? "");
  } catch {
    return { post };
  }
  const status = typeof v.status === "string" ? v.status.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  const words = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  if (status === "completed" || status === "needs_input" || status === "blocked")
    return { post, control: { status, reason: words(v.reason) } };
  if (status !== "continue") return { post };
  const said = words(v.next).toLowerCase().replace(/^@/, "");
  const seat = seats.find((s) => s.id.toLowerCase() === said || s.name.trim().toLowerCase() === said);
  if (!seat) return { post };
  return { post, control: { status: "continue", next: seat.id, instruction: words(v.instruction) } };
}

/** What a goal turn asks: the lead's (choose who goes next) or a member's (do what the lead asked). */
export function goalTask(input: {
  me: Seat;
  lead: Seat;
  seats: readonly Seat[];
  goal: string;
  turn: number;
  max: number;
  instruction?: string;
  /** The lead's turn takes up something Ash said since the run started (his answer to needs input). */
  ashAnswered?: boolean;
}): string {
  const goal = input.goal.replace(/\s+/g, " ").trim().slice(0, 2_000);
  if (input.me.id !== input.lead.id)
    return `${input.lead.name} is leading this room toward Ash's goal: "${goal}". ${input.lead.name} asked you: "${input.instruction || "add what your lane can"}". Do that from your lane and reply with the result, briefly. Don't choose who goes next; ${input.lead.name} does. If there is nothing for you, reply with exactly NO_REPLY.`;
  const ids = input.seats.map((s) => `"${s.id}" (${s.name})`).join(", ");
  return `You are leading this room toward a goal Ash set: "${goal}". This is turn ${input.turn} of at most ${input.max} for the whole room.${input.ashAnswered ? " Ash has written since; take up what he said." : ""}
Write your message to the room: progress, a decision, or what you did. Then end with exactly one control block, on its own lines:
<room_control>{"status":"continue","next":"<member id>","instruction":"what they should do now"}</room_control>
status is continue, completed, needs_input or blocked. With continue, next is one of ${ids} (your own id to take the next turn yourself) and instruction is one plain sentence. With completed, needs_input or blocked, give "reason" instead: one plain sentence for Ash. Stop as soon as the goal is met, or as soon as only Ash can unblock it. The app reads the block and hides it.`;
}

/** The plain line the room shows when a goal run ends. */
export function goalEndLine(state: Exclude<GoalState, "running">, reason?: string): string {
  const why = reason?.trim() ? `: ${reason.trim().replace(/\.$/, "")}.` : ".";
  switch (state) {
    case "completed":
      return `Goal completed${why}`;
    case "needs_input":
      return `Goal needs you${why}`;
    case "blocked":
      return `Goal blocked${why}`;
    case "stopped":
      return `Goal stopped${why}`;
  }
}
