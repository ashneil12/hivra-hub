// The one-time import from Ash OS (WP-04). On a start after the bridge was retired, the app asks Rust whether an Ash OS
// still answers (src-tauri/src/ash_os_import.rs; reads only, never writes back). If it does and holds projects or kept
// Pages, Ash is asked once: Import adds them to the local store, Start clean keeps it empty. Either answer is final.
//
// Only a sure answer is kept. No Ash OS on this Mac (no key file, or a dev copy with no stand-in) is final: start clean,
// never ask again. Ash OS set up but not answering this time (not running, a timeout, an error, an answer the app
// couldn't read, or a pages or memberships read that failed), or the question closed without a choice, decides nothing:
// the app tries again on the next start. Settings → Export and import → "Bring over from Ash OS" runs it again at any
// time, whatever was decided before; it only ever adds. A dev copy imports only from a stand-in, never the live one.
import { invoke } from "@tauri-apps/api/core";
import type { LocalHub } from "./localHub";

/** The key the decision is kept under, beside the record (local_hub.rs). */
export const IMPORT_KEY = "ash-os-import";

export type ImportFound = {
  /** found: its data is below. absent: no Ash OS here, for good. unreachable: set up, but no answer this time. */
  state: "found" | "absent" | "unreachable";
  message?: string;
  projects: unknown[];
  memberships: unknown[];
  pages: unknown[];
};

/** What Ash picked: Import, Start clean, or neither (the question was closed). */
export type ImportAnswer = "import" | "clean" | "later";

export type ImportDecision = {
  /** "later": nothing was decided and nothing is kept; the next start asks Ash OS again. */
  decided: "imported" | "declined" | "none" | "later";
  at: string;
  added?: { projects: number; memberships: number; pages: number };
  message?: string;
};

