// Browser proof for WP-253: turns whose engine reports no price get a list-price estimate, and cache reads show what
// they saved. The seeded chats go through the real UsagePage.
import { createRoot } from "react-dom/client";
import { UsagePage } from "../../src/features/usage/ui/UsagePage";
import type { UsageSession } from "../../src/features/usage/model/history";
import "../../src/styles/index.css";

const now = new Date(2026, 10, 12, 15).getTime();
const at = (hour: number) => new Date(2026, 10, 12, hour).getTime();

const sessions: UsageSession[] = [
  {
    id: "priced",
    cwd: "/work/app",
    harness: "claude",
    model: "claude-opus-5-5",
    blocks: [
      {
        id: "p1",
        role: "user",
        startedAt: at(9),
        turnMetrics: { inputTokens: 20_000, outputTokens: 4_000, cacheReadTokens: 400_000, costUsd: 0.24 },
        turnModel: { harness: "claude", name: "claude-opus-5-5" },
      },
    ],
  },
  {
    id: "unpriced",
    cwd: "/work/app",
    harness: "cursor",
    model: "claude-sonnet-4-6",
    blocks: [
      {
        id: "u1",
        role: "user",
        startedAt: at(10),
        turnMetrics: { inputTokens: 100_000, outputTokens: 10_000 },
        turnModel: { harness: "cursor", name: "claude-sonnet-4-6" },
      },
    ],
  },
  {
    id: "unknown",
    cwd: "/work/app",
    harness: "codex",
    model: "gpt-5.4",
    blocks: [
      {
        id: "x1",
        role: "user",
        startedAt: at(11),
        turnMetrics: { inputTokens: 50_000, outputTokens: 5_000 },
        turnModel: { harness: "codex", name: "gpt-5.4" },
      },
    ],
  },
];

createRoot(document.getElementById("usage")!).render(<UsagePage sessions={sessions} now={now} />);
createRoot(document.getElementById("empty")!).render(<UsagePage sessions={[]} now={now} />);
