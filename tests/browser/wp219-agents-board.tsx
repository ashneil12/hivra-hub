// Example data for the Agents board. Every seeded row starts with "Example:".
import { createRoot } from "react-dom/client";
import { AgentsBoard } from "../../src/features/agents-board/ui/AgentsBoard";
import { buildAgentsTree, type BoardPerson } from "../../src/features/agents-board/model/tree";
import "../../src/styles/index.css";

const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);

function person(patch: Partial<BoardPerson> & Pick<BoardPerson, "id" | "role" | "name">): BoardPerson {
  return { state: "idle", ...patch };
}

const tree = buildAgentsTree({
  now: NOW,
  projects: [
    { id: "hivra", name: "Hivra" },
    { id: "exo", name: "EXO" },
  ],
  people: [
    person({ id: "captain", role: "captain", name: "Chief of Staff", state: "working" }),
    person({ id: "home", role: "home", name: "Example: Home", state: "working", task: "Example: Morning brief" }),
    person({ id: "hivra-session", role: "project", name: "Example: Hivra", projectId: "hivra" }),
    person({ id: "exo-session", role: "project", name: "Example: EXO", projectId: "exo" }),
    person({
      id: "coding",
      role: "mate",
      name: "Example: Coding",
      projectId: "hivra",
      department: "coding",
      state: "working",
      task: "Example: Ship the vault",
    }),
    person({ id: "marketing", role: "mate", name: "Example: Marketing", projectId: "hivra", department: "marketing" }),
    person({
      id: "newer",
      role: "worker",
      name: "Example: Fix the build",
      projectId: "hivra",
      parentId: "coding",
      state: "needs-you",
      task: "Example: A test failed on Windows",
      costUsd: 1.5,
      startedAt: NOW - 20 * 60_000,
      createdAt: NOW - 60_000,
      prNumber: 217,
      checks: { failing: 3, pending: 0, passed: false },
      canStop: true,
      sessionId: "example-chat",
    }),
    person({
      id: "older",
      role: "worker",
      name: "Example: Write the note",
      projectId: "hivra",
      parentId: "coding",
      state: "done",
      createdAt: NOW - 3_600_000,
      settledAt: NOW - 60_000,
    }),
    person({
      id: "sub",
      role: "subchat",
      name: "Example: Read the test",
      projectId: "hivra",
      parentId: "newer",
      state: "working",
      sessionId: "example-sub",
    }),
    person({
      id: "exo-job",
      role: "worker",
      name: "Example: Look at EXO",
      projectId: "exo",
      state: "done",
      settledAt: NOW - 26 * 3_600_000,
    }),
  ],
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <AgentsBoard
      tree={tree}
      projects={[
        { id: "hivra", name: "Hivra" },
        { id: "exo", name: "EXO" },
      ]}
      counts={{ needsYou: 4, working: 2 }}
      now={NOW}
      lines={{ newer: ["Example: The build failed on the Windows test."] }}
      initialOpen={{ newer: true, sub: true, "exo-job": true, older: true }}
      onStop={() => undefined}
    />,
  );
}
