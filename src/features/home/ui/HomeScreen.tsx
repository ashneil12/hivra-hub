// Home. The chief's own chat, then Needs you, Working now and Done today.
// Projects, the usage line and the morning summary are not on this screen.

import { useState, type ReactNode } from "react";
import { sectionKey, type HomeArrangement, type SectionRef } from "../model/arrangement";
import type { HomeLine } from "../model/lines";
import { FREE_UP_SPACE } from "../../monos/model/builderScale";
import { NEEDS_YOU_RED } from "../../hub/ui/StatusMark";
import { ArrowUp } from "../../../shared/ui/icons";
import type { CatalogPanel } from "../../panels/model/panelTabs";
import { workersLabel } from "../model/workingNow";
import { HOME_MAX_WIDTH, HOME_STAGGER_MS } from "../vendor/homeLayout";
import "./home.css";

const TITLE: Record<string, string> = {
  "needs-you": "Needs you",
  "moving-now": "Working now",
  recent: "Done today",
};

export type HomeNeed = {
  key: string;
  project?: string;
  sentence: string;
  stopped: boolean;
  actions: { label: string; onClick: () => void }[];
  onOpen: () => void;
};

export type HomeWork = {
  key: string;
  project?: string;
  text: string;
  since: string;
  onOpen?: () => void;
};

export type HomeDone = {
  key: string;
  project?: string;
  text: string;
  time: string;
  onOpen: () => void;
};

export type HomeChief = {
  missing: boolean;
  name: string;
  scope?: string;
  you?: string;
  reply?: string;
  streaming?: boolean;
  options: { id: string; label: string }[];
  onAdd: () => void;
  onOpenChat: () => void;
  onOption: (id: string) => void;
};

function titleOf(ref: SectionRef, catalog: readonly CatalogPanel[]): string {
  if (ref.kind === "builtin") return TITLE[ref.id] ?? ref.id;
  return catalog.find((panel) => panel.plugin === ref.plugin && panel.panelId === ref.panelId)?.title || "Pinned panel";
}

function Tag({ name }: { name?: string }) {
  if (!name) return null;
  return <span data-home-project className="shrink-0 text-content/60">{name}</span>;
}

