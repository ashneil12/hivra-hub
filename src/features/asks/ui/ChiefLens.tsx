// The project filter at the top of the Chief of Staff's one chat (Ash's round 3 pick, 13 Nov): "Everything", or one
// project. It narrows the same chat to that project's turns (asks/model/chiefLens.ts says how a turn is told apart) and
// what he types next is about that project. The row is the UI SDK's segmented control: one tab stop, arrow keys move.
import { useState } from "react";
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { NEEDS_YOU_RED } from "../../hub/ui/StatusMark";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import { useDelegationRows } from "../../monos/model/delegationStore";
import { useNeedsYou } from "../../needs/model/needsLive";
import { isOpenJob, jobStatus } from "../model/chiefJobs";
import { lensTag, setChiefLens, useChiefLens } from "../model/chiefLens";

const ALL = "all";

type LensRow = { id: string; name: string; needs: number; running: number; waiting: number };

function useLensRows(): LensRow[] {
  useHubDataVersion();
  const needs = useNeedsYou();
  const rows = useDelegationRows();
  return hubData()
    .listProjects()
    .map((project) => {
      const jobs = rows.filter((row) => row.project === project.id && isOpenJob(row));
      return {
        id: project.id,
        name: project.name,
        needs: needs.filter((item) => item.projectId === project.id).length,
        running: jobs.filter((row) => jobStatus(row) === "working").length,
        waiting: jobs.filter((row) => jobStatus(row) !== "working").length,
      };
    });
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const ITEM =
  "relative z-[1] flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md px-2.5 text-[12px] text-content/60 outline-none transition-colors duration-150 hover:text-content data-[checked]:text-content focus-visible:ring-1 focus-visible:ring-content/40";

/** The row at the top of the one chat. Shows only when there are two projects or more to tell apart. */
export function ChiefLensBar({ sessionId }: { sessionId: string }) {
  const lens = useChiefLens();
  const rows = useLensRows();
  const [showQuiet, setShowQuiet] = useState(false);
  if (rows.length < 2) return null;
  // Projects with something going on come first, the ones that need him first of all; quiet ones fold into one button.
  const busy = rows.filter((row) => row.needs || row.running || row.waiting).sort((a, b) => b.needs - a.needs || b.running - a.running);
  const quiet = rows.filter((row) => !busy.includes(row));
  const shown = [...busy, ...(showQuiet || quiet.some((row) => row.id === lens) ? quiet : [])];
  const picked = rows.find((row) => row.id === lens);
  return (
    <div data-chief-lens={lens ?? ALL} className="flex shrink-0 flex-col gap-0.5 border-b border-stroke px-4 py-1.5 font-sans">
      <div className="scrollbar-none flex items-center gap-1 overflow-x-auto">
        <SegmentedControl
          aria-label="Show in this chat"
          value={lens ?? ALL}
          onValueChange={(value) => {
            setChiefLens(value === ALL ? null : String(value));
            // The newest of what is now shown, as when a chat opens.
            requestAnimationFrame(() => {
              const turns = Array.from(document.querySelectorAll<HTMLElement>(`[data-session-drop="${CSS.escape(sessionId)}"] [data-transcript-turn]`));
              turns.filter((turn) => turn.offsetParent).pop()?.scrollIntoView({ block: "end" });
            });
          }}
          className="relative isolate flex items-center gap-0.5"
        >
          <SegmentedControlIndicator
            className="absolute -z-[1] rounded-md bg-content/10 transition-[top,left,width,height] duration-200 ease-[var(--motion-ease-out)] motion-reduce:transition-none"
            style={{
              top: "var(--segmented-control-indicator-top)",
              left: "var(--segmented-control-indicator-left)",
              width: "var(--segmented-control-indicator-width)",
              height: "var(--segmented-control-indicator-height)",
            }}
          />
          <SegmentedControlItem value={ALL} className={ITEM} data-lens-pick={ALL}>
            Everything
          </SegmentedControlItem>
          {shown.map((row) => (
            <SegmentedControlItem key={row.id} value={row.id} className={ITEM} data-lens-pick={row.id}>
              {row.name}
              {row.needs ? (
                <span className="tabular-nums" style={{ color: NEEDS_YOU_RED }} aria-label={plural(row.needs, "needs you", "need you")}>
                  {row.needs}
                </span>
              ) : null}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        {quiet.length && !shown.some((row) => quiet.includes(row)) ? (
          <button
            type="button"
            data-lens-quiet
            onClick={() => setShowQuiet(true)}
            className="h-7 shrink-0 rounded-md px-2 text-[12px] text-content/60 hover:bg-content/8 hover:text-content"
          >
            +{quiet.length} quiet
          </button>
        ) : null}
      </div>
      {picked ? (
        <p data-lens-status className="px-1 text-[12px] leading-5 text-content/60">
          Only {picked.name}, in this same chat.{" "}
          {picked.running || picked.waiting
            ? [picked.running ? `${picked.running} running` : "", picked.waiting ? `${picked.waiting} waiting` : ""].filter(Boolean).join(", ")
            : "Nothing running"}
          {picked.needs ? (
            <>
              , <span style={{ color: NEEDS_YOU_RED }}>{plural(picked.needs, "needs you", "need you")}</span>
            </>
          ) : null}
          .
        </p>
      ) : null}
      {lens ? <LensFilter sessionId={sessionId} lens={lens} /> : null}
    </div>
  );
}

/** Hides this chat's turns that aren't about the project. Nothing is removed: Everything shows them again. */
function LensFilter({ sessionId, lens }: { sessionId: string; lens: string }) {
  const pane = `[data-session-drop="${CSS.escape(sessionId)}"]`;
  const tag = CSS.escape(lensTag(lens));
  // A reply about several projects stays, but another project's question card in it doesn't.
  return (
    <style data-lens-filter>{`${pane} [data-transcript-turn]:not([data-turn-tags~="${tag}"]) { display: none; }
${pane} [data-inline-need-project]:not([data-inline-need-project="${tag}"]) { display: none; }`}</style>
  );
}

/** Above the box he types in, while narrowed: who the next message is about, and the way back to everything. */
export function ChiefLensComposerLine() {
  const lens = useChiefLens();
  useHubDataVersion();
  const picked = lens ? hubData().listProjects().find((project) => project.id === lens) : undefined;
  if (!picked) return null;
  return (
    <div
      data-lens-composer
      className="glass-bar mb-1.5 flex w-full items-center gap-2 rounded-2xl border border-content/10 px-4 py-2 font-sans text-[13px] text-content/60"
    >
      <span className="min-w-0 truncate">
        About {picked.name}. The Chief of Staff answers here and passes it on to {picked.name}&apos;s first mate.
      </span>
      <button
        type="button"
        data-lens-clear
        onClick={() => setChiefLens(null)}
        className="ml-auto shrink-0 rounded-lg border border-content/20 px-2 py-1 text-[12px] text-content hover:bg-content/8"
      >
        Show everything
      </button>
    </div>
  );
}
