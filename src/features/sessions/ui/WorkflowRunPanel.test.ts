// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Block } from "../model/session";
import type { WorkflowRunMeta } from "../model/workflowRun";
import { WorkflowRunPanel } from "./WorkflowRunPanel";

vi.mock("./AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) => createElement("div", { "data-markdown": "" }, text),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const run = (agents: WorkflowRunMeta["agents"], status: WorkflowRunMeta["status"] = "running"): Block => ({
  id: "wf",
  role: "tool",
  text: "Workflow",
  tool: { callId: "toolu_1", title: "Workflow", kind: "workflow" },
  workflowRun: { taskId: "w1", name: "demo-review", status, phases: [{ index: 1, title: "Scan" }], agents },
});
const render = (block: Block) => act(() => root.render(createElement(WorkflowRunPanel, { block, live: true })));
const q = (selector: string) => container.querySelector<HTMLElement>(selector);

it("opens an agent onto what it was asked, how far it has got and what it handed back", () => {
  render(
    run([
      { index: 1, label: "Read parser", state: "done", phaseIndex: 1, prompt: "Read the parser.", result: "Nothing wrong." },
      { index: 2, label: "Read adapter", state: "working", phaseIndex: 1, prompt: "Read the adapter.", toolCalls: 3, lastProgressAt: Date.now() },
      { index: 3, label: "Wait", state: "queued", phaseIndex: 1 },
    ]),
  );
  expect(q("[data-workflow-agent-work]")).toBeNull();
  act(() => q('[data-workflow-agent="Read parser"]')!.click());
  const done = q('[data-workflow-agent-work="Read parser"]')!;
  expect(done.querySelector("[data-workflow-agent-prompt]")?.textContent).toBe("Read the parser.");
  expect(done.querySelector("[data-workflow-agent-report]")?.textContent).toBe("Nothing wrong.");
  expect(q('[data-workflow-agent="Read parser"]')!.getAttribute("aria-expanded")).toBe("true");

  act(() => q('[data-workflow-agent="Read adapter"]')!.click());
  const working = q('[data-workflow-agent-work="Read adapter"]')!;
  expect(working.querySelector("[data-workflow-agent-progress]")?.textContent).toBe("3 tool calls · active just now");
  expect(working.querySelector("[data-workflow-agent-report]")).toBeNull();

  // An agent the provider has said nothing of yet has nothing to open.
  expect(q('[data-workflow-agent="Wait"]')!.tagName).toBe("DIV");

  act(() => q('[data-workflow-agent="Read parser"]')!.click());
  expect(q('[data-workflow-agent-work="Read parser"]')).toBeNull();
});

it("opens a failed agent on its own, on the provider's reason", () => {
  render(
    run(
      [{ index: 1, label: "Verify", state: "failed", phaseIndex: 1, prompt: "Verify.", error: "API Error: 400" }],
      "completed",
    ),
  );
  const failed = q('[data-workflow-agent-work="Verify"]')!;
  expect(failed.querySelector("[data-workflow-agent-report] pre")?.textContent).toBe("API Error: 400");
  expect(failed.querySelector("[data-workflow-agent-progress]")).toBeNull();
});
