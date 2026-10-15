import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { IS_MAC } from "../../../platform/tauri/platform";
import { Check, MessageMultiple, Pencil, Plus, X } from "../../../shared/ui/icons";
import {
  listMonos,
  monoLook,
  monosSnapshot,
  subscribeMonos,
  type Mono,
} from "../../monos/model/mono";
import { MonoComposer } from "../../monos/ui/MonoComposer";
import { MonoRailMascot } from "../../monos/ui/MonoRailMascot";
import { AgentMarkdown } from "../../sessions/ui/AgentMarkdown";
import { hubData } from "../model/hubData";
import {
  addMember,
  createChat,
  ensureLeadership,
  getChat,
  removeMember,
  renameChat,
  renameConversation,
  startConversation,
  sendMessage,
  simulateReplies,
  typingIn,
  useHubChatsVersion,
} from "../model/hubChats";
import { setHubSelection, useHubSelection } from "../model/hubNav";
import { findWaiting } from "../model/waiting";
import type { GroupChat } from "../model/types";
import { StatusMark } from "./StatusMark";

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
  const [renamingConv, setRenamingConv] = useState<string | null>(null);
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

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-hub-chat={chat.id}>
      {/* Members and past conversations. */}
      <div className="sidebar-glass relative flex w-[240px] shrink-0 flex-col border-r border-stroke">
        <div className="group flex h-10 shrink-0 items-center gap-1 px-3" data-tauri-drag-region="deep">
          {renaming ? (
            <input
              autoFocus
              data-hub-rename-input
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
                <div key={mono.id} className="group flex h-6 items-center gap-2 text-[13px] text-content/80">
                  <MonoRailMascot name={look.mascot} color={look.color} />
                  <span className="min-w-0 flex-1 truncate">{look.name}</span>
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
            Add a Mono
          </button>
        </div>
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
                onClick={() => setDrafting(true)}
                className="grid size-5 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content"
              >
                <Plus className="size-3.5" strokeWidth={1.75} />
              </button>
            </div>
            {drafting ? (
              <div data-hub-conversation-draft className="flex h-7 shrink-0 items-center rounded-md border border-dashed border-content/25 bg-selection px-2 text-[13px] text-content">
                New conversation
              </div>
            ) : null}
            {chat.conversations.map((c) =>
              renamingConv === c.id ? (
                <input
                  key={c.id}
                  autoFocus
                  aria-label="Conversation name"
                  data-hub-conversation-rename
                  defaultValue={c.title}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => {
                    renameConversation(chat.id, c.id, e.currentTarget.value);
                    setRenamingConv(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setRenamingConv(null);
                  }}
                  className="h-7 shrink-0 rounded-md bg-selection px-2 text-[13px] text-content outline-none ring-1 ring-content/30"
                />
              ) : (
                <button
                  key={c.id}
                  type="button"
                  title="Double-click to rename"
                  data-hub-conversation={c.id}
                  onClick={() => { setDrafting(false); setConvId(c.id); }}
                  onDoubleClick={() => setRenamingConv(c.id)}
                  className={`flex h-7 shrink-0 items-center rounded-md px-2 text-left text-[13px] ${
                    c.id === conv?.id ? "bg-selection text-content" : "text-content/80 hover:bg-selection-hover"
                  }`}
                >
                  <span className="min-w-0 truncate">
                    {c.when} · {c.title}
                  </span>
                </button>
              ),
            )}
          </div>
        ) : null}
      </div>

      {/* The chat. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region="deep">
          <MessageMultiple className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
          <span className="min-w-0 truncate text-[13px] text-content">{drafting ? "New conversation" : conv ? conv.title : chat.name}</span>
          {IS_MAC ? null : <div className="w-[120px]" />}
        </div>
        {members.length === 0 && !conv ? (
          <EmptyChat chat={chat} onAdd={openPicker} />
        ) : drafting ? (
          <NewConversationScreen
            members={members}
            phrase={chatPhrase(chat)}
            onPick={(text) => {
              const id = startConversation(chat.id, text);
              setDrafting(false);
              setConvId(id);
              simulateReplies(chat.id, id);
            }}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-8 py-6 text-[13px] leading-5">
              {conv && conv.messages.length ? (
                conv.messages.map((msg) =>
                  msg.from === "ash" ? (
                    <div key={msg.id} className="flex justify-end">
                      <div className="agent-chat-user-bubble max-w-[70%] rounded-2xl bg-content/10 px-3 py-1.5 text-content">{msg.text}</div>
                    </div>
                  ) : (
                    <div
                      key={msg.id}
                      data-hub-msg-ref={msg.refId}
                      data-hub-msg-quiet={msg.quiet || undefined}
                      className={`hub-fade-in -mx-2 rounded-lg px-2 py-1 transition-colors duration-700 ${msg.refId && flash === msg.refId ? "bg-content/10" : ""}`}
                    >
                      <div className="pb-0.5 text-xs text-content/60">{nameOf(msg.from)}</div>
                      <AgentMarkdown text={msg.text} className={msg.quiet ? "text-content/85" : "text-content"} />
                      {(() => {
                        const w = msg.refId ? findWaiting(msg.refId) : undefined;
                        if (!w?.state) return null;
                        return (
                          <div className="flex items-center gap-3 pt-1.5">
                            <StatusMark state={w.state} />
                            <button
                              type="button"
                              data-hub-take-look={w.id}
                              onClick={() => setHubSelection({ project: w.projectId, item: "inbox" })}
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
            </div>
          </div>
        )}
        <div className="mx-auto h-6 w-full max-w-[760px] shrink-0 px-8 text-xs text-content/60" data-hub-typing aria-live="polite">
          {typingIn(chat.id) ? `${nameOf(typingIn(chat.id)!)} is typing…` : null}
        </div>
        <div className="mx-auto w-full max-w-[760px] shrink-0 px-8 pb-3">
          <MonoComposer
            sessionId={`hub-chat:${chat.id}`}
            name={chatPhrase(chat)}
            onSubmit={(text) => {
              if (!text.trim()) return false;
              if (drafting) {
                const id = startConversation(chat.id, text.trim());
                setDrafting(false);
                setConvId(id);
                simulateReplies(chat.id, id);
                return;
              }
              sendMessage(chat.id, text.trim(), conv?.id);
              simulateReplies(chat.id, conv?.id);
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** The calm screen New conversation opens: who you're talking to, a few starters, and the composer below. */
function NewConversationScreen({ members, phrase, onPick }: { members: Mono[]; phrase: string; onPick: (text: string) => void }) {
  const starters = ["What changed since yesterday?", "What needs me today?", "Plan this week with me"];
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-8" data-hub-new-conversation-screen>
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
          <p className="text-[17px] font-medium text-content">Talk to {phrase}</p>
          <p className="mt-1 text-[13px] leading-5 text-content/70">Nothing is saved until you send your first message. It names the conversation; double-click the name to change it.</p>
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
          A leadership team is a group chat with the Monos you choose. Add one to start talking.
        </p>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1.5 rounded-md bg-content/10 px-3 py-1.5 text-[13px] text-content hover:bg-content/15"
        >
          <Plus className="size-3.5" strokeWidth={1.75} />
          Add a Mono
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
      className="fixed z-50 w-[260px] rounded-lg border border-stroke bg-background-base p-1 shadow-2xl"
    >
      <div className="px-2 pb-1 pt-1 text-xs text-content/60">Add a Mono to {chat.name}</div>
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
