import { examplesOn, examples } from "./examples";
// Group chats per project, behind the hub data layer. Mock store for now;
// Claude Code swaps in the backend (create chat, add/remove member, send,
// stream replies). Every made-up row is labelled "Example:".
import { useSyncExternalStore } from "react";
import { listMonos } from "../../monos/model/mono";
import { DEFAULT_TEAM_IDS } from "./builtInMonos";
import { leadFor } from "./hubLeads";
import {
  addressedIn,
  BOT_TURN_CAP,
  chimePrompt,
  isSilent,
  lanePick,
  laneChimes,
  parseChimes,
  parsePick,
  pickPrompt,
  plainFailure,
  roomTranscript,
  ruledPick,
  turnPrompt,
  type Chime,
  type Pick,
  type Seat,
  type TurnKind,
} from "./roomTurns";
import type { ChatConversation, ChatMessage, GroupChat } from "./types";

const m = (id: string, from: string, text: string, status?: ChatMessage["status"], refId?: string): ChatMessage => ({
  id,
  from,
  text,
  ...(status ? { status } : {}),
  ...(refId ? { refId } : {}),
});

let chats: GroupChat[] = examples([
  {
    id: "exo-game:leadership",
    projectId: "exo-game",
    name: "Leadership team",
    isDefault: true,
    memberIds: ["chief-of-staff", "projects-manager", "design-critic"],
    conversations: [
      {
        id: "c1",
        when: "Today",
        title: "Example: playtest plan",
        messages: [
          m("1", "chief-of-staff", "Example: morning Ash. The new level is in and working. Two things need you today: play Areas 1 and 2, and skim the four new rules."),
          m("2", "projects-manager", "Example: I've kept the list short. Air and dodge rules are next for the coding team, after your playtest."),
          m("3", "ash", "Example: ok playtest after lunch. can we move level 3 to next week?"),
          m("4", "projects-manager", "Example: yes. Moved to next week. Nothing else shifts."),
          m("5", "design-critic", "Example: I'll check the new HUD screens before they reach you."),
        ],
      },
      { id: "c2", when: "Yesterday", title: "Example: level 3 scope", messages: [m("1", "projects-manager", "Example: level 3 is two weeks of work if we keep the boss fight.")] },
      { id: "c3", when: "12 Oct", title: "Example: monthly goals", messages: [m("1", "chief-of-staff", "Example: three goals for October, parked until the playtest.")] },
    ],
  },
  {
    id: "hivra:leadership",
    projectId: "hivra",
    name: "Leadership team",
    isDefault: true,
    memberIds: ["chief-of-staff", "growth-lead"],
    conversations: [
      {
        id: "c1",
        when: "Today",
        title: "Example: backups and waitlist",
        messages: [
          m("1", "chief-of-staff", "Example: the nightly backup has failed 3 times since 2am. Nobody has picked it up yet.", "stuck", "s1"),
          m("2", "growth-lead", "Example: the waitlist headline test is a tie. That one is your taste call.", undefined, "n3"),
          m("3", "chief-of-staff", "Example: the lead tried two fixes for the email sender and gave up. It needs a person.", "lead_gave_up", "s2"),
        ],
      },
      { id: "c2", when: "Yesterday", title: "Example: launch timing", messages: [m("1", "growth-lead", "Example: launch looks best in the second week of November.")] },
    ],
  },
  {
    id: "nibbii:leadership",
    projectId: "nibbii",
    name: "Leadership team",
    isDefault: true,
    memberIds: [],
    conversations: [],
  },
]);

export function validGroupChats(value: unknown): GroupChat[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is GroupChat => !!c && typeof c.id === "string" &&
    typeof c.projectId === "string" && typeof c.name === "string" && typeof c.isDefault === "boolean" &&
    Array.isArray(c.memberIds) && c.memberIds.every((id: unknown) => typeof id === "string") &&
    Array.isArray(c.conversations) && c.conversations.every((v: unknown) => {
      if (!v || typeof v !== "object") return false;
      const x = v as Record<string, unknown>;
      return typeof x.id === "string" && typeof x.title === "string" && typeof x.when === "string" &&
        Array.isArray(x.messages) && x.messages.every((m: unknown) => !!m && typeof m === "object" &&
          typeof (m as ChatMessage).id === "string" && typeof (m as ChatMessage).from === "string" && typeof (m as ChatMessage).text === "string");
    }));
}

