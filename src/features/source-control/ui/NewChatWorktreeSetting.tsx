// WP-110: the three-way choice for whether a new chat starts in its own worktree.
import { useSyncExternalStore } from "react";
import {
  loadNewChatWorktree,
  saveNewChatWorktree,
  subscribeNewChatWorktree,
  type NewChatWorktree,
} from "../../settings/model/settings";

const LINES: { value: NewChatWorktree; line: string }[] = [
  { value: "off", line: "Off. A new chat uses this folder." },
  {
    value: "ask",
    line: "Ask. The composer offers a worktree, already switched on, for a git project.",
  },
  {
    value: "always",
    line: "Always. Every new chat in a git project starts in its own worktree.",
  },
];

const settingOff = (): NewChatWorktree => "off";

export function NewChatWorktreeSetting() {
  const value = useSyncExternalStore(
    subscribeNewChatWorktree,
    loadNewChatWorktree,
    settingOff,
  );
  return (
    <fieldset
      id="setting-new-chat-worktree"
      data-setting-id="new-chat-worktree"
      className="m-0 flex flex-col gap-2 border-0 p-0"
    >
      <legend className="text-[13px]">New chats and worktrees</legend>
      <div role="radiogroup" aria-label="New chats and worktrees" className="flex flex-col gap-1.5">
        {LINES.map((option) => (
          <label key={option.value} className="flex cursor-pointer items-start gap-2 text-[12px]">
            <input
              type="radio"
              name="new-chat-worktree"
              className="mt-0.5"
              value={option.value}
              checked={value === option.value}
              onChange={() => saveNewChatWorktree(option.value)}
            />
            <span>{option.line}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
