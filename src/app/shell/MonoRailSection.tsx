import { Fragment } from "react";
import { getChat, roomTurnsByMono, useHubChatsVersion } from "../../features/hub/model/hubChats";
import { withRoomTurns } from "../../features/monos/model/roomBusy";
import { StuckMark, SubChatList } from "../../features/monos/ui/SubChatList";
import { dismissWaitingSoul, isDiskFullError, plainAddProblem, seatWaitingSoul, useWaitingSoulsVersion, waitingSouls } from "../../features/hub/model/setupSouls";
import { plainName, roleNamesUndecided, setRoleNames, useRoleNamesVersion } from "../../features/hub/model/roleNames";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { BellOff, ChevronDown, CircleAlert, Clock, Copy, ImagePlus, Loader, MoreHorizontal, Pencil, Pin, PinOff, Plus, RotateCcw, Trash2, UserGroup } from "../../shared/ui/icons";
import { duplicateContactWithFiles, editContactProfile, setContactMuted, setContactPinned } from "../../features/monos/model/contacts";
import { delegationActions, useDelegationRows } from "../../features/monos/model/delegationStore";
import { childChatsByMono } from "../../features/monos/model/delegationView";
import { needsYouFor, needsYouPanel } from "../../features/hub/model/needsYouRows";
import { useNeedsYouRows } from "../../features/hub/model/useNeedsYouRows";
import { useNeedsYou } from "../../features/needs/model/needsLive";
import { countWork, shortSplit, useStuckDismissalsVersion, type StuckWorker, type WorkCounts } from "../../features/monos/model/workerStuck";
import { subChatAttention, useSubChatFolds } from "../../features/monos/model/subChats";
import { hubData, useHubDataVersion } from "../../features/hub/model/hubData";
import { monoTeamInView, openCodingTeam, openMonoChat, openMonoTeam, useHubSelection } from "../../features/hub/model/hubNav";
import { teamFor, useMonoTeamsVersion, type TeamTarget } from "../../features/hub/model/monoTeams";
import { useClock } from "../../features/monos/hooks/useStuckWorkers";
import { failedMonoName, retryMonoFailure } from "../../features/monos/model/monoFailures";
import { NEEDS_YOU, failureChip } from "../../features/hub/model/statusChip";
import { ChipMark, NeedsYouChip } from "../../features/hub/ui/StatusMark";
import { useWaitingChatsVersion, waitingChats, type WaitingChat } from "../../features/hub/model/waitingChats";
import { askText } from "../../features/hub/model/chatQuestions";
import { Popover, type PopoverAnchor } from "../../shared/ui/Popover";
import { useAnimatedReorder } from "../../shared/hooks/useAnimatedReorder";
import { MonoRailMascot } from "../../features/monos/ui/MonoRailMascot";
import { MonoIntroCard } from "../../features/monos/ui/MonoIntro";
import { ensureBuiltInMonos } from "../../features/hub/model/builtInMonos";
import { RailAction } from "./RailAction";
import { pickChief } from "../../features/home/model/chief";
import {
  loadMonoRailCollapsed,
  saveMonoRailCollapsed,
  saveMonosEnabled,
  subscribeMonoRailCollapsed,
} from "../../features/settings/model/settings";
import { StuckPanel } from "../../features/monos/ui/StuckPanel";
import { monoPanelAsks } from "./monoPanelAsks";
import { ProjectBackgroundDialog } from "../../features/projects/ui/ProjectBackgroundDialog";
import { monoBackgroundKey } from "../../features/monos/model/monoBackground";
import {
  ColorPicker,
  MascotPicker,
} from "../../features/monos/ui/monoPanelParts";
import {
  defaultMonoName,
  findMono,
  listMonos,
  MONO_STATUS_LABEL,
  nextMonoLook,
  monoLook,
  monoProjectsPhrase,
  monosSnapshot,
  monoWorksOn,
  reorderMonos,
  saveMonoMascot,
  subscribeMonos,
  updateMono,
  monoForSession,
  type MonoState,
} from "../../features/monos/model/mono";

export type MonoRailProps = {
  /** The Mono open in the main area, if any. */
  activeId?: string;
  /** What each Mono is doing, by Mono id; missing reads as idle. */
  states: ReadonlyMap<string, MonoState>;
  /** Replies each Mono has that the user has not looked at yet, by Mono id. */
  unseenCounts?: ReadonlyMap<string, number>;
  onOpen: (monoId: string) => void;
  /** Creates a Mono, given these projects to start with. */
  onCreate: (projects?: readonly string[]) => void;
  onDelete: (monoId: string) => void;
  /** Deletes the Mono's 1:1 chat only (r30d): the caller asks first; the Mono, soul and memory stay. */
  onDeleteChat?: (monoId: string) => void;
  /** Hub mode: list only the Monos that work on this project folder. */
  projectFilter?: string;
  /** Hub mode: one flat list, sorted by this rank (lower first; ties keep their order). No headers. */
  rank?: (mono: { id: string; name?: string }) => number;
};

const IDLE: MonoState = { status: "idle" };

/**
 * r102 (12, Critiquito): a rail unread count is grey and smaller than the red "needs you" badge, so new replies never
 * read as an ask (asks live in the Inbox).
 */
export const RAIL_UNREAD_CLASS =
  "grid h-3.5 min-w-3.5 shrink-0 place-items-center rounded-full bg-content/12 px-1 text-[9px] font-medium tabular-nums leading-none text-content/70";

