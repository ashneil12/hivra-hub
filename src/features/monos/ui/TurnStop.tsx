// Send becomes Stop, and the model as text above the box (port map idea 2), shared by the Mono chat (MonoComposer) and
// the coding team's own chats (Composer `turnStop` / `modelLine`): one rule, one button, one line. After UniiChat
// (Apache-2.0, VictorTaelin/UniiChat @ 0500bf6): web/src/main.ts bars() and web/src/style.css `.send.stop`.
import type { ReactNode } from "react";

/**
 * Send becomes Stop exactly while a turn runs and nothing waits to go: the box is empty and no attachment waits
 * (UniiChat web/src/main.ts bars(): `stop = on && v.busy && BOX.value.trim() === "" && P.imgs.length === 0`).
 */
export function showsStop(state: { enabled: boolean; busy: boolean; text: string; attachments: number; canStop: boolean }): boolean {
  return state.enabled && state.canStop && state.busy && state.text.trim() === "" && state.attachments === 0;
}

/** The send button's Stop face: same spot and size, a grey fill and a filled square, never red (`.send.stop`). */
export function TurnStopButton({
  type = "button",
  onClick,
  className = "",
}: {
  type?: "button" | "submit";
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type={type}
      aria-label="Stop"
      title="Stop"
      data-mono-stop
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`grid size-6.5 place-items-center rounded-md bg-content/12 text-content transition-[background-color,color,transform] duration-150 hover:bg-content/16 active:scale-90 ${className}`}
    >
      <span aria-hidden className="size-2.5 rounded-[2px] bg-current" />
    </button>
  );
}

/** Above the box: a hairline, then the model line (MonoModelLine), as UniiChat's pick line. */
export function ModelLineRow({ children }: { children: ReactNode }) {
  return (
    <div data-mono-pick className="flex min-w-0 items-center gap-1 pb-1 pl-1 pr-1.5">
      {/* The rule is also the turn runner's ledge in the full composer (ComposerRunner), so it never runs over the model. */}
      <span aria-hidden data-model-line-rule className="h-px min-w-6 flex-1 bg-content/8" />
      {children}
    </div>
  );
}
