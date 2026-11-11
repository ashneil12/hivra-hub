// The two lines the delegation tree adds around a chat's composer (H4):
// - a worker's chat runs on its own, so it shows "Runs on its own · Open <Lead>" instead of the composer; the Lead
//   does the talking, and Ash can still jump in;
// - a Lead with delegated work out reads what is out by name ("2 working: API, UI · 1 asking: Docs · 1 with Hivra lead: Tests";
//   "Waiting on N" without names; its count, "Delegated 3: 2 working, 1 failed", on hover), with one Stop for
//   everything beneath it, and above it a card for each worker that is stuck (StuckWorkerCard.tsx);
// - a Mono with a brief out to a coding team reads one line for it (Ash, 20 Oct: "Briefed EXO coding team: <task> · 2
//   working · 1 with EXO lead"; never "stuck", r30b), which opens that coding team on its Lead: the brief's workers live there, not in this chat.
import { useState } from "react";
import { CrewBriefLines } from "../../crew/ui/BriefLines";
import { ChevronRight, Square, Terminal } from "../../../shared/ui/icons";
import type { HarnessId } from "../../sessions/model/session";
import { MonoModelLine } from "./MonoModelLine";
import { briefedStatus, type BriefedTeam } from "../model/briefedTeams";
import { workingLine } from "../model/leadFlow";
import { shortSplit, stuckOwner, workSplit, type StuckOwner, type StuckWorker } from "../model/workerStuck";
import { leadNameOf, StuckList, stuckTitle } from "./StuckWorkerCard";

/**
 * One brief to a coding team, as the briefing Mono's chat shows it: "Briefed EXO coding team: Fix the save bug · 2
 * working · 1 with EXO lead" (grey; red "needs you" only for what Ash must sort, r30b). Live (it reads the rows),
 * and one click opens the coding team on its Lead.
 */