/** A Mono's unread count as its badge shows it. */
export function unreadBadge(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function unreadLabel(count: number): string {
  return count === 1 ? "1 new reply" : `${count} new replies`;
}

/**
 * Which Monos the rail lists, in order. With `projectFilter`, only the Monos explicitly assigned to that project folder
 * (the hub passes its selected project; Today passes none and keeps the whole roster). The hub (`rank` set) sorts the
 * list: the default four, then every project's Lead (hubMonoRank).
 */
/** Dropwave: Home is its own project. Its sidebar lists only the Monos that work on no project (the Chief of Staff). */
export const HOME_MONOS = "hub:home";

export function railMonos<M extends { id: string; name?: string; projects: string[]; pinned?: boolean }>(
  list: M[],
  projectFilter: string | undefined,
  rank: ((mono: M) => number) | undefined,
): M[] {
  const eligible = list.filter((mono) =>
    projectFilter === HOME_MONOS ? mono.projects.length === 0 : !projectFilter || mono.projects.includes(projectFilter),
  );
  const ordered = rank
    ? eligible.map((m, i) => ({ m, i, r: rank(m) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.m)
    : eligible;
  // WP-21: a pinned Mono stays in this order, and comes first.
  return ordered
    .map((m, i) => ({ m, i }))
    .sort((a, b) => Number(b.m.pinned === true) - Number(a.m.pinned === true) || a.i - b.i)
    .map((x) => x.m);
}

/** Open a Mono's team (monoTeams.ts): a Lead's coding team on the Lead, or a Mono's own team on its chat. */
export function openTeam(team: TeamTarget): void {
  if (team.kind === "coding") openCodingTeam(team.projectId, { lead: true });
  else openMonoTeam(team.monoId, { owner: true });
}

/**
 * The user's Monos, above the projects. Each opens like a project does, but
 * into its conversation; none belongs to a project, so they get a section of
 * their own and the shaded mascot rather than a project's flat one.
 *
 * The hub's rail shows people, not work (Ash, 20 Oct: "monos shouldn't really have sub chats"): a Mono's workers live in
 * its team (monoTeams.ts), so its row says what it has out ("2 working · 1 needs you", red only for what Ash must act on) on
 * one line under it, and opens its team. r88 (Ash, B13): its workers' chats also nest under it, folded unless one needs a look.
 */
export function MonoRailSection({
  activeId,
  states: ownStates,
  unseenCounts,
  onOpen,
  onCreate,
  onDelete,
  onDeleteChat,
  projectFilter,
  rank,
  project,
}: MonoRailProps & {
  /**
   * Lists only the Monos working on this project, as the inset sidebar does;
   * a Mono on several projects shows in each of them. The hub (`rank` set)
   * filters by its own `projectFilter` (the selected hub project) instead.
   */
  project?: string;
}) {
  const snapshot = useSyncExternalStore(subscribeMonos, monosSnapshot);
  // r67 (Alfred A9): a Mono writing a room turn reads busy here too, with the room's name.
  useHubChatsVersion();
  const states = withRoomTurns(ownStates, roomTurnsByMono(), (chatId) => getChat(chatId)?.name);
  // What each Mono has out, from the work it delegated (its workers live in its team, and nest under it here: r88).
  const delegationRows = useDelegationRows();
  const now = useClock();
  useStuckDismissalsVersion();
  useSubChatFolds();
  useMonoTeamsVersion();
  useHubDataVersion();
  const hubSel = useHubSelection();
  // A Mono's own team in view: its row reads as current, since no project is (hubNav.ts).
  const teamInView = rank ? monoTeamInView(hubSel) : undefined;
  const childChats = useMemo(
    () =>
      childChatsByMono(delegationRows, (row) => row.ownerMono ?? monoForSession(row.ownerSession)?.id, Date.now(), {
        max: Infinity,
      }),
    [delegationRows],
  );
  useRoleNamesVersion();
  useWaitingSoulsVersion();
  const waiting = rank ? waitingSouls() : [];
  // Why OK on a waiting Mono couldn't finish (a file it couldn't read, or a failure), by Mono id: it keeps waiting.
  // r27b: each row by where it came from (there is no error kind here). OK itself failed ("Couldn't add …"): only Ash
  // can try again, the red Needs you. A file it couldn't read was left as it is, nothing lost: grey.
  const [soulProblems, setSoulProblems] = useState<ReadonlyMap<string, readonly SoulProblem[]>>(new Map());
  const noteSoulProblems = (monoId: string, problems: readonly SoulProblem[]) =>
    setSoulProblems((current) => {
      const next = new Map(current);
      if (problems.length) next.set(monoId, problems);
      else next.delete(monoId);
      return next;
    });
  const seatSoul = (monoId: string, name: string) => {
    noteSoulProblems(monoId, []);
    void seatWaitingSoul(monoId).then(
      (problems) => noteSoulProblems(monoId, problems.map((problem) => ({ text: plainAddProblem(name, { problem }), ashFixes: false }))),
      (error: unknown) => noteSoulProblems(monoId, [{ text: plainAddProblem(name, { error }), ashFixes: true, ...(isDiskFullError(error) ? { diskFull: true } : {}) }]),
    );
  };
  // r28: while the disk is full, OK can't work, so it is greyed out (Not now still works). The app can't see free space
  // itself, so OK comes back when Ash returns to the app (after clearing space elsewhere) or after a minute.
  const waitingForSpace = [...soulProblems.values()].some((ps) => ps.some((p) => p.diskFull));
  useEffect(() => {
    if (!waitingForSpace) return;
    const offerOkAgain = () =>
      setSoulProblems((current) => new Map([...current].map(([id, ps]) => [id, ps.map(({ diskFull: _, ...p }) => p)])));
    const timer = window.setTimeout(offerOkAgain, DISK_RECHECK_MS);
    window.addEventListener("focus", offerOkAgain);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", offerOkAgain);
    };
  }, [waitingForSpace]);
  // Role names are a hub thing; plain Monocode keeps the Monos' own names.
  // With role names on, the role leads and the name follows in grey; otherwise the name leads and the role follows.
  const shown = (look: { name: string; role?: string }) => {
    const plain = rank ? plainName(look.name) : { primary: look.name };
    return plain.secondary ? { primary: look.role ?? plain.primary, secondary: look.name } : { primary: look.name, secondary: look.role };
  };
  const shownName = (mono: Parameters<typeof monoLook>[0]) => shown(monoLook(mono)).primary;
  const monos = useMemo(
    () =>
      railMonos(listMonos(), projectFilter, rank).filter(
        // Dropwave: the Chief of Staff has its own row at the very top of the hub's sidebar, so it isn't listed again.
        (mono) => (rank ? mono.id !== pickChief(listMonos())?.id : !project || monoWorksOn(mono, project)),
      ),
    [snapshot, projectFilter, rank, project],
  );
  const ids = monos.map((mono) => mono.id);
  const sortable = useAnimatedReorder(ids, reorderMonos, "y");
  // Folded or open, kept with the app's other preferences so it survives a restart (A9).
  const collapsed = useSyncExternalStore(subscribeMonoRailCollapsed, loadMonoRailCollapsed, loadMonoRailCollapsed);
  const toggleCollapsed = () => saveMonoRailCollapsed(!collapsed);
  // "1 stuck" opens its workers beside the rail, answerable there (B6): one Mono's, or every Mono's from the folded header.
  const [stuckPanel, setStuckPanel] = useState<{ monoId?: string; anchor: HTMLElement }>();
  const toggleStuckPanel = (anchor: HTMLElement, monoId?: string) =>
    setStuckPanel((open) => (open && open.anchor === anchor ? undefined : { monoId, anchor }));
  const [menu, setMenu] = useState<{ id: string; anchor: PopoverAnchor }>();
  const [background, setBackground] = useState<string>();
  const backgroundMono = background ? findMono(background) : undefined;
  // What each Mono has out (its workers live in its team, never listed here), read once for its line and the folded summary.
  // WP-210: the red number is the one Needs you list. The panel still opens the worker rows behind a stopped item.
  const needsRows = useNeedsYouRows();
  const needsItems = useNeedsYou();
  // r75 (blind s06, B12): a Mono's own chat waiting on Ash (a Lead that asked before starting any job) is red on its row
  // too, like Today and Being built; it opens that chat.
  useWaitingChatsVersion();
  const waitingByMono = new Map<string, WaitingChat>();
  for (const c of waitingChats()) if (c.monoId && !waitingByMono.has(c.monoId)) waitingByMono.set(c.monoId, c);
  const workOf = (monoId: string) => {
    const children = childChats.get(monoId) ?? [];
    return {
      attention: subChatAttention(children, now),
      counts: railCounts(countWork(children.flatMap((chat) => (chat.row ? [chat.row] : [])), now), needsItems.filter((item) => item.monoId === monoId).length),
    };
  };
  const work = new Map(monos.map((mono) => [mono.id, workOf(mono.id)] as const));
  // r66 (Alfred A9): folded, the header still says who is busy in its own chat: "Nibbii lead" with a pulsing dot, or
  // "2 working". Workers are counted on the line under it (FoldedWorkSummary), as before.
  const busy = monos.filter((mono) => (states.get(mono.id) ?? IDLE).status === "working");
  const busyText = busy.length === 1 ? shownName(busy[0]) : busy.length ? `${busy.length} working` : undefined;
  const total: WorkCounts = { working: 0, asking: 0, stuck: 0 };
  for (const { counts } of work.values()) {
    total.working += counts.working;
    total.asking += counts.asking;
    total.stuck += counts.stuck;
  }
  // "1 needs you" opens only what Ash must act on (r30), from the same list: r51, every row behind the count, workers and
  // jobs alike, so the panel's rows and header always equal the chip.
  // The folded header counts the Monos shown here, so its panel lists those Monos' rows, no more.
  const shownIds = new Set(ids);
  const shownRows = needsRows.filter((r) => !!r.lead && shownIds.has(r.lead));
  const allStuck = needsYouPanel(shownRows).workers;
  const panel = stuckPanel ? needsYouPanel(stuckPanel.monoId ? needsYouFor(needsRows, stuckPanel.monoId) : shownRows) : undefined;
  const panelStuck = panel?.workers ?? [];
  const panelAsks = stuckPanel ? monoPanelAsks(needsItems, stuckPanel.monoId, shownIds) : [];
  const panelMono = stuckPanel?.monoId ? findMono(stuckPanel.monoId) : undefined;
  const menuMono = menu ? findMono(menu.id) : undefined;
  const menuTeam = rank && menuMono ? teamFor({ id: menuMono.id, name: monoLook(menuMono).name }, hubData().listProjects()) : undefined;

  // Hub: a clean first launch starts with the default team in normal rows, not Monocode's intro card.
  useEffect(() => {
    if (rank) ensureBuiltInMonos();
  }, [rank]);

  // Hub: a project with no Monos shows nothing here; its empty Leadership
  // team offers "Add a Mono" instead, so the intro card isn't doubled up.
  if (monos.length === 0 && projectFilter) return null;
  // With no Mono yet, the card stands in for the rail's section (plain
  // Monocode only; the hub has its default team). A project with none of its
  // own offers one under the label instead.
  if (monos.length === 0 && !rank && !project)
    return (
      <div className="mb-2 shrink-0" data-mono-rail>
        <MonoIntroCard
          look={nextMonoLook(monos)}
          onCreate={() => onCreate()}
          onHide={() => saveMonosEnabled(false)}
        />
      </div>
    );

  return (
    <div
      className={`shrink-0 ${project ? "px-2 pb-3" : "mb-2"}`}
      data-mono-rail
      data-mono-project={project}
    >
      <div
        className={
          // The inset sidebar's section labels.
          project
            ? "flex h-7 items-center gap-1 px-2 text-[12px] font-medium text-content/50"
            : "flex items-center gap-1 px-3 pb-1.5 pt-1"
        }
      >
        {/* The label folds the list away (remembered); folded, it shows how many Monos it hides. */}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? (busyText ? `Expand Monos, ${busyText}` : "Expand Monos") : "Collapse Monos"}
          className={`flex min-w-0 flex-1 items-center gap-1 rounded text-left hover:text-content${
            project ? "" : " px-1 text-xs leading-5 text-content/50"
          }`}
        >
          <ChevronDown
            className={`size-3 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
          <span className="truncate">{rank ? "First mates" : "Monos"}</span>
          {collapsed ? <span className="ml-1 text-content/35">{monos.length}</span> : null}
          {collapsed && busyText ? (
            <span className="ml-1.5 flex min-w-0 items-center gap-1 text-content/55" data-mono-rail-busy={busy.length}>
              <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-content/60 motion-reduce:animate-none" />
              <span className="truncate">{busyText}</span>
            </span>
          ) : null}
        </button>
        {monos.length ? (
          <button
            type="button"
            title="New mono"
            aria-label="New mono"
            onClick={() => onCreate(project ? [project] : undefined)}
            className={`grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content${
              project ? " -mr-0.5" : ""
            }`}
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      {collapsed && railSplit(total) ? (
        <FoldedWorkSummary counts={total} stuck={allStuck} onOpenStuck={(anchor) => toggleStuckPanel(anchor)} />
      ) : null}
      {!collapsed && rank && roleNamesUndecided() && monos.some((m) => plainName(monoLook(m).name).secondary) ? (
        <div className="mx-3 mb-1.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 px-1 text-[11px] leading-4 text-content/50" data-role-names-offer>
          <span className="w-full">Monos now go by what they do.</span>
          <button type="button" onClick={() => setRoleNames(false)} className="-ml-1 shrink-0 rounded px-1 text-content/70 hover:bg-content/8 hover:text-content">
            Keep current names
          </button>
          <button type="button" onClick={() => setRoleNames(true)} className="shrink-0 rounded px-1 text-content/70 hover:bg-content/8 hover:text-content">
            OK
          </button>
        </div>
      ) : null}
      {!collapsed && waiting.length ? (
        <div className="mx-2 mb-1.5 flex flex-col gap-px" data-souls-waiting>
          {waiting.map((w) => (
            // A solid outline, like a session's card (Critiquito, r27c), not a dashed one.
            <div key={w.monoId} className="rounded-md border border-content/25 px-2 py-1 text-[13px] leading-tight" data-soul-waiting-card>
              <span className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-content/80">{w.name}</span>
                {soulProblems.get(w.monoId)?.some((p) => p.diskFull) ? (
                  <button type="button" disabled data-soul-ok-waits-for-space title="There isn't space on the disk yet" className="shrink-0 cursor-default rounded px-1 text-[11px] text-content/30">OK</button>
                ) : (
                  <button type="button" onClick={() => seatSoul(w.monoId, w.name)} className="shrink-0 rounded px-1 text-[11px] text-content/70 hover:bg-content/8 hover:text-content">OK</button>
                )}
                <button type="button" onClick={() => dismissWaitingSoul(w.monoId)} className="shrink-0 rounded px-1 text-[11px] text-content/70 hover:bg-content/8 hover:text-content">Not now</button>
              </span>
              <span className="block text-[11px] text-content/50">Waiting for your OK</span>
              {soulProblems.get(w.monoId)?.length ? (
                <span role="alert" className="mt-0.5 flex flex-col gap-0.5 text-[11px] leading-4" data-mono-soul-problems>
                  {soulProblems.get(w.monoId)!.map((problem, i) =>
                    problem.ashFixes ? (
                      <span key={i} className="flex min-w-0 flex-wrap items-center gap-x-1.5" data-mono-soul-problem="needs-you">
                        <ChipMark chip={NEEDS_YOU} />
                        <span className="min-w-0 break-words text-content/60">{problem.text}</span>
                      </span>
                    ) : (
                      <span key={i} className="flex items-start gap-1 text-content/60" data-mono-soul-problem="grey">
                        <CircleAlert className="mt-px size-3 shrink-0" strokeWidth={1.75} />
                        <span className="min-w-0">{problem.text}</span>
                      </span>
                    ),
                  )}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {/* A long roster scrolls inside a bounded height instead of pushing the rest of the rail away. */}
      <div
        hidden={collapsed}
        data-mono-rail-list
        className={`@container/monorail ${collapsed ? "hidden" : "flex"} max-h-[40vh] flex-col gap-px overflow-y-auto${
          project ? "" : " px-2"
        }`}
      >
        {monos.length === 0 ? (
          <RailAction
            label="New mono"
            icon={Plus}
            onClick={() => onCreate(project ? [project] : undefined)}
          />
        ) : null}
        {monos.map((mono) => {
          const look = monoLook(mono);
          const state = states.get(mono.id) ?? IDLE;
          // A Mono's chat in view, else the Mono whose own team is (a worker's chat open in it).
          const selected = activeId ? mono.id === activeId : mono.id === teamInView;
          // Its team, in the hub: a Lead's coding team, or its own once it has one.
          const team = rank ? teamFor({ id: mono.id, name: look.name }, hubData().listProjects()) : undefined;
          const unseen = selected || mono.muted === true ? 0 : (unseenCounts?.get(mono.id) ?? 0);
          const projects = look.projects.length
            ? monoProjectsPhrase(look.projects)
            : "No projects yet";
          // What it has out, split (Ash, 20 Oct): "2 working · 1 asking · 1 stuck". Idle shows nothing else, unless it
          // waits on something (a watched pull request's CI); busy, its own status first, then what is stuck.
          const { attention, counts } = work.get(mono.id) ?? workOf(mono.id);
          const stuckSplit = railSplit({ ...counts, working: 0 });
          // Open team sits on the row only while the Mono has work out (with its line under it): a Mono with nothing out
          // looks exactly as it always did, on hover too (Ash's shipped rail, 20 Oct); its menu still opens the team.
          const rowTeam = team && railSplit(counts) ? team : undefined;
          const status =
            state.status === "idle"
              ? (state.activity ?? railSplit(counts))
              : state.status === "failed"
                ? [`${MONO_STATUS_LABEL.failed}: ${state.activity ?? "its last turn failed"}`, stuckSplit].filter(Boolean).join(" · ")
                : [state.activity ?? MONO_STATUS_LABEL[state.status], stuckSplit].filter(Boolean).join(" · ");
          // A name with a role under it gets 6px more, so the role never sits on the next name; a name alone stays 32px.
          const twoLines = !!shown(look).secondary && shown(look).secondary !== look.name;
          return (
            <Fragment key={mono.id}>
            <div
              ref={(el) => sortable.setItemRef(mono.id, el)}
              data-selected={selected || undefined}
              data-mono-status={state.status}
              className={`reorder-item project-reorder-item group relative flex ${twoLines ? "h-[38px]" : "h-8"} cursor-default touch-none items-stretch rounded-md px-2 ${
                selected ? "bg-selection-strong text-content" : "opacity-65"
              }`}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                if (
                  (event.target as HTMLElement | null)?.closest(
                    "[data-no-drag]",
                  )
                )
                  return;
                sortable.onItemPointerDown(mono.id, event);
              }}
              onClick={(event) => {
                if (
                  (event.target as HTMLElement | null)?.closest(
                    "[data-no-drag]",
                  )
                )
                  return;
                if (sortable.consumeClick()) return;
                // Dropwave: in the hub every one-to-one chat opens in the same layout, the chat list beside the chat.
                if (rank) openMonoChat(mono.id);
                else onOpen(mono.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({
                  id: mono.id,
                  anchor: { x: event.clientX, y: event.clientY },
                });
              }}
            >
              <button
                type="button"
                title={[look.name, look.role, projects, status].filter(Boolean).join("\n")}
                aria-label={[
                  look.name,
                  status ?? "idle",
                  unseen ? unreadLabel(unseen) : undefined,
                  projects,
                ]
                  .filter(Boolean)
                  .join(", ")}
                aria-current={selected ? "true" : undefined}
                className={`flex min-w-0 flex-1 cursor-default items-center gap-2 text-left transition-[padding] duration-150 motion-reduce:transition-none ${
                  rowTeam ? "group-hover:pr-12 group-has-[button:focus-visible]:pr-12" : "group-hover:pr-6 group-has-[button:focus-visible]:pr-6"
                }`}
              >
                <MonoRailMascot
                  name={look.mascot}
                  color={look.color}
                  status={state.status}
                  tone={state.tone}
                  // The dot sits just off the tile's top-right corner; this gap is its own, so it touches neither the
                  // creature nor the first letter of the name (the room, 21 Oct).
                  className="mr-1 size-4 shrink-0"
                />
                {/* The name reads the same in every state, at full contrast: the dot and the creature already say
                    what it is doing (Critiquito, 21 Oct: a working name's shimmer sat near 2:1). */}
                {shown(look).secondary === look.name ? (
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-tight">
                      <span className="min-w-0 truncate text-sm font-medium @max-[200px]/monorail:hidden" data-mono-primary-name>
                        {shown(look).primary}
                      </span>
                      <span className="shrink-0 text-xs font-normal text-content/80 @max-[200px]/monorail:truncate @max-[200px]/monorail:text-sm @max-[200px]/monorail:font-medium @max-[200px]/monorail:text-content" data-mono-own-name>
                        {shown(look).secondary}
                      </span>
                    </span>
                ) : (
                  // The name has the whole first row; the role is a small second line under it, at any rail width
                  // (Ash, 15 Oct: "ed", "Alfred" don't say what they do). Grey at 80% is 4.5:1 on glass even dimmed.
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium leading-[18px]" data-mono-primary-name>
                      {shown(look).primary}
                    </span>
                    {shown(look).secondary ? (
                      <span className="truncate text-[11px] font-normal leading-[14px] text-content/80" data-mono-role>
                        {shown(look).secondary}
                      </span>
                    ) : null}
                  </span>
                )}
                <StuckMark stuck={[...attention.stuck.values()]} />
                {unseen ? (
                  <span
                    aria-hidden
                    data-mono-unread={unseen}
                    className={`${RAIL_UNREAD_CLASS} group-hover:hidden group-has-[button:focus-visible]:hidden`}
                  >
                    {unreadBadge(unseen)}
                  </span>
                ) : null}
              </button>
              {rowTeam ? (
                <button
                  type="button"
                  data-no-drag
                  data-mono-open-team={mono.id}
                  title={`Open ${rowTeam.name}`}
                  aria-label={`Open ${rowTeam.name}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    openTeam(rowTeam);
                  }}
                  className="absolute right-7 top-1/2 hidden size-6 -translate-y-1/2 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content group-hover:grid group-has-[button:focus-visible]:grid"
                >
                  <UserGroup className="size-3.5" strokeWidth={1.75} />
                </button>
              ) : null}
              <button
                type="button"
                data-no-drag
                title="Mono options"
                aria-label={`${look.name} options`}
                aria-haspopup="menu"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenu({ id: mono.id, anchor: event.currentTarget });
                }}
                className="absolute right-1 top-1/2 hidden size-6 -translate-y-1/2 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content group-hover:grid group-has-[button:focus-visible]:grid"
              >
                <MoreHorizontal className="size-4" strokeWidth={1.75} />
              </button>
            </div>
            {state.status === "failed" ? <MonoFailedLine monoId={mono.id} state={state} onOpen={() => onOpen(mono.id)} /> : null}
            {state.status !== "failed" && waitingByMono.has(mono.id) ? <MonoWaitingLine monoId={mono.id} chat={waitingByMono.get(mono.id)!} /> : null}
            {railSplit(counts) ? (
              <MonoWorkLine
                monoId={mono.id}
                name={look.name}
                counts={counts}
                stuck={[...attention.stuck.values()]}
                team={team}
                // The work lives in its team; a Mono with none (it only briefed coding teams) opens its chat, where
                // each brief has its line.
                onOpen={() => (team ? openTeam(team) : onOpen(mono.id))}
                onOpenStuck={(anchor) => toggleStuckPanel(anchor, mono.id)}
              />
            ) : null}
            {/* Dropwave: sub-chat chains show only on the Agents board, never in the hub's sidebar. */}
            {!rank && (childChats.get(mono.id) ?? []).length ? (
              // r88 (Ash, B13): its workers' chats nest under it here too, folded under a count and opening by
              // themselves when one asks, is stuck or failed (subChats.ts); one click opens a worker's chat.
              <div data-mono-sub-chats={mono.id}>
                <SubChatList
                  foldKey={`rail:${mono.id}`}
                  owner={mono.id}
                  children={childChats.get(mono.id) ?? []}
                  attention={attention}
                  leadName={look.name}
                  now={now}
                  onOpen={(chat) => delegationActions()?.openChild(chat.ownerSession, chat.sessionId)}
                />
              </div>
            ) : null}
            </Fragment>
          );
        })}
      </div>
      {stuckPanel ? (
        <StuckPanel
          anchor={stuckPanel.anchor}
          title={panelMono ? monoLook(panelMono).name : "Monos"}
          stuck={panelStuck}
          jobs={panel?.jobs}
          asks={panelAsks}
          now={now}
          showLead={!stuckPanel.monoId}
          onClose={() => setStuckPanel(undefined)}
        />
      ) : null}
      {menu ? (
        <MonoMenu
          key={menu.id}
          monoId={menu.id}
          anchor={menu.anchor}
          team={menuTeam}
          onOpenTeam={(team) => {
            setMenu(undefined);
            openTeam(team);
          }}
          onBackground={() => {
            setMenu(undefined);
            setBackground(menu.id);
          }}
          onDelete={() => {
            setMenu(undefined);
            onDelete(menu.id);
          }}
          {...(onDeleteChat
            ? {
                onDeleteChat: () => {
                  setMenu(undefined);
                  onDeleteChat(menu.id);
                },
              }
            : {})}
          onClose={() => setMenu(undefined)}
        />
      ) : null}
      {backgroundMono ? (
        <ProjectBackgroundDialog
          project={monoBackgroundKey(backgroundMono.id)}
          name={monoLook(backgroundMono).name}
          locked
          onClose={() => setBackground(undefined)}
        />
      ) : null}
    </div>
  );
}

