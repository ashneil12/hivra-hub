import { useState } from "react";
import { createRoot } from "react-dom/client";
import { StackList, StaleStackList, type StackView, type StaleStackView } from "../../src/features/stacks/ui/StackList";
import { TaskDetail } from "../../src/features/tasks/ui/TaskDetail";
import "../../src/styles/index.css";

const initial: StackView[] = [
  {
    id: "saaaa1111",
    worktree: "/tmp/my work/café",
    composeProject: "hivra-saaaa1111",
    url: "http://127.0.0.1:22010",
    running: true,
    stale: false,
  },
  {
    id: "sbbbb2222",
    worktree: "/tmp/other",
    composeProject: "hivra-sbbbb2222",
    url: "http://127.0.0.1:22020",
    running: true,
    stale: false,
  },
  {
    id: "sdddd4444",
    worktree: "/tmp/remote",
    composeProject: "hivra-sdddd4444",
    url: "http://evil.example",
    running: true,
    stale: false,
  },
];

const gone: StaleStackView[] = [
  {
    id: "scccc3333",
    worktree: "/tmp/gone",
    composeProject: "hivra-scccc3333",
  },
];

const task = {
  title: "Run it",
  description: "",
  status: "In progress",
  needsYou: false,
  failed: false,
  assignee: null,
  comments: [],
  activity: [],
};

function Page() {
  const [stacks, setStacks] = useState(initial);
  const [stale, setStale] = useState(gone);
  const declared = false;
  const empty: StackView[] = [];
  return (
    <>
      <section aria-label="Worktree stacks">
        <StackList
          stacks={stacks}
          onStop={(worktree) =>
            setStacks((current) => current.map((stack) => (stack.worktree === worktree ? { ...stack, running: false } : stack)))
          }
        />
      </section>
      <section aria-label="Clean up">
        <StaleStackList stacks={stale} onRemove={(id) => setStale((current) => current.filter((stack) => stack.id !== id))} />
      </section>
      <div id="undeclared">{!declared && empty.length === 0 ? null : <section aria-label="No stack" />}</div>
      <TaskDetail task={{ ...task, number: 1 }} onComment={() => undefined} appUrl="http://127.0.0.1:22010" />
      <TaskDetail task={{ ...task, number: 2 }} onComment={() => undefined} appUrl="http://evil.example" />
    </>
  );
}

createRoot(document.getElementById("stacks")!).render(<Page />);
