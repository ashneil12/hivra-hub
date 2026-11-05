// WP-84: the phase documents on a task, and the decision at a review.

import { useState } from "react";
import type { PathId } from "../model/settings";

const PATHS: { id: PathId; label: string }[] = [
  { id: "straight", label: "Straight build" },
  { id: "research-plan-build", label: "Research, plan, build" },
  { id: "product-first", label: "Product first" },
];

export function PhasePanel({
  pathLabel,
  why,
  pathId,
  documents,
  waiting,
  onAnswer,
  onPath,
  onDocComment,
}: {
  pathLabel: string;
  why: string;
  pathId: PathId;
  documents: readonly { number: number; title: string; body: string }[];
  waiting: boolean;
  onAnswer?: (choice: string, words: string) => void;
  onPath?: (path: string) => void;
  onDocComment?: (docNumber: number, text: string) => void;
}) {
  const [words, setWords] = useState("");
  const ordered = [...documents].sort((a, b) => a.number - b.number);
  return (
    <section aria-label="Phases" className="mt-2">
      <p className="text-[12px] text-content">{pathLabel}</p>
      <p className="text-[12px] text-content/70">{why}</p>
      {onPath ? (
        <label className="mt-1 block text-[12px] text-content/70">
          Path
          <select aria-label="Path" className="ml-2 bg-transparent text-content" value={pathId} onChange={(event) => onPath(event.target.value)}>
            {PATHS.map((path) => (
              <option key={path.id} value={path.id}>
                {path.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <ol className="mt-2 space-y-2">
        {ordered.map((doc) => (
          <li key={doc.number}>
            <h4 className="text-[12px] text-content">
              {doc.number}. {doc.title}
            </h4>
            <p className="whitespace-pre-wrap text-[12px] text-content/80">{doc.body}</p>
            {onDocComment ? (
              <form
                className="mt-1 flex gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  const text = String(data.get("note") ?? "");
                  if (!text.trim()) return;
                  onDocComment(doc.number, text);
                  event.currentTarget.reset();
                }}
              >
                <input name="note" aria-label={`Note on ${doc.title}`} className="min-w-0 flex-1 rounded-md border border-stroke bg-transparent px-2 py-1 text-[12px] text-content" />
                <button type="submit" className="text-[12px] text-content/70">
                  Add note
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ol>
      {waiting && onAnswer ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" className="text-[12px] text-content" onClick={() => onAnswer("Looks right", "")}>
            Looks right
          </button>
          <button
            type="button"
            className="text-[12px] text-content"
            onClick={() => {
              if (!words.trim()) return;
              onAnswer("Change this", words);
              setWords("");
            }}
          >
            Change this
          </button>
          <button type="button" className="text-[12px] text-content" onClick={() => onAnswer("Skip to building", "")}>
            Skip to building
          </button>
          <input aria-label="What should change" value={words} onChange={(event) => setWords(event.target.value)} className="min-w-0 flex-1 rounded-md border border-stroke bg-transparent px-2 py-1 text-[12px] text-content" />
        </div>
      ) : null}
    </section>
  );
}
