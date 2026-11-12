// Opening a Mono's chat with something already typed for Ash (not sent): Bot changes' "Ask Alfred" on a skipped soul.
// The text joins whatever Ash had typed there, once (a second click doesn't type it twice). A Mono with no chat yet
// gets it when its chat is made (saveMonoSessionId).
import { getComposerDraft, setComposerDraft } from "../../sessions/model/draftCache";
import { appendComposerInsert } from "../../sessions/model/quoteDraft";
import { openMonoChat } from "../../hub/model/hubNav";
import { findMono } from "./mono";

/** An open chat pane listens for this ({ sessionId, text }) to add the text to the composer it already shows. */
export const MONO_PREFILL_EVENT = "monocode:mono-prefill";
export type MonoPrefill = { sessionId: string; text: string };

const pending = new Map<string, string>();

function typeInto(sessionId: string, text: string): void {
  const draft = getComposerDraft(sessionId) ?? "";
  if (draft.includes(text)) return;
  setComposerDraft(sessionId, appendComposerInsert(draft, text));
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent<MonoPrefill>(MONO_PREFILL_EVENT, { detail: { sessionId, text } }));
}

export function openMonoChatWith(monoId: string, text: string): void {
  const sessionId = findMono(monoId)?.sessionId;
  if (sessionId) typeInto(sessionId, text);
  else pending.set(monoId, text);
  // Straight to the chat, out of Settings (where Ask Alfred sits), with the text in its composer, not sent.
  openMonoChat(monoId, { main: true });
}

/** A Mono's chat was just made: what was waiting for it is typed in. */
export function takeMonoPrefill(monoId: string, sessionId: string): void {
  const text = pending.get(monoId);
  if (text == null) return;
  pending.delete(monoId);
  typeInto(sessionId, text);
}
