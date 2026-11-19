import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { CommitGuardAllow } from "../../src/features/commit-guard/model/allows";
import { CommitGuardRefusal } from "../../src/features/commit-guard/ui/CommitGuardRefusal";
import { CommitGuardAllowsPanel } from "../../src/features/commit-guard/ui/CommitGuardAllowsPanel";
import { OpenInSourceControlLink } from "../../src/features/commit-guard/ui/OpenInSourceControlLink";
import { onGuardFindingOpen, takePendingGuardFinding } from "../../src/features/commit-guard/model/openFinding";
import "../../src/styles/index.css";

// What the app does when a card's link asks to show a refusal: here the finding is recorded instead of a panel opening.
const opened: string[] = [];
(window as unknown as { __opened: string[] }).__opened = opened;
onGuardFindingOpen(() => {
  const next = takePendingGuardFinding();
  if (next) opened.push(next);
});

const calls: Array<{ id: string }> = [];
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
        message="Possible secret in src/config.rs:12 in /srv/project (commit 1a2b3c4d5e6f, refusal 0123456789ab). The value is not shown. To go on, either remove it from the commit."
        fetchRefusal={async (id) =>
          id === "0123456789ab"
            ? { id, folder: "/srv/project", file: "src/config.rs", line: 12, commit: "1a2b3c4d5e6f" }
            : null
        }
        allowLine={async (id) => {
          calls.push({ id });
        }}
      />
      <CommitGuardRefusal
        message="Possible secret in src/other.rs:3 in /srv/project (commit 2b3c4d5e6f70, refusal aaaaaaaaaaaa). The value is not shown."
        fetchRefusal={async () => null}
      />
      <CommitGuardRefusal message="Possible secret in a commit message:2. The value is not shown." />
      <CommitGuardRefusal
        message="Refused to commit .claude/settings.local.json: it is an agent's local approvals, and this repository tracks it. It saves approved commands with any password typed in them (refusal bbbbbbbbbbbb). To go on, untrack it."
        fetchRefusal={async (id) =>
          id === "bbbbbbbbbbbb"
            ? { id, folder: "/srv/project", file: ".claude/settings.local.json", line: 0, commit: "", wholeFile: true }
            : null
        }
        allowLine={async (id) => {
          calls.push({ id });
        }}
      />
      <OpenInSourceControlLink message="Possible secret in src/config.rs:12 in /srv/project (commit 1a2b3c4d5e6f, refusal 0123456789ab). The value is not shown." />
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
