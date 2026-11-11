// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import type { JanitorEntry, JanitorReport } from "../model/worktreeJanitor";
import { WorktreeCleanup } from "./WorktreeCleanup";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const entry = (name: string, over: Partial<JanitorEntry> = {}): JanitorEntry => ({
  path: `/Users/ash/Worktrees/${name}`,
  kind: "linked",
  repo: "/repo",
  branch: name,
  head: "abc",
  chats: 0,
  lastActivity: 1_000,
  totalBytes: 9_600_000_000,
  buildOutput: [
    { path: "target", bytes: 9_100_000_000, linked: false, ignored: true },
    { path: "node_modules", bytes: 0, linked: true, ignored: false },
  ],
  verdict: { outcome: "keep", state: "ahead", reason: "1 commit not on main", freeableBytes: 0, reclaimBytes: 0 },
  ...over,
});

const report: JanitorReport = {
  generatedAt: 2_000,
  roots: ["/Users/ash/Worktrees"],
  entries: [
    entry("big", {
      verdict: {
        outcome: "free",
        state: "ahead",
        reason: "Idle 9 days: target/ 9.1 GB can be rebuilt",
        freeableBytes: 9_100_000_000,
        reclaimBytes: 9_100_000_000,
      },
    }),
    entry("small", { totalBytes: 10_000, buildOutput: [] }),
  ],
  totalBytes: 9_600_010_000,
  buildOutputBytes: 9_100_000_000,
  buildOutputCount: 1,
  removeCount: 0,
  removeBytes: 0,
  freeCount: 1,
  freeBytes: 9_100_000_000,
  keepCount: 1,
  notes: [],
};

it("shows how much build output each worktree holds, and the total, after the report loads", async () => {
  let answer: (value: JanitorReport) => void = () => {};
  vi.mocked(invoke).mockImplementation((command: string) => {
    if (command === "worktree_janitor_report") {
      return new Promise<JanitorReport>((resolve) => {
        answer = resolve;
      });
    }
    return Promise.resolve([]);
  });
  await act(async () => {
    root.render(createElement(WorktreeCleanup, { project: "/repo", onRemove: vi.fn() }));
  });
  const open = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Clean up"));
  await act(async () => open?.click());
  // Measuring happens in the app, off the window's thread: the window only waits for the answer.
  expect(host.textContent).toContain("Measuring worktrees");
  await act(async () => answer(report));
  expect(host.textContent).toContain("Build output: 9.1 GB in 1 worktree.");
  const lines = [...host.querySelectorAll("[data-build-output]")].map((p) => p.textContent);
  expect(lines).toEqual(["Build output 9.1 GB (target 9.1 GB)"]);
  expect(host.textContent).not.toMatch(/[—–]/);
});
