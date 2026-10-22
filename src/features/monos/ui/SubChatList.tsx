// The chats a chat started, folded under it (Ash, 20 Oct: "if need be it can be setup sort of like claude code with sub
// chats if needed but usually hidden"): a count that opens them, by itself when one is stuck, asking or failed
// (subChats.ts), and one row per chat with its state's mark. Sub-chats only ever live in a team's Sessions list (a
// project's coding team or a Mono's own team: hub/model/codingTeamList.ts, monoTeams.ts), never in the Monos rail,
// which shows people, not work (Ash, 20 Oct).
import { useState } from "react";
import { CheckCircle, ChevronDown, CircleAlert, CircleX, Clock, Loader } from "../../../shared/ui/icons";
import type { ChildChat } from "../model/delegationView";
import { shownSubChats, subChatsOpen, toggleSubChats, type subChatAttention } from "../model/subChats";
import { delegationLine, runningFor, type StuckWorker } from "../model/workerStuck";

/** A child chat's state as a small mark: working, asking its Lead, stuck, done, failed or stopped. */
export function ChildChatMark({ state, stalled }: { state: ChildChat["state"]; stalled?: boolean }) {
  const props = { className: "size-3.5 shrink-0", strokeWidth: 1.75 };
  if (state === "running" && stalled) return <CircleAlert {...props} className={`${props.className} text-amber-400`} />;
  if (state === "running")
    return <Loader {...props} className={`${props.className} animate-spin text-content/50 motion-reduce:animate-none`} />;
  // Waiting on its Lead, not stuck (Ash, 22 Oct): a grey clock, as on the Mono's line.
  if (state === "question") return <Clock {...props} className={`${props.className} text-content/45`} />;
  if (state === "completed") return <CheckCircle {...props} className={`${props.className} text-emerald-400/90`} />;
  // Amber like a stalled one (r27): red is only for Needs you, and a failed worker is its Lead's to handle.
  if (state === "failed") return <CircleAlert {...props} className={`${props.className} text-amber-400`} />;
  return <CircleX {...props} className={`${props.className} text-content/40`} />;
}

/**
 * The owner's own mark when a sub-chat is stuck: the most urgent one's (red failed, amber stalled). One only waiting on
 * its Lead's answer is not stuck (Ash, 22 Oct): a grey clock.
 */
export function StuckMark({ stuck, hideOnHover = true }: { stuck: readonly StuckWorker[]; hideOnHover?: boolean }) {
  if (!stuck.length) return null;
  const kind = stuck.some((s) => s.kind === "failed") ? "failed" : stuck.some((s) => s.kind === "stalled") ? "stalled" : "asking";
  const Icon = kind === "asking" ? Clock : CircleAlert;
  return (
    <span
      aria-hidden
      data-mono-stuck={stuck.length}
      data-mono-stuck-kind={kind}
      className={`flex shrink-0 items-center${hideOnHover ? " group-hover:hidden group-has-[button:focus-visible]:hidden" : ""}`}
    >
      <Icon
        className={`size-3.5 ${kind === "asking" ? "text-content/45" : "text-amber-400"}`}
        strokeWidth={1.75}
      />
    </span>
  );
}

/** What a child's row says after its title: its row's line, or (no row) its state in a word. */
function childLine(chat: ChildChat, now: number): string {
  if (chat.row) return delegationLine(chat.row, now);
  return chat.state === "running" ? "working" : chat.state === "completed" ? "done" : chat.state === "failed" ? "failed" : "stopped";
}

const ATTRS = { toggle: "data-sub-chats-toggle", list: "data-sub-chats", child: "data-sub-chat", more: "data-sub-chats-more" } as const;

/**
 * A chat's sub-chats, folded under a count unless Ash opened them or one is stuck, six at a time. One click on a
 * sub-chat opens it.
 */
export function SubChatList({
  foldKey,
  owner,
  children,
  attention,
  stuckSplit,
  now,
  onOpen,
}: {
  /** Whose fold this is (subChats.ts): `chat:<id>`. */
  foldKey: string;
  /** Its owner, as its data attributes name it. */
  owner: string;
  children: readonly ChildChat[];
  attention: ReturnType<typeof subChatAttention>;
  /** "1 working · 2 stuck", said to a screen reader on the fold. */
  stuckSplit?: string;
  now: number;
  onOpen: (chat: ChildChat) => void;
}) {
  const [all, setAll] = useState(false);
  const open = subChatsOpen(foldKey, attention.key);
  const { shown, more } = shownSubChats(children, attention.stuck, all);
  const count = `${children.length} ${children.length === 1 ? "sub-chat" : "sub-chats"}`;
  // Folded, it says what needs a look: stuck (stalled or failed) and, apart, what only waits on its Lead's answer.
  const stuckCount = [...attention.stuck.values()].filter((s) => s.kind !== "asking").length;
  const waitingCount = attention.stuck.size - stuckCount;
  const attrs = ATTRS;
  return (
    <div className="ml-5 flex flex-col gap-px border-l border-content/10 pb-0.5 pl-1.5">
      <button
        type="button"
        {...{ [attrs.toggle]: owner }}
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} ${count}${stuckSplit ? `, ${stuckSplit}` : ""}`}
        onClick={() => toggleSubChats(foldKey, attention.key)}
        className="flex h-6 min-w-0 cursor-default items-center gap-1 rounded-md px-1.5 text-left text-[12px] text-content/45 hover:bg-content/6 hover:text-content"
      >
        <ChevronDown
          aria-hidden
          className={`size-3 shrink-0 transition-transform motion-reduce:transition-none ${open ? "" : "-rotate-90"}`}
        />
        <span className="min-w-0 truncate">
          {count}
          {!open && waitingCount ? ` · ${waitingCount} waiting` : ""}
          {!open && stuckCount ? ` · ${stuckCount} stuck` : ""}
        </span>
      </button>
      {open ? (
        <div {...{ [attrs.list]: owner }} className="flex flex-col gap-px">
          {shown.map((chat) => {
            const stalled = chat.state === "running" && !!chat.row?.stallKind;
            const line = childLine(chat, now);
            // How long it has run: muted, after its title, never a second status.
            const ran = chat.row ? runningFor(chat.row, now) : undefined;
            return (
              <button
                key={chat.sessionId}
                type="button"
                {...{ [attrs.child]: chat.sessionId }}
                data-state={stalled ? "stalled" : chat.state}
                title={`${chat.title}, ${line}${ran ? `, running ${ran}` : ""}`}
                aria-label={`Open ${chat.title}, ${line}${ran ? `, running ${ran}` : ""}`}
                onClick={() => onOpen(chat)}
                className="flex h-6 min-w-0 cursor-default items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] text-content/60 hover:bg-content/6 hover:text-content"
              >
                <ChildChatMark state={chat.state} stalled={stalled} />
                <span className="min-w-0 truncate">{chat.title}</span>
                {ran ? (
                  <span data-sub-chat-ran className="ml-auto shrink-0 text-[11px] tabular-nums text-content/35">
                    {ran}
                  </span>
                ) : null}
              </button>
            );
          })}
          {more ? (
            <button
              type="button"
              {...{ [attrs.more]: owner }}
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
