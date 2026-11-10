import { isEqualOrInside, knownHomeDir, pathKey, slash } from "../../../shared/lib/paths";
import { REMOTE_PATH_PREFIX } from "../../../shared/lib/remotePaths";

/**
 * Which local images and videos a chat's Markdown may show.
 *
 * A reply, or a chat imported from elsewhere, is untrusted text. A path in it
 * is shown only when it lies inside the chat's own folder (its project, or its
 * worktree) or in the app's generated-images folder; any other path stays the
 * link it is. The check that counts is in Rust (`read_chat_image` and
 * `allow_video_stream` take the chat's folders and decide there, following
 * symlinks). This is the same rule applied to the path as written, so the
 * common case never asks Rust at all.
 */

/** Where the app keeps the images a model generated, under its data folder. */
const GENERATED_IMAGES_FOLDER = "generated-images";

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
 * The folders of the chat a path must lie inside: its own, if it has one. A
 * chat with no folder, or one that is the home or the whole disk, has none, as
 * in Rust, which would hold every file there to be the chat's own.
 */
export function chatMediaRoots(cwd: string | undefined): string[] {
  const root = cwd?.trim();
  if (!root || root === "~") return [];
  const folder = lexicalPath(root);
  const home = knownHomeDir();
  const tooBroad =
    /^(?:remote:\/\/[^/]*)?(?:[A-Za-z]:)?\/$/.test(folder) ||
    (home !== undefined && pathKey(lexicalPath(home)) === pathKey(folder));
  return tooBroad ? [] : [root];
}

/**
 * Whether a local image or video path may be loaded for this chat: inside the
 * chat's folder, or directly in a folder named `generated-images`. The second
 * can only be told by name here, since the app's data folder is Rust's to
 * know, so Rust still has the last word on it.
 */
export function mayShowChatMedia(path: string, cwd: string | undefined): boolean {
  const target = lexicalPath(path);
  if (!target.startsWith(REMOTE_PATH_PREFIX)) {
    const parent = target.slice(0, target.lastIndexOf("/")).split("/").pop();
    if (parent === GENERATED_IMAGES_FOLDER) return true;
  }
  return chatMediaRoots(cwd).some((root) => {
    const folder = lexicalPath(root);
    return folder !== target && isEqualOrInside(target, folder);
  });
}
