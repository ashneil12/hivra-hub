// The reviewed memory doc on disk, read and written over the app's compare-and-swap commands. Disk is untrusted:
// parseDoc reads what comes back.

import { invoke } from "@tauri-apps/api/core";
import { parseDoc, type MemoryDoc } from "./doc";

export async function loadMemoryDoc(): Promise<MemoryDoc> {
  const loaded = await invoke<{ revision: number; doc: unknown }>("memory_review_load");
  const doc = parseDoc(loaded.doc);
  doc.revision = typeof loaded.revision === "number" ? loaded.revision : 0;
  return doc;
}

export function saveMemoryDoc(revision: number, doc: MemoryDoc): Promise<boolean> {
  return invoke<boolean>("memory_review_cas", { revision, doc });
}
