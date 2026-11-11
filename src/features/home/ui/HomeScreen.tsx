// Home. Orbit's column and entrance, restyled: no counters, no status icons, no view-all links.
// HomePage.tsx imports Orbit data hooks and shows those, so this screen is not a copy of that file.

import { useState, type ReactNode } from "react";
import { sectionKey, type HomeArrangement, type SectionRef } from "../model/arrangement";
import type { HomeLine, HomeLineKind } from "../model/lines";
import { FREE_UP_SPACE } from "../../monos/model/builderScale";
import { ArrowUp } from "../../../shared/ui/icons";
import type { CatalogPanel } from "../../panels/model/panelTabs";
import { HOME_MAX_WIDTH, HOME_STAGGER_MS } from "../vendor/homeLayout";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import "./home.css";

const TITLE: Record<string, string> = {
  "needs-you": "Needs you",
  projects: "Projects",
  "moving-now": "Moving now",
  recent: "Recent",
};

export type HomeNote = {
  id: string;
  kind: string;
  text: string;
  projectId: string;
};

export function sectionTitle(ref: SectionRef, catalog: readonly CatalogPanel[]): string {
  if (ref.kind === "builtin") return TITLE[ref.id] ?? ref.id;
  return catalog.find((panel) => panel.plugin === ref.plugin && panel.panelId === ref.panelId)?.title || "Pinned panel";
}

function noteLine(note: HomeNote): HomeLine {
  const kind: HomeLineKind = note.kind === "doc" || note.kind === "chat" || note.kind === "decision" ? note.kind : "moving";
  return { id: `${note.kind}:${note.id}`, kind, text: note.text, projectId: note.projectId, target: note.id, at: 0 };
}

const ROW_ACTIONS = 3;

function NeedActions({ actions }: { actions: readonly { label: string; run: () => void }[] }) {
  return actions.slice(0, ROW_ACTIONS).map((action, index) => {
    const run = (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      action.run();
    };
    // Open chat is the bordered button on a stopped row, not the blue primary.
    if (index === 0 && action.label !== "Open chat") {
      return (
        <button
          key={action.label}
          type="button"
          data-needs-answer=""
          className="primary-action shrink-0 rounded-md border border-transparent px-2.5 py-1 text-[12px] font-medium focus-visible:outline-2 focus-visible:outline-accent"
          onClick={run}
        >
          {action.label}
        </button>
      );
    }
    return (
      <SecondaryButton key={action.label} {...(index === 0 ? { "data-needs-answer": "" } : {})} onClick={run}>
        {action.label}
      </SecondaryButton>
    );
  });
}

function NeedRow({ line, onOpen }: { line: HomeLine; onOpen: (line: HomeLine) => void }) {
  const actions = line.actions ?? [];
  const chip = line.projectName?.trim();
  if (actions.length === 0 && line.kind !== "stopped") {
    return (
      <button
        type="button"
        data-home-line={line.kind}
        className="flex min-h-10 w-full items-center border-t border-stroke px-3 py-1.5 text-left text-[13px] text-content hover:bg-content/8"
        onClick={() => onOpen(line)}
      >
        <span className="min-w-0 flex-1 truncate">{line.text}</span>
      </button>
    );
  }
  return (
    <div
      data-home-line={line.kind}
      data-needs-project={line.projectId || undefined}
      className="flex min-h-10 w-full flex-wrap items-center gap-3 border-t border-stroke px-3 py-1.5 text-[13px] text-content"
    >
      {chip ? (
        <span data-needs-chip className="shrink-0 rounded-md bg-content/10 px-1.5 py-0.5 text-[11px] font-medium text-content/80">
          {chip}
        </span>
      ) : null}
      {line.kind === "stopped" ? (
        <span className="min-w-0 flex-1">
          <span data-needs-stopped className="font-medium text-red-400">Stopped.</span>
          {line.text ? ` ${line.text}` : null}
        </span>
      ) : (
        <button
          type="button"
          aria-label={chip ? `${chip} · ${line.text}` : undefined}
          className="min-w-0 flex-1 truncate text-left"
          onClick={() => onOpen(line)}
        >
          {line.text}
        </button>
      )}
      <NeedActions actions={actions} />
    </div>
  );
}

