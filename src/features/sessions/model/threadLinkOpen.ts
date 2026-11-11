// WP-125: open a local chat or prompt link inside this app. A link that is not
// on this computer is a message. Nothing here builds a web viewer.

import { sameProjectPath } from "../../projects/model/recents";
import { getComposerDraft, setComposerDraft } from "./draftCache";
import { newSessionForProject, type Session } from "./session";
import {
  parseThreadLink,
  THREAD_LINK_MESSAGE,
  type LocalThreadLink,
  type ThreadLinkRejection,
} from "./threadLinks";

/** How long a chat or project lookup may take before we ask for another try. */
export const THREAD_LINK_LOOKUP_MS = 8_000;

export const COMPOSER_PREFILL_EVENT = "hivra:prefill-composer";

export type ThreadOpenFailure =
  | ThreadLinkRejection
  | "missing-chat"
  | "missing-project"
  | "unavailable"
  | "stale";

export type ThreadOpenResult =
  | { ok: true; link: LocalThreadLink; ticket: number }
  | { ok: false; reason: ThreadOpenFailure; message: string };

export type ThreadLookup = {
  hasChat: (sessionId: string) => boolean | Promise<boolean>;
  hasProject: (projectId: string) => boolean | Promise<boolean>;
};

export type ThreadLinkHands = ThreadLookup & {
  /** False when no pane was shown. Void is treated as shown, for older callers. */
  openChat: (sessionId: string) => boolean | Promise<boolean> | void;
  openPrompt: (projectId: string, text: string, ticket: number) => void;
};

export type ThreadPromptProject = { id: string; folder: string | null };

export type ThreadPromptSession = {
  id: string;
  cwd: string;
  blocks: readonly unknown[];
  busy?: boolean;
};

export type ThreadPromptWorld = {
  projects: () => readonly ThreadPromptProject[];
  sessions: () => readonly ThreadPromptSession[];
};

export type ThreadPromptHands = {
  openProject: (projectId: string) => void;
  addSession: (session: Session) => void;
  focusSession: (sessionId: string) => void;
};

type LookupAnswer = "yes" | "no" | "later";

type NoticeState = { id: number; message: string } | null;

let ticket = 0;
let noticeSerial = 0;
let notice: NoticeState = null;
const listeners = new Set<() => void>();

function emitNotice(): void {
  for (const listener of listeners) listener();
}

/** Drop in-flight opens. The next link gets a new ticket. */
export function beginThreadOpen(): number {
  ticket += 1;
  return ticket;
}

export function isThreadOpenCurrent(value: number): boolean {
  return value > 0 && value === ticket;
}

export function reportThreadLink(message: string): void {
  if (!message) return;
  noticeSerial += 1;
  notice = { id: noticeSerial, message };
  emitNotice();
}

export function dismissThreadLink(): void {
  if (!notice) return;
  notice = null;
  emitNotice();
}

export function threadLinkNotice(): NoticeState {
  return notice;
}

export function subscribeThreadLinkNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetThreadLinkStateForTests(): void {
  ticket = 0;
  noticeSerial = 0;
  if (notice) {
    notice = null;
    emitNotice();
  }
}

/** Rust's validate_id: "Invalid session id", and the same shape for other labels. */
function invalidIdError(error: unknown): boolean {
  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  return /^Invalid [\w ]+ id$/.test(text.trim());
}

/**
 * One lookup. A throw, a rejection, or a timeout is "later": the chat may
 * still be there, so it is not reported as missing. An invalid id can never
 * resolve, so that error is "no" (not on this computer), not a retry.
 */
function ask(run: () => boolean | Promise<boolean>): Promise<LookupAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  return new Promise((resolve) => {
    const finish = (value: LookupAnswer) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish("later"), THREAD_LINK_LOOKUP_MS);
    Promise.resolve()
      .then(run)
      .then(
        (value) => finish(value === true ? "yes" : "no"),
        (error: unknown) => finish(invalidIdError(error) ? "no" : "later"),
      );
  });
}

function missing(kind: LocalThreadLink["kind"]): ThreadOpenResult {
  return kind === "chat"
    ? { ok: false, reason: "missing-chat", message: THREAD_LINK_MESSAGE.missingChat }
    : { ok: false, reason: "missing-project", message: THREAD_LINK_MESSAGE.missingProject };
}

/**
 * Parse a link and check it twice. A newer link invalidates this one. The
 * later check wins when the two disagree, because the chat can appear or
 * disappear while the first check is in flight.
 */
export async function resolveThreadLink(
  raw: string,
  lookup: ThreadLookup,
): Promise<ThreadOpenResult> {
  const mine = beginThreadOpen();
  const parsed = parseThreadLink(raw);
  if (!parsed.ok) return parsed;
  const check = () =>
    parsed.link.kind === "chat"
      ? lookup.hasChat(parsed.link.sessionId)
      : lookup.hasProject(parsed.link.projectId);
  const first = await ask(check);
  if (!isThreadOpenCurrent(mine)) return { ok: false, reason: "stale", message: "" };
  if (first === "later") {
    return { ok: false, reason: "unavailable", message: THREAD_LINK_MESSAGE.unavailable };
  }
  const second = await ask(check);
  if (!isThreadOpenCurrent(mine)) return { ok: false, reason: "stale", message: "" };
  if (second === "later") {
    return { ok: false, reason: "unavailable", message: THREAD_LINK_MESSAGE.unavailable };
  }
  if (second === "no") return missing(parsed.link.kind);
  return { ok: true, link: parsed.link, ticket: mine };
}

