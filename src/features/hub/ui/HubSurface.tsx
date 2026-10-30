import { Fragment, useEffect, useRef, useState } from "react";
import { askNeedsAsh, askReason } from "../model/askNeeds";
import { stuckWhere } from "../model/stuckWhere";
import { pickExportForRestore, readImportText, setPendingImport } from "../../portable/model/portable";
import { allConnectors, openConnectorSettings, signIn, useConnectorsVersion } from "../model/connectors";
import { RestorePreview } from "./RestorePreview";
import { Check, FolderOpen, Inbox, StickyNote, MessageMultiple as MessagesSquare, Play as PackageOpen, Wrench as Hammer, type IconComponent } from "../../../shared/ui/icons";
import { IS_MAC } from "../../../platform/tauri/platform";
import { examplesOn } from "../model/examples";
import { calmSummary, dismissDoneNeeds, hubData, sinceHeading, sinceLabel, useHubDataVersion } from "../model/hubData";
import { laterItems, setupItems, waitingOnAsh, type WaitingItem } from "../model/waiting";
import { appItemInView, openMonoChat, setHubSelection, showAppItem } from "../model/hubNav";
import type { HubSelection } from "../model/hubNav";
import type { HubJob, Need, TodaySection } from "../model/types";
import { findPage, keptPages, requestOpenPage, usePagesVersion } from "../../pages/model/pages";
import { PageBody } from "../../pages/ui/PagesView";
import { ChangeRow } from "../../hubChange/ui/HubChangeView";
import { GroupChatView, NewGroupChat } from "./GroupChatView";
import { ChipMark, CircleWord, NeedsYouLinkLine, StatusMark, needMark, redRowProps } from "./StatusMark";
import { failureChip, stuckChip, type Chip } from "../model/statusChip";
import { OptionsSheet } from "./OptionsSheet";
import { DetailSheet, QuestionSheet } from "./QuestionSheet";
import { WaitingOnYou } from "./WaitingOnYou";
import { StuckToday } from "./StuckToday";
import { stuckWorkerChip } from "../../monos/model/stuckChip";
import { failedMonosFor, stuckProject } from "../model/todayCounts";
import { monoFailure, useMonoFailuresVersion } from "../../monos/model/monoFailures";
import { useStuckWorkers } from "../../monos/hooks/useStuckWorkers";
import { jobRowsFinishedAt, stuckForJob } from "../../monos/model/workerStuck";
import { useDelegationRows } from "../../monos/model/delegationStore";
import { OlderQuestions } from "./OlderQuestions";
import { appSinceText, sinceGlance, sinceParagraph, withoutStuckTalk } from "../model/appSince";
import { leadNameOf } from "../../monos/ui/StuckWorkerCard";
import { openLead } from "../../monos/model/stuckActions";
import { chatBusy, findWaitingChat, useChatsBusyVersion, useWaitingChatsVersion, waitingChats } from "../model/waitingChats";
import { BuildsView } from "./BuildsView";
import { BeingBuiltView } from "./BeingBuiltView";
import { DecisionsPage } from "./DecisionsPage";
import { DECISIONS_ITEM } from "../model/decisions";
import { plainStateWord } from "../model/liveJobs";
import { ProposalView } from "./ProposalView";
import { NewProjectView } from "./NewProjectView";
import { projectTodaySections, templateOf, useTemplatesVersion } from "../model/templates";
import { leadershipChatId, useHubChatsVersion } from "../model/hubChats";
import { useProposalsVersion } from "../model/proposals";
import { listBuilds, useHubBuildsVersion } from "../model/hubBuilds";
import { ProjectPagesView } from "./ProjectPagesView";
import { ShipNotice } from "./ShipNotice";
import { HarnessCareNotice } from "./HarnessCareNotice";
import { AutopilotView } from "../../autopilot/ui/AutopilotView";


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
  const data = hubData();
  const projects = data.listProjects();
  const project = projects.find((p) => p.id === selection.project);
  // A project is the unit of the hub (G1): with no project chosen — a first launch, or the last one removed — and
  // projects there, the app opens the first one; with none at all it offers to start one. It never shows a board of all
  // of them. (A Mono's own team fills the workspace instead; App.tsx doesn't show the hub then.)
  const home = !project && !appItemInView(selection);
  const first = projects[0]?.id;
  useEffect(() => {
    if (home && first) setHubSelection({ project: first, item: "inbox" });
  }, [home, first]);
  if (selection.item === "new-project") return <NewProjectView />;
  if (selection.item === "restore") return <RestorePreview />;
  if (selection.item === "autopilot") return <AutopilotView />;
  if (!project) return <HubHome />;
  if (selection.item === "leadership-team")
    return <GroupChatView key={project.id} chatId={leadershipChatId(project.id)} projectId={project.id} />;
  if (selection.item.startsWith("chat:"))
    return <GroupChatView key={selection.item} chatId={selection.item.slice(5)} projectId={project.id} />;
  if (selection.item === "new-chat") return <NewGroupChat projectId={project.id} />;
  if (selection.item.startsWith("proposal:")) return <ProposalView key={selection.item} id={selection.item.slice(9)} />;
  if (selection.item === "being-built") return <BeingBuiltView key={project.id} projectId={project.id} />;
  if (selection.item === DECISIONS_ITEM.id) return <ProjectDecisionsView key={project.id} projectId={project.id} />;
  const section = data.listProjectItems(project.id).find((i) => i.id === selection.item);
  if (section?.sectionType === "builds-playtests")
    return <BuildsView key={project.id} projectId={project.id} title={section.title} />;
  if (section?.sectionType === "project-pages")
    return <ProjectPagesView key={project.id} projectId={project.id} title={section.title} />;
  const item = section;

  let Icon: IconComponent = Inbox;
  let title = "Inbox";
  let body = <TodayBody projectId={project.id} />;
  if (item) {
    title = item.title;
    Icon = item.kind === "leadership-team" || item.kind === "group-chat" ? MessagesSquare : item.kind === "being-built" ? Hammer : PackageOpen;
    body = <Pending what={item.title} unit={item.kind === "leadership-team" ? 4 : item.kind === "being-built" ? 6 : 5} />;
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
        {body}
      </div>
    </div>
  );
}

