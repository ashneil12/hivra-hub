// Tauri side of the docs gateway (WP-72). Imported by the notes screen only, so
// the browser fixture never loads the Tauri API.

import type {
  DocCreateInput,
  DocMentionRecord,
  DocRecord,
  DocUpdateInput,
  DocVersionRecord,
  DocWriteResult,
  DocsGateway,
} from "./gateway";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export function tauriGateway(): DocsGateway {
  return {
    list: () => call<DocRecord[]>("docs_list"),
    get: (id) => call<DocRecord | null>("docs_get", { id }),
    create: (page) => call<DocWriteResult>("docs_create", { page }),
    update: (page) => call<DocWriteResult>("docs_update", { page }),
    adopt: ({ id, blocksJson, body, expectedVersion }) =>
      call<DocWriteResult>("docs_adopt", { id, blocksJson, body, expectedVersion }),
    move: (movePage) => call<DocWriteResult>("docs_move", { movePage }),
    versions: (id) => call<DocVersionRecord[]>("docs_versions", { id }),
    restore: (restore) => call<DocWriteResult>("docs_restore", { restore }),
    favourite: (id, favourite) => call<DocRecord>("docs_favourite", { id, favourite }),
    touch: (id) => call<DocRecord>("docs_touch", { id }),
    trash: (id) => call<void>("docs_trash", { id }),
    resolve: (kind, targetId) =>
      call<DocMentionRecord & { found: boolean }>("docs_resolve", { kind, targetId }),
    export: (request) => call<string[]>("docs_export", { request }),
  };
}

export type { DocCreateInput, DocUpdateInput };
