import { Fragment } from "react";
import { dismissWaitingSoul, seatWaitingSoul, useWaitingSoulsVersion, waitingSouls } from "../../features/hub/model/setupSouls";
import { plainName, roleNamesUndecided, setRoleNames, useRoleNamesVersion } from "../../features/hub/model/roleNames";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CheckCircle, ChevronDown, CircleAlert, CircleX, Clock, ImagePlus, Loader, MoreHorizontal, Plus, Trash2 } from "../../shared/ui/icons";
import { delegationActions, useDelegationRows } from "../../features/monos/model/delegationStore";
import { childChatsByMono, type ChildChat } from "../../features/monos/model/delegationView";
import { countWork, delegationLine, useStuckDismissalsVersion, workSplit, type StuckWorker } from "../../features/monos/model/workerStuck";
import { shownSubChats, subChatAttention, subChatsOpen, toggleSubChats, useSubChatFolds } from "../../features/monos/model/subChats";
import { useClock } from "../../features/monos/hooks/useStuckWorkers";
import { Popover, type PopoverAnchor } from "../../shared/ui/Popover";
import { Shimmer } from "../../shared/ui/Shimmer";
import { useAnimatedReorder } from "../../shared/hooks/useAnimatedReorder";
import { MonoRailMascot } from "../../features/monos/ui/MonoRailMascot";
import { MonoIntroCard } from "../../features/monos/ui/MonoIntro";
import { ensureBuiltInMonos } from "../../features/hub/model/builtInMonos";
import { RailAction } from "./RailAction";
import { saveMonosEnabled } from "../../features/settings/model/settings";
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
  saveMonoName,
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
  /** Hub mode: list only the Monos that work on this project folder. */
  projectFilter?: string;
  /** Hub mode: one flat list, sorted by this rank (lower first; ties keep their order). No headers. */
  rank?: (mono: { id: string; name?: string }) => number;
};

const IDLE: MonoState = { status: "idle" };

/** A child chat's state as a small mark: working, asking its Lead, stuck, done, failed or stopped. */
function ChildChatMark({ state, stalled }: { state: ChildChat["state"]; stalled?: boolean }) {
  const props = { className: "size-3.5 shrink-0", strokeWidth: 1.75 };
  if (state === "running" && stalled) return <CircleAlert {...props} className={`${props.className} text-amber-400`} />;
  if (state === "running")
    return <Loader {...props} className={`${props.className} animate-spin text-content/50 motion-reduce:animate-none`} />;
  if (state === "question") return <Clock {...props} className={`${props.className} text-amber-400`} />;
  if (state === "completed") return <CheckCircle {...props} className={`${props.className} text-emerald-400/90`} />;
  if (state === "failed") return <CircleAlert {...props} className={`${props.className} text-red-400`} />;
  return <CircleX {...props} className={`${props.className} text-content/40`} />;
}

