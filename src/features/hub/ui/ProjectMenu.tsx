import { useEffect, useRef, useState } from "react";
import { Popover, type PopoverAnchor } from "../../../shared/ui/Popover";
import { CANCEL_FOCUS_RING } from "../../../shared/ui/ConfirmDelete";
import {
  Archive, Bot, Check, Clock, DashboardSquare, GitBranch, Inbox, MessageSquare, Shield,
  Star, StickyNote, Terminal, Wrench, Zap, type IconComponent,
} from "../../../shared/ui/icons";
import { hubData, liveHubStore } from "../model/hubData";
import { archiveCheck, archiveProject, renameProjectEverywhere, setProjectShape, setProjectShared, type ArchiveCheck } from "../model/projectActions";
import {
  isImageFileName, pendingUndo, projectFileActions, projectIcon, projectLead, removeFromHub, setProjectIcon,
  swapProjects, useProjectPrefsVersion, type ProjectIconChoice,
} from "../model/projectPrefs";
import { projectMonogram, projectMonogramClasses } from "../model/projectMonogram";
import { PROJECT_SHAPES, SHAPE_LABEL } from "../model/projectShapes";
import type { HubProject, ProjectIconShape } from "../model/types";
import { SHAPES } from "./projectShapeIcons";
import { codingTeamModelLine } from "../model/codingTeamModel";
import {
  DEFAULT_LIMITS, MAX_WORKERS, limitsLine, setWorkerLimits, workerLimits,
} from "../../monos/model/workerPool";
import { WorkerDefaultControl } from "../../crew/ui/WorkerDefaultControl";
import { BuilderScaleControls } from "../../monos/ui/BuilderScaleControls";
import { SpendLimitLine } from "../../usage/ui/SpendLimitLine";
import { plainErrorText } from "../../../shared/text/plainErrorText";
import { ProjectGroupChooser } from "./StripGroups";
import { readStripGroups, stripLayout, stripSectionNeighbour } from "../model/stripGroups";

/**
 * Icons a project could wear on this Mac before Ash OS kept its shape: still drawn for a choice stored back then.
 * New picks are Ash OS's shapes (SHAPES), which every device sees.
 */
export const PROJECT_ICONS: Record<string, IconComponent> = {
  ...SHAPES,
  zap: Zap, star: Star, terminal: Terminal, bot: Bot,
  inbox: Inbox, shield: Shield, wrench: Wrench, branch: GitBranch, dashboard: DashboardSquare,
  chat: MessageSquare, note: StickyNote, archive: Archive, clock: Clock,
};
export const PROJECT_EMOJI = ["🚀", "🎮", "🛠️", "📦", "🧪", "🌱", "🔥", "⭐", "🎨", "📈", "🧠", "💬", "🏠", "🍀", "🐝", "🌊"];

/**
 * A project's tile letters: its first letter, or its first two ("Hi", "Ha") when another project on the hub shares
 * that first letter. `others` is every project shown (it may include this one). WP-94: no longer drawn, because the
 * monogram (projectMonogram.ts) says more about a nameless project; kept for any caller that still asks for it.
 */
export function letterOf(project: Pick<HubProject, "id" | "name" | "shortName">, others: readonly Pick<HubProject, "id" | "name" | "shortName">[] = []): string {
  const chars = (p: Pick<HubProject, "name" | "shortName">) => [...(p.shortName || p.name).trim()];
  const own = chars(project);
  const first = (own[0] ?? "?").toUpperCase();
  const shared = others.some((o) => o.id !== project.id && (chars(o)[0] ?? "").toUpperCase() === first);
  return shared && own[1] ? first + own[1].toLowerCase() : first;
}

/**
 * What a project's tile shows: its shape from Ash OS, drawn grey (Ash picks it from the tile's menu), unless he gave it
 * an emoji or an image on this Mac. Same size everywhere.
 */
