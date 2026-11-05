import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { setHubDataSource, hubData } from "../../src/features/hub/model/hubData";
import type { HubDataSource } from "../../src/features/hub/model/types";
import { memoryGateway } from "../../src/features/docs/gateway";
import { DocsScreen } from "../../src/features/docs/ui/DocsScreen";
import { TaskPane } from "../../src/features/tasks/ui/TaskPane";
import { FinderHost } from "../../src/features/search/ui/FinderHost";
import { finderShortcutAction, routeFinderHit, type FinderHit } from "../../src/features/search/model/finder";
import { requestDocFocus, requestTaskFocus } from "../../src/features/search/model/finderOpen";
import { resolveAppShortcut } from "../../src/features/settings/model/appShortcuts";
import { peekTranscriptJump, requestTranscriptJump, subscribeTranscriptJump } from "../../src/features/sessions/model/transcriptJump";
import { listMonos } from "../../src/features/monos/model/mono";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

// WP-74. The real finder palette, the real task pane and the real doc screen.
const PROJECT = "/work/proj";

localStorage.setItem(
  "monocode:mono-roster",
  JSON.stringify([
    {
      id: "mono-notes",
      name: "Notes keeper",
      mascot: "owl",
      color: "hsl(245 75% 65%)",
      projects: [PROJECT],
      role: "Keeper",
    },
  ]),
);

const base = hubData();
const src = Object.create(base) as HubDataSource;
src.listProjects = () => [
  { id: "crew", name: "Crew", shortName: "Crew", iconShape: "folder", folder: PROJECT },
];
setHubDataSource(src);

const task = {
  id: "task-1",
  projectId: "crew",
  number: 1,
  title: "Fix the notes",
  description: "Save the notes",
  status: "Backlog",
  needsYou: false,
  failed: false,
  assignee: null,
  version: 1,
  comments: [],
  activity: [],
};

installFakeTauri("finder", (command, args) => {
  if (command === "finder_search") {
    const query = String(args.query ?? "").toLowerCase();
    if (!query.includes("notes")) return { tasks: [], docs: [] };
    return {
      tasks: [
        {
          id: task.id,
          project: "crew",
          title: task.title,
          snippet: task.description,
          score: 8,
          blockId: null,
          titleHighlights: [],
          snippetHighlights: [],
          updatedAt: 1,
        },
      ],
      docs: [
        {
          id: "page-notes",
          project: PROJECT,
          title: "Notes page",
          snippet: "Write the notes",
          score: 7,
          blockId: "block-9",
          titleHighlights: [],
          snippetHighlights: [],
          updatedAt: 1,
        },
      ],
    };
  }
  if (command === "tasks_list") return [task];
  if (command === "tasks_get") return task;
  if (command === "list_project_files") return [];
  if (command === "session_search" || command === "search_project") return { hits: [], matches: [], truncated: false };
  return null;
});

const session = {
  id: "chat-1",
  cwd: PROJECT,
  harness: "claude" as const,
  title: "Chat about notes",
  blocks: [{ id: "msg-1", role: "assistant" as const, text: "Write the notes in the chat" }],
};

function MessageLine() {
  const jump = useSyncExternalStore(
    subscribeTranscriptJump,
    () => peekTranscriptJump(session.id),
    () => null,
  );
  const on = jump?.blockId === "msg-1";
  return (
    <p data-message-id="msg-1" data-highlighted={on ? "true" : "false"}>
      Write the notes in the chat
    </p>
  );
}

function FinderFixture({ gateway }: { gateway: ReturnType<typeof memoryGateway> }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState(0);
  const [mono, setMono] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const shortcut = resolveAppShortcut(event);
      const inTerminal = event.target instanceof Element && !!event.target.closest(".monocode-terminal");
      const action = finderShortcutAction(shortcut, inTerminal, event.ctrlKey, event.metaKey);
      if (action === "leave") return;
      if (action !== "open") return;
      event.preventDefault();
      setToken((current) => current + 1);
      setOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const onOpenHit = (hit: FinderHit, beside: boolean, query: string) => {
    setOpen(false);
    routeFinderHit(hit, beside, query, {
      openTask: (id, project) => requestTaskFocus(id, project),
      openDoc: (id, blockId) => requestDocFocus(id, blockId),
      openMessage: (sessionId, blockId, q) => requestTranscriptJump(sessionId, blockId, q),
      openConversation: () => undefined,
      openMono: (id) => {
        const found = listMonos().find((item) => item.id === id);
        setMono(found?.name ?? id);
      },
      openFile: () => undefined,
      openProject: () => undefined,
      runCommand: () => undefined,
    });
  };

  return (
    <div>
      <div className="monocode-terminal">
        <textarea aria-label="Terminal" defaultValue="" />
      </div>
      <TaskPane project={PROJECT} />
      <DocsScreen cwd={PROJECT} onClose={() => undefined} gateway={gateway} idleMs={60_000} />
      <MessageLine />
      {mono ? <p data-open-mono>{mono}</p> : null}
      {open ? (
        <FinderHost
          key={token}
          finder
          open
          cwd={PROJECT}
          initialQuery=""
          history={[]}
          sessions={[session]}
          recents={[{ path: PROJECT, openedAt: 1 }]}
          onOpenFile={() => undefined}
          onRunAction={() => undefined}
          onClose={() => setOpen(false)}
          onOpenHit={onOpenHit}
        />
      ) : null}
    </div>
  );
}

const gateway = memoryGateway();
void gateway
  .create({
    id: "page-notes",
    title: "Notes page",
    body: "Write the notes",
    blocksJson: JSON.stringify([
      {
        id: "block-9",
        type: "paragraph",
        props: {},
        children: [],
        content: [{ type: "text", text: "Write the notes", styles: {} }],
      },
    ]),
    origin: "person",
  })
  .then(() => {
    createRoot(document.getElementById("root")!).render(<FinderFixture gateway={gateway} />);
  });
