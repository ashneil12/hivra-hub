// WP-131: the desktop port. Speech stays in the OS process. This module only
// carries text the recogniser already produced, and only inside the app.
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  DICTATION_NOT_HERE,
  DICTATION_STOPPED,
  noteForEngineMessage,
  type DictationChunk,
  type DictationPort,
  type DictationSupport,
} from "./dictation";

export const DICTATION_EVENT = "monocode:dictation";

function inDesktopApp(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

export function noteFromInvoke(error: unknown): string {
  const text = errorText(error).trim();
  // This one is not a failure note. Outside a Mac it is the whole answer.
  if (text === DICTATION_NOT_HERE || text.endsWith(DICTATION_NOT_HERE)) return DICTATION_NOT_HERE;
  return noteForEngineMessage(text);
}

export const tauriDictationPort: DictationPort = {
  async support(): Promise<DictationSupport> {
    if (!inDesktopApp()) return { available: false, reason: DICTATION_NOT_HERE };
    try {
      const value = await invoke<DictationSupport>("dictation_support");
      if (!value || value.available !== true) {
        const reason = value && typeof value.reason === "string" ? value.reason : "";
        return { available: false, reason: reason ? noteFromInvoke(reason) : DICTATION_NOT_HERE };
      }
      return { available: true, reason: "" };
    } catch (error) {
      return { available: false, reason: noteFromInvoke(error) || DICTATION_NOT_HERE };
    }
  },
  async start() {
    if (!inDesktopApp()) throw new Error(DICTATION_NOT_HERE);
    try {
      const session = await invoke<number>("dictation_start");
      if (typeof session !== "number" || !Number.isFinite(session) || session <= 0) {
        throw new Error(DICTATION_STOPPED);
      }
      return session;
    } catch (error) {
      throw new Error(noteFromInvoke(error));
    }
  },
  async stop(session: number) {
    if (!inDesktopApp()) return;
    if (typeof session !== "number" || !Number.isFinite(session)) return;
    await invoke("dictation_stop", { session }).catch(() => {});
  },
  subscribe(onChunk) {
    let unlisten: UnlistenFn | null = null;
    let dead = false;
    if (!inDesktopApp()) return () => {};
    // LOW 1 (round 3): this window's own listener. A global listen() also receives events emitted to other windows,
    // so another window's dictation words would reach this one.
    void getCurrentWebviewWindow().listen<DictationChunk>(DICTATION_EVENT, (event) => {
      const payload = event.payload;
      if (!payload || typeof payload.session !== "number" || typeof payload.text !== "string") return;
      onChunk({
        session: payload.session,
        text: payload.text,
        finished: payload.finished === true,
        error: payload.error === true,
      });
    })
      .then((fn) => {
        if (dead) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      dead = true;
      unlisten?.();
    };
  },
};