function NeedRow({ row }: { row: HomeNeed }) {
  const actions = row.actions.slice(0, 2);
  const body = (
    <>
      <Tag name={row.project} />
      {row.stopped ? (
        <span data-home-mark="needs-you" className="shrink-0" style={{ color: NEEDS_YOU_RED }}>Needs you</span>
      ) : null}
      <span className="min-w-0 flex-1">{row.sentence}</span>
    </>
  );
  if (actions.length === 0) {
    return (
      <button
        type="button"
        data-home-line="need"
        className="flex min-h-10 w-full items-center gap-3 border-t border-stroke px-3 py-1.5 text-left text-[13px] text-content hover:bg-content/8"
        onClick={row.onOpen}
      >
        {body}
      </button>
    );
  }
  return (
    <div data-home-line="need" className="flex min-h-10 w-full items-center gap-3 border-t border-stroke px-3 py-1.5 text-[13px] text-content">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={row.onOpen}>
        {body}
      </button>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          data-home-action={action.label}
          className="shrink-0 text-[12px] text-content underline-offset-2 hover:underline"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function ChiefBox({ chief, onAsk }: { chief: HomeChief; onAsk: (text: string) => void }) {
  const [text, setText] = useState("");
  const ready = text.trim().length > 0;
  const showExchange = Boolean(chief.you || chief.reply || chief.streaming);
  if (chief.missing) {
    return (
      <div data-home-start="" data-home-no-chief className="flex flex-col items-start gap-2">
        <p className="text-[13px] text-content">There is no Chief of Staff.</p>
        <button
          type="button"
          data-home-action="add-chief"
          className="text-[13px] text-content underline-offset-2 hover:underline"
          onClick={chief.onAdd}
        >
          Add the Chief of Staff
        </button>
      </div>
    );
  }
  return (
    <div data-home-start="" className="flex flex-col gap-2">
      <div>
        <p data-home-chief className="text-[14px] text-content">{chief.name}</p>
        {chief.scope ? <p data-home-scope className="text-[12px] text-content/60">{chief.scope}</p> : null}
      </div>
      <form
        className="flex items-center gap-2 rounded-xl border border-stroke bg-content/[0.03] py-1.5 pr-1.5 pl-4 transition-colors focus-within:border-content/30"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          onAsk(text);
          setText("");
        }}
      >
        <input
          aria-label="Ask"
          value={text}
          placeholder="Ask anything, or hand work to any project"
          onChange={(event) => setText(event.target.value)}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-[14px] text-content outline-none placeholder:text-content/40"
        />
        <button
          type="submit"
          aria-label="Send"
          title="Send"
          disabled={!ready}
          className="primary-action grid size-7 shrink-0 place-items-center rounded-md transition-[background-color,color,transform] duration-150 active:scale-90 disabled:cursor-default"
        >
          <ArrowUp className="size-3.5" strokeWidth={2} aria-hidden />
        </button>
      </form>
      {showExchange ? (
        <div data-home-reply className="rounded-xl border border-stroke px-4 py-2">
          {chief.you ? <p data-home-you className="py-1 text-[13px] text-content/70">{chief.you}</p> : null}
          {chief.reply ? <p className="py-1 text-[13px] text-content">{chief.reply}</p> : null}
          {chief.streaming ? <p data-home-streaming className="py-1 text-[13px] text-content/60">Replying</p> : null}
          {chief.options.length > 0 ? (
            <div className="flex flex-wrap gap-2 py-1">
              {chief.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  data-home-option={option.id}
                  className="text-[13px] text-content underline-offset-2 hover:underline"
                  onClick={() => chief.onOption(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        data-home-action="open-chat"
        className="self-start text-[12px] text-content/70 underline-offset-2 hover:underline"
        onClick={chief.onOpenChat}
      >
        Open full chat
      </button>
    </div>
  );
}

export function HomeScreen({
  date,
  chief,
  needs,
  needsTotal,
  builders,
  working,
  workingTotal,
  done,
  onSeeNeeds,
  onSeeDone,
  arrangement,
  catalog,
  known,
  failed,
  onOpen,
  onMove,
  onHide,
  onShow,
  onPin,
  onUnpin,
  onAsk,
  renderPanel,
}: {
  date: string;
  chief: HomeChief;
  needs: readonly HomeNeed[];
  needsTotal: number;
  builders: readonly HomeLine[];
  working: readonly HomeWork[];
  workingTotal: number;
  done: readonly HomeDone[];
  onSeeNeeds: () => void;
  onSeeDone: () => void;
  arrangement: HomeArrangement;
  catalog: readonly CatalogPanel[];
  known: boolean;
  failed: boolean;
  onOpen: (line: HomeLine) => void;
  onMove: (key: string, dir: -1 | 1) => void;
  onHide: (key: string) => void;
  onShow: (key: string) => void;
  onPin: (plugin: string, panelId: string) => void;
  onUnpin: (key: string) => void;
  onAsk: (text: string) => void;
  renderPanel?: (panel: CatalogPanel) => ReactNode;
}) {
  const [custom, setCustom] = useState(false);
  const filled: Record<string, boolean> = {
    "needs-you": needs.length + builders.length > 0,
    "moving-now": working.length > 0,
    recent: done.length > 0,
  };
  const visible = arrangement.order.filter((ref) => {
    const key = sectionKey(ref);
    if (ref.kind === "builtin" && ref.id === "projects") return false;
    if (arrangement.hidden.includes(key)) return false;
    if (ref.kind === "builtin") return filled[ref.id] === true;
    return true;
  });
  const pinned = new Set(arrangement.order.filter((ref) => ref.kind === "panel").map(sectionKey));
  const offered = catalog.filter((panel) => !pinned.has(sectionKey({ kind: "panel", plugin: panel.plugin, panelId: panel.panelId })));
  const arranged = arrangement.order.filter((ref) => !(ref.kind === "builtin" && ref.id === "projects"));
  const quiet = known && visible.length === 0;
  return (
    <div data-home data-home-order={visible.map(sectionKey).join(" ")} className="min-h-0 min-w-0 flex-1 overflow-y-auto text-content">
      <div className="mx-auto flex flex-col gap-6 px-6 pt-12 pb-8" style={{ maxWidth: HOME_MAX_WIDTH }}>
        <header data-home-header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[18px] font-medium text-content">Home</h1>
            {date ? <p data-home-date className="text-[13px] text-content/60">{date}</p> : null}
          </div>
          {known ? (
            <button
              type="button"
              data-home-action="customize"
              aria-expanded={custom}
              className="text-[13px] text-content underline-offset-2 hover:underline"
              onClick={() => setCustom((open) => !open)}
            >
              Customize
            </button>
          ) : null}
        </header>
        {custom ? (
          <div data-home-customize className="flex flex-col items-start gap-1">
            {arranged.map((ref) => {
              const key = sectionKey(ref);
              const title = titleOf(ref, catalog);
              if (arrangement.hidden.includes(key)) {
                return (
                  <button key={key} type="button" className="text-[12px] text-content/70 underline-offset-2 hover:underline" onClick={() => onShow(key)}>
                    {`Show ${title}`}
                  </button>
                );
              }
              return (
                <div key={key} className="flex items-center gap-3">
                  <button type="button" className="text-[12px] text-content/70 underline-offset-2 hover:underline" onClick={() => onMove(key, -1)}>{`Move ${title} up`}</button>
                  <button type="button" className="text-[12px] text-content/70 underline-offset-2 hover:underline" onClick={() => onMove(key, 1)}>{`Move ${title} down`}</button>
                  <button type="button" className="text-[12px] text-content/70 underline-offset-2 hover:underline" onClick={() => onHide(key)}>{`Hide ${title}`}</button>
                  {ref.kind === "panel" ? (
                    <button type="button" className="text-[12px] text-content/70 underline-offset-2 hover:underline" onClick={() => onUnpin(key)}>{`Unpin ${title}`}</button>
                  ) : null}
                </div>
              );
            })}
            {offered.map((panel) => (
              <button
                key={`${panel.plugin}:${panel.panelId}`}
                type="button"
                className="text-[12px] text-content/70 underline-offset-2 hover:underline"
                onClick={() => onPin(panel.plugin, panel.panelId)}
              >
                {`Pin ${panel.title}`}
              </button>
            ))}
          </div>
        ) : null}
        {known ? <ChiefBox chief={chief} onAsk={onAsk} /> : null}
        {visible.map((ref, index) => {
          const key = sectionKey(ref);
          const title = titleOf(ref, catalog);
          const panel = ref.kind === "panel" ? catalog.find((item) => item.plugin === ref.plugin && item.panelId === ref.panelId) : undefined;
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
                {key === "needs-you" && needsTotal > 0 ? <span data-home-count={needsTotal} className="text-[12px] text-content/60">{needsTotal}</span> : null}
                {key === "moving-now" ? <span data-home-workers className="text-[12px] text-content/60">{workersLabel(workingTotal)}</span> : null}
                {key === "needs-you" && needsTotal > 0 ? (
                  <button type="button" data-home-see="needs" className="text-[12px] text-content/70 underline-offset-2 hover:underline" onClick={onSeeNeeds}>See all</button>
                ) : null}
                {key === "recent" ? (
                  <button type="button" data-home-see="done" className="text-[12px] text-content/70 underline-offset-2 hover:underline" onClick={onSeeDone}>See all</button>
                ) : null}
              </header>
              {key === "needs-you" ? (
                <>
                  {builders.map((line) => (
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
                  ))}
                  {needs.map((row) => <NeedRow key={row.key} row={row} />)}
                </>
              ) : null}
              {key === "moving-now" ? working.map((row) => {
                const body = (
                  <>
                    <Tag name={row.project} />
                    <span className="min-w-0 flex-1">{row.text}</span>
                    {row.since ? <span data-home-since className="shrink-0 text-content/60">{row.since}</span> : null}
                  </>
                );
                if (!row.onOpen) {
                  return (
                    <div key={row.key} data-home-line="working" className="flex min-h-10 w-full items-center gap-3 border-t border-stroke px-3 py-1.5 text-left text-[13px] text-content">
                      {body}
                    </div>
                  );
                }
                return (
                  <button
                    key={row.key}
                    type="button"
                    data-home-line="working"
                    className="flex min-h-10 w-full items-center gap-3 border-t border-stroke px-3 py-1.5 text-left text-[13px] text-content hover:bg-content/8"
                    onClick={row.onOpen}
                  >
                    {body}
                  </button>
                );
              }) : null}
              {key === "recent" ? done.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  data-home-line="done"
                  className="flex min-h-10 w-full items-center gap-3 border-t border-stroke px-3 py-1.5 text-left text-[13px] text-content hover:bg-content/8"
                  onClick={row.onOpen}
                >
                  <Tag name={row.project} />
                  <span className="min-w-0 flex-1">{row.text}</span>
                  {row.time ? <span data-home-time className="shrink-0 text-content/60">{row.time}</span> : null}
                </button>
              )) : null}
              {ref.kind === "panel" ? (panel && renderPanel ? renderPanel(panel) : (
                <p className="border-t border-stroke px-3 py-3 text-[13px] text-content/70">This panel is not available.</p>
              )) : null}
            </section>
          );
        })}
        {quiet ? (
          <div data-home-empty>
            <p className="text-[13px] text-content/60">Nothing needs you.</p>
          </div>
        ) : null}
        {!known && failed ? <p data-home-retry className="text-[13px] text-content/70">Couldn't load home. Trying again.</p> : null}
        {!known && !failed ? <div data-home-loading className="h-8" /> : null}
      </div>
    </div>
  );
}
