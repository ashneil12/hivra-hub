// Home's box sends a turn to the Chief of Staff's own chat. The app lends the session.
// A later ask wins. Home never files a task from here.

import type { UserQuestionReply } from "../../sessions/model/userQuestion";
import type { ExchangeBlock } from "./exchange";

export type HomeChiefSession = {
  id: string;
  busy?: boolean;
  blocks: readonly ExchangeBlock[];
  pendingQuestion?: {
    requestId: number;
    questions: { id: string; prompt: string; options: { id: string; label: string }[] }[];
  };
};

export type HomeChiefHost = {
  ensure: (monoId: string) => Promise<{ id: string } | undefined>;
  submit: (sessionId: string, text: string) => boolean | Promise<boolean>;
  answer: (sessionId: string, requestId: number, reply: UserQuestionReply) => void;
  read: (sessionId: string) => HomeChiefSession | undefined;
};

let host: HomeChiefHost | undefined;
let token = 0;
let version = 0;
const listeners = new Set<() => void>();

export function setHomeChiefHost(next: HomeChiefHost | undefined): () => void {
  host = next;
  return () => {
    if (host === next) host = undefined;
  };
}

export function notifyHomeChief(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeHomeChief(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function homeChiefVersion(): number {
  return version;
}

export function readHomeChiefSession(sessionId: string): HomeChiefSession | undefined {
  if (!host || !sessionId) return undefined;
  return host.read(sessionId);
}

/** Load the Mono's chat without sending. A missing host is not a final failure. */
export async function ensureHomeChief(monoId: string): Promise<string | undefined> {
  if (!host || !monoId.trim()) return undefined;
  try {
    const session = await host.ensure(monoId);
    return session?.id || undefined;
  } catch {
    return undefined;
  }
}

export async function sendHomeTurn(monoId: string, text: string): Promise<{ ok: true; sessionId: string } | { ok: false }> {
  const words = text.trim();
  const current = host;
  if (!words || !monoId.trim() || !current) return { ok: false };
  const mine = ++token;
  let session: { id: string } | undefined;
  try {
    session = await current.ensure(monoId);
  } catch {
    return { ok: false };
  }
  if (!session?.id || mine !== token) return { ok: false };
  let accepted = false;
  try {
    accepted = await current.submit(session.id, words);
  } catch {
    return { ok: false };
  }
  if (!accepted || mine !== token) return { ok: false };
  return { ok: true, sessionId: session.id };
}

export function answerHomeQuestion(sessionId: string, requestId: number, reply: UserQuestionReply): void {
  host?.answer(sessionId, requestId, reply);
}