export function BriefedTeamLine({ brief, onOpen }: { brief: BriefedTeam; onOpen?: (brief: BriefedTeam) => void }) {
  const { counts } = brief;
  const lead = brief.to?.leadName ?? "its Lead";
  const short = shortSplit(counts, lead);
  const team = brief.to?.team ?? "its coding team";
  const words = `Briefed ${team}: ${brief.title} · ${briefedStatus(brief)}`;
  return (
    <button
      type="button"
      data-briefed-team={brief.row.id}
      data-briefed-project={brief.to?.projectId}
      data-briefed-kind={short.needsYou ? "needs-you" : short.retrying ? "retrying" : short.withLead ? "with-lead" : counts.asking ? "asking" : "working"}
      disabled={!onOpen || !brief.to}
      title={[workSplit(counts, lead), brief.to ? `Open ${team} on ${brief.to.leadName}` : undefined].filter(Boolean).join("\n") || words}
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
              {/* r30b: never "stuck". A retry's or its Lead's in grey; red only for what Ash must sort. */}
              {(short.working || short.waiting) && short.retrying ? <span aria-hidden> · </span> : null}
              {short.retrying ? <span className="text-content/60" data-briefed-retrying>{short.retrying} retrying</span> : null}
              {(short.working || short.waiting || short.retrying) && short.withLead ? <span aria-hidden> · </span> : null}
              {short.withLead ? <span className="text-content/60" data-briefed-with-lead>{short.withLead} with {lead}</span> : null}
              {(short.working || short.waiting || short.retrying || short.withLead) && short.needsYou ? <span aria-hidden> · </span> : null}
              {short.needsYou ? <span className="text-red-400" data-briefed-needs-you>{short.needsYou} needs you</span> : null}
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
  modelHarness,
  model,
  modelValues,
  onModelChange,
  onModelSettingsChange,
}: {
  ownerName: string;
  /** Where its work stands: still running, asking its Lead, or finished. */
  state: "running" | "asking" | "finished";
  /** It is stuck (asking, stalled or failed): its card above the line, answerable here without jumping in. */
  stuck?: StuckWorker;
  now?: number;
  onOpenOwner?: () => void;
  onJumpIn: () => void;
  /** E7: which model this worker runs on, pickable here — the line where its chat says it runs on its own. */
  modelHarness?: HarnessId;
  model?: string;
  modelValues?: Record<string, string>;
  onModelChange?: (harness: HarnessId, model: string) => void;
  onModelSettingsChange?: (settings: Record<string, string>) => void;
}) {
  const showsModel = Boolean(modelHarness && model);
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
          <StuckList stuck={[stuck]} now={now} variant="chat" label="Its work" />
        </div>
      ) : null}
      <div
        data-delegated-chat
        className="glass-bar flex w-full items-center gap-2 rounded-2xl border border-content/10 px-4 py-3 font-sans text-[13px] text-content/60"
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
        {showsModel && modelHarness && model ? (
          <span data-delegated-model className="flex min-w-0 shrink-0 items-center">
            <MonoModelLine
              harness={modelHarness}
              model={model}
              values={modelValues ?? {}}
              allowedHarnesses={[modelHarness]}
              onChange={(harness, next) => onModelChange?.(harness, next)}
              onSettingsChange={(settings) => onModelSettingsChange?.(settings)}
            />
          </span>
        ) : null}
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
  crewLines = [],
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
  /** WP-15: one compact line per brief, from derive_status. */
  crewLines?: readonly { id: string; text: string }[];
}) {
  const [stopping, setStopping] = useState(false);
  if (count <= 0 && !failed.length && !unloaded.length && !stuck.length && !crewLines.length)
    return null;
  // Stalled and failed workers are named by whose they are (r30b, the red rule): a retry's ("1 retrying: Tests"), its
  // Lead's ("2 with Hivra lead: API, UI"), or Ash's only when its provider refused it ("1 needs you: Docs", red). Never
  // "stuck"; their cards above say how.
  const stopped = stuck.filter((s) => s.kind !== "asking");
  const lead = stopped.length ? leadNameOf(stopped[0]) : "its Lead";
  const ownedBy = (owner: StuckOwner) => stopped.filter((s) => stuckOwner(s) === owner).map((s) => stuckTitle(s));
  const retrying = ownedBy("retrying");
  const withLead = ownedBy("with-lead");
  const needsYou = ownedBy("needs-you");
  const stuckNames = stopped.map((s) => stuckTitle(s));
  const named = [
    workingLine({ working, asking }),
    retrying.length ? `${retrying.length} retrying: ${names(retrying)}` : undefined,
    withLead.length ? `${withLead.length} with ${lead}: ${names(withLead)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  // The card above already says Needs you. The red footer would say it again.
  const cardOnScreen = stuck.some((worker) => worker.kind !== "asking" && stuckOwner(worker) === "needs-you");
  const needsYouPart = needsYou.length && !cardOnScreen ? `${needsYou.length} needs you: ${names(needsYou)}` : undefined;
  // Briefs have their own lines: "Waiting on N" counts only the rest.
  const others = count - briefs.length;
  const line = named || (needsYouPart ? "" : others > 0 ? `Waiting on ${others}` : undefined);
  return (
    <>
      <StuckList stuck={stuck} now={now} variant="chat" label="Workers its Lead has out" />
      {briefs.length ? (
        <div data-briefed-teams className="flex flex-col gap-1.5 pb-1.5">
          {briefs.map((brief) => (
            <BriefedTeamLine key={brief.row.id} brief={brief} onOpen={onOpenBrief} />
          ))}
        </div>
      ) : null}
      <CrewBriefLines lines={crewLines} />
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
        {needsYouPart ? (
          <span data-delegation-needs-you className="min-w-0 truncate text-red-400" title={needsYou.join(", ")}>
            {line ? <span aria-hidden className="text-content/55">· </span> : null}
            {needsYouPart}
          </span>
        ) : null}
        {failed.length ? (
          <span
            className="min-w-0 truncate text-content/60"
            title={failed.join(", ")}
          >
            Couldn&apos;t stop{" "}
            {failed.length === 1 ? failed[0] : `${failed.length} chats`}
          </span>
        ) : null}
        {unloaded.length ? (
          <span
            data-delegation-unloaded
            className="min-w-0 truncate text-content/60"
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