/**
 * No project chosen: the create-a-project empty state (or what keeps the hub from loading). There is no central area
 * and no board of all projects (G1): a project is the unit of the hub, and HubSurface opens the first one as soon as
 * there is one.
 */
function HubHome() {
  useHubDataVersion();
  const data = hubData();
  const connection = data.connection();
  return (
    <div role="region" aria-label="Projects" data-hub-surface className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-stroke" data-tauri-drag-region="deep">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <FolderOpen className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
          <span className="min-w-0 truncate text-content">Projects</span>
        </div>
        {IS_MAC ? null : <div className="w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {connection.status === "unreachable" ? (
          <>
            <ShipNotice />
            <AshOsDown message={connection.message} retrying={connection.retrying} onRetry={() => data.retry()} />
          </>
        ) : connection.status === "loading" || data.listProjects().length ? (
          // Reading Ash OS: a project opens a moment later (HubSurface), so say nothing rather than flash "No projects yet".
          <div data-hub-loading />
        ) : (
          <>
            {/* The update card shows even when Today can't load (r28: otherwise it sits under the Since paragraph, never above it). */}
            <ShipNotice />
            <FirstTodayEmpty />
          </>
        )}
      </div>
    </div>
  );
}

function TodayBody({ projectId }: { projectId: string }) {
  useWaitingChatsVersion();
  useChatsBusyVersion();
  useMonoFailuresVersion();
  const { stuck: stuckWorkersNow } = useStuckWorkers();
  const delegationRows = useDelegationRows();
  const [sheet, setSheet] = useState<SheetFor | null>(null);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(25);
  const data = hubData();
  const connection = data.connection();
  // The update card shows even when Today can't load (r28: otherwise it sits under the Since paragraph, never above it).
  // Loading and "no projects yet" are HubHome's (G1): a project's Today only ever draws for a real project.
  if (connection.status === "unreachable") return <><ShipNotice /><AshOsDown message={connection.message} retrying={connection.retrying} onRetry={() => data.retry()} /></>;
  const since = data.sinceSummary(projectId);
  const sinceAt = data.sinceAt();
  // C9: one paragraph of what happened since Ash was last active (typing): Ash OS's words about the project's work, then
  // the app's own real events (work handed out, finished and reported back, stuck: appSince.ts). A project's Today says
  // only what happened in that project.
  const sinceMs = sinceAt ? Date.parse(sinceAt) : NaN;
  const appSince = Number.isFinite(sinceMs)
    ? appSinceText({
        sinceMs,
        rows: delegationRows.filter((r) => r.project === projectId),
        stuck: stuckWorkersNow.filter((s) => stuckProject(s)?.id === projectId),
        changes: [],
        nameOf: (row) => leadNameOf({ row }),
        checking: (row) => chatBusy(row.ownerSession),
        // A choice put to Ash, not a permission card (that is a step to allow, not a decision on the work).
        awaitingAsh: (row) => { const w = findWaitingChat(row.ownerSession); return !!w && w.source !== "permission"; },
        // Ash OS's stuck and gave-up jobs join the app's own in one count and one list (appSince.ts).
        jobs: data
          .listProjects()
          .filter((p) => p.id === projectId)
          .flatMap((p) => data.listJobs?.(p.id) ?? [])
          .flatMap((g) => g.jobs)
          .filter((j) => j.state === "stuck" || j.state === "sent_to_lead" || j.state === "lead_gave_up")
          .map((j) => ({ title: j.title, failed: j.state === "lead_gave_up", needsYou: j.state === "lead_gave_up", at: Date.parse(j.lastActiveAt) || 0 })),
      })
    : "";
  const waiting = waitingOnAsh(projectId);
  const projects = data.listProjects().filter((p) => p.id === projectId);
  // Two groups once chats are waiting: "Waiting on you" (agents' questions) above "Needs you" (gates and failures).
  const chatsWaiting =
    waitingChats(projectId).length > 0 ||
    failedMonosFor(projectId).length > 0 ||
    stuckWorkersNow.some((s) => stuckProject(s)?.id === projectId);
  const needsShown = projects.some((p) => waiting.some((w) => w.projectId === p.id) || laterItems(p.id).length);
  // A project's Inbox draws its own board: the cards its template names (templates.ts, stored per project), so a game
  // project opens on builds and a product project on its dashboards. There is no app-wide board to fall back to.
  const sections: readonly TodaySection[] = projectTodaySections(projectId);
  const sinceBlock = (s: TodaySection) => (
    <section key={s.id} data-hub-today-section={s.kind}>
      {sinceAt ? <h2 className="mb-2 text-xs text-content/60">{sinceHeading(s.title, sinceLabel(sinceAt))}</h2> : s.title !== "Since you were away" ? <h2 className="mb-2 text-xs text-content/60">{s.title}</h2> : null}
      {since.pending && !appSince ? (
        // Ash OS is still writing it: a quiet line, and the paragraph swaps in here when it is ready.
        <p className="text-[13px] leading-5 text-content/60" data-hub-since-pending>Writing up what changed…</p>
      ) : (
        (() => {
          const text = sinceParagraph(since.pending ? "" : calmSummary(withoutStuckTalk(sinceGlance(since.plainText))), appSince);
          return (
            <p
              className={`line-clamp-4 text-[13px] leading-5 ${text ? "text-content/85" : "text-content/60"}`}
              title={text || undefined}
              data-hub-since
              data-hub-since-app={appSince || undefined}
            >
              {text || "Nothing new since then."}
            </p>
          );
        })()
      )}
    </section>
  );
  // What Ash has to set up waits for him from anywhere (waiting.ts: connector sign-ins, Mono proposals, the setup file's
  // rows). It belongs to no project, so it shows on whichever project's Today he is in, and goes once it is done.
  const setupBlock = setupItems().length ? (
    <section data-hub-today-setup>
      <h2 className="mb-1 text-xs text-content/60">Setup</h2>
      <p className="px-2 pb-1 text-[13px] text-content/60">Passwords and keys never travel in the setup file.</p>
      <div className="flex flex-col">
        {setupItems().map((w) => (
          <StuckRow key={w.id} item={w} />
        ))}
      </div>
    </section>
  ) : null;
  // What waits on Ash in this project, grouped as needs.ts names it (Waiting on you sits above, in Needs you).
  const pStuck = waiting.filter((w) => w.state);
  const pNeeds = waiting.flatMap((w) => (w.need ? [w.need] : []));
  const pOther = waiting.filter((w) => !w.state && !w.need);
  const needsListed = pStuck.length + pNeeds.length + pOther.length > 0 || laterItems(projectId).length > 0;
  // What waits on Ash in this project, as one shrinkable column: a row stretches to the surface and its words truncate,
  // so an ask with a long title can never widen Today past the window (Ash's Mac, 21 Oct).
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
      </section> : needsListed ? <div className="flex flex-col" data-hub-today-projects>
        {pStuck.map((st) => (
          <StuckRow key={st.id} item={st} />
        ))}
        <NeedGroups needs={pNeeds} onSheet={setSheet} />
        {pOther.map((w) => (
          <StuckRow key={w.id} item={w} />
        ))}
        <LaterList projectId={projectId} onSheet={setSheet} />
      </div> : null}
    </div>
  );
  // C9: the Since paragraph is the glance at the top of Today, above the shortcuts and the project cards; the detail
  // (Needs you, Being built, pages) is below to scroll to.
  const sinceSection = sections.find((s) => s.kind === "since");
  const hasBuilt = sections.some((s) => s.kind === "being-built");
  const block = (s: TodaySection) =>
    s.kind === "since" ? null
    // Setup is the app's own, drawn once above (setupBlock), wherever a template or the fallback board has the section.
    : s.kind === "setup" ? null
    // Waiting on you sits right above Needs you, wherever the board puts it.
    // Only what Ash must act on sits with Needs you (r30): there is no "Stuck" section. A worker its Lead is handling
    // sits with Being built, or here when the board has no Being built.
    : s.kind === "needs" ? <Fragment key={s.id}><StuckToday projectId={projectId} tone="red" />{hasBuilt ? null : <StuckToday projectId={projectId} tone="grey" />}<WaitingOnYou projectId={projectId} />{needsBlock(s)}</Fragment>
    : s.kind === "being-built" ? <BeingBuiltToday key={s.id} title={s.title} projectId={projectId} />
    : s.kind === "page" && s.pageId ? <TodayPage key={s.id} title={s.title} pageId={s.pageId} />
    // A project's own cards (projectToday.ts): its newest build, its newest kept dashboard.
    : s.kind === "latest-build" && projectId ? <LatestBuildToday key={s.id} title={s.title} projectId={projectId} />
    : s.kind === "latest-page" && projectId ? <LatestDashboardToday key={s.id} title={s.title} projectId={projectId} />
    : null;
  return (
    <div className="flex w-full flex-col gap-6 px-6 py-8 xl:px-8" data-hub-surface-body>
      {sinceSection ? sinceBlock(sinceSection) : null}
      {/* "MonoCode Hub was updated" sits below the Since paragraph, which always comes first (PM's r44 check). */}
      <ShipNotice inBody appAsk={data.listProjects()[0]?.id === projectId} />
      {/* A harness fault is the app's own, not a project's (H3): it shows in every project's Today until it clears. */}
      <HarnessCareNotice inBody />
      {setupBlock}
      {/* The board took Needs you off Today: the chats waiting on Ash still lead it. */}
      {sections.some((s) => s.kind === "needs") ? null : <><StuckToday projectId={projectId} tone="red" />{hasBuilt ? null : <StuckToday projectId={projectId} tone="grey" />}<WaitingOnYou projectId={projectId} /></>}
      {sections.map(block)}
      {!query.trim() ? <OlderQuestions projectId={projectId} renderRow={(n) => <NeedRow key={n.id} need={n} onSheet={setSheet} />} /> : null}
      <LastChange projectId={projectId} />
      {sheet?.kind === "job" ? <OptionsSheet jobId={sheet.jobId} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === "question" ? <QuestionSheet needId={sheet.needId} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === "detail" ? <DetailSheet need={sheet.need} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}

const ACTIVE_JOBS: ReadonlySet<HubJob["state"]> = new Set(["working", "checking", "waiting", "stuck", "sent_to_lead", "lead_gave_up", "unknown"]);
const JOB_WORD: Partial<Record<HubJob["state"], string>> = { working: "Working", checking: "Checking", waiting: "Waiting" };
// A stuck job reads as Being built reads it, with the same chip (statusChip.ts): Retrying, With <Lead>, or Needs you.
const jobWord = (j: HubJob, lead: string): string | Chip =>
  j.state === "unknown" ? plainStateWord(j.rawState ?? "")
  : j.state === "stuck" || j.state === "sent_to_lead" || j.state === "lead_gave_up" ? stuckChip(j.state, lead)
  : JOB_WORD[j.state] ?? "";

/** Being built on Today: what the project's Leads are working on, one quiet line each. Hidden when idle. */
function BeingBuiltToday({ title, projectId }: { title: string; projectId?: string }) {
  const data = hubData();
  // This app's own workers under each job: a stuck one makes the job read Stuck, whatever its siblings do.
  const { stuck: stuckNow, now } = useStuckWorkers();
  const delegations = useDelegationRows();
  useMonoFailuresVersion();
  const failureOf = (j: HubJob) => (j.lead && j.state !== "lead_gave_up" ? monoFailure(j.lead) : undefined);
  const word = (j: HubJob, lead: string): string | Chip => {
    // Its Lead's last turn failed: the job can't move until that is dealt with. Only Ash can fix it (credits, sign-in):
    // Needs you; it should come right by itself: Can't answer (r27b).
    const failure = failureOf(j);
    if (failure) return failureChip(failure.tone);
    const stuck = stuckNow.length ? stuckForJob(j.sourceRef, delegations, now) : undefined;
    if (!stuck || j.state === "lead_gave_up") return jobWord(j, lead);
    // One of this app's workers stalled or failed under it: by the red rule, as Being built says it (r30c): red Needs you
    // when only Ash can sort it (credits, a rejected key, a refusal, out of retries), else grey Retrying or With <Lead>.
    return stuck.kind === "asking" && !stuck.escalated ? "Waiting" : stuckWorkerChip(stuck, lead);
  };
  // A project's Today shows that project's work (G1): there is no board where every project's jobs sit together.
  const rows = data.listProjects().filter((p) => !projectId || p.id === projectId).flatMap((p) =>
    (data.listJobs?.(p.id) ?? []).flatMap((g) => g.jobs.filter((j) => ACTIVE_JOBS.has(j.state) && !j.parentId && !(j.state === "working" && jobRowsFinishedAt(j.sourceRef, delegations) !== undefined)).map((j) => ({ p, j, lead: g.leadName }))),
  );
  // A worker its Lead is handling (grey With <Lead> or Retrying) is listed here, after the jobs, unless its job's row
  // above already says so (r30: no "Stuck" section).
  const covered = new Set(rows.flatMap(({ j }) => (stuckNow.length ? [stuckForJob(j.sourceRef, delegations, now)?.key ?? ""] : [])).filter(Boolean));
  if (!rows.length) return <StuckToday projectId={projectId} tone="grey" skip={covered} heading={title} />;
  return (
    <section data-hub-today-section="being-built" data-hub-today-being-built>
      <h2 className="mb-1 text-xs text-content/60">{title}</h2>
      <div className="flex flex-col">
        {rows.slice(0, 8).map(({ p, j, lead }) => {
          const w = word(j, lead);
          const red = typeof w !== "string" && w.tone === "red";
          const failure = failureOf(j);
          return (
            <div key={j.id} className="flex flex-col rounded-md hover:bg-content/5" data-hub-today-job={j.id}>
              <button type="button" onClick={() => setHubSelection({ project: p.id, item: "being-built" })}
                className="flex items-center gap-3 px-2 py-1.5 text-left">
                <span className="min-w-0 flex-1 truncate text-[13px] text-content">{j.title}</span>
                {/* "EXO lead · Needs you", not "EXO · EXO lead · …": a Lead named for its project already says which (r28). */}
                {typeof w === "string" ? (
                  <span className="shrink-0 text-xs text-content/60" data-hub-today-job-where>{stuckWhere(p, lead)} · {w}</span>
                ) : (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-content/60" data-hub-today-job-where>{stuckWhere(p, lead)} · <ChipMark chip={w} /></span>
                )}
              </button>
              {/* Every red Needs you says why and opens the Lead's chat (r27b). */}
              {red ? (
                <div className="flex min-w-0 flex-col px-2 pb-1.5 text-xs" data-hub-today-job-needs>
                  <span className="min-w-0 break-words text-content/60" data-hub-needs-reason>{failure ? `${lead} can't answer: ${failure.reason}` : j.reason || j.why}</span>
                  {j.lead ? <NeedsYouLinkLine name={lead} onOpen={() => openMonoChat(j.lead!)} /> : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {rows.length > 8 ? <span className="px-2 pt-1 text-xs text-content/60">{rows.length - 8} more in Being built</span> : null}
      </div>
      <StuckToday projectId={projectId} tone="grey" skip={covered} />
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

/**
 * A project's "Latest build to try" card (a template card): its newest build, from the same store Builds & playtests
 * reads. Quiet when there is none yet, with the way to the full list either way.
 */
function LatestBuildToday({ title, projectId }: { title: string; projectId: string }) {
  const build = listBuilds(projectId)[0];
  const builds = templateOf(projectId).sections.find((s) => s.sectionType === "builds-playtests");
  const openBuilds = builds ? (
    <button type="button" data-hub-latest-build-open onClick={() => setHubSelection({ project: projectId, item: builds.id })}
      className="self-start rounded-md px-2 py-0.5 text-xs text-content/60 hover:bg-content/5 hover:text-content">
      Open builds
    </button>
  ) : null;
  return (
    <section data-hub-today-section="latest-build">
      <h2 className="mb-2 text-xs text-content/60">{title}</h2>
      {build ? (
        <div className="flex flex-col gap-1">
          <p className="text-[13px] leading-5 text-content/85" data-hub-latest-build>
            {build.version} · {build.title}
          </p>
          <p className="text-[12px] text-content/60" data-hub-latest-build-state>
            {build.status === "ready" ? `Ready to try · ${build.builtAt}` : build.status === "building" ? `Building · ${build.builtAt}` : `Didn't build · ${build.builtAt}`}
          </p>
          {openBuilds}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-[13px] text-content/60" data-hub-latest-build-empty>No build yet.</p>
          {openBuilds}
        </div>
      )}
    </section>
  );
}

/** A project's "Latest dashboard" card: the page kept for it most recently, opening in Pages. */
function LatestDashboardToday({ title, projectId }: { title: string; projectId: string }) {
  usePagesVersion();
  const page = keptPages(projectId)[0];
  // r65 (Critiquito): an empty card says nothing worth reading; it shows once a dashboard is kept.
  if (!page) return null;
  return (
    <section data-hub-today-section="latest-page">
      <h2 className="mb-2 text-xs text-content/60">{title}</h2>
      {(
        <div className="flex flex-col gap-1">
          <button type="button" data-hub-latest-page className="self-start text-left text-[13px] leading-5 text-content/85 hover:underline"
            onClick={() => { requestOpenPage(page.id); window.dispatchEvent(new CustomEvent("monocode:home-open", { detail: "pages" })); }}>
            {page.title}
          </button>
          <p className="text-[12px] text-content/60">Kept by {page.by}</p>
        </div>
      )}
    </section>
  );
}

/** The last change to this project's Today or hub (within a day), with Undo or Redo right here. */
function LastChange({ projectId }: { projectId: string }) {
  const data = hubData();
  const last = (data.listChanges?.() ?? []).find(
    (c) => (c.flow === "today" || c.flow === "hub") && (c.state === "applied" || c.state === "undone") && (c.projectId === projectId || !c.projectId),
  );
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

/** What a Need asks of Ash, for grouping a long list (Board 22 Oct: "102 things waiting" read as one unsorted list). */
export type NeedKind = "decide" | "check" | "read";
const NEED_KIND_LABEL: Record<NeedKind, string> = { decide: "To decide", check: "To check", read: "To look at" };
export function needKind(need: Need): NeedKind {
  if (need.jobId || need.actionTarget?.startsWith("question:")) return "decide";
  if (need.actionType === "accept" || need.canMarkSeen) return "check";
  return "read";
}

/** A project's shown Needs, like with like: what to decide, what to check, what to look at; a heading only when mixed. */
function NeedGroups({ needs, onSheet }: { needs: readonly Need[]; onSheet: (sheet: SheetFor) => void }) {
  const groups = (["decide", "check", "read"] as const)
    .map((kind) => ({ kind, rows: needs.filter((n) => needKind(n) === kind) }))
    .filter((g) => g.rows.length);
  if (groups.length < 2) return <>{needs.map((n) => <NeedRow key={n.id} need={n} onSheet={onSheet} counted />)}</>;
  return (
    <>
      {groups.map((g) => (
        <div key={g.kind} className="flex flex-col" data-hub-need-group={g.kind}>
          <h3 className="mt-2 px-2 pb-0.5 text-[11px] font-normal text-content/50">
            {NEED_KIND_LABEL[g.kind]} · {g.rows.length}
          </h3>
          {g.rows.map((n) => (
            <NeedRow key={n.id} need={n} onSheet={onSheet} counted />
          ))}
        </div>
      ))}
    </>
  );
}

/** The Lead running a job, from Ash OS's job list: its Mono id and name. */
function jobLead(jobId: string): { id: string | null; name: string } | undefined {
  const data = hubData();
  for (const p of data.listProjects())
    for (const g of data.listJobs?.(p.id) ?? []) {
      const j = g.jobs.find((x) => x.id === jobId);
      if (j) return { id: j.lead ?? g.leadId, name: g.leadName };
    }
  return undefined;
}

function NeedRow({ need, onSheet, counted = false }: { need: Need; onSheet?: (sheet: SheetFor) => void; counted?: boolean }) {
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
  const mark = needMark(need, counted);
  const askRed = askNeedsAsh(need, counted);
  // A red ask keeps its one action (See options answers it right here), so it carries no Lead link: one action per row.
  const lead = need.jobId ? jobLead(need.jobId) : undefined;
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
    <div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-content/5" data-hub-need={need.id} data-hub-need-done={done || undefined} data-hub-ask-reason={askRed ? askReason(need) : undefined} {...redRowProps(!done && mark?.circle === "red")}>
      <div className="min-w-0 flex-1">
        <div className={`truncate text-[13px] ${done ? "text-content/60" : "text-content"}`}>{need.title}</div>
        {/* The reason wraps (never cut mid-word). */}
        <div className="whitespace-normal break-words text-[13px] leading-5 text-content/60" data-hub-need-why>{need.why}</div>
        {/* A red Needs you opens the Lead's chat from its row (r27b); the reason is the line above. */}
        {mark?.circle === "red" && lead?.id ? <NeedsYouLinkLine name={lead.name} onOpen={() => openLead(lead.id) || openMonoChat(lead.id!)} /> : null}
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
    <div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-content/5" {...redRowProps(!!item.state && stuckChip(item.state, item.lead).tone === "red")}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-content">{item.title}</div>
        {item.detail ? <div className="whitespace-normal break-words text-[13px] leading-5 text-content/60" data-hub-stuck-reason>{item.detail}</div> : null}
        {item.note ? <div className="whitespace-normal break-words text-[13px] leading-5 text-content/60" data-hub-sent>{item.note}</div> : null}
      </div>
      {item.state ? <StatusMark state={item.state} lead={item.lead} /> : null}
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
  const help = message && message !== heading && !/\b(Ash|Hub) OS\b/.test(message) ? message : "Start it, then try again. Your projects and Needs come back on their own.";
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

/** Clean first launch: no projects yet. Start one, or restore from an export. */
function FirstTodayEmpty() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      setPendingImport(readImportText(f.name, await f.text()));
      showAppItem("restore");
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
      showAppItem("restore");
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
            onClick={() => showAppItem("new-project")}
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

/**
 * D2 (PM r57): each project's own Decisions, beside its other items: Settings → Decisions filtered to this project.
 * Full width, like Being built.
 */
function ProjectDecisionsView({ projectId }: { projectId: string }) {
  return (
    <div role="region" aria-label="Decisions" data-hub-surface data-hub-project-decisions={projectId} className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-stroke" data-tauri-drag-region="deep">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <StickyNote className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
          <span className="min-w-0 truncate text-content">Decisions</span>
        </div>
        {IS_MAC ? null : <div className="w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <DecisionsPage projectId={projectId} />
      </div>
    </div>
  );
}
