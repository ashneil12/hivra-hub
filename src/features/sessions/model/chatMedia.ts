import { isEqualOrInside, slash } from "../../../shared/lib/paths";
import { REMOTE_PATH_PREFIX } from "../../../shared/lib/remotePaths";

/**
 * Which local images and videos a chat's Markdown may show.
 *
 * A reply, or a chat imported from elsewhere, is untrusted text. A path in it
 * on this computer is never trusted: Rust (`read_chat_image` and
 * `allow_video_stream`) takes the chat's id and works out from the app's own
 * records which folders that chat may show media from (its folder and
 * worktree, its Mono's projects and their worktrees, its workers' folders),
 * follows symlinks and refuses everything else. The window does not say which
 * folders; it only says which chat asks. Files on a connected machine are read
 * through the machine, which keeps reads inside its projects; this holds them
 * to the chat's own project there as well.
 */

/**
 * The path with `.` and `..` resolved, without touching the disk. A machine's
 * `remote://<id>` prefix and a drive letter stay as they are.
 */
export function lexicalPath(path: string): string {
  const slashed = slash(path.trim());
  const remote = slashed.startsWith(REMOTE_PATH_PREFIX)
    ? (/^remote:\/\/[^/]*/.exec(slashed)?.[0] ?? "")
    : "";
  const rest = slashed.slice(remote.length);
  const drive = /^[A-Za-z]:(?=\/|$)/.exec(rest)?.[0] ?? "";
  const parts: string[] = [];
  for (const part of rest.slice(drive.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${remote}${drive}/${parts.join("/")}`;
}

/**
 * Whether the window may ask for a media path at all. A path on this computer
 * needs the saved chat that asks, since Rust holds it to that chat's folders;
 * with none (a chat on a connected machine) it stays a link. A path on a
 * connected machine must lie inside the chat's own project there.
 */
export function mayShowChatMedia(
  path: string,
  cwd: string | undefined,
  sessionId: string | undefined,
): boolean {
  const target = lexicalPath(path);
  if (!target.startsWith(REMOTE_PATH_PREFIX)) return !!sessionId;
  const root = cwd ? lexicalPath(cwd) : "";
  return (
    root.startsWith(REMOTE_PATH_PREFIX) &&
    root !== target &&
    isEqualOrInside(target, root)
  );
}
