import { useEffect, useRef, useState } from "react";
import { Popover, type PopoverAnchor } from "../../../shared/ui/Popover";
import {
  Archive, Bot, Clock, DashboardSquare, Folder, Gauge, GitBranch, Globe, Inbox, MessageSquare, Palette, Shield, Sparkles,
  Star, StickyNote, Terminal, Wrench, Zap, type IconComponent,
} from "../../../shared/ui/icons";
import { hubData } from "../model/hubData";
import {
  isImageFileName, moveProject, pendingUndo, projectFileActions, projectIcon, projectLead, removeFromHub, renameProject, setProjectIcon,
  useProjectPrefsVersion, type ProjectIconChoice,
} from "../model/projectPrefs";
import type { HubProject } from "../model/types";

/** The icons a project can wear (the app's own set; no ghost). */
export const PROJECT_ICONS: Record<string, IconComponent> = {
  sparkles: Sparkles, palette: Palette, gauge: Gauge, folder: Folder, star: Star, zap: Zap, terminal: Terminal, bot: Bot,
  inbox: Inbox, shield: Shield, globe: Globe, wrench: Wrench, branch: GitBranch, dashboard: DashboardSquare,
  chat: MessageSquare, note: StickyNote, archive: Archive, clock: Clock,
};
export const PROJECT_EMOJI = ["🚀", "🎮", "🛠️", "📦", "🧪", "🌱", "🔥", "⭐", "🎨", "📈", "🧠", "💬", "🏠", "🍀", "🐝", "🌊"];

/** First letter, light, on a grey glass square: the default for every project. */
export function letterOf(project: Pick<HubProject, "name" | "shortName">): string {
  return ([...(project.shortName || project.name).trim()][0] ?? "?").toUpperCase();
}

/** What a project's tile shows: Ash's emoji, icon or image, else its first letter. Same size everywhere. */
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
  return (
    <span
      data-project-glyph="letter"
      aria-hidden
      style={{ width: size + 6, height: size + 6, fontSize: Math.round(size * 0.72) }}
      className="grid place-items-center rounded-[7px] bg-content/10 font-medium leading-none text-content/85 ring-1 ring-inset ring-content/10"
    >
      {letterOf(project)}
    </span>
  );
}

type Mode = { kind: "menu" } | { kind: "icon" } | { kind: "rename" } | { kind: "remove" };

/**
 * Right-click (or the hover "⋯") on a project: Change icon or image, Rename, Show folder in Finder, Move up / down,
 * then, below a divider, Remove from hub. Each opens a small popover in place; there is no settings page.
 */
export function ProjectMenu({ project, anchor, onClose }: { project: HubProject; anchor: PopoverAnchor; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>({ kind: "menu" });
  const ids = hubData().listProjects().map((p) => p.id);
  const at = ids.indexOf(project.id);
  if (mode.kind === "icon") return <IconChooser project={project} anchor={anchor} onClose={onClose} />;
  if (mode.kind === "rename") return <RenameProject project={project} anchor={anchor} onClose={onClose} />;
  if (mode.kind === "remove") return <RemoveFromHub project={project} anchor={anchor} onClose={onClose} />;
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
      {item("Change icon or image", () => setMode({ kind: "icon" }))}
      {item("Rename", () => setMode({ kind: "rename" }))}
      {item("Show folder in Finder", () => {
        if (project.folder) void projectFileActions().then((a) => a.showFolder(project.folder!));
        onClose();
      }, { disabled: !project.folder })}
      {item("Move up", () => { moveProject(ids, project.id, -1); onClose(); }, { disabled: at <= 0 })}
      {item("Move down", () => { moveProject(ids, project.id, 1); onClose(); }, { disabled: at < 0 || at >= ids.length - 1 })}
      <div role="separator" className="my-1 h-px bg-content/10" />
      {item("Remove from hub", () => setMode({ kind: "remove" }), { danger: true })}
    </Popover>
  );
}

