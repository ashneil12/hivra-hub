// Browser proof for the crew tree (WP-119). The tree is the real one, fed records.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { crewTree } from "../../src/features/crew/model/crewTree";
import { inboxItems } from "../../src/features/crew/model/inbox";
import type { CrewWorkerInput } from "../../src/features/crew/model/rows";
import { CrewTab } from "../../src/features/crew/ui/CrewTab";
import { FirstMateInbox } from "../../src/features/crew/ui/FirstMateInbox";
import "../../src/styles/index.css";

const NOW = 1_700_000_000_000;
const PROJECT = "/work/proj";

function worker(patch: Partial<CrewWorkerInput> & { id: string }): CrewWorkerInput {
  return {
    project: PROJECT,
    status: "working",
    updatedAt: NOW,
    ownerSession: "lead",
    ...patch,
  };
}

const tree = crewTree({
  project: PROJECT,
  now: NOW,
  sessions: [
    {
      id: "lead",
      title: "Lead",
      cwd: PROJECT,
      firstMate: true,
      blocks: [{ id: "ask", role: "user", text: "Fix the save" }],
    },
    {
      id: "chat-a",
      cwd: "/tmp/worktree",
      blocks: [
        {
          id: "sub1",
          role: "tool",
          text: "Check the save",
          tool: { kind: "agent", title: "Check the save", status: "running", startedAt: NOW - 2_000 },
          agentRun: {
            name: "Check the save",
            steps: [{ id: "s1", kind: "tool", text: "Read the file", toolKind: "read", status: "running" }],
          },
        },
      ],
    },
    {
      id: "chat-b",
      cwd: PROJECT,
      blocks: [
        {
          id: "t1",
          role: "tool",
          text: "Read notes",
          tool: { kind: "read", title: "Read notes", status: "running", startedAt: NOW - 4_000 },
        },
      ],
    },
  ],
  workers: [
    worker({ id: "a", title: "Fix the save", createdAt: NOW - 20 * 60_000, childSession: "chat-a", brief: "Stop the crash" }),
    worker({ id: "b", title: "Write the note", createdAt: NOW - 5 * 60_000, childSession: "chat-b" }),
  ],
});

function Tree() {
  const [opened, setOpened] = useState("");
  return (
    <div>
      <CrewTab rows={[]} tree={tree} onOpenChat={setOpened} />
      <p data-opened>{opened}</p>
    </div>
  );
}

createRoot(document.getElementById("tree")!).render(<Tree />);
createRoot(document.getElementById("empty")!).render(
  <CrewTab rows={[]} tree={crewTree({ project: PROJECT, now: NOW })} />,
);
const minute = 60_000;
const inbox = inboxItems({
  project: PROJECT,
  decisions: [
    {
      project: PROJECT,
      decisionKey: "new",
      question: "Newer question",
      askedBy: "chat-new",
      state: "open",
      waiting: [],
      createdAt: NOW - 5 * minute,
      updatedAt: NOW - 5 * minute,
    },
    {
      project: PROJECT,
      decisionKey: "old",
      question: "Oldest question",
      askedBy: "chat-old",
      state: "open",
      waiting: [],
      createdAt: NOW - 20 * minute,
      updatedAt: NOW - 20 * minute,
    },
  ],
  rows: [
    worker({
      id: "cred",
      status: "paused",
      title: "Sign in",
      errorClass: "auth",
      error: "not signed in",
      createdAt: NOW - 90 * minute,
      updatedAt: NOW - 90 * minute,
      childSession: "chat-cred",
    }),
    worker({
      id: "boom",
      status: "failed",
      title: "It failed",
      createdAt: NOW - 40 * minute,
      updatedAt: NOW - 40 * minute,
      statusNotice: "The save did not finish.",
      childSession: "chat-boom",
    }),
  ],
});

function Inbox() {
  const [opened, setOpened] = useState("");
  return (
    <div>
      <FirstMateInbox items={inbox} now={NOW} onOpenChat={setOpened} />
      <p data-inbox-opened>{opened}</p>
    </div>
  );
}

createRoot(document.getElementById("inbox")!).render(<Inbox />);
createRoot(document.getElementById("mate")!).render(
  <CrewTab
    rows={[]}
    tree={crewTree({
      project: PROJECT,
      now: NOW,
      sessions: [{ id: "lead", title: "Lead", cwd: PROJECT, firstMate: true, blocks: [] }],
    })}
  />,
);
