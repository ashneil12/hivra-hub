// Home. The chief's own chat, then Needs you, Working now and Done today.
// Projects, the usage line and the morning summary are not on this screen.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { sectionKey, type HomeArrangement, type SectionRef } from "../model/arrangement";
import type { HomeLine } from "../model/lines";
import { HOME_ACTION_CAP } from "../model/needActions";
import { FREE_UP_SPACE } from "../../monos/model/builderScale";
import { NEEDS_YOU_RED } from "../../hub/ui/StatusMark";
import { RAISE_LIMIT } from "../../usage/model/spendGate";
import { Check, ChevronDown, ChevronUp, SendArrow } from "../../../shared/ui/icons";
import type { CatalogPanel } from "../../panels/model/panelTabs";
import { workersLabel } from "../model/workingNow";
import { HOME_MAX_WIDTH, HOME_STAGGER_MS } from "../vendor/homeLayout";
import { AgentMarkdown } from "../../sessions/ui/AgentMarkdown";
import "./home.css";

const CHIEF_NAME = "Chief of Staff";

const TITLE: Record<string, string> = {
  "needs-you": "Needs you",
  "moving-now": "Working now",
  recent: "Done today",
};

// One size for every answer on Home. The height is fixed so a row's text size cannot stretch one of them.
const HOME_BUTTON = "inline-flex h-7 shrink-0 items-center rounded-md px-2.5 text-[12px] leading-none";
const PRIMARY_BUTTON = `${HOME_BUTTON} bg-accent font-medium text-black`;
const QUIET_BUTTON = `${HOME_BUTTON} border border-content/20 text-content`;
// Name, up, down, switch, and an unpin slot. The slot stays empty on a section so the arrows line up.
const ARRANGE_COLUMNS = { gridTemplateColumns: "minmax(0, 1fr) 1.5rem 1.5rem 2.25rem 4rem" };