/** The Mono's own mark when a sub-chat is stuck: the most urgent one's (red failed, amber stalled, amber clock asking). */
function MonoStuckMark({ stuck }: { stuck: readonly StuckWorker[] }) {
  if (!stuck.length) return null;
  const kind = stuck.some((s) => s.kind === "failed") ? "failed" : stuck.some((s) => s.kind === "stalled") ? "stalled" : "asking";
  const Icon = kind === "asking" ? Clock : CircleAlert;
  return (
    <span
      aria-hidden
      data-mono-stuck={stuck.length}
      data-mono-stuck-kind={kind}
      className="flex shrink-0 items-center group-hover:hidden group-has-[button:focus-visible]:hidden"
    >
      <Icon className={`size-3.5 ${kind === "failed" ? "text-red-400" : "text-amber-400"}`} strokeWidth={1.75} />
    </span>
  );
}

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
export function railMonos<M extends { id: string; name?: string; projects: string[] }>(
  list: M[],
  projectFilter: string | undefined,
  rank: ((mono: M) => number) | undefined,
): M[] {
  const eligible = list.filter((mono) => !projectFilter || mono.projects.includes(projectFilter));
  if (!rank) return eligible;
  return eligible.map((m, i) => ({ m, i, r: rank(m) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.m);
}

/**
 * The user's Monos, above the projects. Each opens like a project does, but
 * into its conversation; none belongs to a project, so they get a section of
 * their own and the shaded mascot rather than a project's flat one.
 */
export function MonoRailSection({
  activeId,
  states,
  unseenCounts,
  onOpen,
  onCreate,
  onDelete,
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
  // Delegated work nests under the Mono that started it (Ash, 19 Oct); a Mono with work out reads "Waiting on N".
  const delegationRows = useDelegationRows();
  const now = useClock();
  useStuckDismissalsVersion();
  useSubChatFolds();
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
  const [soulProblems, setSoulProblems] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const noteSoulProblems = (monoId: string, problems: readonly string[]) =>
    setSoulProblems((current) => {
      const next = new Map(current);
      if (problems.length) next.set(monoId, problems);
      else next.delete(monoId);
      return next;
    });
  const seatSoul = (monoId: string, name: string) => {
    noteSoulProblems(monoId, []);
    void seatWaitingSoul(monoId).then(
      (problems) => noteSoulProblems(monoId, problems),
      (error: unknown) =>
        noteSoulProblems(monoId, [`Couldn't seat ${name}: ${error instanceof Error ? error.message : String(error)}`]),
    );
  };
  // Role names are a hub thing; plain Monocode keeps the Monos' own names.
  const shown = (name: string) => (rank ? plainName(name) : { primary: name });
  const monos = useMemo(
    () =>
      railMonos(listMonos(), projectFilter, rank).filter(
        (mono) => !!rank || !project || monoWorksOn(mono, project),
      ),
    [snapshot, projectFilter, rank, project],
  );
  const ids = monos.map((mono) => mono.id);
  const sortable = useAnimatedReorder(ids, reorderMonos, "y");
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem("monocode:mono-rail-collapsed") === "1"; } catch { return false; } });
  const toggleCollapsed = () => setCollapsed((value) => {
    try { localStorage.setItem("monocode:mono-rail-collapsed", value ? "0" : "1"); } catch { /* optional preference */ }
    return !value;
  });
  const [menu, setMenu] = useState<{ id: string; anchor: PopoverAnchor }>();
  const [background, setBackground] = useState<string>();
  const backgroundMono = background ? findMono(background) : undefined;

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
          aria-label={collapsed ? "Expand Monos" : "Collapse Monos"}
          className={`flex min-w-0 flex-1 items-center gap-1 rounded text-left hover:text-content${
            project ? "" : " px-1 text-xs leading-5 text-content/50"
          }`}
        >
          <ChevronDown
            className={`size-3 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
          <span className="truncate">Monos</span>
          {collapsed ? <span className="ml-1 text-content/35">{monos.length}</span> : null}
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
      {!collapsed && rank && roleNamesUndecided() && monos.some((m) => shown(monoLook(m).name).secondary) ? (
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
            <div key={w.monoId} className="rounded-md border border-dashed border-content/25 px-2 py-1 text-[13px] leading-tight">
              <span className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-content/80">{w.name}</span>
                <button type="button" onClick={() => seatSoul(w.monoId, w.name)} className="shrink-0 rounded px-1 text-[11px] text-content/70 hover:bg-content/8 hover:text-content">OK</button>
                <button type="button" onClick={() => dismissWaitingSoul(w.monoId)} className="shrink-0 rounded px-1 text-[11px] text-content/70 hover:bg-content/8 hover:text-content">Not now</button>
              </span>
              <span className="block text-[11px] text-content/50">Waiting for your OK</span>
              {soulProblems.get(w.monoId)?.length ? (
                <span role="alert" className="mt-0.5 flex items-start gap-1 text-[11px] leading-4 text-red-400">
                  <CircleAlert className="mt-px size-3 shrink-0" strokeWidth={1.75} />
                  <span className="min-w-0">{soulProblems.get(w.monoId)!.join(" ")}</span>
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
        className={`${collapsed ? "hidden" : "flex"} max-h-[40vh] flex-col gap-px overflow-y-auto${
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
          const selected = mono.id === activeId;
          const unseen = selected ? 0 : (unseenCounts?.get(mono.id) ?? 0);
          const projects = look.projects.length
            ? monoProjectsPhrase(look.projects)
            : "No projects yet";
          const children = childChats.get(mono.id) ?? [];
          // What it has out, split (Ash, 20 Oct): "2 working · 1 asking · 1 stuck". Idle shows nothing else, unless it
          // waits on something (a watched pull request's CI); busy, its own status first, then what is stuck.
          const attention = subChatAttention(children, now);
          const counts = countWork(children.map((chat) => chat.row), now);
          const stuckSplit = workSplit({ ...counts, working: 0 });
          const status =
            state.status === "idle"
              ? (state.activity ?? workSplit(counts))
              : [state.activity ?? MONO_STATUS_LABEL[state.status], stuckSplit].filter(Boolean).join(" · ");
          return (
            <Fragment key={mono.id}>
            <div
              ref={(el) => sortable.setItemRef(mono.id, el)}
              data-selected={selected || undefined}
              data-mono-status={state.status}
              className={`reorder-item project-reorder-item group relative flex h-8 cursor-default touch-none items-stretch rounded-md px-2 ${
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
                onOpen(mono.id);
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
                title={[look.name, projects, status].filter(Boolean).join("\n")}
                aria-label={[
                  look.name,
                  status ?? "idle",
                  unseen ? unreadLabel(unseen) : undefined,
                  projects,
                ]
                  .filter(Boolean)
                  .join(", ")}
                aria-current={selected ? "true" : undefined}
                className="flex min-w-0 flex-1 cursor-default items-center gap-2 text-left transition-[padding] duration-150 motion-reduce:transition-none group-hover:pr-6 group-has-[button:focus-visible]:pr-6"
              >
                <MonoRailMascot
                  name={look.mascot}
                  color={look.color}
                  status={state.status}
                />
                {state.status === "working" ? (
                  <Shimmer
                    as="span"
                    duration={1.4}
                    className="min-w-0 flex-1 truncate text-sm font-medium leading-tight"
                  >
                    {shown(look.name).primary}
                  </Shimmer>
                ) : (
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-tight">
                    <span className="min-w-0 truncate text-sm font-medium" data-mono-primary-name>
                      {shown(look.name).primary}
                    </span>
                    {shown(look.name).secondary ? (
                      <span className="shrink-0 text-xs font-normal text-content/45" data-mono-own-name>
                        {shown(look.name).secondary}
                      </span>
                    ) : null}
                  </span>
                )}
                <MonoStuckMark stuck={[...attention.stuck.values()]} />
                {unseen ? (
                  <span
                    aria-hidden
                    data-mono-unread={unseen}
                    className="grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-accent px-1 text-[10px] font-medium tabular-nums leading-none text-white group-hover:hidden group-has-[button:focus-visible]:hidden"
                  >
                    {unreadBadge(unseen)}
                  </span>
                ) : null}
              </button>
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
            {children.length ? (
              <MonoSubChats monoId={mono.id} children={children} attention={attention} stuckSplit={stuckSplit} now={now} />
            ) : null}
            </Fragment>
          );
        })}
      </div>
      {menu ? (
        <MonoMenu
          key={menu.id}
          monoId={menu.id}
          anchor={menu.anchor}
          onBackground={() => {
            setMenu(undefined);
            setBackground(menu.id);
          }}
          onDelete={() => {
            setMenu(undefined);
            onDelete(menu.id);
          }}
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
 * A Mono's sub-chats (its delegated work), folded under a count unless Ash opened them or one is stuck, six at a time.
 * One click on a sub-chat opens it under its Mono.
 */
function MonoSubChats({
  monoId,
  children,
  attention,
  stuckSplit,
  now,
}: {
  monoId: string;
  children: readonly ChildChat[];
  attention: ReturnType<typeof subChatAttention>;
  stuckSplit: string | undefined;
  now: number;
}) {
  const [all, setAll] = useState(false);
  const open = subChatsOpen(monoId, attention.key);
  const { shown, more } = shownSubChats(children, attention.stuck, all);
  const count = `${children.length} ${children.length === 1 ? "sub-chat" : "sub-chats"}`;
  return (
    <div className="ml-5 flex flex-col gap-px border-l border-content/10 pb-0.5 pl-1.5">
      <button
        type="button"
        data-mono-children-toggle={monoId}
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} ${count}${stuckSplit ? `, ${stuckSplit}` : ""}`}
        onClick={() => toggleSubChats(monoId, attention.key)}
        className="flex h-6 min-w-0 cursor-default items-center gap-1 rounded-md px-1.5 text-left text-[12px] text-content/45 hover:bg-content/6 hover:text-content"
      >
        <ChevronDown
          aria-hidden
          className={`size-3 shrink-0 transition-transform motion-reduce:transition-none ${open ? "" : "-rotate-90"}`}
        />
        <span className="min-w-0 truncate">
          {count}
          {!open && stuckSplit ? ` · ${stuckSplit}` : ""}
        </span>
      </button>
      {open ? (
        <div data-mono-children={monoId} className="flex flex-col gap-px">
          {shown.map((chat) => {
            const stalled = chat.state === "running" && !!chat.row.stallKind;
            const line = delegationLine(chat.row, now);
            return (
              <button
                key={chat.sessionId}
                type="button"
                data-mono-child={chat.sessionId}
                data-state={stalled ? "stalled" : chat.state}
                title={`${chat.title}, ${line}`}
                aria-label={`Open ${chat.title}, ${line}`}
                onClick={() => delegationActions()?.openChild(chat.ownerSession, chat.sessionId)}
                className="flex h-6 min-w-0 cursor-default items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] text-content/60 hover:bg-content/6 hover:text-content"
              >
                <ChildChatMark state={chat.state} stalled={stalled} />
                <span className="min-w-0 truncate">{chat.title}</span>
              </button>
            );
          })}
          {more ? (
            <button
              type="button"
              data-mono-children-more={monoId}
              onClick={() => setAll(true)}
              className="flex h-6 min-w-0 cursor-default items-center rounded-md px-1.5 pl-6 text-left text-[12px] text-content/45 hover:bg-content/6 hover:text-content"
            >
              Show {more} more
            </button>
          ) : null}
        </div>
      ) : null}
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
  onBackground,
  onDelete,
  onClose,
}: {
  monoId: string;
  anchor: PopoverAnchor;
  onBackground: () => void;
  onDelete: () => void;
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
    const next = name.trim().slice(0, 40);
    if (next !== (findMono(monoId)?.name ?? "")) saveMonoName(monoId, next);
  };

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
          onBackground();
        }}
        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-content/85 hover:bg-content/8"
      >
        <ImagePlus className="size-3.5 shrink-0" strokeWidth={1.75} />
        Background image
      </button>
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
