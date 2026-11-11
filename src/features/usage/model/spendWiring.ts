/**
 * WP-176. Connects the spend gate to the app: the hub's project ids and git, the Mono and habit registries, the
 * spend ledger in the app's database, the wake queue and activity line, and other windows. The app calls it once at
 * start (App.tsx). Tests call the gate's setters directly.
 */

import { invoke } from "@tauri-apps/api/core";
import { hubProjectFolder, hubProjectIdFor } from "../../hub/model/hubData";
import { habitRunMono } from "../../monos/model/monoHabits";
import { listMonos } from "../../monos/model/mono";
import {
  LOCAL_KEY,
  refreshSpendFromStorage,
  setSpendLoader,
  setSpendPersist,
  setSpendProjectLookup,
  spendKey,
  useLiveSpendSink,
} from "./spendGate";
import type { SpendDay } from "./spend";

/** One row of the ledger's day totals, as the app's command sends it. */
type LedgerRow = { projectKey: string; sessionId: string; day: string; micros: number; priced: number; unpriced: number };

function onStorage(event: StorageEvent): void {
  if (event.key === LOCAL_KEY) refreshSpendFromStorage();
}

export function wireSpendGate(): void {
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
  setSpendLoader((since) =>
    invoke<LedgerRow[]>("spend_ledger_totals", { since }).then((rows) =>
      rows.map((row): SpendDay => ({
        projectKey: row.projectKey,
        sessionId: row.sessionId,
        day: row.day,
        micros: row.micros,
        priced: row.priced,
        unpriced: row.unpriced,
      })),
    ),
  );
  setSpendPersist((entry) => invoke("spend_ledger_append", { entry }));
  useLiveSpendSink();
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
}
