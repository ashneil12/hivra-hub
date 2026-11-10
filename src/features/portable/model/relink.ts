// A chat that came in with no folder keeps what its file named as an inert note (docs/PORTABLE.md). Once that folder
// exists here and passes the same checks as an import (Rust decides: inside the home folder, nothing hidden, inside a
// project or a seated Mono's folder, and not one the import wrote instructions into), the chat's banner offers it
// back, and the sidebar offers every such chat of a project or Mono at once.
import { invoke } from "@tauri-apps/api/core";
import { listMonos } from "../../monos/model/mono";
import { railFolders } from "./railFolders";

export type Relink = { sessionId: string; folder: string; group: string };

const known = () => ({ knownFolders: railFolders(), knownMonos: listMonos().map((m) => m.id) });

/** The folder to offer for this chat, or null. Nothing runs from the note; choosing it is the person's click. */
export async function relinkCandidate(sessionId: string): Promise<string | null> {
  const folder = await invoke<string | null>("portable_relink_candidate", { sessionId, ...known() });
  return folder || null;
}

/** Every chat that can have its folder back now. */
export function relinkCandidates(): Promise<Relink[]> {
  return invoke<Relink[]>("portable_relink_candidates", known());
}

/** Gives these chats their folders (checked again in Rust); the ones it applied come back. */
export function relinkApply(sessionIds: string[]): Promise<Relink[]> {
  return invoke<Relink[]>("portable_relink_apply", { sessionIds, ...known() });
}
