/**
 * WP-176. Connects the spend gate to the app: the hub's project ids and git, the Mono and habit registries, the
 * spend ledger in the app's database, the wake queue and activity line, and other windows. The app calls it once at
 * start (App.tsx). Tests call the gate's setters directly.
 */

import { invoke } from "@tauri-apps/api/core";
import { hubProjectFolder, hubProjectIdFor, hubProjectList } from "../../hub/model/hubData";
import { habitRunMono } from "../../monos/model/monoHabits";
import { listMonos } from "../../monos/model/mono";
import {
  LOCAL_KEY,
  parseStoredBook,
  readLocalSpendBook,
  refreshSpendFromStorage,
  setSpendBookStore,
  setSpendLoader,
  setSpendPersist,
  setSpendProjectLookup,
  setSpendRedoLinks,
  spendKey,
  useLiveSpendSink,
  type SpendBookStore,
} from "./spendGate";
import type { SpendDay } from "./spend";

/** One row of the ledger's day totals, as the app's command sends it. */
type LedgerRow = { projectKey: string; sessionId: string; day: string; micros: number; priced: number; unpriced: number; source?: string | null };

function onStorage(event: StorageEvent): void {
  if (event.key === LOCAL_KEY) refreshSpendFromStorage();
}

/** The app's database row for the limits book: the revision and the book's JSON text, as the Rust commands keep them. */
type BookRow = { revision: number; body: string };

/**
 * The limits book in the app's database (spend_limit_book). Reads fail loudly; a missing or unreadable row is never
 * taken for "no limits" (the gate holds automated turns until the book answers).
 */
const bookInDatabase: SpendBookStore = {
  read: async () => {
    const row = await invoke<BookRow | null>("spend_book_read");
    if (!row) return null;
    const parsed = parseStoredBook({ ...(JSON.parse(row.body) as Record<string, unknown>), revision: row.revision });
    if (!parsed) throw new Error("The spend limits in the database are not a readable book.");
    return parsed;
  },
  write: async ({ expected, revision, limits, ceilings }) => {
    await invoke("spend_book_write", { expected, revision, body: JSON.stringify({ revision, limits, ceilings }) });
  },
};

/**
 * The app's projects in the one folder form, for the ledger's spend keys (Rust spend_key). Sent on each loader pass, so
 * a verdict and the limits key a folder the same way. A project whose folder git cannot answer for is left out.
 */
async function syncProjectFolders(): Promise<void> {
  try {
    const projects = hubProjectList().filter((project) => project.folder);
    // Nothing to send until the hub has projects: an empty list would clear the ledger's table (round 6).
    if (projects.length === 0) return;
    const entries = await Promise.all(
      projects.map(async (project) => {
        try {
          return { id: project.id, folder: await invoke<string>("spend_project_folder", { cwd: project.folder }) };
        } catch {
          return null;
        }
      }),
    );
    const known = entries.filter((entry) => entry !== null);
    if (known.length === 0) return;
    await invoke("spend_set_project_folders", { projects: known });
  } catch {
    /* the next pass sends them again; until then a verdict that needs a folder holds (fail closed) */
  }
}

export function wireSpendGate(): void {
  // The database holds the book. localStorage's copy is read once, for a book saved before the database held it.
  void setSpendBookStore(bookInDatabase, readLocalSpendBook);
  setSpendProjectLookup({
    idOf: (folder) => hubProjectIdFor(folder),
    folderOf: (id) => hubProjectFolder(id),
    firstMateOf: (key) => listMonos().find((mono) => mono.projects.some((project) => spendKey(project) === key))?.sessionId,
    // A habit run belongs to its Mono's project, even when it runs from home.
    projectOfSession: (sessionId) => {
      const mono = habitRunMono(sessionId);
      if (!mono) return undefined;
      return listMonos().find((item) => item.id === mono)?.projects[0];
    },
    resolveFolder: (cwd) => invoke<string>("spend_project_folder", { cwd }),
  });
  setSpendLoader((since) => {
    // The project folders go to the ledger on every loader pass, so a list that was empty at start-up is sent again
    // once the hub has projects (round 6).
    void syncProjectFolders();
    return Promise.all([
      invoke<LedgerRow[]>("spend_ledger_totals", { since }),
      // The redo links are read with the ledger, so a redo's ceiling follows its parent after a restart (WP-176 round 4).
      invoke<{ child: string; parent: string }[]>("spend_redo_links"),
    ]).then(([rows, links]) => {
      setSpendRedoLinks(links);
      return rows.map((row): SpendDay => ({
        projectKey: row.projectKey,
        sessionId: row.sessionId,
        day: row.day,
        micros: row.micros,
        priced: row.priced,
        unpriced: row.unpriced,
        ...(row.source ? { source: row.source } : {}),
      }));
    });
  });
  setSpendPersist((entry) => invoke("spend_ledger_append", { entry }));
  useLiveSpendSink();
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
}
