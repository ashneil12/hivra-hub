// Browser proof for labelled GitHub issues (WP-77). The Tauri bridge is faked before the page loads.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GithubIssuesSetting } from "../../src/features/github-issues/ui/GithubIssuesSetting";
import { TaskDetail } from "../../src/features/tasks/ui/TaskDetail";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

const held: Array<() => void> = [];
const heldSaves: Array<{ args: Record<string, unknown>; resolve: (value: unknown) => void }> = [];
let stored = {
  enabled: false,
  label: "hivra",
  repo: "acme/web",
  version: 0,
  stale: false,
  note: null as string | null,
};

function answerSet(args: Record<string, unknown>) {
  const expected = Number(args.expectedVersion);
  if (expected !== stored.version) {
    return { ...stored, stale: true, note: "That changed. Showing the latest." };
  }
  stored = {
    enabled: args.enabled === true,
    label: String(args.label ?? "hivra"),
    repo: "acme/web",
    version: stored.version + 1,
    stale: false,
    note: null,
  };
  return { ...stored };
}

installFakeTauri("wp77", (command, args) => {
  const project = String(args.project ?? "");
  if (command === "github_issues_setting_get") {
    if (project === "/tmp/slow") {
      return new Promise((resolve) => {
        held.push(() =>
          resolve({
            enabled: true,
            label: "stale",
            repo: "acme/old",
            version: 3,
            stale: false,
            note: "Stale note.",
          }),
        );
      });
    }
    if (project === "/tmp/two") {
      return { enabled: false, label: "other", repo: "acme/two", version: 4, stale: false, note: "This project is off." };
    }
    return { enabled: false, label: "hivra", repo: null, version: 0, stale: false, note: null };
  }
  if (command === "github_issues_setting_set") {
    document.body.dataset.lastCommand = command;
    const hold = (window as unknown as { holdSaves?: boolean }).holdSaves === true;
    if (!hold) return answerSet(args);
    return new Promise((resolve) => {
      heldSaves.push({ args, resolve });
      document.body.dataset.pendingSaves = String(heldSaves.length);
      document.body.dataset.pendingExpected = String(args.expectedVersion ?? "");
    });
  }
  return null;
});

Object.assign(window, {
  releaseStale() {
    for (const resolve of held.splice(0)) resolve();
  },
  releaseOneSave() {
    const next = heldSaves.shift();
    if (!next) return;
    next.resolve(answerSet(next.args));
    document.body.dataset.pendingSaves = String(heldSaves.length);
  },
  bumpSaved() {
    stored.version += 1;
  },
});

const TASK = {
  number: 7,
  title: "Fix the door",
  description: "It sticks.",
  status: "Backlog",
  needsYou: false,
  failed: false,
  assignee: "mate-1",
  comments: [],
  activity: [],
  githubUrl: "https://github.com/acme/web/issues/7",
  githubPaused: true,
  githubPulls: [
    { title: "Crew", url: "https://github.com/acme/web/pull/4", state: "merged" },
    { title: "Same item", url: "https://github.com/acme/web/issues/7", state: "open" },
  ],
};

function Page() {
  const [project, setProject] = useState("/tmp/web");
  return (
    <>
      <button type="button" onClick={() => setProject("/tmp/slow")}>
        Slow project
      </button>
      <button type="button" onClick={() => setProject("/tmp/two")}>
        Other project
      </button>
      <GithubIssuesSetting project={project} />
      <TaskDetail task={TASK} onComment={() => undefined} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