function Notes({ notes, onOpen }: { notes: readonly HomeNote[]; onOpen: (line: HomeLine) => void }) {
  return notes.map((note) => (
    <button
      key={`${note.kind}:${note.id}`}
      type="button"
      data-home-line={note.kind}
      className="flex min-h-10 w-full items-center px-1 py-1.5 text-left text-[13px] text-content hover:underline"
      onClick={() => onOpen(noteLine(note))}
    >
      <span className="min-w-0 flex-1 truncate">{note.text}</span>
    </button>
  ));
}

/**
 * The chat at the top of Home. It stays there whether or not the sections have lines.
 * WP-88: this is the Chief of Staff's chat, not a button that leaves Home.
 */
export function HomeChatBox({
  reply,
  onAsk,
  onOpen,
}: {
  reply?: { text?: string; notes?: readonly HomeNote[] };
  onAsk: (text: string) => void;
  onOpen: (line: HomeLine) => void;
}) {
  const [text, setText] = useState("");
  const notes = reply?.notes ?? [];
  const ready = text.trim().length > 0;
  return (
    <div data-home-start="" className="flex flex-col">
      <form
        className="flex items-center gap-2 rounded-xl border border-stroke bg-content/[0.03] py-1.5 pr-1.5 pl-4 transition-colors focus-within:border-content/30"
        onSubmit={(event) => {
          event.preventDefault();
          // An empty ask is not a question: nothing to answer, so nothing is said.
          if (!ready) return;
          onAsk(text);
        }}
      >
        <input
          aria-label="Ask"
          value={text}
          placeholder="Ask what's happening, or tell a project what to do"
          onChange={(event) => setText(event.target.value)}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-[14px] text-content outline-none placeholder:text-content/40"
        />
        <button
          type="submit"
          aria-label="Send"
          title="Send"
          disabled={!ready}
          // The same send button as a chat's composer (MonoComposer.tsx).
          className="primary-action grid size-7 shrink-0 place-items-center rounded-md transition-[background-color,color,transform] duration-150 active:scale-90 disabled:cursor-default"
        >
          <ArrowUp className="size-3.5" strokeWidth={2} aria-hidden />
        </button>
      </form>
      {reply?.text || notes.length > 0 ? (
        <div data-home-reply className="mt-2 rounded-xl border border-stroke px-4 py-2">
          {reply?.text ? <p className="py-1 text-[13px] text-content">{reply.text}</p> : null}
          {notes.length > 0 ? <Notes notes={notes} onOpen={onOpen} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Home's state when the app holds no project yet: why, and the way to get one. */
export type NoProjects = {
  /** The projects are still in Ash OS, which didn't answer when the app last asked. */
  inAshOs: boolean;
  /** How the last "Bring them over" went, in one line. */
  outcome?: string;
  busy?: boolean;
};

function NoProjectsNote({
  state,
  onBringOver,
  onNewProject,
}: {
  state: NoProjects;
  onBringOver?: () => void;
  onNewProject?: () => void;
}) {
  return (
    <div data-home-no-projects className="flex flex-col items-start gap-2 rounded-xl border border-stroke px-4 py-3">
      <p className="text-[13px] text-content">
        {state.inAshOs
          ? "Your projects haven't come over from Ash OS yet. Bring them over: it only adds, and Ash OS isn't changed."
          : "No projects yet. Add one to give it a coding team and its own Monos."}
      </p>
      {state.outcome ? <p data-home-import-outcome className="text-[13px] text-content/70">{state.outcome}</p> : null}
      <div className="flex items-center gap-4">
        {state.inAshOs && onBringOver ? (
          <button
            type="button"
            data-home-action="bring-over"
            disabled={state.busy}
            className="text-[13px] text-content underline-offset-2 hover:underline disabled:text-content/40"
            onClick={onBringOver}
          >
            {state.busy ? "Bringing them over…" : "Bring them over"}
          </button>
        ) : null}
        {onNewProject ? (
          <button
            type="button"
            data-home-action="new-project"
            className="text-[13px] text-content underline-offset-2 hover:underline"
            onClick={onNewProject}
          >
            New project
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Control({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button type="button" className="text-[12px] text-content/70 underline-offset-2 hover:underline" onClick={onClick}>
      {name}
    </button>
  );
}

export function HomeScreen({
  needsYou,
  projects = [],
  noProjects,
  onBringOver,
  onNewProject,
  moving,
  recent,
  arrangement,
  catalog,
  known,
  failed,
  summary,
  reply,
  onOpen,
  onMove,
  onHide,
  onShow,
  onPin,
  onUnpin,
  onAsk,
  renderPanel,
  programme,
  needsMark = 0,
}: {
  needsYou: readonly HomeLine[];
  /** One line per project (the overview). */
  projects?: readonly HomeLine[];
  /** Set when the app holds no project: Home says why instead of "All quiet." */
  noProjects?: NoProjects;
  onBringOver?: () => void;
  onNewProject?: () => void;
  moving: readonly HomeLine[];
  recent: readonly HomeLine[];
  arrangement: HomeArrangement;
  catalog: readonly CatalogPanel[];
  known: boolean;
  failed: boolean;
  summary?: readonly HomeNote[];
  reply?: { text?: string; notes?: readonly HomeNote[] };
  onOpen: (line: HomeLine) => void;
  onMove: (key: string, dir: -1 | 1) => void;
  onHide: (key: string) => void;
  onShow: (key: string) => void;
  onPin: (plugin: string, panelId: string) => void;
  onUnpin: (key: string) => void;
  onAsk: (text: string) => void;
  renderPanel?: (panel: CatalogPanel) => ReactNode;
  /** WP-159: the programme card. Absent when the board is empty, so a quiet home stays quiet. */
  programme?: ReactNode;
  /** How many items need Ash. The builder line is not one of them, so an empty home stays free of a number. */
  needsMark?: number;
}) {
  const lines: Record<string, readonly HomeLine[]> = {
    "needs-you": needsYou,
    projects,
    "moving-now": moving,
    recent,
  };
  const visible = arrangement.order.filter((ref) => {
    const key = sectionKey(ref);
    if (arrangement.hidden.includes(key)) return false;
    if (ref.kind === "builtin") return (lines[ref.id] ?? []).length > 0;
    return true;
  });
  const pinned = new Set(arrangement.order.filter((ref) => ref.kind === "panel").map(sectionKey));
  const offered = catalog.filter((panel) => !pinned.has(sectionKey({ kind: "panel", plugin: panel.plugin, panelId: panel.panelId })));
  const summaryNotes = summary ?? [];
  // Quiet is about activity: the projects overview alone is not something happening.
  const quiet =
    known && !programme && !noProjects && needsMark === 0 && needsYou.length + moving.length + recent.length === 0 && summaryNotes.length === 0;
  return (
    <div
      data-home
      data-home-order={visible.map(sectionKey).join(" ")}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto text-content"
    >
      <div className="mx-auto flex flex-col gap-6 px-6 pt-12 pb-8" style={{ maxWidth: HOME_MAX_WIDTH }}>
        {known ? <HomeChatBox reply={reply} onAsk={onAsk} onOpen={onOpen} /> : null}
        {known && noProjects ? <NoProjectsNote state={noProjects} onBringOver={onBringOver} onNewProject={onNewProject} /> : null}
        {programme ?? null}
        {known && summaryNotes.length > 0 ? (
          <div data-home-summary className="rounded-lg border border-stroke px-3 py-2">
            <Notes notes={summaryNotes} onOpen={onOpen} />
          </div>
        ) : null}
        {visible.map((ref, index) => {
          const key = sectionKey(ref);
          const title = sectionTitle(ref, catalog);
          const rows = ref.kind === "builtin" ? lines[ref.id] ?? [] : [];
          const panel = ref.kind === "panel" ? catalog.find((item) => item.plugin === ref.plugin && item.panelId === ref.panelId) : undefined;
          const place = visible.indexOf(ref);
          const needsHead = ref.kind === "builtin" && ref.id === "needs-you";
          return (
            <section
              key={key}
              data-home-section={key}
              aria-label={title}
              className="home-enter group rounded-lg border border-stroke"
              style={{ animationDelay: `${index * HOME_STAGGER_MS}ms` }}
            >
              <header className="flex items-center gap-2 px-3 py-2">
                <h2 className={`${needsHead ? "" : "min-w-0 flex-1 "}truncate text-[13px] font-medium text-content`}>{title}</h2>
                {needsHead && needsMark > 0 ? (
                  <span data-home-needs-count={needsMark} className="shrink-0 text-[12px] tabular-nums text-red-400">{needsMark}</span>
                ) : null}
                {/* Arranging is there when it's wanted: on hover or keyboard focus, not as words on every card. */}
                <div data-home-arrange className={`flex items-center gap-3 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100${needsHead ? " ml-auto" : ""}`}>
                  <Control name={`Move ${title} up`} onClick={() => place > 0 && onMove(key, -1)} />
                  <Control name={`Move ${title} down`} onClick={() => place < visible.length - 1 && onMove(key, 1)} />
                  <Control name={`Hide ${title}`} onClick={() => onHide(key)} />
                  {ref.kind === "panel" ? <Control name={`Unpin ${title}`} onClick={() => onUnpin(key)} /> : null}
                </div>
              </header>
              {ref.kind === "builtin" ? rows.map((line) => line.kind === "builders" ? (
                // WP-161: a line about the machine, not a place to open: its text says what is wrong and its one
                // action opens Settings > Worktrees > Clean up. The text wraps, so the free space is never clipped.
                <div
                  key={line.id}
                  data-home-line="builders"
                  className="flex min-h-10 w-full items-center gap-3 border-t border-stroke px-3 py-1.5 text-[13px] text-content"
                >
                  <span className="min-w-0 flex-1">{line.text}</span>
                  <button
                    type="button"
                    data-home-action="free-up-space"
                    className="shrink-0 text-[12px] text-content underline-offset-2 hover:underline"
                    onClick={() => onOpen(line)}
                  >
                    {FREE_UP_SPACE}
                  </button>
                </div>
              ) : (
                <NeedRow key={line.id} line={line} onOpen={onOpen} />
              )) : panel && renderPanel ? renderPanel(panel) : (
                <p className="border-t border-stroke px-3 py-3 text-[13px] text-content/70">This panel is not available.</p>
              )}
            </section>
          );
        })}
        {arrangement.hidden.length > 0 ? (
          <div className="flex flex-col items-start gap-1">
            {arrangement.hidden.map((key) => {
              const ref = arrangement.order.find((item) => sectionKey(item) === key);
              if (!ref) return null;
              const title = sectionTitle(ref, catalog);
              return <Control key={key} name={`Show ${title}`} onClick={() => onShow(key)} />;
            })}
          </div>
        ) : null}
        {quiet ? (
          <div data-home-empty>
            <p className="text-[13px] text-content">All quiet.</p>
          </div>
        ) : null}
        {!known && failed ? <p data-home-retry className="text-[13px] text-content/70">Couldn't load home. Trying again.</p> : null}
        {!known && !failed ? <div data-home-loading className="h-8" /> : null}
        {offered.length > 0 ? (
          <div data-home-pin className="flex flex-col items-start gap-1">
            <p className="text-[13px] text-content/70">Pin a panel</p>
            {offered.map((panel) => (
              <Control key={`${panel.plugin}:${panel.panelId}`} name={`Pin ${panel.title}`} onClick={() => onPin(panel.plugin, panel.panelId)} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
