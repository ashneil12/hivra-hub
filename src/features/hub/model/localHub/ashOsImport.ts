// The one-time import from Ash OS (WP-04). On the first start after the bridge was retired, the app asks Rust once
// whether an Ash OS still answers (src-tauri/src/ash_os_import.rs; reads only, never writes back). If it does and holds
// projects or kept Pages, Ash is asked once: Import adds them to the local store, Start clean keeps it empty. If it
// doesn't answer, the app starts clean and never asks again. A dev copy imports only from a stand-in, never the live one.
import { invoke } from "@tauri-apps/api/core";
import type { LocalHub } from "./localHub";

/** The key the decision is kept under, beside the record (local_hub.rs). */
export const IMPORT_KEY = "ash-os-import";

export type ImportFound = { reachable: boolean; message?: string; projects: unknown[]; memberships: unknown[]; pages: unknown[] };
export type ImportDecision = {
  decided: "imported" | "declined" | "none";
  at: string;
  added?: { projects: number; memberships: number; pages: number };
  message?: string;
};

export type ImportDeps = {
  /** What a reachable Ash OS holds (`ash_os_import_fetch`). */
  fetch: () => Promise<ImportFound>;
  /** Ask Ash once; true means Import. */
  ask: (question: string) => Promise<boolean>;
  now?: () => Date;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The question, in plain words. */
export function importQuestion(found: ImportFound): string {
  const kept = found.pages.filter((p) => (p as { state?: unknown })?.state === "kept").length;
  const parts = [plural(found.projects.length, "project"), ...(kept ? [plural(kept, "kept Page")] : [])];
  return `Hivra no longer uses Ash OS. Bring your ${parts.join(" and ")} over from it? This happens once; Ash OS isn't changed.`;
}

/**
 * Run the import once. Returns the decision kept (or the one already kept). Safe to call on every start: once a
 * decision is kept it never asks or reads Ash OS again.
 */
export async function runAshOsImport(hub: LocalHub, deps: ImportDeps): Promise<ImportDecision> {
  const kept = (await hub.disk.read(IMPORT_KEY)) as ImportDecision | null;
  if (kept && typeof kept === "object" && kept.decided) return kept;
  const at = (deps.now?.() ?? new Date()).toISOString();
  const keep = async (decision: ImportDecision) => {
    await hub.disk.write(IMPORT_KEY, decision);
    return decision;
  };
  let found: ImportFound;
  try {
    found = await deps.fetch();
  } catch (error) {
    return keep({ decided: "none", at, message: error instanceof Error ? error.message : String(error) });
  }
  if (!found.reachable || (!found.projects.length && !found.pages.length)) {
    return keep({ decided: "none", at, ...(found.message ? { message: found.message } : {}) });
  }
  if (!(await deps.ask(importQuestion(found)))) return keep({ decided: "declined", at });
  const added = await hub.importFrom(found);
  return keep({ decided: "imported", at, added });
}

let started = false;

/** The app's run: Rust reads Ash OS, a native dialog asks. Once per launch; once ever, by its kept decision. */
export function startAshOsImport(hub: LocalHub): void {
  if (started || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  started = true;
  void runAshOsImport(hub, {
    fetch: () => invoke<ImportFound>("plugin:hub|ash_os_import_fetch"),
    ask: async (question) => {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      return ask(question, { title: "Bring over from Ash OS", kind: "info", okLabel: "Import", cancelLabel: "Start clean" });
    },
  }).catch(() => undefined);
}
