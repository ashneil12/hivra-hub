import { useEffect, useRef, useState } from "react";
import { parseSetup, setPendingSetup } from "../model/setupFile";
import { signIn, useConnectorsVersion } from "../model/connectors";
import { RestorePreview } from "./RestorePreview";
import { Check, Clock, Inbox, MessageMultiple as MessagesSquare, Play as PackageOpen, Wrench as Hammer, type IconComponent } from "../../../shared/ui/icons";
import { IS_MAC } from "../../../platform/tauri/platform";
import { examplesOn } from "../model/examples";
import { calmSummary, dismissDoneNeeds, hubData, sinceLabel, useHubDataVersion } from "../model/hubData";
import { laterItems, setupItems, waitingOnAsh, type WaitingItem } from "../model/waiting";
import { setHubSelection } from "../model/hubNav";
import type { HubSelection } from "../model/hubNav";
import type { Need } from "../model/types";
import { GroupChatView, NewGroupChat } from "./GroupChatView";
import { CircleWord, StatusMark } from "./StatusMark";
import { OptionsSheet } from "./OptionsSheet";
import { DetailSheet, QuestionSheet } from "./QuestionSheet";
import { BuildsView } from "./BuildsView";
import { BeingBuiltView } from "./BeingBuiltView";
import { ProposalView } from "./ProposalView";
import { NewProjectView } from "./NewProjectView";
import { useTemplatesVersion } from "../model/templates";
import { leadershipChatId, useHubChatsVersion } from "../model/hubChats";
import { useProposalsVersion } from "../model/proposals";
import { useHubBuildsVersion } from "../model/hubBuilds";


/**
 * Main area for the hub views. Unit 1 ships the shell: the title row matches
 * Monocode's own views (no breadcrumbs), the bodies are filled in later units.
 */
