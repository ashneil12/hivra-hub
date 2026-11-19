// The chat import panel on example data: no Tauri, no real chats. `?slow` holds each read so a test can see the
// background progress line; `?before` shows Settings, Chat history as it was before the panel.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatImportPanel } from "../../src/features/chatImport/ui/ChatImportPanel";
import { ChatImportRun, type ChatImportPorts } from "../../src/features/chatImport/model/runner";
import type { ProjectRef } from "../../src/features/chatImport/model/plan";
import { HistoryImportPage, type HistoryPorts } from "../../src/features/historyImport/ui/HistoryImportPage";
import "../../src/styles/index.css";

const params = new URLSearchParams(window.location.search);
const now = Date.UTC(2026, 10, 12, 9);
const day = 86_400_000;
const line = (o: unknown) => JSON.stringify(o);

type Fake = { path: string; cwd: string; id: string; said: string[]; age: number };
const fakes: Fake[] = [];
const add = (cwd: string, count: number, age: number, said = 2) => {
  for (let i = 0; i < count; i += 1) {
    const id = `${cwd.split("/").pop()}-${fakes.length}`;
    fakes.push({
      path: `${id}.jsonl`,
      cwd,
      id,
      said: Array.from({ length: said }, (_, n) => `Example: message ${n + 1} in ${id}`),
      age: age + i,
    });
  }
};
add("/Users/example/Projects/shop-app", 6, 1);
add("/Users/example/Worktrees/shop-app-checkout", 3, 3);
add("/Users/example/Projects/shop-app-v2", 4, 10);
add("/Users/example/Projects/recipes", 3, 40);
add("/Users/example/Old/shop-app-old", 2, 200);
add("/Users/example/Old/scratch", 2, 300);
add("/Users/example/Projects/recipes", 2, 2, 1);

const projects: ProjectRef[] = [{ id: "recipes", name: "Example: Recipes", folder: "/Users/example/Projects/recipes" }];
const repoOf: Record<string, string> = {
  "/Users/example/Worktrees/shop-app-checkout": "/Users/example/Projects/shop-app",
  "/Users/example/Projects/shop-app": "/Users/example/Projects/shop-app",
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ports: ChatImportPorts = {
  roots: async () => ({ claudeCode: ["/Users/example/.claude/projects"], codex: ["/Users/example/.codex/sessions"] }),
  index: async (_root, source, offset, limit) => {
    const list = source === "claude_code" ? fakes : [];
    const page = list.slice(offset, offset + limit);
    return {
      missing: list.length === 0,
      total: list.length,
      offset,
      chats: page.map((f) => ({ path: f.path, bytes: 100, mtimeMs: now - f.age * day, cwd: f.cwd, sessionId: f.id })),
      active: 0,
      links: 0,
      side: 0,
      done: offset + limit >= list.length,
    };
  },
  folders: async (paths) => paths.map((path) => ({ path, exists: !path.includes("/Old/"), ...(repoOf[path] ? { repoRoot: repoOf[path] } : {}) })),
  knownIds: async () => [],
  read: async (_root, _source, path) => {
    if (params.has("slow")) await wait(400);
    const f = fakes.find((item) => item.path === path)!;
    const text = f.said
      .map((said, n) =>
        line({ type: "user", sessionId: f.id, cwd: f.cwd, timestamp: new Date(now - f.age * day + n * 60_000).toISOString(), message: { role: "user", content: said } }),
      )
      .join("\n");
    return { text, cut: false, longLines: 0 };
  },
  projects: () => projects,
  createProject: async (name, folder) => ({ id: name, name, folder }),
  save: async () => true,
};

const historyPorts: HistoryPorts = {
  roots: async () => ({ claudeCode: [], codex: [], hermes: [], hermesDatabase: false }),
  list: async () => ({ missing: true, files: [], active: 0, links: 0, database: false, truncated: false }),
  read: async () => "",
  loadState: async () => ({ revision: 0, state: { entries: {} } }),
  casState: async () => true,
  writeProposal: async () => undefined,
  ask: async () => ({ ok: false, kind: "refused", reason: "Example only." }),
  models: async () => [],
};

const run = new ChatImportRun(ports);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="flex flex-col gap-10">
      {params.has("before") ? null : <ChatImportPanel run={run} projects={projects} now={now} />}
      <HistoryImportPage ports={historyPorts} />
    </div>
  </StrictMode>,
);