function IconChooser({ project, anchor, onClose }: { project: HubProject; anchor: PopoverAnchor; onClose: () => void }) {
  const [tab, setTab] = useState<"emoji" | "icon">("emoji");
  const file = useRef<HTMLInputElement>(null);
  const pick = (choice: ProjectIconChoice | undefined) => {
    setProjectIcon(project.id, choice);
    onClose();
  };
  return (
    <Popover anchor={anchor} side="right" align="start" width={244} constrainHeight={false} role="dialog" aria-label="Project icon"
      onDismiss={onClose} className="flex flex-col gap-2 p-2" data-project-icon-chooser>
      <div className="flex items-center gap-1 text-[12px]">
        {(["emoji", "icon"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t}
            className={`rounded-md px-2 py-0.5 ${tab === t ? "bg-content/12 text-content" : "text-content/55 hover:bg-content/8"}`}>
            {t === "emoji" ? "Emoji" : "Icon"}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-6 gap-1" data-project-icon-grid={tab}>
        {tab === "emoji"
          ? PROJECT_EMOJI.map((e) => (
              <button key={e} type="button" aria-label={`Emoji ${e}`} onClick={() => pick({ kind: "emoji", emoji: e })}
                className="grid size-8 place-items-center rounded-md text-[18px] hover:bg-content/8">{e}</button>
            ))
          : Object.entries(PROJECT_ICONS).map(([name, Icon]) => (
              <button key={name} type="button" aria-label={`Icon ${name}`} onClick={() => pick({ kind: "icon", icon: name })}
                className="grid size-8 place-items-center rounded-md text-content/75 hover:bg-content/8 hover:text-content">
                <Icon className="size-4" strokeWidth={1.75} />
              </button>
            ))}
      </div>
      <div role="separator" className="h-px bg-content/10" />
      <div className="flex items-center gap-1">
        <button type="button" data-project-upload
          onClick={async () => {
            const actions = await projectFileActions();
            const img = await actions.pickImage(project.id);
            if (img) pick({ kind: "image", ...img });
          }}
          className="flex-1 rounded-md px-2 py-1 text-left text-[12px] text-content/80 hover:bg-content/8">
          Upload image…
        </button>
        <button type="button" data-project-icon-reset onClick={() => pick(undefined)}
          className="rounded-md px-2 py-1 text-[12px] text-content/55 hover:bg-content/8">
          Reset
        </button>
      </div>
      <input ref={file} type="file" hidden accept=".png,.jpg,.jpeg,.svg" onChange={() => undefined} />
      <span className="px-0.5 text-[11px] text-content/40">PNG, JPG or SVG. It's copied into the app, so moving the file later is fine.</span>
    </Popover>
  );
}

function RenameProject({ project, anchor, onClose }: { project: HubProject; anchor: PopoverAnchor; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const commit = () => {
    if (name.trim() && name.trim() !== project.name) renameProject(project.id, name);
    onClose();
  };
  return (
    <Popover anchor={anchor} side="right" align="start" width={230} constrainHeight={false} role="dialog" aria-label="Rename project"
      onDismiss={commit} className="p-2">
      <input ref={input} value={name} aria-label="Project name" maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") onClose(); }}
        className="w-full rounded-lg border border-content/10 bg-content/5 px-2.5 py-1.5 text-[13px] text-content outline-none focus:border-content/30" />
    </Popover>
  );
}

/**
 * The confirm, with friction to match the risk. Keeping the Lead (the default): a plain question, Cancel and Remove.
 * Taking the Lead too: Ash types the project's name first. Files and Ash OS's record are never touched; Undo follows.
 */
export function RemoveFromHub({ project, anchor, onClose }: { project: HubProject; anchor: PopoverAnchor; onClose: () => void }) {
  const lead = projectLead(project);
  const [removeLead, setRemoveLead] = useState(false);
  const [typed, setTyped] = useState("");
  const typedOk = typed.trim().toLowerCase() === project.name.trim().toLowerCase();
  const ready = !removeLead || typedOk;
  return (
    <Popover anchor={anchor} side="right" align="start" width={300} constrainHeight={false} role="alertdialog" aria-label={`Remove ${project.name} from the hub`}
      onDismiss={onClose} className="flex flex-col gap-2.5 p-3" data-project-remove-confirm={removeLead ? "with-lead" : "keep-lead"}>
      <div className="text-[13px] text-content">Remove {project.name} from hub?</div>
      <p className="text-[12px] leading-5 text-content/60" data-remove-what>
        Its files stay on disk.{lead ? (removeLead ? "" : ` ${lead.name} is kept.`) : ""}
      </p>
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
        <button type="button" onClick={onClose} className="rounded-md px-2.5 py-1 text-[12px] text-content/60 hover:bg-content/8">Cancel</button>
        <button type="button" data-project-remove disabled={!ready}
          onClick={() => { void removeFromHub(project, { retireLead: !!lead && removeLead }); onClose(); }}
          className="rounded-md bg-red-500/15 px-2.5 py-1 text-[12px] text-red-300 hover:bg-red-500/25 disabled:opacity-35">
          Remove
        </button>
      </div>
    </Popover>
  );
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
      className="sidebar-glass fixed bottom-4 left-20 z-50 flex items-center gap-3 rounded-lg px-3 py-2 text-[12px] text-content/85 shadow-lg ring-1 ring-content/10">
      <span>{pending.project.name} removed from the hub</span>
      <button type="button" onClick={() => void pending.undo()} className="rounded-md px-2 py-0.5 text-content hover:bg-content/10">Undo</button>
    </div>
  );
}

export { isImageFileName };
