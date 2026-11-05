// Browser proof for commit attribution (WP-86). Seeded screens, no app window.
import { createRoot } from "react-dom/client";
import { ActivityPage } from "../../src/features/activity/ui/ActivityPage";
import type { ActivityEntry } from "../../src/features/activity/model/activity";
import { TaskDetail } from "../../src/features/tasks/ui/TaskDetail";
import type { TaskCommit } from "../../src/features/attribution/read";
import { PrAttribution } from "../../src/features/attribution/ui/PrAttribution";
import "../../src/styles/index.css";

const commits: TaskCommit[] = [
  {
    sha: "abc1234",
    tier: "inferred",
    agent: "Ada",
    taskId: "task-1",
    taskTitle: "Fix the gate",
    chatId: "chat-1",
    fileCount: 1,
    lineCount: 2,
    subject: "Stamp the trailer",
  },
  {
    sha: "def5678",
    tier: "person",
    agent: null,
    taskId: null,
    taskTitle: null,
    chatId: null,
    fileCount: 2,
    lineCount: 10,
    subject: "sk-ant-api03-SECRETVALUE",
  },
];

const entry: ActivityEntry = {
  id: "commit-1",
  seq: 1,
  kind: "git.commit",
  actor: { role: "worker", id: "chat-1", name: "Ada" },
  initiator: { role: "person" },
  project: "/work/repo",
  target: "abc1234",
  summary: "commit by Ada for Fix the gate",
  link: "session:chat-1",
  at: 1_700_000_000_000,
};

const task = document.getElementById("task");
const log = document.getElementById("log");
const pr = document.getElementById("pr");
if (!task || !log || !pr) throw new Error("missing mount");

createRoot(task).render(
  <TaskDetail
    task={{
      number: 1,
      title: "Fix the gate",
      description: "",
      status: "In progress",
      needsYou: false,
      failed: false,
      assignee: "Ada",
      comments: [],
      activity: [],
    }}
    commits={commits}
    onComment={() => {}}
  />,
);

createRoot(log).render(<ActivityPage entries={[entry]} />);

createRoot(pr).render(
  <PrAttribution
    credit={{
      agents: ["Ada"],
      tasks: [{ id: "task-1", title: "Fix the gate" }],
    }}
  />,
);