export type ImportDeps = {
  /** What Ash OS holds (`ash_os_import_fetch`). */
  fetch: () => Promise<ImportFound>;
  /** Ask Ash once. */
  ask: (question: string) => Promise<ImportAnswer>;
  now?: () => Date;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The question, in plain words. */
export function importQuestion(found: Pick<ImportFound, "projects" | "pages">): string {
  const kept = found.pages.filter((p) => (p as { state?: unknown })?.state === "kept").length;
  const parts = [plural(found.projects.length, "project"), ...(kept ? [plural(kept, "kept Page")] : [])];
  return `Hivra no longer uses Ash OS. Bring your ${parts.join(" and ")} over from it? It only adds; Ash OS isn't changed.`;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Run the import. Returns the decision (kept, or "later" when nothing was decided). Safe to call on every start: once a
 * decision is kept it never asks or reads Ash OS again, unless `again` (Settings) says to.
 */
export async function runAshOsImport(hub: LocalHub, deps: ImportDeps, options: { again?: boolean } = {}): Promise<ImportDecision> {
  if (!options.again) {
    const kept = (await hub.disk.read(IMPORT_KEY)) as ImportDecision | null;
    if (kept && typeof kept === "object" && kept.decided && kept.decided !== "later") return kept;
  }
  const at = (deps.now?.() ?? new Date()).toISOString();
  const keep = async (decision: ImportDecision) => {
    await hub.disk.write(IMPORT_KEY, decision);
    return decision;
  };
  const later = (message?: string): ImportDecision => ({ decided: "later", at, ...(message ? { message } : {}) });
  let found: ImportFound;
  try {
    found = await deps.fetch();
  } catch (error) {
    return later(errorText(error));
  }
  const message = found.message ? { message: found.message } : {};
  if (found.state === "unreachable") return later(found.message);
  if (found.state !== "found") return keep({ decided: "none", at, ...message });
  if (!found.projects.length && !found.pages.length) return keep({ decided: "none", at, message: "Ash OS holds no projects or kept Pages." });
  const answer = await deps.ask(importQuestion(found));
  if (answer === "later") return later("The question was closed without a choice.");
  if (answer === "clean") return keep({ decided: "declined", at });
  const added = await hub.importFrom(found);
  return keep({ decided: "imported", at, added });
}

/** The import's real reads and question: Rust reads Ash OS, a native dialog asks. */
export function appImportDeps(): ImportDeps {
  return {
    fetch: () => invoke<ImportFound>("plugin:hub|ash_os_import_fetch"),
    ask: async (question) => {
      const { message } = await import("@tauri-apps/plugin-dialog");
      const picked = await message(question, {
        title: "Bring over from Ash OS",
        kind: "info",
        buttons: { yes: "Import", no: "Start clean", cancel: "Not now" },
      });
      return answerOf(picked);
    },
  };
}

/** The dialog's answer: the button's own label (or its default name); closing it (Esc) decides nothing. */
export function answerOf(picked: string): ImportAnswer {
  if (picked === "Import" || picked === "Yes") return "import";
  if (picked === "Start clean" || picked === "No") return "clean";
  return "later";
}

let started = false;

// The last run's decision, for Home: while the projects are still in Ash OS ("later"), Home says so and offers to try
// again, instead of showing an empty hub with no reason.
let last: ImportDecision | undefined;
const listeners = new Set<() => void>();

function noteDecision(decision: ImportDecision | undefined): ImportDecision | undefined {
  if (decision) {
    last = decision;
    for (const listener of listeners) listener();
  }
  return decision;
}

/** The decision from this launch's last run, if one ran. */
export function lastAshOsImport(): ImportDecision | undefined {
  return last;
}

export function subscribeAshOsImport(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The window that asks: only the main one, never a hidden quick-session or floating window (WP-04 review). */
export const IMPORT_WINDOW = "main";

async function currentWindowLabel(): Promise<string | undefined> {
  try {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    return getCurrentWebviewWindow().label;
  } catch {
    return undefined;
  }
}

/**
 * The app's run on each start: only in the main window (every window loads the hub, hidden ones too, and while the
 * import is undecided each would ask again). Once per launch; for good once a decision is kept.
 */
export async function startAshOsImport(
  hub: LocalHub,
  deps: { label?: () => Promise<string | undefined>; inTauri?: boolean; importDeps?: ImportDeps } = {},
): Promise<ImportDecision | undefined> {
  const inTauri = deps.inTauri ?? (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window);
  if (started || !inTauri) return undefined;
  if ((await (deps.label ?? currentWindowLabel)()) !== IMPORT_WINDOW) return undefined;
  if (started) return undefined;
  started = true;
  return runAshOsImport(hub, deps.importDeps ?? appImportDeps()).then(noteDecision, () => undefined);
}

/** Tests only. */
export function resetAshOsImportStartForTest(): void {
  started = false;
  last = undefined;
}

/** Whether Settings offers the row: not once the app knows there is nothing to bring over ("none": no Ash OS here). */
export async function offersAshOsImport(hub: LocalHub): Promise<boolean> {
  const kept = (await hub.disk.read(IMPORT_KEY).catch(() => null)) as ImportDecision | null;
  return kept?.decided !== "none";
}

/** Settings → "Bring over from Ash OS": run it again, whatever was decided before. */
export async function importFromAshOsAgain(hub: LocalHub, deps: ImportDeps = appImportDeps()): Promise<ImportDecision> {
  const decision = await runAshOsImport(hub, deps, { again: true });
  noteDecision(decision);
  return decision;
}

/** One line for Settings on how it went. */
export function importOutcome(decision: ImportDecision): string {
  switch (decision.decided) {
    case "imported": {
      const a = decision.added ?? { projects: 0, memberships: 0, pages: 0 };
      return a.projects + a.memberships + a.pages
        ? `Brought over ${plural(a.projects, "project")}, ${plural(a.memberships, "Mono's project", "Monos' projects")} and ${plural(a.pages, "kept Page")}.`
        : "Everything Ash OS held is already here.";
    }
    case "declined":
      return "Nothing was brought over.";
    case "none":
      return `There's nothing to bring over${decision.message ? `: ${decision.message}` : "."}`;
    default:
      return `Ash OS didn't answer${decision.message ? ` (${decision.message})` : ""}. Try again when it's running.`;
  }
}
