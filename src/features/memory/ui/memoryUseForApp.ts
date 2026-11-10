// WP-100: the app's ports for a use of memory, kept apart from the model so a browser test can drive it.

import { invoke } from "@tauri-apps/api/core";
import { parseDoc, type MemoryDoc } from "../model/doc";
import type { UsePorts } from "../model/memoryUse";

/** The same compare-and-swap commands the Memory screen uses, against the same file. */
export function memoryUsePorts(): UsePorts {
  return {
    load: async () => {
      const loaded = await invoke<{ revision: number; doc: unknown }>("memory_review_load");
      const doc = parseDoc(loaded?.doc);
      doc.revision = typeof loaded?.revision === "number" ? loaded.revision : 0;
      return doc;
    },
    save: (revision, doc: MemoryDoc) => invoke<boolean>("memory_review_cas", { revision, doc }),
  };
}