const CHAT_KEY = "monocode:hub-chats";
// Examples never replace or persist over real conversations.
if (!examplesOn()) {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CHAT_KEY) ?? "[]");
    chats = validGroupChats(saved).map((c) => c.replyPending ? { ...c, replyPending: undefined,
      replyError: "The previous reply was interrupted. Check the Mono's conversation before trying again." } : c);
  } catch { /* keep a clean roster if storage is unavailable */ }
}

const EVENT = "monocode:hub-chats-changed";
let version = 0;
function changed(): void {
  if (!examplesOn()) {
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(chats)); } catch { /* browser storage unavailable */ }
  }
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
}
function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
/** Re-render on any chat change. */
export function useHubChatsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

export function leadershipChatId(projectId: string): string {
  return `${projectId}:leadership`;
}

export function listChats(projectId: string): GroupChat[] {
  return chats.filter((c) => c.projectId === projectId);
}

export function getChat(id: string): GroupChat | undefined {
  return chats.find((c) => c.id === id);
}

/** Every project has a Leadership team. It is made empty here; seatDefaultTeam seats the default team once. */
export function ensureLeadership(projectId: string): GroupChat {
  const id = leadershipChatId(projectId);
  let chat = getChat(id);
  if (!chat) {
    chat = { id, projectId, name: "Leadership team", isDefault: true, memberIds: [], conversations: [] };
    chats = [...chats, chat];
    changed();
  }
  return chat;
}

