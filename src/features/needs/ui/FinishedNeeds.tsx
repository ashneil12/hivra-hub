// Where finished rows go (Ash, 13 Nov: "there's a lot of ones that I can't actually tick as done ... when they
// resolve, they can just go into their own pile that is like out of the way"). One folded line with a count at the
// bottom of the Needs you list and of the roll-up, opening in place: each row says what it was and which of the three
// things happened (settledNeeds.ts), and nothing there asks for anything again.
import { useState } from "react";
import { ChevronRight } from "../../../shared/ui/icons";
import { settledLine, useSettledNeeds } from "../model/settledNeeds";
import { Reveal } from "./Reveal";

export function FinishedNeeds({ className = "" }: { className?: string }) {
  const rows = useSettledNeeds();
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <div data-finished-needs={rows.length} className={`flex flex-col ${className}`}>
      <button
        type="button"
        data-finished-toggle
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 items-center gap-1.5 rounded px-1.5 text-left text-[12px] leading-4 text-content/60 hover:bg-content/5 hover:text-content focus-visible:outline focus-visible:outline-1 focus-visible:outline-content/40"
      >
        <ChevronRight
          aria-hidden
          className={`size-3 shrink-0 transition-transform duration-200 ease-[var(--motion-ease-out)] motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
          strokeWidth={1.75}
        />
        <span>Finished</span>
        <span className="tabular-nums text-content/45">{rows.length}</span>
      </button>
      {open ? (
        <Reveal>
          <ul aria-label="Finished" className="flex flex-col gap-0.5 pb-1">
            {rows.map((row) => (
              <li key={row.key} data-finished-need={row.key} className="flex min-w-0 flex-col rounded-md px-2.5 py-1">
                <span className="truncate text-[12px] leading-4 text-content/70" title={row.sentence}>
                  {row.sentence}
                </span>
                <span data-finished-why className="text-[11px] leading-4 text-content/60">
                  {settledLine(row)}
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
      ) : null}
    </div>
  );
}
