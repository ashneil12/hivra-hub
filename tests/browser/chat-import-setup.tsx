// The later parts of "bring my chats over" on example data: `?part=choose` (default) and `?part=rules`, each with the
// sidebar card that calls the person back. No Tauri, no real chats.
import { StrictMode, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ChatImportRun, type ChatImportPorts } from "../../src/features/chatImport/model/runner";
import type { ProjectRef } from "../../src/features/chatImport/model/plan";
import { ImportSetupCard } from "../../src/features/chatImport/ui/ImportSetupCard";
import { railCard, type SetupPart } from "../../src/features/chatImport/ui/importRail";
import type { ShownProposal } from "../../src/features/memory/ui/LearnFromChats";
import "../../src/styles/index.css";

const params = new URLSearchParams(window.location.search);
const first: SetupPart = params.get("part") === "rules" ? "rules" : "choose";
const now = Date.UTC(2026, 10, 12, 9);
const day = 86_400_000;
const line = (o: unknown) => JSON.stringify(o);

type Fake = { path: string; cwd: string; id: string; age: number };
const fakes: Fake[] = [];
const add = (cwd: string, count: number, age: number) => {
  for (let i = 0; i < count; i += 1) {
    const id = `${cwd.split("/").pop()}-${fakes.length}`;
    fakes.push({ path: `${id}.jsonl`, cwd, id, age: age + i });
  }
};
add("/Users/example/Projects/shop-app", 6, 1);
add("/Users/example/Projects/shop-app-v2", 4, 10);
add("/Users/example/Projects/recipes", 3, 40);

const projects: ProjectRef[] = [];
const ports: ChatImportPorts = {
  roots: async () => ({ claudeCode: ["/Users/example/.claude/projects"], codex: [] }),
  index: async (_root, _source, offset, limit) => ({
    missing: false,
    total: fakes.length,
    offset,
    chats: fakes.slice(offset, offset + limit).map((f) => ({ path: f.path, bytes: 100, mtimeMs: now - f.age * day, cwd: f.cwd, sessionId: f.id })),
    active: 0,
    links: 0,
    side: 0,
    done: offset + limit >= fakes.length,
  }),
  folders: async (paths) => paths.map((path) => ({ path, exists: true })),
  knownIds: async () => [],
  read: async (_root, _source, path) => {
    const f = fakes.find((item) => item.path === path)!;
    const text = ["Example: first message", "Example: second message"]
      .map((said, n) => line({ type: "user", sessionId: f.id, cwd: f.cwd, timestamp: new Date(now - f.age * day + n * 60_000).toISOString(), message: { role: "user", content: said } }))
      .join("\n");
    return { text, cut: false, longLines: 0 };
  },
  projects: () => projects,
  createProject: async (name, folder) => ({ id: name, name, folder }),
  save: async () => true,
};

const rules: ShownProposal[] = [
  {
    id: "r1",
    title: "Example: keep commits small",
    diff: "+ Make one small commit per change, with a plain sentence saying what it does.",
    quotes: [
      { sessionId: "shop-app-0", quote: "Example: please split this, I like small commits" },
      { sessionId: "recipes-11", quote: "Example: one commit per fix, as always" },
    ],
  },
  {
    id: "r2",
    title: "Example: write the test first",
    diff: "+ Write a failing test before the fix, and say which test it was.",
    quotes: [
      { sessionId: "shop-app-2", quote: "Example: where is the test for this?" },
      { sessionId: "shop-app-v2-7", quote: "Example: test first, then the change" },
    ],
  },
  {
    id: "r3",
    title: "Example: answer in one paragraph",
    diff: "+ End every piece of work with one plain paragraph.",
    quotes: [
      { sessionId: "recipes-10", quote: "Example: too long, give me a paragraph" },
      { sessionId: "shop-app-4", quote: "Example: one paragraph is enough" },
    ],
  },
];

const run = new ChatImportRun(ports);
void run.find();

function Page() {
  const state = useSyncExternalStore(run.subscribe, run.get, run.get);
  const [part, setPart] = useState<SetupPart | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [rulesDone, setRulesDone] = useState(false);
  const card =
    first === "rules"
      ? rulesDone
        ? null
        : railCard({ stage: "rules", learn: true }, state, { phase: "done", read: 13, target: 13, proposals: rules })
      : railCard(
          { stage: state.phase === "importing" ? "importing" : state.phase === "done" ? "off" : state.phase === "ready" ? "choose" : "sweep", learn: true },
          state,
          { phase: "idle", read: 0, target: 0, proposals: [] },
        );
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 flex-col justify-end p-2" data-fixture-sidebar>
        {card ? (
          <section role="status" className="overflow-hidden rounded-lg bg-content/12" data-import-rail-card={card.key}>
            <button type="button" data-import-rail-open={card.open ?? ""} disabled={!card.open} onClick={() => card.open && setPart(card.open)}
              className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-left">
              <span className="block truncate text-[12px] font-medium leading-tight text-content">{card.title}</span>
              <span className="block truncate text-[11px] leading-tight text-content/60">{card.line}</span>
            </button>
          </section>
        ) : null}
      </aside>
      <main className="flex-1 p-6 text-[13px] text-content/60" data-fixture-main>
        Example: the app, in use.
        <p data-fixture-saved>{saved.length ? `Saved: ${saved.join(", ")}` : ""}</p>
        <p data-fixture-phase>{state.phase}</p>
      </main>
      {part ? (
        <ImportSetupCard
          part={part}
          run={run}
          projects={projects}
          rules={rules}
          rulesFrom={13}
          now={now}
          accept={async (id) => {
            if (id === "r3" && params.has("refuse")) return false;
            setSaved((cur) => [...cur, id]);
            return true;
          }}
          onBringIn={() => setPart(null)}
          onRulesDone={() => {
            setRulesDone(true);
            setPart(null);
          }}
          onClose={() => setPart(null)}
        />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