export function HubSurface({ selection }: { selection: HubSelection }) {
  useHubDataVersion();
  // Needs that ticked themselves off while Ash was looking go away once he leaves the page.
  useEffect(() => dismissDoneNeeds, [selection.project, selection.item]);
  useHubChatsVersion();
  useProposalsVersion();
  useTemplatesVersion();
  useConnectorsVersion();
  useHubBuildsVersion();
  if (selection.item === "new-project") return <NewProjectView />;
  if (selection.item === "restore") return <RestorePreview />;
  const data = hubData();
  if (selection.project !== "today") {
    if (selection.item === "leadership-team")
      return <GroupChatView key={selection.project} chatId={leadershipChatId(selection.project)} projectId={selection.project} />;
    if (selection.item.startsWith("chat:"))
      return <GroupChatView key={selection.item} chatId={selection.item.slice(5)} projectId={selection.project} />;
    if (selection.item === "new-chat") return <NewGroupChat projectId={selection.project} />;
    if (selection.item.startsWith("proposal:"))
      return <ProposalView key={selection.item} id={selection.item.slice(9)} />;
    if (selection.item === "being-built") return <BeingBuiltView key={selection.project} projectId={selection.project} />;
    const section = data.listProjectItems(selection.project).find((i) => i.id === selection.item);
    if (section?.sectionType === "builds-playtests")
      return <BuildsView key={selection.project} projectId={selection.project} title={section.title} />;
  }
  const project = data.listProjects().find((p) => p.id === selection.project);
  const item = project ? data.listProjectItems(project.id).find((i) => i.id === selection.item) : undefined;

  let Icon: IconComponent = Clock;
  let title = "Today";
  let body = <TodayBody projectId={undefined} />;
  if (project) {
    if (!item) {
      Icon = Inbox;
      title = "Inbox";
      body = <TodayBody projectId={project.id} />;
    } else {
      title = item.title;
      Icon = item.kind === "leadership-team" || item.kind === "group-chat" ? MessagesSquare : item.kind === "being-built" ? Hammer : PackageOpen;
      body = <Pending what={item.title} unit={item.kind === "leadership-team" ? 4 : item.kind === "being-built" ? 6 : 5} />;
    }
  }

  return (
    <div role="region" aria-label={title} data-hub-surface className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-stroke" data-tauri-drag-region="deep">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <Icon className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
          <span className="min-w-0 truncate text-content">{title}</span>
        </div>
        {IS_MAC ? null : <div className="w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
}

function TodayBody({ projectId }: { projectId: string | undefined }) {
  const [sheet, setSheet] = useState<SheetFor | null>(null);
  const data = hubData();
  const connection = data.connection();
  if (connection.status === "unreachable") return <AshOsDown message={connection.message} retrying={connection.retrying} onRetry={() => data.retry()} />;
  // Reading Ash OS for the first time: say nothing rather than flash "No projects yet".
  if (connection.status === "loading" && !data.listProjects().length) return <div data-hub-loading />;
  if (!data.listProjects().length) return <FirstTodayEmpty />;
  const since = data.sinceSummary(projectId);
  const sinceAt = data.sinceAt();
  const waiting = waitingOnAsh(projectId);
  const projects = data.listProjects().filter((p) => !projectId || p.id === projectId);
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-8 py-8">
      <section>
        {sinceAt ? <h2 className="mb-2 text-xs text-content/60">{sinceLabel(sinceAt)}</h2> : null}
        {since.pending ? (
          // Ash OS is still writing it: a quiet line, and the paragraph swaps in here when it is ready.
          <p className="text-[13px] leading-5 text-content/60" data-hub-since-pending>Writing up what changed…</p>
        ) : (
          <p className="line-clamp-4 text-[13px] leading-5 text-content/85" data-hub-since>{calmSummary(since.plainText)}</p>
        )}
      </section>
      {!projectId && setupItems().length ? (
        <section data-hub-setup>
          <h2 className="mb-1 text-xs text-content/60">Setup</h2>
          <p className="px-2 pb-1 text-[13px] text-content/60">Passwords and keys never travel in the setup file.</p>
          <div className="flex flex-col">
            {setupItems().map((w) => (
              <StuckRow key={w.id} item={w} />
            ))}
          </div>
        </section>
      ) : null}
      {projects.map((p) => {
        const pStuck = waiting.filter((w) => w.projectId === p.id && w.state);
        const pNeeds = waiting.flatMap((w) => (w.projectId === p.id && w.need ? [w.need] : []));
        const pOther = waiting.filter((w) => w.projectId === p.id && !w.state && !w.need);
        if (!pNeeds.length && !pStuck.length && !pOther.length) return null;
        return (
          <section key={p.id}>
            {projectId ? null : <h2 className="mb-1 text-xs text-content/60">{p.name}</h2>}
            <div className="flex flex-col">
              {pStuck.map((s) => (
                <StuckRow key={s.id} item={s} />
              ))}
              {pNeeds.map((n) => (
                <NeedRow key={n.id} need={n} onSheet={setSheet} />
              ))}
              {pOther.map((w) => (
                <StuckRow key={w.id} item={w} />
              ))}
              <LaterList projectId={p.id} onSheet={setSheet} />
            </div>
          </section>
        );
      })}
      <OlderGroup projectId={projectId} onSheet={setSheet} />
      {sheet?.kind === "job" ? <OptionsSheet jobId={sheet.jobId} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === "question" ? <QuestionSheet needId={sheet.needId} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === "detail" ? <DetailSheet need={sheet.need} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}

/** Under a project's Needs: the ones past the five, collapsed to one quiet line until opened. */
/** Which sheet a Need's one button opens. */
type SheetFor = { kind: "job"; jobId: string } | { kind: "question"; needId: string } | { kind: "detail"; need: Need };

function LaterList({ projectId, onSheet }: { projectId: string; onSheet: (sheet: SheetFor) => void }) {
  const [open, setOpen] = useState(false);
  const later = laterItems(projectId);
  if (!later.length) return null;
  return (
    <div className="flex flex-col" data-hub-later>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="self-start rounded-md px-2 pt-1 text-xs text-content/60 hover:text-content">
        {open ? "Hide Later" : `${later.length} more under Later`}
      </button>
      {open ? later.map((w) => (w.need ? <NeedRow key={w.id} need={w.need} onSheet={onSheet} /> : <StuckRow key={w.id} item={w} />)) : null}
    </div>
  );
}

/**
 * Older questions (recovered from past chats and the like). They are not Needs: in no badge and no count, and shut
 * until Ash opens them. On Today they sit once at the bottom, under their project's name; in a project, its own.
 */
function OlderGroup({ projectId, onSheet }: { projectId: string | undefined; onSheet: (sheet: SheetFor) => void }) {
  const [open, setOpen] = useState(false);
  const data = hubData();
  const older = data.listOlder(projectId);
  if (!older.length) return null;
  const names = new Map(data.listProjects().map((p) => [p.id, p.name]));
  const groups = [...new Set(older.map((n) => n.projectId))];
  return (
    <section data-hub-older>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="rounded-md px-2 text-xs text-content/60 hover:text-content">
        Older ({older.length})
      </button>
      {open ? (
        <div className="mt-1 flex flex-col">
          {groups.map((pid) => (
            <div key={pid} className="flex flex-col">
              {projectId ? null : <h2 className="mb-1 mt-2 px-2 text-xs text-content/60">{names.get(pid) ?? pid}</h2>}
              {older.filter((n) => n.projectId === pid).map((n) => (
                <NeedRow key={n.id} need={n} onSheet={onSheet} />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function NeedRow({ need, onSheet }: { need: Need; onSheet?: (sheet: SheetFor) => void }) {
  const done = need.state === "done";
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const data = hubData();
  // One action per row, as Ash OS names it: Looks right accepts; See options opens the job's or the question's
  // sheet; an older Looks-right row (action "open") is marked seen; Open and Start show the row in full.
  const accept = need.actionType === "accept" && !!data.acceptNeed;
  const seen = need.canMarkSeen && need.actionType !== "accept" && !!data.markNeedSeen;
  const isQuestion = !!need.actionTarget?.startsWith("question:");
  const answering = data.answerState?.(need.id);
  const run = async (call: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await call();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That didn't go through.");
      setBusy(false);
    }
  };
  const onAction = async () => {
    if (need.jobId && data.jobOptions) return onSheet?.({ kind: "job", jobId: need.jobId });
    if (accept) return run(() => data.acceptNeed!(need.id));
    if (seen) return run(() => data.markNeedSeen!(need.id));
    if (isQuestion && data.question) return onSheet?.({ kind: "question", needId: need.id });
    if (need.actionType === "open" || need.actionType === "start") return onSheet?.({ kind: "detail", need });
  };
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-content/5" data-hub-need={need.id} data-hub-need-done={done || undefined}>
      <div className="min-w-0 flex-1">
        <div className={`truncate text-[13px] ${done ? "text-content/60" : "text-content"}`}>{need.title}</div>
        <div className="truncate text-[13px] text-content/60">{need.why}</div>
        {problem ? <div className="text-[13px] text-content/60" data-hub-need-problem>{problem}</div> : null}
        {answering && !answering.sending && (answering.receipt || answering.problem) ? (
          <div className="text-[13px] leading-5 text-content/85" data-hub-answer-receipt>{answering.receipt ?? answering.problem}</div>
        ) : null}
      </div>
      {done ? (
        // It ticked itself off (answered or cleared somewhere else). It stays here until Ash leaves the page.
        <span className="grid size-6 shrink-0 place-items-center text-content/60" role="img" aria-label="Done">
          <Check className="size-3.5" strokeWidth={1.75} />
        </span>
      ) : answering?.sending ? (
        // His answer is on its way (the model can take a minute); nothing else waits for it.
        <span className="shrink-0 text-xs text-content/60" data-hub-sending>Sending…</span>
      ) : (
        <>
          {need.circle && need.word ? <CircleWord circle={need.circle} word={need.word} /> : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void onAction()}
            className="shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-60"
          >
            {seen ? "Seen" : need.actionLabel}
          </button>
        </>
      )}
    </div>
  );
}

/** The only rows that carry a status: a 14px circle and a plain word. */
function StuckRow({ item }: { item: WaitingItem }) {
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-content/5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-content">{item.title}</div>
        {item.detail ? <div className="line-clamp-2 text-[13px] text-content/60">{item.detail}</div> : null}
        {item.note ? <div className="truncate text-[13px] text-content/60" data-hub-sent>{item.note}</div> : null}
      </div>
      {item.state ? <StatusMark state={item.state} /> : null}
      {item.target || item.connectorId ? (
        <button
          type="button"
          data-hub-take-look={item.id}
          onClick={() => (item.connectorId ? signIn(item.connectorId) : item.target && setHubSelection(item.target))}
          className="shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12"
        >
          {item.actionLabel ?? "Take a look"}
        </button>
      ) : null}
    </div>
  );
}

function Pending({ what, unit }: { what: string; unit: number }) {
  // Ships clean: a placeholder is never reachable without the examples flag (the sections that led here are hidden).
  if (!examplesOn()) return null;
  return (
    <div className="grid h-full place-items-center px-8 text-center">
      <p className="text-[13px] text-content/60">
        {what} is built in Unit {unit}. Unit 1 is the app shell.
      </p>
    </div>
  );
}

/** Ash OS can't be reached: one calm sentence and one button. Never example data. */
function AshOsDown({ message, retrying, onRetry }: { message?: string; retrying?: boolean; onRetry: () => void }) {
  const heading = "Ash OS isn't running.";
  const help = message && message !== heading ? message : "Start it, then try again. Your projects and Needs come back on their own.";
  return (
    <div className="grid h-full place-items-center px-8" data-hub-down>
      <div className="flex max-w-[420px] flex-col items-center gap-3 text-center">
        <p className="text-[13px] text-content">{heading}</p>
        <p className="text-[13px] leading-5 text-content/60">{help}</p>
        <button
          type="button"
          data-hub-down-retry
          disabled={retrying}
          onClick={onRetry}
          className="rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-60"
        >
          {retrying ? "Trying…" : "Try again"}
        </button>
      </div>
    </div>
  );
}

/** Clean first launch: no projects yet. One calm action. */
function FirstTodayEmpty() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      setPendingSetup(parseSetup(await f.text()), f.name);
      setHubSelection({ project: "today", item: "restore" });
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't read that file.");
    }
  };
  return (
    <div className="grid h-full place-items-center px-8" data-hub-today-empty>
      <div className="flex max-w-[420px] flex-col items-center gap-3 text-center">
        <p className="text-[13px] text-content">No projects yet.</p>
        <p className="text-[13px] leading-5 text-content/60">
          Make your first project, or bring yours back from a setup file. Then Today fills up with what changed and what's waiting on you.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-hub-today-new-project
            onClick={() => setHubSelection({ project: "today", item: "new-project" })}
            className="rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90"
          >
            New project
          </button>
          <button
            type="button"
            data-hub-today-restore
            onClick={() => fileRef.current?.click()}
            className="rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content"
          >
            Restore a setup file
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" data-hub-today-file
            onChange={(e) => void onFile(e.target.files?.[0])} />
        </div>
        {note ? <p className="text-[13px] text-content/60">{note}</p> : null}
      </div>
    </div>
  );
}
