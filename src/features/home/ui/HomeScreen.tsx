// Home. The chief's own chat, then Needs you, Working now and Done today.
// Projects, the usage line and the morning summary are not on this screen.

import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { sectionKey, type HomeArrangement, type SectionRef } from "../model/arrangement";
import type { HomeLine } from "../model/lines";
import { HOME_ACTION_CAP } from "../model/needActions";
import { FREE_UP_SPACE } from "../../monos/model/builderScale";
import { NEEDS_YOU_RED } from "../../hub/ui/StatusMark";
import { RAISE_LIMIT } from "../../usage/model/spendGate";
import { Book, Check, GripVertical, Plus, SendArrow, Sparkles, Zap } from "../../../shared/ui/icons";
import type { CatalogPanel } from "../../panels/model/panelTabs";
import { workersLabel } from "../model/workingNow";
import { HOME_STAGGER_MS } from "../vendor/homeLayout";
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
// Name, switch, and an unpin slot. The slot stays empty on a section so the switches line up.
const ARRANGE_COLUMNS = { gridTemplateColumns: "minmax(0, 1fr) 2.25rem 4rem" };
// The header's two controls (a project's Autopilot switch, Customize): one height and one look, so they sit level.
export const HOME_HEADER_BUTTON =
  "inline-flex h-7 shrink-0 items-center gap-2 rounded-md border border-content/10 px-2.5 text-[12px] leading-none text-content/70 hover:bg-content/10 hover:text-content";

// The order the cards were dragged into, by key, is part of Home's saved arrangement (G5: `arrangement.cards`, kept in
// the local hub store), so every window and a restore agree.
/** Cards in the dragged order; one that was never dragged keeps its own place after them. */
export function orderCards<T extends { key: string }>(cards: readonly T[], order: readonly string[]): T[] {
  const rank = (card: T, index: number) => (order.includes(card.key) ? order.indexOf(card.key) : order.length + index);
  return cards.map((card, index) => ({ card, at: rank(card, index) })).sort((a, b) => a.at - b.at).map((entry) => entry.card);
}
/** `key` dropped on `onto`: it takes that card's place, and the cards between move over by one. */
export function dropCard(keys: readonly string[], key: string, onto: string): string[] {
  const from = keys.indexOf(key);
  const to = keys.indexOf(onto);
  if (from < 0 || to < 0 || from === to) return [...keys];
  const next = keys.filter((item) => item !== key);
  next.splice(to, 0, key);
  return next;
}

