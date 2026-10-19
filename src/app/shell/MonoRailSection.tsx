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
import { ImagePlus, MoreHorizontal, Plus, Trash2 } from "../../shared/ui/icons";
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

/** A Mono's unread count as its badge shows it. */
export function unreadBadge(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function unreadLabel(count: number): string {
  return count === 1 ? "1 new reply" : `${count} new replies`;
}

/**
 * Which Monos the rail lists, in order. The hub (`rank` set) shows one global list, the same on every project:
 * the default four, then every project's Lead (hubMonoRank). Plain Monocode can still filter by project folder.
 */
export function railMonos<M extends { id: string; name?: string; projects: string[] }>(
  list: M[],
  projectFilter: string | undefined,
  rank: ((mono: M) => number) | undefined,
): M[] {
  if (!rank) return list.filter((mono) => !projectFilter || mono.projects.includes(projectFilter));
  return list.map((m, i) => ({ m, i, r: rank(m) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.m);
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
   * keeps its one global list here too.
   */
  project?: string;
}) {
  const snapshot = useSyncExternalStore(subscribeMonos, monosSnapshot);
  useRoleNamesVersion();
  useWaitingSoulsVersion();
  const waiting = rank ? waitingSouls() : [];
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
        <span
          className={`min-w-0 flex-1 truncate${
            project ? "" : " px-1 text-xs leading-5 text-content/50"
          }`}
        >
          Monos
        </span>
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
      {rank && roleNamesUndecided() && monos.some((m) => shown(monoLook(m).name).secondary) ? (
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
      {waiting.length ? (
        <div className="mx-2 mb-1.5 flex flex-col gap-px" data-souls-waiting>
          {waiting.map((w) => (
            <div key={w.monoId} className="rounded-md border border-dashed border-content/25 px-2 py-1 text-[13px] leading-tight">
              <span className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-content/80">{w.name}</span>
                <button type="button" onClick={() => void seatWaitingSoul(w.monoId)} className="shrink-0 rounded px-1 text-[11px] text-content/70 hover:bg-content/8 hover:text-content">OK</button>
                <button type="button" onClick={() => dismissWaitingSoul(w.monoId)} className="shrink-0 rounded px-1 text-[11px] text-content/70 hover:bg-content/8 hover:text-content">Not now</button>
              </span>
              <span className="block text-[11px] text-content/50">Waiting for your OK</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className={`flex flex-col gap-px${project ? "" : " px-2"}`}>
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
          const status =
            state.status === "idle"
              ? undefined
              : (state.activity ?? MONO_STATUS_LABEL[state.status]);
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
