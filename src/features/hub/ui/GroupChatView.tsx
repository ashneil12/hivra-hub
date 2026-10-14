import { useMemo, useState, useSyncExternalStore } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { Check, MessageMultiple, Plus } from "../../../shared/ui/icons";
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
  sendMessage,
  useHubChatsVersion,
} from "../model/hubChats";
import { setHubSelection } from "../model/hubNav";
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
  const [picker, setPicker] = useState(false);
  const conv = chat.conversations.find((c) => c.id === convId) ?? chat.conversations[0];
  const nameOf = (from: string) => {
    const mono = monos.find((m) => m.id === from);
    return mono ? monoLook(mono).name : from;
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-hub-chat={chat.id}>
      {/* Members and past conversations. */}
      <div className="sidebar-glass relative flex w-[240px] shrink-0 flex-col border-r border-stroke">
        <div className="flex h-10 shrink-0 items-center gap-2 px-3" data-tauri-drag-region="deep">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-content">{chat.name}</span>
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
                <div key={mono.id} className="flex h-6 items-center gap-2 text-[13px] text-content/80">
                  <MonoRailMascot name={look.mascot} color={look.color} />
                  <span className="min-w-0 truncate">{look.name}</span>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            data-hub-add-mono
            onClick={() => setPicker((v) => !v)}
            className="mt-1 flex h-6 items-center gap-2 rounded-md px-0.5 text-[13px] text-content/60 hover:text-content"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
            Add a Mono
          </button>
        </div>
        {picker ? <MonoPicker chat={chat} monos={monos} onClose={() => setPicker(false)} /> : null}
        {chat.conversations.length ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
            <div className="px-1 pb-1 text-xs leading-5 text-content/60">Conversations</div>
            {chat.conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setConvId(c.id)}
                className={`flex h-7 shrink-0 items-center rounded-md px-2 text-left text-[13px] ${
                  c.id === conv?.id ? "bg-selection text-content" : "text-content/80 hover:bg-content/6"
                }`}
              >
                <span className="min-w-0 truncate">
                  {c.when} · {c.title}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* The chat. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region="deep">
          <MessageMultiple className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
          <span className="min-w-0 truncate text-[13px] text-content">{conv ? conv.title : chat.name}</span>
          {IS_MAC ? null : <div className="w-[120px]" />}
        </div>
        {members.length === 0 && !conv ? (
          <EmptyChat chat={chat} onAdd={() => setPicker(true)} />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-8 py-6 text-[13px] leading-5">
              {conv ? (
                conv.messages.map((msg) =>
                  msg.from === "ash" ? (
                    <div key={msg.id} className="flex justify-end">
                      <div className="agent-chat-user-bubble max-w-[70%] rounded-2xl bg-content/10 px-3 py-1.5 text-content">{msg.text}</div>
                    </div>
                  ) : (
                    <div key={msg.id}>
                      <div className="pb-0.5 text-xs text-content/60">{nameOf(msg.from)}</div>
                      <AgentMarkdown text={msg.text} className="text-content" />
                      {msg.status ? (
                        <div className="pt-1">
                          <StatusMark state={msg.status} />
                        </div>
                      ) : null}
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
        <div className="mx-auto w-full max-w-[760px] shrink-0 px-8 pb-3">
          <MonoComposer
            sessionId={`hub-chat:${chat.id}`}
            name={chatPhrase(chat)}
            onSubmit={(text) => {
              if (!text.trim()) return false;
              sendMessage(chat.id, text.trim());
            }}
          />
        </div>
        <div className="flex h-7 shrink-0 items-center border-t border-stroke px-3 text-[11px] text-content/60">
          {projectName(chat.projectId)} · {chat.isDefault ? "leadership team" : chat.name}
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

/** Any Mono can join any chat. */
function MonoPicker({ chat, monos, onClose }: { chat: GroupChat; monos: Mono[]; onClose: () => void }) {
  return (
    <div
      data-hub-mono-picker
      className="absolute left-2 right-2 z-20 rounded-lg border border-stroke bg-background-base p-1 shadow-xl"
      style={{ top: 40 + 24 * (chat.memberIds.length + 2) + 34 }}
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
            {inChat ? <Check className="size-3.5 text-content/60" strokeWidth={1.75} /> : null}
          </button>
        );
      })}
    </div>
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
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${on ? "bg-selection text-content" : "text-content/80 hover:bg-content/6"}`}
              >
                <MonoRailMascot name={look.mascot} color={look.color} />
                <span className="min-w-0 flex-1 truncate">{look.name}</span>
                {on ? <Check className="size-3.5 text-content/80" strokeWidth={1.75} /> : null}
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