export type HomeNeed = {
  key: string;
  project?: string;
  sentence: string;
  stopped: boolean;
  /** A merge, a gate check, or a question that asks to ship. After stopped rows, before other questions. */
  blocksShip?: boolean;
  actions: { label: string; title?: string; onClick: () => void }[];
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

/** Dropwave: Home uses the room it has. The chat box stays a readable width; the cards below spread out. */
const HOME_WIDE_WIDTH = 1120;
const HOME_BOX_WIDTH = 760;
// One card look for every section on Home.
const HOME_CARD = "home-enter group/card flex min-w-0 flex-col rounded-xl border border-content/10 pb-1.5";
const HOME_ROW = "mx-1.5 flex min-h-10 items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-content";

/** A section a project's home adds below the built-in ones: its pinned pages, its automations (Dropwave). */
export type HomeExtraSection = {
  key: string;
  title: string;
  empty: string;
  /** Tiles for things you open (pages); rows for the rest. */
  layout?: "rows" | "tiles";
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
  /** Its own picture, where the app has one; else its initials. */
  avatar?: ReactNode;
  /** One-tap starters under the box. */
  starters?: readonly string[];
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
      <div data-home-line="need" className={`${HOME_ROW} flex-wrap`}>
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
        className={`${HOME_ROW} hover:bg-content/8`}
        onClick={row.onOpen}
      >
        {body}
      </button>
    );
  }
  return (
    <div data-home-line="need" className={`${HOME_ROW} flex-wrap`}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={row.onOpen}>
        {body}
      </button>
      {actions.map((action, index) => (
        <button
          key={action.label}
          type="button"
          data-home-action={action.label}
          {...(index === 0 ? { "data-needs-answer": "" } : {})}
          title={action.title ?? action.label}
          aria-label={action.title ?? action.label}
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

function ChiefBox({ chief, onAsk, quiet, seed }: { chief: HomeChief; onAsk: (text: string) => void; quiet: boolean; seed?: { text: string; n: number } }) {
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  // Words put in the box for the person to finish (Customize's "Ask for a new card"): typed in, focused, not sent.
  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    const input = box.current?.querySelector<HTMLInputElement>("input[aria-label='Ask']");
    input?.focus();
    input?.setSelectionRange(seed.text.length, seed.text.length);
  }, [seed]);
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
  if (talking) {
    return (
      <div data-home-start="" className="mx-auto flex w-full flex-col rounded-xl border border-stroke bg-surface" style={{ maxWidth: HOME_BOX_WIDTH }}>
        <ChiefExchange chief={chief} />
        <AskForm chief={chief} text={text} setText={setText} ready={ready} onAsk={onAsk} />
      </div>
    );
  }
  // Dropwave (Ash, 11 Nov): Home's chat area is one big box to start a conversation from, not a conversation.
  return (
    <div ref={box} data-home-start="" className="mx-auto flex w-full flex-col items-center gap-4 pt-6 pb-2" style={{ maxWidth: HOME_BOX_WIDTH }}>
      <div className="flex flex-col items-center gap-2 text-center">
        {/* The same hello as an agent's empty chat (MonoHeader): its mascot standing on its name. */}
        {chief.avatar ? <span data-home-avatar="chief" className="relative z-10 grid place-items-center">{chief.avatar}</span> : <ChiefAvatar />}
        <div className={`flex flex-col items-center gap-2 ${chief.avatar ? "-mt-4" : ""}`}>
          <span
            data-home-chief
            data-home-speaker="chief"
            className={chief.avatar ? "mono-pill flex h-8 items-center rounded-full border px-3.5 text-[13px] font-semibold leading-none text-content backdrop-blur-md" : "text-[20px] font-semibold leading-7 text-content"}
          >
            {CHIEF_NAME}
          </span>
          {chief.scope ? <span data-home-scope className="text-[13px] text-content/60">{chief.scope}</span> : null}
        </div>
        {quiet ? (
          <p data-home-quiet className="text-[13px] leading-6 text-content/60">
            All quiet. Ask me anything, or hand work to any project.
          </p>
        ) : null}
      </div>
      <AskForm chief={chief} text={text} setText={setText} ready={ready} onAsk={onAsk} big />
      {chief.starters?.length ? (
        <div className="flex flex-wrap items-center justify-center gap-2" role="group" aria-label="Starters">
          {chief.starters.map((starter) => (
            <button
              key={starter}
              type="button"
              data-home-starter
              className="h-7 rounded-full border border-content/10 px-3 text-[12px] font-medium text-content/55 hover:bg-content/8 hover:text-content"
              onClick={() => onAsk(starter)}
            >
              {starter}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AskForm({
  chief,
  text,
  setText,
  ready,
  onAsk,
  big = false,
}: {
  chief: HomeChief;
  text: string;
  setText: (text: string) => void;
  ready: boolean;
  onAsk: (text: string) => void;
  big?: boolean;
}) {
  return (
    <form
      className={
        big
          ? "flex w-full items-center gap-3 rounded-xl border border-content/10 bg-surface py-2 pr-2 pl-4 focus-within:border-content/25"
          : "mt-3 flex items-center gap-2 border-t border-stroke py-1.5 pr-1.5 pl-4"
      }
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onAsk(text);
        setText("");
      }}
    >
      {big ? <Sparkles className="size-4 shrink-0 text-content/50" strokeWidth={1.75} aria-hidden /> : null}
      <input
        aria-label="Ask"
        value={text}
        placeholder={chief.placeholder ?? "Ask anything, or hand work to any project"}
        onChange={(event) => setText(event.target.value)}
        className={`min-w-0 flex-1 bg-transparent text-content outline-none placeholder:text-content/40 ${big ? "h-10 text-[15px]" : "py-1.5 text-[14px]"}`}
      />
      <button
        type="submit"
        aria-label="Send"
        title="Send"
        disabled={!ready}
        className={`grid shrink-0 place-items-center transition-colors disabled:cursor-default ${big ? "size-9 rounded-lg" : "size-7 rounded-md"} ${ready ? "bg-accent text-black" : "bg-content/12 text-content/60"}`}
      >
        <SendArrow className={big ? "size-4" : "size-3.5"} strokeWidth={2.25} aria-hidden />
      </button>
    </form>
  );
}

/** Dropwave: the three counts at a glance, above the cards. */
function Glance({ label, value, note, tone, onClick }: { label: string; value: number; note: string; tone: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="flex items-center gap-2 text-[12px] text-content/60">
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tone }} />
        {label}
      </span>
      <span className="text-[28px] font-semibold leading-8 tabular-nums text-content">{value}</span>
      <span className="truncate text-[12px] text-content/60">{note}</span>
    </>
  );
  const look = "home-enter flex min-w-0 flex-col gap-1 rounded-xl border border-content/10 px-4 py-3 text-left";
  return onClick ? (
    <button type="button" data-home-glance={label} className={`${look} hover:border-content/16 hover:bg-content/5`} onClick={onClick}>{body}</button>
  ) : (
    <div data-home-glance={label} className={look}>{body}</div>
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
  needsGlance = needsTotal,
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
  onHide,
  onShow,
  onPin,
  onUnpin,
  onAsk,
  onReorder,
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
  /** The Needs you count at a glance, when it is known to be more than the rows listed here. */
  needsGlance?: number;
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
  onHide: (key: string) => void;
  onShow: (key: string) => void;
  onPin: (plugin: string, panelId: string) => void;
  onUnpin: (key: string) => void;
  onAsk: (text: string) => void;
  /** A card was dropped: the new order of every card, to keep in the arrangement. */
  onReorder?: (keys: string[]) => void;
  renderPanel?: (panel: CatalogPanel) => ReactNode;
}) {
  const [custom, setCustom] = useState(false);
  // Dropwave (Ash, 11 Nov): the cards are dragged into place on the page itself; Customize only turns them on and off.
  // The saved order; a drop shows at once and holds until the saved arrangement says otherwise.
  const savedOrder = arrangement.cards ?? [];
  const savedKey = savedOrder.join("\n");
  const [dropped, setDropped] = useState<{ order: string[]; over: string } | null>(null);
  const cardOrder = dropped && dropped.over === savedKey ? dropped.order : savedOrder;
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [askSeed, setAskSeed] = useState<{ text: string; n: number } | undefined>();
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
  // Every card on the page, in the order it was dragged into (a card never dragged keeps its own place).
  const cardKeys = orderCards(
    [...visible.map((ref) => ({ key: sectionKey(ref) })), ...(known ? extraSections.map((extra) => ({ key: extra.key })) : [])],
    cardOrder,
  ).map((card) => card.key);
  const cardLook = (key: string) =>
    `${dragging === key ? " opacity-50" : ""}${dropOn === key && dragging !== key ? " border-accent/70 bg-content/5" : ""}`;
  /** A card takes a drop: the dragged card lands in its place. */
  const cardDrop = (key: string) => ({
    "data-home-drop": dropOn === key && dragging !== null && dragging !== key ? "" : undefined,
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      if (!dragging || dragging === key) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (dropOn !== key) setDropOn(key);
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      if (!dragging) return;
      event.preventDefault();
      const next = dropCard(cardKeys, dragging, key);
      setDropped({ order: next, over: savedKey });
      onReorder?.(next);
      setDragging(null);
      setDropOn(null);
    },
  });
  /** A card is picked up by its title row; the whole card follows the pointer. */
  const cardGrip = (key: string) => ({
    draggable: true,
    "data-home-grip": key,
    title: "Drag to move this card",
    onDragStart: (event: ReactDragEvent<HTMLElement>) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", key);
      const card = event.currentTarget.closest("section");
      if (card) event.dataTransfer.setDragImage(card, 24, 20);
      setDragging(key);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropOn(null);
    },
  });
  const grip = (
    <GripVertical className="size-3.5 shrink-0 text-content/30 opacity-0 transition-opacity group-hover/card:opacity-100" strokeWidth={1.75} aria-hidden />
  );
  return (
    <div data-home data-home-order={visible.map(sectionKey).join(" ")} className="min-h-0 min-w-0 flex-1 overflow-y-auto text-content">
      <div className="mx-auto flex flex-col gap-6 px-8 pt-10 pb-10" style={{ maxWidth: HOME_WIDE_WIDTH }}>
        {/* The app's own page header (New automation, Pages): the title, a quiet line under it, the controls level on the right. */}
        <header data-home-header className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="text-[20px] font-semibold leading-tight text-content">{title}</h1>
            {date ? <p data-home-date className="mt-1.5 truncate text-[13px] text-content/50">{date}</p> : null}
          </div>
          {headerExtra}
          {known ? (
            <button
              ref={toggleRef}
              type="button"
              data-home-action="customize"
              aria-expanded={custom}
              className={`${HOME_HEADER_BUTTON}${custom ? " bg-content/10 text-content" : ""}`}
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
            className="flex flex-col gap-1 rounded-xl border border-content/10 p-3"
          >
            <p className="px-1 pb-1 text-[12px] text-content/50">Turn cards on or off. To move a card, drag it by its title on the page.</p>
            {arranged.map((ref) => {
              const key = sectionKey(ref);
              const title = titleOf(ref, catalog);
              const shown = !arrangement.hidden.includes(key);
              return (
                <div key={key} data-home-arrange={key} className="grid items-center gap-x-1.5 px-1 py-1" style={ARRANGE_COLUMNS}>
                  <span className="min-w-0 truncate text-[13px] text-content">{title}</span>
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
            <div className="mt-1 flex items-center gap-2 border-t border-content/10 px-1 pt-2">
              {/* A card of your own: the Chief of Staff builds it. The words land in the box below for you to finish. */}
              <button
                type="button"
                data-home-action="add-card"
                className={`${HOME_HEADER_BUTTON} gap-1.5`}
                onClick={() => {
                  setCustom(false);
                  setAskSeed((seed) => ({ text: "Add a card to Home that shows ", n: (seed?.n ?? 0) + 1 }));
                }}
              >
                <Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
                Ask for a new card
              </button>
              <span className="min-w-0 flex-1 truncate text-[12px] text-content/50">The Chief of Staff builds it for you.</span>
              <button
                type="button"
                className={PRIMARY_BUTTON}
                onClick={() => setCustom(false)}
              >
                Done
              </button>
            </div>
          </div>
        ) : null}
        {known ? <ChiefBox chief={chief} onAsk={onAsk} quiet={quiet} seed={askSeed} /> : null}
        {known && !chief.missing ? (
          <div data-home-glances className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {arrangement.hidden.includes("needs-you") ? null : (
              <Glance
                label="Needs you"
                value={needsGlance}
                note={needsGlance > 0 ? "Waiting on your answer" : "Nothing is waiting on you"}
                tone={needsGlance > 0 ? NEEDS_YOU_RED : "var(--color-status-ok)"}
                onClick={needsGlance > 0 ? onSeeNeeds : undefined}
              />
            )}
            {arrangement.hidden.includes("moving-now") ? null : (
              <Glance
                label="Working now"
                value={workingTotal}
                note={workingTotal > 0 ? `${workersLabel(workingTotal)} on the job` : "Nobody is working right now"}
                tone="var(--color-accent)"
              />
            )}
            {arrangement.hidden.includes("recent") ? null : (
              <Glance
                label="Done today"
                value={done.length}
                note={done.length > 0 ? "Finished since this morning" : "Nothing finished yet today"}
                tone="var(--color-status-ok)"
              />
            )}
          </div>
        ) : null}
        <div data-home-cards className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
        {visible.map((ref, index) => {
          const key = sectionKey(ref);
          const title = titleOf(ref, catalog);
          const panel = ref.kind === "panel" ? catalog.find((item) => item.plugin === ref.plugin && item.panelId === ref.panelId) : undefined;
          return (
            <section
              key={key}
              data-home-section={key}
              aria-label={title}
              className={`${HOME_CARD}${key === "needs-you" || ref.kind === "panel" ? " md:col-span-2" : ""}${cardLook(key)}`}
              style={{ animationDelay: `${index * HOME_STAGGER_MS}ms`, order: cardKeys.indexOf(key) }}
              {...cardDrop(key)}
            >
              <header {...cardGrip(key)} className="flex cursor-grab items-center gap-2 px-4 pt-3 pb-2 active:cursor-grabbing">
                <SectionMark kind={key} />
                <h2 className="truncate text-[13px] font-medium text-content">{title}</h2>
                {key === "needs-you" && needsTotal > 0 ? <span data-home-count={needsTotal} className="text-[12px] text-content/60">{needsTotal}</span> : null}
                {key === "moving-now" ? <span data-home-workers className="text-[12px] text-content/60">{workersLabel(workingTotal)}</span> : null}
                {key === "recent" ? <span data-home-done className="text-[12px] text-content/60">{done.length}</span> : null}
                <span className="min-w-0 flex-1" />
                {grip}
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
                      className={HOME_ROW}
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
                    <div key={row.key} data-home-line="working" className={HOME_ROW}>
                      {body}
                    </div>
                  );
                }
                return (
                  <button
                    key={row.key}
                    type="button"
                    data-home-line="working"
                    className={`${HOME_ROW} hover:bg-content/8`}
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
                  className={`${HOME_ROW} hover:bg-content/8`}
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
                className={`${HOME_CARD}${cardLook(extra.key)}`}
                style={{ animationDelay: `${(visible.length + index) * HOME_STAGGER_MS}ms`, order: cardKeys.indexOf(extra.key) }}
                {...cardDrop(extra.key)}
              >
                <header {...cardGrip(extra.key)} className="flex cursor-grab items-center gap-2 px-4 pt-3 pb-2 active:cursor-grabbing">
                  <span className="grid size-4 shrink-0 place-items-center text-content/60">
                    {extra.layout === "tiles" ? <Book className="size-3.5" aria-hidden /> : <Zap className="size-3.5" aria-hidden />}
                  </span>
                  <h2 className="truncate text-[13px] font-medium text-content">{extra.title}</h2>
                  {extra.rows.length ? <span className="text-[12px] text-content/60">{extra.rows.length}</span> : null}
                  <span className="min-w-0 flex-1" />
                  {grip}
                  {extra.action ? (
                    <button type="button" className="text-[12px] text-accent" onClick={extra.action.onClick}>{extra.action.label}</button>
                  ) : null}
                </header>
                {extra.rows.length === 0 ? (
                  <p className="px-4 pb-2 text-[13px] text-content/60">{extra.empty}</p>
                ) : extra.layout === "tiles" ? (
                  <div className="grid grid-cols-1 gap-2 px-3 pb-1.5 sm:grid-cols-2">
                    {extra.rows.map((row) => (
                      <button
                        key={row.key}
                        type="button"
                        data-home-line={extra.key}
                        className="flex min-w-0 items-center gap-3 rounded-lg border border-content/10 px-3 py-2.5 text-left hover:border-content/16 hover:bg-content/5"
                        onClick={row.onOpen}
                      >
                        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-content/8 text-content/70">
                          <Book className="size-4" aria-hidden />
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-[13px] font-medium text-content">{row.text}</span>
                          {row.meta ? <span className="truncate text-[12px] text-content/60">{row.meta}</span> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : extra.rows.map((row) => (
                  <button
                    key={row.key}
                    type="button"
                    data-home-line={extra.key}
                    className={`${HOME_ROW} hover:bg-content/8`}
                    onClick={row.onOpen}
                  >
                    <span className="min-w-0 flex-1">{row.text}</span>
                    {row.meta ? <span className="shrink-0 text-content/60">{row.meta}</span> : null}
                  </button>
                ))}
              </section>
            ))
          : null}
        </div>
        {!known && failed ? <p data-home-retry className="text-[13px] text-content/70">Couldn't load home. Trying again.</p> : null}
        {!known && !failed ? <div data-home-loading className="h-8" /> : null}
      </div>
    </div>
  );
}
