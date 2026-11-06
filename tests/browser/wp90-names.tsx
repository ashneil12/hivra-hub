import { createRoot } from "react-dom/client";
import { StackList, type StackView } from "../../src/features/stacks/ui/StackList";
import { TaskDetail } from "../../src/features/tasks/ui/TaskDetail";
import "../../src/styles/index.css";

const stacks: StackView[] = [
  {
    id: "saaaa1111",
    worktree: "/tmp/my work/café",
    composeProject: "hivra-saaaa1111",
    url: "http://shop-wp-90.localhost:7400",
    running: true,
    stale: false,
    names: [
      { hostname: "main-wp-90.localhost", url: "http://main-wp-90.localhost:7400" },
      {
        hostname: "github-wp-90.localhost",
        url: "http://github-wp-90.localhost:7400",
        service: "github",
      },
      {
        hostname: "stripe-wp-90.localhost",
        url: "http://stripe-wp-90.localhost:7400",
        service: "stripe",
      },
    ],
    emulated: ["github", "stripe"],
    mode: "Tests use fake GitHub and Stripe",
  },
  {
    id: "sbbbb2222",
    worktree: "/tmp/other",
    composeProject: "hivra-sbbbb2222",
    url: "http://shop-wp-91.localhost:7400",
    running: true,
    stale: false,
    names: [{ hostname: "main-wp-91.localhost", url: "http://main-wp-91.localhost:7400" }],
    emulated: [],
    mode: "Reaches the real internet",
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

createRoot(document.getElementById("stacks")!).render(
  <>
    <section aria-label="Worktree stacks">
      <StackList stacks={stacks} onStop={() => undefined} />
    </section>
    <TaskDetail
      task={{ ...task, number: 1 }}
      onComment={() => undefined}
      appUrl="http://shop-wp-90.localhost:7400"
    />
  </>,
);
