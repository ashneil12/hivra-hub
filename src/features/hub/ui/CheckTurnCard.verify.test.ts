// @vitest-environment happy-dom
// The verify stage's row on a `[MonoCode check]` card (board I2): a claim can cite the last verdict for its project,
// and one click runs the project's checks and real path on the files this turn wrote. A verdict that could not run is
// shown as such, never as a pass.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Block } from "../../sessions/model/session";
import type { VerifyRecord, VerifyStatus } from "../model/verifyStage";
import { CheckTurnCard } from "./CheckTurnCard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

const mocked = vi.mocked(invoke);
const now = Date.now();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocked.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const prompt: Block = {
  id: "p1",
  role: "user",
  text: "[MonoCode check] Was the header fix recorded?",
  internal: true,
  appRequestId: "mono-check-ck_9",
  monoCheck: { id: "ck_9", dumpId: "d_1", finding: "The header fix may be missing." },
};
const write: Block = {
  id: "t1",
  role: "tool",
  text: "",
  tool: { callId: "c1", title: "Write", kind: "execute", status: "completed", preview: { kind: "write", path: "src/header.tsx" } },
};
const answer: Block = { id: "a1", role: "assistant", text: "Fixed the header, it now collapses on scroll." };

function record(over: Partial<VerifyRecord>): VerifyRecord {
  return {
    id: "v1",
    projectRoot: "/repo",
    checkout: "/repo",
    startedAt: now - 90_000,
    endedAt: now - 60_000,
    outcome: "passed",
    summary: "Verified: Web checks passed.",
    steps: [{ kind: "check", id: "web", name: "Web checks", outcome: "passed", detail: "ran and passed", runId: "r", logPath: "/tmp/l", seconds: 3 }],
    gaps: [],
    changedFiles: ["src/header.tsx"],
    ...over,
  };
}

function status(over: Partial<VerifyStatus>): VerifyStatus {
  return {
    projectRoot: "/repo",
    checkout: "/repo",
    imported: true,
    verify: { checks: [{ id: "web", name: "Web checks", command: "npm run check" }] },
    note: null,
    latest: null,
    ...over,
  };
}

function render(cwd?: string) {
  act(() =>
    root.render(createElement(CheckTurnCard, { turn: [prompt, write, answer], live: false, agentName: "Hub lead", cwd })),
  );
}

async function open() {
  await act(async () => {
    container.querySelector('[data-mono-check="ck_9"] button')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("does not read or offer the stage without a folder", () => {
  render();
  act(() => container.querySelector('[data-mono-check="ck_9"] button')!.click());
  expect(container.querySelector("[data-verify-stage]")).toBeNull();
  expect(mocked).not.toHaveBeenCalled();
});

it("cites the last verdict so a claim can point at it", async () => {
  mocked.mockResolvedValue(status({ latest: record({}) }));
  render("/repo");
  await open();
  expect(mocked).toHaveBeenCalledWith("verify_stage_status", { cwd: "/repo" });
  const row = container.querySelector("[data-verify-stage]")!;
  expect(row.textContent).toContain("every check that ran passed");
  expect(row.textContent).toContain("Web checks: ran and passed");
  expect(row.getAttribute("data-verification-outcome")).toBe("passed");
  expect(row.textContent).toContain("Run verification");
});

it("says plainly when the project declares nothing, and offers no run", async () => {
  mocked.mockResolvedValue(
    status({ imported: false, verify: {}, note: "This project's .monocode/project.json isn't imported yet, so nothing can run." }),
  );
  render("/repo");
  await open();
  const row = container.querySelector("[data-verify-stage]")!;
  expect(row.textContent).toContain("isn't imported yet");
  expect(row.textContent).not.toContain("Run verification");
  expect(row.getAttribute("data-verification-outcome")).toBe("none");
});

it("runs the stage on this turn's files and shows a failed verdict as not proven", async () => {
  const failed = record({
    outcome: "failed",
    steps: [{ kind: "check", id: "web", name: "Web checks", outcome: "failed", detail: "failed (exit 2)", runId: "r2", logPath: "/tmp/l2", seconds: 4 }],
  });
  mocked.mockImplementation(async (command: string) => {
    if (command === "verify_stage_status") return status({});
    if (command === "verify_stage_run") return failed;
    throw new Error(`unexpected ${command}`);
  });
  render("/repo");
  await open();
  await act(async () => {
    container.querySelector("[data-verify-stage] button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(mocked).toHaveBeenCalledWith("verify_stage_run", { cwd: "/repo", paths: ["src/header.tsx"] });
  const row = container.querySelector("[data-verify-stage]")!;
  expect(row.getAttribute("data-verification-outcome")).toBe("failed");
  expect(row.textContent).toContain("Not proven");
  expect(row.textContent).not.toMatch(/every check that ran passed/i);
});

it("shows a verdict that could not be exercised as such", async () => {
  mocked.mockResolvedValue(
    status({
      latest: record({
        outcome: "couldNotExercise",
        steps: [{ kind: "realPath", id: "real-path", name: "Real path", outcome: "couldNotExercise", detail: "the bench could not run", runId: "r3", logPath: "/tmp/l3", seconds: 1 }],
      }),
    }),
  );
  render("/repo");
  await open();
  const row = container.querySelector("[data-verify-stage]")!;
  expect(row.getAttribute("data-verification-outcome")).toBe("couldNotExercise");
  expect(row.textContent).toContain("couldn't exercise this change");
  expect(row.textContent).toContain("Not proven");
});
