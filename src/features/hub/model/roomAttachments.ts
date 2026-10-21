// What Ash attaches in a room (GroupChatView's composer): every file is kept by its path, so the message still has it
// after a restart and each Mono's turn can send it the way its own chat would (roomConductor turnAttachments, the app's
// room runner). A picture pasted from the clipboard has no file yet: it is written to one first (the same
// `write_attachment` the session composer uses). Nothing is dropped quietly: a file that can't be kept says so.
import { invoke } from "@tauri-apps/api/core";
import type { Attachment } from "../../sessions/model/session";
import type { RoomAttachment } from "./types";

export async function roomAttachments(files: readonly Attachment[]): Promise<RoomAttachment[]> {
  const out: RoomAttachment[] = [];
  for (const file of files) {
    let path = file.path?.trim();
    if (!path && file.data) {
      path = await invoke<string>("write_attachment", { name: file.name, data: file.data }).catch((error: unknown) => {
        throw new Error(`Couldn't keep ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (!path) throw new Error(`Couldn't keep ${file.name}: it has no file on this Mac. Attach it again.`);
    out.push({ id: file.id, name: file.name, mimeType: file.mimeType, kind: file.kind, size: file.size, path });
  }
  return out;
}
