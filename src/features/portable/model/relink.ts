// A chat that came in with no folder keeps what its file named as an inert note (docs/PORTABLE.md). Once that folder
// exists here and passes the same checks as an import (Rust decides), the chat's banner offers it back.
import { invoke } from "@tauri-apps/api/core";
import { railFolders } from "./railFolders";

/** The folder to offer for this chat, or null. Nothing runs from the note; choosing it is the person's click. */
export async function relinkCandidate(sessionId: string): Promise<string | null> {
  const folder = await invoke<string | null>("portable_relink_candidate", { sessionId, knownFolders: railFolders() });
  return folder || null;
}
