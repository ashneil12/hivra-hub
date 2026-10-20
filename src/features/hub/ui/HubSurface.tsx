import { Fragment, useEffect, useRef, useState } from "react";
import { pickExportForRestore, readImportText, setPendingImport } from "../../portable/model/portable";
import { allConnectors, openConnectorSettings, signIn, useConnectorsVersion } from "../model/connectors";
import { RestorePreview } from "./RestorePreview";
import { Check, Clock, Inbox, MessageMultiple as MessagesSquare, Play as PackageOpen, Wrench as Hammer, type IconComponent } from "../../../shared/ui/icons";
import { IS_MAC } from "../../../platform/tauri/platform";
import { examplesOn } from "../model/examples";
import { calmSummary, dismissDoneNeeds, hubData, sinceLabel, useHubDataVersion } from "../model/hubData";
import { laterItems, setupItems, waitingOnAsh, type WaitingItem } from "../model/waiting";
import { setHubSelection } from "../model/hubNav";
import type { HubSelection } from "../model/hubNav";
import { TODAY_DEFAULT, type HubJob, type Need, type TodaySection } from "../model/types";
import { findPage, requestOpenPage, usePagesVersion } from "../../pages/model/pages";
import { PageBody } from "../../pages/ui/PagesView";
import { ChangeRow } from "../../hubChange/ui/HubChangeView";
import { GroupChatView, NewGroupChat } from "./GroupChatView";
import { CircleWord, StatusMark, needMark } from "./StatusMark";
import { OptionsSheet } from "./OptionsSheet";
import { DetailSheet, QuestionSheet } from "./QuestionSheet";
import { WaitingOnYou } from "./WaitingOnYou";
import { OlderQuestions } from "./OlderQuestions";
import { useWaitingChatsVersion, waitingChats } from "../model/waitingChats";
import { BuildsView } from "./BuildsView";
import { BeingBuiltView } from "./BeingBuiltView";
import { ProposalView } from "./ProposalView";
import { NewProjectView } from "./NewProjectView";
import { useTemplatesVersion } from "../model/templates";
import { leadershipChatId, useHubChatsVersion } from "../model/hubChats";
import { useProposalsVersion } from "../model/proposals";
import { useHubBuildsVersion } from "../model/hubBuilds";
import { markShipSeen, restartForUpdate, shipCardView, useShipStatus } from "../../../app/model/ship";
import { revealPath } from "../../../platform/tauri/fs";


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
      <div className="min-h-0 flex-1 overflow-y-auto">
        {project ? null : <ShipNotice />}
        {body}
      </div>
    </div>
  );
}