/**
 * What a Mono has out, on one line under its row, in place of the sub-chats it used to list (Ash, 20 Oct: the rail shows
 * people, not work): "2 working · 1 stuck" (asking counts as stuck, as on Today; the full split is on hover), the stuck
 * part red only when Ash must act; the row keeps its own mark. One click opens its team, where the work and its
 * sub-chats are.
 */
/** One row of the waiting-soul problems list; `ashFixes`: only Ash can sort it (red Needs you), else grey. */
type SoulProblem = { text: string; ashFixes: boolean; diskFull?: boolean };
/** How long a greyed-out OK (disk full) waits before it is offered again, if Ash hasn't come back to the app. */
const DISK_RECHECK_MS = 60_000;

/** The rail's "needs you": red, the one colour for what only Ash can sort (r30). */
const NEEDS_YOU_RED = "text-red-400";

/**
 * The rail's counts under the red rule (r30): what works, what waits on its Lead, and only what Ash must act on in the
 * third place (`stuck` here is that "needs you" count). A worker its Lead is handling or retrying isn't counted.
 */
function railCounts(counts: WorkCounts, needsYou: number): WorkCounts {
  return { working: counts.working, asking: counts.asking, stuck: needsYou, needsYou };
}
/** "2 working · 1 waiting · 1 needs you", never "stuck"; nothing when nothing is out. */
function railSplit(counts: WorkCounts): string | undefined {
  const parts = [
    counts.working ? `${counts.working} working` : "",
    counts.asking ? `${counts.asking} waiting` : "",
    counts.stuck ? `${counts.stuck} needs you` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

function MonoWorkLine({
  monoId,
  name,
  counts,
  team,
  onOpen,
  onOpenStuck,
}: {
  monoId: string;
  name: string;
  counts: WorkCounts;
  stuck: readonly StuckWorker[];
  team?: TeamTarget;
  onOpen: () => void;
  /** "1 stuck" opens its stuck workers beside the rail, each answerable there (B6). */
  onOpenStuck: (anchor: HTMLElement) => void;
}) {
  const short = shortSplit(counts);
  // Red is only for Needs you, and no third colour: what is counted here is what only Ash can sort (r30).
  const stuckColor = NEEDS_YOU_RED;
  // Work still running leads with the spinner (the row already carries the stuck mark); with nothing running, the
  // line's own mark says why it waits.
  const Mark = short.working ? Loader : counts.stuck ? CircleAlert : Clock;
  // Waiting on its Lead is not stuck: only stuck work colours the mark.
  const markColor = short.working || !short.stuck ? "text-content/45" : stuckColor;
  return (
    <div
      className="ml-5 flex h-6 min-w-0 items-center border-l border-content/10 pl-1.5"
      data-mono-work={monoId}
      data-mono-work-kind={counts.stuck ? "needs-you" : counts.asking ? "asking" : "working"}
    >
      {/* The line is two targets: what is working opens its team; "1 stuck" opens the stuck workers to answer them. */}
      <span className="flex min-w-0 flex-1 items-center text-[12px] text-content/45" data-mono-work-split>
        <button
          type="button"
          title={[railSplit(counts), team ? `Open ${team.name}` : `Open ${name}`].filter(Boolean).join("\n")}
          aria-label={`${railSplit(counts) ?? short.text}. Open ${team ? team.name : name}`}
          onClick={onOpen}
          className={`flex min-w-0 cursor-default items-center gap-1.5 rounded-md px-1.5 text-left hover:bg-content/6 hover:text-content${
            short.stuck ? " shrink" : " flex-1"
          }`}
        >
          <Mark
            aria-hidden
            className={`size-3.5 shrink-0 ${markColor}${Mark === Loader ? " animate-spin motion-reduce:animate-none" : ""}`}
            strokeWidth={1.75}
          />
          {short.working ? <span className="min-w-0 truncate">{short.working} working</span> : null}
          {short.working && short.waiting ? <span aria-hidden> · </span> : null}
          {short.waiting ? <span className="min-w-0 truncate" data-mono-work-waiting>{short.waiting} waiting</span> : null}
          {(short.working || short.waiting) && short.stuck ? <span aria-hidden> · </span> : null}
        </button>
        {short.stuck ? (
          <StuckButton count={short.stuck} color={stuckColor} label={`See what needs you for ${name}`} onOpen={onOpenStuck} />
        ) : null}
      </span>
    </div>
  );
}

/** "1 stuck", as a button: it opens the stuck workers beside the rail (B6), never a dead word. */
function StuckButton({
  count,
  color,
  label,
  onOpen,
}: {
  count: number;
  color: string;
  label: string;
  onOpen: (anchor: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      data-no-drag
      data-stuck-trigger
      title={label}
      aria-label={`${count} needs you. ${label}`}
      aria-haspopup="dialog"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(event.currentTarget);
      }}
      className={`shrink-0 cursor-default rounded-md px-1.5 hover:bg-content/6 ${color}`}
    >
      {count} needs you
    </button>
  );
}

/**
 * The folded Monos section still says what is out (A9: "a busy Mono still shows its one status line"): one line under the
 * header for every Mono, in the same words as a Mono's own line ("3 working · 1 stuck"), the full split on hover; "1 stuck"
 * opens every stuck worker.
 */
function FoldedWorkSummary({
  counts,
  onOpenStuck,
}: {
  counts: WorkCounts;
  stuck: readonly StuckWorker[];
  onOpenStuck: (anchor: HTMLElement) => void;
}) {
  const short = shortSplit(counts);
  // Red is only for Needs you, and no third colour: what is counted here is what only Ash can sort (r30).
  const stuckColor = NEEDS_YOU_RED;
  const Mark = short.working ? Loader : counts.stuck ? CircleAlert : Clock;
  return (
    <div
      className="mx-3 -mt-1 mb-1.5 flex h-6 min-w-0 items-center px-1 text-[12px] text-content/45"
      title={railSplit(counts)}
      data-mono-rail-summary
      data-mono-work-kind={counts.stuck ? "needs-you" : counts.asking ? "asking" : "working"}
    >
      <span className="flex min-w-0 items-center gap-1.5 pr-0.5" data-mono-rail-summary-split>
        <Mark
          aria-hidden
          className={`size-3.5 shrink-0 ${short.working || !short.stuck ? "text-content/45" : stuckColor}${Mark === Loader ? " animate-spin motion-reduce:animate-none" : ""}`}
          strokeWidth={1.75}
        />
        {short.working ? <span className="min-w-0 truncate">{short.working} working</span> : null}
        {short.working && short.waiting ? <span aria-hidden className="shrink-0">·</span> : null}
        {short.waiting ? <span className="min-w-0 truncate" data-mono-work-waiting>{short.waiting} waiting</span> : null}
        {(short.working || short.waiting) && short.stuck ? <span aria-hidden className="shrink-0">·</span> : null}
      </span>
      {short.stuck ? <StuckButton count={short.stuck} color={stuckColor} label="See what needs you" onOpen={onOpenStuck} /> : null}
    </div>
  );
}

/**
 * A Mono whose last turn failed, under its row (r27b). Only Ash can fix it (credits, sign-in, a request the model
 * refuses: the failure's error kind, turnFailure.ts): the red Needs you chip, the plain reason ("Out of credits") and
 * "Open <Lead>'s chat". It should come right by itself or with Try again (usage limit, overloaded, a dropped
 * connection): a grey ring named "Can't answer" and the reason, which opens its chat. Try again either way.
 */
/** r75: the Mono's own chat waits on Ash's answer: the red Needs you, the question on hover, Open <its> chat. */
/** r76 (Critiquito): just the red "Needs you" under the Mono's name; the row already opens its chat. The ask is on hover. */
function MonoWaitingLine({ monoId, chat }: { monoId: string; chat: WaitingChat }) {
  const title = [askText(chat.question), ...(chat.options ?? []).map((option, i) => `${i + 1}. ${option}`)].join("\n");
  return (
    <div className="ml-5 flex min-w-0 items-center px-1.5 text-[12px]" data-mono-waiting={monoId} title={title}>
      <ChipMark chip={NEEDS_YOU} />
    </div>
  );
}

function MonoFailedLine({ monoId, state, onOpen }: { monoId: string; state: MonoState; onOpen: () => void }) {
  const [trying, setTrying] = useState(false);
  const chip = failureChip(state.tone);
  const reason = state.activity ?? "Its last turn failed";
  const name = failedMonoName({ monoId });
  const retryButton = (
    <button
      type="button"
      disabled={trying}
      data-mono-failed-retry
      title="Try again"
      aria-label={trying ? "Trying again" : "Try again"}
      onClick={() => {
        setTrying(true);
        if (!retryMonoFailure(monoId)) setTrying(false);
      }}
      className="grid size-5 shrink-0 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content disabled:opacity-60"
    >
      <RotateCcw className={`size-3.5 ${trying ? "animate-spin motion-reduce:animate-none" : ""}`} strokeWidth={1.75} />
    </button>
  );
  return (
    <div
      className="ml-5 flex min-h-6 min-w-0 items-start gap-1 border-l border-content/10 py-0.5 pl-1.5"
      data-mono-failed={monoId}
      data-mono-failed-tone={state.tone === "red" ? "red" : "grey"}
      data-mono-failed-chip={chip.word}
      title={state.detail ?? state.activity}
    >
      {chip.tone === "red" ? (
        <span className="min-w-0 flex-1 px-1.5 text-[12px]">
          <NeedsYouChip reason={reason} lead={name} onOpenLead={onOpen} />
        </span>
      ) : (
        <button
          type="button"
          aria-label={`Open ${reason}`}
          onClick={onOpen}
          className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] text-content/60 hover:bg-content/6"
        >
          <ChipMark chip={chip} ringOnly />
          <span className="min-w-0 truncate" data-mono-failed-reason>
            {reason}
          </span>
        </button>
      )}
      {/* No spinning or working mark on a Needs you (Critiquito, r27c): only Ash can fix it, so Try again waits in
          its chat. A grey Can't answer keeps it. */}
      {chip.tone === "red" ? null : retryButton}
    </div>
  );
}