const SEATED_KEY = "monocode:hub-leadership-seated";
function seatedChats(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(SEATED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * A project's Leadership team gets the default team (Chief of Staff, Projects Manager, frank, Alfred, as far as they
 * are on the roster) once, ahead of anyone already in it (Ash 14 Oct: every first project ships with them). Once per
 * chat: a Mono Ash takes out of the chat stays out, and one he removed from the roster is never added. Returns the chat.
 */
export function seatDefaultTeam(projectId: string): GroupChat {
  const chat = ensureLeadership(projectId);
  if (examplesOn()) return chat;
  const seated = seatedChats();
  if (seated.has(chat.id)) return chat;
  const roster = new Set(listMonos().map((m) => m.id));
  const team = DEFAULT_TEAM_IDS.filter((id) => roster.has(id));
  if (!team.length) return chat; // the roster isn't ready yet: try again next time
  const add = team.filter((id) => !chat.memberIds.includes(id));
  if (add.length) chats = chats.map((c) => (c.id === chat.id ? { ...c, memberIds: [...add, ...c.memberIds] } : c));
  try {
    localStorage.setItem(SEATED_KEY, JSON.stringify([...seated, chat.id]));
  } catch {
    /* storage unavailable: seating again adds nobody twice */
  }
  changed();
  return getChat(chat.id)!;
}

export function createChat(projectId: string, name: string, memberIds: string[]): GroupChat {
  const chat: GroupChat = {
    id: `${projectId}:chat-${crypto.randomUUID()}`,
    projectId,
    name: name.trim() || "New chat",
    isDefault: false,
    memberIds: [...memberIds],
    conversations: [],
  };
  chats = [...chats, chat];
  changed();
  return chat;
}

export function addMember(chatId: string, monoId: string): void {
  chats = chats.map((c) => (c.id === chatId && !c.memberIds.includes(monoId) ? { ...c, memberIds: [...c.memberIds, monoId] } : c));
  changed();
}

export function removeMember(chatId: string, monoId: string): void {
  chats = chats.map((c) => (c.id === chatId ? { ...c, memberIds: c.memberIds.filter((id) => id !== monoId) } : c));
  changed();
}

export function sendMessage(chatId: string, text: string, convId?: string): void {
  chats = chats.map((c) => {
    if (c.id !== chatId) return c;
    const msg: ChatMessage = { id: crypto.randomUUID(), from: "ash", text };
    const target = convId ? c.conversations.find((x) => x.id === convId) : undefined;
    if (target)
      return {
        ...c,
        conversations: c.conversations.map((x) =>
          x.id === target.id
            ? { ...x, title: x.messages.length || x.named ? x.title : autoTitle(text), messages: [...x.messages, msg] }
            : x,
        ),
      };
    const [first, ...rest] = c.conversations;
    if (first && first.when === "Today") return { ...c, conversations: [{ ...first, messages: [...first.messages, msg] }, ...rest] };
    return { ...c, conversations: [{ id: msg.id, when: "Today", title: autoTitle(text), messages: [msg] }, ...c.conversations] };
  });
  changed();
}

export function renameChat(chatId: string, name: string): void {
  const next = name.trim();
  if (!next) return;
  chats = chats.map((c) => (c.id === chatId ? { ...c, name: next } : c));
  changed();
}

/** A conversation names itself from its first message: the first line, cut at a word near 40 characters. */
export function autoTitle(text: string): string {
  const line = text.trim().split("\n")[0];
  if (line.length <= 40) return line;
  const cut = line.slice(0, 40);
  const space = cut.lastIndexOf(" ");
  return `${space > 20 ? cut.slice(0, space) : cut}…`;
}

/** Ash renames a conversation (double-click its name). Empty keeps the old name. */
export function renameConversation(chatId: string, convId: string, title: string): void {
  const next = title.trim();
  if (!next) return;
  chats = chats.map((c) =>
    c.id === chatId ? { ...c, conversations: c.conversations.map((x) => (x.id === convId ? { ...x, title: next, named: true } : x)) } : c,
  );
  changed();
}

/**
 * The New conversation screen sends its first message: only now is a conversation made, named from that message.
 * Returns its id.
 */
let convSeq = 0;
export function startConversation(chatId: string, text: string): string {
  const id = `conv-${Date.now().toString(36)}-${++convSeq}`;
  const msg: ChatMessage = { id: `${id}-1`, from: "ash", text };
  chats = chats.map((c) =>
    c.id === chatId ? { ...c, conversations: [{ id, when: "Today", title: autoTitle(text), messages: [msg] }, ...c.conversations] } : c,
  );
  changed();
  return id;
}

/** Start a fresh conversation at the top of the list; returns its id. */
export function newConversation(chatId: string): string {
  const id = `conv-${Date.now().toString(36)}`;
  chats = chats.map((c) =>
    c.id === chatId ? { ...c, conversations: [{ id, when: "Today", title: "New conversation", messages: [] }, ...c.conversations] } : c,
  );
  changed();
  return id;
}

// ---- Replies: the room takes turns (roomTurns.ts has the rules). One exchange per message, or batch of messages, from
// Ash: a picked answerer, then at most one new reply from each other member, then a Mono another Mono addresses may
// answer once, all under BOT_TURN_CAP turns. One turn is in flight per room; what Ash sends meanwhile waits and is
// answered together in the next exchange. Every turn runs in the Mono's own session (the app's runner).
let typing: Record<string, string | undefined> = {};
export function typingIn(chatId: string): string | undefined {
  return typing[chatId];
}
function setTyping(chatId: string, monoId: string | undefined): void {
  typing = { ...typing, [chatId]: monoId };
  chats = chats.map((c) => c.id === chatId ? { ...c, replyPending: monoId } : c);
  changed();
}

function addReply(chatId: string, from: string, text: string, quiet: boolean, convId?: string, pick?: ChatMessage["pick"]): void {
  chats = chats.map((c) => {
    if (c.id !== chatId) return c;
    const msg: ChatMessage = { id: `${Date.now().toString(36)}${from}${++replySeq}`, from, text, ...(quiet ? { quiet: true } : {}), ...(pick ? { pick } : {}) };
    const target = (convId && c.conversations.find((x) => x.id === convId)) || c.conversations[0];
    if (!target) return c;
    return { ...c, conversations: c.conversations.map((x) => (x.id === target.id ? { ...x, messages: [...x.messages, msg] } : x)) };
  });
  changed();
}
let replySeq = 0;

/** Mock: the picked answerer types, replies; one other member may add a line. */
export function simulateReplies(chatId: string, convId?: string): void {
  if (!examplesOn()) { void requestReply(chatId, convId); return; }
  const chat = getChat(chatId);
  const [answerer, extra] = chat?.memberIds ?? [];
  if (!answerer) return;
  setTyping(chatId, answerer);
  window.setTimeout(() => {
    setTyping(chatId, undefined);
    addReply(chatId, answerer, "Example: on it. I'll put the plan on the board within the hour.", false, convId);
    if (!extra) return;
    window.setTimeout(() => addReply(chatId, extra, "Example: I'll check it against the project's needs when it's done.", true, convId), 1600);
  }, 1800);
}

export type GroupChatRunner = (monoId: string, prompt: string, options?: { maxReplyChars: number }) => Promise<string>;
let runner: GroupChatRunner | undefined;
/** The app supplies its normal Mono session engine; the store never invents an answer. */
export function setGroupChatRunner(next: GroupChatRunner): () => void {
  runner = next;
  return () => { if (runner === next) runner = undefined; };
}
/** The runner's refusal when the Mono's own session is mid-turn: an answer surfaces it, a chime-in just skips. */
export class MonoBusyError extends Error {}

/** The cheap router: one isolated prompt to the smallest model, text back. Without one, the lane rules decide. */
export type RoomRouter = (prompt: string) => Promise<string>;
let router: RoomRouter | undefined;
export function setRoomRouter(next: RoomRouter): () => void {
  router = next;
  return () => { if (router === next) router = undefined; };
}
const ROUTER_TIMEOUT_MS = 20_000;
async function askRouter(prompt: string): Promise<string | undefined> {
  const ask = router;
  if (!ask) return undefined;
  let timer: number | undefined;
  try {
    return await Promise.race([
      ask(prompt),
      new Promise<undefined>((resolve) => { timer = window.setTimeout(() => resolve(undefined), ROUTER_TIMEOUT_MS); }),
    ]);
  } catch {
    return undefined;
  } finally {
    window.clearTimeout(timer);
  }
}

type RoomState = {
  running: boolean;
  /** Conversations Ash sent to while a turn was in flight, answered in order once it ends. */
  pending: string[];
  /** Who the current or last exchange picked, and why (shown with a failure). */
  pick?: Pick;
  routing?: boolean;
  /** The conversation whose exchange hit the turn cap and now waits for Ash. */
  paused?: string;
};
const rooms = new Map<string, RoomState>();
function room(chatId: string): RoomState {
  let r = rooms.get(chatId);
  if (!r) { r = { running: false, pending: [] }; rooms.set(chatId, r); }
  return r;
}
/** "Choosing who answers…" while the router picks. */
export function roomRouting(chatId: string): boolean {
  return !!rooms.get(chatId)?.routing;
}
/** The exchange hit the turn cap in this conversation and is waiting for Ash. */
export function roomPaused(chatId: string, convId?: string): boolean {
  const paused = rooms.get(chatId)?.paused;
  return !!paused && (!convId || paused === convId);
}
/** Who was picked to answer the last message, and why: "Projects Manager, squarely Projects Manager's lane". */
export function roomPick(chatId: string): Pick | undefined {
  return rooms.get(chatId)?.pick;
}

function setReplyProblem(chatId: string, error: string | undefined): void {
  chats = chats.map((c) => c.id === chatId ? { ...c, replyError: error } : c);
}
export function replyProblem(chatId: string, convId?: string): string | undefined {
  const chat = getChat(chatId);
  return convId && chat?.replyConversationId !== convId ? undefined : chat?.replyError;
}
export function retryReply(chatId: string): Promise<void> {
  const chat = getChat(chatId);
  if (!chat?.replyConversationId || !chat.replyMessageId) return Promise.resolve();
  const conv = chat.conversations.find((c) => c.id === chat.replyConversationId);
  const lastUser = conv ? [...conv.messages].reverse().find((m) => m.from === "ash") : undefined;
  if (lastUser?.id !== chat.replyMessageId) {
    setReplyProblem(chatId, "This conversation has newer messages. Open it before sending again.");
    changed(); return Promise.resolve();
  }
  return requestReply(chatId, chat.replyConversationId);
}

/** Ash's messages in a conversation that no exchange has answered yet (oldest first). */
function unanswered(conv: ChatConversation): ChatMessage[] {
  if (conv.answeredThrough !== undefined) {
    const at = conv.messages.findIndex((m) => m.id === conv.answeredThrough);
    if (at >= 0) return conv.messages.slice(at + 1).filter((m) => m.from === "ash");
  }
  // No marker (older data): the run of Ash's messages since the last reply.
  const out: ChatMessage[] = [];
  for (let i = conv.messages.length - 1; i >= 0 && conv.messages[i].from === "ash"; i--) out.unshift(conv.messages[i]);
  return out;
}
function setAnswered(chatId: string, convId: string, through: string | undefined, replyMessageId?: string): void {
  chats = chats.map((c) => c.id !== chatId ? c : {
    ...c,
    ...(replyMessageId ? { replyConversationId: convId, replyMessageId } : {}),
    conversations: c.conversations.map((x) => {
      if (x.id !== convId) return x;
      const { answeredThrough: _, ...rest } = x;
      return through === undefined ? rest : { ...x, answeredThrough: through };
    }),
  });
  changed();
}

/** The chat's members as the room's seats: their names, and a Lead's project as another name for it. */
function seatsOf(chat: GroupChat): Seat[] {
  const roster = listMonos();
  return chat.memberIds.map((id) => {
    // A member no longer on the roster keeps its seat; the runner says so if it is picked.
    const mono = roster.find((m) => m.id === id);
    const name = mono?.name?.trim() || id;
    const lead = leadFor(id);
    return {
      id,
      name,
      ...(mono?.engine ? { engine: mono.engine } : {}),
      ...(lead ? { aliases: [lead.projectName, `${lead.projectName} lead`], card: `${name}: runs ${lead.projectName}'s work and its workers; answers about ${lead.projectName} itself. Not: other projects.` } : {}),
    };
  });
}

/**
 * Ask the room to answer Ash's latest message(s) in a conversation. While a turn is in flight in this room, the
 * conversation waits its turn and this returns at once; the running exchange stops at its next turn boundary and the
 * waiting messages are answered together.
 */
export function requestReply(chatId: string, convId?: string): Promise<void> {
  const chat = getChat(chatId);
  const conv = chat?.conversations.find((c) => c.id === convId) ?? chat?.conversations[0];
  if (!chat || !conv) return Promise.resolve();
  const r = room(chatId);
  if (r.running) {
    if (!r.pending.includes(conv.id)) r.pending.push(conv.id);
    return Promise.resolve();
  }
  return runRoom(chatId, conv.id, r);
}

async function runRoom(chatId: string, convId: string, r: RoomState): Promise<void> {
  r.running = true;
  r.pending = [convId];
  try {
    while (r.pending.length) await runExchange(chatId, r.pending.shift()!, r);
  } finally {
    r.running = false;
    r.routing = false;
  }
}

type Turn = { seat: string; kind: TurnKind; why: string; by?: Pick["by"]; other?: string };

async function runExchange(chatId: string, convId: string, r: RoomState): Promise<void> {
  const chat = getChat(chatId);
  const conv = chat?.conversations.find((c) => c.id === convId);
  if (!chat || !conv) return;
  const batch = unanswered(conv);
  const last = batch[batch.length - 1];
  if (!last) return;
  const before = conv.answeredThrough;
  setAnswered(chatId, convId, last.id, last.id);
  r.paused = undefined;
  setReplyProblem(chatId, undefined);
  const seats = seatsOf(chat);
  const nameOf = (id: string) => seats.find((s) => s.id === id)?.name ?? id;
  const fail = (error: string) => { setReplyProblem(chatId, error); setAnswered(chatId, convId, before); };
  if (!seats.length || !runner) {
    fail(!seats.length ? "Add a Mono to this chat before sending." : "The Mono session engine isn't connected. Open this chat in the desktop app.");
    return;
  }
  const transcript = () => roomTranscript(getChat(chatId)?.conversations.find((c) => c.id === convId)?.messages ?? [], nameOf);

  // Round 1: who answers.
  let pick = ruledPick(batch.map((m) => m.text), seats);
  if (!pick && router) {
    r.routing = true; changed();
    for (let attempt = 0; attempt < 2 && !pick; attempt++) {
      const out = await askRouter(pickPrompt(seats, transcript()) + (attempt ? "\nName exactly one member id from the list." : ""));
      if (out === undefined) break;
      pick = parsePick(out, seats);
    }
    r.routing = false;
  }
  pick ??= lanePick(batch.map((m) => m.text).join("\n"), seats)!;
  r.pick = pick;

  const queue: Turn[] = [{ seat: pick.id, kind: "answer", why: pick.why, by: pick.by }];
  const replied = new Set<string>();
  const extra = new Set<string>();
  let turns = 0;
  while (queue.length) {
    // Ash spoke again: stop here; his new messages open the next exchange.
    if (r.pending.some((id) => { const c = getChat(chatId)?.conversations.find((x) => x.id === id); return !!c && unanswered(c).length > 0; })) return;
    if (turns >= BOT_TURN_CAP) { r.paused = convId; changed(); return; }
    const turn = queue.shift()!;
    const me = seats.find((s) => s.id === turn.seat);
    if (!me) continue;
    setTyping(chatId, turn.seat);
    let reply: string;
    try {
      reply = await runner(turn.seat, turnPrompt({ chatName: chat.name, projectId: chat.projectId, me, seats, kind: turn.kind, batch: batch.length, other: turn.other, transcript: transcript() }));
    } catch (error) {
      setTyping(chatId, undefined);
      // A chime-in or reply that couldn't run (busy, failed) is dropped quietly; the answer's failure is shown.
      if (turn.kind === "answer") { fail(error instanceof Error ? plainFailure(me.name, error.message, me.engine) : `${me.name} couldn't reply. Your message is saved.`); return; }
      continue;
    }
    setTyping(chatId, undefined);
    turns++;
    if (turn.kind === "answer" && !reply.trim()) { fail("The Mono finished without a text reply. Open its conversation to inspect the result."); return; }
    if (isSilent(reply)) continue;
    addReply(chatId, turn.seat, reply, turn.kind !== "answer", convId, { by: turn.by ?? (turn.kind === "chime" ? "chime" : "addressed"), why: turn.why });
    // Round 3: a Mono this reply addresses may answer once, next.
    const named = addressedIn(reply, seats, turn.seat).filter((id) => !replied.has(id));
    named.forEach((id) => replied.add(id));
    // Its answer to being addressed takes the place of a chime-in still waiting, so it doesn't speak twice in a row.
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].kind === "chime" && named.includes(queue[i].seat)) queue.splice(i, 1);
    queue.unshift(...named.map((id): Turn => ({ seat: id, kind: "reply", why: `${me.name} addressed ${nameOf(id)}`, other: me.name })));
    // Round 2: after the answer, who else may have something new (each at most once).
    if (turn.kind === "answer") {
      const ashText = batch.map((m) => m.text).join("\n");
      let chimes: Chime[] | undefined;
      if (router && seats.length > 1) {
        const out = await askRouter(chimePrompt(seats, me, transcript()));
        chimes = out === undefined ? undefined : parseChimes(out, seats, me.id);
      }
      chimes ??= laneChimes(ashText, seats, me.id);
      for (const c of chimes)
        if (!replied.has(c.id) && !extra.has(c.id)) { extra.add(c.id); queue.push({ seat: c.id, kind: "chime", why: c.why, other: me.name }); }
    }
  }
}

/** Restore exported chats without duplicating an existing conversation. */
export function importChats(imported: GroupChat[]): void {
  const present = new Set(chats.map((c) => c.id));
  const additions = validGroupChats(imported).filter((c) => {
    if (present.has(c.id)) return false;
    present.add(c.id); return true;
  }).map((c) => ({ ...c, replyPending: undefined }));
  chats = [...chats, ...additions];
  changed();
}
export function exportChats(): GroupChat[] { return structuredClone(chats); }

export function monoTaskRunnerConnected(): boolean { return !!runner; }
export function runMonoTask(monoId: string, prompt: string, options?: { maxReplyChars: number }): Promise<string> {
  if (!runner) return Promise.reject(new Error("Open the desktop app to run a Mono."));
  return runner(monoId, prompt, options);
}
