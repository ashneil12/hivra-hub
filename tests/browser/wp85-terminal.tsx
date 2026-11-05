// Browser proof for a Claude session started in a terminal (WP-85).
// The list, the pane, the task and the setting are the ones the app renders.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { applyMapped, attachSession, emptyBook, type MirrorBook } from "../../plugins/hivra-mirror/src/book.ts";
import { TerminalChatList } from "../../src/features/terminalMirror/ui/TerminalChatList";
import { TerminalMirrorPane } from "../../src/features/terminalMirror/ui/TerminalMirrorPane";
import { TerminalSessionsSetting } from "../../src/features/terminalMirror/ui/TerminalSessionsSetting";
import { TaskDetail } from "../../src/features/tasks/ui/TaskDetail";
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

function Page() {
  const [book, setBook] = useState<MirrorBook>(emptyBook());
  const [open, setOpen] = useState<string | null>(null);
  const [activity, setActivity] = useState<{ id: string; text: string }[]>([]);
  const session = book.sessions.find((item) => item.id === open) ?? null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          const started = applyMapped(
            book,
            { kind: "session", id: "s1", folder: "/work/notes", title: "Notes", state: "running" },
            1,
          );
          setBook(applyMapped(started, { kind: "assistant", id: "b1", sessionId: "s1", text: "hello from the terminal" }, 2));
        }}
      >
        Session started
      </button>
      <TerminalChatList
        rows={book.sessions.map((item) => ({ id: item.id, title: item.title, state: item.state, folder: item.folder }))}
        onOpen={setOpen}
      />
      {session ? (
        <TerminalMirrorPane
          session={session}
          tasks={[{ id: "task-1", number: 1, title: "Write" }]}
          onReply={() => undefined}
          onStop={() => undefined}
          onAllow={() => undefined}
          onDeny={() => undefined}
          onAttach={(taskId) => {
            const result = attachSession(book, session.id, taskId);
            if (result.activity) {
              const line = result.activity;
              setActivity((prev) => (prev.some((item) => item.id === line.id) ? prev : [...prev, { id: line.id, text: line.text }]));
            }
            setBook(result.book);
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
