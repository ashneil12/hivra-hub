// Browser proof for Settings, Usage (WP-108). The seeded chats are the UsagePage
// Settings renders, not a copy of its markup.
import { createRoot } from "react-dom/client";
import { UsagePage } from "../../src/features/usage/ui/UsagePage";
import type { UsageSession } from "../../src/features/usage/model/history";
import "../../src/styles/index.css";

const now = new Date(2026, 10, 6, 15).getTime();
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).getTime();

const sessions: UsageSession[] = [
  {
    id: "s1",
    cwd: "/work/secret-project",
    harness: "claude",
    model: "sonnet-5",
    blocks: [
      {
        id: "b1",
        role: "user",
        startedAt: at(6, 9),
        text: "my bank password is hunter2",
        turnMetrics: { inputTokens: 100, outputTokens: 20, costUsd: 0.5 },
        turnModel: { harness: "claude", name: "sonnet-5" },
      },
      {
        id: "late",
        role: "user",
        startedAt: at(5, 23, 50),
        turnMetrics: { inputTokens: 1_000 },
      },
    ],
  },
  {
    id: "s2",
    cwd: "/work/lib",
    harness: "codex",
    model: "gpt-5",
    blocks: [
      {
        id: "b1",
        role: "user",
        startedAt: at(6, 10),
        text: "the reply that must not travel",
        turnMetrics: { inputTokens: 40, outputTokens: 8 },
        turnModel: { harness: "codex", name: "gpt-5" },
      },
    ],
  },
];

createRoot(document.getElementById("usage")!).render(
  <UsagePage sessions={sessions} now={now} />,
);

createRoot(document.getElementById("empty")!).render(
  <UsagePage sessions={[]} now={now} />,
);
