import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { plainTitle } from "../../../shared/text/plainTitle";
import { createPortal } from "react-dom";
import { IS_MAC } from "../../../platform/tauri/platform";
import { ArrowLeft, Check, MessageMultiple, Pencil, Plus, Trash2, X } from "../../../shared/ui/icons";
import { confirmDelete } from "../../../shared/ui/ConfirmDelete";
import {
  listMonos,
  monoLook,
  monosSnapshot,
  subscribeMonos,
  type Mono,
} from "../../monos/model/mono";
import { MonoComposer } from "../../monos/ui/MonoComposer";
import { MonoRailMascot } from "../../monos/ui/MonoRailMascot";
import { hubData } from "../model/hubData";
import {
  addMember,
  createChat,
  deleteConversation,
  ensureLeadership,
  chatSaveProblem,
  getChat,
  removeMember,
  renameChat,
  renameConversation,
  startConversation,
  sendMessage,
  simulateReplies,
  replyProblem,
  retryReply,
  roomDrafts,
  roomGoal,
  setRoomLead,
  setRoomResponder,
  startGoal,
  roomPick,
  roomWorking,
  useHubChatsVersion,
} from "../model/hubChats";
import { openCodingTeam, setHubSelection, useHubSelection } from "../model/hubNav";
import { findWaiting } from "../model/waiting";
import { roomAttachments } from "../model/roomAttachments";
import { GOAL_MAX_TURNS, RESPONDER_LABELS, RESPONDER_MODES, responderOf } from "../model/roomModes";
import { quickModel } from "../model/roomDecider";
import { hostOf } from "../model/roomTurns";
import type { ChatMessage, GroupChat, RoomAttachment } from "../model/types";
import type { Attachment } from "../../sessions/model/session";
import { StatusMark } from "./StatusMark";
import { RoomMessage, RoomStatusLine, RoomText } from "./RoomMessage";
import { MonoDraftsInChat } from "../../selfBuild/ui/MonoDraftCard";
import { useWaitingDrafts } from "../../selfBuild/model/monoMake";
import { useWaitingTeamDrafts } from "../../selfBuild/model/teamMake";
import { TeamDraftsInChat } from "../../selfBuild/ui/TeamDraftCard";
import { CouncilRoom } from "../../council/ui/CouncilRoom";
import { CouncilSwitch } from "../../council/ui/CouncilSwitch";
import { consumeCouncilCommand } from "../../council/model/command";
import { requestCouncil } from "../../council/model/host";

function useMonos(): Mono[] {
  const snap = useSyncExternalStore(subscribeMonos, monosSnapshot, monosSnapshot);
  return useMemo(() => listMonos(), [snap]);
}

function projectName(projectId: string): string {
  return hubData().listProjects().find((p) => p.id === projectId)?.name ?? projectId;
}

/** The chat's display name in sentences: "EXO game's leadership team". */
function chatPhrase(chat: GroupChat): string {
  return chat.isDefault ? `${projectName(chat.projectId)}'s leadership team` : chat.name;
}

/**
 * A project's group chat: the Leadership team by default, or one Ash made.
 * A light list of members and past conversations beside the chat. No
 * Explorer and no coding controls.
 */