export type HomeNeed = {
  key: string;
  project?: string;
  sentence: string;
  stopped: boolean;
  /** A merge, a gate check, or a question that asks to ship. After stopped rows, before other questions. */
  blocksShip?: boolean;
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

/** A section a project's home adds below the built-in ones: its pinned pages, its automations (Dropwave). */
export type HomeExtraSection = {
  key: string;
  title: string;
  empty: string;
  rows: { key: string; text: string; meta?: string; onOpen: () => void }[];
  action?: { label: string; onClick: () => void };
};

export type HomeChief = {
  missing: boolean;
  name: string;
  scope?: string;
  you?: string;
  reply?: string;
  streaming?: boolean;
  options: { id: string; label: string }[];
  /** The box's prompt: Home's, or a project's. */
  placeholder?: string;
  onAdd: () => void;
  onOpenChat: () => void;
  onOption: (id: string) => void;
};

function homeNeedRank(row: HomeNeed): number {
  if (row.stopped) return 0;
  if (row.blocksShip) return 1;
  return 2;
}

function titleOf(ref: SectionRef, catalog: readonly CatalogPanel[]): string {
  if (ref.kind === "builtin") return TITLE[ref.id] ?? ref.id;
  return catalog.find((panel) => panel.plugin === ref.plugin && panel.panelId === ref.panelId)?.title || "Pinned panel";
}

function Tag({ name }: { name?: string }) {
  if (!name) return null;
  return (
    <span data-home-project className="shrink-0 rounded border border-stroke px-1.5 py-0.5 text-[11px] text-content/80">
      {name}
    </span>
  );
}

function NeedRow({ row }: { row: HomeNeed }) {
  if (row.stopped) {
    const open = row.actions[0]?.onClick ?? row.onOpen;
    return (
      <div data-home-line="need" className="flex min-h-10 w-full flex-wrap items-center gap-2 border-t border-stroke px-3 py-2 text-[13px] text-content">
        <Tag name={row.project} />
        <span data-home-stopped className="shrink-0 font-medium" style={{ color: NEEDS_YOU_RED }}>Stopped.</span>
        <span className="min-w-0 flex-1">{row.sentence}</span>
        <button type="button" data-home-action="Open chat" className={QUIET_BUTTON} onClick={open}>
          Open chat
        </button>
      </div>
    );
  }
  const actions = row.actions.slice(0, HOME_ACTION_CAP);
  const body = (
    <>
      <Tag name={row.project} />
      <span className="min-w-0 flex-1">{row.sentence}</span>
    </>
  );
  if (actions.length === 0) {
    return (
      <button
        type="button"
        data-home-line="need"
        className="flex min-h-10 w-full items-center gap-2 border-t border-stroke px-3 py-2 text-left text-[13px] text-content hover:bg-content/8"
        onClick={row.onOpen}
      >
        {body}
      </button>
    );
  }
  return (
    <div data-home-line="need" className="flex min-h-10 w-full flex-wrap items-center gap-2 border-t border-stroke px-3 py-2 text-[13px] text-content">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={row.onOpen}>
        {body}
      </button>
      {actions.map((action, index) => (
        <button
          key={action.label}
          type="button"
          data-home-action={action.label}
          className={index === 0 ? PRIMARY_BUTTON : QUIET_BUTTON}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function youBubbleClass(text: string): string {
  const single = !text.includes("\n");
  return `user-message-bubble relative min-w-0 w-fit max-w-[min(100%,36rem)] bg-content/10 px-3 py-2 font-sans text-sm whitespace-pre-wrap break-words text-content ${single ? "rounded-full" : "rounded-xl"}`;
}

function ChiefAvatar() {
  return (
    <span
      data-home-avatar="chief"
      className="grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-black"
      style={{ backgroundColor: "var(--color-skill)" }}
    >
      CS
    </span>
  );
}

function ChiefIdentity({ scope }: { scope?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span data-home-chief data-home-speaker="chief" className="shrink-0 text-[13px] font-semibold text-content">
        {CHIEF_NAME}
      </span>
      {scope ? <span className="shrink-0 text-[12px] text-content/60" aria-hidden="true">·</span> : null}
      {scope ? <span data-home-scope className="min-w-0 truncate text-[12px] text-content/60">{scope}</span> : null}
    </div>
  );
}

function NameLine({ scope }: { scope?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ChiefAvatar />
      <ChiefIdentity scope={scope} />
    </div>
  );
}

function ChiefExchange({ chief }: { chief: HomeChief }) {
  const showYou = Boolean(chief.you);
  const showChief = Boolean(chief.reply || chief.streaming || chief.options.length > 0);
  if (!showYou && !showChief) return null;
  return (
    <div className="flex flex-col gap-3 px-3 pt-3">
      {showYou ? (
        <div data-home-you className="flex flex-col items-end gap-1 pl-14">
          <span data-home-speaker="you" className="sr-only">You</span>
          <div data-chat-message-role="user" className={youBubbleClass(chief.you ?? "")}>{chief.you}</div>
        </div>
      ) : null}
      {showChief ? (
        <div data-home-reply data-chat-message-role="assistant" className="flex min-w-0 items-start gap-2">
          <ChiefAvatar />
          <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
            <ChiefIdentity scope={chief.scope} />
            {chief.reply ? (
              <div
                data-home-reply-text
                data-home-streaming={chief.streaming ? "" : undefined}
                className="min-w-0 w-full font-sans text-sm leading-6 text-content"
              >
                <AgentMarkdown text={chief.reply} streaming={chief.streaming} revealOnMount={false} />
              </div>
            ) : chief.streaming ? (
              <p data-home-streaming className="zen-thinking-pulse font-sans text-sm text-content/50">Thinking</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Suggested replies">
              {chief.options.map((option, index) => (
                <button
                  key={option.id}
                  type="button"
                  data-home-option={option.id}
                  aria-label={option.label}
                  className={index === 0 ? PRIMARY_BUTTON : QUIET_BUTTON}
                  onClick={() => chief.onOption(option.id)}
                >
                  {option.label}
                </button>
              ))}
              <button
                type="button"
                data-home-action="open-chat"
                className="px-1 text-[13px] text-content/80"
                onClick={chief.onOpenChat}
              >
                Open full chat
              </button>
            </div>
          </div>
        </div>
      ) : (
        <NameLine scope={chief.scope} />
      )}
    </div>
  );
}

function ChiefBox({ chief, onAsk, quiet }: { chief: HomeChief; onAsk: (text: string) => void; quiet: boolean }) {
  const [text, setText] = useState("");
  const ready = text.trim().length > 0;
  const talking = Boolean(chief.you || chief.reply || chief.streaming || chief.options.length > 0);
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
    <div data-home-start="" className="flex flex-col rounded-lg border border-stroke">
      {talking ? <ChiefExchange chief={chief} /> : (
        <div className="px-3 pt-3">
          <NameLine scope={chief.scope} />
          {quiet ? (
            <p data-home-quiet className="mt-2 text-[13px] leading-6 text-content/60">
              All quiet. Ask me anything, or hand work to any project.
            </p>
          ) : null}
        </div>
      )}
      <form
        className="mt-3 flex items-center gap-2 border-t border-stroke py-1.5 pr-1.5 pl-4"
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
          placeholder={chief.placeholder ?? "Ask anything, or hand work to any project"}
          onChange={(event) => setText(event.target.value)}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-[14px] text-content outline-none placeholder:text-content/40"
        />
        <button
          type="submit"
          aria-label="Send"
          title="Send"
          disabled={!ready}
          className={`grid size-7 shrink-0 place-items-center rounded-md transition-colors disabled:cursor-default ${ready ? "bg-accent text-black" : "bg-content/25 text-content"}`}
        >
          <SendArrow className="size-3.5" strokeWidth={2.25} aria-hidden />
        </button>
      </form>
    </div>
  );
}

function SectionMark({ kind }: { kind: string }) {
  if (kind === "recent") {
    return (
      <span data-home-mark="done" className="grid size-4 shrink-0 place-items-center" style={{ color: "var(--color-status-ok)" }}>
        <Check className="size-3.5" aria-hidden />
      </span>
    );
  }
  if (kind !== "needs-you" && kind !== "moving-now") return null;
  const mark = kind === "needs-you" ? "needs-you" : "working";
  const color = kind === "needs-you" ? NEEDS_YOU_RED : "var(--color-accent)";
  return <span data-home-mark={mark} className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

function ShowSwitch({ title, on, onToggle }: { title: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={`Show ${title}`}
      aria-checked={on}
      onClick={onToggle}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-content/20"}`}
    >
      <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${on ? "left-4.5" : "left-0.5"}`} />
    </button>
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
  title = "Home",
  headerExtra,
  extraSections = [],
}: {
  /** Home, or the project's name on a project's home. */
  title?: string;
  /** Beside the title: a project's Autopilot switch. */
  headerExtra?: ReactNode;
  extraSections?: readonly HomeExtraSection[];
  date: string;
  chief: HomeChief;
  needs: readonly HomeNeed[];
  needsTotal: number;
  builders: readonly HomeLine[];
  working: readonly HomeWork[];
  workingTotal: number;
  done: readonly HomeDone[];
  onSeeNeeds: () => void;
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
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!custom) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (toggleRef.current?.contains(target)) return;
      setCustom(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCustom(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [custom]);
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
  const orderedNeeds = [...needs].sort((a, b) => homeNeedRank(a) - homeNeedRank(b));
  return (
    <div data-home data-home-order={visible.map(sectionKey).join(" ")} className="min-h-0 min-w-0 flex-1 overflow-y-auto text-content">
      <div className="mx-auto flex flex-col gap-6 px-6 pt-12 pb-8" style={{ maxWidth: HOME_MAX_WIDTH }}>
        <header data-home-header className="flex items-baseline gap-3">
          <h1 className="text-[18px] font-medium text-content">{title}</h1>
          {date ? <p data-home-date className="min-w-0 flex-1 truncate text-[13px] text-content/60">{date}</p> : <span className="flex-1" />}
          {headerExtra}
          {known ? (
            <button
              ref={toggleRef}
              type="button"
              data-home-action="customize"
              aria-expanded={custom}
              className="rounded-md border border-stroke px-2.5 py-1 text-[13px] text-content hover:bg-content/8"
              onClick={() => setCustom((open) => !open)}
            >
              Customize
            </button>
          ) : null}
        </header>
        {known && custom ? (
          <div
            ref={panelRef}
            data-home-customize
            role="dialog"
            aria-label="Customize"
            className="flex flex-col gap-1 rounded-lg border border-stroke p-2"
          >
            {arranged.map((ref) => {
              const key = sectionKey(ref);
              const title = titleOf(ref, catalog);
              const shown = !arrangement.hidden.includes(key);
              return (
                <div key={key} data-home-arrange={key} className="grid items-center gap-x-1.5 px-1 py-1" style={ARRANGE_COLUMNS}>
                  <span className="min-w-0 truncate text-[13px] text-content">{title}</span>
                  <button type="button" aria-label={`Move ${title} up`} className="grid size-6 place-items-center justify-self-center rounded text-content/70 hover:bg-content/8" onClick={() => onMove(key, -1)}>
                    <ChevronUp className="size-3.5" aria-hidden />
                  </button>
                  <button type="button" aria-label={`Move ${title} down`} className="grid size-6 place-items-center justify-self-center rounded text-content/70 hover:bg-content/8" onClick={() => onMove(key, 1)}>
                    <ChevronDown className="size-3.5" aria-hidden />
                  </button>
                  <span className="justify-self-center">
                    <ShowSwitch title={title} on={shown} onToggle={() => (shown ? onHide(key) : onShow(key))} />
                  </span>
                  <span data-home-unpin="" className="min-w-0 justify-self-end">
                    {ref.kind === "panel" ? (
                      <button type="button" aria-label={`Unpin ${title}`} className="text-[12px] text-content/70 underline-offset-2 hover:underline" onClick={() => onUnpin(key)}>
                        Unpin
                      </button>
                    ) : null}
                  </span>
                </div>
              );
            })}
            {offered.map((panel) => (
              <div key={`${panel.plugin}:${panel.panelId}`} className="grid items-center gap-x-1.5 px-1 py-1" style={ARRANGE_COLUMNS}>
                <span className="min-w-0 truncate text-[13px] text-content/70">{panel.title}</span>
                <span />
                <span />
                <span />
                <span className="justify-self-end">
                  <button
                    type="button"
                    aria-label={`Pin ${panel.title}`}
                    className={QUIET_BUTTON}
                    onClick={() => onPin(panel.plugin, panel.panelId)}
                  >
                    Pin
                  </button>
                </span>
              </div>
            ))}
            <button
              type="button"
              className={`mt-1 self-end ${PRIMARY_BUTTON}`}
              onClick={() => setCustom(false)}
            >
              Done
            </button>
          </div>
        ) : null}
        {known ? <ChiefBox chief={chief} onAsk={onAsk} quiet={quiet} /> : null}
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
              <header className="flex items-center gap-2 px-3 py-2">
                <SectionMark kind={key} />
                <h2 className="truncate text-[13px] font-medium text-content">{title}</h2>
                {key === "needs-you" && needsTotal > 0 ? <span data-home-count={needsTotal} className="text-[12px] text-content/60">{needsTotal}</span> : null}
                {key === "moving-now" ? <span data-home-workers className="text-[12px] text-content/60">{workersLabel(workingTotal)}</span> : null}
                {key === "recent" ? <span data-home-done className="text-[12px] text-content/60">{done.length}</span> : null}
                <span className="min-w-0 flex-1" />
                {key === "needs-you" && needsTotal > 0 ? (
                  <button type="button" data-home-see="needs" className="text-[12px] text-accent" onClick={onSeeNeeds}>See all</button>
                ) : null}
              </header>
              {key === "needs-you" ? (
                <>
                  {builders.map((line) => (
                    // A disk pause opens Clean up. A spend pause opens the limit. The text wraps, so the reason is never clipped.
                    <div
                      key={line.id}
                      data-home-line="builders"
                      className="flex min-h-10 w-full items-center gap-3 border-t border-stroke px-3 py-1.5 text-[13px] text-content"
                    >
                      <span className="min-w-0 flex-1">{line.text}</span>
                      <button
                        type="button"
                        data-home-action={line.target === "builders-spend" ? "raise-limit" : "free-up-space"}
                        className="shrink-0 text-[12px] text-content underline-offset-2 hover:underline"
                        onClick={() => onOpen(line)}
                      >{line.target === "builders-spend" ? RAISE_LIMIT : FREE_UP_SPACE}</button>
                    </div>
                  ))}
                  {orderedNeeds.map((row) => <NeedRow key={row.key} row={row} />)}
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
              {ref.kind === "panel" ? (
                <div data-home-panel className="border-t border-stroke px-3 py-3 text-[13px] text-content">
                  {panel && renderPanel ? renderPanel(panel) : (
                    <p className="text-content/70">This panel is not available.</p>
                  )}
                </div>
              ) : null}
            </section>
          );
        })}
        {known
          ? extraSections.map((extra, index) => (
              <section
                key={extra.key}
                data-home-section={extra.key}
                aria-label={extra.title}
                className="home-enter rounded-lg border border-stroke"
                style={{ animationDelay: `${(visible.length + index) * HOME_STAGGER_MS}ms` }}
              >
                <header className="flex items-center gap-2 px-3 py-2">
                  <h2 className="truncate text-[13px] font-medium text-content">{extra.title}</h2>
                  {extra.rows.length ? <span className="text-[12px] text-content/60">{extra.rows.length}</span> : null}
                  <span className="min-w-0 flex-1" />
                  {extra.action ? (
                    <button type="button" className="text-[12px] text-accent" onClick={extra.action.onClick}>{extra.action.label}</button>
                  ) : null}
                </header>
                {extra.rows.length === 0 ? (
                  <p className="border-t border-stroke px-3 py-2.5 text-[13px] text-content/60">{extra.empty}</p>
                ) : extra.rows.map((row) => (
                  <button
                    key={row.key}
                    type="button"
                    data-home-line={extra.key}
                    className="flex min-h-10 w-full items-center gap-3 border-t border-stroke px-3 py-1.5 text-left text-[13px] text-content hover:bg-content/8"
                    onClick={row.onOpen}
                  >
                    <span className="min-w-0 flex-1">{row.text}</span>
                    {row.meta ? <span className="shrink-0 text-content/60">{row.meta}</span> : null}
                  </button>
                ))}
              </section>
            ))
          : null}
        {!known && failed ? <p data-home-retry className="text-[13px] text-content/70">Couldn't load home. Trying again.</p> : null}
        {!known && !failed ? <div data-home-loading className="h-8" /> : null}
      </div>
    </div>
  );
}
