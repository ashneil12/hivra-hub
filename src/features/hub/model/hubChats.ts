import { examples } from "./examples";
// Group chats per project, behind the hub data layer. Mock store for now;
// Claude Code swaps in the backend (create chat, add/remove member, send,
// stream replies). Every made-up row is labelled "Example:".
import { useSyncExternalStore } from "react";
import type { ChatMessage, GroupChat } from "./types";

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

const EVENT = "monocode:hub-chats-changed";
let version = 0;
function changed(): void {
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

/** Every project has a Leadership team; a new project starts with nobody in it. */
export function ensureLeadership(projectId: string): GroupChat {
  const id = leadershipChatId(projectId);
  let chat = getChat(id);
  if (!chat) {
    chat = { id, projectId, name: "Leadership team", isDefault: true, memberIds: [], conversations: [] };
    chats = [...chats, chat];
  }
  return chat;
}

export function createChat(projectId: string, name: string, memberIds: string[]): GroupChat {
  const chat: GroupChat = {
    id: `${projectId}:chat-${Date.now().toString(36)}`,
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
    const msg: ChatMessage = { id: Date.now().toString(36), from: "ash", text };
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

// ---- Replies (room protocol): one picked answerer per message from Ash;
// others add at most one useful reply, quietly underneath. Mock timing.
let typing: Record<string, string | undefined> = {};
export function typingIn(chatId: string): string | undefined {
  return typing[chatId];
}
function setTyping(chatId: string, monoId: string | undefined): void {
  typing = { ...typing, [chatId]: monoId };
  changed();
}

function addReply(chatId: string, from: string, text: string, quiet: boolean, convId?: string): void {
  chats = chats.map((c) => {
    if (c.id !== chatId) return c;
    const msg: ChatMessage = { id: `${Date.now().toString(36)}${from}`, from, text, ...(quiet ? { quiet: true } : {}) };
    const target = (convId && c.conversations.find((x) => x.id === convId)) || c.conversations[0];
    if (!target) return c;
    return { ...c, conversations: c.conversations.map((x) => (x.id === target.id ? { ...x, messages: [...x.messages, msg] } : x)) };
  });
  changed();
}

/** Mock: the picked answerer types, replies; one other member may add a line. */
export function simulateReplies(chatId: string, convId?: string): void {
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
