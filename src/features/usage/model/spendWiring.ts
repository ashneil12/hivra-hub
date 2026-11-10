/**
 * WP-176. Connects the spend gate to the hub's project ids and to the Mono and habit registries. The app calls it once
 * at start (App.tsx). Tests call the gate's setters directly.
 */

import { hubProjectFolder, hubProjectIdFor } from "../../hub/model/hubData";
import { habitRunMono } from "../../monos/model/monoHabits";
import { listMonos, monoForSession } from "../../monos/model/mono";
import { setSpendChatKind, setSpendProjectLookup, spendKey, type ChatKind } from "./spendGate";

export function wireSpendGate(): void {
  setSpendProjectLookup({
    idOf: (folder) => hubProjectIdFor(folder),
    folderOf: (id) => hubProjectFolder(id),
    firstMateOf: (key) => listMonos().find((mono) => mono.projects.some((project) => spendKey(project) === key))?.sessionId,
  });
  setSpendChatKind((sessionId): ChatKind => {
    if (habitRunMono(sessionId)) return "habit";
    if (monoForSession(sessionId)) return "mono";
    if (sessionId.startsWith("app-")) return "worker";
    return "chat";
  });
}