export function ProjectGlyph({ project, size = 18 }: { project: HubProject; size?: number }) {
  useProjectPrefsVersion();
  const choice = projectIcon(project.id);
  if (choice?.kind === "emoji")
    return <span data-project-glyph="emoji" aria-hidden style={{ fontSize: size, lineHeight: 1 }}>{choice.emoji}</span>;
  if (choice?.kind === "icon" && PROJECT_ICONS[choice.icon]) {
    const Icon = PROJECT_ICONS[choice.icon];
    return <Icon data-project-glyph="icon" style={{ width: size, height: size }} strokeWidth={1.75} />;
  }
  if (choice?.kind === "image")
    return <img data-project-glyph="image" alt="" src={choice.src} style={{ width: size + 4, height: size + 4 }} className="rounded-[6px] object-cover" />;
  // WP-94: a project with no icon of its own gets two letters from its name on a tile whose colour that name always
  // picks (projectMonogram.ts). "folder" is the shape every project is given when none was chosen, so it reads as
  // "no icon" rather than as an identity: a grey folder says nothing about which project it is.
  const Shape = project.iconShape === "folder" ? undefined : SHAPES[project.iconShape];
  if (Shape) return <Shape data-project-glyph="shape" data-project-shape={project.iconShape} aria-hidden style={{ width: size, height: size }} strokeWidth={1.75} />;
  return <ProjectMonogramTile name={project.name} size={size} />;
}

/** A project's letters on their own colour, as T3 Code draws a project with no icon. */
export function ProjectMonogramTile({ name, size }: { name: string; size: number }) {
  return (
    <span
      data-project-glyph="monogram"
      data-project-monogram={projectMonogram(name)}
      aria-hidden
      style={{ width: size + 6, height: size + 6, fontSize: Math.round(size * 0.56) }}
      className={`grid place-items-center rounded-[7px] font-medium leading-none ring-1 ring-inset ring-content/10 ${projectMonogramClasses(name)}`}
    >
      {projectMonogram(name)}
    </span>
  );
}

type Mode = { kind: "menu" } | { kind: "icon" } | { kind: "rename" } | { kind: "workers" } | { kind: "remove" } | { kind: "group" };

/**
 * Right-click (or the hover "⋯") on a project: Change icon or image, Rename, Show folder in Finder, Move up / down,
 * then, below a divider, Remove from hub. Each opens a small popover in place; there is no settings page.
 */
