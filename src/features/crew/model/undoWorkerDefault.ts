// WP-89: Undo writes that scope back to the card's previous setting, or clears it.
// A Mono write only lands if the roster is still the one just read.

import type { MonoCard } from "../../monos/model/monoCards";
import { commitRoster } from "../../monos/model/mono";
import {
  setProjectWorkerModel,
  setSystemWorkerDefault,
} from "../../monos/model/workerPool";
import { cleanStoredDefault } from "./workerDefault";

type WorkerDefaultCard = Extract<MonoCard, { type: "worker-default" }>;

function restored(card: WorkerDefaultCard) {
  return card.previous ? cleanStoredDefault(card.previous) : undefined;
}

/** Put one scope back. A previous value that isn't usable is dropped, not stored. */
export function undoWorkerDefault(card: WorkerDefaultCard): void {
  const previous = restored(card);
  if (card.scope === "system") {
    setSystemWorkerDefault(previous);
    return;
  }
  if (card.scope === "project") {
    const project = card.project?.trim();
    if (!project) throw new Error("Say which project this undoes.");
    setProjectWorkerModel(
      project,
      previous?.model
        ? {
            model: previous.model,
            ...(previous.cli ? { cli: previous.cli } : {}),
            ...(previous.effort ? { effort: previous.effort } : {}),
          }
        : undefined,
    );
    return;
  }
  const id = card.mono?.trim();
  if (!id) throw new Error("Say which Mono this undoes.");
  const commit = commitRoster((roster) => {
    const index = roster.findIndex((mono) => mono.id === id);
    if (index < 0) return null;
    const next = { ...roster[index] };
    if (previous) next.workerDefault = previous;
    else delete next.workerDefault;
    const copy = roster.slice();
    copy[index] = next;
    return copy;
  });
  if (commit === "missing") throw new Error("That Mono isn't on this Mac.");
  if (commit === "lost") throw new Error("That change didn't stick. Try again.");
}
