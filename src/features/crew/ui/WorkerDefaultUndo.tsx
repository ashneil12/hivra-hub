// WP-89: the Undo on a worker-default card. The line is already the message text.

import { useState } from "react";
import type { MonoCard } from "../../monos/model/monoCards";
import { findMono } from "../../monos/model/mono";
import { undoWorkerDefault } from "../model/undoWorkerDefault";

type Card = Extract<MonoCard, { type: "worker-default" }>;

function noteUndone(card: Card): void {
  const actor = card.mono?.trim();
  if (!actor) return;
  const name = findMono(actor)?.name ?? actor;
  void import("@tauri-apps/api/core")
    .then(({ invoke }) =>
      invoke("activity_note", {
        kind: "worker.default",
        summary: "Undone the worker default.",
        project: card.scope === "system" ? "app" : (card.project?.trim() || "app"),
        target: card.scope,
        actorId: actor,
        actorName: name,
      }),
    )
    .catch(() => undefined);
}

export function WorkerDefaultUndo({ card }: { card: Card }) {
  const [undone, setUndone] = useState(false);
  const [problem, setProblem] = useState<string>();

  function onUndo() {
    if (undone) return;
    try {
      undoWorkerDefault(card);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That didn't undo.");
      return;
    }
    setUndone(true);
    setProblem(undefined);
    noteUndone(card);
  }

  return (
    <div className="mt-1 flex items-center gap-2">
      <button
        type="button"
        className="text-[12px] text-content/55 hover:text-content disabled:hover:text-content/55"
        data-worker-default-undo=""
        disabled={undone}
        onClick={onUndo}
      >
        {undone ? "Undone" : "Undo"}
      </button>
      {problem ? (
        <span className="text-[12px] text-content/70" role="alert" data-worker-default-undo-error="">
          {problem}
        </span>
      ) : null}
    </div>
  );
}
