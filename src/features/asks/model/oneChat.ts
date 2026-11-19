// One chat (Ash, 13 Nov: "Chief of Staff is just really literally just one main chat ... full port one chat for
// everything"). The Chief of Staff has exactly one chat: no side chats, no "New chat", no chat of its own per project.
// Every way in (the rail, a project's home, Home's box, a link) lands in it. Chats it already had from before stay in
// the data and Search still finds them; nothing here deletes or moves one.
import { pickChief } from "../../home/model/chief";
import { IS_HUB_BUNDLE } from "../../hub/model/hubBundle";
import { listMonos, type Mono } from "../../monos/model/mono";

/** Dropwave only: MonoCode's own build keeps a Mono's chats as they are. */
export const ONE_CHAT = IS_HUB_BUNDLE;

type Roster = readonly Pick<Mono, "id" | "name" | "everyProject" | "sessionId">[];

function roster(): readonly Mono[] {
  try {
    return listMonos();
  } catch {
    return [];
  }
}

/** The first mate whose chat is the one chat: the Chief of Staff, the same one the rail pins. */
export function oneChatMonoId(monos: Roster = roster(), on: boolean = ONE_CHAT): string | undefined {
  return on ? pickChief(monos)?.id : undefined;
}

export function isOneChatMono(monoId: string | null | undefined, monos: Roster = roster(), on: boolean = ONE_CHAT): boolean {
  return !!monoId && oneChatMonoId(monos, on) === monoId;
}

/** The one chat itself (the Chief of Staff's main chat), once it exists. */
export function oneChatId(monos: Roster = roster(), on: boolean = ONE_CHAT): string | undefined {
  return on ? pickChief(monos)?.sessionId || undefined : undefined;
}

export function isOneChat(sessionId: string | null | undefined, monos: Roster = roster(), on: boolean = ONE_CHAT): boolean {
  return !!sessionId && oneChatId(monos, on) === sessionId;
}

/**
 * The side chats the Chief of Staff had before it became one chat. They are kept: a list of them opens beside the one
 * chat, with no way to start another. (A chat it had of its own in a project stays in that project's chat list.)
 */
export function earlierChatIds(monos: readonly Pick<Mono, "id" | "name" | "everyProject" | "sessionId" | "chats">[] = roster(), on: boolean = ONE_CHAT): string[] {
  const chief = on ? pickChief(monos) : undefined;
  if (!chief) return [];
  return [...new Set(chief.chats ?? [])].filter((id) => !!id && id !== chief.sessionId);
}

/**
 * A message that came from a project's own home goes into the one chat with the project named first, so the Chief of
 * Staff (and Ash, reading back) knows what it is about. A message that already names it is left alone.
 */
export function aboutProject(text: string, projectName: string | undefined): string {
  const words = text.trim();
  const name = projectName?.trim();
  if (!name || !words) return words;
  if (words.toLowerCase().startsWith(`about ${name.toLowerCase()}`)) return words;
  return `About ${name}: ${words}`;
}

let catchUpHost: ((chatId: string) => void | Promise<void>) | undefined;

/** The app lends the way a catch-up card gets into the one chat (App.tsx; asks/model/catchUp.ts builds it). */
export function setCatchUpHost(next: (chatId: string) => void | Promise<void>): () => void {
  catchUpHost = next;
  return () => {
    if (catchUpHost === next) catchUpHost = undefined;
  };
}

/** "Catch me up": false when the app has not lent the way yet. */
export function requestCatchUp(chatId: string): boolean {
  if (!catchUpHost || !chatId) return false;
  void Promise.resolve(catchUpHost(chatId)).catch((error) => console.error("Catch me up failed", error));
  return true;
}