export function ProjectMenu({ project, anchor, onClose }: { project: HubProject; anchor: PopoverAnchor; onClose: () => void }) {
  const [shareProblem, setShareProblem] = useState<string>();
  const [mode, setMode] = useState<Mode>({ kind: "menu" });
  const projects = hubData().listProjects();
  const ids = projects.map((p) => p.id);
  // WP-137: the strip draws projects in no group first, then each group, so a move trades places with the neighbour in
  // the project's own section (as this window draws it), and is offered only when that neighbour is there.
  const strip = readStripGroups();
  const layout = stripLayout(projects, strip.groups, strip.assignments, strip.filterId);
  const above = stripSectionNeighbour(layout, project.id, -1);
  const below = stripSectionNeighbour(layout, project.id, 1);
  if (mode.kind === "icon") return <IconChooser project={project} anchor={anchor} onClose={onClose} />;
  if (mode.kind === "rename") return <RenameProject project={project} anchor={anchor} onClose={onClose} />;
  if (mode.kind === "workers") return <ProjectWorkers project={project} anchor={anchor} onClose={onClose} />;
  if (mode.kind === "remove") return <RemoveFromHub project={project} anchor={anchor} onClose={onClose} />;
  // WP-137: which group the project sits under on the strip.
  if (mode.kind === "group") return <ProjectGroupChooser project={project} anchor={anchor} onClose={onClose} />;
  const item = (label: string, run: () => void, opts: { disabled?: boolean; danger?: boolean } = {}) => (
    <button
      type="button"
      role="menuitem"
      disabled={opts.disabled}
      data-project-menu-item={label}
      onClick={run}
      className={`flex h-7 w-full items-center rounded-md px-2 text-left text-[13px] disabled:opacity-35 ${
        opts.danger ? "text-red-400 hover:bg-red-500/10" : "text-content hover:bg-content/8"
      }`}
    >
      {label}
    </button>
  );
  return (
    <Popover anchor={anchor} side="right" align="start" width={210} constrainHeight={false} role="menu" aria-label={`${project.name} options`}
      onDismiss={onClose} onContextMenu={(e) => e.preventDefault()} className="p-1" data-project-menu>
      {item("Change icon", () => setMode({ kind: "icon" }))}
      {item("Rename", () => setMode({ kind: "rename" }))}
      {/* WP-80: off until Ash clicks. The team switch in Settings decides whether a shared project is sent. */}
      {item(project.shared ? "Stop sharing with my team" : "Share with my team", () => {
        setShareProblem(undefined);
        // A failed change stays on screen with the menu open, so Ash sees why it did not go through.
        void setProjectShared(project, !project.shared).then(onClose, (reason) => setShareProblem(plainErrorText(reason)));
      })}
      {shareProblem ? (
        <p role="alert" className="px-2 py-1 text-[12px] leading-snug text-red-400">{shareProblem}</p>
      ) : null}
      {item("Group", () => setMode({ kind: "group" }))}
      {item("Workers at once", () => setMode({ kind: "workers" }))}
      {item("Show folder in Finder", () => {
        if (project.folder) void projectFileActions().then((a) => a.showFolder(project.folder!));
        onClose();
      }, { disabled: !project.folder })}
      {above ? item("Move up", () => { swapProjects(ids, project.id, above.id); onClose(); }) : null}
      {below ? item("Move down", () => { swapProjects(ids, project.id, below.id); onClose(); }) : null}
      <div role="separator" className="my-1 h-px bg-content/10" />
      {item("Remove from the app", () => setMode({ kind: "remove" }), { danger: true })}
    </Popover>
  );
}