/**
 * Right-click menu for a Mono, like a project's: its name, mascot and color
 * up top, edited in place, then the actions.
 */
function MonoMenu({
  monoId,
  anchor,
  team,
  onOpenTeam,
  onBackground,
  onDelete,
  onDeleteChat,
  onClose,
}: {
  monoId: string;
  anchor: PopoverAnchor;
  /** Its team, if it has one: "Open team" opens it. */
  team?: TeamTarget;
  onOpenTeam: (team: TeamTarget) => void;
  onBackground: () => void;
  onDelete: () => void;
  onDeleteChat?: () => void;
  onClose: () => void;
}) {
  useSyncExternalStore(subscribeMonos, monosSnapshot);
  const mono = findMono(monoId);
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(mono?.name ?? "");

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  if (!mono) return null;
  const look = monoLook(mono);
  const commitName = () => {
    const next = (input.current?.value ?? name).trim().slice(0, 40);
    if (next !== (findMono(monoId)?.name ?? "")) editContactProfile(monoId, { name: next });
  };
  const itemClass =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-content/85 hover:bg-content/8";

  return (
    <Popover
      anchor={anchor}
      side="right"
      align="start"
      gap={0}
      width={280}
      constrainHeight={false}
      onDismiss={() => {
        commitName();
        onClose();
      }}
      role="menu"
      aria-label="Mono options"
      onContextMenu={(event) => event.preventDefault()}
      className="p-2"
    >
      <input
        ref={input}
        value={name}
        placeholder={defaultMonoName(mono.mascot)}
        maxLength={40}
        aria-label="Mono name"
        onChange={(event) => setName(event.target.value)}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commitName();
          onClose();
        }}
        className="mb-2 w-full rounded-lg border border-content/10 bg-content/5 px-2.5 py-1.5 text-[13px] text-content outline-none ring-accent/40 placeholder:text-content/45 focus:ring-1"
      />
      <div className="mb-2 flex flex-col gap-2">
        <MascotPicker
          current={look.mascot}
          color={look.color}
          onPick={(mascot) => saveMonoMascot(monoId, mascot)}
        />
        <ColorPicker
          inline
          current={look.color}
          onPick={(color) => updateMono(monoId, (mono) => ({ ...mono, color }))}
        />
      </div>
      <div role="separator" className="my-1 h-px bg-content/10" />
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          commitName();
          setContactPinned(monoId, mono.pinned !== true);
          onClose();
        }}
        className={itemClass}
      >
        {mono.pinned === true ? (
          <PinOff className="size-3.5 shrink-0" strokeWidth={1.75} />
        ) : (
          <Pin className="size-3.5 shrink-0" strokeWidth={1.75} />
        )}
        {mono.pinned === true ? "Unpin" : "Pin"}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          commitName();
          setContactMuted(monoId, mono.muted !== true);
          onClose();
        }}
        className={itemClass}
      >
        <BellOff className="size-3.5 shrink-0" strokeWidth={1.75} />
        {mono.muted === true ? "Unmute" : "Mute"}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          commitName();
          void duplicateContactWithFiles(monoId);
          onClose();
        }}
        className={itemClass}
      >
        <Copy className="size-3.5 shrink-0" strokeWidth={1.75} />
        Duplicate
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          input.current?.focus();
          input.current?.select();
        }}
        className={itemClass}
      >
        <Pencil className="size-3.5 shrink-0" strokeWidth={1.75} />
        Edit profile
      </button>
      {team ? (
        <button
          type="button"
          role="menuitem"
          data-mono-menu-open-team
          onClick={() => {
            commitName();
            onOpenTeam(team);
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-content/85 hover:bg-content/8"
        >
          <UserGroup className="size-3.5 shrink-0" strokeWidth={1.75} />
          Open {team.name}
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          commitName();
          onBackground();
        }}
        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-content/85 hover:bg-content/8"
      >
        <ImagePlus className="size-3.5 shrink-0" strokeWidth={1.75} />
        Background image
      </button>
      {onDeleteChat && mono.sessionId ? (
        <button
          type="button"
          role="menuitem"
          data-mono-menu-delete-chat
          onClick={() => {
            commitName();
            onDeleteChat();
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-red-400 hover:bg-content/8"
        >
          <Trash2 className="size-3.5 shrink-0" strokeWidth={1.75} />
          Delete chat…
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        onClick={onDelete}
        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-red-400 hover:bg-content/8"
      >
        <Trash2 className="size-3.5 shrink-0" strokeWidth={1.75} />
        Delete mono…
      </button>
    </Popover>
  );
}
