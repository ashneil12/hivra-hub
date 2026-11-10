// WP-111: the ids of private chats, from the open window and from the database.
// A failure here is not a final answer. The caller tries again and reads nothing meanwhile.

import { invoke } from "@tauri-apps/api/core";
import { livePrivateKeys, privateChatKeys } from "../../memory/model/privateChat";

export async function loadPrivateChatKeys(): Promise<Set<string>> {
  const keys = new Set(livePrivateKeys());
  let rows: unknown;
  try {
    rows = await invoke("session_private_keys");
  } catch {
    throw new Error("Couldn't check which chats are private. Nothing was read. You can try again.");
  }
  if (!Array.isArray(rows)) return keys;
  const stored = privateChatKeys(
    rows.map((row) => {
      const item = row && typeof row === "object" ? (row as { id?: unknown; providerSessionId?: unknown }) : {};
      return {
        id: typeof item.id === "string" ? item.id : "",
        providerSessionId: typeof item.providerSessionId === "string" ? item.providerSessionId : undefined,
        private: true,
      };
    }),
  );
  for (const key of stored) keys.add(key);
  return keys;
}
