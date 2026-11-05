// Home. Orbit's column and entrance, restyled: no counters, no status icons, no view-all links.
// HomePage.tsx imports Orbit data hooks and shows those, so this screen is not a copy of that file.

import { useState, type ReactNode } from "react";
import { sectionKey, type HomeArrangement, type SectionRef } from "../model/arrangement";
import type { HomeLine, HomeLineKind } from "../model/lines";
import type { CatalogPanel } from "../../panels/model/panelTabs";
import { HOME_MAX_WIDTH, HOME_STAGGER_MS } from "../vendor/homeLayout";
import "./home.css";

const TITLE: Record<string, string> = {
  "needs-you": "Needs you",
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
  return (
    <form
      data-home-start=""
      className="rounded-lg border border-stroke px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        onAsk(text);
      }}
    >
      <label className="block text-[13px] text-content">
        Ask
        <input
          aria-label="Ask"
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="mt-2 w-full bg-transparent text-[13px] text-content outline-none"
        />
      </label>
      <button type="submit" className="mt-2 text-[13px] text-content underline-offset-2 hover:underline">
        Ask
      </button>
      {reply?.text || notes.length > 0 ? (
        <div data-home-reply className="mt-3 border-t border-stroke pt-2">
          {reply?.text ? <p className="text-[13px] text-content">{reply.text}</p> : null}
          {notes.length > 0 ? <Notes notes={notes} onOpen={onOpen} /> : null}
        </div>
      ) : null}
    </form>
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
}: {
  needsYou: readonly HomeLine[];
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
}) {
  const lines: Record<string, readonly HomeLine[]> = {
    "needs-you": needsYou,
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
  const quiet = known && needsYou.length + moving.length + recent.length === 0 && summaryNotes.length === 0;
  return (
    <div
      data-home
      data-home-order={visible.map(sectionKey).join(" ")}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto text-content"
    >
      <div className="mx-auto flex flex-col gap-6 px-6 pt-12 pb-8" style={{ maxWidth: HOME_MAX_WIDTH }}>
        {known ? <HomeChatBox reply={reply} onAsk={onAsk} onOpen={onOpen} /> : null}
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
          return (
            <section
              key={key}
              data-home-section={key}
              aria-label={title}
              className="home-enter rounded-lg border border-stroke"
              style={{ animationDelay: `${index * HOME_STAGGER_MS}ms` }}
            >
              <header className="flex items-center gap-3 px-3 py-2">
                <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-content">{title}</h2>
                <Control name={`Move ${title} up`} onClick={() => place > 0 && onMove(key, -1)} />
                <Control name={`Move ${title} down`} onClick={() => place < visible.length - 1 && onMove(key, 1)} />
                <Control name={`Hide ${title}`} onClick={() => onHide(key)} />
                {ref.kind === "panel" ? <Control name={`Unpin ${title}`} onClick={() => onUnpin(key)} /> : null}
              </header>
              {ref.kind === "builtin" ? rows.map((line) => (
                <button
                  key={line.id}
                  type="button"
                  data-home-line={line.kind}
                  className="flex min-h-10 w-full items-center border-t border-stroke px-3 py-1.5 text-left text-[13px] text-content hover:bg-content/8"
                  onClick={() => onOpen(line)}
                >
                  <span className="min-w-0 flex-1 truncate">{line.text}</span>
                </button>
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
