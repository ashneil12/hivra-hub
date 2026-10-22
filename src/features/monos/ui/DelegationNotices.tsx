// The two lines the delegation tree adds around a chat's composer (H4):
// - a worker's chat runs on its own, so it shows "Runs on its own · Open <Lead>" instead of the composer; the Lead
//   does the talking, and Ash can still jump in;
// - a Lead with delegated work out reads what is out by name ("2 working: API, UI · 1 asking: Docs · 1 stuck: Tests";
//   "Waiting on N" without names; its count, "Delegated 3: 2 working, 1 failed", on hover), with one Stop for
//   everything beneath it, and above it a card for each worker that is stuck (StuckWorkerCard.tsx);
// - a Mono with a brief out to a coding team reads one line for it (Ash, 20 Oct: "Briefed EXO coding team: <task> · 2
//   working · 1 stuck"), which opens that coding team on its Lead: the brief's workers live there, not in this chat.
import { useState } from "react";
import { ChevronRight, Square, Terminal } from "../../../shared/ui/icons";
import { briefedStatus, type BriefedTeam } from "../model/briefedTeams";
import { workingLine } from "../model/leadFlow";
import { shortSplit, workSplit, type StuckWorker } from "../model/workerStuck";
import { StuckList, stuckTitle } from "./StuckWorkerCard";

/**
 * One brief to a coding team, as the briefing Mono's chat shows it: "Briefed EXO coding team: Fix the save bug · 2
 * working · 1 stuck" (asking counts as stuck; the stuck part amber, or red once one failed). Live (it reads the rows),
 * and one click opens the coding team on its Lead.
 */
export function BriefedTeamLine({ brief, onOpen }: { brief: BriefedTeam; onOpen?: (brief: BriefedTeam) => void }) {
  const { counts } = brief;
  const short = shortSplit(counts);
  const team = brief.to?.team ?? "its coding team";
  const words = `Briefed ${team}: ${brief.title} · ${briefedStatus(brief)}`;
  return (
    <button
      type="button"
      data-briefed-team={brief.row.id}
      data-briefed-project={brief.to?.projectId}
      data-briefed-kind={brief.failed ? "failed" : counts.stuck ? "stuck" : counts.asking ? "asking" : "working"}
      disabled={!onOpen || !brief.to}
      title={[workSplit(counts), brief.to ? `Open ${team} on ${brief.to.leadName}` : undefined].filter(Boolean).join("\n") || words}
      aria-label={brief.to ? `${words}. Open ${team}` : words}
      onClick={() => onOpen?.(brief)}
      className="group/brief flex w-full min-w-0 cursor-default items-center gap-2 rounded-2xl border border-content/10 px-4 py-2.5 text-left font-sans text-[12px] text-content/55 hover:bg-content/4 disabled:hover:bg-transparent"
    >
      <Terminal aria-hidden className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
      {/* The brief's words give way first; what its team has out always shows. */}
      <span className="flex min-w-0 items-baseline">
        <span className="min-w-0 truncate" data-briefed-words>
          <span className="text-content/85">Briefed {team}:</span> {brief.title}
        </span>
        <span className="shrink-0 whitespace-pre" data-briefed-status>
          <span aria-hidden> · </span>
          {short.text ? (
            <>
              {short.working ? <span>{short.working} working</span> : null}
              {short.working && short.waiting ? <span aria-hidden> · </span> : null}
              {short.waiting ? <span data-briefed-waiting>{short.waiting} waiting</span> : null}
              {(short.working || short.waiting) && short.stuck ? <span aria-hidden> · </span> : null}
              {short.stuck ? (
                <span className="text-content/60">{short.stuck} stuck</span>
              ) : null}
            </>
          ) : (
            briefedStatus(brief)
          )}
        </span>
      </span>
      {brief.to ? (
        <ChevronRight
          aria-hidden
          className="ml-auto size-3.5 shrink-0 text-content/35 group-hover/brief:text-content/70"
          strokeWidth={1.75}
        />
      ) : null}
    </button>
  );
}

/** "Tests, Upload" (at most three names, then "+2"), as the working line names them. */
function names(list: readonly string[]): string {
  return list.length > 3
    ? `${list.slice(0, 3).join(", ")} +${list.length - 3}`
    : list.join(", ");
}

