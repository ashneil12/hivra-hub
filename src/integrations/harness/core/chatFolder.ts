// A chat's folder is where its agent, git, checkpoints and terminals run. A chat that came in from an export with a
// folder that isn't a project on this Mac has none ("", see docs/PORTABLE.md): it is told so, in these words, and
// nothing starts for it. The app never reads a blank folder as the home folder, `/` or the folder it runs in (Rust says
// the same in src-tauri/src/chat_folder.rs).

export const CHAT_NEEDS_FOLDER = "Choose a project folder for this chat first.";

/** True when the chat has a folder to work in. `~` is the home folder chosen on purpose, not a missing folder. */
export function hasChatFolder(cwd: string | undefined | null): cwd is string {
  return typeof cwd === "string" && cwd.trim() !== "";
}

/** The folder, or the plain message when the chat has none. */
export function requireChatFolder(cwd: string | undefined | null): string {
  if (!hasChatFolder(cwd)) throw new Error(CHAT_NEEDS_FOLDER);
  return cwd;
}
