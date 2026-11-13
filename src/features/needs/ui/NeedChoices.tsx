// Every answer a question offers, as the card shows it (Ash, 13 Nov: "right now it only gives you one option ... let's
// say there's multiple choice. Well, how are you going to really see the multiple choice in a way that's actually
// beautiful looking?"). One row per answer, lettered a, b, c so a key press picks one, the asker's pick marked
// Suggested. A pick shows at once: the chosen row lights and gets its tick, the others fade, and a line says who has it.
import { useState, type KeyboardEvent } from "react";
import { Check, LoaderCircle } from "../../../shared/ui/icons";
import { noteAnswered } from "../model/answeredNeeds";
import type { NeedsItem } from "../model/needsYou";

const PRESS = "transition-[background-color,border-color,color,opacity,transform] duration-[160ms] ease-[var(--motion-ease-out)] active:scale-[0.99] motion-reduce:transition-none";

export type ChoiceState = { phase: "idle" } | { phase: "sending" | "answered"; chosen: string } | { phase: "refused"; chosen: string; reason: string };

export function choiceLetter(index: number): string {
  return String.fromCharCode(97 + index);
}

export function NeedChoices({ item }: { item: Pick<NeedsItem, "key" | "who" | "sentence" | "choices" | "suggested" | "answer" | "outcomes"> }) {
  const [state, setState] = useState<ChoiceState>({ phase: "idle" });
  const choices = item.choices ?? [];
  const answer = item.answer;
  if (!choices.length || !answer) return null;
  const busy = state.phase === "sending" || state.phase === "answered";
  const choose = async (label: string) => {
    if (busy) return;
    setState({ phase: "sending", chosen: label });
    const reason = await answer(label);
    if (reason) {
      setState({ phase: "refused", chosen: label, reason });
      return;
    }
    // An answer that only takes the person somewhere (a quiet ask's "Answer it") leaves the card as it was.
    const outcome = item.outcomes?.[label];
    if (outcome === null) {
      setState({ phase: "idle" });
      return;
    }
    setState({ phase: "answered", chosen: label });
    noteAnswered({ key: item.key, words: label, who: item.who, sentence: item.sentence, ...(outcome ? { line: outcome } : {}) });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
    const index = event.key.toLowerCase().charCodeAt(0) - 97;
    const label = choices[index];
    if (!label) return;
    event.preventDefault();
    void choose(label);
  };
  return (
    <div data-need-choices={state.phase} role="group" aria-label="Answers" onKeyDown={onKeyDown} className="flex flex-col gap-1.5">
      {choices.map((label, index) => {
        const letter = choiceLetter(index);
        const suggested = label === item.suggested;
        const chosen = state.phase !== "idle" && state.chosen === label;
        const tone = chosen
          ? "border-transparent bg-selection text-content"
          : suggested
            ? "border-content/20 bg-content/5 text-content hover:bg-content/8"
            : "border-content/10 text-content/85 hover:border-content/20 hover:bg-content/5 hover:text-content";
        return (
          <button
            key={label}
            type="button"
            data-need-choice={letter}
            data-suggested={suggested ? "" : undefined}
            aria-label={`${letter}: ${label}${suggested ? ", suggested" : ""}`}
            aria-pressed={chosen}
            disabled={busy}
            onClick={() => void choose(label)}
            className={`flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left text-[13px] leading-[18px] disabled:cursor-default ${PRESS} ${tone} ${
              state.phase === "answered" && !chosen ? "opacity-40" : ""
            }`}
          >
            <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded bg-content/8 text-[11px] font-medium text-content/60">
              {chosen && state.phase === "answered" ? (
                <Check className="size-3.5 text-content" strokeWidth={2} />
              ) : chosen && state.phase === "sending" ? (
                <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" strokeWidth={1.75} />
              ) : (
                letter
              )}
            </span>
            <span className="min-w-0 flex-1 break-words">{label}</span>
            {suggested ? <span className="shrink-0 text-[11px] text-content/60">Suggested</span> : null}
          </button>
        );
      })}
      {state.phase === "answered" ? (
        <p role="status" data-need-choice-state="answered" className="text-[12px] leading-4 text-content/60">
          {item.outcomes?.[state.chosen] ?? `Sent. ${item.who} has it.`}
        </p>
      ) : state.phase === "refused" ? (
        <p role="alert" data-need-choice-state="refused" className="text-[12px] leading-4 text-red-400">
          {state.reason}
        </p>
      ) : null}
    </div>
  );
}