export function GroupChatView({ chatId, projectId }: { chatId: string; projectId: string }) {
  useHubChatsVersion();
  const chat = getChat(chatId) ?? ensureLeadership(projectId);
  const monos = useMonos();
  const members = chat.memberIds.map((id) => monos.find((m) => m.id === id)).filter((m): m is Mono => !!m);
  const [convId, setConvId] = useState<string | undefined>();
  const [picker, setPicker] = useState<DOMRect | null>(null);
  const [renaming, setRenaming] = useState(false);
  /** New conversation opens a screen; nothing is made until the first message is sent. */
  const [drafting, setDrafting] = useState(false);
  /** The name Ash gave the new conversation before its first message (double-click "New conversation"). */
  const [draftTitle, setDraftTitle] = useState<string | undefined>();
  /** Which conversation's name is being edited: its id, or "draft" for the one not started yet. */
  const [renamingConv, setRenamingConv] = useState<string | null>(null);
  const removeConversation = async (id: string, title: string) => {
    if (!(await confirmDelete(title))) return;
    if (convId === id) setConvId(undefined);
    deleteConversation(chat.id, id);
  };
  /** Back out of the New conversation screen: nothing was made, and the conversation he was in shows again. */
  const leaveDraft = () => {
    setDrafting(false);
    setDraftTitle(undefined);
    if (renamingConv === "draft") setRenamingConv(null);
  };
  /** WP-22: the next message is a goal the room's lead works toward. */
  const [goalNext, setGoalNext] = useState(false);
  // WP-23: a council on this room. A room that already has one opens on it; closing it stays closed until the room changes.
  // Dropwave: council is a mode of the chat, off until its switch under the box is turned on (an unfinished council
  // still opens on itself, so its answer is not lost behind the switch).
  const councilUnfinished = (id: string) => {
    const phase = getChat(id)?.council?.phase;
    return phase === "restate" || phase === "running";
  };
  const [councilOpen, setCouncilOpen] = useState(() => councilUnfinished(chatId));
  useEffect(() => {
    setCouncilOpen(councilUnfinished(chatId));
  }, [chatId]);
  const begin = (text: string, attachments?: RoomAttachment[]) => {
    const id = startConversation(chat.id, text, { title: draftTitle, attachments });
    setDrafting(false);
    setDraftTitle(undefined);
    setConvId(id);
    answer(id);
  };
  /** Ash sent: the room answers, or (goal on) its lead starts working toward the goal. */
  const answer = (id: string | undefined) => {
    if (goalNext) {
      setGoalNext(false);
      void startGoal(chat.id, id);
    } else simulateReplies(chat.id, id);
  };
  useEffect(() => {
    if (!drafting) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest("[data-hub-conversation-rename]")) return;
      leaveDraft();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [drafting, renamingConv]); // eslint-disable-line react-hooks/exhaustive-deps
  const addRef = useRef<HTMLButtonElement>(null);
  const openPicker = () => setPicker(addRef.current?.getBoundingClientRect() ?? null);
  const conv = drafting ? undefined : chat.conversations.find((c) => c.id === convId) ?? chat.conversations[0];
  // 'Take a look' can land here with a focus: open that conversation, scroll
  // to the exact message and highlight it briefly.
  const sel = useHubSelection();
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    const ref = sel.focus;
    if (!ref) return;
    const owner = chat.conversations.find((c) => c.messages.some((m) => m.refId === ref));
    if (!owner) return;
    setConvId(owner.id);
    setFlash(ref);
    setHubSelection({ project: sel.project, item: sel.item });
    requestAnimationFrame(() =>
      document.querySelector(`[data-hub-msg-ref="${ref}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
    const t = window.setTimeout(() => setFlash(null), 2200);
    return () => window.clearTimeout(t);
  }, [sel.focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const nameOf = (from: string) => {
    const mono = monos.find((m) => m.id === from);
    return mono ? monoLook(mono).name : from;
  };
  // Who is working on a room turn right now: their mascot moves, and the line above the composer says so.
  const working = new Set(roomWorking(chat.id).map((w) => w.monoId));
  // Turns writing now: their words show as live messages at the end, and become the message in the same place.
  const drafts = conv ? roomDrafts(chat.id, conv.id) : [];
  const shown: { message: ChatMessage; live: boolean }[] = [
    ...(conv?.messages ?? []).map((message) => ({ message, live: false })),
    ...drafts.map((d) => ({
      message: { id: d.id, from: d.monoId, kind: "mono" as const, text: d.text, quiet: d.quiet, pick: d.pick, ...(d.replyTo ? { replyTo: d.replyTo } : {}) },
      live: true,
    })),
  ];
  // The room talks on its own: new messages (and words as they are written) keep the view at the bottom unless Ash
  // scrolled up to read.
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // A drafted Mono's or team's card landing in the conversation keeps it at the bottom too, like a message.
  const monoDrafts = useWaitingDrafts().length;
  const teamDrafts = useWaitingTeamDrafts().length;
  const count = `${conv?.messages.length ?? 0}:${drafts.map((d) => d.text.length).join(",")}:${monoDrafts}:${teamDrafts}`;
  useEffect(() => {
    pinned.current = true;
  }, [conv?.id]);
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current && !sel.focus) el.scrollTop = el.scrollHeight;
  }, [count, conv?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-hub-chat={chat.id}>
      {/* Members and past conversations. */}
      <div className="sidebar-glass relative flex w-[240px] shrink-0 flex-col border-r border-stroke">
        <div className="group flex h-10 shrink-0 items-center gap-1 px-3" data-tauri-drag-region="deep">
          {renaming ? (
            <input
              autoFocus
              data-hub-rename-input
              data-tauri-drag-region="false"
              defaultValue={chat.name}
              onBlur={(e) => {
                renameChat(chat.id, e.currentTarget.value);
                setRenaming(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenaming(false);
              }}
              className="min-w-0 flex-1 rounded-md bg-content/8 px-1.5 py-0.5 text-[13px] font-medium text-content outline-none"
            />
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-content">{chat.name}</span>
              <button
                type="button"
                title="Rename chat"
                aria-label="Rename chat"
                data-hub-rename
                onClick={() => setRenaming(true)}
                className="grid size-5 place-items-center rounded-md text-content/60 opacity-0 hover:bg-content/8 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
              >
                <Pencil className="size-3" strokeWidth={1.75} />
              </button>
            </>
          )}
        </div>
        <div className="px-3 pb-3">
          <div className="pb-1 text-xs leading-5 text-content/60">In this chat</div>
          <div className="flex flex-col gap-0.5">
            <div className="flex h-6 items-center gap-2 text-[13px] text-content/80">
              <span className="grid size-4 place-items-center rounded-full bg-content/15 text-[9px] text-content">A</span>
              You
            </div>
            {members.map((mono) => {
              const look = monoLook(mono);
              return (
                <div key={mono.id} className={`group flex items-center gap-2 text-[13px] text-content/80 ${look.role ? "min-h-6 py-0.5" : "h-6"}`} data-hub-member={mono.id} data-hub-member-working={working.has(mono.id) || undefined}>
                  <MonoRailMascot name={look.mascot} color={look.color} status={working.has(mono.id) ? "working" : "idle"} />
                  {/* r61 (PM's blind G4): each member says what it does, like the sidebar's role line. */}
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate">{look.name}</span>
                    {look.role ? <span className="truncate text-[11px] text-content/60" data-hub-member-role>{look.role}</span> : null}
                  </span>
                  <button
                    type="button"
                    title={`Remove ${look.name} from this chat`}
                    aria-label={`Remove ${look.name} from this chat`}
                    data-hub-remove-member={mono.id}
                    onClick={() => removeMember(chat.id, mono.id)}
                    className="grid size-5 place-items-center rounded-md text-content/60 opacity-0 hover:bg-content/8 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <X className="size-3" strokeWidth={1.75} />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            ref={addRef}
            data-hub-add-mono
            onClick={() => (picker ? setPicker(null) : openPicker())}
            className="mt-1 flex h-6 items-center gap-2 rounded-md px-0.5 text-[13px] text-content/60 hover:text-content"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
            Add a first mate
          </button>
        </div>
        {members.length ? <RoomResponder chat={chat} members={members} /> : null}
        {picker ? <MonoPicker chat={chat} monos={monos} anchor={picker} onClose={() => setPicker(null)} /> : null}
        {members.length || chat.conversations.length ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
            <div className="flex items-center px-1 pb-1">
              <span className="flex-1 text-xs leading-5 text-content/60">Conversations</span>
              <button
                type="button"
                title="New conversation"
                aria-label="New conversation"
                data-hub-new-conversation
                onClick={() => {
                  setDrafting(true);
                  setRenamingConv(null);
                }}
                className="grid size-5 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content"
              >
                <Plus className="size-3.5" strokeWidth={1.75} />
              </button>
            </div>
            {drafting ? (
              renamingConv === "draft" ? (
                <ConversationNameInput
                  value={draftTitle ?? ""}
                  placeholder="New conversation"
                  onDone={(name) => {
                    if (name !== undefined) setDraftTitle(name.trim() || undefined);
                    setRenamingConv(null);
                  }}
                />
              ) : (
                <div
                  data-hub-conversation-draft
                  title="Name it"
                  onDoubleClick={() => setRenamingConv("draft")}
                  className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-dashed border-content/25 bg-selection pl-2 pr-1 text-[13px] text-content"
                >
                  <span data-hub-conversation-draft-title className={`min-w-0 flex-1 truncate ${draftTitle ? "" : "italic text-content/75"}`}>{draftTitle ?? "New conversation"}</span>
                  <span data-hub-conversation-draft-word className="shrink-0 text-[11px] text-content/60">Draft</span>
                  <button
                    type="button"
                    title="Name it"
                    aria-label="Name this conversation"
                    data-hub-conversation-draft-pencil
                    onClick={() => setRenamingConv("draft")}
                    className="grid size-5 shrink-0 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content"
                  >
                    <Pencil className="size-3" strokeWidth={1.75} />
                  </button>
                </div>
              )
            ) : null}
            {chat.conversations.map((c) =>
              renamingConv === c.id ? (
                <ConversationNameInput
                  key={c.id}
                  value={c.title}
                  onDone={(name) => {
                    if (name !== undefined) renameConversation(chat.id, c.id, name);
                    setRenamingConv(null);
                  }}
                />
              ) : (
                // A conversation can be deleted (r49): the trash on hover, or a right-click, then the shared confirm.
                <div
                  key={c.id}
                  className="group/conv relative flex shrink-0 items-center"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    void removeConversation(c.id, c.title);
                  }}
                >
                  <button
                    type="button"
                    title="Double-click to rename"
                    data-hub-conversation={c.id}
                    onClick={() => { leaveDraft(); setConvId(c.id); }}
                    onDoubleClick={() => { leaveDraft(); setConvId(c.id); setRenamingConv(c.id); }}
                    className={`flex h-7 w-full items-center rounded-md pl-2 pr-7 text-left text-[13px] ${
                      c.id === conv?.id ? "bg-selection text-content" : "text-content/80 hover:bg-selection-hover"
                    }`}
                  >
                    <span className="min-w-0 truncate">
                      {c.when} · {plainTitle(c.title)}
                    </span>
                  </button>
                  <button
                    type="button"
                    data-hub-conversation-delete={c.id}
                    title={`Delete ${plainTitle(c.title)}`}
                    aria-label={`Delete ${plainTitle(c.title)}`}
                    onClick={() => void removeConversation(c.id, c.title)}
                    className="absolute right-1 grid size-5 place-items-center rounded-md text-content/45 opacity-0 hover:bg-content/8 hover:text-red-400 focus-visible:opacity-100 group-hover/conv:opacity-100"
                  >
                    <Trash2 className="size-3" strokeWidth={1.75} />
                  </button>
                </div>
              ),
            )}
          </div>
        ) : null}
      </div>

      {/* The chat. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region="deep">
          <MessageMultiple className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
          {drafting || conv ? (
            // Out of the header's drag region: a double-click here renames the conversation, and must not also zoom
            // the window (Mac round 4, 21 Oct). The rest of the header still drags and zooms like a title bar.
            <span
              className="min-w-0 truncate text-[13px] text-content"
              data-hub-conversation-title
              data-tauri-drag-region="false"
              title="Double-click to rename"
              onDoubleClick={() => setRenamingConv(drafting ? "draft" : conv!.id)}
            >
              {drafting ? (draftTitle ?? "New conversation") : plainTitle(conv!.title)}
            </span>
          ) : null}
          {drafting || conv ? (
            <button
              type="button"
              title="Rename"
              aria-label="Rename conversation"
              data-hub-conversation-pencil
              data-tauri-drag-region="false"
              onClick={() => setRenamingConv(drafting ? "draft" : conv!.id)}
              className="grid size-5 shrink-0 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content"
            >
              <Pencil className="size-3" strokeWidth={1.75} />
            </button>
          ) : (
            // A room with no conversation yet shows its own name here: out of the drag region too, so a double-click
            // on it doesn't zoom the window either (Mac run, 21 Oct).
            <span className="min-w-0 truncate text-[13px] text-content" data-hub-room-header-name data-tauri-drag-region="false">
              {chat.name}
            </span>
          )}
          {IS_MAC ? null : <div className="w-[120px]" />}
        </div>
        {councilOpen ? (
          <CouncilRoom chatId={chat.id} onClose={() => setCouncilOpen(false)} />
        ) : members.length === 0 && !conv ? (
          <EmptyChat chat={chat} onAdd={openPicker} />
        ) : drafting ? (
          <NewConversationScreen
            members={members}
            phrase={chatPhrase(chat)}
            back={chat.conversations.length ? (conv0Title(chat, convId) ?? "the last conversation") : undefined}
            onBack={leaveDraft}
            onPick={(text) => begin(text)}
          />
        ) : (
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
            }}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <div className="flex w-full flex-col gap-4 px-6 py-6 text-[13px] leading-5 xl:px-8">
              {conv && shown.length ? (
                shown.map(({ message: msg, live }, index) =>
                  msg.from === "ash" || msg.kind === "notice" || msg.kind === "system" ? (
                    <RoomMessage key={msg.id} chatId={chat.id} message={msg} previous={shown[index - 1]?.message} messages={conv.messages} nameOf={nameOf} />
                  ) : (
                    // A live message keeps its key when it lands, so it fills in where it is instead of being replaced.
                    <div
                      key={msg.id}
                      data-hub-msg-ref={msg.refId}
                      data-hub-msg-quiet={msg.quiet || undefined}
                      data-hub-msg-draft={live || undefined}
                      aria-busy={live || undefined}
                      className={`hub-fade-in group -mx-2 rounded-lg px-2 py-1 transition-colors duration-700 ${msg.refId && flash === msg.refId ? "bg-content/10" : ""}`}
                    >
                      <RoomMessage chatId={chat.id} message={msg} previous={shown[index - 1]?.message} messages={conv.messages} nameOf={nameOf} live={live}>
                        <RoomText text={msg.text} className={`max-w-[75ch] ${msg.quiet ? "text-content/85" : "text-content"}`} />
                      </RoomMessage>
                      {(() => {
                        const w = msg.refId ? findWaiting(msg.refId) : undefined;
                        if (!w?.state) return null;
                        return (
                          <div className="flex items-center gap-3 pt-1.5">
                            <StatusMark state={w.state} lead={w.lead} />
                            <button
                              type="button"
                              data-hub-take-look={w.id}
                              onClick={() => openCodingTeam(w.projectId)}
                              className="rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12"
                            >
                              Take a look
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  ),
                )
              ) : (
                <p className="py-10 text-center text-content/60">
                  No messages yet. Say hello to {members.map((m) => monoLook(m).name).join(", ")}.
                </p>
              )}
              {/* A new Mono or team a seat drafted here: a message in the conversation, after the words that offered it (r29, A6). */}
              <MonoDraftsInChat room={chat.id} conv={conv?.id} />
              <TeamDraftsInChat room={chat.id} conv={conv?.id} />
            </div>
          </div>
        )}
        {councilOpen ? null : drafting ? <div className="h-6 w-full shrink-0 px-6 xl:px-8" /> : <RoomStatusLine chatId={chat.id} convId={conv?.id} nameOf={nameOf} />}
        {!councilOpen && chatSaveProblem() ? <div role="alert" className="w-full px-6 pb-2 text-[12px] text-amber-400 xl:px-8" data-hub-chat-save-error>
          {chatSaveProblem()}
        </div> : null}
        {!councilOpen && !drafting && replyProblem(chat.id, conv?.id) ? <div role="alert" className="w-full px-6 pb-2 text-[12px] text-content/70 xl:px-8" data-hub-chat-error>
          {roomPick(chat.id) ? <span data-hub-chat-error-pick={roomPick(chat.id)!.id}>{nameOf(roomPick(chat.id)!.id)} was picked to answer ({roomPick(chat.id)!.why}). </span> : null}
          {replyProblem(chat.id, conv?.id)} <button type="button" onClick={() => void retryReply(chat.id)} className="ml-2 underline">Try again</button>
        </div> : null}
        {councilOpen ? null : <GoalBar chat={chat} members={members} convId={conv?.id} on={goalNext} onChange={setGoalNext} />}
        {councilOpen ? null : <div className="w-full shrink-0 px-6 pb-3 xl:px-8">
          <MonoComposer
            sessionId={`hub-chat:${chat.id}`}
            name={chatPhrase(chat)}
            onSubmit={async (text: string, files: Attachment[]) => {
              // WP-23: /council convenes a council instead of sending the line to the room.
              const council = consumeCouncilCommand(text);
              if (council.matched) return requestCouncil(council.question, chat.memberIds);
              // Sending while the team is answering is fine: the room takes it up as soon as the current turn ends.
              if (!text.trim() && !files.length) return false;
              // Every file is kept by its path first (a pasted picture is saved to one); one that can't be kept stops
              // the send with the reason, and the message and files stay in the composer.
              const kept = files.length ? await roomAttachments(files) : undefined;
              if (drafting) {
                begin(text.trim(), kept);
                return;
              }
              sendMessage(chat.id, text.trim(), conv?.id, kept);
              answer(conv?.id);
            }}
          />
          {/* WP-23, Dropwave: council is a mode of this chat. The switch sits under the box, here and in the council. */}
          <div className="px-1 pt-2">
            <CouncilSwitch on={false} onChange={() => setCouncilOpen(true)} />
          </div>
        </div>}
      </div>
    </div>
  );
}

/**
 * WP-22: who answers in this room (its responder mode) and who leads it. Auto names the quick model it asks, or says
 * the lead answers until one is set up.
 */
function RoomResponder({ chat, members }: { chat: GroupChat; members: Mono[] }) {
  const mode = responderOf(chat);
  const lead = hostOf(members.map((m) => ({ id: m.id, name: monoLook(m).name })), chat.leadId);
  const model = mode === "auto" ? quickModel() : undefined;
  const select = "h-6 w-full rounded-md border border-content/15 bg-transparent px-1 text-[12px] text-content";
  return (
    <div className="flex flex-col gap-1 px-3 pb-3" data-hub-room-settings>
      <label className="flex flex-col gap-0.5 text-xs leading-5 text-content/60">
        Who answers
        <select className={select} value={mode} onChange={(e) => setRoomResponder(chat.id, e.target.value as typeof mode)} data-hub-room-responder>
          {RESPONDER_MODES.map((m) => (
            <option key={m} value={m}>
              {RESPONDER_LABELS[m].label}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[11px] leading-4 text-content/55" data-hub-room-responder-hint>
        {RESPONDER_LABELS[mode].hint}
        {mode === "auto" ? (model ? ` It asks ${model.name}.` : " Add a model in Settings, Other models; until then the lead answers.") : ""}
      </p>
      {members.length > 1 ? (
        <label className="flex flex-col gap-0.5 text-xs leading-5 text-content/60">
          Lead
          <select className={select} value={lead?.id ?? ""} onChange={(e) => setRoomLead(chat.id, e.target.value || undefined)} data-hub-room-lead>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {monoLook(m).name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

/** WP-22: above the composer: make the next message a goal for the lead, and show how a goal run stands. */
function GoalBar({ chat, members, convId, on, onChange }: { chat: GroupChat; members: Mono[]; convId?: string; on: boolean; onChange: (on: boolean) => void }) {
  if (!members.length) return null;
  const goal = convId ? roomGoal(chat.id, convId) : undefined;
  const lead = hostOf(members.map((m) => ({ id: m.id, name: monoLook(m).name })), chat.leadId);
  return (
    <div className="flex w-full shrink-0 items-center gap-2 px-6 pb-1 text-[12px] text-content/60 xl:px-8" data-hub-goal-bar data-hub-goal-state={goal?.state}>
      <button
        type="button"
        aria-pressed={on}
        onClick={() => onChange(!on)}
        className={`rounded-md border px-1.5 py-0.5 ${on ? "border-content/40 text-content" : "border-content/15 hover:text-content"}`}
        data-hub-goal-toggle
      >
        Goal
      </button>
      {on ? (
        <span data-hub-goal-hint>
          Your next message is a goal. {lead?.name ?? "The lead"} works toward it for up to {GOAL_MAX_TURNS} turns and stops when it's done or needs you.
        </span>
      ) : null}
    </div>
  );
}

/** The name of the conversation Back returns to. */
function conv0Title(chat: GroupChat, convId: string | undefined): string | undefined {
  return (chat.conversations.find((c) => c.id === convId) ?? chat.conversations[0])?.title;
}

/** A conversation's name being edited: Enter or leaving keeps it, Escape keeps the old one. */
function ConversationNameInput({ value, placeholder, onDone }: { value: string; placeholder?: string; onDone: (name: string | undefined) => void }) {
  const done = useRef(false);
  const finish = (name: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      autoFocus
      aria-label="Conversation name"
      data-hub-conversation-rename
      defaultValue={value}
      placeholder={placeholder}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") {
          e.preventDefault();
          finish(undefined);
        }
      }}
      className="h-7 shrink-0 rounded-md bg-selection px-2 text-[13px] text-content outline-none ring-1 ring-content/30"
    />
  );
}

/** The calm screen New conversation opens: who you're talking to, a few starters, and the composer below. */
function NewConversationScreen({
  members,
  phrase,
  back,
  onBack,
  onPick,
}: {
  members: Mono[];
  phrase: string;
  /** The conversation Back returns to (none: there is nothing to go back to). */
  back?: string;
  onBack: () => void;
  onPick: (text: string) => void;
}) {
  const starters = ["What changed since yesterday?", "What needs me today?", "Plan this week with me"];
  return (
    <div className="relative grid min-h-0 flex-1 place-items-center px-8" data-hub-new-conversation-screen>
      {back ? (
        <button
          type="button"
          data-hub-new-conversation-back
          title={`Back to ${back} (Esc)`}
          onClick={onBack}
          className="absolute left-4 top-3 flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-content/70 hover:bg-content/8 hover:text-content"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
          Back
        </button>
      ) : null}
      <div className="flex max-w-[460px] flex-col items-center gap-4 text-center">
        <div className="flex -space-x-1">
          {members.slice(0, 5).map((m) => {
            const look = monoLook(m);
            return (
              <span key={m.id} className="grid size-9 place-items-center rounded-[10px] bg-surface-raised ring-1 ring-surface-ring">
                <MonoRailMascot name={look.mascot} color={look.color} className="size-5" />
              </span>
            );
          })}
        </div>
        <div>
          <p className="text-[17px] font-medium text-content">New conversation with {phrase}</p>
          <p className="mt-1 text-[13px] leading-5 text-content/70">Say anything to start. Nothing is saved until you send.</p>
          <p className="mt-0.5 text-[12px] leading-5 text-content/60">Click the pencil to name it. + adds a photo or a file.</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {starters.map((s) => (
            <button key={s} type="button" onClick={() => onPick(s)} className="rounded-md bg-surface px-3 py-1.5 text-[12px] text-content/85 ring-1 ring-surface-ring hover:bg-surface-raised">
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function EmptyChat({ chat, onAdd }: { chat: GroupChat; onAdd: () => void }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-8" data-hub-chat-empty>
      <div className="flex max-w-[380px] flex-col items-center gap-3 text-center">
        <p className="text-[13px] text-content">Only you are in {chatPhrase(chat)} so far.</p>
        <p className="text-[13px] leading-5 text-content/60">
          A leadership team is a group chat with the first mates you choose. Add one to start talking.
        </p>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1.5 rounded-md bg-content/10 px-3 py-1.5 text-[13px] text-content hover:bg-content/15"
        >
          <Plus className="size-3.5" strokeWidth={1.75} />
          Add a first mate
        </button>
      </div>
    </div>
  );
}

/** Any Mono can join any chat. A floating menu; clicking outside closes it. */
function MonoPicker({ chat, monos, anchor, onClose }: { chat: GroupChat; monos: Mono[]; anchor: DOMRect; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const t = window.setTimeout(() => document.addEventListener("mousedown", down), 0);
    document.addEventListener("keydown", key);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const top = Math.min(anchor.bottom + 6, window.innerHeight - 40 - monos.length * 44);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-hub-mono-picker
      style={{ left: anchor.left, top: Math.max(8, top) }}
      className="fixed z-50 w-[260px] rounded-lg border border-stroke popover-glass p-1 shadow-2xl"
    >
      <div className="px-2 pb-1 pt-1 text-xs text-content/60">Add a first mate to {chat.name}</div>
      {monos.map((mono) => {
        const look = monoLook(mono);
        const inChat = chat.memberIds.includes(mono.id);
        const hubProjects = hubData().listProjects();
        const where =
          look.projects
            .map((p) => hubProjects.find((hp) => hp.folder === p.path)?.name ?? p.name)
            .join(", ") || "No project yet";
        return (
          <button
            key={mono.id}
            type="button"
            role="menuitem"
            disabled={inChat}
            onClick={() => {
              addMember(chat.id, mono.id);
              onClose();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-content/8 disabled:hover:bg-transparent"
          >
            <MonoRailMascot name={look.mascot} color={look.color} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-content">{look.name}</span>
              <span className="block truncate text-[11px] text-content/60">{where}</span>
            </span>
            {inChat ? <span className="text-[11px] text-content/60">In chat</span> : null}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/** Make a new group chat for this project and pick who is in it. */
export function NewGroupChat({ projectId }: { projectId: string }) {
  const monos = useMonos();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-hub-new-chat>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region="deep">
        <MessageMultiple className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
        <span className="text-[13px] text-content">New group chat</span>
      </div>
      <div className="mx-auto flex w-full max-w-[520px] flex-col gap-5 px-8 py-8">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-content/60">Name</span>
          <input
            data-hub-new-chat-name
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="For example, Launch week"
            className="rounded-md border border-stroke bg-content/5 px-2.5 py-1.5 text-[13px] text-content outline-none placeholder:text-content/45 focus:border-content/25"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-content/60">Who's in it (you always are)</span>
          {monos.map((mono) => {
            const look = monoLook(mono);
            const on = picked.includes(mono.id);
            return (
              <button
                key={mono.id}
                type="button"
                onClick={() => setPicked(on ? picked.filter((id) => id !== mono.id) : [...picked, mono.id])}
                role="checkbox"
                aria-checked={on}
                className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] ${on ? "bg-content/14 font-medium text-content" : "text-content/80 hover:bg-content/6"}`}
              >
                <span
                  className={`grid size-4 shrink-0 place-items-center rounded-full ${on ? "bg-content text-background-base" : "border border-content/40"}`}
                >
                  {on ? <Check className="size-3" strokeWidth={2.5} /> : null}
                </span>
                <MonoRailMascot name={look.mascot} color={look.color} />
                <span className="min-w-0 flex-1 truncate">{look.name}</span>
              </button>
            );
          })}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setHubSelection({ project: projectId, item: "leadership-team" })}
            className="rounded-md px-3 py-1.5 text-[13px] text-content/80 hover:bg-content/8"
          >
            Cancel
          </button>
          <button
            type="button"
            data-hub-create-chat
            disabled={!name.trim()}
            onClick={() => {
              const chat = createChat(projectId, name, picked);
              setHubSelection({ project: projectId, item: `chat:${chat.id}` });
            }}
            className="rounded-md bg-content/12 px-3 py-1.5 text-[13px] text-content hover:bg-content/16 disabled:opacity-50"
          >
            Create chat
          </button>
        </div>
      </div>
    </div>
  );
}