/** Open a link, or say why it cannot be opened. A stale result is silent. */
export async function acceptThreadLink(raw: string, hands: ThreadLinkHands): Promise<void> {
  const result = await resolveThreadLink(raw, hands);
  if (!result.ok) {
    if (result.reason !== "stale" && result.message) reportThreadLink(result.message);
    return;
  }
  if (!isThreadOpenCurrent(result.ticket)) return;
  const link = result.link;
  if (link.kind === "chat") {
    const sessionId = link.sessionId;
    const still = await ask(() => hands.hasChat(sessionId));
    if (!isThreadOpenCurrent(result.ticket)) return;
    if (still !== "yes") {
      reportThreadLink(
        still === "later" ? THREAD_LINK_MESSAGE.unavailable : THREAD_LINK_MESSAGE.missingChat,
      );
      return;
    }
    if (!isThreadOpenCurrent(result.ticket)) return;
    const shown = await Promise.resolve(hands.openChat(sessionId));
    if (!isThreadOpenCurrent(result.ticket)) return;
    if (shown === false) reportThreadLink(THREAD_LINK_MESSAGE.missingChat);
    return;
  }
  if (!isThreadOpenCurrent(result.ticket)) return;
  hands.openPrompt(link.projectId, link.text, result.ticket);
}

export function readComposerPrefill(detail: unknown, sessionId: string): string | null {
  if (!detail || typeof detail !== "object") return null;
  const record = detail as { sessionId?: unknown; text?: unknown; ticket?: unknown };
  if (record.sessionId !== sessionId || typeof record.text !== "string") return null;
  if (typeof record.ticket === "number" && !isThreadOpenCurrent(record.ticket)) return null;
  return record.text;
}

/** Put the prompt in the draft cache, then tell a composer that is already open. */
export function requestComposerPrefill(sessionId: string, text: string, mine: number): boolean {
  if (!isThreadOpenCurrent(mine)) return false;
  setComposerDraft(sessionId, text);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(
      new CustomEvent(COMPOSER_PREFILL_EVENT, {
        detail: { sessionId, text, ticket: mine },
      }),
    );
  }
  return isThreadOpenCurrent(mine);
}

function projectNow(
  world: ThreadPromptWorld,
  projectId: string,
): ThreadPromptProject | undefined {
  return world.projects().find((project) => project.id === projectId);
}

function folderOf(project: ThreadPromptProject | undefined): string | null {
  if (!project || project.folder == null || project.folder === "") return null;
  return project.folder;
}

function isBlankProjectChat(session: ThreadPromptSession, folder: string): boolean {
  if (typeof session.cwd !== "string" || session.busy) return false;
  if (!Array.isArray(session.blocks) || session.blocks.length !== 0) return false;
  // An unsent draft is not blank. A prompt link must not replace it.
  const draft = getComposerDraft(session.id);
  if (draft) return false;
  return sameProjectPath(session.cwd, folder);
}

/**
 * Open the project and put the prompt in a blank chat there, or in a new one.
 * A ticket that is no longer current writes nothing.
 */
export function placePrompt(
  projectId: string,
  text: string,
  mine: number,
  world: ThreadPromptWorld,
  hands: ThreadPromptHands,
): void {
  if (!isThreadOpenCurrent(mine)) return;
  const project = projectNow(world, projectId);
  if (!project) {
    reportThreadLink(THREAD_LINK_MESSAGE.missingProject);
    return;
  }
  if (!folderOf(project)) {
    reportThreadLink(THREAD_LINK_MESSAGE.noFolder);
    return;
  }
  hands.openProject(projectId);
  if (!isThreadOpenCurrent(mine)) return;
  const still = projectNow(world, projectId);
  const folder = folderOf(still);
  if (!folder) {
    reportThreadLink(still ? THREAD_LINK_MESSAGE.noFolder : THREAD_LINK_MESSAGE.missingProject);
    return;
  }
  const sessions = world.sessions();
  const blank = sessions.find((session) => isBlankProjectChat(session, folder));
  if (blank) {
    if (!requestComposerPrefill(blank.id, text, mine)) return;
    if (!isThreadOpenCurrent(mine)) return;
    hands.focusSession(blank.id);
    return;
  }
  // The project's own provider, not whichever chat happens to be open.
  const session = {
    ...newSessionForProject(undefined, folder),
    composerSeed: text,
  };
  if (!isThreadOpenCurrent(mine)) return;
  if (!requestComposerPrefill(session.id, text, mine)) return;
  if (!isThreadOpenCurrent(mine)) return;
  hands.addSession(session);
  hands.focusSession(session.id);
}

/** Append a prompt chat unless that id is already in the list. */
export function rememberPromptSession<T extends { id: string }>(
  prev: readonly T[],
  session: T,
): T[] | null {
  if (prev.some((item) => item.id === session.id)) return null;
  return [...prev, session];
}
