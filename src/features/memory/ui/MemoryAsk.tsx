// WP-100: the one question memory asks, in the Memory screen. Four plain answers, and the answer decides.

import { useState } from "react";
import type { MemoryItem } from "../model/doc";
import type { AskAnswer } from "../model/ask";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";

/**
 * "Still true?" about one faded fact. The answers are the four the model keeps: still true, changed (with the new
 * wording typed in), no longer true, and unsure. Wording alone is never an answer: "changed" is, and the text is what
 * it becomes.
 */
export function MemoryAsk({
  item,
  busy,
  onAnswer,
}: {
  item: MemoryItem;
  busy: boolean;
  onAnswer: (answer: AskAnswer) => void;
}) {
  const [changing, setChanging] = useState(false);
  const [wording, setWording] = useState(item.text);
  const cleaned = wording.trim();
  return (
    <section data-ask={item.id} aria-label="A memory to check" className="flex flex-col gap-2 rounded-md border border-content/15 p-3">
      <p>Is this still true?</p>
      <p data-ask-text>{item.text}</p>
      {changing ? (
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-sm">
            What is true now
            <textarea
              aria-label="What is true now"
              value={wording}
              onChange={(event) => setWording(event.target.value)}
              className="rounded-md border border-content/15 bg-transparent px-2 py-1"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              className={BTN}
              disabled={busy || !cleaned}
              onClick={() => onAnswer({ kind: "changed", text: cleaned })}
            >
              Save the new wording
            </button>
            <button type="button" className={BTN} disabled={busy} onClick={() => setChanging(false)}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN} disabled={busy} onClick={() => onAnswer({ kind: "still-true" })}>
            Still true
          </button>
          <button type="button" className={BTN} disabled={busy} onClick={() => setChanging(true)}>
            It changed
          </button>
          <button type="button" className={BTN} disabled={busy} onClick={() => onAnswer({ kind: "no-longer" })}>
            No longer true
          </button>
          <button type="button" className={BTN} disabled={busy} onClick={() => onAnswer({ kind: "unsure" })}>
            Not sure
          </button>
        </div>
      )}
    </section>
  );
}