function IconChooser({ project, anchor, onClose }: { project: HubProject; anchor: PopoverAnchor; onClose: () => void }) {
  useProjectPrefsVersion();
  const [tab, setTab] = useState<"shape" | "emoji">("shape");
  const [busy, setBusy] = useState<ProjectIconShape>();
  const [problem, setProblem] = useState<string>();
  const local = projectIcon(project.id);
  const pickLocal = (choice: ProjectIconChoice | undefined) => {
    setProjectIcon(project.id, choice);
    onClose();
  };
  const pickShape = (shape: ProjectIconShape) => {
    setBusy(shape);
    setProblem(undefined);
    void setProjectShape(project, shape).then(onClose, (e: unknown) => {
      setBusy(undefined);
      setProblem(plainErrorText(e));
    });
  };
  return (
    <Popover anchor={anchor} side="right" align="start" width={260} constrainHeight={false} role="dialog" aria-label="Project icon"
      onDismiss={onClose} className="flex flex-col gap-2 p-2" data-project-icon-chooser>
      <div className="flex items-center gap-1 text-[12px]">
        {(["shape", "emoji"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t}
            className={`rounded-md px-2 py-0.5 ${tab === t ? "bg-content/12 text-content" : "text-content/55 hover:bg-content/8"}`}>
            {t === "shape" ? "Shape" : "Emoji"}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1" data-project-icon-grid={tab}>
        {tab === "emoji"
          ? PROJECT_EMOJI.map((e) => (
              <button key={e} type="button" aria-label={`Emoji ${e}`} onClick={() => pickLocal({ kind: "emoji", emoji: e })}
                className="grid size-8 place-items-center rounded-md text-[18px] hover:bg-content/8">{e}</button>
            ))
          : PROJECT_SHAPES.map((shape) => {
              const Icon = SHAPES[shape];
              const on = !local && project.iconShape === shape;
              return (
                <button key={shape} type="button" aria-label={`Shape ${SHAPE_LABEL[shape]}`} aria-pressed={on} title={SHAPE_LABEL[shape]}
                  data-project-shape-choice={shape} disabled={!!busy} onClick={() => pickShape(shape)}
                  className={`grid size-8 place-items-center rounded-md hover:bg-content/8 hover:text-content disabled:opacity-50 ${on ? "bg-content/12 text-content" : "text-content/70"}`}>
                  <Icon className="size-4" strokeWidth={1.75} />
                </button>
              );
            })}
      </div>
      {problem ? <p className="px-0.5 text-[11px] leading-4 text-content/70" role="alert" data-project-icon-problem>{problem}</p> : null}
      <div role="separator" className="h-px bg-content/10" />
      <div className="flex items-center gap-1">
        <button type="button" data-project-upload
          onClick={async () => {
            const actions = await projectFileActions();
            const img = await actions.pickImage(project.id);
            if (img) pickLocal({ kind: "image", ...img });
          }}
          className="flex-1 rounded-md px-2 py-1 text-left text-[12px] text-content/80 hover:bg-content/8">
          Upload image…
        </button>
        {local ? (
          <button type="button" data-project-icon-reset onClick={() => pickLocal(undefined)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-content/55 hover:bg-content/8">
            <Check className="size-3" />Use the shape
          </button>
        ) : null}
      </div>
      <span className="px-0.5 text-[11px] text-content/40">
        {liveHubStore() ? "A shape is kept by the harness, so every device shows it. An emoji or image stays on this Mac." : "Kept on this Mac."}
      </span>
    </Popover>
  );
}

function RenameProject({ project, anchor, onClose }: { project: HubProject; anchor: PopoverAnchor; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const commit = () => {
    if (busy) return;
    if (!name.trim() || name.trim() === project.name) return onClose();
    setBusy(true);
    setProblem(undefined);
    void renameProjectEverywhere(project, name).then(onClose, (e: unknown) => {
      setBusy(false);
      setProblem(plainErrorText(e));
    });
  };
  return (
    <Popover anchor={anchor} side="right" align="start" width={250} constrainHeight={false} role="dialog" aria-label="Rename project"
      onDismiss={problem ? onClose : commit} className="flex flex-col gap-1.5 p-2">
      <input ref={input} value={name} aria-label="Project name" maxLength={60} disabled={busy}
        onChange={(e) => { setName(e.target.value); setProblem(undefined); }}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") onClose(); }}
        className="w-full rounded-lg border border-content/10 bg-content/5 px-2.5 py-1.5 text-[13px] text-content outline-none focus:border-content/30" />
      {problem ? <p className="px-0.5 text-[11px] leading-4 text-content/70" role="alert" data-project-rename-problem>{problem}</p> : null}
    </Popover>
  );
}

/**
 * How many workers the project's Lead runs at once, and how many of them on heavy tests (board H8; Ash, 16 Oct: "maybe
 * today I want, like, 10 or 20 parallel workers ... it's really a per-project thing"). The rest wait and start by
 * themselves. Telling the Lead in chat does the same.
 */
export function ProjectWorkers({ project, anchor, onClose }: { project: HubProject; anchor: PopoverAnchor; onClose: () => void }) {
  const [limits, setLimits] = useState(() => workerLimits(project.id));
  const change = (next: Partial<typeof limits>) => setLimits(setWorkerLimits(project.id, next));
  const field = (label: string, value: number, key: "workers" | "heavy", max: number) => (
    <label className="flex items-center justify-between gap-2 text-[13px] text-content">
      {label}
      <input type="number" min={1} max={max} value={value} aria-label={label} data-project-workers={key}
        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 1) change({ [key]: n }); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") onClose(); }}
        className="w-16 rounded-lg border border-content/10 bg-content/5 px-2 py-1 text-right text-[13px] text-content outline-none focus:border-content/30" />
    </label>
  );
  return (
    <Popover anchor={anchor} side="right" align="start" width={340} constrainHeight={false} role="dialog" aria-label={`${project.name} workers`}
      onDismiss={onClose} className="flex flex-col gap-2 p-2.5" data-project-workers-dialog>
      {field("Max builders", limits.workers, "workers", MAX_WORKERS)}
      {field("Of them on heavy tests", limits.heavy, "heavy", limits.workers)}
      {/* WP-161: pauses apply to every project. Running builders are not stopped. */}
      <BuilderScaleControls />
      {/* WP-176: this project's measured-cost limit. A running builder is not stopped. */}
      <SpendLimitLine project={project.id} harness={limits.cli} />
      <p className="text-[12px] leading-4 text-content/60" data-project-workers-line>
        {limitsLine(project.name, limits)} The rest wait their turn and start by themselves. You can also just tell its Lead.
      </p>
      {/* WP-89: the same control as Settings and the Mono, with this project's CLI. */}
      <WorkerDefaultControl scope="project" projectId={project.id} projectFolder={project.folder ?? undefined} />
      {/* E7: which model the coding team starts on (DeepSeek on High when set up), and why when it isn't. */}
      <p className="text-[12px] leading-4 text-content/60" data-project-model-line>{codingTeamModelLine(project.name)}</p>
      {limits.workers !== DEFAULT_LIMITS.workers || limits.heavy !== DEFAULT_LIMITS.heavy ? (
        <button type="button" onClick={() => change({ ...DEFAULT_LIMITS })} className="self-start text-[12px] text-content/55 hover:text-content">
          Back to {DEFAULT_LIMITS.workers} and {DEFAULT_LIMITS.heavy}
        </button>
      ) : null}
    </Popover>
  );
}

/**
 * The confirm, with friction to match the risk. Keeping the Lead (the default): a plain question, Cancel and Remove.
 * Taking the Lead too: Ash types the project's name first. With Ash OS there, it archives the project (asked first
 * what that leaves open); nothing is deleted, its asks, memory and folder stay, and Undo brings it back.
 */
export function RemoveFromHub({ project, anchor, onClose }: { project: HubProject; anchor: PopoverAnchor; onClose: () => void }) {
  const lead = projectLead(project);
  const live = !!liveHubStore();
  const [removeLead, setRemoveLead] = useState(false);
  const [typed, setTyped] = useState("");
  const [check, setCheck] = useState<ArchiveCheck>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // r61: a destructive confirm opens with Cancel focused (after the popover has placed itself).
  useEffect(() => {
    const t = setTimeout(() => cancelRef.current?.focus({ preventScroll: true }), 0);
    cancelRef.current?.focus({ preventScroll: true });
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!live) return;
    let on = true;
    archiveCheck(project.id).then((c) => on && setCheck(c), (e: unknown) => on && setProblem(plainErrorText(e)));
    return () => { on = false; };
  }, [live, project.id]);
  const typedOk = typed.trim().toLowerCase() === project.name.trim().toLowerCase();
  const ready = (!removeLead || typedOk) && !busy;
  const remove = () => {
    setBusy(true);
    setProblem(undefined);
    const hide = live ? { hide: () => archiveProject(project.id, true), unhide: () => archiveProject(project.id, false) } : undefined;
    void removeFromHub(project, { retireLead: !!lead && removeLead, hide }).then(onClose, (e: unknown) => {
      setBusy(false);
      setProblem(plainErrorText(e));
    });
  };
  return (
    <Popover anchor={anchor} side="right" align="start" width={300} constrainHeight={false} role="alertdialog" aria-label={`Remove ${project.name} from the app`}
      onDismiss={onClose} className="flex flex-col gap-2.5 p-3" data-project-remove-confirm={removeLead ? "with-lead" : "keep-lead"}>
      <div className="text-[13px] text-content">Remove {project.name} from hub?</div>
      <p className="text-[12px] leading-5 text-content/60" data-remove-what>
        Its files stay on disk.{lead ? (removeLead ? "" : ` ${lead.name} is kept.`) : ""}
      </p>
      {check ? (
        <p className="text-[12px] leading-5 text-content/60" data-remove-open>
          {openLine(check)} Nothing is deleted, and you can bring it back.
        </p>
      ) : null}
      {lead ? (
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="Its Lead">
          {[false, true].map((remove) => (
            <label key={String(remove)} className="flex cursor-default items-center gap-2 rounded-md px-1.5 py-1 text-[12px] text-content/85 hover:bg-content/5">
              <input type="radio" name="lead" checked={removeLead === remove} onChange={() => setRemoveLead(remove)} data-lead-choice={remove ? "remove" : "keep"} />
              {remove ? `Retire ${lead.name} too` : `Keep ${lead.name}`}
            </label>
          ))}
        </div>
      ) : null}
      {lead && removeLead ? (
        <>
          <p className="text-[12px] leading-5 text-content/60" data-remove-lead-note>
            {lead.name}'s chats and memory will be archived, not deleted. You can undo it in Changes.
          </p>
          <label className="flex flex-col gap-1 text-[11px] text-content/55">
            Type {project.name} to confirm
            <input value={typed} aria-label="Project name to confirm" onChange={(e) => setTyped(e.target.value)} autoFocus
              className="rounded-md border border-content/15 bg-content/3 px-2 py-1.5 text-[12px] text-content outline-none focus:border-content/35" />
          </label>
        </>
      ) : null}
      <div className="flex justify-end gap-1.5 pt-1">
        {/* r61 (PM's D4): Cancel has the focus, with a visible ring, so Enter cancels (as in ConfirmDelete). */}
        <button type="button" ref={cancelRef} data-project-remove-cancel onClick={onClose}
          className={`rounded-md px-2.5 py-1 text-[12px] text-content/60 hover:bg-content/8 ${CANCEL_FOCUS_RING}`}>Cancel</button>
        <button type="button" data-project-remove disabled={!ready}
          onClick={remove}
          className="rounded-md bg-red-500/15 px-2.5 py-1 text-[12px] text-red-300 hover:bg-red-500/25 disabled:opacity-35">
          Remove
        </button>
      </div>
      {problem ? <p className="text-[12px] leading-5 text-content/70" role="alert" data-remove-problem>{problem}</p> : null}
    </Popover>
  );
}

/** "It has 3 open asks and 1 thing waiting on you." */
export function openLine(c: Pick<ArchiveCheck, "openAsks" | "openNeeds">): string {
  if (!c.openAsks && !c.openNeeds) return "Nothing in it is open.";
  const asks = `${c.openAsks} open ${c.openAsks === 1 ? "ask" : "asks"}`;
  const needs = `${c.openNeeds} ${c.openNeeds === 1 ? "thing" : "things"} waiting on you`;
  return `It has ${c.openAsks && c.openNeeds ? `${asks} and ${needs}` : c.openAsks ? asks : needs}.`;
}

/** "EXO game removed from the hub · Undo", for ten seconds. */
export function RemovedUndoToast() {
  useProjectPrefsVersion();
  const [, tick] = useState(0);
  const pending = pendingUndo();
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => tick((n) => n + 1), 1000);
    return () => clearTimeout(t);
  });
  if (!pending) return null;
  return (
    <div role="status" data-project-undo
      className="sidebar-glass fixed bottom-14 left-20 z-50 flex items-center gap-3 rounded-lg px-3 py-2 text-[12px] text-content/85 shadow-lg ring-1 ring-content/10">
      <span>{pending.project.name} removed from the app</span>
      <button type="button" aria-label={`Undo: ${pending.project.name} removed from the app`} onClick={() => void pending.undo()} className="rounded-md px-2 py-0.5 text-content hover:bg-content/10">Undo</button>
    </div>
  );
}

export { isImageFileName };
