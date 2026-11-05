// WP-85. Terminal sessions in the chat list, beside the chats Hivra started.

import { terminalStateLabel } from "../model/list";
import { TerminalMark } from "./TerminalMark";

export type TerminalChatRow = {
  id: string;
  title: string;
  state: string;
  folder: string;
};

export function TerminalChatList({
  rows,
  onOpen,
}: {
  rows: readonly TerminalChatRow[];
  onOpen: (id: string) => void;
}) {
  return (
    <ul aria-label="Chats" className="flex flex-col gap-1">
      {rows.map((row) => (
        <li key={row.id}>
          <button type="button" className="flex w-full flex-col items-start px-2 py-1 text-left" onClick={() => onOpen(row.id)}>
            <TerminalMark />
            <span className="text-[13px] text-content">{row.title}</span>
            <span className="text-[12px] text-content/70">{terminalStateLabel(row.state)}</span>
            <span className="text-[12px] text-content/60">{row.folder}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
