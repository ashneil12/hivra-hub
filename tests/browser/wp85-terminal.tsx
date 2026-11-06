// Browser proof for a Claude session started in a terminal (WP-85).
// The list is the chat list the app merges into, and attach goes through the app command.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { mergeTerminalSessions, sessionsFromWire, terminalSessionId, terminalStatusText } from "../../src/features/terminalMirror/model/list";
import { TerminalMark } from "../../src/features/terminalMirror/ui/TerminalMark";
import { TerminalMirrorPane } from "../../src/features/terminalMirror/ui/TerminalMirrorPane";
import { TerminalSessionsSetting } from "../../src/features/terminalMirror/ui/TerminalSessionsSetting";
import { TaskDetail } from "../../src/features/tasks/ui/TaskDetail";
import type { TerminalSession } from "../../plugins/hivra-mirror/src/book.ts";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

type Call = { command: string; args: Record<string, unknown> };

const calls: Call[] = [];
Object.assign(window, { __mirrorCalls: calls });

installFakeTauri("main", (command, args) => {
  calls.push({ command, args });
  if (command === "terminal_mirror_status") return { enabled: false, installed: false, version: 0 };
  if (command === "terminal_mirror_set") {
    const enabled = args.enabled === true;
    const version = typeof args.expectedVersion === "number" ? args.expectedVersion : 0;
    return { enabled, installed: enabled, version: version + 1, stale: false, note: null };
  }
  if (command === "terminal_mirror_attach") return null;
  return null;
});

const task = {
  number: 1,
  title: "Write",
  description: "",
  status: "Todo",
  needsYou: false,
  failed: false,
  assignee: null,
  comments: [] as { id: string; body: string }[],
};

const started = [
  {
    id: "s1",
    title: "Notes",
    folder: "/work/notes",
    state: "running",
    updatedAt: 2,
    blocks: [{ id: "b1", role: "assistant", text: "hello from the terminal" }],
  },
];

function Page() {
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [activity, setActivity] = useState<{ id: string; text: string }[]>([]);
  const rows = mergeTerminalSessions([], terminals, "/work/notes");
  const session = terminals.find((item) => item.id === open) ?? null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setTerminals(sessionsFromWire(started));
        }}
      >
        Session started
      </button>
      <ul aria-label="Chats">
        {rows.map((row) => (
          <li key={row.id}>
            <button type="button" onClick={() => setOpen(terminalSessionId(row.id))}>
              {row.title}
            </button>
            {row.terminal ? <TerminalMark /> : null}
            {row.terminal ? <span>{terminalStatusText(row.terminal)}</span> : null}
          </li>
        ))}
      </ul>
      {session ? (
        <TerminalMirrorPane
          session={session}
          tasks={[{ id: "task-1", number: 1, title: "Write" }]}
          onReply={() => undefined}
          onStop={() => undefined}
          onAllow={() => undefined}
          onDeny={() => undefined}
          onAttach={(taskId) => {
            void invoke("terminal_mirror_attach", { sessionId: session.id, taskId }).then(() => {
              const id = `mirror-${taskId}-${session.id}`;
              const text = `Terminal session ${session.title} (${session.folder})`;
              setActivity((prev) => (prev.some((item) => item.id === id) ? prev : [...prev, { id, text }]));
            });
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
      <TaskDetail task={{ ...task, activity }} onComment={() => undefined} />
      <TerminalSessionsSetting />
    </>
  );
}

createRoot(document.getElementById("app")!).render(<Page />);
