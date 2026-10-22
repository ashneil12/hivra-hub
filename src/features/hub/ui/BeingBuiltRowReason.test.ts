// @vitest-environment happy-dom
// A stuck row in Being built says why in plain words (Critiquito on the D5 shot, 22 Oct): no exit codes or developer
// text on the row, "Failed 3 times" instead; the detail stays in the Lead's chat.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { rowReason } from "../model/rowReason";
import type { Worker } from "../model/types";
import { WorkerLine } from "./BeingBuiltView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const D5 = 'Three tries, all exit 7: "Example: D5 test step is broken (exit 7)". The step is meant to fail and must not be fixed. Nothing for Ash to decide.';

describe("rowReason", () => {
  it("turns a reason with exit codes into plain words with the count", () => {
    expect(rowReason(D5)).toBe("Failed 3 times. The details are in the Lead's chat.");
    expect(rowReason("Crashed 4 times, retries ran out: Claude exited with code 1")).toBe("Failed 4 times. The details are in the Lead's chat.");
    expect(rowReason("npm test exited with status 2 in /Users/ash/harness/hivra")).toBe("It failed. The details are in the Lead's chat.");
    expect(rowReason("ENOSPC while writing the build")).toBe("It failed. The details are in the Lead's chat.");
  });
  it("leaves a plain reason as it is", () => {
    expect(rowReason("The disk was full twice.")).toBe("The disk was full twice.");
    expect(rowReason("Example: The email sender refused the login.")).toBe("The email sender refused the login.");
    expect(rowReason(undefined)).toBe("");
  });
});

let root: Root | undefined;
afterEach(() => act(() => root?.unmount()));

it("the Being built row shows no exit code or developer text, only plain words", async () => {
  const w: Worker = { id: "j_d5", projectId: "hub", who: "MonoCode Hub lead", doing: "D5 test: always-failing step", kind: "coding", minutes: 3, steps: [], stuck: "stuck", stuckReason: D5, lead: null };
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(WorkerLine, { w, onOpen: () => undefined, showWho: false })));
  const row = host.querySelector('[data-hub-worker="j_d5"]')!;
  expect(row.querySelector("[data-hub-job-reason]")!.textContent).toBe("Failed 3 times. The details are in the Lead's chat.");
  expect(row.textContent).not.toMatch(/exit\s*\d|code \d|Example:/i);
  expect(row.textContent).toContain("Stuck");
});