function TodayBody({ projectId }: { projectId: string | undefined }) {
  useWaitingChatsVersion();
  const [sheet, setSheet] = useState<SheetFor | null>(null);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(25);
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
  // Two groups once chats are waiting: "Waiting on you" (agents' questions) above "Needs you" (gates and failures).
  const chatsWaiting = waitingChats(projectId).length > 0;
  const needsShown = projects.some((p) => waiting.some((w) => w.projectId === p.id) || laterItems(p.id).length);
  // Today's sections are Ash OS's board (`ash-hub-layout`): a seated Mono can add a kept page, move, rename or take
  // off a section through Edit Today, and Apply / Undo moves it here. A project's Inbox keeps its own fixed order.
  const sections: readonly TodaySection[] = projectId ? TODAY_DEFAULT.filter((s) => s.kind !== "being-built") : data.todayLayout?.() ?? TODAY_DEFAULT;
  const sinceBlock = (s: TodaySection) => (
    <section key={s.id} data-hub-today-section={s.kind}>
      {sinceAt ? <h2 className="mb-2 text-xs text-content/60">{s.title === "Since you were away" ? sinceLabel(sinceAt) : `${s.title} · ${sinceLabel(sinceAt).toLowerCase()}`}</h2> : s.title !== "Since you were away" ? <h2 className="mb-2 text-xs text-content/60">{s.title}</h2> : null}
      {since.pending ? (
        // Ash OS is still writing it: a quiet line, and the paragraph swaps in here when it is ready.
        <p className="text-[13px] leading-5 text-content/60" data-hub-since-pending>Writing up what changed…</p>
      ) : (
        <p className="line-clamp-4 text-[13px] leading-5 text-content/85" data-hub-since>{calmSummary(since.plainText)}</p>
      )}
    </section>
  );
  const setupBlock = (s: TodaySection) =>
    !projectId && setupItems().length ? (
      <section key={s.id} data-hub-setup data-hub-today-section={s.kind}>
        <h2 className="mb-1 text-xs text-content/60">{s.title}</h2>
        <p className="px-2 pb-1 text-[13px] text-content/60">Passwords and keys never travel in the setup file.</p>
        <div className="flex flex-col">
          {setupItems().map((w) => (
            <StuckRow key={w.id} item={w} />
          ))}
        </div>
      </section>
    ) : null;
  const needsBlock = (s: TodaySection) => (
    <div key={s.id} className="flex flex-col gap-6" data-hub-today-section={s.kind}>
      {s.title !== "Needs you" || (chatsWaiting && needsShown) ? <h2 className="-mb-4 text-xs text-content/60" data-hub-needs-heading>{s.title}</h2> : null}
      <label className="flex flex-col gap-1 text-[12px] text-content/60">
        Find an ask, including Later and Older
        <input type="search" aria-label="Search asks" value={query} onChange={(e) => { setQuery(e.target.value); setShown(25); }} placeholder="Search by words or project…" className="rounded-md border border-stroke bg-content/3 px-3 py-2 text-[13px] text-content outline-none focus:border-content/30" />
      </label>
      {query.trim() ? <section data-hub-search-results className="flex flex-col">
        {(() => {
          const needle = query.trim().toLowerCase();
          const matches = [...data.listNeeds(projectId), ...(data.listOlder?.(projectId) ?? [])].filter((n) =>
            `${n.title} ${n.why} ${n.detail ?? ""} ${projects.find((p) => p.id === n.projectId)?.name ?? ""}`.toLowerCase().includes(needle));
          return <><p className="mb-2 text-xs text-content/50">{matches.length} matching asks</p>
            {matches.slice(0, shown).map((n) => <NeedRow key={n.id} need={n} onSheet={setSheet} />)}
            {matches.length > shown ? <button type="button" onClick={() => setShown((n) => n + 25)} className="mt-2 self-start rounded-md bg-content/5 px-3 py-1.5 text-[12px] text-content/70">Show 25 more</button> : null}</>;
        })()}
      </section> : projects.map((p) => {
        const pStuck = waiting.filter((w) => w.projectId === p.id && w.state);
        const pNeeds = waiting.flatMap((w) => (w.projectId === p.id && w.need ? [w.need] : []));
        const pOther = waiting.filter((w) => w.projectId === p.id && !w.state && !w.need);
        if (!pNeeds.length && !pStuck.length && !pOther.length && !laterItems(p.id).length) return null;
        return (
          <section key={p.id}>
            {projectId ? null : <h2 className="mb-1 text-xs text-content/60">{p.name}</h2>}
            <div className="flex flex-col">
              {pStuck.map((st) => (
                <StuckRow key={st.id} item={st} />
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
    </div>
  );
  const block = (s: TodaySection) =>
    s.kind === "since" ? sinceBlock(s)
    : s.kind === "setup" ? setupBlock(s)
    // Waiting on you sits right above Needs you, wherever the board puts it.
    : s.kind === "needs" ? <Fragment key={s.id}><WaitingOnYou projectId={projectId} />{needsBlock(s)}</Fragment>
    : s.kind === "being-built" ? <BeingBuiltToday key={s.id} title={s.title} />
    : s.kind === "page" && s.pageId ? <TodayPage key={s.id} title={s.title} pageId={s.pageId} />
    : null;
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-8 py-8">
      {!projectId ? <HomeTools /> : null}
      {!projectId ? <section aria-label="Projects" className="grid gap-2 sm:grid-cols-2" data-hub-home-projects>
        {projects.map((p) => <div key={p.id} className="rounded-lg border border-stroke px-3 py-2.5">
          <button type="button" onClick={() => setHubSelection({ project: p.id, item: "inbox" })} className="text-[14px] font-medium text-content hover:underline">{p.name}</button>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-content/60">
            <button type="button" onClick={() => setHubSelection({ project: p.id, item: "inbox" })} className="hover:text-content">{data.listNeeds(p.id).filter((n) => n.state !== "done").length} {data.listNeeds(p.id).filter((n) => n.state !== "done").length === 1 ? "need" : "needs"}</button>
            <button type="button" onClick={() => setHubSelection({ project: p.id, item: "leadership-team" })} className="hover:text-content">Leadership</button>
            <button type="button" onClick={() => setHubSelection({ project: p.id, item: "being-built" })} className="hover:text-content">Being built</button>
          </div>
        </div>)}
      </section> : null}
      {/* The board took Needs you off Today: the chats waiting on Ash still lead it. */}
      {sections.some((s) => s.kind === "needs") ? null : <WaitingOnYou projectId={projectId} />}
      {sections.map(block)}
      {!query.trim() ? <OlderQuestions projectId={projectId} renderRow={(n) => <NeedRow key={n.id} need={n} onSheet={setSheet} />} /> : null}
      {!projectId ? <LastChange /> : null}
      {sheet?.kind === "job" ? <OptionsSheet jobId={sheet.jobId} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === "question" ? <QuestionSheet needId={sheet.needId} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === "detail" ? <DetailSheet need={sheet.need} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}

const ACTIVE_JOBS: ReadonlySet<HubJob["state"]> = new Set(["working", "checking", "stuck", "sent_to_lead", "lead_gave_up"]);
const JOB_WORD: Partial<Record<HubJob["state"], string>> = { working: "Working", checking: "Checking", stuck: "Stuck", sent_to_lead: "With the lead", lead_gave_up: "Stuck" };

/** Being built on Today: what the Leads are working on across the projects, one quiet line each. Hidden when idle. */
function BeingBuiltToday({ title }: { title: string }) {
  const data = hubData();
  const rows = data.listProjects().flatMap((p) =>
    (data.listJobs?.(p.id) ?? []).flatMap((g) => g.jobs.filter((j) => ACTIVE_JOBS.has(j.state) && !j.parentId).map((j) => ({ p, j, lead: g.leadName }))),
  );
  if (!rows.length) return null;
  return (
    <section data-hub-today-section="being-built" data-hub-today-being-built>
      <h2 className="mb-1 text-xs text-content/60">{title}</h2>
      <div className="flex flex-col">
        {rows.slice(0, 8).map(({ p, j, lead }) => (
          <button key={j.id} type="button" onClick={() => setHubSelection({ project: p.id, item: "being-built" })}
            className="flex items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-content/5" data-hub-today-job={j.id}>
            <span className="min-w-0 flex-1 truncate text-[13px] text-content">{j.title}</span>
            <span className="shrink-0 text-xs text-content/60">{p.name} · {lead} · {JOB_WORD[j.state]}</span>
          </button>
        ))}
        {rows.length > 8 ? <span className="px-2 pt-1 text-xs text-content/60">{rows.length - 8} more in the projects' Being built</span> : null}
      </div>
    </section>
  );
}

/** A kept page placed on Today by an applied Edit Today change. Gone from the board if the page was taken away. */
function TodayPage({ title, pageId }: { title: string; pageId: string }) {
  usePagesVersion();
  const page = findPage(pageId);
  if (!page || page.removed || !page.keptAt) return null;
  return (
    <section data-hub-today-section="page" data-hub-today-page={pageId}>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-xs text-content/60">{title}</h2>
        <button type="button" className="rounded-md px-2 py-0.5 text-xs text-content/60 hover:bg-content/5 hover:text-content"
          onClick={() => { requestOpenPage(pageId); window.dispatchEvent(new CustomEvent("monocode:home-open", { detail: "pages" })); }}>
          Open in Pages
        </button>
      </div>
      <PageBody page={page} live />
    </section>
  );
}

/** The last change to Today or the hub (within a day), with Undo or Redo right here. */
function LastChange() {
  const data = hubData();
  const last = (data.listChanges?.() ?? []).find((c) => (c.flow === "today" || c.flow === "hub") && (c.state === "applied" || c.state === "undone"));
  const at = last?.undoneAt ?? last?.appliedAt;
  if (!last || !at || Date.now() - Date.parse(at) > 86_400_000) return null;
  return (
    <section data-hub-today-last-change className="-mt-2 opacity-90">
      <ChangeRow change={last} compact />
    </section>
  );
}

/** Under a project's Needs: the ones past the five, collapsed to one quiet line until opened. */
/** Which sheet a Need's one button opens. */
type SheetFor = { kind: "job"; jobId: string } | { kind: "question"; needId: string } | { kind: "detail"; need: Need };

function LaterList({ projectId, onSheet }: { projectId: string; onSheet: (sheet: SheetFor) => void }) {
  const [open, setOpen] = useState(false);
  const later = laterItems(projectId);
  if (!later.length) return null;
  // Shut: one tappable line. Open: a quiet "Later" heading in line with the rows, the rows a little dimmer, and
  // "Hide Later" in line with them underneath.
  const toggle = (label: string) => (
    <button type="button" aria-expanded={open} data-hub-later-toggle onClick={() => setOpen((v) => !v)} className="mt-1 self-start cursor-pointer rounded-md px-2 py-1 text-xs text-content/80 underline decoration-content/40 underline-offset-2 hover:bg-content/5 hover:text-content">
      {label}
    </button>
  );
  if (!open) return <div className="flex flex-col" data-hub-later>{toggle(`${later.length} more under Later`)}</div>;
  return (
    <div className="flex flex-col" data-hub-later data-hub-later-open>
      <h3 className="mt-3 px-2 pb-1 text-xs font-normal text-content/60" data-hub-later-heading>Later</h3>
      <div className="flex flex-col opacity-75" data-hub-later-rows>
        {later.map((w) => (w.need ? <NeedRow key={w.id} need={w.need} onSheet={onSheet} /> : <StuckRow key={w.id} item={w} />))}
      </div>
      {toggle("Hide Later")}
    </div>
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
  const mark = needMark(need);
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
        {/* The reason wraps (never cut mid-word). */}
        <div className="whitespace-normal break-words text-[13px] leading-5 text-content/60" data-hub-need-why>{need.why}</div>
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
          {mark ? <CircleWord circle={mark.circle} word={mark.word} /> : null}
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
        {item.detail ? <div className="whitespace-normal break-words text-[13px] leading-5 text-content/60" data-hub-stuck-reason>{item.detail}</div> : null}
        {item.note ? <div className="whitespace-normal break-words text-[13px] leading-5 text-content/60" data-hub-sent>{item.note}</div> : null}
      </div>
      {item.state ? <StatusMark state={item.state} /> : null}
      {item.signIn === "waiting" ? (
        <span className="shrink-0 text-xs text-content/60" data-hub-signin-state="waiting" role="status">Waiting for your Mac…</span>
      ) : item.signIn === "on-this-mac" ? (
        <span className="shrink-0 text-xs text-content/60" data-hub-signin-state="on-this-mac" role="status">On this Mac</span>
      ) : item.target || item.connectorId || item.act ? (
        <button
          type="button"
          data-hub-take-look={item.id}
          onClick={() => {
            if (item.act) return item.act();
            if (!item.connectorId) return item.target && setHubSelection(item.target);
            // A connector the catalog has signs in on Settings > Connectors; any other keeps the setup file's flow.
            const name = allConnectors().find((c) => c.id === item.connectorId)?.name ?? "";
            if (!openConnectorSettings(name)) void signIn(item.connectorId);
          }}
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
  const heading = "The harness service is unavailable.";
  const help = message && message !== heading && !message.includes("Ash OS") ? message : "Start it, then try again. Your projects and Needs come back on their own.";
  return (
    <div className="grid h-full place-items-center px-8" data-hub-down>
      <div className="flex max-w-[420px] flex-col items-center gap-3 text-center">
        <p className="text-[13px] text-content">{heading}</p>
        <p className="text-[13px] leading-5 text-content/60">{help}</p>
        <HomeTools />
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
/**
 * Ship on Today (src-tauri/src/ship.rs): the new build's trial, an update waiting for a quiet moment (with Restart now),
 * or the last ship's receipt until it's read. Plain words, no badge.
 */
function ShipNotice() {
  const view = shipCardView(useShipStatus());
  const [busy, setBusy] = useState(false);
  if (!view) return null;
  const act = (run: () => Promise<void>) => {
    setBusy(true);
    void run()
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  return (
    <div className="mx-auto max-w-[720px] px-8 pt-8" data-hub-ship={view.id}>
      <section aria-label="Update" className="rounded-lg border border-stroke px-3 py-2.5 hub-fade-in">
        <p className="text-[13px] leading-5 text-content">{view.text}</p>
        {view.detail ? <p className="mt-0.5 text-[12px] leading-5 text-content/60">{view.detail}</p> : null}
        {view.restartNow || view.log || view.dismiss ? (
          <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
            {view.restartNow ? (
              <button type="button" disabled={busy} onClick={() => act(restartForUpdate)} className="rounded-md bg-content/8 px-2.5 py-1 text-content hover:bg-content/12 disabled:opacity-50">
                Restart now
              </button>
            ) : null}
            {view.log ? (
              <button type="button" onClick={() => act(() => revealPath(view.log!))} className="rounded-md px-2.5 py-1 text-content/70 hover:bg-content/5 hover:text-content">
                Show the log
              </button>
            ) : null}
            {view.dismiss ? (
              <button type="button" disabled={busy} onClick={() => act(() => markShipSeen(view.id))} className="rounded-md px-2.5 py-1 text-content/70 hover:bg-content/5 hover:text-content">
                Done
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function FirstTodayEmpty() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      setPendingImport(readImportText(f.name, await f.text()));
      setHubSelection({ project: "today", item: "restore" });
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't read that file.");
    }
  };
  const pick = async () => {
    try {
      const p = await pickExportForRestore();
      if (p === "browser") return fileRef.current?.click();
      if (!p) return;
      setPendingImport(p);
      setHubSelection({ project: "today", item: "restore" });
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't read that export.");
    }
  };
  return (
    <div className="grid h-full place-items-center px-8" data-hub-today-empty>
      <div className="flex max-w-[420px] flex-col items-center gap-3 text-center">
        <p className="text-[13px] text-content" data-hub-today-empty-line>No projects yet. Start one and Today fills up with what's waiting on you.</p>
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
            onClick={() => void pick()}
            className="rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content"
          >
            Restore from an export
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" data-hub-today-file
            onChange={(e) => void onFile(e.target.files?.[0])} />
        </div>
        {note ? <p className="text-[13px] text-content/60">{note}</p> : null}
      </div>
    </div>
  );
}

/** Local views remain accessible even while the shared service is unavailable. */
function HomeTools() {
  return <nav aria-label="Workspace shortcuts" className="flex flex-wrap gap-2" data-hub-home-tools>
    {(["Pages", "Notes", "Automations"] as const).map((name) => <button key={name} type="button" onClick={() => window.dispatchEvent(new CustomEvent("monocode:home-open", { detail: name.toLowerCase() }))}
      className="rounded-md bg-content/5 px-3 py-1.5 text-[12px] text-content/75 hover:bg-content/10">{name}</button>)}
  </nav>;
}
