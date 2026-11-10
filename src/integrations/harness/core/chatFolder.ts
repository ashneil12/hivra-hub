// A chat's folder is where its agent, git, checkpoints and terminals run. A chat that came in from an export with a
// folder that isn't a project on this Mac has none ("", see docs/PORTABLE.md): it is told so, in these words, and
// nothing starts for it. The app never reads a blank folder as the home folder, `/` or the folder it runs in (Rust says
// the same in src-tauri/src/chat_folder.rs).

export const CHAT_NEEDS_FOLDER = "Choose a project folder for this chat first.";

/** Sent after an import brought chats in with no folder, so the sidebar's "Needs a folder" group reads its list again. */
export const FOLDERLESS_CHANGED = "monocode:folderless-chats-changed";

/** True when the chat has a folder to work in. `~` is the home folder chosen on purpose, not a missing folder. */
export function hasChatFolder(cwd: string | undefined | null): cwd is string {
  return typeof cwd === "string" && cwd.trim() !== "";
}

/** The folder, or the plain message when the chat has none. */
export function requireChatFolder(cwd: string | undefined | null): string {
  if (!hasChatFolder(cwd)) throw new Error(CHAT_NEEDS_FOLDER);
  return cwd;
}

/**
 * Relink all gave a chat its folder in the store: the open copy takes the folder and nothing else. No move to another
 * project, nothing added to the recents, no other chat touched, and a chat that already has a folder keeps it.
 */
export function withRelinkedFolder<T extends { id: string; cwd: string }>(sessions: readonly T[], sessionId: string, cwd: string): T[] {
  return sessions.map((session) => (session.id === sessionId && !hasChatFolder(session.cwd) ? { ...session, cwd } : session));
}
