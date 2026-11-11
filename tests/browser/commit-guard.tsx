import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { CommitGuardAllow } from "../../src/features/commit-guard/model/allows";
import { CommitGuardRefusal } from "../../src/features/commit-guard/ui/CommitGuardRefusal";
import { CommitGuardAllowsPanel } from "../../src/features/commit-guard/ui/CommitGuardAllowsPanel";
import "../../src/styles/index.css";

const calls: Array<{ repo: string; file: string; line: number }> = [];
(window as unknown as { __allowCalls: typeof calls }).__allowCalls = calls;

// The fixture's list, read fresh each time as the real command is (a snapshot would go stale after a remove).
const store: CommitGuardAllow[] = [
  { repo: "1f2e3d4c5b6a", file: "docs/notes.md", hash: "aaa" },
  { repo: "1f2e3d4c5b6a", file: "src/fixture.rs", hash: "bbb" },
];

function Page() {
  return (
    <main className="flex flex-col gap-6 p-6 text-white">
      <CommitGuardRefusal
        message="Possible secret in src/config.rs:12. The value is not shown. To go on, either remove it from the commit."
        repo="/srv/project"
        allowLine={async (repo, file, line) => {
          calls.push({ repo, file, line });
        }}
      />
      <CommitGuardRefusal
        message="Possible secret in a commit message:2. The value is not shown."
        repo="/srv/project"
      />
      <CommitGuardAllowsPanel
        list={async () => [...store]}
        remove={async (allow) => {
          const index = store.findIndex((item) => item === allow);
          if (index >= 0) store.splice(index, 1);
        }}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