export function DelegatedChatNotice({
  ownerName,
  state,
  stuck,
  now = Date.now(),
  onOpenOwner,
  onJumpIn,
}: {
  ownerName: string;
  /** Where its work stands: still running, asking its Lead, or finished. */
  state: "running" | "asking" | "finished";
  /** It is stuck (asking, stalled or failed): its card above the line, answerable here without jumping in. */
  stuck?: StuckWorker;
  now?: number;
  onOpenOwner?: () => void;
  onJumpIn: () => void;
}) {
  const lead =
    state === "asking"
      ? `Asked ${ownerName} a question`
      : state === "finished"
        ? `Worked for ${ownerName}`
        : "Runs on its own";
  return (
    <>
      {stuck ? (
        <div className="w-full">
          <StuckList stuck={[stuck]} now={now} variant="chat" label="Stuck" />
        </div>
      ) : null}
      <div
        data-delegated-chat
        className="flex w-full items-center gap-2 rounded-2xl border border-content/10 px-4 py-3 font-sans text-[13px] text-content/60"
      >
        <span className="min-w-0 truncate">
          {lead}
          <span aria-hidden className="px-1.5 opacity-60">
            ·
          </span>
          {onOpenOwner ? (
            <button
              type="button"
              onClick={onOpenOwner}
              className="rounded text-content underline-offset-2 hover:underline"
            >
              Open {ownerName}
            </button>
          ) : (
            <span>{ownerName} talks to it</span>
          )}
        </span>
        <button
          type="button"
          data-jump-in
          onClick={onJumpIn}
          className="ml-auto shrink-0 rounded-lg px-2 py-1 text-[12px] text-content/55 hover:bg-content/6 hover:text-content"
        >
          Jump in
        </button>
      </div>
    </>
  );
}

export function DelegationWaitingLine({
  count,
  working = [],
  asking = [],
  rollup,
  stuck = [],
  now = Date.now(),
  failed = [],
  unloaded = [],
  onStopAll,
  briefs = [],
  onOpenBrief,
}: {
  count: number;
  /** What is out by title, still running (not stalled) and asking: "2 working: API, UI". */
  working?: readonly string[];
  asking?: readonly string[];
  /** "Delegated 3: 2 working, 1 failed": the count of what it has out, on hover. */
  rollup?: string;
  /** Its workers that are stuck: a card each, above the line. */
  stuck?: readonly StuckWorker[];
  now?: number;
  /** Chats the last Stop couldn't stop, by title. */
  failed?: readonly string[];
  /** Chats whose workers the last Stop couldn't load (they may still be running), by title. */
  unloaded?: readonly string[];
  onStopAll?: () => Promise<unknown> | void;
  /** Its briefs out to coding teams: a line each, above the working line (BriefedTeamLine). */
  briefs?: readonly BriefedTeam[];
  onOpenBrief?: (brief: BriefedTeam) => void;
}) {
  const [stopping, setStopping] = useState(false);
  if (count <= 0 && !failed.length && !unloaded.length && !stuck.length)
    return null;
  // Stalled and failed workers are named as stuck; their cards above say how.
  const stuckNames = stuck
    .filter((s) => s.kind !== "asking")
    .map((s) => stuckTitle(s));
  const named = [
    workingLine({ working, asking }),
    stuckNames.length
      ? `${stuckNames.length} stuck: ${names(stuckNames)}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  // Briefs have their own lines: "Waiting on N" counts only the rest.
  const others = count - briefs.length;
  const line = named || (others > 0 ? `Waiting on ${others}` : undefined);
  return (
    <>
      <StuckList stuck={stuck} now={now} variant="chat" label="Stuck workers" />
      {briefs.length ? (
        <div data-briefed-teams className="flex flex-col gap-1.5 pb-1.5">
          {briefs.map((brief) => (
            <BriefedTeamLine key={brief.row.id} brief={brief} onOpen={onOpenBrief} />
          ))}
        </div>
      ) : null}
      <div
        data-delegation-waiting={count}
        className="flex items-center gap-2 px-1 pb-1.5 font-sans text-[12px] text-content/55"
      >
        {line ? (
          <span
            data-delegation-working
            className="min-w-0 truncate"
            title={rollup ?? [...working, ...asking, ...stuckNames].join(", ")}
          >
            {line}
          </span>
        ) : null}
        {failed.length ? (
          <span
            className="min-w-0 truncate text-amber-400"
            title={failed.join(", ")}
          >
            Couldn&apos;t stop{" "}
            {failed.length === 1 ? failed[0] : `${failed.length} chats`}
          </span>
        ) : null}
        {unloaded.length ? (
          <span
            data-delegation-unloaded
            className="min-w-0 truncate text-amber-400"
            title={unloaded.join(", ")}
          >
            Couldn&apos;t load the workers under{" "}
            {unloaded.length === 1 ? unloaded[0] : `${unloaded.length} chats`};
            they may still be running
          </span>
        ) : null}
        {onStopAll && count > 0 ? (
          <button
            type="button"
            data-delegation-stop-all
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void Promise.resolve(onStopAll()).finally(() =>
                setStopping(false),
              );
            }}
            title="Stop everything it delegated"
            className="ml-auto flex shrink-0 items-center gap-1 rounded-lg px-2 py-0.5 hover:bg-content/6 hover:text-content disabled:opacity-50"
          >
            <Square className="size-3" strokeWidth={2} />
            {stopping ? "Stopping" : "Stop all"}
          </button>
        ) : null}
      </div>
    </>
  );
}
